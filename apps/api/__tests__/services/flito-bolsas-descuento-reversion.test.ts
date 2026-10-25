// HU #13905 (Feature #13886, ADR-0029 D13/D14, Q7) — revertir el descuento de la bolsa de COMPAÑÍA al
// desaplicar o reemplazar un comprobante, y bloquear si el periodo IMPUTADO de la salida está cerrado.
// `exigirDescuentoReversible` + `revertirDescuentoComprobante` de `flito-bolsas.descuento.ts`, contra
// PostgreSQL de verdad; AC1/AC2 además por `desaplicar`/`reemplazar` reales de `flito-comprobantes`.
//
// Se activa con `TEST_DATABASE_URL`; sin ella se SALTA (el CI no levanta Postgres). Un `skipped` NO es verde.
// Cada caso crea su compañía, bolsa, trámite y comprobantes; todo se borra en `afterAll` (cierres incluidos).
// Reloj fijo (`vi.useFakeTimers({ toFake: ['Date'] })`): el libro rechaza fechas futuras y el corte
// 2026-12-01 aún no ha llegado.
//
// Mutantes que estos tests matan (matriz QA A):
//   · M1 D14 por `fecha` en vez de por `periodo` imputado → TC-07 cae.
//   · M2 sin la exención de `compensacion` → TC-17 cae.
//   · M3 exigir que mira solo la primera salida → TC-06 cae.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const URL = process.env.TEST_DATABASE_URL;
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const CORTE = '2026-12-01';
/** 03-dic-2026 10:00 COT. */
const DIC_3 = new Date('2026-12-03T15:00:00Z');
/** 29-nov-2026 10:00 COT. */
const NOV_29 = new Date('2026-11-29T15:00:00Z');
/** 05-ene-2027 10:00 COT: diciembre ya terminó y se puede cerrar. */
const ENE_5 = new Date('2027-01-05T15:00:00Z');
const MOTIVO = 'Se aplicó al trámite equivocado';

