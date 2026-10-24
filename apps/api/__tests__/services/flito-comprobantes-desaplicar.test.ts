process.env.TZ = 'UTC';
// HU #13903 (Feature #13886) — DESAPLICAR y REEMPLAZAR un comprobante aplicado
// (`flito-comprobantes.desaplicar.ts`, rutas `POST /:id/desaplicar` y `POST /:id/reemplazar`).
//
// `db` es el mock keyed por tabla; `db.transaction` corre el callback contra el MISMO mock pero con
// ROLLBACK emulado: si el callback lanza, las escrituras que el espía registró dentro se descartan. Así
// «nada cambia» se afirma como «cero escrituras confirmadas», y «la reversa del dueño se deshace con un
// fallo posterior» (nota de QA A) como «la reversa corrió, pero su UPDATE no quedó».
//
// Espías: la guarda y la reversa de la bolsa (`exigirDescuentoReversible` / `revertirDescuentoComprobante`,
// la guarda es no-op hasta la HU-D: AC9 la hace lanzar), las reversas de SOAT e impuesto (`reversarEnTx`,
// con la implementación REAL por defecto: sus escrituras llegan al espía), `prepararAplicacion` (el
// reemplazo: un plan falso registra cuándo corre su `enTx`) y `detalle` (la respuesta).
//
// Mutantes que estos tests matan (los del QA A y los propios):
//   · quitar el FOR UPDATE del comprobante → «AC8 … primer bloqueo de la tx es flito_comprobantes» cae.
//   · omitir o invertir la reversa antes de aplicar el reemplazo → «AC7 … orden» cae.
//   · dejar pasar el derecho → «AC3 …» recibe 200 y cae.
//   · reversa del dueño fuera de la tx → «AC7 si falla el reemplazo … sin UPDATE de flito_impuestos» cae.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { getTableName } from 'drizzle-orm';
import { USER_ROLES } from '@operaciones/shared-types';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken, fuenteDePrueba, operacionesDePartida } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import { expandir } from '../../src/modules/permisos/arbol/expansion.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }) }));
const auditMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock.fn }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined), ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: vi.fn(), presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn() }));
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.ocr.js', () => ({ particionar: vi.fn(), leerSubDocumento: vi.fn() }));
const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logMock };
vi.mock('../../src/shared/logger.js', () => ({ loggerFor: () => logMock, logger: logMock }));

/** El orden en que corren los pasos con efecto (bolsa, dueño, reemplazo). */
const h = vi.hoisted(() => ({
  orden: [] as string[],
  exigir: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>,
  revertir: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>,
  reversaSoat: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>,
  reversaImp: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>,
  preparar: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>,
  detalle: null as unknown as ReturnType<typeof import('vitest')['vi']['fn']>,
}));
vi.mock('../../src/modules/flito-bolsas/flito-bolsas.descuento.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  h.exigir = vi.fn(); h.revertir = vi.fn();
  return { ...real, exigirDescuentoReversible: h.exigir, revertirDescuentoComprobante: h.revertir };
});
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (orig) => {
  const real = await orig() as typeof import('../../src/modules/flito-soat/flito-soat.service.js');
  h.reversaSoat = vi.fn(async (...a: Parameters<typeof real.reversarEnTx>) => { h.orden.push('reversa_soat'); return real.reversarEnTx(...a); });
  return { ...real, reversarEnTx: h.reversaSoat };
});
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', async (orig) => {
  const real = await orig() as typeof import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
  h.reversaImp = vi.fn(async (...a: Parameters<typeof real.reversarEnTx>) => { h.orden.push('reversa_impuesto'); return real.reversarEnTx(...a); });
  return { ...real, reversarEnTx: h.reversaImp };
});
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  h.preparar = vi.fn();
  return { ...real, prepararAplicacion: h.preparar };
});
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  h.detalle = vi.fn(async (id: string) => ({ id }));
  return { ...real, detalle: h.detalle };
});

const { fijarFuenteDePermisos } = await import('../../src/shared/permisos-efectivos.js');
const {
  flitoComprobantes, flitoSoportes, flitoTramites, flitoImpuestos, flitoSoat, flitoEstadoHistorial, auditLogs, flitoLiquidaciones, users,
  flitoTramiteServiciosAdicionales,
} = await import('../../src/db/schema.js');
const { desaplicar, reemplazar } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.desaplicar.js');
const { ComprobanteError } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js');
const { PeriodoCerradoError } = await import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
const { SoatError } = await import('../../src/modules/flito-soat/flito-soat.service.js');

