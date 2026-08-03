// FLITO Impuestos — contingencia (HU #11155, Feature #11150): marcar la gestión por Operaciones al
// enviar, y asumirla o devolverla sobre un impuesto ya enviado.
//
// Espeja lo hecho en SOAT, con dos diferencias que estos tests fijan:
//   · el envío NO lleva XOR — no hay proveedor con el que competir, el destinatario sale del
//     organismo, así que la contingencia es solo una marca más;
//   · devolver no recibe destinatario, porque el organismo nunca cambió.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

beforeEach(() => { selectMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset(); });

const IMP_ID = '00000000-0000-0000-0000-0000000000f1';
const USER_ID = 7;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  app.use('/api/flito/impuestos', router);
  return app;
}
const auth = async (role: string) => `Bearer ${await testToken({ sub: USER_ID, username: 'ops@flitsas.com', role: role as never })}`;

/** Igual que en SOAT: el helper `chain` no registra argumentos, así que se envuelve para capturarlos. */
function montarTx(filasBloqueadas: { id: string }[] = [{ id: IMP_ID }], filaActualizada: unknown = { id: IMP_ID }) {
  const sets: Record<string, unknown>[] = [];
  const inserts: unknown[] = [];
  const txSelect = vi.fn().mockReturnValue(chain(filasBloqueadas));
  const txUpdate = vi.fn(() => {
    const c = chain([filaActualizada]);
    return { ...c, set: (v: Record<string, unknown>) => { sets.push(v); return c; } };
  });
  const txInsert = vi.fn(() => {
    const c = chain([]);
    return { ...c, values: (v: unknown) => { inserts.push(v); return c; } };
  });
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ select: txSelect, update: txUpdate, insert: txInsert }));
  return { sets, inserts, txUpdate };
}

/** El envío inserta bitácora por id ANTES del historial; se filtra por forma para no confundirlos. */
const filasHistorial = (inserts: unknown[]) =>
  inserts.flat().filter((v): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && 'concepto' in (v as object));

const impuestoEn = (over: Record<string, unknown> = {}) => ({
  id: IMP_ID, estado: 'solicitado', gestionOperaciones: false, organismoCodigo: '08001',
  enviadoEn: new Date('2026-07-01T10:00:00Z'), motivoRechazo: null, ...over,
});

const asumir = async (rol: string, body: unknown) =>
  request(await buildApp()).post(`/api/flito/impuestos/${IMP_ID}/asumir-operaciones`)
    .set('Authorization', await auth(rol)).send(body as object);
const devolver = async (rol: string, body: unknown) =>
  request(await buildApp()).post(`/api/flito/impuestos/${IMP_ID}/devolver-gestor`)
    .set('Authorization', await auth(rol)).send(body as object);

describe('flito-impuestos — envío a gestión de Operaciones (HU #11155)', () => {
  it('AC1 — marca la contingencia y conserva el organismo', async () => {
    const { sets, inserts } = montarTx();
    const r = await request(await buildApp()).post('/api/flito/impuestos/enviar')
      .set('Authorization', await auth('admin')).send({ ids: [IMP_ID], gestionOperaciones: true });

    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({
      estado: 'solicitado', gestionOperaciones: true, gestionOperacionesPorId: USER_ID, enviadoPorId: USER_ID,
    });
    // El organismo no se toca: el impuesto se paga ante él aunque lo tramite otro.
    expect(sets[0]).not.toHaveProperty('organismoCodigo');
    expect(filasHistorial(inserts)[0]).toMatchObject({
      concepto: 'impuesto', estadoAnterior: 'pendiente', estadoNuevo: 'solicitado',
      motivo: 'Envío a gestión de Operaciones',
    });
  });

  it('AC2 — sin la marca, el envío se comporta como siempre', async () => {
    const { sets, inserts } = montarTx();
    const r = await request(await buildApp()).post('/api/flito/impuestos/enviar')
      .set('Authorization', await auth('admin')).send({ ids: [IMP_ID] });

    expect(r.status).toBe(200);
    expect(sets[0]).not.toHaveProperty('gestionOperaciones');
    expect(filasHistorial(inserts)[0]).toMatchObject({ motivo: 'Envío al gestor' });
  });

  it('a diferencia de SOAT no hay XOR: `gestionOperaciones: false` es un envío normal, no un 400', async () => {
    const { sets } = montarTx();
    const r = await request(await buildApp()).post('/api/flito/impuestos/enviar')
      .set('Authorization', await auth('admin')).send({ ids: [IMP_ID], gestionOperaciones: false });

    expect(r.status).toBe(200);
    expect(sets[0]).not.toHaveProperty('gestionOperaciones');
  });
});

