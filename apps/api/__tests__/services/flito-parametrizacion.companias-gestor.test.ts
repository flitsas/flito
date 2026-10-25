// HU #12078 (Feature #12074) — el gestor por defecto del canal «SOAT sin trámite», en la ficha de la
// compañía: `PATCH /api/flito/parametrizacion/companias/:id`.
//
// Es la otra mitad de la HU. El alta despacha al gestor por defecto de la compañía; aquí se
// configura ese gestor. Desde la HU #13967 el gestor ES el canal: `null` = «Sin proveedor» = cerrado.
//
// ── Lo que se prueba y por qué así ───────────────────────────────────────────────────────────────
//
// **Se mide el `set` del UPDATE, no la respuesta.** El mock keyed devuelve la fila que el test
// registre, así que afirmar sobre el cuerpo probaría el mock. Lo que decide qué se escribe es el
// objeto que llega a `update().set()` (`espia-drizzle`).
//
// **Las guardas se prueban por su EFECTO, no solo por el status.** Un 400 que igual escribió es un
// 400 inútil: cada caso negativo comprueba además que no hubo UPDATE.
//
// **El estado RESULTANTE, no lo que llega.** El PATCH es leer-y-luego-escribir y casi nunca trae las
// dos claves: «encender el flag a secas» y «quitar el gestor a secas» son los dos casos normales, y
// los dos llegan a la misma invariante desde lados distintos. Por eso el handler lee la fila previa
// y por eso aquí se registran previas distintas.
//
// **HU #13967:** el flag y el CHECK `clients_sin_tramite_gestor_chk` se retiraron (0262). El proveedor
// ES el canal: `null` lo cierra y no hay estado ilegal que vigilar entre dos columnas.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

const auditMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const COMPANIA = 1;
const GESTOR = '55555555-5555-4555-8555-555555555555';
const OTRO = '66666666-6666-4666-8666-666666666666';

/**
 * La app con el `errorHandler` REAL montado, como en `app.ts`.
 *
 * No es decoración: el handler deja pasar por `next(e)` todo error que no sea de proveedor no usable
 * (HU #13967: ya no traduce el `23514` del CHECK retirado). Sin el `errorHandler`, «todo lo demás» acabaría en la página por defecto de Express y
 * el caso que comprueba que el `catch` es ESTRECHO no estaría midiendo el camino de producción.
 */
async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  app.use('/api/flito/parametrizacion', router);
  app.use(errorHandler);
  return app;
}

const auth = async (role: 'admin' | 'auditor' = 'admin') =>
  `Bearer ${await testToken({ sub: 1, username: 'ops@flito.co', role })}`;

/** La fila de `clients` que el `returning()` del UPDATE devuelve, para el DTO. */
const filaCompania = (over: Record<string, unknown> = {}) => ({
  id: COMPANIA, name: 'Acme', document: '900',
  soatAutogestionable: false, soatSinTramite: false,
  impuestosAutogestionable: false, logisticaAutogestionable: false, logisticaPermiteParcial: false,
  flitoCarpetaStorage: null, flitoToleranciaValorImpuesto: '0',
  flitoProveedorSoatSinTramiteId: null, ...over,
});

/**
 * Registra el estado PREVIO de la compañía y el catálogo de proveedores.
 *
 * `proveedores: []` significa «ese uuid no existe»; el mock keyed responde por tabla y el handler
 * consulta el catálogo solo cuando el cuerpo trae un uuid.
 */
function escenario(opciones: {
  previa?: { proveedorSinTramiteId: string | null } | null;
  proveedores?: { id: string; activo: boolean }[];
  devuelve?: Record<string, unknown>;
  updateFalla?: unknown;
} = {}) {
  const previa = opciones.previa === undefined
    ? { proveedorSinTramiteId: null }
    : opciones.previa;

  kdb.when.scenario({
    clients: previa ? [{ id: COMPANIA, ...previa }] : [],
    flito_proveedores_soat: opciones.proveedores ?? [],
  });
  if (opciones.updateFalla !== undefined) {
    kdb.when.update('clients', () => { throw opciones.updateFalla; });
  } else {
    kdb.when.update('clients', [opciones.devuelve ?? filaCompania()]);
  }
}

const patch = async (cuerpo: Record<string, unknown>, id: number | string = COMPANIA) =>
  request(await buildApp())
    .patch(`/api/flito/parametrizacion/companias/${id}`)
    .set('Authorization', await auth())
    .send(cuerpo);

const setEscrito = () => espia.updatesEn('clients').at(-1)?.datos;

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  auditMock.mockClear();
});

// ═══════════ AC2b — la configuración vive en la ficha de la compañía ═════════

