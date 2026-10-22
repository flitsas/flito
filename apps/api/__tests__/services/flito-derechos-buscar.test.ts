// HU #13838 (G3, Feature #13834) — consulta de gestión de Dr. Flit: `POST /api/flito/derechos/buscar`.
// Diseño: docs/diseno/feature-13834-dr-flit-consultas-gestion.md · tarjeta: docs/ux/flito-dr-flit-f6.md §F6.6 Derechos.
//
// - El valor viaja en el BODY `{ valor }` (trim, 1..100, estricto) → 400 «Datos inválidos» sin consultar el
//   listado y sin rastro PII.
// - Mismo permiso (`derechos.cola.ver`) y alcance (`alcanceDe(req)` → `porOrganismos` en `listarDerechos`) que
//   el GET /; 403 sin la función. No reutiliza `GET /candidatos/:placa`.
// - Primera página de 5 filas + total real; la tarjeta es la fila de la pestaña «Registrados»: placa · id FLIT,
//   «Con advertencia» solo si la fila la trae, concepto del recibo, valor y fecha de pago. Sin empresa, VIN,
//   radicado, archivo, soporte ni advertencias crudas.
// - Rastro `logPiiAccess` `search` con 200 (también con 0 filas): `flito_derechos`, `['placa']`, motivo
//   `Dr. Flit gestión — filas=N`, SIN el valor.
// - Limiter `drflit-gestion`: 40 / min por usuario, compartido entre los módulos de la consulta.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
const pii = vi.hoisted(() => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => pii);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const svc = vi.hoisted(() => ({
  listarDerechos: vi.fn(), candidatosDePlaca: vi.fn(), colaImpuestos: vi.fn(), alcance: null as null | Record<string, unknown>,
}));
vi.mock('../../src/modules/flito-derechos/flito-derechos.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), listarDerechos: svc.listarDerechos, candidatosDePlaca: svc.candidatosDePlaca,
}));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), colaImpuestos: svc.colaImpuestos,
}));
vi.mock('../../src/shared/middleware/frontera-enlace.js', async (orig) => {
  const real = await orig<typeof import('../../src/shared/middleware/frontera-enlace.js')>();
  return {
    ...real,
    alcanceDe: vi.fn((...a: Parameters<typeof real.alcanceDe>) => (svc.alcance ? Promise.resolve(svc.alcance) : real.alcanceDe(...a))),
  };
});

const URL = '/api/flito/derechos/buscar';
const PLACA = 'QTQ100';
const D1 = '00000000-0000-0000-0000-0000000000d1';
const D2 = '00000000-0000-0000-0000-0000000000d2';

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-derechos/flito-derechos.routes.js');
  const { default: impuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/derechos', conAlcance('derechos', router));
  a.use('/api/flito/impuestos', conAlcance('impuestos', impuestos));
  a.use(errorHandler);
  return a;
}

let sub = 13838_500;
const admin = async () => `Bearer ${await testToken({ sub: ++sub, role: 'admin' })}`;

/** Fila del listado (pestaña «Registrados») con datos que la tarjeta NO debe dejar pasar. */
const fila = {
  id: D1, tramiteId: 't-1', idFlit: 'FL-901', placa: PLACA, vin: '9BWZZZ377VT004251', marca: 'MAZDA', linea: 'CX-5',
  tipoTramite: 'Traspaso', fechaAprobacion: null, fechaCreacion: null, organismoCodigo: '05001', empresa: 'Gestora Uno',
  valor: '125000.50', fechaPago: '2026-10-02', numeroRadicado: 'RAD-555', tipoTramiteRecibo: 'Derechos de traspaso',
  origen: 'drive', archivoOrigen: 'recibo-secreto.pdf', paginas: [1], procesamientoId: 'p-1',
  procesamientoArchivo: 'lote.pdf', procesamientoEn: null, advertencias: ['Valor no coincide'], soporteId: 's-1',
  createdAt: '2026-10-02T10:00:00.000Z',
};
const filaLimpia = { ...fila, id: D2, placa: null, valor: null, fechaPago: null, tipoTramiteRecibo: null, advertencias: null };

const pagina = (items: unknown[], total = items.length) => ({ items, total, page: 1, pageSize: 5 });

beforeEach(() => {
  pii.logPiiAccess.mockClear();
  svc.listarDerechos.mockReset(); svc.candidatosDePlaca.mockReset(); svc.colaImpuestos.mockReset();
  svc.listarDerechos.mockResolvedValue(pagina([]));
  svc.colaImpuestos.mockResolvedValue(pagina([]));
  svc.alcance = null;
});

