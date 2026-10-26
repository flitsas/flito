// HU #13838 (G3, Feature #13834) — consulta de gestión de Dr. Flit: `POST /api/flito/impuestos/buscar`.
// Diseño: docs/diseno/feature-13834-dr-flit-consultas-gestion.md · tarjeta: docs/ux/flito-dr-flit-f6.md §F6.6 Impuestos.
//
// - El valor viaja en el BODY `{ valor }` (trim, 1..100, estricto) → 400 «Datos inválidos» sin consultar la
//   cola y sin rastro PII.
// - Mismo permiso (`impuestos.cola.ver`) y alcance (`contextoImpuesto(req.user)`) que el GET /; 403 sin la función.
// - Primera página de 5 filas + total real; la tarjeta: placa · id FLIT, estado, organismo, liquidado y fecha
//   de pago. Sin comprador, documento, VIN, compañía, valor pagado ni semáforo.
// - Rastro PII `search` por `registrarAccesoImpuesto` con 200 (también con 0 filas), `filas=N`, SIN el valor.
// - Limiter `drflit-gestion`: 40 / min por usuario.
//
// Router REAL montado como en `app.ts` (`conAlcance`). Se dobla `colaImpuestos` (el SQL del alcance ya lo
// cubre `flito-impuestos.alcance-enlace.test.ts`) y `alcanceDeUsuario` (para afirmar que el contexto que
// recibe la cola es el del enlace de ESE usuario).
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
const svc = vi.hoisted(() => ({ colaImpuestos: vi.fn(), alcance: null as null | Record<string, unknown> }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), colaImpuestos: svc.colaImpuestos,
}));
vi.mock('../../src/shared/middleware/frontera-enlace.js', async (orig) => {
  const real = await orig<typeof import('../../src/shared/middleware/frontera-enlace.js')>();
  return {
    ...real,
    alcanceDeUsuario: vi.fn((...a: Parameters<typeof real.alcanceDeUsuario>) =>
      (svc.alcance ? Promise.resolve(svc.alcance) : real.alcanceDeUsuario(...a))),
  };
});

const URL = '/api/flito/impuestos/buscar';
const PLACA = 'QTQ100';
const VIN = '9BWZZZ377VT004251';
const I1 = '00000000-0000-0000-0000-0000000000e1';

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/impuestos', conAlcance('impuestos', router));
  a.use(errorHandler);
  return a;
}

let sub = 13838_000;
const admin = async () => `Bearer ${await testToken({ sub: ++sub, role: 'admin' })}`;

/** Fila de la cola con PII y campos internos que la tarjeta NO debe dejar pasar. */
const fila = {
  id: I1, tramiteId: 't-1', idFlit: 'FL-777', placa: PLACA, vin: VIN, marca: 'MAZDA', linea: 'CX-5',
  tipoTramite: 'Traspaso', fechaAprobacion: null, fechaCreacion: null, estado: 'pagado',
  compradorNombre: 'Ana Pérez', compradorDocumento: '1012345678', compradorTipoDocumento: 'CC',
  companiaNombre: 'Gestora Uno', organismoCodigo: '05001', organismoNombre: 'Tránsito de Medellín',
  valorLiquidado: 345000, valorPagado: 351000, marcadoPorDiferencia: true, tieneFacturaVenta: true,
  enviadoPorNombre: 'Empleado FLIT', enviadoEn: '2026-10-01T10:00:00.000Z', pagadoEn: '2026-10-05T10:00:00.000Z',
  liquidadoEn: null, documentos: null, estancado: false, motivoRechazo: null, creadoEn: '2026-09-30T10:00:00.000Z',
  gestionOperaciones: false, certificacion: null, analisisEstado: null, semaforo: 'rojo', motivoSemaforo: null,
};
const sinOrganismoNombre = { ...fila, id: 'x2', placa: null, organismoNombre: null, valorLiquidado: null, pagadoEn: null, estado: 'solicitado' };

const pagina = (items: unknown[], total = items.length) => ({ items, total, page: 1, pageSize: 5 });

beforeEach(() => {
  pii.logPiiAccess.mockClear();
  svc.colaImpuestos.mockReset();
  svc.colaImpuestos.mockResolvedValue(pagina([]));
  svc.alcance = null;
});

describe('HU #13838 · POST /impuestos/buscar — autenticación y permiso', () => {
  it('401 sin token, sin cola ni rastro', async () => {
    const r = await request(await app()).post(URL).send({ valor: PLACA });
    expect(r.status).toBe(401);
    expect(svc.colaImpuestos).not.toHaveBeenCalled();
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('403 sin la función impuestos.cola.ver, sin consultar la cola ni escribir rastro', async () => {
    const t = await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: ['soat.cola.ver', 'drflit.gestion.consultar'] });
    const r = await request(await app()).post(URL).set('Authorization', `Bearer ${t}`).send({ valor: PLACA });
    expect(r.status).toBe(403);
    expect(svc.colaImpuestos).not.toHaveBeenCalled();
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

describe('HU #13838 · POST /impuestos/buscar — body estricto', () => {
  const casos: Array<[string, unknown]> = [
    ['sin valor', {}],
    ['valor vacío', { valor: '' }],
    ['valor solo espacios', { valor: '   ' }],
    ['valor > 100', { valor: 'A'.repeat(101) }],
    ['valor que no es texto', { valor: 123 }],
    ['campo extra', { valor: PLACA, page: 2 }],
  ];
  for (const [nombre, body] of casos) {
    it(`400 ${nombre}, sin cola y sin rastro`, async () => {
      const r = await request(await app()).post(URL).set('Authorization', await admin()).send(body as object);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'Datos inválidos' });
      expect(svc.colaImpuestos).not.toHaveBeenCalled();
      expect(pii.logPiiAccess).not.toHaveBeenCalled();
    });
  }

  it('100 caracteres exactos sí pasan (borde)', async () => {
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: 'A'.repeat(100) });
    expect(r.status).toBe(200);
  });

  it('POST /buscar no cae en ninguna ruta /:id de los sub-routers: responde la consulta de gestión', async () => {
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: PLACA });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ total: 0, items: [] });
    expect(svc.colaImpuestos).toHaveBeenCalledTimes(1);
  });
});

