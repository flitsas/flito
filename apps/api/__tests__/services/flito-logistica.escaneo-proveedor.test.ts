// HU #14352 (Feature #14326, ADR-0039 §8) — el escaneo del usuario de proveedor: lo que no le toca es UNA sola respuesta, byte a byte. Corre en CI con
// las filas en una cola; las mismas reglas contra PostgreSQL, con conteos y `updated_at`, en db/flito-logistica.escaneo-proveedor.pg.test.ts.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { MENSAJE_LT_NO_ENCONTRADA } from '@operaciones/shared-types';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import type { crearCaptura } from '../helpers/alcance-captura.js';

const h = vi.hoisted(() => ({ cap: null as unknown as ReturnType<typeof crearCaptura>, audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/db/client.js', async () => {
  const { crearCaptura: crear } = await import('../helpers/alcance-captura.js');
  h.cap = crear();
  return { db: h.cap.db, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: h.audit }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: vi.fn().mockResolvedValue('k'), presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn() }));
await import('../../src/db/client.js');

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');

const A = '14352000-0000-4000-8000-00000000000a';
const T1 = '14352000-0000-4000-8000-0000000000c1';
const ALCANCE = { enlace: 'proveedor', proveedorId: A } as const;
const ctx = { userId: 9, username: 'm', role: 'x', operaAjenas: false, alcance: ALCANCE };
const ENTRADA = { placa: 'ZZA101', numeroLicencia: 'L-1', numeroLt: 'LT900' };
const FILA = { tramiteId: T1, idFlit: 'F1', organismoCodigo: '05001', companiaId: 7, companiaNit: '900', companiaNombre: 'Cia', vehiculoId: 3, vin: 'VIN1', docId: null, organismoNombre: 'Org', marca: 'M', linea: 'L', modelo: 2024 };

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/logistica', conAlcance('logistica', router));
  a.use(errorHandler);
  return a;
}
let sub = 14352000;
const como = async (enlace = 'proveedor', extra: string[] = []) => `Bearer ${await testToken({ sub: ++sub, role: 'xyz_rol' as never, tipoEnlace: enlace, funciones: ['logistica.documento.escanear', 'logistica.lt.validar', ...extra] })}`;
const escrituras = () => h.cap.consultas.filter((c) => c.tipo !== 'select' && c.tipo !== 'selectDistinct');

// [caso, licencia global, trámites con alcance, soporte]. Los cuatro de R18 de AC1.
const CASOS: [string, unknown[], unknown[], unknown[], string][] = [
  ['el trámite no existe', [], [], [], 'inexistente'],
  ['es de otro proveedor', [], [], [{ id: T1, gestionable: true, conLt: false }], 'fuera_de_alcance'],
  ['la compañía no tiene logística gestionada', [], [], [{ id: T1, gestionable: false, conLt: false }], 'no_gestionada'],
  ['la licencia la registró otro proveedor', [{ id: T1, organismoCodigo: '05001', companiaNombre: 'Ajena', propia: false }], [], [{ id: T1, gestionable: true, conLt: true }], 'lt_ajena'],
];

beforeEach(() => { h.cap.reset(); h.audit.mockClear(); });

