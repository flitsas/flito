// HU #14135 (Feature #14014) — lo que solo Postgres real confirma de la carga masiva INICIAL: el reclamo trae el
// tipo y el VIN, la pendiente nace en `flito_soat_incompletas` cumpliendo los CHECK de 0269 (inicial sin factura
// solo con «Falta factura de venta»; Renovación con la placa del RUNT), fila y pendiente en una transacción, el
// resumen distingue factura de propietario, la descarga trae VIN + «Motivo» y la PII se anonimiza al terminar.
// Solo corre con TEST_DATABASE_URL (sin SQL nuevo: 0270/0271 ya admiten tipo inicial, vin y los motivos usados).

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import ExcelJS from 'exceljs';

const URL_BASE = process.env.TEST_DATABASE_URL;
vi.mock('../../src/db/client.js', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: {}, getPoolStats: () => ({}) };
  const schema = await import('../../src/db/schema.js');
  return { db: drizzle(postgres(url, { max: 8, onnotice: () => {} }), { schema }), getPoolStats: () => ({}) };
});

describe.skipIf(!URL_BASE)('carga masiva Inicial contra Postgres real', () => {
  let sql: postgres.Sql;
  let companiaId: number;
  let rec: typeof import('../../src/modules/flito-soat/flito-soat-masivo-reclamo.js');
  let ini: typeof import('../../src/modules/flito-soat/flito-soat-masivo-inicial.js');
  let svc: typeof import('../../src/modules/flito-soat/flito-soat-masivo.service.js');
  let desc: typeof import('../../src/modules/flito-soat/flito-soat-masivo-descarga.js');
  const lotes: string[] = [];
  const vins: string[] = [];
  const ctx = { userId: 1, username: 'prueba', alcance: 'todo' } as never;

  beforeAll(async () => {
    sql = postgres(URL_BASE!, { max: 2, onnotice: () => {} });
    rec = await import('../../src/modules/flito-soat/flito-soat-masivo-reclamo.js');
    ini = await import('../../src/modules/flito-soat/flito-soat-masivo-inicial.js');
    svc = await import('../../src/modules/flito-soat/flito-soat-masivo.service.js');
    desc = await import('../../src/modules/flito-soat/flito-soat-masivo-descarga.js');
    const [c] = await sql`SELECT id FROM clients WHERE id NOT IN (SELECT compania_id FROM flito_soat_masivo_lotes WHERE estado <> 'terminado') ORDER BY id LIMIT 1`;
    companiaId = c!.id;
  });
  afterEach(async () => {
    if (lotes.length) await sql`DELETE FROM flito_soat_masivo_lotes WHERE id IN ${sql(lotes)}`;
    if (vins.length) await sql`DELETE FROM flito_soat_incompletas WHERE vin IN ${sql(vins)}`;
    lotes.length = 0; vins.length = 0;
  });
  afterAll(async () => { await sql?.end(); });

  async function loteInicial(filas: Array<{ vin: string; estado?: string; motivo?: string }>) {
    const [l] = await sql`INSERT INTO flito_soat_masivo_lotes (compania_id, creado_por_nombre, tipo_soat, total_filas, archivo_hash)
      VALUES (${companiaId}, 'prueba', 'inicial', ${filas.length}, 'h') RETURNING id`;
    lotes.push(l!.id);
    let n = 2;
    for (const f of filas) {
      await sql`INSERT INTO flito_soat_masivo_filas (lote_id, n_fila, estado, motivo_rechazo, vin) VALUES (${l!.id}, ${n++}, ${f.estado ?? 'pendiente'}, ${f.motivo ?? null}, ${f.vin})`;
    }
    return l!.id as string;
  }

  it('el reclamo trae el tipo del lote y el VIN; la pendiente de factura y la de propietario se guardan y el resumen las distingue', async () => {
    const v1 = 'ZZZTEST0000000001'; const v2 = 'ZZZTEST0000000002';
    vins.push(v1, v2);
    const id = await loteInicial([{ vin: v1 }, { vin: v2 }]);
    const filas = await rec.reclamarFilas(2);
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.tipoSoat === 'inicial' && !!f.vin)).toBe(true);
    const canal = { companiaId } as never;
    const [fa, fb] = filas as [typeof filas[0], typeof filas[0]];
    const ra = await ini.aparcarFilaInicial({ fila: fa, canal, ctx, vin: fa.vin as string,
      decision: { tipo: 'pendiente', motivoPendiente: 'falta_factura_venta', tipoSoat: 'inicial', placa: null, vinRunt: null } });
    const rb = await ini.aparcarFilaInicial({ fila: fb, canal, ctx, vin: fb.vin as string,
      decision: { tipo: 'pendiente', motivoPendiente: 'faltan_datos_propietario', tipoSoat: 'renovacion', placa: 'ZZT123', vinRunt: null } });
    expect([ra, rb]).toEqual(['aparcada', 'aparcada']);
    const pend = await sql`SELECT vin, tipo_soat, modalidad_consulta, placa, motivo_pendiente, estado FROM flito_soat_incompletas WHERE vin IN ${sql([v1, v2])} ORDER BY vin`;
    expect(pend.map((p) => [p.tipo_soat, p.modalidad_consulta, p.placa, p.motivo_pendiente, p.estado])).toEqual([
      ['inicial', 'vin', null, 'falta_factura_venta', 'incompleta'],
      ['renovacion', 'placa', 'ZZT123', 'faltan_datos_propietario', 'incompleta'],
    ]);
    // Lote terminado: el avance distingue las pendientes por motivo y la PII (VIN) se anonimiza.
    expect(await rec.cerrarLoteSiTermino(id)).toBe(true);
    const av = await svc.avanceLote(id, ctx);
    expect(av?.tipo).toBe('inicial');
    expect(av?.resumen).toMatchObject({ total: 2, porValidar: 2, porValidarFactura: 1, porValidarPropietario: 1 });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM flito_soat_masivo_filas WHERE lote_id = ${id} AND vin IS NOT NULL`;
    expect(n).toBe(0);
  });

  it('una pendiente abierta del mismo VIN: el índice único salta y la fila queda sin tocar (otra va a «ocupada»)', async () => {
    const v = 'ZZZTEST0000000003'; vins.push(v);
    await loteInicial([{ vin: v }, { vin: 'ZZZTEST0000000004' }]);
    const filas = await rec.reclamarFilas(2);
    const canal = { companiaId } as never;
    const dec = { tipo: 'pendiente', motivoPendiente: 'falta_factura_venta', tipoSoat: 'inicial', placa: null, vinRunt: null } as const;
    const a = filas.find((f) => f.vin === v)!;
    expect(await ini.aparcarFilaInicial({ fila: a, canal, ctx, vin: v, decision: dec })).toBe('aparcada');
    // Segunda fila con el mismo VIN abierto (carrera simulada: se fuerza el VIN de la otra fila).
    const b = filas.find((f) => f.vin !== v)!;
    expect(await ini.aparcarFilaInicial({ fila: b, canal, ctx, vin: v, decision: dec })).toBe('ocupada');
    const [{ estado }] = await sql`SELECT estado FROM flito_soat_masivo_filas WHERE id = ${b.id}`;
    expect(estado).toBe('consultando');
  });

  it('AC3: la descarga de un lote Inicial trae la columna VIN y «Motivo» final, con el texto del motivo', async () => {
    const id = await loteInicial([
      { vin: 'ABC', estado: 'rechazada', motivo: 'vin_invalido' },
      { vin: 'ZZZTEST0000000005', estado: 'rechazada', motivo: 'fila_duplicada' },
      { vin: '=CMD|x', estado: 'rechazada', motivo: 'vin_invalido' },
    ]);
    await rec.cerrarLoteSiTermino(id);
    const d = await desc.descargarRechazadas(id, ctx);
    expect(d?.tipo).toBe('inicial');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(d!.buffer as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).values).toEqual([undefined, 'VIN', 'Motivo']);
    expect(ws.getRow(3).values).toEqual([undefined, 'ZZZTEST0000000005', 'VIN repetido en el archivo']);
    expect(String(ws.getRow(4).getCell(1).value)).toBe("'=CMD|x");
    expect(desc.nombreArchivoRechazadas('inicial')).toBe('rechazadas-soat-inicial.xlsx');
  });
});
