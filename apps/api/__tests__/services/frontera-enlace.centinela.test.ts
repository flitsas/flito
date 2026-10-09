// HU #12875 (AC3, diseño §6) — Centinela de la frontera por enlace sobre la app REAL (`createApp()`).
//
//   1. Recorre cada prefijo MONTADO en `app.ts` (internals de Express 4 SOLO aquí, nunca en runtime) y
//      lo sondea con un usuario de enlace compañía que tiene el catálogo ENTERO: nunca un 2xx. Un router
//      nuevo que alguien monte mañana sin `conAlcance` cae en este recorrido y tiene que salir cerrado.
//   2. Snapshot EXACTO de los montajes declarados (`conAlcance`) y de las rutas de cada router abierto
//      (incluidos los sub-routers anidados): una ruta nueva en un módulo abierto pone esto rojo y obliga
//      a decidir (¿acota por enlace, o va con `soloSinEnlace()`?). HU #13426: la decisión de cada ruta
//      de los módulos que abre está escrita en `RUTAS_13426` y se COMPRUEBA contra el código (la marca
//      de `soloSinEnlace()` en la pila de la ruta), no solo se lista.
//   3. `conAlcance` restaura la marca: dos montajes sobre el mismo prefijo no se la heredan (§6.3).
//   4. TC-06d: el tipo interno/externo retirado no tiene lectores en el código.
//
// Mutantes que mata: quitar la comprobación del módulo en la guarda (1 y 3 en rojo), no restaurar la
// marca en `conAlcance` (3), envolver un montaje más con `conAlcance` sin decidirlo (2).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba, testToken } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => {
  const vacio = () => chain([]);
  return {
    db: {
      select: vi.fn(vacio), selectDistinct: vi.fn(vacio), insert: vi.fn(vacio), update: vi.fn(vacio),
      delete: vi.fn(vacio), execute: vi.fn().mockResolvedValue([]), transaction: vi.fn(),
    },
    getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
  };
});
vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const pasa = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: pasa, authLimiter: pasa, qrPublicLimiter: pasa };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { conAlcance } = await import('../../src/shared/middleware/frontera-enlace.js');
const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
const { catalogoCompleto } = await import('../../src/modules/permisos/catalogo.js');

const aqui = path.dirname(fileURLToPath(import.meta.url));

/**
 * Montajes que NO autentican a nadie (su token o su ausencia de sesión es la autenticación). Nombrados:
 * cualquier otro prefijo entra al recorrido. Ni el antes ni el después de la HU los cierra.
 */
const PUBLICOS = [
  '/api/rum', '/api/files', '/api/webhooks/firma', '/api/validacion-identidad/completar', '/api/tramite-portal',
  '/api/public/tramite-verificar', '/api/public/drive', '/api/rndc/public/manifiestos', '/api/auth/login',
];

type Capa = {
  name: string; regexp: RegExp; route?: unknown; handle: ((...a: unknown[]) => unknown) & {
    fronteraModulo?: string; fronteraRouter?: { stack: Capa[] }; stack?: Capa[];
  };
  route_?: never;
};