describe('AC1 — misma respuesta en los cuatro casos', () => {
  it('byte a byte, sin idFlit, companiaNombre, organismoCodigo, documentoId, candidatos ni propietarioNombre', async () => {
    const respuestas: unknown[] = [];
    for (const [, licencia, filas, soporte] of CASOS) {
      h.cap.responder(licencia, filas, soporte);
      respuestas.push(await svc.escanearLt(ENTRADA, null, {}, ctx));
    }
    const esperada = { resultado: 'sin_match', motivo: MENSAJE_LT_NO_ENCONTRADA, placa: 'ZZA101', vin: '', numeroLicencia: 'L-1' };
    for (const r of respuestas) expect(r).toStrictEqual(esperada);
    expect(new Set(respuestas.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(MENSAJE_LT_NO_ENCONTRADA).toBe('No se encontró un trámite para esta licencia');
  });
});

describe('AC10 — todos los caminos hacen las mismas lecturas', () => {
  it.each(CASOS)('%s: la licencia, los trámites con alcance y el soporte, y ninguna escritura (AC2)', async (_n, licencia, filas, soporte) => {
    h.cap.responder(licencia, filas, soporte);
    await svc.escanearLt(ENTRADA, null, {}, ctx);
    expect(h.cap.consultas.map((c) => c.tipo)).toEqual(['select', 'select', 'select']);
    expect(escrituras()).toEqual([]);
  });

  it('también con un trámite propio: nadie se salta el soporte', async () => {
    h.cap.responder([], [{ ...FILA, docId: 'd1' }], [{ id: T1, gestionable: true, conLt: true }]);
    await svc.validarLt(ENTRADA, ALCANCE);
    expect(h.cap.consultas).toHaveLength(3);
  });
});

describe('AC8 — el motivo real va a soporte y no a la respuesta', () => {
  it.each(CASOS)('%s', async (_n, licencia, filas, soporte, motivo) => {
    h.cap.responder(licencia, filas, soporte);
    const vistos: string[] = [];
    const r = await svc.escanearLt(ENTRADA, null, {}, ctx, { alNoEncontrar: (m) => { vistos.push(m); } });
    expect(vistos).toEqual([motivo]);
    expect(JSON.stringify(r)).not.toContain(motivo);
  });

  it('por la ruta: el detalle de auditoría lleva el motivo y nada personal', async () => {
    h.cap.responder([{ c: null, p: A }], [], [], [{ id: T1, gestionable: true, conLt: false }]);
    const r = await request(await app()).post('/api/flito/logistica/escanear').set('Authorization', await como()).send(ENTRADA);
    expect(r.status).toBe(200);
    const detalle = h.audit.mock.calls[0]![1].detail as string;
    expect(detalle).toContain('fuera_de_alcance');
    expect(detalle).not.toContain('ZZA101');
    expect(detalle).not.toContain('L-1');
  });
});

describe('AC4 y D2 — un trámite propio y otro ajeno', () => {
  it('el conteo de candidatos fuera de alcance solo queda en la auditoría', async () => {
    h.cap.responder([], [{ ...FILA }], [{ id: T1, gestionable: true, conLt: false }, { id: 'otro', gestionable: true, conLt: false }]);
    const vistos: number[] = [];
    const v = await svc.resolverEscaneo(
      { placa: 'ZZA101', vin: null, numeroLicencia: 'L-1', numeroLt: 'LT900', manual: true, propietarioNombre: null, propietarioDocumento: null, combustible: null, fotoBase64: null, flitRaw: {} },
      { alContarFueraDeAlcance: (n) => { vistos.push(n); } }, ALCANCE,
    );
    expect(vistos).toEqual([1]);
    expect(v).toMatchObject({ kind: 'tramite' });
    expect(JSON.stringify(v)).not.toContain('otro');
  });
});

describe('AC5 — todos los propios ya tienen licencia', () => {
  it('«Sin trámite pendiente»: solo revela lo propio', async () => {
    h.cap.responder([], [{ ...FILA, docId: 'd1' }], [{ id: T1, gestionable: true, conLt: true }]);
    const r = await svc.escanearLt(ENTRADA, null, {}, ctx);
    expect(r).toMatchObject({ resultado: 'sin_match', motivo: 'El vehículo no tiene un trámite aprobado pendiente de LT.' });
    expect(r).not.toHaveProperty('candidatos');
  });
});

describe('Operaciones conserva su motivo específico', () => {
  const OPS = { ...ctx, alcance: { enlace: 'ninguno' } as const };
  it('un trámite sin compañía o sin organismo le dice cuál es el problema', async () => {
    h.cap.responder([], [{ ...FILA, companiaId: null }]);
    expect(await svc.escanearLt(ENTRADA, null, {}, OPS)).toMatchObject({ resultado: 'sin_match', motivo: expect.stringContaining('compañía FLITO'), idFlit: 'F1' });
    h.cap.responder([], [{ ...FILA, organismoCodigo: null }]);
    expect(await svc.escanearLt(ENTRADA, null, {}, OPS)).toMatchObject({ resultado: 'sin_match', motivo: expect.stringContaining('organismo'), idFlit: 'F1' });
  });

  it('al proveedor, esos mismos casos, si el WHERE los dejara pasar, son el mensaje único', async () => {
    h.cap.responder([], [{ ...FILA, companiaId: null }], [{ id: T1, gestionable: false, conLt: false }]);
    expect(await svc.escanearLt(ENTRADA, null, {}, ctx)).toStrictEqual({ resultado: 'sin_match', motivo: MENSAJE_LT_NO_ENCONTRADA, placa: 'ZZA101', vin: '', numeroLicencia: 'L-1' });
    h.cap.responder([], [{ ...FILA, organismoCodigo: null }], [{ id: T1, gestionable: false, conLt: false }]);
    expect(await svc.escanearLt(ENTRADA, null, {}, ctx)).toStrictEqual({ resultado: 'sin_match', motivo: MENSAJE_LT_NO_ENCONTRADA, placa: 'ZZA101', vin: '', numeroLicencia: 'L-1' });
  });
});

describe('AC6 — `tramiteId` ajeno o inventado', () => {
  it('misma respuesta de AC1, sin escribir', async () => {
    h.cap.responder([], [{ ...FILA }], [{ id: T1, gestionable: true, conLt: false }]);
    const r = await svc.escanearLt(ENTRADA, null, {}, ctx, { tramiteId: '14352000-0000-4000-8000-0000000000ff' });
    expect(r).toStrictEqual({ resultado: 'sin_match', motivo: MENSAJE_LT_NO_ENCONTRADA, placa: 'ZZA101', vin: '', numeroLicencia: 'L-1' });
    expect(escrituras()).toEqual([]);
  });
});

describe('AC7 — dejar pendiente', () => {
  it('403 antes de consultar datos, aunque el proveedor tenga la función', async () => {
    const token = await como('proveedor', ['logistica.documento.dejar_pendiente']);
    const r = await request(await app()).post('/api/flito/logistica/escanear').set('Authorization', token).send({ ...ENTRADA, dejarPendiente: true });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toEqual([]);
  });
});

describe('AC9 — validar y consultar vehículo', () => {
  it('validar-lt no dice `ya_registrada` de una licencia ajena', async () => {
    h.cap.responder([{ id: T1, organismoCodigo: '05001', companiaNombre: 'Ajena', propia: false }], [], [{ id: T1, gestionable: true, conLt: true }]);
    const r = await svc.validarLt(ENTRADA, ALCANCE);
    expect(r).toStrictEqual({ resultado: 'sin_match', motivo: MENSAJE_LT_NO_ENCONTRADA, placa: 'ZZA101', vin: '', numeroLicencia: 'L-1' });
  });

  it('validar-lt de una propia no devuelve el nombre del propietario (H2)', async () => {
    h.cap.responder([{ id: T1, organismoCodigo: '05001', companiaNombre: 'Cia', propia: true }], [], []);
    const r = await svc.validarLt(ENTRADA, ALCANCE);
    expect(r.resultado).toBe('ya_registrada');
    expect(r).not.toHaveProperty('propietarioNombre');
  });

  it('consultar-vehiculo responde `{encontrado:false}` idéntico', async () => {
    h.cap.responder([]);
    expect(await svc.consultarVehiculo('ZZA101', ALCANCE)).toStrictEqual({ encontrado: false });
  });
});

describe('§8.2 y limitadores — ninguna ruta de lectura por placa va sin tope', () => {
  it.each([
    ['/escanear', ENTRADA, '300'],
    ['/validar-lt', ENTRADA, '300'],
    ['/consultar-vehiculo', { placa: 'ZZA101' }, undefined],
  ] as const)('%s responde con su cabecera de cuota', async (ruta, cuerpo, tope) => {
    const r = await request(await app()).post(`/api/flito/logistica${ruta}`).set('Authorization', await como()).send(cuerpo);
    expect(r.status).toBe(200);
    expect(r.headers['ratelimit-limit']).toBeDefined();
    if (tope) expect(r.headers['ratelimit-limit']).toBe(tope);
  });
});
