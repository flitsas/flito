// HU #13902 (Feature #13886, ADR-0029 D7-D12, D15) — descuento de la bolsa de COMPAÑÍA al aplicar el
// comprobante, contra PostgreSQL de verdad: corte en hora de Colombia, omisiones con motivo, saldo negativo,
// llaves de ADR-0006 compartidas con conciliación y liquidación, compensación enlazada, re-descuento tras
// reversar una liquidación anterior al corte y la regla de autogestión.
//
// Se activa con `TEST_DATABASE_URL`; sin ella se SALTA (el CI no levanta Postgres). Un `skipped` NO es verde.
// Cada caso crea su compañía, su bolsa, su trámite y sus comprobantes; todo se borra en `afterAll`.
// El reloj se fija con `vi.useFakeTimers({ toFake: ['Date'] })`: el libro rechaza fechas futuras y el corte
// de los AC (2026-12-01) aún no ha llegado.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const URL = process.env.TEST_DATABASE_URL;
vi.hoisted(() => {
  // El cliente drizzle lee DATABASE_URL al importarse; `setup.ts` la deja en un valor ficticio.
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const CORTE = '2026-12-01';
/** 03-dic-2026 10:00 COT. */
const DIC_3 = new Date('2026-12-03T15:00:00Z');

describe.skipIf(!URL)('HU #13902 — descontarComprobante (PostgreSQL real)', () => {
  let sql: import('postgres').Sql;
  let db: typeof import('../../src/db/client.js').db;
  let env: typeof import('../../src/config/env.js').env;
  let d: typeof import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
  let libro: typeof import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
  let USER: number;
  let ctx: { userId: number; nombre: string };
  let n = 0;
  const creados = { clients: [] as number[], vehicles: [] as number[], tramites: [] as string[], soats: [] as string[], soportes: [] as string[] };

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL!, { max: 2 });
    ({ db } = await import('../../src/db/client.js'));
    ({ env } = await import('../../src/config/env.js'));
    d = await import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
    libro = await import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
    const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`;
    USER = u!.id as number;
    ctx = { userId: USER, nombre: 'hu13902@flit.io' };
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = creados.clients.length ? creados.clients : [-1];
    const bolsas = sql`SELECT id FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_conceptos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id IN ${sql(ids)}`;
    const tr = creados.tramites.length ? creados.tramites : ['00000000-0000-0000-0000-000000000000'];
    await sql`DELETE FROM flito_comprobantes WHERE tramite_id IN ${sql(tr)}`;
    if (creados.soportes.length) await sql`DELETE FROM flito_soportes WHERE id IN ${sql(creados.soportes)}`;
    await sql`DELETE FROM flito_excepciones_autogestion WHERE tramite_id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_impuestos WHERE tramite_id IN ${sql(tr)}`;
    await sql`UPDATE flito_tramites SET soat_id = NULL WHERE id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_tramites WHERE id IN ${sql(tr)}`;
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

  interface Escenario {
    companiaId: number | null; bolsaId: string | null; tramiteId: string; soatId: string | null;
  }
  interface OpcionesEscenario {
    autogestion?: { soat?: boolean; impuestos?: boolean; logistica?: boolean };
    conceptos?: string[]; saldo?: number; activa?: boolean; sinBolsa?: boolean; sinCompania?: boolean;
    soat?: { origen?: 'tramite' | 'cliente'; excepcion?: boolean }; impuestoExcepcion?: boolean;
  }

  async function escenario(o: OpcionesEscenario = {}): Promise<Escenario> {
    n += 1;
    const sello = `${Date.now() % 1e9}${n}`;
    let companiaId: number | null = null;
    if (!o.sinCompania) {
      const a = o.autogestion ?? {};
      const [c] = await sql`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
        VALUES (${`HU13902 ${sello}`}, ${`8${sello}`.slice(0, 20)}, ${a.soat ?? false}, ${a.impuestos ?? false}, ${a.logistica ?? false}) RETURNING id`;
      companiaId = c!.id as number;
      creados.clients.push(companiaId);
    }
    let bolsaId: string | null = null;
    if (companiaId !== null && !o.sinBolsa) {
      const activa = o.activa ?? true;
      const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, compania_id, saldo, activa, inactivada_en)
        VALUES ('compania', ${companiaId}, ${String(o.saldo ?? 1_000_000)}, ${activa}, ${activa ? null : new Date('2026-11-01T00:00:00Z')}) RETURNING id`;
      bolsaId = b!.id as string;
      for (const concepto of o.conceptos ?? ['soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'servicios_adicionales']) {
        await sql`INSERT INTO flito_bolsas_unicas_conceptos (bolsa_id, concepto) VALUES (${bolsaId}, ${concepto})`;
      }
    }
    const [v] = await sql`INSERT INTO vehicles DEFAULT VALUES RETURNING id`;
    creados.vehicles.push(v!.id as number);
    const [t] = await sql`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id)
      VALUES (${`HU13902-${sello}`}, ${v!.id}, now(), ${companiaId}) RETURNING id`;
    const tramiteId = t!.id as string;
    creados.tramites.push(tramiteId);
    let soatId: string | null = null;
    if (o.soat && companiaId !== null) {
      const [s] = await sql`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, origen, excepcion_autogestion)
        VALUES (${`V${sello}`.slice(0, 17)}, ${v!.id}, ${companiaId}, ${o.soat.origen ?? 'tramite'}, ${o.soat.excepcion ?? false}) RETURNING id`;
      soatId = s!.id as string;
      creados.soats.push(soatId);
      await sql`UPDATE flito_tramites SET soat_id = ${soatId} WHERE id = ${tramiteId}`;
    }
    if (o.impuestoExcepcion !== undefined && companiaId !== null) {
      await sql`INSERT INTO flito_impuestos (tramite_id, organismo_codigo, compania_id, modalidad_aplicada, excepcion_autogestion)
        VALUES (${tramiteId}, '05001', ${companiaId}, 'requiere_gestion', ${o.impuestoExcepcion})`;
    }
    return { companiaId, bolsaId, tramiteId, soatId };
  }

  /** Un comprobante aplicado como pago (o documentación) del trámite. */
  async function comprobante(tramiteId: string, concepto: string, valor: number | null, esPago = true): Promise<string> {
    n += 1;
    const [s] = await sql`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
      VALUES ('comprobante_pago', 'c.pdf', 'application/pdf', ${`hu13902/${n}.pdf`}, ${`h13902${Date.now()}${n}`.slice(0, 64)}, 10, 'test') RETURNING id`;
    creados.soportes.push(s!.id as string);
    const [c] = await sql`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre,
        estado, tramite_id, concepto, es_pago, valor, aplicado_en, aplicado_por_id)
      VALUES (gen_random_uuid(), ${s!.id}, '{}'::jsonb, ${USER}, 'test', 'aplicado', ${tramiteId}, ${concepto}, ${esPago},
        ${valor === null ? null : String(valor)}, now(), ${USER}) RETURNING id`;
    return c!.id as string;
  }

  const descontar = (c: Parameters<typeof d.descontarComprobante>[1]) =>
    db.transaction((tx) => d.descontarComprobante(tx, c, ctx));
  const pago = (comprobanteId: string, tramiteId: string, concepto: string, valor: number, aplicadoEn = DIC_3) =>
    ({ comprobanteId, tramiteId, concepto: concepto as never, esPago: true, valor: String(valor), aplicadoEn });
  const movimientos = (bolsaId: string) => sql`SELECT *, fecha::text AS fecha FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${bolsaId} ORDER BY created_at, origen, id`;
  const saldo = async (bolsaId: string) => Number((await sql`SELECT saldo FROM flito_bolsas_unicas WHERE id = ${bolsaId}`)[0]!.saldo);

  // ─────────────────────────── AC1 ───────────────────────────

  describe('AC1 — sin corte el gancho no hace nada', () => {
    it('TC-01 · sin FLITO_BOLSAS_CORTE_COMPROBANTES → null y ningún movimiento', async () => {
      env.FLITO_BOLSAS_CORTE_COMPROBANTES = undefined;
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      expect(await descontar(pago(id, e.tramiteId, 'impuesto', 250_000))).toBeNull();
      expect(await movimientos(e.bolsaId!)).toHaveLength(0);
      expect(d.corteVigente()).toBeNull();
      expect(d.cubiertoPorCorte('2030-01-01')).toBe(false);
    });
  });

  // ─────────────────────────── AC2 ───────────────────────────

  describe('AC2 — con corte, la salida se asienta en la misma tx', () => {
    it('TC-03 · impuesto 250.000 el 03-dic → salida origen comprobante, comprobante_id, llave salida:comprobante:<id>, saldo 750.000', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      const r = await descontar(pago(id, e.tramiteId, 'impuesto', 250_000));
      const [m, ...resto] = await movimientos(e.bolsaId!);
      expect(resto).toHaveLength(0);
      expect(m).toMatchObject({
        tipo: 'salida', origen: 'comprobante', concepto: 'impuesto', comprobante_id: id, tramite_id: e.tramiteId,
        llave_idempotencia: `salida:comprobante:${id}`, registrado_por_nombre: 'hu13902@flit.io', periodo: '2026-12',
      });
      expect(Number(m!.valor)).toBe(250_000);
      expect(await saldo(e.bolsaId!)).toBe(750_000);
      expect(r).toEqual({
        movimientos: [{ bolsaId: e.bolsaId, alcance: 'compania', movimientoId: m!.id, valor: 250_000, saldoResultante: 750_000 }],
        omitidos: [], alertas: [],
      });
    });

    it('TC-04 · si la tx de aplicar se deshace, el descuento se deshace con ella', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      await expect(db.transaction(async (tx) => {
        await d.descontarComprobante(tx, pago(id, e.tramiteId, 'impuesto', 250_000), ctx);
        throw new Error('falla posterior del aplicar');
      })).rejects.toThrow('falla posterior');
      expect(await movimientos(e.bolsaId!)).toHaveLength(0);
      expect(await saldo(e.bolsaId!)).toBe(1_000_000);
    });
  });

  // ─────────────────────────── AC3 ───────────────────────────

  describe('AC3 — el corte se compara en hora de Colombia', () => {
    it('TC-06 · aplicado el 30-nov 23:30 COT (01-dic 04:30Z) con corte 2026-12-01 se omite antes_del_corte', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      const r = await descontar(pago(id, e.tramiteId, 'impuesto', 250_000, new Date('2026-12-01T04:30:00Z')));
      expect(r).toEqual({ movimientos: [], omitidos: [{ alcance: 'compania', motivo: 'antes_del_corte' }], alertas: [] });
      expect(await movimientos(e.bolsaId!)).toHaveLength(0);
    });

    it('TC-07 · aplicado exactamente a las 00:00 COT del día del corte sí descuenta', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      const r = await descontar(pago(id, e.tramiteId, 'impuesto', 250_000, new Date('2026-12-01T05:00:00Z')));
      expect(r!.movimientos).toHaveLength(1);
      expect((await movimientos(e.bolsaId!))[0]).toMatchObject({ origen: 'comprobante', fecha: '2026-12-01' });
    });
  });

  // ─────────────────────────── AC4 ───────────────────────────

  describe('AC4 — lo que no aplica se omite sin alerta', () => {
    it.each([
      ['concepto no marcado en la bolsa', { conceptos: ['soat'] }, 'concepto_no_cubierto'],
      ['compañía sin bolsa', { sinBolsa: true }, 'sin_bolsa'],
      ['bolsa inactiva', { activa: false }, 'inactiva'],
      ['trámite sin compañía', { sinCompania: true }, 'sin_compania'],
    ] as const)('TC-08 · %s → %s', async (_caso, o, motivo) => {
      const e = await escenario(o as OpcionesEscenario);
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      const r = await descontar(pago(id, e.tramiteId, 'impuesto', 250_000));
      expect(r).toEqual({ movimientos: [], omitidos: [{ alcance: 'compania', motivo }], alertas: [] });
      if (e.bolsaId) {
        expect(await movimientos(e.bolsaId)).toHaveLength(0);
        expect(await saldo(e.bolsaId)).toBe(1_000_000);
      }
    });

    it('TC-08 · comprobante de documentación → no_es_pago', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'impuesto', null, false);
      const r = await descontar({ ...pago(id, e.tramiteId, 'impuesto', 0), esPago: false, valor: null });
      expect(r).toEqual({ movimientos: [], omitidos: [{ alcance: 'compania', motivo: 'no_es_pago' }], alertas: [] });
      expect(await movimientos(e.bolsaId!)).toHaveLength(0);
    });
  });

  // ─────────────────────────── AC5 ───────────────────────────

  describe('AC5 — saldo insuficiente no bloquea', () => {
    it('TC-09 · saldo 100.000 y comprobante 300.000 → saldo −200.000 y alerta con la bolsa (y su nombre visible, HU #13904)', async () => {
      const e = await escenario({ saldo: 100_000 });
      const id = await comprobante(e.tramiteId, 'derecho', 300_000);
      const r = await descontar(pago(id, e.tramiteId, 'derecho', 300_000));
      expect(await saldo(e.bolsaId!)).toBe(-200_000);
      // Bolsa de compañía: `nombre` es NULL, así que el nombre visible es el del cliente.
      const [cli] = await sql`SELECT name FROM clients WHERE id = ${e.companiaId}`;
      expect(r!.alertas).toEqual([{ bolsaId: e.bolsaId, bolsaNombre: cli!.name, alcance: 'compania', saldoResultante: -200_000 }]);
    });
  });

  // ─────────────────────────── AC6 ───────────────────────────

  describe('AC6 — idempotencia y llaves de ADR-0006', () => {
    it('TC-10 · repetir el descuento del mismo comprobante no crea un segundo movimiento', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      const r1 = await descontar(pago(id, e.tramiteId, 'impuesto', 250_000));
      const r2 = await descontar(pago(id, e.tramiteId, 'impuesto', 250_000));
      expect(await movimientos(e.bolsaId!)).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(750_000);
      expect(r2!.movimientos[0]!.movimientoId).toBe(r1!.movimientos[0]!.movimientoId);
    });

    it('TC-11 · SOAT ya conciliado con salida:soat:<soatId> → sin movimiento, cubierto_por_conciliacion', async () => {
      const e = await escenario({ soat: {} });
      await db.transaction((tx) => libro.asentarSiHayBolsa(tx, e.companiaId!, {
        tipo: 'salida', origen: 'conciliacion', valor: 400_000, fecha: '2026-12-02', concepto: 'soat',
        llaveIdempotencia: `salida:soat:${e.soatId}`, etiqueta: 'salida',
      }, ctx));
      const id = await comprobante(e.tramiteId, 'soat', 400_000);
      const r = await descontar(pago(id, e.tramiteId, 'soat', 400_000));
      expect(r!.omitidos).toEqual([{ alcance: 'compania', motivo: 'cubierto_por_conciliacion' }]);
      expect(await movimientos(e.bolsaId!)).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(600_000);
    });

    it('TC-12 · orden inverso: el comprobante SOAT usa salida:soat:<soatId> (M1) y la conciliación posterior no cobra dos veces', async () => {
      const e = await escenario({ soat: {} });
      const id = await comprobante(e.tramiteId, 'soat', 400_000);
      await descontar(pago(id, e.tramiteId, 'soat', 400_000));
      const [m] = await movimientos(e.bolsaId!);
      expect(m!.llave_idempotencia).toBe(`salida:soat:${e.soatId}`);
      const conc = await db.transaction((tx) => libro.asentarSiHayBolsa(tx, e.companiaId!, {
        tipo: 'salida', origen: 'conciliacion', valor: 400_000, fecha: '2026-12-03', concepto: 'soat',
        llaveIdempotencia: `salida:soat:${e.soatId}`, etiqueta: 'salida',
      }, ctx));
      expect(conc!.duplicado).toBe(true);
      expect(await movimientos(e.bolsaId!)).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(600_000);
    });
  });

  // ─────────────────────────── AC7 ───────────────────────────

  describe('AC7 — lo liquidado antes del corte queda como está', () => {
    async function salidaLiquidacion(e: Escenario, concepto: string, valor: number, llave: string) {
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
      await db.transaction((tx) => libro.registrarSalidasLiquidacion(tx, {
        companiaId: e.companiaId!, tramiteId: e.tramiteId, fecha: '2026-11-20',
        conceptos: [{ concepto: concepto as never, valor, organismoCodigo: null, llave }],
      }, ctx));
      vi.setSystemTime(DIC_3);
    }

    it('TC-14 · trámite liquidado antes del corte y comprobante aplicado después se omite cubierto_por_liquidacion', async () => {
      const e = await escenario();
      await salidaLiquidacion(e, 'derecho', 80_000, `tramite:${e.tramiteId}:derecho`);
      const id = await comprobante(e.tramiteId, 'derecho', 80_000);
      const r = await descontar(pago(id, e.tramiteId, 'derecho', 80_000));
      expect(r!.omitidos).toEqual([{ alcance: 'compania', motivo: 'cubierto_por_liquidacion' }]);
      expect(await movimientos(e.bolsaId!)).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(920_000);
    });

    it('TC-14 · borde: la salida de la liquidación ya reversada no cubre → sí descuenta', async () => {
      const e = await escenario();
      await salidaLiquidacion(e, 'derecho', 80_000, `tramite:${e.tramiteId}:derecho`);
      await db.transaction((tx) => libro.reversarSalidasLiquidacion(tx, e.tramiteId, ctx));
      const id = await comprobante(e.tramiteId, 'derecho', 80_000);
      const r = await descontar(pago(id, e.tramiteId, 'derecho', 80_000));
      expect(r!.movimientos).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(920_000);
    });

    it('TC-14 · borde 2: una salida automática de OTRO concepto no cubre → sí descuenta', async () => {
      const e = await escenario();
      await salidaLiquidacion(e, 'tramite_digital', 50_000, `tramite:${e.tramiteId}:tramite_digital`);
      const id = await comprobante(e.tramiteId, 'derecho', 80_000);
      const r = await descontar(pago(id, e.tramiteId, 'derecho', 80_000));
      expect(r!.movimientos).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(870_000);
    });

    it('TC-14 · SOAT: la llave salida:soat:<soatId> ocupada por la liquidación → cubierto_por_liquidacion', async () => {
      const e = await escenario({ soat: {} });
      await salidaLiquidacion(e, 'soat', 400_000, `soat:${e.soatId}`);
      const id = await comprobante(e.tramiteId, 'soat', 400_000);
      const r = await descontar(pago(id, e.tramiteId, 'soat', 400_000));
      expect(r!.omitidos).toEqual([{ alcance: 'compania', motivo: 'cubierto_por_liquidacion' }]);
      expect(await saldo(e.bolsaId!)).toBe(600_000);
    });
  });

  // ─────────────────────────── AC8 ───────────────────────────

  describe('AC8 — la compensación revierte con una entrada enlazada', () => {
    it('TC-15 · entrada con revierte_movimiento_id, saldo de vuelta, llave original rev:…; dos compensaciones no duplican', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 250_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 250_000));
      const [salida] = await movimientos(e.bolsaId!);
      const o = { motivo: 'El dueño rechazó el pago', compensacion: true };
      const r1 = await db.transaction((tx) => d.revertirDescuentoComprobante(tx, id, ctx, o));
      const r2 = await db.transaction((tx) => d.revertirDescuentoComprobante(tx, id, ctx, o));
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(0);
      const filas = await movimientos(e.bolsaId!);
      expect(filas).toHaveLength(2);
      const entrada = filas.find((f) => f.tipo === 'entrada')!;
      expect(entrada).toMatchObject({ origen: 'comprobante', revierte_movimiento_id: salida!.id, comprobante_id: id });
      expect(Number(entrada.valor)).toBe(250_000);
      const original = filas.find((f) => f.id === salida!.id)!;
      expect(original.llave_idempotencia).toBe(`rev:salida:comprobante:${id}`);
      expect(Number(original.valor)).toBe(250_000);
      expect(await saldo(e.bolsaId!)).toBe(1_000_000);
    });

    it('TC-15 · el índice único parcial impide una segunda reversión aunque se salte la relectura', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 100_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 100_000));
      const [salida] = await movimientos(e.bolsaId!);
      await db.transaction((tx) => d.revertirDescuentoComprobante(tx, id, ctx, { motivo: 'x', compensacion: true }));
      await expect(sql`INSERT INTO flito_bolsas_unicas_movimientos (bolsa_id, tipo, origen, valor, saldo_resultante, periodo, fecha,
          registrado_por_nombre, revierte_movimiento_id)
        VALUES (${e.bolsaId}, 'entrada', 'comprobante', 1, 1, '2026-12', '2026-12-03', 't', ${salida!.id})`).rejects.toThrow(/uq_flito_bolsas_unicas_mov_revierte/);
    });
  });

  // ─────────────────────────── AC10 ───────────────────────────

  describe('AC10 — reversar después del corte una liquidación anterior', () => {
    it('TC-17 · devuelve la salida de la liquidación y descuenta el comprobante: un solo descuento neto', async () => {
      const e = await escenario();
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
      await db.transaction((tx) => libro.registrarSalidasLiquidacion(tx, {
        companiaId: e.companiaId!, tramiteId: e.tramiteId, fecha: '2026-11-20',
        conceptos: [{ concepto: 'impuesto', valor: 250_000, organismoCodigo: null, llave: `impuesto:${e.tramiteId}` }],
      }, ctx));
      vi.setSystemTime(DIC_3);
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      expect((await descontar(pago(id, e.tramiteId, 'impuesto', 250_000)))!.omitidos[0]!.motivo).toBe('cubierto_por_liquidacion');

      vi.setSystemTime(new Date('2026-12-05T15:00:00Z'));
      await db.transaction(async (tx) => {
        const devueltas = await libro.reversarSalidasLiquidacion(tx, e.tramiteId, ctx);
        await d.redescontarTrasReverso(tx, e.tramiteId, devueltas.length > 0, ctx);
      });
      const filas = await movimientos(e.bolsaId!);
      expect(filas.map((f) => [f.tipo, f.origen])).toEqual([['salida', 'automatico'], ['entrada', 'automatico'], ['salida', 'comprobante']]);
      expect(filas[2]).toMatchObject({ comprobante_id: id, llave_idempotencia: `salida:comprobante:${id}` });
      expect(await saldo(e.bolsaId!)).toBe(750_000);
    });

    it('TC-17 · borde: reversa ANTES del corte → no se re-descuenta', async () => {
      const e = await escenario();
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
      await db.transaction((tx) => libro.registrarSalidasLiquidacion(tx, {
        companiaId: e.companiaId!, tramiteId: e.tramiteId, fecha: '2026-11-20',
        conceptos: [{ concepto: 'impuesto', valor: 250_000, organismoCodigo: null, llave: `impuesto:${e.tramiteId}` }],
      }, ctx));
      await comprobante(e.tramiteId, 'impuesto', 250_000);
      vi.setSystemTime(new Date('2026-11-25T15:00:00Z'));
      const r = await db.transaction(async (tx) => {
        const devueltas = await libro.reversarSalidasLiquidacion(tx, e.tramiteId, ctx);
        return d.redescontarTrasReverso(tx, e.tramiteId, devueltas.length > 0, ctx);
      });
      expect(r).toEqual([]);
      expect(await saldo(e.bolsaId!)).toBe(1_000_000);
    });

    it('TC-17 · borde: si la liquidación no movió la bolsa (posterior al corte) no se re-descuenta lo omitido antes del corte', async () => {
      const e = await escenario();
      await comprobante(e.tramiteId, 'impuesto', 250_000);
      const r = await db.transaction((tx) => d.redescontarTrasReverso(tx, e.tramiteId, false, ctx));
      expect(r).toEqual([]);
      expect(await movimientos(e.bolsaId!)).toHaveLength(0);
    });
  });

  // ─────────────────────────── AC11 (D15) ───────────────────────────

  describe('AC11 — lo autogestionado no descuenta, salvo excepción', () => {
    it.each([
      ['logistica', { logistica: true }, {}],
      ['impuesto', { impuestos: true }, { impuestoExcepcion: false }],
      ['soat', { soat: true }, { soat: { origen: 'tramite' as const } }],
    ])('TC-18 · %s autogestionado → sin movimiento, motivo autogestionado', async (concepto, autogestion, extra) => {
      const e = await escenario({ autogestion, ...extra });
      const id = await comprobante(e.tramiteId, concepto, 120_000);
      const r = await descontar(pago(id, e.tramiteId, concepto, 120_000));
      expect(r).toEqual({ movimientos: [], omitidos: [{ alcance: 'compania', motivo: 'autogestionado' }], alertas: [] });
      expect(await saldo(e.bolsaId!)).toBe(1_000_000);
    });

    it('TC-19 · con excepción de autogestión vigente para el trámite sí descuenta (logística)', async () => {
      const e = await escenario({ autogestion: { logistica: true } });
      await sql`INSERT INTO flito_excepciones_autogestion (tramite_id, concepto, motivo) VALUES (${e.tramiteId}, 'logistica', 'FLITO la hace')`;
      const id = await comprobante(e.tramiteId, 'logistica', 120_000);
      expect((await descontar(pago(id, e.tramiteId, 'logistica', 120_000)))!.movimientos).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(880_000);
    });

    it('TC-19 · borde: excepción revocada (no vigente) o de otro concepto → no descuenta', async () => {
      const e = await escenario({ autogestion: { logistica: true } });
      await sql`INSERT INTO flito_excepciones_autogestion (tramite_id, concepto, motivo, revocado_en, revocado_motivo)
        VALUES (${e.tramiteId}, 'logistica', 'ya no', now(), 'revocada')`;
      await sql`INSERT INTO flito_excepciones_autogestion (tramite_id, concepto, motivo) VALUES (${e.tramiteId}, 'soat', 'otro concepto')`;
      const id = await comprobante(e.tramiteId, 'logistica', 120_000);
      expect((await descontar(pago(id, e.tramiteId, 'logistica', 120_000)))!.omitidos).toEqual([{ alcance: 'compania', motivo: 'autogestionado' }]);
    });

    it('TC-19 · impuesto y SOAT con la excepción marcada en su registro → sí descuentan', async () => {
      const e = await escenario({ autogestion: { impuestos: true, soat: true }, impuestoExcepcion: true, soat: { excepcion: true } });
      const imp = await comprobante(e.tramiteId, 'impuesto', 100_000);
      const soat = await comprobante(e.tramiteId, 'soat', 300_000);
      expect((await descontar(pago(imp, e.tramiteId, 'impuesto', 100_000)))!.movimientos).toHaveLength(1);
      expect((await descontar(pago(soat, e.tramiteId, 'soat', 300_000)))!.movimientos).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(600_000);
    });

    it('TC-20 · SOAT del canal cliente (origen=cliente) sí descuenta aunque la compañía autogestione SOAT', async () => {
      const e = await escenario({ autogestion: { soat: true }, soat: { origen: 'cliente' } });
      const id = await comprobante(e.tramiteId, 'soat', 300_000);
      expect((await descontar(pago(id, e.tramiteId, 'soat', 300_000)))!.movimientos).toHaveLength(1);
      expect((await movimientos(e.bolsaId!))[0]!.llave_idempotencia).toBe(`salida:soat:${e.soatId}`);
    });

    it.each(['derecho', 'tramite_digital', 'servicios_adicionales'])('TC-21 · %s descuenta siempre (no tiene autogestión)', async (concepto) => {
      const e = await escenario({ autogestion: { soat: true, impuestos: true, logistica: true } });
      const id = await comprobante(e.tramiteId, concepto, 50_000);
      expect((await descontar(pago(id, e.tramiteId, concepto, 50_000)))!.movimientos).toHaveLength(1);
      expect(await saldo(e.bolsaId!)).toBe(950_000);
    });
  });
});

// Predicado puro: sin base.
const { gestionaConcepto, llaveDescuento } = await import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
describe('gestionaConcepto / llaveDescuento — puros', () => {
  const base = {
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    soatExcepcion: false, soatOrigen: 'tramite', impuestoExcepcion: false, logisticaExcepcion: null,
  };
  it('compañía sin autogestión gestiona todo; GMF/derecho sin autogestión', () => {
    for (const c of ['soat', 'impuesto', 'logistica', 'derecho', 'tramite_digital', 'servicios_adicionales']) expect(gestionaConcepto(c, base)).toBe(true);
  });
  it('M1 · SOAT con soatId usa la llave de ADR-0006; sin soatId, la del comprobante', () => {
    expect(llaveDescuento('soat', 'c1', 's1')).toBe('salida:soat:s1');
    expect(llaveDescuento('soat', 'c1', null)).toBe('salida:comprobante:c1');
    expect(llaveDescuento('impuesto', 'c1', 's1')).toBe('salida:comprobante:c1');
  });
});
