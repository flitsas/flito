// HU #14133 (Feature #14013, ADR-0032) — resumen del lote, descarga de rechazadas y purga de PII, contra Postgres REAL.
// Solo corre con TEST_DATABASE_URL (un `skipped` NO es verde). Fixtures con COMMIT, borrados en `afterEach`.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import ExcelJS from 'exceljs';

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
const SQL_0272 = readFileSync(path.resolve(__dirname, '../../src/db/migrations/0272_flito_soat_masivo_descarga_rechazadas.sql'), 'utf8');

describe('0272 — análisis estático', () => {
  it('idempotente: sin BEGIN/COMMIT y ADD COLUMN IF NOT EXISTS', () => {
    const limpio = SQL_0272.replace(/--[^\n]*/g, '');
    expect(limpio).not.toMatch(/\b(BEGIN|COMMIT)\b/);
    expect(limpio).toContain('ADD COLUMN IF NOT EXISTS primera_descarga_en');
  });
});

describe('AC3 — re-subir el archivo de rechazadas', () => {
  it('la columna «Motivo» se ignora al parsear', async () => {
    const { parsearXlsxRenovacion } = await import('../../src/modules/flito-soat/flito-soat-masivo-parse.js');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rechazadas');
    ws.addRow(['Placa', 'Documento', 'Nombre', 'Correo', 'Celular', 'Motivo']);
    ws.addRow(['ABC123', '1098765432', 'Maria Lopez', 'maria@ejemplo.com', '3101234567', 'Placa repetida en el archivo']);
    const { filas } = await parsearXlsxRenovacion(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(filas).toHaveLength(1);
    expect(filas[0]!.motivoRechazo).toBeNull();
    expect(filas[0]!.placa).toBe('ABC123');
  });
  it('un encabezado desconocido sigue rechazando el archivo', async () => {
    const { parsearXlsxRenovacion } = await import('../../src/modules/flito-soat/flito-soat-masivo-parse.js');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('x');
    ws.addRow(['Placa', 'Documento', 'Nombre', 'Correo', 'Celular', 'Otra']);
    ws.addRow(['ABC123', '1098765432', 'Maria Lopez', 'maria@ejemplo.com', '3101234567', 'x']);
    await expect(parsearXlsxRenovacion(Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toMatchObject({ codigo: 'encabezados_invalidos' });
  });
});

describe.skipIf(!URL_BASE)('resumen, descarga y purga contra Postgres real', () => {
  let sql: postgres.Sql;
  let companiaId: number;
  let otraCompaniaId: number;
  const lotes: string[] = [];
  let svc: typeof import('../../src/modules/flito-soat/flito-soat-masivo.service.js');
  let dsc: typeof import('../../src/modules/flito-soat/flito-soat-masivo-descarga.js');
  let purga: typeof import('../../src/modules/flito-soat/flito-soat-masivo-purga.js');
  let pii: typeof import('../../src/modules/flito-soat/flito-soat-masivo.pii.js');
  const ctxDe = (c: number) => ({ alcance: 'compania', companiaId: c, userId: 1, username: 'u' }) as never;
  const T0 = new Date('2026-10-28T10:00:00Z');
  const mas = (ms: number) => new Date(T0.getTime() + ms);

  beforeAll(async () => {
    sql = postgres(URL_BASE!, { max: 2, onnotice: () => {} });
    svc = await import('../../src/modules/flito-soat/flito-soat-masivo.service.js');
    dsc = await import('../../src/modules/flito-soat/flito-soat-masivo-descarga.js');
    purga = await import('../../src/modules/flito-soat/flito-soat-masivo-purga.js');
    pii = await import('../../src/modules/flito-soat/flito-soat-masivo.pii.js');
    const cs = await sql`SELECT id FROM clients WHERE id NOT IN (SELECT compania_id FROM flito_soat_masivo_lotes WHERE estado <> 'terminado') ORDER BY id LIMIT 2`;
    companiaId = cs[0]!.id; otraCompaniaId = cs[1]!.id;
  });
  afterEach(async () => { if (lotes.length) await sql`DELETE FROM flito_soat_masivo_lotes WHERE id IN ${sql(lotes)}`; lotes.length = 0; piiMock.mockClear(); });
  afterAll(async () => { await sql?.end(); });

  /** Lote TERMINADO con 2 rechazadas (una con fórmula en el nombre). */
  async function loteTerminado(o: { terminadoEn?: Date } = {}) {
    const terminado = true;
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes
      (compania_id, creado_por_nombre, tipo_soat, estado, total_filas, archivo_hash, terminado_en, n_aceptadas, n_por_validar, n_rechazadas)
      VALUES (${companiaId}, 'Ana', 'renovacion', 'terminado', 2, 'h',
        ${terminado ? (o.terminadoEn ?? T0) : null}, ${terminado ? 0 : null}, ${terminado ? 0 : null}, ${terminado ? 2 : null}) RETURNING id`;
    lotes.push(l!.id);
    await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, motivo_rechazo, placa, documento, nombre, correo, celular) VALUES
      (${l!.id}, 2, 'rechazada', 'runt_no_cuadra', 'ABC123', '1098765432', '=HYPERLINK("x")', 'a@ejemplo.com', '3101234567'),
      (${l!.id}, 3, 'rechazada', 'fila_duplicada', 'ABC123', '1098765432', 'Maria Lopez', 'm@ejemplo.com', '3109999999')`;
    return l!.id as string;
  }
  const leer = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as never); return wb.worksheets[0]!; };

  it('AC1: el resumen cuadra (creadas + por validar + rechazadas = total) y ofrece la descarga', async () => {
    const id = await loteTerminado({ terminadoEn: new Date() });
    const a = await svc.avanceLote(id, ctxDe(companiaId));
    expect(a!.resumen).toEqual({ total: 2, creadas: 0, porValidar: 0, rechazadas: 2 });
    expect(a!.resumen!.creadas + a!.resumen!.porValidar + a!.resumen!.rechazadas).toBe(a!.total);
    expect(a!.descargaRechazadas).toBe(true);
  });

  it('AC2: el .xlsx lleva las columnas de la plantilla + «Motivo», escapa fórmulas y registra el acceso PII una vez (ruta)', async () => {
    const id = await loteTerminado();
    const d = await dsc.descargarRechazadas(id, ctxDe(companiaId), mas(60_000));
    const ws = await leer(d!.buffer);
    expect(ws.getRow(1).values).toEqual([undefined, 'Placa', 'Documento', 'Nombre', 'Correo', 'Celular', 'Motivo']);
    expect(ws.rowCount).toBe(3);
    expect(String(ws.getRow(2).getCell(3).value)).toBe(`'=HYPERLINK("x")`);
    expect(String(ws.getRow(2).getCell(6).value)).toContain('No hay registro en el RUNT');
    expect(String(ws.getRow(3).getCell(6).value)).toBe('Placa repetida en el archivo');
    await pii.registrarDescargaRechazadasMasivo({} as never, { id, filas: d!.filas });
    expect(piiMock).toHaveBeenCalledTimes(1);
    const arg = piiMock.mock.calls[0]![1];
    expect(arg.accion).toBe('export');
    expect(JSON.stringify(arg)).not.toMatch(/ABC123|1098765432|Maria|ejemplo/);
  });

  it('AC4: lote sin terminar → 409 lote_en_proceso, no se ofrece la descarga y el avance sigue', async () => {
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, estado, total_filas, archivo_hash)
      VALUES (${companiaId}, 'Ana', 'renovacion', 'en_cola', 1, 'h') RETURNING id`;
    lotes.push(l!.id);
    await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, placa, documento) VALUES (${l!.id}, 2, 'pendiente', 'ABC123', '1098765432')`;
    await expect(dsc.descargarRechazadas(l!.id, ctxDe(companiaId))).rejects.toMatchObject({ status: 409, codigo: 'lote_en_proceso' });
    const a = await svc.avanceLote(l!.id, ctxDe(companiaId));
    expect(a!.descargaRechazadas).toBe(false);
    expect(a!.resumen).toBeNull();
    expect(a!.pendientes).toBe(1);
  });

  it('AC5: descarga repetible dentro de 15 min de la primera; luego 410 y la PII queda borrada (motivos y conteos intactos)', async () => {
    const id = await loteTerminado();
    await dsc.descargarRechazadas(id, ctxDe(companiaId), mas(60_000));
    await dsc.descargarRechazadas(id, ctxDe(companiaId), mas(10 * 60_000)); // repetible
    await expect(dsc.descargarRechazadas(id, ctxDe(companiaId), mas(60_000 + 15 * 60_000))).rejects.toMatchObject({ status: 410 });
    const filas = await sql`SELECT placa, documento, nombre, correo, celular, vin, motivo_rechazo FROM flito_soat_masivo_filas WHERE lote_id = ${id}`;
    for (const f of filas) { expect([f.placa, f.documento, f.nombre, f.correo, f.celular, f.vin]).toEqual([null, null, null, null, null, null]); }
    expect(filas.map((f) => f.motivo_rechazo).sort()).toEqual(['fila_duplicada', 'runt_no_cuadra']);
    const a = await svc.avanceLote(id, ctxDe(companiaId));
    expect(a!.rechazadas).toBe(2);
    expect(a!.motivosRechazo).toHaveLength(2);
  });

  it('AC5: a las 24 h sin descargar el mantenimiento purga; antes no', async () => {
    const id = await loteTerminado();
    expect(await purga.purgarPiiRechazadas(mas(23 * 3600_000), id)).toBe(0);
    expect(await purga.purgarPiiRechazadas(mas(24 * 3600_000), id)).toBe(2);
    expect(await purga.purgarPiiRechazadas(mas(25 * 3600_000), id)).toBe(0); // idempotente
    await expect(dsc.descargarRechazadas(id, ctxDe(companiaId), mas(25 * 3600_000))).rejects.toMatchObject({ status: 410 });
  });

  it('AC5: no se purga un lote sin terminar ni las filas que no son rechazadas', async () => {
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, estado, total_filas, archivo_hash, creado_en)
      VALUES (${companiaId}, 'Ana', 'renovacion', 'en_cola', 1, 'h', now() - interval '3 days') RETURNING id`;
    lotes.push(l!.id);
    await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, motivo_rechazo, placa, documento) VALUES (${l!.id}, 2, 'rechazada', 'placa_invalida', 'XX', '1')`;
    expect(await purga.purgarPiiRechazadas(mas(48 * 3600_000), l!.id)).toBe(0);
  });

  it('AC6: un lote de otra compañía responde null (404) en resumen y descarga', async () => {
    const id = await loteTerminado();
    expect(await svc.avanceLote(id, ctxDe(otraCompaniaId))).toBeNull();
    expect(await dsc.descargarRechazadas(id, ctxDe(otraCompaniaId))).toBeNull();
    expect(await dsc.descargarRechazadas(id, { alcance: 'proveedor', companiaId: null } as never)).toBeNull();
  });
});
