// HU #13959 (Feature #13940) — Un proveedor SOAT inactivo o eliminado no se puede elegir como destino (RN-PROV-5).
//
// Aquí se mide la RUTA con la base mockeada: el envío (`POST /flito/soat/enviar`, 409, AC1/AC2) y el gestor por defecto
// de la compañía (`PATCH /flito/parametrizacion/companias/:id`, 400, AC3; 200 si el valor no cambia, AC4). Cada caso
// negativo comprueba además que NO hubo escritura: un 409 que igual envió es un 409 inútil. El `FOR SHARE`, la
// concurrencia (AC6) y el canal sin trámite (AC5) contra PostgreSQL de verdad están en
// `__tests__/db/proveedores-soat-inactivo.test.ts`.
import 'express-async-errors'; // Como en `app.ts`: un error sin capturar en trámites llega a `errorHandler` (el 500).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const { selectMock, updateMock, transactionMock } = vi.hoisted(() => ({
  selectMock: vi.fn(), updateMock: vi.fn(), transactionMock: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); });

const SOAT_ID = '00000000-0000-0000-0000-000000000001';
const P = '00000000-0000-0000-0000-0000000000aa';
const OTRO = '00000000-0000-0000-0000-0000000000bb';
const INACTIVO = 'El gestor Gestora Andina está inactivo: elige otro gestor.';
const NO_EXISTE = 'El gestor seleccionado no existe o fue eliminado.';

const auth = async () => `Bearer ${await testToken({ sub: 7, username: 'ops@flitsas.com', role: 'admin' })}`;

/** La tx: la 1.ª lectura es el padre `FOR SHARE`, la 2.ª su perfil vivo (R11); las demás, las filas bloqueadas del envío. */
function montarTx(proveedor: unknown[], perfil: unknown[] = [{ id: P }]) {
  const txSelect = vi.fn().mockReturnValue(chain([{ id: SOAT_ID }]));
  txSelect.mockReturnValueOnce(chain(proveedor));
  txSelect.mockReturnValueOnce(chain(perfil));
  const txUpdate = vi.fn().mockReturnValue(chain([{ id: SOAT_ID }]));
  const txInsert = vi.fn().mockReturnValue(chain([]));
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ select: txSelect, update: txUpdate, insert: txInsert }));
  return { txSelect, txUpdate, txInsert };
}

async function appSoat() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}

const enviar = async (proveedorSoatId: string) => request(await appSoat()).post('/api/flito/soat/enviar')
  .set('Authorization', await auth()).send({ ids: [SOAT_ID], proveedorSoatId });

describe('POST /flito/soat/enviar — proveedor no utilizable (HU #13959)', () => {
  it('AC1: proveedor inactivo → 409 «El gestor P está inactivo: elige otro gestor.» y no se envía nada', async () => {
    const { txUpdate, txInsert } = montarTx([{ nombre: 'Gestora Andina', activo: false, deletedAt: null }]);
    const r = await enviar(P);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: INACTIVO });
    expect(txUpdate).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('AC2: proveedor eliminado (aunque siga `activo`) → 409 «no existe o fue eliminado» y no se envía nada', async () => {
    const { txUpdate } = montarTx([{ nombre: 'Gestora Andina', activo: true, deletedAt: new Date() }]);
    const r = await enviar(P);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: NO_EXISTE });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC2: proveedor inexistente → 409 con el mismo texto (no un 500 por la FK)', async () => {
    const { txUpdate } = montarTx([]);
    const r = await enviar(OTRO);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: NO_EXISTE });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('proveedor activo y vigente → 200; el estado se lee DENTRO de la transacción del envío', async () => {
    const { txSelect, txUpdate } = montarTx([{ nombre: 'Gestora Andina', activo: true, deletedAt: null }]);
    const r = await enviar(P);
    expect(r.status).toBe(200);
    expect(r.body.enviados).toEqual([SOAT_ID]);
    expect(txSelect).toHaveBeenCalledTimes(3); // padre y perfil FOR SHARE + filas FOR UPDATE SKIP LOCKED
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });

  it('a gestión de Operaciones no consulta ningún proveedor', async () => {
    const { txSelect } = montarTx([]);
    txSelect.mockReset().mockReturnValue(chain([{ id: SOAT_ID }]));
    const r = await request(await appSoat()).post('/api/flito/soat/enviar')
      .set('Authorization', await auth()).send({ ids: [SOAT_ID], gestionOperaciones: true });
    expect(r.status).toBe(200);
    expect(txSelect).toHaveBeenCalledTimes(1);
  });
});

// ── Solicitudes desde Gestión Trámites (HU #14339, #14342) ─────────────────────────────────────────

const TRAMITE_ID = '00000000-0000-0000-0000-000000000002';
const VIGENTE = { nombre: 'Gestora Andina', activo: true, deletedAt: null };