const T_COMP = getTableName(flitoComprobantes);
const T_SOP = getTableName(flitoSoportes);
const T_TRAM = getTableName(flitoTramites);
const T_IMP = getTableName(flitoImpuestos);
const T_SOAT = getTableName(flitoSoat);
const T_HIST = getTableName(flitoEstadoHistorial);
const T_AUDIT = getTableName(auditLogs);
const T_LIQ = getTableName(flitoLiquidaciones);
const T_USERS = getTableName(users);
const T_SA = getTableName(flitoTramiteServiciosAdicionales);
const TIPO = '8d2e1f3a-4b5c-4d6e-9f70-1a2b3c4d5e6f';
const BASE = '/api/flito/comprobantes';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const R_ID = '82141ddf-2b5d-4ac7-966e-0dd91bbed5fa';
const T1 = '5a3c4c2e-0f9b-4e6e-9a1d-2c3b4a5d6e7f';
const CTX = { userId: 7, username: 'u@flitsas.io', role: 'financiera' };
const MOTIVO = 'Se aplicó al trámite equivocado';

const fila = (over: Record<string, unknown> = {}) => ({
  id: ID, estado: 'aplicado', tramiteId: T1, concepto: 'soat', esPago: true, soporteId: 'sop-1', servicioTipoId: null,
  saAsignacionPrevia: null, saValorPrevio: null, ...over,
});
const tramite = { id: T1, idFlit: 'FLIT-ABC001', soatId: 'soat-1' };

const espia = crearEspia(kdb);

/** Espía de `.for(...)`: qué tabla se bloqueó y en qué orden (el mock keyed lo ignora). */
const bloqueos: { tabla: string; modo: string }[] = [];
function espiarFor() {
  const base = kdb.select.getMockImplementation() as (...a: unknown[]) => Record<string, unknown>;
  kdb.select.mockImplementation((...args: unknown[]) => {
    const c = base(...args);
    let tabla = '';
    const from = c.from as (t: unknown) => unknown;
    c.from = (t: unknown) => { try { tabla = getTableName(t as never); } catch { tabla = '?'; } return from(t); };
    c.for = (modo: string) => { bloqueos.push({ tabla, modo }); return c; };
    return c;
  });
}

/** Los DELETE (el espía solo registra INSERT/UPDATE): qué tabla, en orden. */
const borrados: string[] = [];
function espiarDelete() {
  const base = kdb.delete.getMockImplementation() as (t: unknown) => unknown;
  kdb.delete.mockImplementation((t: unknown) => { borrados.push(getTableName(t as never)); return base(t); });
}

/** `db.transaction` con ROLLBACK: lo escrito dentro de un callback que lanza no queda en el espía. */
function transaccionConRollback() {
  kdb.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const ins = espia.inserts.length; const upd = espia.updates.length; const del = borrados.length;
    try { return await cb(kdb.db); } catch (e) { espia.inserts.length = ins; espia.updates.length = upd; borrados.length = del; throw e; }
  });
}

/** Un plan falso de aplicar para el reemplazo: registra cuándo corre su `enTx` y qué había escrito ya. */
function planFalso(o: { falla?: unknown } = {}) {
  const plan = {
    compAntes: -1, impAntes: -1, saAntes: -1,
    enTx: vi.fn(async () => {
      h.orden.push('aplicar_reemplazo');
      plan.compAntes = espia.updatesEn(T_COMP).length; plan.impAntes = espia.updatesEn(T_IMP).length;
      plan.saAntes = borrados.filter((t) => t === T_SA).length + espia.updatesEn(T_SA).length;
      if (o.falla) throw o.falla;
    }),
    traducirError: vi.fn(async (e: unknown) => e),
    trasCommit: vi.fn(async () => { h.orden.push('tras_commit'); }),
    respuesta: vi.fn(async () => ({ id: R_ID, estado: 'aplicado' })),
  };
  h.preparar.mockResolvedValue(plan);
  return plan;
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.routes.js');
  app.use(BASE, conAlcance('comprobantes', router));
  app.use((err: { message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'fallback', detalle: err.message });
  });
  return app;
}
const auth = async (role: 'admin' | 'financiera' | 'auditor' = 'financiera') => `Bearer ${await testToken({ sub: 7, username: 'u@flitsas.io', role })}`;
let sub = 9100;
const comoEnlace = async (tipoEnlace: string) => `Bearer ${await testToken({
  sub: ++sub, role: 'xyz_renombrado' as never, tipoEnlace,
  funciones: ['comprobantes.comprobante.ver', 'comprobantes.comprobante.desaplicar', 'comprobantes.comprobante.reemplazar'],
})}`;

/** Escenario SOAT pagado (AC1/AC6/AC8): comprobante aplicado como pago del SOAT del trámite T1. */
function armarSoat(estadoSoat = 'pagado', over: Record<string, unknown> = {}) {
  kdb.when
    .selectOnce(T_COMP, [fila(over)]) // fuera de la tx
    .selectOnce(T_COMP, [fila(over)]) // FOR UPDATE dentro de la tx
    .select(T_COMP, [{ n: 0 }]) // soporte compartido (solo al descartar)
    .select(T_TRAM, [tramite])
    .select(T_SOAT, [{ id: 'soat-1', estado: estadoSoat }])
    .update(T_SOAT, [{ id: 'soat-1', estado: 'pendiente' }])
    .update(T_COMP, [{ id: ID }]);
}

