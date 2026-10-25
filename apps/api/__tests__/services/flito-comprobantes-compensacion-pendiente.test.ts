// HU #13938 (Feature #13886) — cuando el dueño (SOAT o derecho) rechaza el pago DESPUÉS del commit del
// comprobante, `pagarDespuesDelCommit` lo devuelve a `pendiente` con `motivo_pendiente = destino_no_admite`
// y un `detalle_pendiente` con lo que dijo el dueño. Contra PostgreSQL de verdad: el CHECK
// `flito_comprobantes_pendiente_chk` (0198) exige motivo en `pendiente`, y los tests con mocks
// (`flito-comprobantes.aplicar.test.ts`) no lo ven. Sin la corrección la tx de compensación revienta con
// 23514 y el comprobante queda `aplicado` sin pago en el dueño y con la bolsa descontada.
//
// El rechazo es REAL: el SOAT está `pendiente` (no `solicitado`), así que `aplicarFacturaSoat` responde
// 400 antes de escribir; en el derecho, otro registro ganó la carrera entre la guarda y la tx del dueño
// (el trámite ya tiene derecho) y `registrarDesdeRevision` responde 400.
//
// Se activa con `TEST_DATABASE_URL`; sin ella se SALTA (el CI no levanta Postgres). Un `skipped` NO es verde.
// Cada caso crea su compañía, bolsa, trámite, SOAT, soporte y comprobante; todo se borra en `afterAll`.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const URL = process.env.TEST_DATABASE_URL;
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const CORTE = '2026-12-01';
/** 03-dic-2026 10:00 COT. */
const DIC_3 = new Date('2026-12-03T15:00:00Z');
const VALOR = 450_000;

