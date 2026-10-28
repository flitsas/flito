// HU #14134 — persistencia de marca/línea/modelo del RUNT en la fila del lote (Renovación e Inicial), contra Postgres REAL.
// Solo corre con TEST_DATABASE_URL. Renovación: las primitivas de alta de `flito-soat-cliente.service` se simulan
// (su cobertura es ajena a este WI) y se ejecuta de verdad `crearRenovacionDeFila` + `marcarFila`.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const URL_BASE = process.env.TEST_DATABASE_URL;
vi.mock('../../src/db/client.js', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: {}, getPoolStats: () => ({}) };
  const schema = await import('../../src/db/schema.js');
  return { db: drizzle(postgres(url, { max: 4, onnotice: () => {} }), { schema }), getPoolStats: () => ({}) };
});
vi.mock('../../src/modules/flito-soat/flito-soat-cliente.service.js', async (orig) => ({
  ...(await orig<typeof import('../../src/modules/flito-soat/flito-soat-cliente.service.js')>()),
  verificarRn01: vi.fn().mockResolvedValue(null),
  verificarTenenciaVehiculo: vi.fn().mockResolvedValue(undefined),
  upsertVehiculoRunt: vi.fn().mockResolvedValue(null),
  insertarSolicitudDespachada: vi.fn().mockResolvedValue(undefined),
}));

describe.skipIf(!URL_BASE)('vehículo del RUNT en la fila del lote', () => {
  let sql: postgres.Sql;
  let companiaId: number;
  const lotes: string[] = [];
  let comprador: string | null = null;
  const ctx = { userId: 1, username: 'prueba', alcance: 'todo' } as never;

  beforeAll(async () => {
    sql = postgres(URL_BASE!, { max: 2, onnotice: () => {} });
    const [c] = await sql`SELECT id FROM clients WHERE id NOT IN (SELECT compania_id FROM flito_soat_masivo_lotes WHERE estado <> 'terminado') ORDER BY id LIMIT 1`;
    companiaId = c!.id;
  });
  afterEach(async () => {
    if (comprador) await sql`DELETE FROM flito_compradores WHERE soat_id = ${comprador} AND nombre_completo = 'ZZ VEHICULO TEST'`;
    comprador = null;
    if (lotes.length) await sql`DELETE FROM flito_soat_masivo_lotes WHERE id IN ${sql(lotes)}`;
    await sql`DELETE FROM flito_soat_incompletas WHERE vin = 'ZZZVEH0000000001'`;
    lotes.length = 0;
  });
  afterAll(async () => { await sql?.end(); });

  const datos = { marca: 'MAZDA', linea: 'CX-30', modelo: '2022' };

  it('Renovación: crearRenovacionDeFila deja marca/línea/modelo en la fila aceptada', async () => {
    const [s] = await sql`SELECT id FROM flito_soat s WHERE NOT EXISTS (SELECT 1 FROM flito_compradores c WHERE c.soat_id = s.id) AND NOT EXISTS (SELECT 1 FROM flito_soat_masivo_filas f WHERE f.soat_id_reservado = s.id) LIMIT 1`;
    expect(s, 'se necesita un flito_soat sin compradores en la BD local').toBeTruthy();
    comprador = s!.id;
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, total_filas, archivo_hash)
      VALUES (${companiaId}, 'prueba', 'renovacion', 1, 'h') RETURNING id`;
    lotes.push(l!.id);
    await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, placa, documento, nombre, correo, celular, soat_id_reservado, reclamada_en)
      VALUES (${l!.id}, 2, 'consultando', 'ZZV123', '1', 'ZZ VEHICULO TEST', 'a@b.co', '3100000000', ${s!.id}, now())`;
    const rec = await import('../../src/modules/flito-soat/flito-soat-masivo-crear.js');
    const fila = { id: (await sql`SELECT id FROM flito_soat_masivo_filas WHERE lote_id = ${l!.id}`)[0]!.id, loteId: l!.id, nFila: 2, companiaId,
      creadoPorId: 1, creadoPorNombre: 'prueba', soatIdReservado: s!.id, intentos: 0, placa: 'ZZV123', documento: '1', nombre: 'ZZ VEHICULO TEST',
      correo: 'a@b.co', celular: '3100000000' };
    await rec.crearRenovacionDeFila({
      fila, canal: { companiaId } as never, ctx,
      desenlace: { clase: 'ok', vinEfectivo: 'ZZZVEH0000000009', organismoCodigo: null, datos } as never,
    });
    const [f] = await sql`SELECT estado, vehiculo_marca, vehiculo_linea, vehiculo_modelo FROM flito_soat_masivo_filas WHERE lote_id = ${l!.id}`;
    expect(f).toMatchObject({ estado: 'aceptada', vehiculo_marca: 'MAZDA', vehiculo_linea: 'CX-30', vehiculo_modelo: 2022 });
  });

  it('Inicial: aparcarFilaInicial con `vehiculo` deja los datos en la fila por_validar', async () => {
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, total_filas, archivo_hash)
      VALUES (${companiaId}, 'prueba', 'inicial', 1, 'h') RETURNING id`;
    lotes.push(l!.id);
    await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, vin, soat_id_reservado, reclamada_en)
      VALUES (${l!.id}, 2, 'consultando', 'ZZZVEH0000000001', gen_random_uuid(), now())`;
    const [fr] = await sql`SELECT id, soat_id_reservado FROM flito_soat_masivo_filas WHERE lote_id = ${l!.id}`;
    const ini = await import('../../src/modules/flito-soat/flito-soat-masivo-inicial.js');
    const { vehiculoDeDesenlace } = await import('../../src/modules/flito-soat/flito-soat-masivo-crear.js');
    const r = await ini.aparcarFilaInicial({
      fila: { id: fr!.id, loteId: l!.id, soatIdReservado: fr!.soat_id_reservado } as never,
      canal: { companiaId } as never, ctx, vin: 'ZZZVEH0000000001',
      decision: { tipo: 'pendiente', motivoPendiente: 'falta_factura_venta', tipoSoat: 'inicial', placa: null, vinRunt: null },
      vehiculo: vehiculoDeDesenlace({ clase: 'ok', datos } as never),
    });
    expect(r).toBe('aparcada');
    const [f] = await sql`SELECT estado, vehiculo_marca, vehiculo_linea, vehiculo_modelo FROM flito_soat_masivo_filas WHERE lote_id = ${l!.id}`;
    expect(f).toMatchObject({ estado: 'por_validar', vehiculo_marca: 'MAZDA', vehiculo_linea: 'CX-30', vehiculo_modelo: 2022 });
  });
});