/** El prefijo de un `app.use('<prefijo>', …)` a partir de la expresión que Express 4 compila. */
function prefijoDe(re: RegExp): string | null {
  const fuente = re.source;
  if (fuente === '^\\/?(?=\\/|$)') return null; // `app.use(fn)` global
  const m = /^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/.exec(fuente);
  if (!m) return null;
  return m[1]!.replace(/\\\//g, '/').replace(/\\-/g, '-').replace(/\\\./g, '.');
}

let app: express.Express;
let capas: Capa[];
let auth: string;

beforeAll(async () => {
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  capas = (app as unknown as { _router: { stack: Capa[] } })._router.stack;
  // Enlace compañía con el catálogo ENTERO: marcarle todas las funciones no lo saca de su frontera.
  auth = `Bearer ${await testToken({ sub: 77001, role: 'cliente' })}`;
  await registrarUsuarioDePrueba(77001, {
    rol: 'aseguradora_x', tipoEnlace: 'compania', funcionesDelRol: catalogoCompleto().map((f) => f.codigo), excepciones: [],
  });
});

const montajes = () => capas
  .filter((c) => !c.route)
  .map((c) => ({ prefijo: prefijoDe(c.regexp), capa: c }))
  .filter((m): m is { prefijo: string; capa: Capa } => !!m.prefijo && m.prefijo.startsWith('/api'));

describe('AC3 — recorrido de la app real: ningún prefijo montado le da un 2xx a un usuario de compañía fuera de lo declarado', () => {
  it('hay un número razonable de montajes (el parser de la expresión de Express no se quedó en cero)', () => {
    expect(montajes().length).toBeGreaterThan(80);
  });

  it('cada prefijo NO público y NO declarado → 403 de la frontera o 404; nunca 2xx', async () => {
    const declarados = new Set(montajes().filter((m) => m.capa.handle.fronteraModulo).map((m) => m.prefijo));
    const sondeados = [...new Set(montajes().map((m) => m.prefijo))]
      .filter((p) => !PUBLICOS.includes(p) && !declarados.has(p));
    const malos: string[] = [];
    let cerradosPorFrontera = 0;
    for (const prefijo of sondeados) {
      for (const metodo of ['get', 'post'] as const) {
        const r = await request(app)[metodo](`${prefijo}/__sonda-frontera`).set('Authorization', auth).send({});
        if (r.status === 403 && r.body?.error === 'Sin permisos') cerradosPorFrontera += 1;
        if (r.status >= 200 && r.status < 300) malos.push(`${metodo.toUpperCase()} ${prefijo} → ${r.status}`);
        if (![403, 404].includes(r.status)) malos.push(`${metodo.toUpperCase()} ${prefijo} → ${r.status}`);
      }
    }
    expect(malos).toEqual([]);
    // Y la mayoría lo cierra la FRONTERA, no un 404 casual: si la guarda dejara pasar, aquí habría 403
    // de `exigirFuncion` (cuerpo con `funcion`) o 2xx, no este cuerpo.
    expect(cerradosPorFrontera).toBeGreaterThan(sondeados.length);
  });

  it('el prefijo raíz de los legacy sensibles, uno a uno: vehículos, RUNT, usuarios, catálogos → 403 de la frontera', async () => {
    for (const [metodo, ruta] of [
      ['get', '/api/vehicles'], ['post', '/api/runt/consulta-persona'], ['get', '/api/users'],
      ['get', '/api/flito/parametrizacion/companias'], ['get', '/api/permisos/roles'], ['get', '/api/flito/liquidacion'],
      // HU #13426: Tránsito se abre SOLO a `organismos_transito`; para una compañía sigue cerrado.
      ['get', '/api/transito/pendientes'], ['get', '/api/transito/organismos'],
    ] as const) {
      const r = await request(app)[metodo](ruta).set('Authorization', auth).send({});
      expect([r.status, r.body], `${metodo} ${ruta}`).toEqual([403, { error: 'Sin permisos' }]);
    }
  });
});

describe('AC3 — snapshot de lo declarado: montajes con `conAlcance` y rutas de los routers abiertos', () => {
  it('los montajes declarados: los cuatro de SOAT (#12875) y los de #13426 (Tránsito: solo `transitoRoutes`)', () => {
    const declarados = montajes().filter((m) => m.capa.handle.fronteraModulo)
      .map((m) => ({ prefijo: m.prefijo, modulo: m.capa.handle.fronteraModulo }));
    expect(declarados).toEqual([
      { prefijo: '/api/flito/soat', modulo: 'soat' },
      { prefijo: '/api/flito/soat', modulo: 'soat' },
      { prefijo: '/api/flito/soat', modulo: 'soat' },
      { prefijo: '/api/flito/soat', modulo: 'soat' },
      { prefijo: '/api/flito/impuestos', modulo: 'impuestos' },
      { prefijo: '/api/flito/derechos', modulo: 'derechos' },
      { prefijo: '/api/flito/tramites', modulo: 'tramites' },
      { prefijo: '/api/flito/tablero', modulo: 'tablero' },
      { prefijo: '/api/flito/logistica', modulo: 'logistica' },
      { prefijo: '/api/flito/logistica', modulo: 'logistica' },
      { prefijo: '/api/flito/bolsas', modulo: 'bolsas' },
      { prefijo: '/api/flito/comprobantes', modulo: 'comprobantes' },
      { prefijo: '/api/transito', modulo: 'transito' },
    ]);
  });

  it('las rutas de los routers abiertos (método + path, sub-routers incluidos): una ruta nueva obliga a decidir', () => {
    expect(rutasAbiertas().map((r) => r.ruta)).toEqual([...RUTAS_SOAT_ABIERTAS, ...RUTAS_13426.map(([r]) => r)]);
  });

  it('HU #13426 — la decisión escrita de cada ruta es la del código: `soloSinEnlace` ⇔ la ruta lleva su guarda', () => {
    const enCodigo = rutasAbiertas().filter((r) => !r.ruta.includes('/api/flito/soat'))
      .map((r) => [r.ruta, r.cerrada ? 'soloSinEnlace' : 'filtra']);
    expect(enCodigo).toEqual(RUTAS_13426);
    // SOAT acota todas por `contextoSoat` (#12875): ninguna lleva la guarda.
    expect(rutasAbiertas().filter((r) => r.ruta.includes('/api/flito/soat') && r.cerrada)).toEqual([]);
  });
});

describe('§6.3 — `conAlcance` restaura la marca: dos montajes sobre el mismo prefijo no se la heredan', () => {
  const ok = vi.fn((_req: Request, res: Response) => { res.json({ ok: true }); });
  function laboratorio() {
    const a = express();
    const declarado = Router();
    declarado.use(authMiddleware);
    declarado.get('/solo-aqui', ok); // no casa con `/hermano`: deja pasar la petición
    const sinDeclarar = Router();
    sinDeclarar.use(authMiddleware);
    sinDeclarar.get('/hermano', ok);
    a.use('/api/x', conAlcance('soat', declarado));
    a.use('/api/x', sinDeclarar);
    return a;
  }

  it('el segundo montaje (sin declarar) cierra al usuario de compañía aunque el primero sí estuviera declarado', async () => {
    const r = await request(laboratorio()).get('/api/x/hermano').set('Authorization', auth);
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(ok).not.toHaveBeenCalled();
  });

  it('control: el primer montaje sí le deja pasar, y un usuario sin enlace pasa los dos', async () => {
    expect((await request(laboratorio()).get('/api/x/solo-aqui').set('Authorization', auth)).status).toBe(200);
    const admin = `Bearer ${await testToken({ sub: 77002, role: 'admin' })}`;
    expect((await request(laboratorio()).get('/api/x/hermano').set('Authorization', admin)).status).toBe(200);
  });

  it('un módulo que no es de la frontera no se puede declarar (error al arrancar, no en runtime)', () => {
    expect(() => conAlcance('inventado' as never, Router())).toThrow(/módulo de frontera desconocido/);
  });
});

describe('TC-06d — el tipo interno/externo retirado no tiene lectores ni escritores en el código', () => {
  /** Excepciones NOMBRADAS: la columna (expand/contract) y el reporte de transición (AC9), cuyo «antes» ES ese tipo. */
  const PERMITIDOS = new Set([
    'db/schema/permisos.ts', 'modules/permisos/frontera-en-seco.ts', 'scripts/permisos-reparto-en-seco.ts',
  ]);
  const archivos = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? archivos(p) : p.endsWith('.ts') ? [p] : [];
  });

  it('`apps/api/src` (sin migraciones): solo el esquema y el reporte en seco nombran el tipo retirado', () => {
    const raiz = path.resolve(aqui, '../../src');
    const conTipo = archivos(raiz)
      .map((p) => path.relative(raiz, p).split(path.sep).join('/'))
      .filter((rel) => !rel.startsWith('db/migrations/'))
      .filter((rel) => /tipoPrincipal|tipo_principal|TipoPrincipal/.test(readFileSync(path.join(raiz, rel), 'utf8')));
    expect(conTipo.filter((rel) => !PERMITIDOS.has(rel))).toEqual([]);
  });

  it('la frontera del canal externo se fue entera: ni el archivo ni su guarda existen en el código', () => {
    const raiz = path.resolve(aqui, '../../src');
    const conCanal = archivos(raiz)
      .filter((p) => /guardiaCanalCliente|RUTAS_PERMITIDAS_CLIENTE|FUNCIONES_DEL_CANAL_EXTERNO|middleware\/canal-cliente/.test(readFileSync(p, 'utf8')));
    expect(conCanal).toEqual([]);
  });

  it('`packages/shared-types/src`: solo la lista de campos auditables (histórico, paridad con el CHECK de la 0185)', () => {
    const raiz = path.resolve(aqui, '../../../../packages/shared-types/src');
    const conTipo = archivos(raiz)
      .filter((p) => /tipoPrincipal|tipo_principal|TipoPrincipal/.test(readFileSync(p, 'utf8')))
      .map((p) => path.basename(p));
    expect(conTipo).toEqual(['permisos-auditoria.ts']);
  });
});

