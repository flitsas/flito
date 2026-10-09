// HU #12875 (AC3, diseño §6) — Centinela de la frontera por enlace sobre la app REAL (`createApp()`).
//
//   1. Recorre cada prefijo MONTADO en `app.ts` (internals de Express 4 SOLO aquí, nunca en runtime) y
//      lo sondea con un usuario de enlace compañía que tiene el catálogo ENTERO: nunca un 2xx. Un router
//      nuevo que alguien monte mañana sin `conAlcance` cae en este recorrido y tiene que salir cerrado.
//   2. Snapshot EXACTO de los montajes declarados (`conAlcance`) y de las rutas de cada router abierto:
//      una ruta nueva en un módulo abierto pone esto rojo y obliga a decidir (¿acota por enlace, o va
//      con `soloSinEnlace()`?). Es la foto congelada que sustituye a la lista del canal externo.
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
type CapaRuta = Capa & { route: { path: string; methods: Record<string, boolean> } };

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
      ['get', '/api/flito/parametrizacion/companias'], ['get', '/api/permisos/roles'], ['get', '/api/flito/impuestos'],
      ['get', '/api/flito/tablero'], ['get', '/api/transito/pendientes'],
    ] as const) {
      const r = await request(app)[metodo](ruta).set('Authorization', auth).send({});
      expect([r.status, r.body], `${metodo} ${ruta}`).toEqual([403, { error: 'Sin permisos' }]);
    }
  });
});

describe('AC3 — snapshot de lo declarado: montajes con `conAlcance` y rutas de los routers abiertos', () => {
  it('los montajes declarados son EXACTAMENTE los cuatro de SOAT (#12875); #13426 añade los suyos aquí', () => {
    const declarados = montajes().filter((m) => m.capa.handle.fronteraModulo)
      .map((m) => ({ prefijo: m.prefijo, modulo: m.capa.handle.fronteraModulo }));
    expect(declarados).toEqual([
      { prefijo: '/api/flito/soat', modulo: 'soat' },
      { prefijo: '/api/flito/soat', modulo: 'soat' },
      { prefijo: '/api/flito/soat', modulo: 'soat' },
      { prefijo: '/api/flito/soat', modulo: 'soat' },
    ]);
  });

  it('las rutas de los routers abiertos (método + path): una ruta nueva obliga a decidir si acota por enlace', () => {
    const rutas = montajes().filter((m) => m.capa.handle.fronteraModulo).flatMap((m) =>
      (m.capa.handle.fronteraRouter!.stack as CapaRuta[]).filter((c) => c.route).flatMap((c) =>
        Object.keys(c.route.methods).map((verbo) => `${verbo.toUpperCase()} ${m.prefijo}${c.route.path === '/' ? '' : c.route.path}`)));
    expect(rutas).toEqual(RUTAS_SOAT_ABIERTAS);
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
