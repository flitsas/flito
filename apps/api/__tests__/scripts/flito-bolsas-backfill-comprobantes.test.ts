// HU #13910 (HU-E, Feature #13887, ADR-0029 D12 / Q4) — backfill de los comprobantes de pago aplicados ANTES
// del corte, contra PostgreSQL de verdad: simulación sin escritura, descuento en los dos alcances con las
// llaves del gancho, omisiones del gancho (liquidación, conciliación, inactiva, sin bolsa), idempotencia,
// corte obligatorio y una transacción por comprobante (fallo a mitad → retomable sin duplicar).
//
// Se activa con `TEST_DATABASE_URL`; sin ella se SALTA (el CI no levanta Postgres). Un `skipped` NO es verde.
// Aislamiento: los comprobantes de prueba se aplican en 2001 con corte 2001-02-01 y cada caso acota el
// recorrido a sus ids (`comprobanteIds`): el backfill nunca toca datos ajenos de la BD local.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const URL = process.env.TEST_DATABASE_URL;
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const CORTE = '2001-02-01';
/** 10-ene-2001 10:00 COT: antes del corte. */
const ANTES = '2001-01-10T15:00:00Z';
const NADA = '00000000-0000-0000-0000-000000000000';
const NOTA = 'Backfill corte comprobantes (ADR-0029)';