describe('AC2b — el endpoint acepta el gestor y lo valida contra el catálogo ACTIVO', () => {
  it('**un gestor activo se acepta y se escribe**', async () => {
    escenario({ proveedores: [{ id: GESTOR, activo: true }] });

    const r = await patch({ proveedorSoatSinTramiteId: GESTOR });

    expect(r.status).toBe(200);
    expect(setEscrito()).toEqual({ flitoProveedorSoatSinTramiteId: GESTOR });
  });

  it('**un uuid que no existe en el catálogo → 400 y CERO escrituras**', async () => {
    escenario({ proveedores: [] });

    const r = await patch({ proveedorSoatSinTramiteId: OTRO });

    expect(r.status).toBe(400);
    expect(r.body.campo).toBe('proveedorSoatSinTramiteId');
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });

  it('**un proveedor INACTIVO → 400**: «válida incluye vigente»', async () => {
    // El mutante que mata: validar solo la existencia (`if (!proveedor)`). Aceptar un proveedor
    // apagado —que la pantalla ya no ofrece— convierte el catálogo en una lista de sugerencias, y
    // el alta del canal mandaría todo a contingencia sin que nadie lo hubiera decidido.
    escenario({ proveedores: [{ id: GESTOR, activo: false }] });

    const r = await patch({ proveedorSoatSinTramiteId: GESTOR });

    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/inactivo/i);
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });

  it('un valor que no es uuid lo rechaza Zod, sin llegar a la base', async () => {
    escenario({ proveedores: [{ id: GESTOR, activo: true }] });

    const r = await patch({ proveedorSoatSinTramiteId: 'sura' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });

  it('**si el cuerpo NO trae gestor, el catálogo ni se consulta**', async () => {
    // Una consulta por PATCH que no la necesita. Se mide contando lecturas de la tabla del catálogo:
    // el mock enruta por nombre de tabla, así que esto no depende de lo que devuelva.
    escenario({ previa: { proveedorSinTramiteId: GESTOR } });

    const r = await patch({ carpetaStorage: 'clientes/acme' });

    expect(r.status).toBe(200);
    expect(setEscrito()).toEqual({ flitoCarpetaStorage: 'clientes/acme' });
  });

  it('**el DTO lo expone**, para que la pantalla pueda pintarlo (el selector es la HU #12079)', async () => {
    escenario({
      proveedores: [{ id: GESTOR, activo: true }],
      devuelve: filaCompania({ flitoProveedorSoatSinTramiteId: GESTOR }),
    });

    const r = await patch({ proveedorSoatSinTramiteId: GESTOR });

    expect(r.status).toBe(200);
    expect(r.body.proveedorSoatSinTramiteId).toBe(GESTOR);
  });

  it('**la compañía que no existe es 404 y no llega al UPDATE**', async () => {
    // El 404 salía del `returning()`; ahora se adelanta a la lectura previa. Si esa lectura vacía
    // se tragara —«no hay previa, sigo»— el handler validaría el estado resultante contra `undefined`
    // y encender el flag pasaría en un id inexistente.
    escenario({ previa: null });

    const r = await patch({ soatSinTramite: true }, 999);

    expect(r.status).toBe(404);
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });
});

// ═══════════ HU #13967 — el proveedor es el canal (antes AC2c: flag + CHECK) ═══

describe('HU #13967 — el proveedor ES el canal: no hay flag que atar', () => {
  it('**elegir un proveedor activo abre el canal**: solo se escribe el proveedor, `soatSinTramite` se ignora', async () => {
    escenario({
      previa: { proveedorSinTramiteId: null },
      proveedores: [{ id: GESTOR, activo: true }],
      devuelve: filaCompania({ soatSinTramite: true, flitoProveedorSoatSinTramiteId: GESTOR }),
    });

    const r = await patch({ soatSinTramite: false, proveedorSoatSinTramiteId: GESTOR });

    expect(r.status).toBe(200);
    expect(setEscrito()).toEqual({ flitoProveedorSoatSinTramiteId: GESTOR });
    expect(r.body.soatSinTramite).toBe(true);
  });

  it('**«Sin proveedor» (`null`) con el canal abierto se guarda**: es cómo se cierra (ya no hay 400)', async () => {
    escenario({
      previa: { proveedorSinTramiteId: GESTOR },
      devuelve: filaCompania(),
    });

    const r = await patch({ soatSinTramite: true, proveedorSoatSinTramiteId: null });

    expect(r.status).toBe(200);
    expect(setEscrito()).toEqual({ flitoProveedorSoatSinTramiteId: null });
    expect(r.body.soatSinTramite).toBe(false);
  });

  it('**un PATCH con SOLO `soatSinTramite` → 400 «Nada que actualizar» y CERO escrituras**', async () => {
    escenario({ previa: { proveedorSinTramiteId: null } });

    const r = await patch({ soatSinTramite: true });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Nada que actualizar');
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });

  it('**un 23514 de la base ya no se traduce a un consejo de configuración**: sale por `errorHandler`', async () => {
    escenario({
      previa: { proveedorSinTramiteId: null },
      proveedores: [{ id: GESTOR, activo: true }],
      updateFalla: Object.assign(new Error('violates check constraint'),
        { code: '23514', constraint_name: 'clients_sin_tramite_gestor_chk' }),
    });

    const r = await patch({ proveedorSoatSinTramiteId: GESTOR });

    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/gestor por defecto|proveedorSoatSinTramiteId/);
  });
});