/** Los tres motivos de RN-PROV-5, con lo que lee cada uno dentro de la tx y el texto que tiene que llegar. */
const NO_UTILIZABLES = [
  { caso: 'inactivo', padre: [{ ...VIGENTE, activo: false }], perfil: [{ id: P }], error: INACTIVO },
  { caso: 'eliminado', padre: [{ ...VIGENTE, deletedAt: new Date() }], perfil: [{ id: P }], error: NO_EXISTE },
  { caso: 'sin servicio SOAT', padre: [VIGENTE], perfil: [], error: NO_EXISTE },
];

async function appTramites() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  app.use('/api/flito/tramites', conAlcance('tramites', router));
  app.use(errorHandler);
  return app;
}

describe.each(['solicitar-soat', 'solicitar-ambos'])('POST /flito/tramites/%s — proveedor no utilizable', (ruta) => {
  const solicitar = async () => request(await appTramites()).post(`/api/flito/tramites/${ruta}`)
    .set('Authorization', await auth()).send({ tramiteIds: [TRAMITE_ID], proveedorSoatId: P });

  beforeEach(() => { selectMock.mockReturnValue(chain([{ soatId: SOAT_ID, soatAutogestionable: false }])); });

  it.each(NO_UTILIZABLES)('$caso → 409 con el mensaje del error, no el genérico, y no se envía nada', async ({ padre, perfil, error }) => {
    const { txUpdate, txInsert } = montarTx(padre, perfil);
    const r = await solicitar();
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error });
    expect(txUpdate).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
    expect(transactionMock).toHaveBeenCalledTimes(1); // Tampoco se llega a pedir impuestos.
  });

  it('proveedor vigente → 200 y el SOAT se envía', async () => {
    const { txUpdate } = montarTx([VIGENTE]);
    const r = await solicitar();
    expect(r.status).toBe(200);
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });
});

// ── Cambiar proveedor y devolver al proveedor (HU #14339, #14342) ──────────────────────────────────

/** La fila que hace válida cada operación, para que lo único que rechace sea el proveedor. */
const OPERACIONES = [
  {
    nombre: 'POST /:id/proveedor',
    ruta: 'proveedor',
    fila: { id: SOAT_ID, estado: 'pendiente', companiaId: 1, proveedorSoatId: OTRO, gestionOperaciones: false },
    cuerpo: { proveedorSoatId: P, motivo: 'cambio de convenio' },
  },
  {
    nombre: 'POST /:id/devolver-gestor',
    ruta: 'devolver-gestor',
    fila: { id: SOAT_ID, estado: 'solicitado', companiaId: 1, proveedorSoatId: OTRO, gestionOperaciones: true },
    cuerpo: { proveedorSoatId: P, motivo: 'ya puede retomarlo' },
  },
];

const operar = async (ruta: string, cuerpo: Record<string, unknown>) => request(await appSoat())
  .post(`/api/flito/soat/${SOAT_ID}/${ruta}`).set('Authorization', await auth()).send(cuerpo);

describe.each(OPERACIONES)('$nombre — proveedor no utilizable', ({ ruta, fila, cuerpo }) => {
  beforeEach(() => { selectMock.mockReturnValueOnce(chain([fila])).mockReturnValue(chain([])); });

  it.each(NO_UTILIZABLES)('$caso → 409 con el mensaje del error y la asignación no cambia', async ({ padre, perfil, error }) => {
    const { txUpdate, txInsert } = montarTx(padre, perfil);
    const r = await operar(ruta, cuerpo);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error });
    expect(txUpdate).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('proveedor vigente → 200, se asigna, y la validación va antes de escribir en `flito_soat` (ADR-0039)', async () => {
    const { txSelect, txUpdate } = montarTx([VIGENTE]);
    const sets: Record<string, unknown>[] = [];
    txUpdate.mockImplementation(() => {
      const c = chain([{ id: SOAT_ID, estado: fila.estado, motivoRechazo: null }]);
      return { ...c, set: (v: Record<string, unknown>) => { sets.push(v); return c; } };
    });
    const r = await operar(ruta, cuerpo);
    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({ proveedorSoatId: P, proveedorSobrescrito: true });
    expect(txSelect).toHaveBeenCalledTimes(2); // padre y perfil, los dos FOR SHARE
    expect(txSelect.mock.invocationCallOrder[1]!).toBeLessThan(txUpdate.mock.invocationCallOrder[0]!);
  });
});

