// HU #14132, AC3 (gate QA modo B) — la incompleta que escribe el WORKER (aparcarFila: modalidad placa, vin NULL, sin
// factura, propietario orden 0 SIN tipo_documento/dirección/municipio/departamento) debe poder pasar por
// `reintentarIncompleta` y producir la Renovación en `solicitado` SIN factura. Contra Postgres REAL (TEST_DATABASE_URL).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';

const URL_BASE = process.env.TEST_DATABASE_URL;
const consultarMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/client.js', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: {}, getPoolStats: () => ({}) };
  const schema = await import('../../src/db/schema.js');
  return { db: drizzle(postgres(url, { max: 4, onnotice: () => {} }), { schema }), getPoolStats: () => ({}) };
});
vi.mock('../../src/modules/flito-soat/flito-soat-cliente-runt.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), consultarYClasificar: consultarMock,
}));

describe.skipIf(!URL_BASE)('AC3 — reintento manual de una incompleta escrita por el worker', () => {
  let sql: postgres.Sql;
  const reservado = randomUUID();
  const VIN = `QA${Date.now().toString().slice(-9)}XY1234`.slice(0, 17);
  let companiaId: number; let userId: number; let incId: string | undefined;

  beforeAll(async () => {
    sql = postgres(URL_BASE!, { max: 2, onnotice: () => {} });
    const [c] = await sql`SELECT id FROM clients ORDER BY id LIMIT 1`; companiaId = c!.id;
    const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`; userId = u!.id;
  });
  afterAll(async () => {
    if (incId) {
      await sql`DELETE FROM flito_soat_historial WHERE soat_id = ${reservado}`.catch(() => {});
      await sql`DELETE FROM flito_compradores WHERE soat_id = ${reservado} OR soat_incompleta_id = ${incId}`.catch(() => {});
      await sql`DELETE FROM flito_soat_incompletas WHERE id = ${incId}`.catch(() => {});
      await sql`DELETE FROM flito_soat WHERE id = ${reservado}`.catch(() => {});
      await sql`DELETE FROM vehicles WHERE vin = ${VIN}`.catch(() => {});
    }
    await sql?.end();
  });

  it('aparcarFila (real) → reintentarIncompleta (RUNT ok) → Renovación solicitado, sin factura, propietario conservado', async () => {
    const { aparcarFila } = await import('../../src/modules/flito-soat/flito-soat-masivo-crear.js');
    const { reintentarIncompleta } = await import('../../src/modules/flito-soat/flito-soat-incompletas-reintento.service.js');
    const { extraerDatosCanal } = await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js');
    const ctx = { userId, username: 'qa@prueba.co', role: 'admin', proyeccionCliente: false, alcance: 'todo', companiaId } as never;
    const fila = {
      id: randomUUID(), loteId: randomUUID(), placa: 'QAB123', documento: '900123456', nombre: 'Persona Sintetica Prueba',
      correo: 'p@ejemplo.com', celular: '3101234567', soatIdReservado: reservado, intentos: 2, creadoPorId: userId, creadoPorNombre: 'qa', companiaId,
    } as never;
    const r = await aparcarFila({ fila, canal: { companiaId, carpetaStorage: null } as never, ctx, intentos: 2, causa: 'timeout' });
    expect(r).toBe('aparcada');
    const [inc] = await sql`SELECT id, vin, placa, modalidad_consulta, motivo_pendiente, factura_storage_key, estado FROM flito_soat_incompletas WHERE soat_id_reservado = ${reservado}`;
    incId = inc!.id;
    expect(inc).toMatchObject({ vin: null, placa: 'QAB123', modalidad_consulta: 'placa', motivo_pendiente: 'runt_sin_respuesta', factura_storage_key: null, estado: 'incompleta' });
    const [p] = await sql`SELECT tipo_documento, direccion, municipio, departamento, numero_documento, nombres FROM flito_compradores WHERE soat_incompleta_id = ${incId}`;
    expect(p).toMatchObject({ tipo_documento: null, direccion: null, municipio: null, departamento: null, numero_documento: '900123456', nombres: 'Persona Sintetica Prueba' });

    const datos = extraerDatosCanal({ vehiculo: { placa: 'QAB123', vin: VIN, marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
      cilindraje: '1598', tipoServicio: 'Particular', tipoCarroceria: 'WAGON', pasajerosSentados: '5', puertas: '5', organismoTransito: 'X' } });
    consultarMock.mockResolvedValue({ clase: 'ok', datos, vinEfectivo: VIN, organismoCodigo: null });
    const h = await reintentarIncompleta(incId!, ctx);
    expect(consultarMock).toHaveBeenCalledWith({ modalidad: 'placa', placa: 'QAB123', documento: '900123456' }, 'renovacion');
    expect(h?.respuesta).toMatchObject({ resultado: 'completada', soatId: reservado, estado: 'solicitado' });
    const [s] = await sql`SELECT estado, vin FROM flito_soat WHERE id = ${reservado}`;
    expect(s).toMatchObject({ estado: 'solicitado', vin: VIN });
    const [so] = await sql`SELECT tipo_soat FROM flito_soat_solicitud WHERE soat_id = ${reservado}`;
    expect(so).toMatchObject({ tipo_soat: 'renovacion' });
    const sop = await sql`SELECT 1 FROM flito_soportes WHERE soat_id = ${reservado}`;
    expect(sop.length).toBe(0);
    const [p2] = await sql`SELECT soat_id, numero_documento FROM flito_compradores WHERE soat_incompleta_id = ${incId}`;
    expect(p2).toMatchObject({ soat_id: reservado, numero_documento: '900123456' });
    const [i2] = await sql`SELECT estado, soat_id FROM flito_soat_incompletas WHERE id = ${incId}`;
    expect(i2).toMatchObject({ estado: 'completada', soat_id: reservado });
  });
});