describe('GET /companias devuelve el gestor por defecto', () => {
  it('**el DTO lo trae, y separado de la bandera**: son dos preguntas', async () => {
    kdb.when.scenario({
      clients: [filaCompania({ soatSinTramite: true, flitoProveedorSoatSinTramiteId: GESTOR })],
    });

    const r = await request(await buildApp())
      .get('/api/flito/parametrizacion/companias').set('Authorization', await auth('auditor'));

    expect(r.status).toBe(200);
    expect(r.body[0].soatSinTramite).toBe(true);
    expect(r.body[0].proveedorSoatSinTramiteId).toBe(GESTOR);
  });

  it('una compañía sin el canal abierto lo devuelve en `null`, y la clave EXISTE', async () => {
    // Una clave ausente obligaría a la pantalla a distinguir «no configurado» de «esta versión del
    // API no lo manda».
    kdb.when.scenario({ clients: [filaCompania()] });

    const r = await request(await buildApp())
      .get('/api/flito/parametrizacion/companias').set('Authorization', await auth());

    expect(r.body[0].proveedorSoatSinTramiteId).toBeNull();
    expect(Object.keys(r.body[0])).toContain('proveedorSoatSinTramiteId');
  });
});

// ═══════════ La decisión de enrutamiento queda registrada ════════════════════

describe('el `audit` del PATCH dice QUÉ cambió, no solo quién y cuándo', () => {
  // «Operaciones redirigió el canal de esta compañía a otra aseguradora» decide a qué gestor van a
  // parar TODAS las solicitudes que esa compañía radique a partir de ese instante. `clients` guarda
  // el estado actual y no lo versiona: si el registro solo tiene actor e instante, el cambio no es
  // reconstruible después — no hay dónde mirar de qué gestor a cuál se movió.
  const detalleAuditado = () =>
    String((auditMock.mock.calls.at(-1)?.[1] as { detail?: unknown } | undefined)?.detail ?? '');

  it('**redirigir el canal a otra aseguradora deja el uuid del gestor en el `detail`**', async () => {
    escenario({
      previa: { proveedorSinTramiteId: OTRO },
      proveedores: [{ id: GESTOR, activo: true }],
      devuelve: filaCompania({ flitoProveedorSoatSinTramiteId: GESTOR }),
    });

    const r = await patch({ proveedorSoatSinTramiteId: GESTOR });

    expect(r.status).toBe(200);
    // El formato de siempre se conserva —la compañía por su nombre— y el contenido se añade detrás.
    expect(detalleAuditado()).toContain('Parametrización compañía Acme');
    expect(detalleAuditado()).toContain(GESTOR);
  });

  it('**elegir el proveedor se registra como «Proveedor SOAT sin trámite: X»**, sin «activado»', async () => {
    escenario({
      previa: { proveedorSinTramiteId: null },
      proveedores: [{ id: GESTOR, activo: true }],
      devuelve: filaCompania({ soatSinTramite: true, flitoProveedorSoatSinTramiteId: GESTOR }),
    });

    const r = await patch({ soatSinTramite: true, proveedorSoatSinTramiteId: GESTOR });

    expect(r.status).toBe(200);
    expect(detalleAuditado()).toContain(`Proveedor SOAT sin trámite: ${GESTOR}`);
    expect(detalleAuditado()).not.toMatch(/activado|desactivado/i);
  });

  it('**«Sin proveedor» se registra**: un `null` es una decisión, no una clave ausente', async () => {
    escenario({
      previa: { proveedorSinTramiteId: GESTOR },
      devuelve: filaCompania(),
    });

    const r = await patch({ proveedorSoatSinTramiteId: null });

    expect(r.status).toBe(200);
    expect(detalleAuditado()).toContain('Proveedor SOAT sin trámite: Sin proveedor');
  });

  it('**un PATCH que no toca el canal no inventa el cambio**: se registra lo que VINO en el cuerpo', async () => {
    // El mutante que mata: componer el `detail` con el estado RESULTANTE en vez de con `cambios`.
    // Un PATCH de la carpeta de storage dejaría escrito «gestor por defecto: …» sin que nadie lo
    // hubiera tocado, y el registro afirmaría una decisión que no se tomó.
    escenario({
      previa: { proveedorSinTramiteId: GESTOR },
      devuelve: filaCompania({ soatSinTramite: true, flitoProveedorSoatSinTramiteId: GESTOR }),
    });

    const r = await patch({ carpetaStorage: 'clientes/acme' });

    expect(r.status).toBe(200);
    expect(detalleAuditado()).toBe('Parametrización compañía Acme');
    expect(detalleAuditado()).not.toContain(GESTOR);
  });
});

describe('el gestor por defecto es ESCRITURA de Operaciones', () => {
  it('auditor → 403, y ni siquiera se lee la compañía', async () => {
    escenario({ proveedores: [{ id: GESTOR, activo: true }] });

    const r = await request(await buildApp())
      .patch(`/api/flito/parametrizacion/companias/${COMPANIA}`)
      .set('Authorization', await auth('auditor'))
      .send({ proveedorSoatSinTramiteId: GESTOR });

    expect(r.status).toBe(403);
    expect(espia.updatesEn('clients')).toHaveLength(0);
  });
});