type CapaPila = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: { fronteraSoloSinEnlace?: boolean } }[] };
  handle: { stack?: CapaPila[] };
};
/** Rutas de una pila de Express, entrando en los sub-routers (`router.use(subRouter)`). */
function rutasDePila(pila: CapaPila[]): { verbo: string; path: string; cerrada: boolean }[] {
  return pila.flatMap((c) => {
    if (c.route) {
      const cerrada = c.route.stack.some((l) => l.handle.fronteraSoloSinEnlace === true);
      return Object.keys(c.route.methods).map((v) => ({ verbo: v.toUpperCase(), path: c.route!.path, cerrada }));
    }
    return c.handle.stack ? rutasDePila(c.handle.stack) : [];
  });
}
function rutasAbiertas(): { ruta: string; cerrada: boolean }[] {
  return montajes().filter((m) => m.capa.handle.fronteraModulo).flatMap((m) =>
    rutasDePila(m.capa.handle.fronteraRouter!.stack as unknown as CapaPila[]).map((r) => ({
      ruta: `${r.verbo} ${m.prefijo}${r.path === '/' ? '' : r.path}`, cerrada: r.cerrada,
    })));
}

/**
 * HU #13426 — Rutas de los routers que abre esta HU, en orden de montaje, con su DECISIÓN (diseño §3):
 *   · `filtra`        → acota por el enlace en el servicio (lectura: solo su alcance, detalle ajeno 404;
 *                       escritura sobre lo ajeno 403 sin comprobar existencia).
 *   · `soloSinEnlace` → catálogo, configuración u operación interna de FLIT: 403 a todo enlace.
 * Revisada una a una al abrir cada módulo; NO se regenera a ciegas. Una ruta nueva exige su fila.
 */