describe('las validaciones de negocio siguen antes que la del proveedor', () => {
  const [cambiar, devolver] = OPERACIONES as [typeof OPERACIONES[0], typeof OPERACIONES[0]];
  const rechazoSinTx = async (ruta: string, cuerpo: Record<string, unknown>, fila: unknown[], status: number, texto: RegExp) => {
    selectMock.mockReturnValueOnce(chain(fila));
    const r = await operar(ruta, cuerpo);
    expect(r.status).toBe(status);
    expect(r.body.error).toMatch(texto);
    expect(transactionMock).not.toHaveBeenCalled();
  };

  it('el SOAT no existe → 404 en las dos', async () => {
    await rechazoSinTx(cambiar.ruta, cambiar.cuerpo, [], 404, /El SOAT no existe/);
    await rechazoSinTx(devolver.ruta, devolver.cuerpo, [], 404, /El SOAT no existe/);
  });

  it('cambiar: RN-05 (en adquisición) y luego el motivo en blanco → 400', async () => {
    await rechazoSinTx(cambiar.ruta, cambiar.cuerpo, [{ ...cambiar.fila, estado: 'solicitado' }], 400, /RN-05/);
    await rechazoSinTx(cambiar.ruta, { ...cambiar.cuerpo, motivo: '   ' }, [cambiar.fila], 400, /motivo/);
  });

  it('devolver: lo que Operaciones no gestiona → 400', async () => {
    await rechazoSinTx(devolver.ruta, devolver.cuerpo, [{ ...devolver.fila, gestionOperaciones: false }], 400, /no lo gestiona Operaciones/);
  });
});

// ── Gestor por defecto de la compañía ──────────────────────────────────────────────────────────────

async function appParam() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.routes.js');
  app.use('/api/flito/parametrizacion', router);
  return app;
}

/** `previo` = la fila de la compañía antes del PATCH; `proveedor` = lo que devuelve el `FOR SHARE` dentro de la tx. */
function montarCompania(previo: { proveedorSinTramiteId: string | null; soatSinTramite?: boolean }, proveedor: unknown[]) {
  selectMock.mockReturnValueOnce(chain([{ id: 1, soatSinTramite: false, ...previo }]));
  // La 2.ª lectura es el perfil vivo, también `FOR SHARE` (R11): existe mientras el spec no diga otra cosa.
  const txSelect = vi.fn().mockReturnValue(chain([{ id: P }]));
  txSelect.mockReturnValueOnce(chain(proveedor));
  const sets: Record<string, unknown>[] = [];
  const txUpdate = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      return { where: () => ({ returning: () => Promise.resolve([{ id: 1, name: 'Acme', flitoProveedorSoatSinTramiteId: P }]) }) };
    },
  }));
  transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn({ select: txSelect, update: txUpdate }));
  return { txSelect, txUpdate, sets };
}

const patchCompania = async (cuerpo: Record<string, unknown>) => request(await appParam())
  .patch('/api/flito/parametrizacion/companias/1').set('Authorization', await auth()).send(cuerpo);

describe('PATCH /flito/parametrizacion/companias/:id — gestor por defecto (HU #13959)', () => {
  it('AC3: fijar un proveedor inactivo → 400 con el texto de AC1 y no se escribe', async () => {
    const { txUpdate } = montarCompania({ proveedorSinTramiteId: null },
      [{ nombre: 'Gestora Andina', activo: false, deletedAt: null }]);
    const r = await patchCompania({ proveedorSoatSinTramiteId: P });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: INACTIVO, campo: 'proveedorSoatSinTramiteId' });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC3: fijar un proveedor eliminado o inexistente → 400 «no existe o fue eliminado»', async () => {
    let m = montarCompania({ proveedorSinTramiteId: null }, [{ nombre: 'Gestora Andina', activo: true, deletedAt: new Date() }]);
    let r = await patchCompania({ proveedorSoatSinTramiteId: P });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: NO_EXISTE, campo: 'proveedorSoatSinTramiteId' });
    expect(m.txUpdate).not.toHaveBeenCalled();

    m = montarCompania({ proveedorSinTramiteId: P }, []);
    r = await patchCompania({ proveedorSoatSinTramiteId: OTRO });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(NO_EXISTE);
    expect(m.txUpdate).not.toHaveBeenCalled();
  });

  it('AC4: la compañía YA tenía P (hoy inactivo) y el formulario lo reenvía al editar otro campo → 200, sin consultar P', async () => {
    const { txSelect, sets } = montarCompania({ proveedorSinTramiteId: P, soatSinTramite: true },
      [{ nombre: 'Gestora Andina', activo: false, deletedAt: null }]);
    const r = await patchCompania({ proveedorSoatSinTramiteId: P, toleranciaValorImpuesto: 500 });
    expect(r.status).toBe(200);
    expect(txSelect).not.toHaveBeenCalled();
    expect(sets[0]).toMatchObject({ flitoToleranciaValorImpuesto: '500' });
  });

  it('cambiar a un proveedor activo y vigente → 200 y se escribe', async () => {
    const { txSelect, sets } = montarCompania({ proveedorSinTramiteId: null },
      [{ nombre: 'Gestora Andina', activo: true, deletedAt: null }]);
    const r = await patchCompania({ proveedorSoatSinTramiteId: P });
    expect(r.status).toBe(200);
    expect(txSelect).toHaveBeenCalledTimes(2); // padre y perfil, los dos FOR SHARE
    expect(sets[0]).toEqual({ flitoProveedorSoatSinTramiteId: P });
  });
});