describe('flito-impuestos — asumir y devolver la gestión (HU #11155)', () => {
  it('AC3 — asumir marca la contingencia sin tocar estado, organismo ni fecha de envío', async () => {
    selectMock.mockReturnValueOnce(chain([impuestoEn()]));
    selectMock.mockReturnValue(chain([]));
    const { sets, inserts } = montarTx();

    const r = await asumir('admin', { motivo: 'el gestor del organismo está incomunicado' });

    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({
      gestionOperaciones: true,
      gestionOperacionesMotivo: 'el gestor del organismo está incomunicado',
      gestionOperacionesPorId: USER_ID,
    });
    expect(sets[0]).not.toHaveProperty('estado');
    expect(sets[0]).not.toHaveProperty('enviadoEn');
    expect(sets[0]).not.toHaveProperty('organismoCodigo');
    expect(filasHistorial(inserts)[0]).toMatchObject({ estadoAnterior: 'solicitado', estadoNuevo: 'solicitado' });
  });

  it('AC4 — devolver limpia las marcas y no pide destinatario', async () => {
    selectMock.mockReturnValueOnce(chain([impuestoEn({ gestionOperaciones: true })]));
    selectMock.mockReturnValue(chain([]));
    const { sets } = montarTx();

    // Sin `proveedorSoatId` ni equivalente: el organismo nunca cambió.
    const r = await devolver('admin', { motivo: 'el gestor ya puede retomarlo' });

    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({
      gestionOperaciones: false, gestionOperacionesMotivo: null,
      gestionOperacionesPorId: null, gestionOperacionesEn: null,
    });
  });

  it('AC3 — un impuesto Con novedad también se asume', async () => {
    selectMock.mockReturnValueOnce(chain([impuestoEn({ estado: 'con_novedad', motivoRechazo: 'recibo ilegible' })]));
    selectMock.mockReturnValue(chain([]));
    const { sets, inserts } = montarTx();

    const r = await asumir('admin', { motivo: 'lo corrige Operaciones' });
    expect(r.status).toBe(200);
    expect(sets[0]).not.toHaveProperty('motivoRechazo');
    expect(filasHistorial(inserts)[0]).toMatchObject({ estadoAnterior: 'con_novedad', estadoNuevo: 'con_novedad' });
  });

  it('AC5 — motivo corto o vacío → 400, sin escribir', async () => {
    const { txUpdate } = montarTx();
    expect((await asumir('admin', { motivo: 'x' })).status).toBe(400);
    expect((await devolver('admin', { motivo: '' })).status).toBe(400);
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC6 — Pagado y Pendiente se rechazan, con mensajes distintos', async () => {
    const { txUpdate } = montarTx();

    selectMock.mockReturnValueOnce(chain([impuestoEn({ estado: 'pagado' })]));
    const pagado = await asumir('admin', { motivo: 'quiero rehacerlo' });
    expect(pagado.status).toBe(400);
    expect(pagado.body.error).toMatch(/pagado/i);

    selectMock.mockReturnValueOnce(chain([impuestoEn({ estado: 'pendiente' })]));
    const pendiente = await asumir('admin', { motivo: 'lo asumo desde ya' });
    expect(pendiente.status).toBe(400);
    expect(pendiente.body.error).toMatch(/no se ha enviado a gestión/i);

    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC6 — casos redundantes y registro inexistente', async () => {
    const { txUpdate } = montarTx();

    selectMock.mockReturnValueOnce(chain([impuestoEn({ gestionOperaciones: true })]));
    const yaAsumido = await asumir('admin', { motivo: 'otra vez por si acaso' });
    expect(yaAsumido.status).toBe(400);
    expect(yaAsumido.body.error).toMatch(/ya lo gestiona Operaciones/i);

    selectMock.mockReturnValueOnce(chain([impuestoEn({ gestionOperaciones: false })]));
    const noAsumido = await devolver('admin', { motivo: 'devolver sin haberlo tomado' });
    expect(noAsumido.status).toBe(400);
    expect(noAsumido.body.error).toMatch(/no lo gestiona Operaciones/i);

    selectMock.mockReturnValueOnce(chain([]));
    expect((await asumir('admin', { motivo: 'no existe este id' })).status).toBe(404);

    expect(txUpdate).not.toHaveBeenCalled();
  });

  for (const rol of ['gestor_impuestos', 'proveedor', 'auditor']) {
    it(`AC5 — ${rol} no puede asumir ni devolver → 403`, async () => {
      const { txUpdate } = montarTx();
      expect((await asumir(rol, { motivo: 'me lo quedo yo' })).status).toBe(403);
      expect((await devolver(rol, { motivo: 'me lo quedo yo' })).status).toBe(403);
      expect(txUpdate).not.toHaveBeenCalled();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — a quién se mide con qué ANS. Decisión de negocio (2026-07-31): lo que asume Operaciones se
// mide con el ANS global, no con el del organismo, para que a Operaciones se le mida igual en los
// dos módulos. El criterio se prueba directo sobre el helper: es una función pura y montarle la
// cola entera para afirmar sobre una píldora sería ruido.
//
// Ojo: este helper y `EXPR_ESTANCADO_IMP` son gemelos y tienen que decir lo mismo. Hasta esta HU NO
// coincidían —el SQL medía contra el organismo y el JavaScript contra el global— pese a que el
// comentario del módulo afirmaba lo contrario.
describe('flito-impuestos — con qué ANS se mide cada uno (HU #11155, AC9)', () => {
  const haceHoras = (h: number) => new Date(Date.now() - h * 3_600_000);

  it('lo que gestiona Operaciones se mide con el ANS global de 24 horas', async () => {
    const { estaEstancado } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
    // Con un ANS de organismo largo (72 h) que, de aplicarse, aún no habría vencido.
    expect(estaEstancado('solicitado', haceHoras(30), true, 72)).toBe(true);
    expect(estaEstancado('solicitado', haceHoras(10), true, 72)).toBe(false);
  });

  it('lo que gestiona el organismo se sigue midiendo con el suyo', async () => {
    const { estaEstancado } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
    // 30 h ya pasó el ANS global, pero el de su organismo es de 72 h: no está estancado.
    expect(estaEstancado('solicitado', haceHoras(30), false, 72)).toBe(false);
    expect(estaEstancado('solicitado', haceHoras(80), false, 72)).toBe(true);
  });

  it('un organismo sin ANS configurado no marca a su gestor, pero sí a Operaciones', async () => {
    const { estaEstancado } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
    expect(estaEstancado('solicitado', haceHoras(200), false, null)).toBe(false);
    // El efecto que buscaba la decisión: la contingencia no se esconde tras una parametrización que falta.
    expect(estaEstancado('solicitado', haceHoras(200), true, null)).toBe(true);
  });

  it('solo cuenta lo que está En gestión y tiene fecha de envío', async () => {
    const { estaEstancado } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
    expect(estaEstancado('pagado', haceHoras(200), true, 24)).toBe(false);
    expect(estaEstancado('pendiente', haceHoras(200), true, 24)).toBe(false);
    expect(estaEstancado('solicitado', null, true, 24)).toBe(false);
  });
});