describe('HU #13838 · POST /derechos/buscar — autenticación y permiso', () => {
  it('401 sin token, sin listado ni rastro', async () => {
    const r = await request(await app()).post(URL).send({ valor: PLACA });
    expect(r.status).toBe(401);
    expect(svc.listarDerechos).not.toHaveBeenCalled();
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('403 sin la función derechos.cola.ver, sin consultar el listado ni escribir rastro', async () => {
    const t = await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: ['impuestos.cola.ver'] });
    const r = await request(await app()).post(URL).set('Authorization', `Bearer ${t}`).send({ valor: PLACA });
    expect(r.status).toBe(403);
    expect(svc.listarDerechos).not.toHaveBeenCalled();
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('403 no gasta cupo del limiter: 41 intentos sin función siguen en 403, nunca 429', async () => {
    const a = await app();
    const t = `Bearer ${await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: [] })}`;
    const estados = new Set<number>();
    for (let i = 0; i < 41; i++) estados.add((await request(a).post(URL).set('Authorization', t).send({ valor: PLACA })).status);
    expect([...estados]).toEqual([403]);
  });
});

describe('HU #13838 · POST /derechos/buscar — body estricto', () => {
  const casos: Array<[string, unknown]> = [
    ['sin valor', {}],
    ['valor vacío', { valor: '' }],
    ['valor solo espacios', { valor: '   ' }],
    ['valor > 100', { valor: 'A'.repeat(101) }],
    ['valor que no es texto', { valor: 123 }],
    ['campo extra', { valor: PLACA, page: 2 }],
  ];
  for (const [nombre, body] of casos) {
    it(`400 ${nombre}, sin listado y sin rastro`, async () => {
      const r = await request(await app()).post(URL).set('Authorization', await admin()).send(body as object);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'Datos inválidos' });
      expect(svc.listarDerechos).not.toHaveBeenCalled();
      expect(pii.logPiiAccess).not.toHaveBeenCalled();
    });
  }

  it('100 caracteres exactos sí pasan (borde)', async () => {
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: 'A'.repeat(100) });
    expect(r.status).toBe(200);
  });
});

describe('HU #13838 · POST /derechos/buscar — resultado', () => {
  it('200: valor recortado, página 1 de 5, total real; tarjeta exacta sin PII ni campos internos; no usa candidatos', async () => {
    svc.listarDerechos.mockResolvedValue(pagina([fila, filaLimpia], 8));
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: `  ${PLACA}  ` });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      total: 8,
      items: [
        { id: D1, placa: PLACA, idFlit: 'FL-901', conAdvertencia: true, concepto: 'Derechos de traspaso', valor: 125000.5, fechaPago: '2026-10-02' },
        { id: D2, placa: null, idFlit: 'FL-901', conAdvertencia: false, concepto: null, valor: null, fechaPago: null },
      ],
    });
    expect(JSON.stringify(r.body)).not.toMatch(/9BWZZZ|Gestora Uno|RAD-555|recibo-secreto|lote\.pdf|Valor no coincide|MAZDA|Traspaso"/);
    expect(svc.listarDerechos.mock.calls[0]![0]).toEqual({ buscar: PLACA, page: 1, pageSize: 5 });
    expect(svc.candidatosDePlaca).not.toHaveBeenCalled();
  });

  it('alcance: `listarDerechos` recibe EXACTAMENTE el alcance que `alcanceDe(req)` resolvió (organismos)', async () => {
    svc.alcance = { enlace: 'organismos_transito', organismos: ['05001', '11001'] };
    const t = `Bearer ${await testToken({ sub: ++sub, role: 'xyz_gestor' as never, tipoEnlace: 'organismos_transito', funciones: ['derechos.cola.ver'] })}`;
    const r = await request(await app()).post(URL).set('Authorization', t).send({ valor: PLACA });
    expect(r.status).toBe(200);
    expect(svc.listarDerechos.mock.calls[0]![1]).toBe(svc.alcance);
  });

  it('rastro PII `search` con 200: flito_derechos, campos [placa], filas=N y SIN el valor', async () => {
    svc.listarDerechos.mockResolvedValue(pagina([fila], 8));
    await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: PLACA });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    const [, opts] = pii.logPiiAccess.mock.calls[0]!;
    expect(opts).toEqual({ resourceTipo: 'flito_derechos', accion: 'search', camposAccedidos: ['placa'], motivo: 'Dr. Flit gestión — filas=1' });
    expect(JSON.stringify(opts)).not.toContain(PLACA);
  });

  it('0 filas: 200 { total: 0, items: [] } y el rastro se escribe igual con filas=0, sin el valor', async () => {
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: 'FL-404' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ total: 0, items: [] });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    expect(pii.logPiiAccess.mock.calls[0]![1]).toMatchObject({ motivo: 'Dr. Flit gestión — filas=0' });
    expect(JSON.stringify(pii.logPiiAccess.mock.calls[0]![1])).not.toContain('FL-404');
  });
});

describe('HU #13838 · POST /derechos/buscar — limitador por usuario', () => {
  it('429 a partir de la 41.ª consulta del mismo usuario en el minuto; otro usuario no comparte cupo', async () => {
    const a = await app();
    const tok = await admin();
    const estados: number[] = [];
    for (let i = 0; i < 41; i++) estados.push((await request(a).post(URL).set('Authorization', tok).send({ valor: PLACA })).status);
    expect(estados.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(estados[40]).toBe(429);
    expect((await request(a).post(URL).set('Authorization', await admin()).send({ valor: PLACA })).status).toBe(200);
  });

  it('el cupo es uno por usuario para toda la consulta: 40 en impuestos agotan derechos', async () => {
    const a = await app();
    const tok = await admin();
    for (let i = 0; i < 40; i++) expect((await request(a).post('/api/flito/impuestos/buscar').set('Authorization', tok).send({ valor: PLACA })).status).toBe(200);
    expect((await request(a).post(URL).set('Authorization', tok).send({ valor: PLACA })).status).toBe(429);
    expect(svc.listarDerechos).not.toHaveBeenCalled();
  });
});