/** Escenario impuesto pagado (AC2/AC7). */
function armarImpuesto(over: Record<string, unknown> = {}) {
  kdb.when
    .selectOnce(T_COMP, [fila({ concepto: 'impuesto', ...over })])
    .selectOnce(T_COMP, [fila({ concepto: 'impuesto', ...over })])
    .select(T_COMP, [{ n: 0 }])
    .select(T_TRAM, [tramite])
    .select(T_IMP, [{ id: 'imp-1', estado: 'pagado' }])
    .update(T_IMP, [{ id: 'imp-1' }])
    .update(T_COMP, [{ id: ID }]);
}

/** Reemplazo: original aplicado (fuera), reemplazo pendiente (fuera), bloqueo de ambos y relectura del original. */
function armarReemplazo(over: Record<string, unknown> = {}) {
  kdb.when
    .selectOnce(T_COMP, [fila({ concepto: 'impuesto', ...over })])
    .selectOnce(T_COMP, [{ estado: 'pendiente' }])
    .selectOnce(T_COMP, [{ estado: 'aplicado' }])
    .selectOnce(T_COMP, [{ estado: 'pendiente' }])
    .selectOnce(T_COMP, [fila({ concepto: 'impuesto', ...over })])
    .select(T_COMP, [{ n: 0 }])
    .select(T_TRAM, [tramite])
    .select(T_IMP, [{ id: 'imp-1', estado: 'pagado' }])
    .update(T_IMP, [{ id: 'imp-1' }])
    .update(T_COMP, [{ id: ID }]);
}

/** Lo que una petición rechazada no puede haber dejado: ninguna escritura confirmada. */
function nadaCambio() {
  expect(espia.updates).toEqual([]);
  expect(espia.inserts).toEqual([]);
  expect(borrados).toEqual([]);
}

beforeEach(() => {
  kdb.reset(); espia.reiniciar(); espiarFor(); espiarDelete(); transaccionConRollback();
  bloqueos.length = 0; h.orden.length = 0; borrados.length = 0;
  h.exigir.mockReset(); h.exigir.mockImplementation(async () => { h.orden.push('exigir_bolsa'); });
  h.revertir.mockReset(); h.revertir.mockImplementation(async () => { h.orden.push('revertir_bolsa'); return []; });
  auditMock.fn.mockReset(); auditMock.fn.mockResolvedValue(undefined);
  h.reversaSoat.mockClear(); h.reversaImp.mockClear(); h.preparar.mockReset(); h.detalle.mockClear();
});
afterEach(() => { fijarFuenteDePermisos(fuenteDePrueba); });

// ═════════════════ AC1 ══════════════════════════════════════════════════════════════════════════

describe('AC1 — desaplicar un SOAT a «pendiente»', () => {
  it('tx única: bolsa (guarda → reversa), SOAT a Pendiente con su reversa, comprobante pendiente sin trámite', async () => {
    armarSoat();
    const r = await desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX);
    expect(r).toEqual({ comprobante: { id: ID }, destino: 'pendiente', motivo: MOTIVO });
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(h.orden).toEqual(['exigir_bolsa', 'revertir_bolsa', 'reversa_soat']);
    expect(h.revertir).toHaveBeenCalledWith(expect.anything(), ID, { userId: 7, nombre: 'u@flitsas.io' }, { motivo: `Desaplicación del comprobante: ${MOTIVO}` });

    const [soat] = espia.updatesEn(T_SOAT);
    expect(soat!.datos).toMatchObject({ estado: 'pendiente', pagadoEn: null, valorPagado: null, enviadoEn: null });
    const [hist] = espia.insertsEn(T_HIST);
    expect(hist!.datos).toMatchObject({ concepto: 'soat', registroId: 'soat-1', estadoAnterior: 'pagado', estadoNuevo: 'pendiente', motivo: `Reversa: Comprobante desaplicado: ${MOTIVO}`, usuarioId: 7 });

    const [comp] = espia.updatesEn(T_COMP);
    expect(comp!.datos).toMatchObject({
      estado: 'pendiente', tramiteId: null, esPago: null, valor: null, soporteAplicadoId: null,
      aplicadoPorId: null, aplicadoEn: null, aplicadoMotivo: null, aplicadoAutomaticamente: false,
      // `flito_comprobantes_pendiente_chk`: un pendiente lleva motivo. Vuelve «leído, pendiente de asociar».
      motivoPendiente: 'leido', detallePendiente: `Desaplicado: ${MOTIVO}`,
    });
    expect(espia.updatesEn(T_SOP)).toEqual([]); // a pendiente el archivo no se libera
  });

  it('por HTTP: 200 { resultado: desaplicado } y rastro quién (usuario del token) / cuándo (audit_logs) / motivo', async () => {
    armarSoat();
    const res = await request(await buildApp()).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resultado: 'desaplicado', comprobante: { id: ID } });
    expect(auditMock.fn).toHaveBeenCalledTimes(1);
    const [req, entrada] = auditMock.fn.mock.calls[0]!;
    expect((req as { user: { sub: number } }).user.sub).toBe(7);
    expect(entrada).toEqual({ action: 'update', resource: 'flito_comprobante', resourceId: ID, detail: `Comprobante desaplicado a pendiente: ${MOTIVO}` });
  });
});

