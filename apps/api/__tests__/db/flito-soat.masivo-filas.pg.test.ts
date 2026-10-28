// HU #14134 (Feature #14013, ADR-0032) — filas del avance del lote (estado + vehículo del RUNT) y su vida efímera,
// contra Postgres REAL. Solo corre con TEST_DATABASE_URL. Fixtures con COMMIT, borrados en `afterEach`.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const URL_BASE = process.env.TEST_DATABASE_URL;
vi.mock('../../src/db/client.js', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: {}, getPoolStats: () => ({}) };
  const schema = await import('../../src/db/schema.js');
  return { db: drizzle(postgres(url, { max: 4, onnotice: () => {} }), { schema }), getPoolStats: () => ({}) };
});
const { piiMock } = vi.hoisted(() => ({ piiMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_0273 = readFileSync(path.resolve(__dirname, '../../src/db/migrations/0273_flito_soat_masivo_filas_vehiculo.sql'), 'utf8');

describe('0273 — análisis estático', () => {
  it('idempotente, sin BEGIN/COMMIT y con las tres columnas nullable', () => {
    const limpio = SQL_0273.replace(/--[^\n]*/g, '');
    expect(limpio).not.toMatch(/\b(BEGIN|COMMIT|NOT NULL|DEFAULT)\b/i);
    for (const c of ['vehiculo_marca varchar(60)', 'vehiculo_linea varchar(80)', 'vehiculo_modelo smallint']) {
      expect(limpio).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
    }
  });
});

describe('registro PII de la lectura de filas (un registro por lote y usuario)', () => {
  it('registra una sola vez por (usuario, lote), sin placas en el motivo', async () => {
    const pii = await import('../../src/modules/flito-soat/flito-soat-masivo.pii.js');
    pii.reiniciarLecturasRegistradasMasivo(); piiMock.mockClear();
    const req = {} as never;
    for (let i = 0; i < 5; i++) await pii.registrarLecturaFilasMasivo(req, { id: 'lote-1', filas: 3 }, 7);
    await pii.registrarLecturaFilasMasivo(req, { id: 'lote-1', filas: 3 }, 8);
    expect(piiMock).toHaveBeenCalledTimes(2);
    const arg = piiMock.mock.calls[0]![1];
    expect(arg.motivo).toBe('avance_filas lote=lote-1 filas=3');
    expect(arg.camposAccedidos).toEqual(['placa', 'vin']);
  });
});

describe('vehiculoDeDesenlace', () => {
  it('toma marca/línea/modelo del RUNT; modelo no numérico → null; otras clases → vacío', async () => {
    const { vehiculoDeDesenlace } = await import('../../src/modules/flito-soat/flito-soat-masivo-crear.js');
    const ok = (modelo: string | null) => ({ clase: 'ok', datos: { marca: ' MAZDA ', linea: '3', modelo } }) as never;
    expect(vehiculoDeDesenlace(ok('2021'))).toEqual({ vehiculoMarca: 'MAZDA', vehiculoLinea: '3', vehiculoModelo: 2021 });
    expect(vehiculoDeDesenlace(ok('N/A'))).toMatchObject({ vehiculoModelo: null });
    expect(vehiculoDeDesenlace({ clase: 'caido' } as never)).toEqual({});
  });
});

describe.skipIf(!URL_BASE)('filas del avance contra Postgres real', () => {
  let sql: postgres.Sql;
  let companiaId: number;
  let otraCompaniaId: number;
  const lotes: string[] = [];
  let svc: typeof import('../../src/modules/flito-soat/flito-soat-masivo.service.js');
  let reclamo: typeof import('../../src/modules/flito-soat/flito-soat-masivo-reclamo.js');
  let purga: typeof import('../../src/modules/flito-soat/flito-soat-masivo-purga.js');
  const ctxDe = (c: number) => ({ alcance: 'compania', companiaId: c, userId: 1, username: 'u' }) as never;

  beforeAll(async () => {
    sql = postgres(URL_BASE!, { max: 2, onnotice: () => {} });
    svc = await import('../../src/modules/flito-soat/flito-soat-masivo.service.js');
    reclamo = await import('../../src/modules/flito-soat/flito-soat-masivo-reclamo.js');
    purga = await import('../../src/modules/flito-soat/flito-soat-masivo-purga.js');
    const cs = await sql`SELECT id FROM clients WHERE id NOT IN (SELECT compania_id FROM flito_soat_masivo_lotes WHERE estado <> 'terminado') ORDER BY id LIMIT 2`;
    companiaId = cs[0]!.id; otraCompaniaId = cs[1]!.id;
  });
  afterEach(async () => { if (lotes.length) await sql`DELETE FROM flito_soat_masivo_lotes WHERE id IN ${sql(lotes)}`; lotes.length = 0; });
  afterAll(async () => { await sql?.end(); });

  /** Lote `procesando` con una fila por estado; la «creada» lleva el vehículo del RUNT. */
  async function lote() {
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, estado, total_filas, archivo_hash, iniciado_en)
      VALUES (${companiaId}, 'Ana', 'renovacion', 'procesando', 4, 'h', now()) RETURNING id`;
    lotes.push(l!.id);
    await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, motivo_rechazo, placa, documento, nombre, vehiculo_marca, vehiculo_linea, vehiculo_modelo, vigente_hasta, soat_id_reservado, reclamada_en) VALUES
      (${l!.id}, 5, 'pendiente', NULL, 'DDD444', '4', 'Dos', NULL, NULL, NULL, NULL, NULL, NULL),
      (${l!.id}, 3, 'rechazada', 'runt_no_cuadra', 'BBB222', '2', 'Dos', NULL, NULL, NULL, NULL, NULL, NULL),
      (${l!.id}, 4, 'consultando', NULL, 'CCC333', '3', 'Tres', NULL, NULL, NULL, NULL, gen_random_uuid(), now())`;
    return l!.id as string;
  }

  it('devuelve las filas ordenadas por nFila, con estado del contrato, motivo textual y sin datos del propietario', async () => {
    const id = await lote();
    const a = await svc.avanceLote(id, ctxDe(companiaId));
    expect(a!.filas.map((f) => [f.nFila, f.estado])).toEqual([[3, 'rechazada'], [4, 'consultando'], [5, 'en_cola']]);
    expect(a!.filas[0]).toEqual({
      nFila: 3, placa: 'BBB222', vin: null, estado: 'rechazada', marca: null, linea: null, modelo: null,
      motivo: { codigo: 'runt_no_cuadra', mensaje: expect.any(String) },
    });
    expect(a!.filas[0]!.motivo!.mensaje.length).toBeGreaterThan(5);
    expect(Object.keys(a!.filas[0]!).sort()).toEqual(['estado', 'linea', 'marca', 'modelo', 'motivo', 'nFila', 'placa', 'vin']);
    expect(JSON.stringify(a!.filas)).not.toMatch(/"(documento|nombre|correo|celular)"|Dos|Tres/);
    // Aditivo: el contrato anterior se conserva.
    expect(a!.motivosRechazo).toHaveLength(1);
    expect(a!.resumen).toBeNull();
  });

  it('el lote de otra compañía sigue siendo null (404)', async () => {
    const id = await lote();
    expect(await svc.avanceLote(id, ctxDe(otraCompaniaId))).toBeNull();
  });

  it('al terminar el lote, creada/por validar quedan sin placa ni vehículo; la rechazada conserva la placa hasta la purga, que borra también el vehículo', async () => {
    const id = await lote();
    await sql`DELETE FROM flito_soat_masivo_filas WHERE lote_id = ${id} AND estado IN ('pendiente','consultando')`;
    await sql`UPDATE flito_soat_masivo_filas SET vehiculo_marca = 'MAZDA', vehiculo_linea = '3', vehiculo_modelo = 2021 WHERE lote_id = ${id}`;
    await sql`UPDATE flito_soat_masivo_lotes SET total_filas = 1 WHERE id = ${id}`;
    expect(await reclamo.cerrarLoteSiTermino(id)).toBe(true);
    let a = await svc.avanceLote(id, ctxDe(companiaId));
    expect(a!.filas[0]).toMatchObject({ estado: 'rechazada', placa: 'BBB222', marca: 'MAZDA', modelo: 2021 });
    expect(await purga.purgarPiiRechazadas(new Date(Date.now() + 25 * 3600_000), id)).toBe(1);
    a = await svc.avanceLote(id, ctxDe(companiaId));
    expect(a!.filas[0]).toMatchObject({ placa: null, vin: null, marca: null, linea: null, modelo: null, motivo: { codigo: 'runt_no_cuadra' } });
  });
  it('tope: con más de 200 filas insertadas (el CHECK del lote limita la entrada, no las filas) devuelve 200 ordenadas por nFila', async () => {
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, estado, total_filas, archivo_hash, iniciado_en)
      VALUES (${companiaId}, 'Ana', 'renovacion', 'procesando', 200, 'h', now()) RETURNING id`;
    lotes.push(l!.id);
    await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, placa, documento)
      SELECT ${l!.id}, 300 - g, 'pendiente', 'TOP' || g, '1' FROM generate_series(1, 205) g`;
    const a = await svc.avanceLote(l!.id, ctxDe(companiaId));
    expect(a!.filas).toHaveLength(200);
    const ns = a!.filas.map((f) => f.nFila);
    expect(ns).toEqual([...ns].sort((x, y) => x - y));
    expect(ns[0]).toBe(95); // las 5 de nFila más alta (295..299) quedan fuera: el tope corta por el final
    expect(ns[199]).toBe(294);
  });

  it('al terminar el lote, aceptada y por validar con placa, vin y vehículo poblados quedan TODOS en NULL', async () => {
    const [s] = await sql`SELECT id FROM flito_soat LIMIT 1`;
    expect(s, 'se necesita al menos un flito_soat en la BD local para el FK de la aceptada').toBeTruthy();
    const [i] = await sql`INSERT INTO flito_soat_incompletas (soat_id_reservado, compania_id, vin, tipo_soat, modalidad_consulta, motivo_pendiente, estado, solicitado_por_nombre, solicitado_en, intentos, ultimo_intento_en)
      VALUES (gen_random_uuid(), ${companiaId}, 'ZZZFILAS000000001', 'inicial', 'vin', 'falta_factura_venta', 'incompleta', 'prueba', now(), 1, now()) RETURNING id`;
    try {
      const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, estado, total_filas, archivo_hash, iniciado_en)
        VALUES (${companiaId}, 'Ana', 'renovacion', 'procesando', 2, 'h', now()) RETURNING id`;
      lotes.push(l!.id);
      await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, placa, vin, documento, nombre, vehiculo_marca, vehiculo_linea, vehiculo_modelo, soat_id) VALUES
        (${l!.id}, 2, 'aceptada', 'AAA111', 'ZZZV0000000000001', '1', 'N', 'MAZDA', '3', 2021, ${s!.id})`;
      await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, placa, vin, documento, nombre, vehiculo_marca, vehiculo_linea, vehiculo_modelo, incompleta_id) VALUES
        (${l!.id}, 3, 'por_validar', 'BBB222', 'ZZZV0000000000002', '2', 'N', 'KIA', 'RIO', 2020, ${i!.id})`;
      expect(await reclamo.cerrarLoteSiTermino(l!.id)).toBe(true);
      const filas = await sql`SELECT placa, vin, documento, nombre, vehiculo_marca, vehiculo_linea, vehiculo_modelo FROM flito_soat_masivo_filas WHERE lote_id = ${l!.id}`;
      expect(filas).toHaveLength(2);
      for (const f of filas) expect(Object.values(f)).toEqual([null, null, null, null, null, null, null]);
    } finally {
      await sql`DELETE FROM flito_soat_masivo_lotes WHERE id IN ${sql(lotes.length ? lotes : [''])}`.catch(() => {});
      lotes.length = 0;
      await sql`DELETE FROM flito_soat_incompletas WHERE id = ${i!.id}`;
    }
  });
});
