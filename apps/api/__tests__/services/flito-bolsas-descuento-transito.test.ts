// HU #13909 (Feature #13887, ADR-0029 D7-D11, D13-D14) — el comprobante aplicado mueve HASTA DOS bolsas:
// la de la compañía y la de tránsito que cubre (secretaría del registro dueño, concepto). Contra PostgreSQL
// de verdad: llaves de ADR-0006 compartidas con la conciliación, reversión enlazada en las dos bolsas al
// desaplicar/reemplazar/compensar, periodo cerrado en tránsito que bloquea todo (todo o nada) y
// concurrencia real (dos aplicaciones y una conciliación a la vez, sin deadlock).
//
// Se activa con `TEST_DATABASE_URL`; sin ella se SALTA (el CI no levanta Postgres). Un `skipped` NO es verde.
// Cada caso crea su compañía, sus bolsas (compañía y tránsito, con una secretaría libre de cobertura en la
// BD), su trámite y sus comprobantes; todo se borra en `afterAll`. Reloj fijo: el corte (2026-12-01) aún
// no ha llegado y el libro rechaza fechas futuras.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
// `sql` de drizzle para `tx.execute` (el `sql` del fixture es el cliente postgres-js).
import { sql as sqlTag } from 'drizzle-orm';

const URL = process.env.TEST_DATABASE_URL;
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const CORTE = '2026-12-01';
/** 03-dic-2026 10:00 COT. */
const DIC_3 = new Date('2026-12-03T15:00:00Z');
/** 05-ene-2027 10:00 COT: diciembre ya terminó y se puede cerrar. */
const ENE_5 = new Date('2027-01-05T15:00:00Z');
const MOTIVO = 'Se aplicó al trámite equivocado';
const NADA = '00000000-0000-0000-0000-000000000000';