// ═════════════════ AC2 ══════════════════════════════════════════════════════════════════════════

describe('AC2 — desaplicar un impuesto a «descartado»', () => {
  it('el impuesto vuelve a Pendiente con su reversa (historial + audit) y el comprobante queda descartado con quién/cuándo/motivo', async () => {
    armarImpuesto();
    await desaplicar(ID, { destino: 'descartado', motivo: MOTIVO }, CTX);
    expect(h.orden).toEqual(['exigir_bolsa', 'revertir_bolsa', 'reversa_impuesto']);
    const [imp] = espia.updatesEn(T_IMP);
    expect(imp!.datos).toMatchObject({ estado: 'pendiente', pagadoEn: null, marcadoPorDiferencia: false });
    expect(espia.insertsEn(T_HIST)[0]!.datos).toMatchObject({ concepto: 'impuesto', registroId: 'imp-1', estadoAnterior: 'pagado', estadoNuevo: 'pendiente' });
    const audits = espia.insertsEn(T_AUDIT).map((m) => m.datos);
    expect(audits).toContainEqual(expect.objectContaining({ resource: 'flito_impuesto', resourceId: 'imp-1' }));

    const [comp] = espia.updatesEn(T_COMP);
    expect(comp!.datos).toMatchObject({ estado: 'descartado', descartadoPorId: 7, descartadoMotivo: MOTIVO });
    expect(comp!.datos.descartadoEn).toBeInstanceOf(Date);
    // Nadie más comparte el archivo: se libera como en `descartar`.
    expect(espia.updatesEn(T_SOP)[0]!.datos).toEqual({ descartado: true });
  });
});

// ═════════════════ AC3 ══════════════════════════════════════════════════════════════════════════