const RUTAS_13426: [string, 'filtra' | 'soloSinEnlace'][] = [
  ['POST /api/flito/impuestos/:id/reanalizar',                                 'filtra'],
  ['PATCH /api/flito/impuestos/:id/direccion',                                 'filtra'],
  ['POST /api/flito/impuestos/certificados/zip',                               'filtra'],
  ['POST /api/flito/impuestos/:id/recibos',                                    'filtra'],
  ['POST /api/flito/impuestos/:id/recibos/reemplazar-pago',                    'filtra'],
  ['GET /api/flito/impuestos/:id/factura-venta',                               'filtra'],
  ['POST /api/flito/impuestos/soportes/zip',                                   'filtra'],
  ['GET /api/flito/impuestos',                                                 'filtra'],
  ['POST /api/flito/impuestos/export',                                         'filtra'],
  ['GET /api/flito/impuestos/facetas',                                         'filtra'],
  ['GET /api/flito/impuestos/:id',                                             'filtra'],
  ['GET /api/flito/impuestos/:id/historial',                                   'filtra'],
  ['GET /api/flito/impuestos/:id/soportes',                                    'filtra'],
  ['POST /api/flito/impuestos/:id/certificar',                                 'filtra'],
  ['POST /api/flito/impuestos/certificar',                                     'filtra'],
  ['GET /api/flito/impuestos/:id/certificado',                                 'filtra'],
  ['POST /api/flito/impuestos/enviar',                                         'filtra'],
  ['POST /api/flito/impuestos/:id/asumir-operaciones',                         'soloSinEnlace'],
  ['POST /api/flito/impuestos/:id/devolver-gestor',                            'soloSinEnlace'],
  ['POST /api/flito/impuestos/:id/rechazar',                                   'filtra'],
  ['POST /api/flito/impuestos/:id/reactivar',                                  'filtra'],
  ['POST /api/flito/impuestos/:id/reversar',                                   'filtra'],
  ['POST /api/flito/impuestos/recibos',                                        'filtra'],
  ['POST /api/flito/impuestos/:id/recibo-caja',                                'filtra'],
  ['POST /api/flito/derechos/cargar',                                          'filtra'],
  ['GET /api/flito/derechos',                                                  'filtra'],
  ['GET /api/flito/derechos/facetas',                                          'filtra'],
  ['GET /api/flito/derechos/drive/archivos',                                   'soloSinEnlace'],
  ['GET /api/flito/derechos/drive/registro',                                   'soloSinEnlace'],
  ['POST /api/flito/derechos/drive/procesar',                                  'soloSinEnlace'],
  ['GET /api/flito/derechos/candidatos/:placa',                                'soloSinEnlace'],
  ['GET /api/flito/derechos/soporte/:id',                                      'filtra'],
  ['GET /api/flito/tramites',                                                  'filtra'],
  ['GET /api/flito/tramites/facetas',                                          'filtra'],
  ['GET /api/flito/tramites/:id/historial',                                    'filtra'],
  ['GET /api/flito/tramites/:id/soportes',                                     'filtra'],
  ['POST /api/flito/tramites/soportes/zip',                                    'filtra'],
  ['POST /api/flito/tramites/crear-empresa',                                   'soloSinEnlace'],
  ['POST /api/flito/tramites/demo',                                            'soloSinEnlace'],
  ['POST /api/flito/tramites/solicitar-soat',                                  'filtra'],
  ['POST /api/flito/tramites/solicitar-impuestos',                             'filtra'],
  ['POST /api/flito/tramites/solicitar-ambos',                                 'filtra'],
  ['POST /api/flito/tramites/entregar',                                        'filtra'],
  ['POST /api/flito/tramites/:id/desbloquear-autogestion',                     'filtra'],
  ['POST /api/flito/tramites/:id/revocar-autogestion',                         'filtra'],
  ['GET /api/flito/tablero',                                                   'filtra'],
  ['GET /api/flito/logistica',                                                 'filtra'],
  ['GET /api/flito/logistica/facetas',                                         'filtra'],
  ['GET /api/flito/logistica/mi-ruta',                                         'soloSinEnlace'],
  ['GET /api/flito/logistica/actas',                                           'filtra'],
  ['GET /api/flito/logistica/actas/:id',                                       'filtra'],
  ['GET /api/flito/logistica/actas/:id/pdf',                                   'filtra'],
  ['GET /api/flito/logistica/:id',                                             'filtra'],
  ['POST /api/flito/logistica/validar-lt',                                     'soloSinEnlace'],
  ['POST /api/flito/logistica/escanear',                                       'soloSinEnlace'],
  ['POST /api/flito/logistica/documentos/:id/novedad',                         'filtra'],
  ['POST /api/flito/logistica/cerrar-lote',                                    'filtra'],
  ['POST /api/flito/logistica/actas/:id/despachar',                            'filtra'],
  ['POST /api/flito/logistica/actas/:id/entregar',                             'filtra'],
  ['POST /api/flito/logistica/actas/:id/devolucion',                           'filtra'],
  ['POST /api/flito/logistica/documentos/:id/reversar',                        'filtra'],
  ['GET /api/flito/logistica/tramites/:tramiteId/viajes',                      'filtra'],
  ['POST /api/flito/logistica/tramites/:tramiteId/viajes',                     'filtra'],
  ['DELETE /api/flito/logistica/tramites/:tramiteId/viajes/:viajeId',          'filtra'],
  ['GET /api/flito/bolsas/consolidado',                                        'filtra'],
  ['GET /api/flito/bolsas/riesgo',                                             'filtra'],
  ['GET /api/flito/bolsas/alertas',                                            'filtra'],
  ['GET /api/flito/bolsas/transito',                                           'soloSinEnlace'],
  ['POST /api/flito/bolsas/transito',                                          'soloSinEnlace'],
  ['GET /api/flito/bolsas/:companiaId',                                        'filtra'],
  ['GET /api/flito/bolsas/:companiaId/movimientos',                            'filtra'],
  ['POST /api/flito/bolsas/:companiaId/recargas',                              'filtra'],
  ['GET /api/flito/bolsas/soportes/:soporteId',                                'filtra'],
  ['GET /api/flito/bolsas/transito/:bolsaId',                                  'soloSinEnlace'],
  ['PATCH /api/flito/bolsas/transito/:bolsaId',                                'soloSinEnlace'],
  ['GET /api/flito/bolsas/transito/:bolsaId/movimientos',                      'soloSinEnlace'],
  ['POST /api/flito/bolsas/transito/:bolsaId/cargas',                          'soloSinEnlace'],
  ['GET /api/flito/bolsas/:companiaId/extracto',                               'filtra'],
  ['POST /api/flito/bolsas/:companiaId/movimientos-manuales',                  'filtra'],
  ['POST /api/flito/bolsas/:companiaId/movimientos/:movimientoId/correccion',  'filtra'],
  ['GET /api/flito/bolsas/:companiaId/cierres',                                'filtra'],
  ['POST /api/flito/bolsas/:companiaId/cierres',                               'filtra'],
  ['POST /api/flito/comprobantes',                                             'soloSinEnlace'],
  ['GET /api/flito/comprobantes',                                              'filtra'],
  ['POST /api/flito/comprobantes/tramites/buscar',                             'soloSinEnlace'],
  ['GET /api/flito/comprobantes/:id',                                          'filtra'],
  ['GET /api/flito/comprobantes/:id/archivo',                                  'filtra'],
  ['POST /api/flito/comprobantes/:id/releer',                                  'soloSinEnlace'],
  ['POST /api/flito/comprobantes/:id/aplicar',                                 'soloSinEnlace'],
  ['POST /api/flito/comprobantes/:id/descartar',                               'soloSinEnlace'],
  ['POST /api/flito/comprobantes/:id/diferencia/aceptar',                      'soloSinEnlace'],
  ['GET /api/transito/organismos',                                             'filtra'],
  ['GET /api/transito/pendientes',                                             'filtra'],
  ['GET /api/transito/mis-tramites',                                           'filtra'],
  ['GET /api/transito/traspasos',                                              'filtra'],
  ['GET /api/transito/traspasos/:id',                                          'filtra'],
  ['POST /api/transito/tomar/:id',                                             'filtra'],
  ['POST /api/transito/asignar-placa/:id',                                     'filtra'],
  ['POST /api/transito/confirmar-placa/:id',                                   'filtra'],
];

