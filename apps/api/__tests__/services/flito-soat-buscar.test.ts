// HU #13837 (G2, Feature #13834) — consulta de gestión de Dr. Flit: `POST /api/flito/soat/buscar`.
// Diseño: docs/diseno/feature-13834-dr-flit-consultas-gestion.md · tarjeta: docs/ux/flito-dr-flit-f6.md §F6.6 SOAT.
//
// - El valor viaja en el BODY `{ valor }` (trim, 1..100, estricto) → 400 «Datos inválidos» sin consultar la
//   cola y sin rastro PII.
// - Mismo permiso (`soat.cola.ver`) y alcance (`contextoSoat(req.user)`) que el GET /; 403 sin la función.
// - Primera página de 5 filas + total real; la tarjeta usa solo campos de las DOS ramas de la fila (interna y
//   del canal Cliente): sin comprador, documento, proveedor, valor ni vigencia. Compañía solo sin proyección
//   del canal Cliente; VIN solo cuando no hay placa.
// - Rastro PII `search` por `registrarAccesoSoat` con 200 (también con 0 filas), `filas=N`, SIN el valor.
// - Limiter `drflit-gestion`: 40 / min por usuario.
//
// Router REAL montado como en `app.ts` (`conAlcance`). El servicio se dobla en `cola` y `contextoSoat`: el
// filtrado SQL del alcance (compañía / proveedor) ya lo cubren los tests de la cola; aquí se afirma que la
// ruta pasa a `cola` EXACTAMENTE el contexto que `contextoSoat` resolvió para ESE usuario y que proyecta.
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
const svc = vi.hoisted(() => ({ cola: vi.fn(), contextoSoat: vi.fn() }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), cola: svc.cola, contextoSoat: svc.contextoSoat,
}));

const URL = '/api/flito/soat/buscar';
const PLACA = 'QTQ100';
const VIN = '9BWZZZ377VT004251';
const S1 = '00000000-0000-0000-0000-0000000000c1';
const S2 = '00000000-0000-0000-0000-0000000000c2';

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/soat', conAlcance('soat', router));
  a.use(errorHandler);
  return a;
}

let sub = 13837_000;
const admin = async () => `Bearer ${await testToken({ sub: ++sub, role: 'admin' })}`;

const ctxInterno = { userId: 1, username: 'u', role: 'admin', proyeccionCliente: false, alcance: 'todo', proveedorSoatId: null, companiaId: null };
const ctxCompania = { ...ctxInterno, role: 'cliente', proyeccionCliente: true, alcance: 'compania', companiaId: 42 };
const ctxProveedor = { ...ctxInterno, role: 'proveedor', alcance: 'proveedor', proveedorSoatId: 'prov-1' };

/** Fila de la cola (rama interna) con PII y campos internos que la tarjeta NO debe dejar pasar. */
const filaInterna = {
  id: S1, vin: VIN, placa: PLACA, marca: 'MAZDA', estado: 'solicitado', companiaNombre: 'Gestora Uno',
  proveedorSoatId: 'prov-1', proveedorSoatNombre: 'Proveedor Secreto', gestionOperaciones: false,
  compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '1012345678', tipoDocumento: 'CC', orden: 1, porcentajeParticipacion: 100 }],
  enviadoPorNombre: 'Empleado FLIT', enviadoEn: '2026-10-01T10:00:00.000Z', pagadoEn: null, valorPagado: 512000,
  vigencia: null, estancado: false, creadoEn: '2026-09-30T10:00:00.000Z',
};
/** Fila del canal Cliente (proyectada), sin placa: el título es el VIN. */
const filaClienteSinPlaca = {
  id: S2, vin: VIN, placa: null, estado: 'pagado', companiaNombre: 'Mi Compañía',
  compradores: [], enviadoEn: '2026-10-01T10:00:00.000Z', pagadoEn: '2026-10-03T10:00:00.000Z',
  estancado: false, creadoEn: '2026-09-30T10:00:00.000Z',
};

const pagina = (items: unknown[], total = items.length) => ({ items, total, page: 1, pageSize: 5 });

beforeEach(() => {
  pii.logPiiAccess.mockClear();
  svc.cola.mockReset(); svc.contextoSoat.mockReset();
  svc.contextoSoat.mockResolvedValue(ctxInterno);
  svc.cola.mockResolvedValue(pagina([]));
});