describe('AC3 — derecho: 409 dueno_no_reversible «Corrige el pago en su módulo»; nada cambia', () => {
  it('desaplicar: 409 sin abrir la tx ni tocar la bolsa', async () => {
    kdb.when.select(T_COMP, [fila({ concepto: 'derecho' })]);
    const res = await request(await buildApp()).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'dueno_no_reversible', detalle: 'Corrige el pago en su módulo' });
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(h.exigir).not.toHaveBeenCalled(); expect(h.revertir).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('reemplazar: el mismo 409; no se prepara el reemplazo', async () => {
    kdb.when.select(T_COMP, [fila({ concepto: 'derecho' })]);
    const res = await request(await buildApp()).post(`${BASE}/${ID}/reemplazar`).set('Authorization', await auth()).send({ reemplazoId: R_ID, motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'dueno_no_reversible', detalle: 'Corrige el pago en su módulo' });
    expect(h.preparar).not.toHaveBeenCalled();
    expect(h.revertir).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('también bajo el bloqueo: si la fila de dentro de la tx es un derecho, 409 y rollback', async () => {
    kdb.when.selectOnce(T_COMP, [fila()]).selectOnce(T_COMP, [fila({ concepto: 'derecho' })]).select(T_TRAM, [tramite]);
    await expect(desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX)).rejects.toMatchObject({ status: 409, codigo: 'dueno_no_reversible' });
    expect(h.revertir).not.toHaveBeenCalled();
    nadaCambio();
  });
});

// ═════════════════ AC4 ══════════════════════════════════════════════════════════════════════════

describe('AC4 — no aplicado → 409 no_aplicado; inexistente → 404; cuerpo inválido → 400; nada cambia', () => {
  it.each(['pendiente', 'descartado'])('comprobante %s → 409 no_aplicado (desaplicar y reemplazar)', async (estado) => {
    kdb.when.select(T_COMP, [fila({ estado })]);
    const app = await buildApp();
    const a = await request(app).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    const b = await request(app).post(`${BASE}/${ID}/reemplazar`).set('Authorization', await auth()).send({ reemplazoId: R_ID, motivo: MOTIVO });
    for (const r of [a, b]) { expect(r.status).toBe(409); expect(r.body.codigo).toBe('no_aplicado'); }
    expect(kdb.transaction).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('inexistente → 404 no_encontrado; `:id` que no es uuid → 404', async () => {
    const app = await buildApp();
    const a = await request(app).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    const b = await request(app).post(`${BASE}/abc/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    for (const r of [a, b]) { expect(r.status).toBe(404); expect(r.body.codigo).toBe('no_encontrado'); }
    nadaCambio();
  });

  it.each([
    [{ destino: 'pendiente', motivo: 'abc' }], [{ destino: 'otro', motivo: MOTIVO }], [{ motivo: MOTIVO }], [{ destino: 'pendiente', motivo: 'x'.repeat(501) }],
  ])('desaplicar con %j → 400 datos_invalidos sin abrir la tx', async (body) => {
    kdb.when.select(T_COMP, [fila()]);
    const res = await request(await buildApp()).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('datos_invalidos');
    expect(kdb.transaction).not.toHaveBeenCalled();
    nadaCambio();
  });

  it.each([
    [{ motivo: MOTIVO }], [{ reemplazoId: 'no-uuid', motivo: MOTIVO }], [{ reemplazoId: R_ID, motivo: 'abc' }], [{ reemplazoId: ID, motivo: MOTIVO }],
  ])('reemplazar con %j → 400 datos_invalidos', async (body) => {
    kdb.when.select(T_COMP, [fila()]);
    const res = await request(await buildApp()).post(`${BASE}/${ID}/reemplazar`).set('Authorization', await auth()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('datos_invalidos');
    expect(h.preparar).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('reemplazo inexistente → 404; reemplazo ya resuelto → 409 ya_resuelto', async () => {
    kdb.when.selectOnce(T_COMP, [fila()]).selectOnce(T_COMP, []);
    await expect(reemplazar(ID, { reemplazoId: R_ID, motivo: MOTIVO }, CTX)).rejects.toMatchObject({ status: 404, codigo: 'no_encontrado' });
    kdb.when.selectOnce(T_COMP, [fila()]).selectOnce(T_COMP, [{ estado: 'aplicado' }]);
    await expect(reemplazar(ID, { reemplazoId: R_ID, motivo: MOTIVO }, CTX)).rejects.toMatchObject({ status: 409, codigo: 'ya_resuelto' });
    expect(h.preparar).not.toHaveBeenCalled();
    nadaCambio();
  });
});

// ═════════════════ AC5 ══════════════════════════════════════════════════════════════════════════

describe('AC5 — honorario con el trámite liquidado → 409 tramite_liquidado; nada cambia', () => {
  it('pago de trámite digital sobre un trámite sellado: 409 y ni la bolsa ni la fila se tocan', async () => {
    kdb.when.select(T_COMP, [fila({ concepto: 'tramite_digital' })]).select(T_TRAM, [tramite]).select(T_LIQ, [{ id: 'liq-1' }]);
    const res = await request(await buildApp()).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('tramite_liquidado');
    expect(h.exigir).not.toHaveBeenCalled(); expect(h.revertir).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('control: el mismo honorario SIN liquidación se desaplica (sin dueño que reversar)', async () => {
    kdb.when.select(T_COMP, [fila({ concepto: 'tramite_digital' })]).select(T_TRAM, [tramite]).update(T_COMP, [{ id: ID }]);
    await desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX);
    expect(h.orden).toEqual(['exigir_bolsa', 'revertir_bolsa']);
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ estado: 'pendiente', tarifaReferencia: null, diferenciaTarifa: null, marcadoPorDiferencia: false });
  });
});

// ═════════════════ AC6 ══════════════════════════════════════════════════════════════════════════

describe('AC6 — el SOAT no admite la reversa → 409 legible y rollback', () => {
  it('SOAT que ya no está pagado: 409 dueno_no_reversible con el motivo; el comprobante sigue aplicado y el SOAT sin cambios', async () => {
    armarSoat('solicitado');
    await expect(desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX)).rejects.toMatchObject({
      status: 409, codigo: 'dueno_no_reversible', extra: { detalle: expect.stringContaining('El SOAT no está pagado') },
    });
    expect(h.reversaSoat).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('la reversa del SOAT lanza (SoatError): su mensaje sale como 409 legible y no queda escritura alguna', async () => {
    armarSoat();
    h.reversaSoat.mockImplementationOnce(async () => { throw new SoatError(400, 'El SOAT ya está en ese estado'); });
    const res = await request(await buildApp()).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'dueno_no_reversible', detalle: 'El SOAT ya está en ese estado' });
    nadaCambio();
  });
});

// ═════════════════ AC7 ══════════════════════════════════════════════════════════════════════════

describe('AC7 — reemplazar un impuesto aplicado por un pendiente', () => {
  it('original descartado (quién/cuándo/motivo) y reemplazo aplicado al MISMO trámite y concepto por el camino normal, en ESTE orden', async () => {
    armarReemplazo({ valor: '200000' });
    const plan = planFalso();
    const r = await reemplazar(ID, { reemplazoId: R_ID, motivo: MOTIVO, campos: { valorTotal: '210000' } }, CTX);
    expect(h.preparar).toHaveBeenCalledWith(R_ID, { tramiteId: T1, concepto: 'impuesto', esPago: true, campos: { valorTotal: '210000' }, motivo: MOTIVO }, CTX, { sinGuardaPrevia: true });
    // Mutante «omitir / invertir la reversa antes de aplicar»: la bolsa y el dueño se deshacen ANTES del reemplazo.
    expect(h.orden).toEqual(['exigir_bolsa', 'revertir_bolsa', 'reversa_impuesto', 'aplicar_reemplazo', 'tras_commit']);
    expect(plan.compAntes).toBe(1); // el original ya estaba descartado cuando corrió el reemplazo
    expect(plan.impAntes).toBe(1); // y el impuesto ya había vuelto
    // El dueño vuelve a «en gestión» (no a Pendiente): es lo único que el camino normal de aplicar paga.
    expect(espia.updatesEn(T_IMP)[0]!.datos).toMatchObject({ estado: 'solicitado' });
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ estado: 'descartado', descartadoPorId: 7, descartadoMotivo: MOTIVO });
    // Los DOS comprobantes se bloquean antes que el trámite.
    expect(bloqueos.slice(0, 3).map((b) => b.tabla)).toEqual([T_COMP, T_COMP, T_COMP]);
    expect(r).toEqual({ original: { id: ID }, comprobante: { id: R_ID, estado: 'aplicado' }, reemplazoId: R_ID, motivo: MOTIVO });
  });

  it('por HTTP: 200 { resultado: reemplazado, original, comprobante } y rastro en los dos comprobantes', async () => {
    armarReemplazo();
    planFalso();
    const res = await request(await buildApp()).post(`${BASE}/${ID}/reemplazar`).set('Authorization', await auth()).send({ reemplazoId: R_ID, motivo: MOTIVO });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resultado: 'reemplazado', original: { id: ID }, comprobante: { id: R_ID, estado: 'aplicado' } });
    expect(auditMock.fn.mock.calls.map((c) => c[1])).toEqual([
      { action: 'update', resource: 'flito_comprobante', resourceId: ID, detail: `Comprobante reemplazado por ${R_ID}: ${MOTIVO}` },
      { action: 'update', resource: 'flito_comprobante', resourceId: R_ID, detail: `Comprobante aplicado en reemplazo de ${ID}: ${MOTIVO}` },
    ]);
  });

  it('si aplicar el reemplazo falla: sale el error de aplicar, el original sigue aplicado y la reversa del dueño también se deshace', async () => {
    armarReemplazo();
    const falla = new ComprobanteError(409, 'destino_no_admite', 'El destino no admite este pago', { detalle: 'x', puedeAdjuntar: false });
    const plan = planFalso({ falla });
    const res = await request(await buildApp()).post(`${BASE}/${ID}/reemplazar`).set('Authorization', await auth()).send({ reemplazoId: R_ID, motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('destino_no_admite');
    expect(h.reversaImp).toHaveBeenCalledTimes(1); // corrió dentro de la tx…
    expect(espia.updatesEn(T_IMP)).toEqual([]); // …y su UPDATE no quedó (misma tx: rollback)
    expect(espia.updatesEn(T_COMP)).toEqual([]); // el original sigue aplicado
    nadaCambio();
    expect(plan.trasCommit).not.toHaveBeenCalled();
    expect(auditMock.fn).not.toHaveBeenCalled();
  });
});

// ═════════════════ AC8 ══════════════════════════════════════════════════════════════════════════

describe('AC8 — dos desaplicaciones a la vez: una gana, la otra 409 no_aplicado', () => {
  it('la relectura FOR UPDATE del comprobante decide; la reversa del dueño corre una sola vez', async () => {
    armarSoat();
    await desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX);
    // El primer bloqueo de la tx es el comprobante, y el trámite va después (mutante: quitar el FOR UPDATE).
    expect(bloqueos[0]).toEqual({ tabla: T_COMP, modo: 'update' });
    expect(bloqueos.findIndex((b) => b.tabla === T_TRAM)).toBeGreaterThan(0);

    // La segunda pasó la guarda de fuera (aún aplicado) y, tras esperar el bloqueo, lee el estado nuevo.
    const escriturasDeLaPrimera = espia.updates.length;
    kdb.when.selectOnce(T_COMP, [fila()]).selectOnce(T_COMP, [fila({ estado: 'pendiente', tramiteId: null })]);
    await expect(desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX)).rejects.toMatchObject({ status: 409, codigo: 'no_aplicado' });
    expect(h.reversaSoat).toHaveBeenCalledTimes(1);
    expect(h.revertir).toHaveBeenCalledTimes(1);
    expect(espia.updates.length).toBe(escriturasDeLaPrimera);
  });
});

// ═════════════════ AC9 ══════════════════════════════════════════════════════════════════════════

describe('AC9 — la guarda de la bolsa responde periodo_cerrado: se propaga con { bolsaId, periodo } y nada cambia', () => {
  beforeEach(() => { h.exigir.mockImplementation(async () => { throw new PeriodoCerradoError('bolsa-9', '2026-09'); }); });

  it('desaplicar → 409 periodo_cerrado con bolsaId y periodo; ni reversa de bolsa ni del dueño', async () => {
    armarSoat();
    const res = await request(await buildApp()).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'periodo_cerrado', bolsaId: 'bolsa-9', periodo: '2026-09' });
    expect(h.revertir).not.toHaveBeenCalled(); expect(h.reversaSoat).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('reemplazar → el mismo 409; el reemplazo no llega a aplicarse', async () => {
    armarReemplazo();
    const plan = planFalso();
    const res = await request(await buildApp()).post(`${BASE}/${ID}/reemplazar`).set('Authorization', await auth()).send({ reemplazoId: R_ID, motivo: MOTIVO });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'periodo_cerrado', bolsaId: 'bolsa-9', periodo: '2026-09' });
    expect(plan.enTx).not.toHaveBeenCalled();
    nadaCambio();
  });
});

// ═════════════════ AC10 ═════════════════════════════════════════════════════════════════════════

describe('AC10 — permisos y frontera por enlace', () => {
  it('las funciones nuevas las tiene exactamente quien tiene aplicar; ningún rol «operaciones»', () => {
    expect(USER_ROLES as readonly string[]).not.toContain('operaciones');
    for (const rol of USER_ROLES) {
      const ops = expandir(operacionesDePartida(rol));
      const aplica = ops.has('comprobantes.comprobante.aplicar');
      expect(ops.has('comprobantes.comprobante.desaplicar'), rol).toBe(aplica);
      expect(ops.has('comprobantes.comprobante.reemplazar'), rol).toBe(aplica);
    }
    expect(expandir(operacionesDePartida('financiera')).has('comprobantes.comprobante.desaplicar')).toBe(true);
  });

  it('sin comprobantes.comprobante.desaplicar / .reemplazar → 403', async () => {
    expect(expandir(operacionesDePartida('auditor')).has('comprobantes.comprobante.desaplicar')).toBe(false);
    const app = await buildApp();
    const a = await request(app).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth('auditor')).send({ destino: 'pendiente', motivo: MOTIVO });
    const b = await request(app).post(`${BASE}/${ID}/reemplazar`).set('Authorization', await auth('auditor')).send({ reemplazoId: R_ID, motivo: MOTIVO });
    expect(a.status).toBe(403); expect(b.status).toBe(403);
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('enlace a la compañía X sobre un comprobante de un trámite de Y → 404 (desaplicar y reemplazar), sin tx', async () => {
    kdb.when.select(T_USERS, [{ c: 42, p: null }]).select(T_COMP, []);
    const app = await buildApp();
    for (const [ruta, body] of [['desaplicar', { destino: 'pendiente', motivo: MOTIVO }], ['reemplazar', { reemplazoId: R_ID, motivo: MOTIVO }]] as const) {
      const res = await request(app).post(`${BASE}/${ID}/${ruta}`).set('Authorization', await comoEnlace('compania')).send(body);
      expect(res.status, ruta).toBe(404);
      expect(res.body.codigo).toBe('no_encontrado');
    }
    expect(kdb.transaction).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('control: el mismo enlace sobre un comprobante de SU compañía → 403 (la escritura sigue cerrada a todo enlace)', async () => {
    kdb.when.select(T_USERS, [{ c: 42, p: null }]).select(T_COMP, [{ id: ID }]);
    const res = await request(await buildApp()).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await comoEnlace('compania')).send({ destino: 'pendiente', motivo: MOTIVO });
    expect(res.status).toBe(403);
    expect(kdb.transaction).not.toHaveBeenCalled();
  });
});

// ═════════════════ AC11 ═════════════════════════════════════════════════════════════════════════

describe('AC11 — servicios adicionales: la puente vuelve a como estaba antes de aplicar el comprobante, en la misma tx', () => {
  const sa = (over: Record<string, unknown> = {}) => fila({ concepto: 'servicios_adicionales', servicioTipoId: TIPO, valor: '120', ...over });
  /** Pago de SA aplicado (fuera y bajo el bloqueo), trámite sin liquidar. */
  function armarSa(over: Record<string, unknown>) {
    kdb.when.selectOnce(T_COMP, [sa(over)]).selectOnce(T_COMP, [sa(over)]).select(T_COMP, [{ n: 0 }])
      .select(T_TRAM, [tramite]).update(T_COMP, [{ id: ID }]);
  }

  it('la fila la insertó el comprobante (sa_asignacion_previa = false) → se BORRA, dentro de la tx, antes de cambiar el comprobante', async () => {
    armarSa({ saAsignacionPrevia: false });
    await desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX);
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(borrados).toEqual([T_SA]);
    expect(espia.updatesEn(T_SA)).toEqual([]);
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ estado: 'pendiente', servicioTipoId: null, saAsignacionPrevia: null, saValorPrevio: null });
    expect(h.orden).toEqual(['exigir_bolsa', 'revertir_bolsa']);
  });

  it('había una asignación manual (sa_asignacion_previa = true, 80) → vuelve a 80; no se borra', async () => {
    armarSa({ saAsignacionPrevia: true, saValorPrevio: '80.00' });
    await desaplicar(ID, { destino: 'descartado', motivo: MOTIVO }, CTX);
    expect(borrados).toEqual([]);
    expect(espia.updatesEn(T_SA).map((m) => m.datos)).toEqual([{ valor: '80.00' }]);
    expect(espia.updatesEn(T_COMP)[0]!.datos).toMatchObject({ estado: 'descartado', descartadoPorId: 7 });
  });

  it('la fila que puso el comprobante ya no existe (la quitaron a mano) → no pasa nada y la desaplicación sigue', async () => {
    armarSa({ saAsignacionPrevia: false });
    kdb.when.delete(T_SA, []); // 0 filas borradas
    await expect(desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX)).resolves.toMatchObject({ destino: 'pendiente' });
    expect(espia.updatesEn(T_COMP)).toHaveLength(1);
  });

  it('pago de SA aplicado antes de la 0251 (sa_asignacion_previa NULL) → 409 servicio_no_reversible «Corrige el valor en Servicios adicionales»; nada cambia (desaplicar y reemplazar)', async () => {
    kdb.when.select(T_COMP, [sa({ saAsignacionPrevia: null })]);
    const app = await buildApp();
    const a = await request(app).post(`${BASE}/${ID}/desaplicar`).set('Authorization', await auth()).send({ destino: 'pendiente', motivo: MOTIVO });
    const b = await request(app).post(`${BASE}/${ID}/reemplazar`).set('Authorization', await auth()).send({ reemplazoId: R_ID, motivo: MOTIVO });
    for (const r of [a, b]) {
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ codigo: 'servicio_no_reversible', detalle: 'Corrige el valor en Servicios adicionales' });
    }
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(h.preparar).not.toHaveBeenCalled(); expect(h.revertir).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('el legado también se frena BAJO el bloqueo (la fila de dentro de la tx manda) y hace rollback', async () => {
    kdb.when.selectOnce(T_COMP, [sa({ saAsignacionPrevia: false })]).selectOnce(T_COMP, [sa({ saAsignacionPrevia: null })]).select(T_TRAM, [tramite]);
    await expect(desaplicar(ID, { destino: 'pendiente', motivo: MOTIVO }, CTX)).rejects.toMatchObject({ status: 409, codigo: 'servicio_no_reversible' });
    expect(h.revertir).not.toHaveBeenCalled();
    nadaCambio();
  });

  it('reemplazar un pago de SA: la puente se restaura ANTES de aplicar el reemplazo (que la vuelve a escribir sobre el estado restaurado), con el mismo tipo', async () => {
    kdb.when
      .selectOnce(T_COMP, [sa({ saAsignacionPrevia: false })])
      .selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .selectOnce(T_COMP, [{ estado: 'aplicado' }])
      .selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .selectOnce(T_COMP, [sa({ saAsignacionPrevia: false })])
      .select(T_COMP, [{ n: 0 }])
      .select(T_TRAM, [tramite])
      .update(T_COMP, [{ id: ID }]);
    const plan = planFalso();
    await reemplazar(ID, { reemplazoId: R_ID, motivo: MOTIVO }, CTX);
    expect(h.preparar).toHaveBeenCalledWith(R_ID, expect.objectContaining({ concepto: 'servicios_adicionales', servicioTipoId: TIPO, tramiteId: T1 }), CTX, { sinGuardaPrevia: true });
    expect(plan.saAntes).toBe(1); // el DELETE de la puente ya había corrido cuando entró el reemplazo
    expect(borrados).toEqual([T_SA]);
  });

  it('si el reemplazo falla, la restauración de la puente también se deshace (rollback de la tx única)', async () => {
    kdb.when
      .selectOnce(T_COMP, [sa({ saAsignacionPrevia: true, saValorPrevio: '80.00' })])
      .selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .selectOnce(T_COMP, [{ estado: 'aplicado' }])
      .selectOnce(T_COMP, [{ estado: 'pendiente' }])
      .selectOnce(T_COMP, [sa({ saAsignacionPrevia: true, saValorPrevio: '80.00' })])
      .select(T_COMP, [{ n: 0 }])
      .select(T_TRAM, [tramite])
      .update(T_COMP, [{ id: ID }]);
    const plan = planFalso({ falla: new ComprobanteError(409, 'valor_ya_documentado', 'Ya documentado') });
    await expect(reemplazar(ID, { reemplazoId: R_ID, motivo: MOTIVO }, CTX)).rejects.toMatchObject({ codigo: 'valor_ya_documentado' });
    expect(plan.saAntes).toBe(1); // se restauró…
    nadaCambio(); // …y se deshizo con todo
  });
});