describe.skipIf(!URL)('HU #13909 — doble movimiento compañía + tránsito (PostgreSQL real)', () => {
  let sql: import('postgres').Sql;
  let db: typeof import('../../src/db/client.js').db;
  let env: typeof import('../../src/config/env.js').env;
  let d: typeof import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
  let libro: typeof import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
  let transito: typeof import('../../src/modules/flito-bolsas/flito-bolsas-transito.service.js');
  let comp: typeof import('../../src/modules/flito-comprobantes/flito-comprobantes.desaplicar.js');
  let ap: typeof import('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js');
  let USER: number;
  let ctx: { userId: number; nombre: string };
  let cctx: { userId: number; username: string; role: string };
  let n = 0;
  /** Secretarías sin ninguna cobertura en la BD: cada escenario toma una (la cobertura activa es única por par). */
  let libres: string[] = [];
  const creados = {
    clients: [] as number[], vehicles: [] as number[], tramites: [] as string[], soats: [] as string[],
    soportes: [] as string[], transito: [] as string[],
  };

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL!, { max: 2 });
    ({ db } = await import('../../src/db/client.js'));
    ({ env } = await import('../../src/config/env.js'));
    d = await import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
    libro = await import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
    transito = await import('../../src/modules/flito-bolsas/flito-bolsas-transito.service.js');
    comp = await import('../../src/modules/flito-comprobantes/flito-comprobantes.desaplicar.js');
    ap = await import('../../src/modules/flito-comprobantes/flito-comprobantes.aplicar.js');
    const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`;
    USER = u!.id as number;
    ctx = { userId: USER, nombre: 'hu13909@flit.io' };
    cctx = { userId: USER, username: 'hu13909@flit.io', role: 'financiera' };
    libres = (await sql`SELECT codigo FROM organismos_transito_config o
      WHERE NOT EXISTS (SELECT 1 FROM flito_bolsas_unicas_cobertura c WHERE c.organismo_codigo = o.codigo)
      ORDER BY codigo DESC LIMIT 40`).map((f) => f.codigo as string);
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = creados.clients.length ? creados.clients : [-1];
    const tb = creados.transito.length ? creados.transito : [NADA];
    const bolsas = sql`SELECT id FROM flito_bolsas_unicas WHERE (alcance = 'compania' AND compania_id IN ${sql(ids)}) OR id IN ${sql(tb)}`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE revierte_movimiento_id IS NOT NULL AND bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_cierres WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_conceptos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_cobertura WHERE bolsa_id IN ${sql(tb)}`;
    await sql`DELETE FROM flito_bolsas_unicas WHERE (alcance = 'compania' AND compania_id IN ${sql(ids)}) OR id IN ${sql(tb)}`;
    const tr = creados.tramites.length ? creados.tramites : [NADA];
    const imps = sql`SELECT id::text FROM flito_impuestos WHERE tramite_id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_estado_historial WHERE registro_id::text IN (${imps})`;
    await sql`DELETE FROM audit_logs WHERE resource = 'flito_impuesto' AND resource_id::text IN (${imps})`;
    await sql`DELETE FROM flito_comprobantes WHERE tramite_id IN ${sql(tr)} OR soporte_id IN ${sql(creados.soportes.length ? creados.soportes : [NADA])}`;
    if (creados.soportes.length) await sql`DELETE FROM flito_soportes WHERE id IN ${sql(creados.soportes)}`;
    await sql`DELETE FROM flito_impuestos WHERE tramite_id IN ${sql(tr)}`;
    await sql`UPDATE flito_tramites SET soat_id = NULL WHERE id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_tramites WHERE id IN ${sql(tr)}`;
    if (creados.soats.length) await sql`DELETE FROM audit_logs WHERE resource = 'flito_soat' AND resource_id::text IN ${sql(creados.soats)}`;
    if (creados.soats.length) await sql`DELETE FROM flito_soat WHERE id IN ${sql(creados.soats)}`;
    if (creados.vehicles.length) await sql`DELETE FROM vehicles WHERE id IN ${sql(creados.vehicles)}`;
    await sql`DELETE FROM clients WHERE id IN ${sql(ids)}`;
    await sql.end();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: DIC_3 });
    env.FLITO_BOLSAS_CORTE_COMPROBANTES = CORTE;
  });
  afterEach(() => {
    vi.useRealTimers();
    env.FLITO_BOLSAS_CORTE_COMPROBANTES = undefined;
  });

  // ─────────────────────────── Fixtures ───────────────────────────

  interface Compania { companiaId: number; bolsaId: string | null }

  async function compania(o: { sinBolsa?: boolean } = {}): Promise<Compania> {
    n += 1;
    const sello = `${Math.floor(Math.random() * 1e9)}${n}`;
    // 0252 dejó `*_autogestionable` en true por defecto: estas compañías NO autogestionan.
    const [c] = await sql`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
      VALUES (${`HU13909 ${sello}`}, ${`6${sello}`.slice(0, 20)}, false, false, false) RETURNING id`;
    const companiaId = c!.id as number;
    creados.clients.push(companiaId);
    if (o.sinBolsa) return { companiaId, bolsaId: null };
    const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, compania_id, saldo, activa)
      VALUES ('compania', ${companiaId}, '1000000', true) RETURNING id`;
    for (const concepto of ['soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'servicios_adicionales']) {
      await sql`INSERT INTO flito_bolsas_unicas_conceptos (bolsa_id, concepto) VALUES (${b!.id}, ${concepto})`;
    }
    return { companiaId, bolsaId: b!.id as string };
  }

  /** Bolsa de tránsito activa que cubre (organismo, conceptos). */
  async function bolsaTransito(organismo: string, conceptos: string[], saldo = 5_000_000): Promise<{ id: string; nombre: string }> {
    n += 1;
    const nombre = `Tránsito HU13909 ${n}`;
    const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, nombre, saldo, activa)
      VALUES ('transito', ${nombre}, ${String(saldo)}, true) RETURNING id`;
    const id = b!.id as string;
    creados.transito.push(id);
    for (const concepto of conceptos) {
      await sql`INSERT INTO flito_bolsas_unicas_cobertura (bolsa_id, organismo_codigo, concepto, activa) VALUES (${id}, ${organismo}, ${concepto}, true)`;
    }
    return { id, nombre };
  }

  function secretaria(): string {
    const s = libres.shift();
    if (!s) throw new Error('No quedan secretarías sin cobertura en la BD de pruebas');
    return s;
  }

  interface Tramite { tramiteId: string; soatId: string | null; vehiculoId: number }

  /** Trámite con su registro dueño: impuesto (pagado) y/o SOAT (`pendiente`: el dueño rechaza un pago tras el commit). */
  async function tramite(companiaId: number, o: { impuesto?: string; soat?: { organismo: string | null } } = {}): Promise<Tramite> {
    n += 1;
    const sello = `${Math.floor(Math.random() * 1e9)}${n}`;
    const [v] = await sql`INSERT INTO vehicles DEFAULT VALUES RETURNING id`;
    const vehiculoId = v!.id as number;
    creados.vehicles.push(vehiculoId);
    const [t] = await sql`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id)
      VALUES (${`HU13909-${sello}`}, ${vehiculoId}, now(), ${companiaId}) RETURNING id`;
    const tramiteId = t!.id as string;
    creados.tramites.push(tramiteId);
    if (o.impuesto) {
      await sql`INSERT INTO flito_impuestos (tramite_id, organismo_codigo, compania_id, modalidad_aplicada, estado)
        VALUES (${tramiteId}, ${o.impuesto}, ${companiaId}, 'requiere_gestion', 'pagado')`;
    }
    let soatId: string | null = null;
    if (o.soat) {
      const [s] = await sql`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, origen, organismo_codigo)
        VALUES (${`T${sello}`.slice(0, 17)}, ${vehiculoId}, ${companiaId}, 'cliente', ${o.soat.organismo}) RETURNING id`;
      soatId = s!.id as string;
      creados.soats.push(soatId);
      await sql`UPDATE flito_tramites SET soat_id = ${soatId} WHERE id = ${tramiteId}`;
    }
    return { tramiteId, soatId, vehiculoId };
  }

  async function comprobante(tramiteId: string, concepto: string, valor: number): Promise<{ id: string; soporteId: string }> {
    n += 1;
    const [s] = await sql`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
      VALUES ('comprobante_pago', 'c.pdf', 'application/pdf', ${`hu13909/${n}.pdf`}, ${`h13909${Math.random()}${n}`.slice(0, 64)}, 10, 'test') RETURNING id`;
    const soporteId = s!.id as string;
    creados.soportes.push(soporteId);
    const [c] = await sql`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre,
        estado, tramite_id, concepto, es_pago, valor, soporte_aplicado_id, aplicado_en, aplicado_por_id, aplicado_motivo)
      VALUES (gen_random_uuid(), ${soporteId}, '{}'::jsonb, ${USER}, 'test', 'aplicado', ${tramiteId}, ${concepto}, true,
        ${String(valor)}, ${soporteId}, now(), ${USER}, 'cruce manual de prueba') RETURNING id`;
    return { id: c!.id as string, soporteId };
  }

  async function pendiente(): Promise<string> {
    n += 1;
    const [s] = await sql`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
      VALUES ('comprobante_pago', 'c.pdf', 'application/pdf', ${`hu13909/p${n}.pdf`}, ${`p13909${Math.random()}${n}`.slice(0, 64)}, 10, 'test') RETURNING id`;
    creados.soportes.push(s!.id as string);
    const [c] = await sql`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre, estado, motivo_pendiente)
      VALUES (gen_random_uuid(), ${s!.id}, '{}'::jsonb, ${USER}, 'test', 'pendiente', 'leido') RETURNING id`;
    return c!.id as string;
  }

  const pago = (comprobanteId: string, tramiteId: string, concepto: string, valor: number) =>
    ({ comprobanteId, tramiteId, concepto: concepto as never, esPago: true, valor: String(valor), aplicadoEn: DIC_3 });
  const descontar = (c: ReturnType<typeof pago>) => db.transaction((tx) => d.descontarComprobante(tx, c, ctx));
  const movimientos = (bolsaId: string) => sql`SELECT *, fecha::text AS fecha FROM flito_bolsas_unicas_movimientos
    WHERE bolsa_id = ${bolsaId} ORDER BY created_at, tipo DESC, id`;
  const saldo = async (bolsaId: string) => Number((await sql`SELECT saldo FROM flito_bolsas_unicas WHERE id = ${bolsaId}`)[0]!.saldo);
  const cerrar = (bolsaId: string, periodo: string) => sql`INSERT INTO flito_bolsas_unicas_cierres
      (bolsa_id, periodo, saldo_inicial, total_entradas, total_salidas, saldo_final, movimientos, cerrado_por_nombre)
    VALUES (${bolsaId}, ${periodo}, 0, 0, 0, 0, 0, 'hu13909')`;
  const estado = async (id: string) => (await sql`SELECT estado, tramite_id FROM flito_comprobantes WHERE id = ${id}`)[0]!;
  const transitoDe = (r: Awaited<ReturnType<typeof d.descontarComprobante>>) => ({
    movimientos: r!.movimientos.filter((m) => m.alcance === 'transito'),
    omitidos: r!.omitidos.filter((m) => m.alcance === 'transito'),
    alertas: r!.alertas.filter((m) => m.alcance === 'transito'),
  });

  /** Compañía con bolsa + tránsito que cubre (secretaría del impuesto, impuesto) + impuesto aplicado y descontado. */
  async function impuestoDescontado(valor: number) {
    const c = await compania();
    const org = secretaria();
    const bt = await bolsaTransito(org, ['impuesto']);
    const t = await tramite(c.companiaId, { impuesto: org });
    const k = await comprobante(t.tramiteId, 'impuesto', valor);
    const r = await descontar(pago(k.id, t.tramiteId, 'impuesto', valor));
    return { c, org, bt, t, k, r };
  }

  // ─────────────────────────── AC1 ───────────────────────────

  describe('AC1 — compañía y tránsito cubren: dos salidas del mismo valor', () => {
    it('AC1 · impuesto 300.000 → salida 300.000 en compañía y en tránsito; la de tránsito con llave consumo:comprobante:<id> y la secretaría', async () => {
      const { c, org, bt, t, k, r } = await impuestoDescontado(300_000);

      const [mc, ...restoC] = await movimientos(c.bolsaId!);
      const [mt, ...restoT] = await movimientos(bt.id);
      expect(restoC).toHaveLength(0);
      expect(restoT).toHaveLength(0);
      expect(mc).toMatchObject({ tipo: 'salida', origen: 'comprobante', comprobante_id: k.id, llave_idempotencia: `salida:comprobante:${k.id}` });
      expect(mt).toMatchObject({
        tipo: 'salida', origen: 'comprobante', concepto: 'impuesto', organismo_codigo: org, comprobante_id: k.id,
        tramite_id: t.tramiteId, llave_idempotencia: `consumo:comprobante:${k.id}`, periodo: '2026-12',
      });
      expect(Number(mc!.valor)).toBe(300_000);
      expect(Number(mt!.valor)).toBe(300_000);
      expect(await saldo(c.bolsaId!)).toBe(700_000);
      expect(await saldo(bt.id)).toBe(4_700_000);
      expect(r).toEqual({
        movimientos: [
          { bolsaId: c.bolsaId, alcance: 'compania', movimientoId: mc!.id, valor: 300_000, saldoResultante: 700_000 },
          { bolsaId: bt.id, alcance: 'transito', movimientoId: mt!.id, valor: 300_000, saldoResultante: 4_700_000 },
        ],
        omitidos: [], alertas: [],
      });
    });

    it('AC1 · idempotente: reintentar el descuento no crea un segundo consumo y devuelve el mismo movimiento', async () => {
      const { bt, t, k, r } = await impuestoDescontado(300_000);
      const otra = await descontar(pago(k.id, t.tramiteId, 'impuesto', 300_000));
      expect(transitoDe(otra).movimientos).toEqual(transitoDe(r).movimientos);
      expect(await movimientos(bt.id)).toHaveLength(1);
      expect(await saldo(bt.id)).toBe(4_700_000);
    });

    it('AC1 · saldo insuficiente en tránsito → salida igual, saldo negativo y alerta con el nombre de la bolsa (D11)', async () => {
      const c = await compania();
      const org = secretaria();
      const bt = await bolsaTransito(org, ['impuesto'], 100_000);
      const t = await tramite(c.companiaId, { impuesto: org });
      const k = await comprobante(t.tramiteId, 'impuesto', 300_000);
      const r = await descontar(pago(k.id, t.tramiteId, 'impuesto', 300_000));
      expect(await saldo(bt.id)).toBe(-200_000);
      expect(transitoDe(r).alertas).toEqual([{ bolsaId: bt.id, bolsaNombre: bt.nombre, alcance: 'transito', saldoResultante: -200_000 }]);
    });
  });

  // ─────────────────────────── AC2 ───────────────────────────

  describe('AC2 — compañía sin bolsa, tránsito que cubre', () => {
    it('AC2 · solo la salida de tránsito; el lado compañía se omite sin alerta', async () => {
      const c = await compania({ sinBolsa: true });
      const org = secretaria();
      const bt = await bolsaTransito(org, ['impuesto']);
      const t = await tramite(c.companiaId, { impuesto: org });
      const k = await comprobante(t.tramiteId, 'impuesto', 300_000);
      const r = await descontar(pago(k.id, t.tramiteId, 'impuesto', 300_000));
      const [mt] = await movimientos(bt.id);
      expect(r).toEqual({
        movimientos: [{ bolsaId: bt.id, alcance: 'transito', movimientoId: mt!.id, valor: 300_000, saldoResultante: 4_700_000 }],
        omitidos: [{ alcance: 'compania', motivo: 'sin_bolsa' }],
        alertas: [],
      });
    });
  });

  // ─────────────────────────── AC3 ───────────────────────────

  describe('AC3 — sin movimiento de tránsito, con su motivo; la compañía se descuenta igual', () => {
    it('AC3 · trámite digital → concepto_no_cubierto', async () => {
      const c = await compania();
      const t = await tramite(c.companiaId);
      const k = await comprobante(t.tramiteId, 'tramite_digital', 80_000);
      const r = await descontar(pago(k.id, t.tramiteId, 'tramite_digital', 80_000));
      expect(transitoDe(r)).toEqual({ movimientos: [], omitidos: [{ alcance: 'transito', motivo: 'concepto_no_cubierto' }], alertas: [] });
      expect(r!.movimientos.map((m) => m.alcance)).toEqual(['compania']);
      expect(await saldo(c.bolsaId!)).toBe(920_000);
    });

    it('AC3 · registro dueño sin secretaría (SOAT sin organismo) → sin_organismo', async () => {
      const c = await compania();
      const t = await tramite(c.companiaId, { soat: { organismo: null } });
      const k = await comprobante(t.tramiteId, 'soat', 500_000);
      const r = await descontar(pago(k.id, t.tramiteId, 'soat', 500_000));
      expect(transitoDe(r).omitidos).toEqual([{ alcance: 'transito', motivo: 'sin_organismo' }]);
      expect(transitoDe(r).movimientos).toEqual([]);
      expect(await saldo(c.bolsaId!)).toBe(500_000);
    });

    it('AC3 · impuesto sin registro dueño → sin_organismo', async () => {
      const c = await compania();
      const t = await tramite(c.companiaId);
      const k = await comprobante(t.tramiteId, 'impuesto', 100_000);
      const r = await descontar(pago(k.id, t.tramiteId, 'impuesto', 100_000));
      expect(transitoDe(r).omitidos).toEqual([{ alcance: 'transito', motivo: 'sin_organismo' }]);
      expect(await saldo(c.bolsaId!)).toBe(900_000);
    });

    it('AC3 · pareja sin cobertura activa → sin_bolsa (y una cobertura de OTRO concepto no cuenta)', async () => {
      const c = await compania();
      const org = secretaria();
      const bt = await bolsaTransito(org, ['derecho']);
      const t = await tramite(c.companiaId, { impuesto: org });
      const k = await comprobante(t.tramiteId, 'impuesto', 100_000);
      const r = await descontar(pago(k.id, t.tramiteId, 'impuesto', 100_000));
      expect(transitoDe(r).omitidos).toEqual([{ alcance: 'transito', motivo: 'sin_bolsa' }]);
      expect(await movimientos(bt.id)).toHaveLength(0);
      expect(await saldo(c.bolsaId!)).toBe(900_000);
    });

    it('AC3 · bolsa de tránsito inactiva → inactiva, sin movimiento', async () => {
      const c = await compania();
      const org = secretaria();
      const bt = await bolsaTransito(org, ['impuesto']);
      await sql`UPDATE flito_bolsas_unicas SET activa = false, inactivada_en = now() WHERE id = ${bt.id}`;
      const t = await tramite(c.companiaId, { impuesto: org });
      const k = await comprobante(t.tramiteId, 'impuesto', 100_000);
      const r = await descontar(pago(k.id, t.tramiteId, 'impuesto', 100_000));
      expect(transitoDe(r).omitidos).toEqual([{ alcance: 'transito', motivo: 'inactiva' }]);
      expect(await movimientos(bt.id)).toHaveLength(0);
    });
  });

  // ─────────────────────────── AC4 ───────────────────────────

  describe('AC4 — SOAT ya conciliado', () => {
    it('AC4 · consumo:soat:<soatId> ocupado por la conciliación → sin consumo nuevo, cubierto_por_conciliacion', async () => {
      const c = await compania();
      const org = secretaria();
      const bt = await bolsaTransito(org, ['soat']);
      const t = await tramite(c.companiaId, { soat: { organismo: org } });
      await db.transaction((tx) => transito.registrarConsumoTransito(tx, {
        organismoCodigo: org, concepto: 'soat', tramiteId: null, valor: 500_000, fecha: '2026-12-02',
        llave: `soat:${t.soatId}`, origen: 'conciliacion',
      }, ctx));
      expect(await saldo(bt.id)).toBe(4_500_000);
      const k = await comprobante(t.tramiteId, 'soat', 500_000);
      const r = await descontar(pago(k.id, t.tramiteId, 'soat', 500_000));
      expect(transitoDe(r)).toEqual({ movimientos: [], omitidos: [{ alcance: 'transito', motivo: 'cubierto_por_conciliacion' }], alertas: [] });
      expect(await movimientos(bt.id)).toHaveLength(1);
      expect(await saldo(bt.id)).toBe(4_500_000);
    });

    it('AC4 · SOAT sin conciliar → el consumo del comprobante usa la MISMA llave consumo:soat:<soatId> (ADR-0006)', async () => {
      const c = await compania();
      const org = secretaria();
      const bt = await bolsaTransito(org, ['soat']);
      const t = await tramite(c.companiaId, { soat: { organismo: org } });
      const k = await comprobante(t.tramiteId, 'soat', 500_000);
      await descontar(pago(k.id, t.tramiteId, 'soat', 500_000));
      const [mt] = await movimientos(bt.id);
      expect(mt).toMatchObject({ llave_idempotencia: `consumo:soat:${t.soatId}`, origen: 'comprobante', comprobante_id: k.id, organismo_codigo: org });
    });
  });

  // ─────────────────────────── AC5 ───────────────────────────

  describe('AC5 — desaplicar revierte los dos lados', () => {
    it('AC5 · desaplicar real → una entrada enlazada en cada bolsa, ambos saldos restituidos, llaves rev:…', async () => {
      const { c, bt, k } = await impuestoDescontado(300_000);
      const [sc] = await movimientos(c.bolsaId!);
      const [st] = await movimientos(bt.id);

      await comp.desaplicar(k.id, { destino: 'pendiente', motivo: MOTIVO }, cctx);

      for (const [bolsaId, salida, saldoInicial] of [[c.bolsaId!, sc!, 1_000_000], [bt.id, st!, 5_000_000]] as const) {
        const filas = await movimientos(bolsaId);
        expect(filas).toHaveLength(2);
        const entrada = filas.find((f) => f.tipo === 'entrada')!;
        expect(entrada).toMatchObject({ origen: 'comprobante', revierte_movimiento_id: salida.id, comprobante_id: k.id });
        expect(Number(entrada.valor)).toBe(300_000);
        expect(filas.find((f) => f.id === salida.id)!.llave_idempotencia).toBe(`rev:${salida.llave_idempotencia}`);
        expect(await saldo(bolsaId)).toBe(saldoInicial);
      }
      const entradaT = (await movimientos(bt.id)).find((f) => f.tipo === 'entrada')!;
      expect(entradaT.organismo_codigo).toBe(st!.organismo_codigo);
      expect((await estado(k.id)).estado).toBe('pendiente');
    });
  });

  // ─────────────────────────── AC6 ───────────────────────────

  describe('AC6 — mes cerrado en la bolsa de tránsito bloquea todo', () => {
    async function transitoCerrado() {
      const x = await impuestoDescontado(300_000);
      vi.setSystemTime(ENE_5);
      await cerrar(x.bt.id, '2026-12');
      return x;
    }
    async function sinCambios(x: Awaited<ReturnType<typeof transitoCerrado>>) {
      expect(await estado(x.k.id)).toMatchObject({ estado: 'aplicado', tramite_id: x.t.tramiteId });
      expect((await sql`SELECT estado FROM flito_impuestos WHERE tramite_id = ${x.t.tramiteId}`)[0]!.estado).toBe('pagado');
      expect(await movimientos(x.c.bolsaId!)).toHaveLength(1);
      expect(await movimientos(x.bt.id)).toHaveLength(1);
      expect(await saldo(x.c.bolsaId!)).toBe(700_000);
      expect(await saldo(x.bt.id)).toBe(4_700_000);
    }

    it('AC6 · desaplicar → 409 periodo_cerrado con la bolsa de tránsito y el periodo; nada cambia', async () => {
      const x = await transitoCerrado();
      const err = await comp.desaplicar(x.k.id, { destino: 'pendiente', motivo: MOTIVO }, cctx).catch((e: unknown) => e) as { status: number; cuerpo: () => unknown };
      expect(err.status).toBe(409);
      expect(err.cuerpo()).toMatchObject({ codigo: 'periodo_cerrado', bolsaId: x.bt.id, bolsaNombre: x.bt.nombre, periodo: '2026-12' });
      await sinCambios(x);
    });

    it('AC6 · reemplazar → 409 periodo_cerrado con la bolsa de tránsito; original aplicado, reemplazo pendiente, nada cambia', async () => {
      const x = await transitoCerrado();
      const reemplazoId = await pendiente();
      const err = await comp.reemplazar(x.k.id, { reemplazoId, motivo: MOTIVO }, cctx).catch((e: unknown) => e) as { status: number; cuerpo: () => unknown };
      expect(err.status).toBe(409);
      expect(err.cuerpo()).toMatchObject({ codigo: 'periodo_cerrado', bolsaId: x.bt.id, periodo: '2026-12' });
      expect((await estado(reemplazoId)).estado).toBe('pendiente');
      await sinCambios(x);
    });
  });

  // ─────────────────────────── AC7 ───────────────────────────

  describe('AC7 — reemplazar revierte y vuelve a descontar en las dos bolsas', () => {
    it('AC7 · 200.000 → 210.000: cada bolsa recibe entrada 200.000 enlazada y salida nueva 210.000', async () => {
      const { c, bt, t, k } = await impuestoDescontado(200_000);
      const [sc] = await movimientos(c.bolsaId!);
      const [st] = await movimientos(bt.id);
      const r = await comprobante(t.tramiteId, 'impuesto', 210_000);
      // Lo que hace `reemplazar` en su tx con la bolsa: guarda + reversión del original y descuento del reemplazo.
      await db.transaction(async (tx) => {
        await d.exigirDescuentoReversible(tx, k.id);
        await d.revertirDescuentoComprobante(tx, k.id, ctx, { motivo: MOTIVO });
        await d.descontarComprobante(tx, pago(r.id, t.tramiteId, 'impuesto', 210_000), ctx);
      });
      for (const [bolsaId, salida, prefijo, saldoFinal] of [
        [c.bolsaId!, sc!, 'salida:comprobante:', 790_000], [bt.id, st!, 'consumo:comprobante:', 4_790_000],
      ] as const) {
        const filas = await movimientos(bolsaId);
        expect(filas).toHaveLength(3);
        const entrada = filas.find((f) => f.tipo === 'entrada')!;
        expect(entrada).toMatchObject({ revierte_movimiento_id: salida.id, comprobante_id: k.id });
        expect(Number(entrada.valor)).toBe(200_000);
        const nueva = filas.find((f) => f.tipo === 'salida' && f.comprobante_id === r.id)!;
        expect(Number(nueva.valor)).toBe(210_000);
        expect(nueva.llave_idempotencia).toBe(`${prefijo}${r.id}`);
        expect(await saldo(bolsaId)).toBe(saldoFinal);
      }
    });
  });

  // ─────────────────────────── AC8 ───────────────────────────

  describe('AC8 — el dueño rechaza el pago tras el commit', () => {
    it('AC8 · SOAT con salidas en compañía y tránsito; aplicarFacturaSoat rechaza → las dos salidas quedan revertidas con entradas enlazadas', async () => {
      const c = await compania();
      const org = secretaria();
      const bt = await bolsaTransito(org, ['soat']);
      const t = await tramite(c.companiaId, { soat: { organismo: org } });
      const k = await comprobante(t.tramiteId, 'soat', 450_000);
      await descontar(pago(k.id, t.tramiteId, 'soat', 450_000));
      expect(await saldo(c.bolsaId!)).toBe(550_000);
      expect(await saldo(bt.id)).toBe(4_550_000);
      const destino = { concepto: 'soat' as never, fk: { soatId: t.soatId }, tipoSoporte: 'factura_soat', candidato: null };
      const args = {
        tramiteId: t.tramiteId, soporteAplicadoId: k.soporteId, extraccionDestino: {}, motivo: null, fechaPago: null,
        ctx: { userId: USER, username: 'hu13909@flit.io', role: 'financiera' },
      };

      await expect(ap.pagarDespuesDelCommit(k.id, destino as never, args as never)).rejects.toMatchObject({ status: 409, codigo: 'destino_no_admite' });

      for (const [bolsaId, saldoInicial] of [[c.bolsaId!, 1_000_000], [bt.id, 5_000_000]] as const) {
        const filas = await movimientos(bolsaId);
        expect(filas).toHaveLength(2);
        const salida = filas.find((f) => f.tipo === 'salida')!;
        const entrada = filas.find((f) => f.tipo === 'entrada')!;
        expect(entrada).toMatchObject({ origen: 'comprobante', comprobante_id: k.id, revierte_movimiento_id: salida.id });
        expect(await saldo(bolsaId)).toBe(saldoInicial);
      }
      // La llave del SOAT queda libre para la conciliación o un pago posterior.
      const [st] = (await movimientos(bt.id)).filter((f) => f.tipo === 'salida');
      expect(st!.llave_idempotencia).toBe(`rev:consumo:soat:${t.soatId}`);
      expect((await estado(k.id)).estado).toBe('pendiente');
    });
  });

  // ─────────────────────────── AC9 ───────────────────────────

  describe('AC9 — concurrencia real: dos aplicaciones y una conciliación a la vez', () => {
    /** Saldo inicial − salidas + entradas del libro. */
    const delLibro = async (bolsaId: string, inicial: number) => {
      const [f] = await sql`SELECT COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END), 0) AS neto
        FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${bolsaId}`;
      return inicial + Number(f!.neto);
    };

    it('AC9 · misma bolsa de compañía y misma de tránsito, 4 rondas → sin deadlock, saldos = libro', async () => {
      const c = await compania();
      const org = secretaria();
      const bt = await bolsaTransito(org, ['impuesto', 'soat']);
      let esperadoC = 1_000_000;
      let esperadoT = 5_000_000;
      for (let ronda = 0; ronda < 4; ronda += 1) {
        const t1 = await tramite(c.companiaId, { impuesto: org });
        const t2 = await tramite(c.companiaId, { impuesto: org });
        const tb = await tramite(c.companiaId, { soat: { organismo: org } });
        const k1 = await comprobante(t1.tramiteId, 'impuesto', 100_000);
        const k2 = await comprobante(t2.tramiteId, 'impuesto', 120_000);
        // La conciliación de una boleta asienta con los mismos escritores y en el mismo orden que
        // `asentar` de `flito-conciliacion.conciliar.service.ts`: bolsa de compañía → bolsa de tránsito.
        // La pausa entre los dos locks abre la ventana: si el descuento bloqueara tránsito antes que
        // compañía, esta transacción y la suya se esperarían en cruz (40P01).
        const conciliar = db.transaction(async (tx) => {
          await libro.asentarSiHayBolsa(tx, c.companiaId, {
            tipo: 'salida', origen: 'conciliacion', valor: 300_000, fecha: '2026-12-02', concepto: 'soat',
            organismoCodigo: org, tramiteId: null, llaveIdempotencia: `salida:soat:${tb.soatId}`, etiqueta: 'salida',
          }, ctx);
          await tx.execute(sqlTag`SELECT pg_sleep(0.15)`);
          await transito.registrarConsumoTransito(tx, {
            organismoCodigo: org, concepto: 'soat', tramiteId: null, valor: 300_000, fecha: '2026-12-02',
            llave: `soat:${tb.soatId}`, origen: 'conciliacion',
          }, ctx);
        });
        await new Promise((ok) => setTimeout(ok, 30));
        const resultados = await Promise.allSettled([
          conciliar,
          descontar(pago(k1.id, t1.tramiteId, 'impuesto', 100_000)),
          descontar(pago(k2.id, t2.tramiteId, 'impuesto', 120_000)),
        ]);
        expect(resultados.filter((x) => x.status === 'rejected')).toEqual([]);
        esperadoC -= 520_000;
        esperadoT -= 520_000;
      }
      expect(await saldo(c.bolsaId!)).toBe(esperadoC);
      expect(await saldo(bt.id)).toBe(esperadoT);
      expect(await delLibro(c.bolsaId!, 1_000_000)).toBe(esperadoC);
      expect(await delLibro(bt.id, 5_000_000)).toBe(esperadoT);
      expect(await movimientos(bt.id)).toHaveLength(12);
    }, 30_000);
  });
});