describe.skipIf(!URL)('HU #13905 — reversión del descuento y periodo cerrado (PostgreSQL real)', () => {
  let sql: import('postgres').Sql;
  let db: typeof import('../../src/db/client.js').db;
  let corte: import('../helpers/corte-bolsas.js').CorteDePrueba;
  let d: typeof import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
  let comp: typeof import('../../src/modules/flito-comprobantes/flito-comprobantes.desaplicar.js');
  let USER: number;
  let ctx: { userId: number; nombre: string };
  let cctx: { userId: number; username: string; role: string };
  let n = 0;
  const creados = { clients: [] as number[], vehicles: [] as number[], tramites: [] as string[], soats: [] as string[], soportes: [] as string[] };

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL!, { max: 2 });
    ({ db } = await import('../../src/db/client.js'));
    corte = (await import('../helpers/corte-bolsas.js')).corteDePrueba(sql);
    d = await import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
    comp = await import('../../src/modules/flito-comprobantes/flito-comprobantes.desaplicar.js');
    const [u] = await sql`SELECT id FROM users ORDER BY id LIMIT 1`;
    USER = u!.id as number;
    ctx = { userId: USER, nombre: 'hu13905@flit.io' };
    cctx = { userId: USER, username: 'hu13905@flit.io', role: 'financiera' };
  });

  afterAll(async () => {
    if (!sql) return;
    await corte.restaurar();
    const ids = creados.clients.length ? creados.clients : [-1];
    const bolsas = sql`SELECT id FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id IN ${sql(ids)}`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE revierte_movimiento_id IS NOT NULL AND bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_movimientos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_cierres WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_conceptos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas WHERE alcance = 'compania' AND compania_id IN ${sql(ids)}`;
    const tr = creados.tramites.length ? creados.tramites : ['00000000-0000-0000-0000-000000000000'];
    const imps = sql`SELECT id::text FROM flito_impuestos WHERE tramite_id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_estado_historial WHERE registro_id::text IN (${imps})`;
    await sql`DELETE FROM audit_logs WHERE resource = 'flito_impuesto' AND resource_id::text IN (${imps})`;
    await sql`DELETE FROM flito_comprobantes WHERE tramite_id IN ${sql(tr)} OR soporte_id IN ${sql(creados.soportes.length ? creados.soportes : ['00000000-0000-0000-0000-000000000000'])}`;
    if (creados.soportes.length) await sql`DELETE FROM flito_soportes WHERE id IN ${sql(creados.soportes)}`;
    await sql`DELETE FROM flito_impuestos WHERE tramite_id IN ${sql(tr)}`;
    await sql`UPDATE flito_tramites SET soat_id = NULL WHERE id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_tramites WHERE id IN ${sql(tr)}`;
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

  interface Escenario { companiaId: number; bolsaId: string; tramiteId: string; soatId: string | null }

  async function bolsaDe(companiaId: number, saldo = 1_000_000): Promise<string> {
    const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, compania_id, saldo, activa)
      VALUES ('compania', ${companiaId}, ${String(saldo)}, true) RETURNING id`;
    for (const concepto of ['soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'servicios_adicionales']) {
      await sql`INSERT INTO flito_bolsas_unicas_conceptos (bolsa_id, concepto) VALUES (${b!.id}, ${concepto})`;
    }
    return b!.id as string;
  }

  async function escenario(o: { soat?: boolean; impuestoPagado?: boolean } = {}): Promise<Escenario> {
    n += 1;
    // El reloj está fijo: `Date.now()` repetiría el sello entre corridas (id_flit y document son únicos).
    const sello = `${Math.floor(Math.random() * 1e9)}${n}`;
    // 0252 cambió el default de `*_autogestionable` a true: estos casos son de una compañía que NO autogestiona.
    const [c] = await sql`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
      VALUES (${`HU13905 ${sello}`}, ${`9${sello}`.slice(0, 20)}, false, false, false) RETURNING id`;
    const companiaId = c!.id as number;
    creados.clients.push(companiaId);
    const bolsaId = await bolsaDe(companiaId);
    const [v] = await sql`INSERT INTO vehicles DEFAULT VALUES RETURNING id`;
    creados.vehicles.push(v!.id as number);
    const [t] = await sql`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id)
      VALUES (${`HU13905-${sello}`}, ${v!.id}, now(), ${companiaId}) RETURNING id`;
    const tramiteId = t!.id as string;
    creados.tramites.push(tramiteId);
    let soatId: string | null = null;
    if (o.soat) {
      const [s] = await sql`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, origen)
        VALUES (${`W${sello}`.slice(0, 17)}, ${v!.id}, ${companiaId}, 'cliente') RETURNING id`;
      soatId = s!.id as string;
      creados.soats.push(soatId);
      await sql`UPDATE flito_tramites SET soat_id = ${soatId} WHERE id = ${tramiteId}`;
    }
    if (o.impuestoPagado) {
      await sql`INSERT INTO flito_impuestos (tramite_id, organismo_codigo, compania_id, modalidad_aplicada, estado)
        VALUES (${tramiteId}, '05001', ${companiaId}, 'requiere_gestion', 'pagado')`;
    }
    return { companiaId, bolsaId, tramiteId, soatId };
  }

  /** Un comprobante del trámite: `aplicado` como pago (por defecto) o `pendiente` (reemplazo). */
  async function comprobante(tramiteId: string | null, concepto: string | null, valor: number | null, estado: 'aplicado' | 'pendiente' = 'aplicado'): Promise<string> {
    n += 1;
    const [s] = await sql`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
      VALUES ('comprobante_pago', 'c.pdf', 'application/pdf', ${`hu13905/${n}.pdf`}, ${`h13905${Math.random()}${n}`.slice(0, 64)}, 10, 'test') RETURNING id`;
    creados.soportes.push(s!.id as string);
    const [c] = estado === 'aplicado'
      ? await sql`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre,
          estado, tramite_id, concepto, es_pago, valor, aplicado_en, aplicado_por_id)
        VALUES (gen_random_uuid(), ${s!.id}, '{}'::jsonb, ${USER}, 'test', 'aplicado', ${tramiteId}, ${concepto}, true,
          ${valor === null ? null : String(valor)}, now(), ${USER}) RETURNING id`
      : await sql`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre, estado, motivo_pendiente)
        VALUES (gen_random_uuid(), ${s!.id}, '{}'::jsonb, ${USER}, 'test', 'pendiente', 'leido') RETURNING id`;
    return c!.id as string;
  }

  const pago = (comprobanteId: string, tramiteId: string, concepto: string, valor: number, aplicadoEn = DIC_3) =>
    ({ comprobanteId, tramiteId, concepto: concepto as never, esPago: true, valor: String(valor), aplicadoEn });
  const descontar = (c: ReturnType<typeof pago>) => db.transaction((tx) => d.descontarComprobante(tx, c, ctx));
  const exigir = (id: string) => db.transaction((tx) => d.exigirDescuentoReversible(tx, id));
  const revertir = (id: string, compensacion?: boolean) =>
    db.transaction((tx) => d.revertirDescuentoComprobante(tx, id, ctx, { motivo: MOTIVO, ...(compensacion ? { compensacion } : {}) }));
  /** Lo que hace `desaplicarEnTx` con la bolsa: guarda → reversión, en la misma tx. */
  const desaplicarBolsa = (id: string) => db.transaction(async (tx) => {
    await d.exigirDescuentoReversible(tx, id);
    return d.revertirDescuentoComprobante(tx, id, ctx, { motivo: MOTIVO });
  });
  const movimientos = (bolsaId: string) => sql`SELECT *, fecha::text AS fecha FROM flito_bolsas_unicas_movimientos WHERE bolsa_id = ${bolsaId} ORDER BY created_at, tipo DESC, id`;
  const saldo = async (bolsaId: string) => Number((await sql`SELECT saldo FROM flito_bolsas_unicas WHERE id = ${bolsaId}`)[0]!.saldo);
  const cerrar = (bolsaId: string, periodo: string) => sql`INSERT INTO flito_bolsas_unicas_cierres
      (bolsa_id, periodo, saldo_inicial, total_entradas, total_salidas, saldo_final, movimientos, cerrado_por_nombre)
    VALUES (${bolsaId}, ${periodo}, 0, 0, 0, 0, 0, 'hu13905')`;
  const estadoComprobante = async (id: string) => (await sql`SELECT estado, tramite_id FROM flito_comprobantes WHERE id = ${id}`)[0]!;

  // ─────────────────────────── AC1 ───────────────────────────

  describe('AC1 — desaplicar devuelve el descuento', () => {
    it('TC-01 · impuesto 250.000 en mes abierto → entrada 250.000 enlazada, saldo de vuelta, llave original rev:…', async () => {
      const e = await escenario({ impuestoPagado: true });
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      await descontar(pago(id, e.tramiteId, 'impuesto', 250_000));
      expect(await saldo(e.bolsaId)).toBe(750_000);
      const [salida] = await movimientos(e.bolsaId);

      await comp.desaplicar(id, { destino: 'pendiente', motivo: MOTIVO }, cctx);

      const filas = await movimientos(e.bolsaId);
      expect(filas).toHaveLength(2);
      const entrada = filas.find((f) => f.tipo === 'entrada')!;
      expect(entrada).toMatchObject({ origen: 'comprobante', revierte_movimiento_id: salida!.id, comprobante_id: id, periodo: '2026-12' });
      expect(Number(entrada.valor)).toBe(250_000);
      expect(filas.find((f) => f.id === salida!.id)!.llave_idempotencia).toBe(`rev:salida:comprobante:${id}`);
      expect(await saldo(e.bolsaId)).toBe(1_000_000);
      expect((await estadoComprobante(id)).estado).toBe('pendiente');
    });
  });

  // ─────────────────────────── AC2 / D14 ───────────────────────────

  describe('AC2 — periodo imputado cerrado bloquea sin cambios', () => {
    async function descontadoEnDiciembreCerrado() {
      const e = await escenario({ impuestoPagado: true });
      const id = await comprobante(e.tramiteId, 'impuesto', 250_000);
      await descontar(pago(id, e.tramiteId, 'impuesto', 250_000));
      vi.setSystemTime(ENE_5);
      await cerrar(e.bolsaId, '2026-12');
      // HU #13904: bolsa de compañía (`nombre` NULL) → el nombre visible es el del cliente.
      const [cli] = await sql`SELECT name FROM clients WHERE id = ${e.companiaId}`;
      return { e, id, bolsaNombre: cli!.name as string };
    }

    it('TC-03 · exigirDescuentoReversible lanza PeriodoCerradoError {bolsaId, periodo:"2026-12"}', async () => {
      const { e, id, bolsaNombre } = await descontadoEnDiciembreCerrado();
      const err = await exigir(id).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(d.PeriodoCerradoError);
      expect(err).toMatchObject({ bolsaId: e.bolsaId, bolsaNombre, periodo: '2026-12' });
    });

    it('TC-04 · desaplicar → 409 periodo_cerrado; comprobante sigue aplicado, impuesto sigue pagado, bolsa sin movimientos', async () => {
      const { e, id, bolsaNombre } = await descontadoEnDiciembreCerrado();
      const err = await comp.desaplicar(id, { destino: 'pendiente', motivo: MOTIVO }, cctx).catch((x: unknown) => x) as { status: number; cuerpo: () => unknown };
      expect(err.status).toBe(409);
      expect(err.cuerpo()).toMatchObject({ codigo: 'periodo_cerrado', bolsaId: e.bolsaId, bolsaNombre, periodo: '2026-12' });
      expect(await estadoComprobante(id)).toMatchObject({ estado: 'aplicado', tramite_id: e.tramiteId });
      expect((await sql`SELECT estado FROM flito_impuestos WHERE tramite_id = ${e.tramiteId}`)[0]!.estado).toBe('pagado');
      expect(await movimientos(e.bolsaId)).toHaveLength(1);
      expect(await saldo(e.bolsaId)).toBe(750_000);
    });

    it('TC-05 · reemplazar → 409 periodo_cerrado; original aplicado, reemplazo pendiente, bolsa sin movimientos', async () => {
      const { e, id, bolsaNombre } = await descontadoEnDiciembreCerrado();
      const reemplazoId = await comprobante(null, null, null, 'pendiente');
      const err = await comp.reemplazar(id, { reemplazoId, motivo: MOTIVO }, cctx).catch((x: unknown) => x) as { status: number; cuerpo: () => unknown };
      expect(err.status).toBe(409);
      expect(err.cuerpo()).toMatchObject({ codigo: 'periodo_cerrado', bolsaId: e.bolsaId, bolsaNombre, periodo: '2026-12' });
      expect((await estadoComprobante(id)).estado).toBe('aplicado');
      expect((await estadoComprobante(reemplazoId)).estado).toBe('pendiente');
      expect((await sql`SELECT estado FROM flito_impuestos WHERE tramite_id = ${e.tramiteId}`)[0]!.estado).toBe('pagado');
      expect(await movimientos(e.bolsaId)).toHaveLength(1);
    });

    it('TC-06 · varias salidas en bolsas distintas, solo la ÚLTIMA (en el orden de lectura) cerrada → exigir bloquea y nada se mueve (todo o nada)', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 100_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 100_000));
      // Segunda salida viva del mismo comprobante en otra bolsa (otra compañía).
      const [c2] = await sql`INSERT INTO clients (name, document) VALUES (${`HU13905 b2 ${n}`}, ${`7${Math.floor(Math.random() * 1e9)}${n}`.slice(0, 20)}) RETURNING id`;
      creados.clients.push(c2!.id as number);
      const bolsa2 = await bolsaDe(c2!.id as number);
      await sql`INSERT INTO flito_bolsas_unicas_movimientos (bolsa_id, tipo, origen, valor, saldo_resultante, periodo, fecha,
          registrado_por_nombre, comprobante_id, tramite_id, concepto, llave_idempotencia)
        VALUES (${bolsa2}, 'salida', 'comprobante', 50000, 950000, '2026-12', '2026-12-03', 't', ${id}, ${e.tramiteId}, 'derecho',
          ${`salida:comprobante:${id}:b2`})`;
      await sql`UPDATE flito_bolsas_unicas SET saldo = 950000 WHERE id = ${bolsa2}`;
      // `salidasVivasDe` ordena por bolsa_id (uuid = orden del hex en minúsculas): se cierra la bolsa que se
      // lee DE ÚLTIMA, para que una guarda que mire solo la primera salida (M3) no la vea.
      const [abierta, cerrada] = [e.bolsaId, bolsa2].sort();
      vi.setSystemTime(ENE_5);
      await cerrar(cerrada!, '2026-12');

      await expect(exigir(id)).rejects.toMatchObject({ bolsaId: cerrada, periodo: '2026-12' });
      await expect(exigir(id)).rejects.toBeInstanceOf(d.PeriodoCerradoError);
      expect(await movimientos(abierta!)).toHaveLength(1);
      expect(await movimientos(cerrada!)).toHaveLength(1);
      expect(await saldo(e.bolsaId)).toBe(900_000);
      expect(await saldo(bolsa2)).toBe(950_000);
      // Guarda + reversión en la misma tx (lo que hace desaplicarEnTx): tampoco mueve nada.
      await expect(desaplicarBolsa(id)).rejects.toMatchObject({ bolsaId: cerrada, periodo: '2026-12' });
      // La revertir directa (sin compensación) también se niega: la guarda vive en las dos.
      await expect(revertir(id)).rejects.toBeInstanceOf(d.PeriodoCerradoError);
      expect(await movimientos(abierta!)).toHaveLength(1);
      expect(await movimientos(cerrada!)).toHaveLength(1);
    });

    it('TC-07 · salida con fecha 29-nov imputada a 2026-12 (nov cerrado) → D14 mira el periodo imputado: no bloquea', async () => {
      await corte.fijar('2026-11-01');
      const e = await escenario();
      await cerrar(e.bolsaId, '2026-11');
      const id = await comprobante(e.tramiteId, 'derecho', 80_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 80_000, NOV_29));
      const [salida] = await movimientos(e.bolsaId);
      expect(salida).toMatchObject({ fecha: '2026-11-29', periodo: '2026-12' });

      await expect(exigir(id)).resolves.toBeUndefined();
      const r = await desaplicarBolsa(id);
      expect(r).toHaveLength(1);
      expect(await saldo(e.bolsaId)).toBe(1_000_000);
    });

    it('TC-14 · salida ya revertida y periodo cerrado después → no bloquea (no hay salida viva) ni duplica', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 60_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 60_000));
      await revertir(id);
      vi.setSystemTime(ENE_5);
      await cerrar(e.bolsaId, '2026-12');
      await expect(exigir(id)).resolves.toBeUndefined();
      expect(await desaplicarBolsa(id)).toHaveLength(0);
      expect(await movimientos(e.bolsaId)).toHaveLength(2);
      expect(await saldo(e.bolsaId)).toBe(1_000_000);
    });
  });

  // ─────────────────────────── AC3 / AC4 ───────────────────────────

  describe('AC3 — reemplazar devuelve y vuelve a descontar por el valor nuevo', () => {
    it('TC-08 · descontó 200.000, reemplazo de 210.000 → entrada 200.000 enlazada + salida 210.000 del reemplazo; saldo neto −210.000', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'impuesto', 200_000);
      await descontar(pago(id, e.tramiteId, 'impuesto', 200_000));
      const [salida] = await movimientos(e.bolsaId);
      const rid = await comprobante(e.tramiteId, 'impuesto', 210_000);
      // Lo que hace `reemplazar` en su tx: desaplicar el original (guarda + reversión) y aplicar el reemplazo.
      await db.transaction(async (tx) => {
        await d.exigirDescuentoReversible(tx, id);
        await d.revertirDescuentoComprobante(tx, id, ctx, { motivo: MOTIVO });
        await d.descontarComprobante(tx, pago(rid, e.tramiteId, 'impuesto', 210_000), ctx);
      });
      const filas = await movimientos(e.bolsaId);
      expect(filas).toHaveLength(3);
      const entrada = filas.find((f) => f.tipo === 'entrada')!;
      expect(entrada).toMatchObject({ revierte_movimiento_id: salida!.id, comprobante_id: id });
      expect(Number(entrada.valor)).toBe(200_000);
      const nueva = filas.find((f) => f.tipo === 'salida' && f.comprobante_id === rid)!;
      expect(Number(nueva.valor)).toBe(210_000);
      expect(nueva.llave_idempotencia).toBe(`salida:comprobante:${rid}`);
      expect(await saldo(e.bolsaId)).toBe(790_000);
    });
  });

  describe('AC4 — reemplazar SOAT reutiliza la llave de ADR-0006', () => {
    it('TC-09 · original salida:soat:<soatId> → rev:salida:soat:<soatId>; la nueva toma salida:soat:<soatId>', async () => {
      const e = await escenario({ soat: true });
      const id = await comprobante(e.tramiteId, 'soat', 900_000);
      await descontar(pago(id, e.tramiteId, 'soat', 900_000));
      const [salida] = await movimientos(e.bolsaId);
      expect(salida!.llave_idempotencia).toBe(`salida:soat:${e.soatId}`);
      const rid = await comprobante(e.tramiteId, 'soat', 950_000);
      const r = await db.transaction(async (tx) => {
        await d.exigirDescuentoReversible(tx, id);
        await d.revertirDescuentoComprobante(tx, id, ctx, { motivo: MOTIVO });
        return d.descontarComprobante(tx, pago(rid, e.tramiteId, 'soat', 950_000), ctx);
      });
      expect(r!.omitidos.filter((o) => o.alcance === 'compania')).toEqual([]);
      const filas = await movimientos(e.bolsaId);
      expect(filas.find((f) => f.id === salida!.id)!.llave_idempotencia).toBe(`rev:salida:soat:${e.soatId}`);
      const nueva = filas.find((f) => f.tipo === 'salida' && f.comprobante_id === rid)!;
      expect(nueva.llave_idempotencia).toBe(`salida:soat:${e.soatId}`);
      expect(await saldo(e.bolsaId)).toBe(50_000);
    });
  });

  // ─────────────────────────── AC5 ───────────────────────────

  describe('AC5 — la bolsa inactiva admite la reversión', () => {
    it('TC-10 · entrada en la bolsa inactiva, saldo restituido, sigue inactiva', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 300_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 300_000));
      await sql`UPDATE flito_bolsas_unicas SET activa = false, inactivada_en = now() WHERE id = ${e.bolsaId}`;
      const r = await desaplicarBolsa(id);
      expect(r).toHaveLength(1);
      expect(await saldo(e.bolsaId)).toBe(1_000_000);
      expect((await sql`SELECT activa FROM flito_bolsas_unicas WHERE id = ${e.bolsaId}`)[0]!.activa).toBe(false);
    });

    it('TC-11 · bolsa inactiva con el periodo cerrado → sí bloquea (Q7 no exime de D14)', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 300_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 300_000));
      await sql`UPDATE flito_bolsas_unicas SET activa = false, inactivada_en = now() WHERE id = ${e.bolsaId}`;
      vi.setSystemTime(ENE_5);
      await cerrar(e.bolsaId, '2026-12');
      await expect(desaplicarBolsa(id)).rejects.toMatchObject({ bolsaId: e.bolsaId, periodo: '2026-12' });
      expect(await movimientos(e.bolsaId)).toHaveLength(1);
    });
  });

  // ─────────────────────────── AC6 ───────────────────────────

  describe('AC6 — no se revierte dos veces', () => {
    it('TC-12 · la segunda reversión no crea entrada ni cambia el saldo', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 120_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 120_000));
      expect(await desaplicarBolsa(id)).toHaveLength(1);
      expect(await desaplicarBolsa(id)).toHaveLength(0);
      expect(await movimientos(e.bolsaId)).toHaveLength(2);
      expect(await saldo(e.bolsaId)).toBe(1_000_000);
    });
  });

  // ─────────────────────────── AC7 ───────────────────────────

  describe('AC7 — el comprobante que no descontó no mueve bolsas', () => {
    it('TC-13 · aplicado antes del corte → desaplicar sin movimientos', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 120_000);
      const r = await descontar(pago(id, e.tramiteId, 'derecho', 120_000, NOV_29));
      expect(r!.omitidos[0]!.motivo).toBe('antes_del_corte');
      await expect(exigir(id)).resolves.toBeUndefined();
      expect(await desaplicarBolsa(id)).toHaveLength(0);
      expect(await movimientos(e.bolsaId)).toHaveLength(0);
      expect(await saldo(e.bolsaId)).toBe(1_000_000);
    });

    it('TC-13 · impuesto aplicado sin bolsa que cubra (antes del corte) → desaplicar real sin movimientos', async () => {
      const e = await escenario({ impuestoPagado: true });
      const id = await comprobante(e.tramiteId, 'impuesto', 120_000);
      await comp.desaplicar(id, { destino: 'pendiente', motivo: MOTIVO }, cctx);
      expect(await movimientos(e.bolsaId)).toHaveLength(0);
      expect((await estadoComprobante(id)).estado).toBe('pendiente');
    });
  });

  // ─────────────────────────── AC8 ───────────────────────────

  describe('AC8 — la compensación no se bloquea por periodo', () => {
    it('TC-17 · salida en 2026-12 cerrado + compensacion:true → revierte sin periodo_cerrado; entrada en 2027-01', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 250_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 250_000));
      const [salida] = await movimientos(e.bolsaId);
      vi.setSystemTime(ENE_5);
      await cerrar(e.bolsaId, '2026-12');
      const r = await revertir(id, true);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ periodo: '2027-01', revierteMovimientoId: salida!.id });
      expect(await saldo(e.bolsaId)).toBe(1_000_000);
    });

    it('TC-18 · la entrada de compensación salta al primer periodo abierto aunque la fecha caiga en el cerrado', async () => {
      const e = await escenario();
      const id = await comprobante(e.tramiteId, 'derecho', 40_000);
      await descontar(pago(id, e.tramiteId, 'derecho', 40_000));
      vi.setSystemTime(ENE_5);
      await cerrar(e.bolsaId, '2026-12');
      await revertir(id, true);
      const entrada = (await movimientos(e.bolsaId)).find((f) => f.tipo === 'entrada')!;
      expect(entrada).toMatchObject({ periodo: '2027-01', fecha: '2027-01-05' });
      // Sin compensación, la misma situación (otro comprobante) sí bloquea.
      vi.setSystemTime(DIC_3);
      const e2 = await escenario();
      const id2 = await comprobante(e2.tramiteId, 'derecho', 40_000);
      await descontar(pago(id2, e2.tramiteId, 'derecho', 40_000));
      vi.setSystemTime(ENE_5);
      await cerrar(e2.bolsaId, '2026-12');
      await expect(revertir(id2)).rejects.toBeInstanceOf(d.PeriodoCerradoError);
    });
  });
});
