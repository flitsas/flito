// HU #14136 (Feature #14014) — completar una pendiente de la carga masiva: adjuntar factura y confirmar.
// Contra Postgres REAL (TEST_DATABASE_URL); RUNT, OCR, storage y canal se simulan.
//
// Matriz AC → casos:
//   AC1  factura con el mismo VIN → extracción para prellenar; sigue `incompleta`
//   AC2  confirmar Inicial → `solicitado` con soat_id_reservado, factura como soporte, incompleta `completada`
//   AC3  confirmar Renovación sin factura, propietario a mano → compuerta por placa + documento → `solicitado`
//   AC4  VIN distinto → 422 «El VIN de la factura no coincide…»; la fila no cambia
//   AC6  OCR caído → 200 `lectura: no_disponible`, la factura queda y se sigue a mano
//   AC7  otra compañía → null (la ruta responde 404) en adjuntar y confirmar
//   AC8  PDF falso → 400 `archivo_no_pdf` por los bytes; nada se guarda
//   AC9  dos confirmaciones simultáneas → una crea; la otra 409 `incompleta_ya_resuelta`
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';

const URL_BASE = process.env.TEST_DATABASE_URL;
const consultarMock = vi.hoisted(() => vi.fn());
const ocrMock = vi.hoisted(() => vi.fn());
const uploadMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/db/client.js', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: {}, getPoolStats: () => ({}) };
  const schema = await import('../../src/db/schema.js');
  return { db: drizzle(postgres(url, { max: 6, onnotice: () => {} }), { schema }), getPoolStats: () => ({}) };
});
vi.mock('../../src/modules/flito-soat/flito-soat-cliente-runt.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), consultarYClasificar: consultarMock,
}));
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), extraerFacturaVenta: ocrMock,
}));
vi.mock('../../src/services/storage.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), uploadEntityDocument: uploadMock,
}));
vi.mock('../../src/modules/flito-soat/flito-soat-cliente.service.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, canalDeLaCompania: async (_c: unknown, id: number) => ({ companiaId: id, carpetaStorage: null }) };
});

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const archivo = (buffer: Buffer = PDF) => ({ originalname: 'factura.pdf', mimetype: 'application/pdf', buffer, size: buffer.length });
const campo = (valor: string | null, confiable = true) => ({ valor, confianza: confiable ? 0.99 : 0.2, confiable });
const PROPIETARIO = {
  tipoDocumento: 'CC', numeroDocumento: '1020304050', nombres: 'ANA', apellidos: 'PEREZ', razonSocial: null,
  correo: 'ana@x.co', celular: '3001234567', direccion: 'Cra 1 # 2-3', municipio: 'Funza', departamento: 'Cundinamarca',
} as never;