describe.skipIf(!URL)('HU #13910 — backfill de comprobantes aplicados antes del corte (PostgreSQL real)', () => {
  let sql: import('postgres').Sql;
  let db: typeof import('../../src/db/client.js').db;
  let env: typeof import('../../src/config/env.js').env;
  let bf: typeof import('../../src/scripts/flito-bolsas-backfill-comprobantes.js');
  let d: typeof import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
  let libro: typeof import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
  let transito: typeof import('../../src/modules/flito-bolsas/flito-bolsas-transito.service.js');
  let USER: number;
  let ctx: { userId: number; nombre: string };
  let n = 0;
  let libres: string[] = [];
  const creados = {
    clients: [] as number[], vehicles: [] as number[], tramites: [] as string[], soats: [] as string[],
    soportes: [] as string[], transito: [] as string[],
  };
  /** Datos personales sembrados: el reporte no puede contener ninguno (AC1). */
  const pii: string[] = [];

  beforeAll(async () => {
    const { default: postgres } = await import('postgres');
    sql = postgres(URL!, { max: 2 });
    ({ db } = await import('../../src/db/client.js'));
    ({ env } = await import('../../src/config/env.js'));
    bf = await import('../../src/scripts/flito-bolsas-backfill-comprobantes.js');
    d = await import('../../src/modules/flito-bolsas/flito-bolsas.descuento.js');
    libro = await import('../../src/modules/flito-bolsas/flito-bolsas.libro.js');
    transito = await import('../../src/modules/flito-bolsas/flito-bolsas-transito.service.js');
    const [u] = await sql`SELECT id, username FROM users ORDER BY id LIMIT 1`;
    USER = u!.id as number;
    pii.push(u!.username as string);
    ctx = { userId: USER, nombre: 'hu13910@flit.io' };
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
    await sql`DELETE FROM flito_bolsas_unicas_conceptos WHERE bolsa_id IN (${bolsas})`;
    await sql`DELETE FROM flito_bolsas_unicas_cobertura WHERE bolsa_id IN ${sql(tb)}`;
    await sql`DELETE FROM flito_bolsas_unicas WHERE (alcance = 'compania' AND compania_id IN ${sql(ids)}) OR id IN ${sql(tb)}`;
    const tr = creados.tramites.length ? creados.tramites : [NADA];
    await sql`DELETE FROM flito_comprobantes WHERE tramite_id IN ${sql(tr)}`;
    if (creados.soportes.length) await sql`DELETE FROM flito_soportes WHERE id IN ${sql(creados.soportes)}`;
    await sql`DELETE FROM flito_impuestos WHERE tramite_id IN ${sql(tr)}`;
    await sql`UPDATE flito_tramites SET soat_id = NULL WHERE id IN ${sql(tr)}`;
    await sql`DELETE FROM flito_tramites WHERE id IN ${sql(tr)}`;
    if (creados.soats.length) await sql`DELETE FROM flito_soat WHERE id IN ${sql(creados.soats)}`;
    if (creados.vehicles.length) await sql`DELETE FROM vehicles WHERE id IN ${sql(creados.vehicles)}`;
    await sql`DELETE FROM clients WHERE id IN ${sql(ids)}`;
    await sql.end();
  });

  beforeEach(() => { env.FLITO_BOLSAS_CORTE_COMPROBANTES = CORTE; });
  afterEach(() => { env.FLITO_BOLSAS_CORTE_COMPROBANTES = undefined; });

  // ─────────────────────────── Fixtures ───────────────────────────

  async function compania(o: { bolsa?: 'activa' | 'inactiva' | 'ninguna' } = {}): Promise<{ companiaId: number; bolsaId: string | null }> {
    n += 1;
    const sello = `${Math.floor(Math.random() * 1e9)}${n}`;
    const nombre = `HU13910 Compania ${sello}`;
    const nit = `7${sello}`.slice(0, 20);
    pii.push(nombre, nit);
    const [c] = await sql`INSERT INTO clients (name, document, soat_autogestionable, impuestos_autogestionable, logistica_autogestionable)
      VALUES (${nombre}, ${nit}, false, false, false) RETURNING id`;
    const companiaId = c!.id as number;
    creados.clients.push(companiaId);
    if (o.bolsa === 'ninguna') return { companiaId, bolsaId: null };
    const activa = o.bolsa !== 'inactiva';
    const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, compania_id, saldo, activa, inactivada_en)
      VALUES ('compania', ${companiaId}, '1000000', ${activa}, ${activa ? null : sql`now()`}) RETURNING id`;
    for (const concepto of ['soat', 'impuesto', 'derecho']) {
      await sql`INSERT INTO flito_bolsas_unicas_conceptos (bolsa_id, concepto) VALUES (${b!.id}, ${concepto})`;
    }
    return { companiaId, bolsaId: b!.id as string };
  }

  async function bolsaTransito(organismo: string, conceptos: string[]): Promise<string> {
    n += 1;
    const nombre = `Tránsito HU13910 ${n}`;
    pii.push(nombre);
    const [b] = await sql`INSERT INTO flito_bolsas_unicas (alcance, nombre, saldo, activa) VALUES ('transito', ${nombre}, '5000000', true) RETURNING id`;
    const id = b!.id as string;
    creados.transito.push(id);
    for (const concepto of conceptos) {
      await sql`INSERT INTO flito_bolsas_unicas_cobertura (bolsa_id, organismo_codigo, concepto, activa) VALUES (${id}, ${organismo}, ${concepto}, true)`;
    }
    return id;
  }

  function secretaria(): string {
    const s = libres.shift();
    if (!s) throw new Error('No quedan secretarías sin cobertura en la BD de pruebas');
    return s;
  }

  async function tramite(companiaId: number, o: { impuesto?: string; soat?: string } = {}): Promise<{ tramiteId: string; soatId: string | null }> {
    n += 1;
    const sello = `${Math.floor(Math.random() * 1e9)}${n}`;
    const placa = `Q${sello}`.slice(0, 6);
    const vinVehiculo = `W${sello}`.padEnd(17, 'Y').slice(0, 17);
    const dueno = `Propietario HU13910 ${sello}`;
    const cedula = `8${sello}`.slice(0, 12);
    const [v] = await sql`INSERT INTO vehicles (plate, vin, owner_name, owner_document)
      VALUES (${placa}, ${vinVehiculo}, ${dueno}, ${cedula}) RETURNING id`;
    pii.push(placa, vinVehiculo, dueno, cedula);
    creados.vehicles.push(v!.id as number);
    const [t] = await sql`INSERT INTO flito_tramites (id_flit, vehiculo_id, sincronizado_en, compania_id)
      VALUES (${`HU13910-${sello}`}, ${v!.id}, now(), ${companiaId}) RETURNING id`;
    const tramiteId = t!.id as string;
    creados.tramites.push(tramiteId);
    if (o.impuesto) {
      await sql`INSERT INTO flito_impuestos (tramite_id, organismo_codigo, compania_id, modalidad_aplicada, estado)
        VALUES (${tramiteId}, ${o.impuesto}, ${companiaId}, 'requiere_gestion', 'pagado')`;
    }
    let soatId: string | null = null;
    if (o.soat) {
      const vin = `V${sello}`.padEnd(17, 'X').slice(0, 17);
      pii.push(vin);
      const [s] = await sql`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, origen, organismo_codigo)
        VALUES (${vin}, ${v!.id}, ${companiaId}, 'cliente', ${o.soat}) RETURNING id`;
      soatId = s!.id as string;
      creados.soats.push(soatId);
      await sql`UPDATE flito_tramites SET soat_id = ${soatId} WHERE id = ${tramiteId}`;
    }
    return { tramiteId, soatId };
  }

  /** Comprobante de pago aplicado ANTES del corte (o en `aplicadoEn`). */
  async function comprobante(tramiteId: string, concepto: string, valor: number, aplicadoEn = ANTES): Promise<string> {
    n += 1;
    const [s] = await sql`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre)
      VALUES ('comprobante_pago', 'c.pdf', 'application/pdf', ${`hu13910/${n}.pdf`}, ${`h13910${Math.random()}${n}`.slice(0, 64)}, 10, 'test') RETURNING id`;
    creados.soportes.push(s!.id as string);
    const [c] = await sql`INSERT INTO flito_comprobantes (lote_id, soporte_id, extraccion, subido_por_id, subido_por_nombre,
        estado, tramite_id, concepto, es_pago, valor, soporte_aplicado_id, aplicado_en, aplicado_por_id, aplicado_motivo)
      VALUES (gen_random_uuid(), ${s!.id}, '{}'::jsonb, ${USER}, 'test', 'aplicado', ${tramiteId}, ${concepto}, true,
        ${String(valor)}, ${s!.id}, ${aplicadoEn}, ${USER}, 'cruce manual de prueba') RETURNING id`;
    return c!.id as string;
  }

  const movimientosDe = (ids: string[]) => sql`SELECT m.*, b.alcance, m.fecha::text AS fecha FROM flito_bolsas_unicas_movimientos m
    JOIN flito_bolsas_unicas b ON b.id = m.bolsa_id WHERE m.comprobante_id IN ${sql(ids)} ORDER BY b.alcance, m.id`;
  const correr = (comprobanteIds: string[], apply: boolean, descontar?: typeof d.descontarComprobante) =>
    bf.ejecutarBackfillComprobantes({ apply, usuarioId: USER, comprobanteIds, descontar });
  const motivos = (r: Awaited<ReturnType<typeof correr>>, id: string) =>
    r.lineas.filter((l) => l.comprobanteId === id).map((l) => `${l.alcance}:${l.resultado}:${l.motivo ?? '-'}`).sort();

  /** Impuesto antes del corte con bolsa de compañía y de tránsito que lo cubren. */
  async function impuestoCubierto(valor: number) {
    const c = await compania();
    const org = secretaria();
    const tb = await bolsaTransito(org, ['impuesto']);
    const t = await tramite(c.companiaId, { impuesto: org });
    const id = await comprobante(t.tramiteId, 'impuesto', valor);
    return { c, org, tb, t, id };
  }

  // ─────────────────────────── AC ───────────────────────────

  it('AC1 · sin --apply no escribe ningún movimiento y reporta id, alcance, bolsa, concepto, valor y motivo, sin PII', async () => {
    const a = await impuestoCubierto(150_000);
    const sinBolsa = await compania({ bolsa: 'ninguna' });
    const tOmitido = await tramite(sinBolsa.companiaId, { soat: secretaria() });
    const omitido = await comprobante(tOmitido.tramiteId, 'soat', 90_000);

    const r = await correr([a.id, omitido], false);

    expect(await movimientosDe([a.id, omitido])).toHaveLength(0);
    expect(r.apply).toBe(false);
    expect(r.comprobantes).toBe(2);
    expect(r.lineas).toEqual(expect.arrayContaining([
      expect.objectContaining({ comprobanteId: a.id, alcance: 'compania', bolsaId: a.c.bolsaId, concepto: 'impuesto', valor: 150_000, resultado: 'descontado', motivo: null }),
      expect.objectContaining({ comprobanteId: a.id, alcance: 'transito', bolsaId: a.tb, concepto: 'impuesto', valor: 150_000, resultado: 'descontado', motivo: null }),
      expect.objectContaining({ comprobanteId: omitido, alcance: 'compania', bolsaId: null, concepto: 'soat', valor: 90_000, resultado: 'omitido', motivo: 'sin_bolsa' }),
    ]));
    const texto = [JSON.stringify(r), ...bf.formatearReporte(r)].join('\n');
    expect(texto).toContain(a.id);
    expect(texto).toContain('SIMULACIÓN');
    for (const dato of pii) expect(texto).not.toContain(dato);
  });

  it('AC2 · --apply descuenta impuesto antes del corte: una salida en compañía y otra en tránsito con las llaves del comprobante', async () => {
    const a = await impuestoCubierto(200_000);

    const r = await correr([a.id], true);

    const movs = await movimientosDe([a.id]);
    expect(movs).toHaveLength(2);
    const [mc, mt] = movs;
    expect(mc).toMatchObject({
      alcance: 'compania', bolsa_id: a.c.bolsaId, tipo: 'salida', origen: 'comprobante', concepto: 'impuesto',
      llave_idempotencia: `salida:comprobante:${a.id}`, observacion: NOTA, registrado_por_id: USER, fecha: libro.hoyIso(),
    });
    expect(mt).toMatchObject({
      alcance: 'transito', bolsa_id: a.tb, tipo: 'salida', origen: 'comprobante', concepto: 'impuesto', organismo_codigo: a.org,
      llave_idempotencia: `consumo:comprobante:${a.id}`, observacion: NOTA, registrado_por_id: USER, fecha: libro.hoyIso(),
    });
    expect(Number(mc!.valor)).toBe(200_000);
    expect(Number(mt!.valor)).toBe(200_000);
    expect(motivos(r, a.id)).toEqual(['compania:descontado:-', 'transito:descontado:-']);
  });

  it('AC3 · liquidación viva del mismo concepto → cubierto_por_liquidacion; SOAT ya conciliado → cubierto_por_conciliacion; ningún movimiento', async () => {
    const c = await compania();
    const org = secretaria();
    const tbImp = await bolsaTransito(org, ['impuesto', 'soat']);
    expect(tbImp).toBeTruthy();
    const tLiq = await tramite(c.companiaId, { impuesto: org });
    const tSoat = await tramite(c.companiaId, { soat: org });
    const hoy = libro.hoyIso();
    await db.transaction(async (tx) => {
      await libro.asentarSiHayBolsa(tx, c.companiaId, {
        tipo: 'salida', origen: 'automatico', valor: 120_000, fecha: hoy, concepto: 'impuesto',
        tramiteId: tLiq.tramiteId, llaveIdempotencia: `salida:tramite:${tLiq.tramiteId}:impuesto`, etiqueta: 'salida',
      }, ctx);
      await transito.registrarConsumoTransito(tx, {
        organismoCodigo: org, concepto: 'impuesto', tramiteId: tLiq.tramiteId, valor: 120_000, fecha: hoy,
        llave: `tramite:${tLiq.tramiteId}:impuesto`,
      }, ctx);
      await libro.asentarSiHayBolsa(tx, c.companiaId, {
        tipo: 'salida', origen: 'conciliacion', valor: 300_000, fecha: hoy, concepto: 'soat',
        organismoCodigo: org, tramiteId: null, llaveIdempotencia: `salida:soat:${tSoat.soatId}`, etiqueta: 'salida',
      }, ctx);
      await transito.registrarConsumoTransito(tx, {
        organismoCodigo: org, concepto: 'soat', tramiteId: null, valor: 300_000, fecha: hoy,
        llave: `soat:${tSoat.soatId}`, origen: 'conciliacion',
      }, ctx);
    });
    const kLiq = await comprobante(tLiq.tramiteId, 'impuesto', 120_000);
    const kSoat = await comprobante(tSoat.tramiteId, 'soat', 300_000);

    const r = await correr([kLiq, kSoat], true);

    expect(await movimientosDe([kLiq, kSoat])).toHaveLength(0);
    expect(motivos(r, kLiq)).toEqual(['compania:omitido:cubierto_por_liquidacion', 'transito:omitido:cubierto_por_liquidacion']);
    expect(motivos(r, kSoat)).toEqual(['compania:omitido:cubierto_por_conciliacion', 'transito:omitido:cubierto_por_conciliacion']);
  });

  it('AC4 · ya ejecutado con --apply, otra vez con --apply → ningún movimiento nuevo', async () => {
    const a = await impuestoCubierto(80_000);
    await correr([a.id], true);
    const antes = (await movimientosDe([a.id])).map((m) => m.id as string);
    expect(antes).toHaveLength(2);

    const r = await correr([a.id], true);

    expect((await movimientosDe([a.id])).map((m) => m.id as string)).toEqual(antes);
    expect(motivos(r, a.id)).toEqual(['compania:ya_descontado:-', 'transito:ya_descontado:-']);
    expect(r.lineas.filter((l) => l.resultado === 'descontado')).toHaveLength(0);
  });

  it('AC5 · sin FLITO_BOLSAS_CORTE_COMPROBANTES → error que dice que falta la fecha de corte; no lee ni escribe', async () => {
    const a = await impuestoCubierto(70_000);
    env.FLITO_BOLSAS_CORTE_COMPROBANTES = undefined;
    const descontar = vi.fn(d.descontarComprobante);
    const select = vi.spyOn(db, 'select');
    try {
      await expect(correr([a.id], true, descontar)).rejects.toThrow(/falta la fecha de corte/i);
      expect(select).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
    expect(descontar).not.toHaveBeenCalled();
    expect(await movimientosDe([a.id])).toHaveLength(0);
  });

  it('AC6 · concepto solo cubierto por bolsa inactiva y otro sin bolsa → ningún movimiento; reporte "inactiva" y "sin_bolsa"', async () => {
    const cIn = await compania({ bolsa: 'inactiva' });
    const tIn = await tramite(cIn.companiaId, { impuesto: secretaria() });
    const kIn = await comprobante(tIn.tramiteId, 'impuesto', 50_000);
    const cSin = await compania({ bolsa: 'ninguna' });
    const tSin = await tramite(cSin.companiaId, { impuesto: secretaria() });
    const kSin = await comprobante(tSin.tramiteId, 'impuesto', 60_000);

    const r = await correr([kIn, kSin], true);

    expect(await movimientosDe([kIn, kSin])).toHaveLength(0);
    expect(r.lineas.filter((l) => l.resultado !== 'omitido')).toHaveLength(0);
    expect(motivos(r, kIn)).toContain('compania:omitido:inactiva');
    expect(motivos(r, kSin)).toContain('compania:omitido:sin_bolsa');
  });

  it('AC7 · falla a mitad: los anteriores quedan completos, el fallido sin movimientos; al re-ejecutar sigue sin duplicar', async () => {
    const a = await impuestoCubierto(10_000);
    const b = await impuestoCubierto(20_000);
    const c = await impuestoCubierto(30_000);
    // Orden de recorrido determinista: por `aplicado_en`.
    await sql`UPDATE flito_comprobantes SET aplicado_en = ${'2001-01-05T15:00:00Z'} WHERE id = ${a.id}`;
    await sql`UPDATE flito_comprobantes SET aplicado_en = ${'2001-01-06T15:00:00Z'} WHERE id = ${b.id}`;
    await sql`UPDATE flito_comprobantes SET aplicado_en = ${'2001-01-07T15:00:00Z'} WHERE id = ${c.id}`;
    // El fallo llega DESPUÉS de escribir los dos lados de `b`: la tx tiene que deshacerlos.
    const falla: typeof d.descontarComprobante = async (tx, comp, cx, o) => {
      const r = await d.descontarComprobante(tx, comp, cx, o);
      if (comp.comprobanteId === b.id) throw new Error('caída simulada');
      return r;
    };

    await expect(correr([a.id, b.id, c.id], true, falla)).rejects.toThrow('caída simulada');

    expect(await movimientosDe([a.id])).toHaveLength(2);
    expect(await movimientosDe([b.id, c.id])).toHaveLength(0);
    const deA = (await movimientosDe([a.id])).map((m) => m.id as string);

    const r = await correr([a.id, b.id, c.id], true);

    expect((await movimientosDe([a.id])).map((m) => m.id as string)).toEqual(deA);
    expect(await movimientosDe([b.id])).toHaveLength(2);
    expect(await movimientosDe([c.id])).toHaveLength(2);
    expect(motivos(r, a.id)).toEqual(['compania:ya_descontado:-', 'transito:ya_descontado:-']);
    expect(motivos(r, b.id)).toEqual(['compania:descontado:-', 'transito:descontado:-']);
  });

  it('el gancho normal (sin backfill) sigue devolviendo antes_del_corte para ese mismo comprobante', async () => {
    const a = await impuestoCubierto(40_000);
    const r = await db.transaction((tx) => d.descontarComprobante(tx, {
      comprobanteId: a.id, tramiteId: a.t.tramiteId, concepto: 'impuesto' as never, esPago: true, valor: '40000', aplicadoEn: new Date(ANTES),
    }, ctx));
    expect(r).toEqual({ movimientos: [], omitidos: [{ alcance: 'compania', motivo: 'antes_del_corte' }, { alcance: 'transito', motivo: 'antes_del_corte' }], alertas: [] });
    expect(await movimientosDe([a.id])).toHaveLength(0);
  });

  it('un comprobante aplicado desde el corte no es candidato del backfill', async () => {
    const c = await compania();
    const t = await tramite(c.companiaId, { impuesto: secretaria() });
    const k = await comprobante(t.tramiteId, 'impuesto', 10_000, '2001-02-01T15:00:00Z');
    const r = await correr([k], true);
    expect(r.comprobantes).toBe(0);
    expect(await movimientosDe([k])).toHaveLength(0);
  });
});