describe('HU #13838 · POST /impuestos/buscar — resultado', () => {
  it('200: valor recortado, página 1 de 5, total real; tarjeta exacta sin PII ni campos internos', async () => {
    svc.colaImpuestos.mockResolvedValue(pagina([fila, sinOrganismoNombre], 12));
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: `  ${PLACA}  ` });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      total: 12,
      items: [
        { id: I1, placa: PLACA, idFlit: 'FL-777', estado: 'pagado', organismo: 'Tránsito de Medellín', liquidado: 345000, pagado: '2026-10-05T10:00:00.000Z' },
        { id: 'x2', placa: null, idFlit: 'FL-777', estado: 'solicitado', organismo: '05001', liquidado: null, pagado: null },
      ],
    });
    expect(JSON.stringify(r.body)).not.toMatch(/Ana|1012345678|9BWZZZ|Gestora Uno|Empleado FLIT|351000|MAZDA|rojo|Traspaso/);
    expect(svc.colaImpuestos.mock.calls[0]![1]).toEqual({ buscar: PLACA, page: 1, pageSize: 5 });
  });

  it('alcance: la cola recibe el contexto del enlace de ESE usuario (organismos de tránsito)', async () => {
    svc.alcance = { enlace: 'organismos_transito', organismos: ['05001'] };
    const t = `Bearer ${await testToken({ sub: ++sub, role: 'xyz_gestor' as never, tipoEnlace: 'organismos_transito', funciones: ['impuestos.cola.ver', 'drflit.gestion.consultar'] })}`;
    const r = await request(await app()).post(URL).set('Authorization', t).send({ valor: PLACA });
    expect(r.status).toBe(200);
    expect(svc.colaImpuestos.mock.calls[0]![0]).toMatchObject({ userId: sub, organismos: ['05001'], alcance: svc.alcance });
  });

  it('rastro PII `search` con 200: recurso flito_impuesto, campos de la tarjeta, filas=N y SIN el valor', async () => {
    svc.colaImpuestos.mockResolvedValue(pagina([fila], 12));
    await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: PLACA });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    const [, opts] = pii.logPiiAccess.mock.calls[0]!;
    expect(opts).toMatchObject({
      resourceTipo: 'flito_impuesto', resourceId: null, accion: 'search', camposAccedidos: ['placa'],
      motivo: 'Lectura de impuestos — filas=1',
    });
    expect(JSON.stringify(opts)).not.toContain(PLACA);
  });

  it('0 filas: 200 { total: 0, items: [] } y el rastro se escribe igual con filas=0, sin el valor', async () => {
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: VIN });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ total: 0, items: [] });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    expect(pii.logPiiAccess.mock.calls[0]![1]).toMatchObject({ motivo: 'Lectura de impuestos — filas=0' });
    expect(JSON.stringify(pii.logPiiAccess.mock.calls[0]![1])).not.toContain(VIN);
  });
});

describe('HU #13838 · POST /impuestos/buscar — limitador por usuario', () => {
  it('429 a partir de la 41.ª consulta del mismo usuario en el minuto; otro usuario no comparte cupo', async () => {
    const a = await app();
    const tok = await admin();
    const estados: number[] = [];
    for (let i = 0; i < 41; i++) estados.push((await request(a).post(URL).set('Authorization', tok).send({ valor: PLACA })).status);
    expect(estados.slice(0, 40).every((s) => s === 200)).toBe(true);
    expect(estados[40]).toBe(429);
    expect((await request(a).post(URL).set('Authorization', await admin()).send({ valor: PLACA })).status).toBe(200);
  });
});

// HU #13941 (AC4/AC6): «Consultar la gestión» de Dr. Flit se exige PRIMERO; la frontera sigue siendo `conAlcance`.
describe('HU #13941 · POST /buscar — función «Consultar la gestión» de Dr. Flit', () => {
  it('AC4: con `impuestos.cola.ver` pero sin `drflit.gestion.consultar` → 403 drflit-funcion-no-habilitada, sin consultar ni rastro', async () => {
    const t = await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: ['impuestos.cola.ver'] });
    const r = await request(await app()).post(URL).set('Authorization', `Bearer ${t}`).send({ valor: PLACA });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: expect.any(String), codigo: 'drflit-funcion-no-habilitada', funcion: 'drflit.gestion.consultar' });
    expect(svc.colaImpuestos).not.toHaveBeenCalled();
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('AC6: enlace compañía con las dos funciones → la cola recibe el alcance de SU compañía (la frontera no cambia)', async () => {
    svc.alcance = { enlace: 'compania', companiaId: 42 };
    const t = `Bearer ${await testToken({ sub: ++sub, role: 'xyz_cliente' as never, tipoEnlace: 'compania', funciones: ['impuestos.cola.ver', 'drflit.gestion.consultar'] })}`;
    const r = await request(await app()).post(URL).set('Authorization', t).send({ valor: PLACA });
    expect(r.status).toBe(200);
    expect(svc.colaImpuestos.mock.calls[0]![0]).toMatchObject({ userId: sub, alcance: svc.alcance });
  });
});