describe.skipIf(!URL)('HU #13938 — compensación tras el rechazo del dueño deja el comprobante pendiente con motivo (PostgreSQL real)', () => {
  let sql: import('postgres').Sql;
  let db: typeof import('../../src/db/client.js').db;
  let corte: import('../helpers/corte-bolsas.js').CorteDePrueba;
  let d: typeof import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
  let ap: typeof import('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js');
  let ComprobanteError: typeof import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js').ComprobanteError;
  let USER: number;
  let n = 0;
  const creados = { clients: [] as number[], vehicles: [] as number[], tramites: [] as string[], soats: [] as string[], soportes: [] as string[], comprobantes: [] as string[] };

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL!, { max: 2 });
    ({ db } = await import('../../src/db/client.js'));
    corte = (await import('../helpers/corte-bolsas.js')).corteDePrueba(sql);
    d = await import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
    ap = await import('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js');
    ({ ComprobanteError } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.service.js'));
    const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`;
    USER = u!.id as number;
  });

  afterAll(async () => {
    if (!sql) return;
    await corte.restaurar();
    const ids = creados.clients.length ? creados.clients : [-1];
    const nada = ['00000000-0000-0000-0000-000000000000'];
    const bolsas = sql`SELECT id FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE revierte_movimiento_id IS NOT NULL AND bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_conceptos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id IN ${sql(ids)}`;
    const tr = creados.tramites.length ? creados.tramites : nada;
    await sql`DELETE FROM flito_comprobantes WHERE id IN ${sql(creados.comprobantes.length ? creados.comprobantes : nada)}`;
    await sql`DELETE FROM flito_derechos_tramite WHERE tramite_id IN ${sql(tr)}`;
    if (creados.soportes.length) await sql`DELETE FROM flito_soportes WHERE id IN ${sql(creados.soportes)}`;
    await sql`UPDATE flito_tramites SET soat_id = NULL WHERE id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_tramites WHERE id IN ${sql(tr)}`;
    if (creados.soats.length) await sql`DELETE FROM audit_logs WHERE resource = 'flito_soat' AND resource_id::text IN ${sql(creados.soats)}`;
    if (creados.soats.length) await sql`DELETE FROM flito_soat WHERE id IN ${sql(creados.soats)}`;
    if (creados.vehicles.length) await sql`DELETE FROM vehicles WHERE id IN ${sql(creados.vehicles)}`;
    await sql`DELETE FROM clients WHERE id IN ${sql(ids)}`;
    await sql.end();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: DIC_3 });
    await corte.fijar(CORTE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ─────────────────────────── Fixtures ───────────────────────────

  /** Compañía con bolsa 1.000.000, trámite, SOAT `pendiente` (no admite pago) y un comprobante `aplicado` como pago y ya descontado. */
  async function aplicadoYDescontado(concepto: 'soat' | 'derecho') {
    n += 1;
    const sello = `${Math.floor(Math.random() * 1e9)}${n}`;
    const [c] = await sql`INSERT INTO clients (name, document) VALUES (${`HU13938 ${sello}`}, ${`8${sello}`.slice(0, 20)}) RETURNING id`;
    const companiaId = c!.id as number;
    creados.clients.push(companiaId);
    const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, compania_id, saldo, activa)
      VALUES ('compania', ${companiaId}, '1000000', true) RETURNING id`;
    const bolsaId = b!.id as string;
    await sql`INSERT INTO flito_bolsas_unicas_conceptos (bolsa_id, concepto) VALUES (${bolsaId}, ${concepto})`;
    const [v] = await sql`INSERT INTO vehicles DEFAULT VALUES RETURNING id`;
    creados.vehicles.push(v!.id as number);
    const [t] = await sql`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id)
      VALUES (${`HU13938-${sello}`}, ${v!.id}, now(), ${companiaId}) RETURNING id`;
    const tramiteId = t!.id as string;
    creados.tramites.push(tramiteId);
    const [s] = await sql`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, origen)
      VALUES (${`X${sello}`.slice(0, 17)}, ${v!.id}, ${companiaId}, 'cliente') RETURNING id`;
    const soatId = s!.id as string;
    creados.soats.push(soatId);
    await sql`UPDATE flito_tramites SET soat_id = ${soatId} WHERE id = ${tramiteId}`;
    const [so] = await sql`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
      VALUES ('comprobante_pago', 'c.pdf', 'application/pdf', ${`hu13938/${sello}.pdf`}, ${`h13938${Math.random()}${n}`.slice(0, 64)}, 10, 'test') RETURNING id`;
    const soporteId = so!.id as string;
    creados.soportes.push(soporteId);
    const [k] = await sql`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre,
        estado, tramite_id, concepto, es_pago, valor, soporte_aplicado_id, aplicado_en, aplicado_por_id, aplicado_motivo)
      VALUES (gen_random_uuid(), ${soporteId}, '{}'::jsonb, ${USER}, 'test', 'aplicado', ${tramiteId}, ${concepto}, true,
        ${String(VALOR)}, ${soporteId}, now(), ${USER}, 'cruce manual de prueba') RETURNING id`;
    const id = k!.id as string;
    creados.comprobantes.push(id);
    await db.transaction((tx) => d.descontarComprobante(tx,
      { comprobanteId: id, tramiteId, concepto: concepto as never, esPago: true, valor: String(VALOR), aplicadoEn: DIC_3 },
      { userId: USER, nombre: 'hu13938@flit.io' }));
    const args = {
      tramiteId, soporteAplicadoId: soporteId, extraccionDestino: {}, motivo: null, fechaPago: null,
      ctx: { userId: USER, username: 'hu13938@flit.io', role: 'financiera' },
    };
    return { id, bolsaId, tramiteId, soatId, soporteId, args };
  }

  const fila = async (id: string) => (await sql`SELECT estado, motivo_pendiente, detalle_pendiente, es_pago, valor,
    soporte_aplicado_id, aplicado_en, aplicado_por_id, aplicado_motivo FROM flito_comprobantes WHERE id = ${id}`)[0]!;
  const saldo = async (bolsaId: string) => Number((await sql`SELECT saldo FROM flito_bolsas_unicas WHERE id = ${bolsaId}`)[0]!.saldo);
  const movimientos = (bolsaId: string) => sql`SELECT * FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${bolsaId} ORDER BY created_at, tipo DESC, id`;

  async function rechazo(p: Promise<void>) {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(ComprobanteError);
    expect(e).toMatchObject({ status: 409, codigo: 'destino_no_admite' });
    return e as InstanceType<typeof ComprobanteError>;
  }

  /** AC1 + AC2: pendiente con motivo y detalle, soporte liberado, descuento revertido como compensación. */
  async function compensado(e: Awaited<ReturnType<typeof aplicadoYDescontado>>, mensajeDueno: RegExp) {
    const f = await fila(e.id);
    expect(f).toMatchObject({
      estado: 'pendiente', motivo_pendiente: 'destino_no_admite', es_pago: null, valor: null,
      soporte_aplicado_id: null, aplicado_en: null, aplicado_por_id: null, aplicado_motivo: null,
    });
    expect(f.detalle_pendiente).toMatch(/rechazó el pago tras aplicar/);
    expect(f.detalle_pendiente).toMatch(mensajeDueno);
    expect(await saldo(e.bolsaId)).toBe(1_000_000);
    const movs = await movimientos(e.bolsaId);
    expect(movs).toHaveLength(2);
    const salida = movs.find((m) => m.tipo === 'salida')!;
    const entrada = movs.find((m) => m.tipo === 'entrada')!;
    expect(entrada).toMatchObject({ origen: 'comprobante', comprobante_id: e.id, revierte_movimiento_id: salida.id });
    expect(Number(entrada.valor)).toBe(VALOR);
  }

  it('AC1/AC2 · SOAT no solicitado: aplicarFacturaSoat rechaza → pendiente + destino_no_admite + detalle del dueño; bolsa revertida; soporte liberado', async () => {
    const e = await aplicadoYDescontado('soat');
    expect(await saldo(e.bolsaId)).toBe(1_000_000 - VALOR);
    const destino = { concepto: 'soat' as never, fk: { soatId: e.soatId }, tipoSoporte: 'factura_soat', candidato: null };

    const err = await rechazo(ap.pagarDespuesDelCommit(e.id, destino, e.args));

    expect(err.extra).toMatchObject({ detalle: 'Solo se puede conciliar un documento contra un SOAT en adquisición', puedeAdjuntar: false });
    await compensado(e, /El dueño \(soat\).*Solo se puede conciliar un documento contra un SOAT en adquisición/);
    // El dueño rechazó antes de escribir: el SOAT sigue igual.
    expect((await sql`SELECT estado FROM flito_soat WHERE id = ${e.soatId}`)[0]!.estado).toBe('pendiente');
  });

  it('AC1/AC2 · derecho registrado por otro entre la guarda y el dueño: registrarDesdeRevision rechaza → pendiente + destino_no_admite + detalle del dueño; bolsa revertida', async () => {
    const e = await aplicadoYDescontado('derecho');
    await sql`INSERT INTO flito_derechos_tramite (tramite_id, origen) VALUES (${e.tramiteId}, 'manual')`;
    const destino = { concepto: 'derecho' as never, fk: {}, tipoSoporte: 'derecho_tramite', candidato: null };

    const err = await rechazo(ap.pagarDespuesDelCommit(e.id, destino, e.args));

    expect(err.extra).toMatchObject({ detalle: 'Ese trámite ya tiene registrado su derecho de tránsito', puedeAdjuntar: false });
    await compensado(e, /El dueño \(derecho\).*Ese trámite ya tiene registrado su derecho de tránsito/);
    expect((await sql`SELECT count(*)::int AS n FROM flito_derechos_tramite WHERE tramite_id = ${e.tramiteId}`)[0]!.n).toBe(1);
  });

  it('AC2 · reintento: si el comprobante ya no está aplicado (otra compensación ganó), no toca la fila ni la bolsa dos veces', async () => {
    const e = await aplicadoYDescontado('soat');
    const destino = { concepto: 'soat' as never, fk: { soatId: e.soatId }, tipoSoporte: 'factura_soat', candidato: null };
    await rechazo(ap.pagarDespuesDelCommit(e.id, destino, e.args));
    await rechazo(ap.pagarDespuesDelCommit(e.id, destino, e.args));
    await compensado(e, /Solo se puede conciliar/);
  });
});