describe.skipIf(!URL_BASE)('HU #14136 — completar una pendiente (Postgres real)', () => {
  let sql: postgres.Sql;
  let companiaId: number; let otraCompania: number; let userId: number;
  const creadas: { id: string; reservado: string; vin: string }[] = [];
  const ctx = () => ({ userId, username: 'qa@prueba.co', role: 'admin', proyeccionCliente: false, alcance: 'todo', companiaId } as never);
  const ctxCompania = (c: number) => ({ userId, username: 'qa@prueba.co', role: 'admin', proyeccionCliente: true, alcance: 'compania', companiaId: c } as never);
  let seq = 0;
  const nuevoVin = () => `QH${Date.now().toString().slice(-8)}${String(++seq).padStart(7, '0')}`.slice(0, 17);

  async function pendiente(o: { tipo?: 'inicial' | 'renovacion'; factura?: boolean } = {}) {
    const tipo = o.tipo ?? 'inicial'; const vin = nuevoVin(); const reservado = randomUUID();
    const [i] = await sql`INSERT INTO flito_soat_incompletas
      (soat_id_reservado, compania_id, vin, placa, tipo_soat, modalidad_consulta, motivo_pendiente, estado,
       solicitado_por_id, solicitado_por_nombre, intentos)
      VALUES (${reservado}, ${companiaId}, ${vin}, ${tipo === 'renovacion' ? `Q${seq}H${String(seq).padStart(2, '0')}A` : null},
        ${tipo}, ${tipo === 'renovacion' ? 'placa' : 'vin'}, ${tipo === 'renovacion' ? 'faltan_datos_propietario' : 'falta_factura_venta'},
        'incompleta', ${userId}, 'qa', 1) RETURNING id, placa`;
    creadas.push({ id: i!.id, reservado, vin });
    return { id: i!.id as string, reservado, vin, placa: i!.placa as string | null };
  }
  const datosRunt = async (vin: string, placa: string) => (await import('../../src/modules/flito-soat/flito-soat-cliente-runt.js')).extraerDatosCanal({
    vehiculo: { placa, vin, marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA', cilindraje: '1598',
      tipoServicio: 'Particular', tipoCarroceria: 'WAGON', pasajerosSentados: '5', puertas: '5', organismoTransito: 'X' },
  });
  const runtOk = async (vin: string, placa = 'QAB123') =>
    consultarMock.mockResolvedValue({ clase: 'ok', datos: await datosRunt(vin, placa), vinEfectivo: vin, organismoCodigo: null });
  const estado = async (id: string) => (await sql`SELECT estado, factura_storage_key FROM flito_soat_incompletas WHERE id = ${id}`)[0]!;

  beforeAll(async () => {
    sql = postgres(URL_BASE!, { max: 2, onnotice: () => {} });
    const cs = await sql`SELECT id FROM clients ORDER BY id LIMIT 2`; companiaId = cs[0]!.id; otraCompania = cs[1]?.id ?? companiaId + 100000;
    const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`; userId = u!.id;
  });
  beforeEach(() => {
    consultarMock.mockReset(); ocrMock.mockReset(); uploadMock.mockReset();
    uploadMock.mockImplementation(async (_c: string, id: string) => `test/soat/facturas-venta/${id}.pdf`);
  });
  afterAll(async () => {
    for (const c of creadas) {
      await sql`DELETE FROM flito_soat_historial WHERE soat_id = ${c.reservado}`.catch(() => {});
      await sql`DELETE FROM flito_soportes WHERE soat_id = ${c.reservado}`.catch(() => {});
      await sql`DELETE FROM flito_compradores WHERE soat_id = ${c.reservado} OR soat_incompleta_id = ${c.id}`.catch(() => {});
      await sql`DELETE FROM flito_soat_incompletas WHERE id = ${c.id}`.catch(() => {});
      await sql`DELETE FROM flito_soat_solicitud WHERE soat_id = ${c.reservado}`.catch(() => {});
      await sql`DELETE FROM flito_soat WHERE id = ${c.reservado}`.catch(() => {});
      await sql`DELETE FROM vehicles WHERE vin = ${c.vin}`.catch(() => {});
    }
    await sql?.end();
  });

  it('AC1: factura con el mismo VIN → extracción; la solicitud sigue pendiente y la factura queda con el soat_id reservado', async () => {
    const p = await pendiente();
    ocrMock.mockResolvedValue({ vin: campo(p.vin), nombres: campo('ANA'), numeroDocumento: campo('1020304050') });
    const { adjuntarFactura } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    const r = await adjuntarFactura(p.id, archivo(), ctx());
    expect(r).toMatchObject({ lectura: 'ok', vinVerificado: true, estado: 'incompleta' });
    expect(r!.extraccion.nombres?.valor).toBe('ANA');
    expect(uploadMock).toHaveBeenCalledWith(expect.any(String), p.reservado, 'factura.pdf', PDF, 'application/pdf');
    expect(await estado(p.id)).toMatchObject({ estado: 'incompleta', factura_storage_key: `test/soat/facturas-venta/${p.reservado}.pdf` });
  });

  it('AC4: VIN distinto → 422 con el mensaje; la solicitud no cambia', async () => {
    const p = await pendiente();
    ocrMock.mockResolvedValue({ vin: campo('ZZZZZZZZZZZZZZZZZ') });
    const { adjuntarFactura, VinFacturaNoCoincideError } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    await expect(adjuntarFactura(p.id, archivo(), ctx())).rejects.toBeInstanceOf(VinFacturaNoCoincideError);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(await estado(p.id)).toMatchObject({ estado: 'incompleta', factura_storage_key: null });
  });

  it('AC6: OCR caído → se guarda la factura y se sigue a mano (lectura no_disponible)', async () => {
    const p = await pendiente();
    const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
    ocrMock.mockRejectedValue(new OcrNoDisponibleError(503, 'caído'));
    const { adjuntarFactura } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    const r = await adjuntarFactura(p.id, archivo(), ctx());
    expect(r).toMatchObject({ lectura: 'no_disponible', vinVerificado: false, estado: 'incompleta', extraccion: {} });
    expect((await estado(p.id)).factura_storage_key).not.toBeNull();
  });

  it('AC8: un PDF falso se rechaza por los BYTES (400 archivo_no_pdf); nada se lee ni se guarda', async () => {
    const p = await pendiente();
    const { adjuntarFactura } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    await expect(adjuntarFactura(p.id, archivo(Buffer.from('MZ\x90\x00 esto es un ejecutable')), ctx()))
      .rejects.toMatchObject({ status: 400, codigo: 'archivo_no_pdf' });
    expect(ocrMock).not.toHaveBeenCalled(); expect(uploadMock).not.toHaveBeenCalled();
  });

  it('AC7: pendiente de otra compañía → null en adjuntar y en confirmar (404 sin revelar)', async () => {
    const p = await pendiente();
    const { adjuntarFactura, confirmarIncompleta } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    expect(await adjuntarFactura(p.id, archivo(), ctxCompania(otraCompania))).toBeNull();
    expect(await confirmarIncompleta(p.id, { propietario: PROPIETARIO, procedencia: null }, ctxCompania(otraCompania))).toBeNull();
    expect(ocrMock).not.toHaveBeenCalled(); expect(consultarMock).not.toHaveBeenCalled();
  });

  it('AC2: confirmar una Inicial con factura → solicitado con el soat_id reservado, factura como soporte, incompleta completada', async () => {
    const p = await pendiente();
    ocrMock.mockResolvedValue({ vin: campo(p.vin) });
    const { adjuntarFactura, confirmarIncompleta } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    await adjuntarFactura(p.id, archivo(), ctx());
    await runtOk(p.vin);
    const r = await confirmarIncompleta(p.id, { propietario: PROPIETARIO, procedencia: null }, ctx());
    expect(r).toMatchObject({ soatId: p.reservado, estado: 'solicitado', tipoSoat: 'inicial' });
    expect(consultarMock).toHaveBeenCalledWith({ modalidad: 'vin', vin: p.vin }, 'inicial');
    expect((await sql`SELECT estado, vin FROM flito_soat WHERE id = ${p.reservado}`)[0]).toMatchObject({ estado: 'solicitado', vin: p.vin });
    expect((await sql`SELECT 1 FROM flito_soportes WHERE soat_id = ${p.reservado}`).length).toBe(1);
    expect((await sql`SELECT soat_id, numero_documento FROM flito_compradores WHERE soat_incompleta_id = ${p.id}`)[0])
      .toMatchObject({ soat_id: p.reservado, numero_documento: '1020304050' });
    expect(await estado(p.id)).toMatchObject({ estado: 'completada' });
  });

  it('AC5/AC2: Inicial SIN factura cargada no pasa a solicitado ni consulta el RUNT (400)', async () => {
    const p = await pendiente();
    const { confirmarIncompleta } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    await expect(confirmarIncompleta(p.id, { propietario: PROPIETARIO, procedencia: null }, ctx())).rejects.toMatchObject({ status: 400 });
    expect(consultarMock).not.toHaveBeenCalled();
    expect((await sql`SELECT 1 FROM flito_soat WHERE id = ${p.reservado}`).length).toBe(0);
    expect((await estado(p.id)).estado).toBe('incompleta');
  });

  it('AC3: Renovación pendiente sin factura, propietario a mano → compuerta por placa + documento → solicitado', async () => {
    const p = await pendiente({ tipo: 'renovacion' });
    await runtOk(p.vin, p.placa!);
    const { confirmarIncompleta } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    const r = await confirmarIncompleta(p.id, { propietario: PROPIETARIO, procedencia: null }, ctx());
    expect(r).toMatchObject({ soatId: p.reservado, estado: 'solicitado', tipoSoat: 'renovacion' });
    expect(consultarMock).toHaveBeenCalledWith({ modalidad: 'placa', placa: p.placa, documento: '1020304050' }, 'renovacion');
    expect((await sql`SELECT 1 FROM flito_soportes WHERE soat_id = ${p.reservado}`).length).toBe(0);
    expect((await estado(p.id)).estado).toBe('completada');
  });

  it('AC9: dos confirmaciones simultáneas → solo una crea la solicitud; la otra recibe 409 incompleta_ya_resuelta', async () => {
    const p = await pendiente();
    ocrMock.mockResolvedValue({ vin: campo(p.vin) });
    const { adjuntarFactura, confirmarIncompleta } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    await adjuntarFactura(p.id, archivo(), ctx());
    await runtOk(p.vin);
    const res = await Promise.allSettled([
      confirmarIncompleta(p.id, { propietario: PROPIETARIO, procedencia: null }, ctx()),
      confirmarIncompleta(p.id, { propietario: PROPIETARIO, procedencia: null }, ctx()),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const rechazo = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rechazo.reason).toMatchObject({ status: 409, codigo: 'incompleta_ya_resuelta' });
    expect((await sql`SELECT 1 FROM flito_soat WHERE id = ${p.reservado}`).length).toBe(1);
    expect((await sql`SELECT 1 FROM flito_compradores WHERE soat_incompleta_id = ${p.id}`).length).toBe(1);
  });
});