/**
 * Foto de las rutas de los cuatro routers de `/api/flito/soat` (orden de montaje y de declaración).
 * Las 25 acotan por `contextoSoat` (compañía / proveedor) o por `buscarConAcceso` (404-no-403 fuera de
 * su alcance); por eso ninguna lleva `soloSinEnlace()` en #12875. Añadir una aquí es decidir eso.
 */
const RUTAS_SOAT_ABIERTAS: string[] = [
  'POST /api/flito/soat/cliente/preconsulta',
  'POST /api/flito/soat/cliente',
  'POST /api/flito/soat/cliente/factura/lectura',
  'POST /api/flito/soat/cliente/incompletas/buscar',
  'GET /api/flito/soat/cliente/incompletas/:id',
  'POST /api/flito/soat/cliente/incompletas/:id/reintentar',
  'GET /api/flito/soat/:id/documentos-adicionales',
  'POST /api/flito/soat/:id/documentos-adicionales',
  'DELETE /api/flito/soat/:id/documentos-adicionales/:soporteId',
  'GET /api/flito/soat',
  'POST /api/flito/soat/export',
  'POST /api/flito/soat/soportes/zip',
  'GET /api/flito/soat/facetas',
  'GET /api/flito/soat/:id',
  'GET /api/flito/soat/:id/historial',
  'GET /api/flito/soat/:id/soportes',
  'POST /api/flito/soat/enviar',
  'POST /api/flito/soat/:id/rechazar',
  'POST /api/flito/soat/:id/reactivar',
  'POST /api/flito/soat/:id/reversar',
  'POST /api/flito/soat/:id/proveedor',
  'POST /api/flito/soat/:id/asumir-operaciones',
  'POST /api/flito/soat/:id/devolver-gestor',
  'POST /api/flito/soat/:id/factura',
  'POST /api/flito/soat/facturas',
];