describe('HU #13837 · POST /buscar — autenticación y permiso', () => {
  it('401 sin token, sin cola ni rastro', async () => {
    const r = await request(await app()).post(URL).send({ valor: PLACA });
    expect(r.status).toBe(401);
    expect(svc.cola).not.toHaveBeenCalled();
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });

  it('403 sin la función soat.cola.ver, sin consultar la cola ni escribir rastro', async () => {
    const t = await testToken({ sub: ++sub, role: 'xyz_sin_nada' as never, funciones: ['tramites.cola.ver'] }); // otra cola: no arrastra soat.cola.ver por la cadena
    const r = await request(await app()).post(URL).set('Authorization', `Bearer ${t}`).send({ valor: PLACA });
    expect(r.status).toBe(403);
    expect(svc.cola).not.toHaveBeenCalled();
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

describe('HU #13837 · POST /buscar — body estricto', () => {
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
      expect(svc.cola).not.toHaveBeenCalled();
      expect(pii.logPiiAccess).not.toHaveBeenCalled();
    });
  }

  it('100 caracteres exactos sí pasan (borde)', async () => {
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: 'A'.repeat(100) });
    expect(r.status).toBe(200);
  });

  it('POST /buscar no cae en ninguna ruta /:id: responde la consulta de gestión', async () => {
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: PLACA });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ total: 0, items: [] });
  });
});

describe('HU #13837 · POST /buscar — resultado', () => {
  it('200 interno: valor recortado, página 1 de 5, total real; tarjeta con compañía y sin VIN (hay placa)', async () => {
    svc.cola.mockResolvedValue(pagina([filaInterna], 9));
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: `  ${PLACA}  ` });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      total: 9,
      items: [{ id: S1, placa: PLACA, estado: 'solicitado', compania: 'Gestora Uno', solicitado: '2026-10-01T10:00:00.000Z', pagado: null }],
    });
    expect(JSON.stringify(r.body)).not.toMatch(/Ana|1012345678|9BWZZZ|Proveedor Secreto|prov-1|Empleado FLIT|512000|MAZDA/);
    expect(svc.cola).toHaveBeenCalledTimes(1);
    expect(svc.cola.mock.calls[0]![1]).toEqual({ buscar: PLACA, page: 1, pageSize: 5 });
  });

  it('alcance compañía: `cola` recibe el contexto de `contextoSoat(req.user)`; sin compañía en la tarjeta y VIN como título sin placa', async () => {
    svc.contextoSoat.mockResolvedValue(ctxCompania);
    svc.cola.mockResolvedValue(pagina([filaClienteSinPlaca]));
    const t = `Bearer ${await testToken({ sub: ++sub, role: 'xyz_cliente' as never, tipoEnlace: 'compania', funciones: ['soat.cola.ver'] })}`;
    const r = await request(await app()).post(URL).set('Authorization', t).send({ valor: VIN });
    expect(r.status).toBe(200);
    expect(svc.contextoSoat.mock.calls[0]![0]).toMatchObject({ sub });
    expect(svc.cola.mock.calls[0]![0]).toBe(await svc.contextoSoat.mock.results[0]!.value);
    expect(r.body).toEqual({
      total: 1,
      items: [{ id: S2, placa: null, vin: VIN, estado: 'pagado', solicitado: '2026-10-01T10:00:00.000Z', pagado: '2026-10-03T10:00:00.000Z' }],
    });
    expect(r.body.items[0]).not.toHaveProperty('compania');
  });

  it('alcance proveedor: `cola` recibe el contexto del gestor (su proveedor), con compañía visible', async () => {
    svc.contextoSoat.mockResolvedValue(ctxProveedor);
    svc.cola.mockResolvedValue(pagina([filaInterna]));
    const t = `Bearer ${await testToken({ sub: ++sub, role: 'xyz_gestor' as never, tipoEnlace: 'proveedor', funciones: ['soat.cola.ver'] })}`;
    const r = await request(await app()).post(URL).set('Authorization', t).send({ valor: PLACA });
    expect(r.status).toBe(200);
    expect(svc.cola.mock.calls[0]![0]).toMatchObject({ alcance: 'proveedor', proveedorSoatId: 'prov-1' });
    expect(r.body.items[0]).toMatchObject({ compania: 'Gestora Uno' });
  });

  it('rastro PII `search` escrito con 200: recurso flito_soat, campos de la tarjeta, filas=N y SIN el valor', async () => {
    svc.cola.mockResolvedValue(pagina([filaInterna], 9));
    await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: PLACA });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    const [, opts] = pii.logPiiAccess.mock.calls[0]!;
    expect(opts).toEqual({
      resourceTipo: 'flito_soat', resourceId: null, accion: 'search', camposAccedidos: ['placa', 'vin'],
      motivo: 'Lectura de SOAT — filas=1',
    });
    expect(JSON.stringify(opts)).not.toContain(PLACA);
  });

  it('0 filas: 200 { total: 0, items: [] } y el rastro se escribe igual con filas=0, sin el valor', async () => {
    const r = await request(await app()).post(URL).set('Authorization', await admin()).send({ valor: VIN });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ total: 0, items: [] });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    expect(pii.logPiiAccess.mock.calls[0]![1]).toMatchObject({ motivo: 'Lectura de SOAT — filas=0' });
    expect(JSON.stringify(pii.logPiiAccess.mock.calls[0]![1])).not.toContain(VIN);
  });
});

describe('HU #13837 · POST /buscar — limitador por usuario', () => {
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
