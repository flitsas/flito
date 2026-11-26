/**
 * Épica #14707 (ADR-0049) — descarte de un trámite muerto, contra PostgreSQL de verdad.
 *
 * Todo corre dentro de una transacción de Drizzle que termina en ROLLBACK (patrón de `helpers/base-en-tx.ts`):
 * la base local no se ensucia. Se activa con `TEST_DATABASE_URL` sobre una base con las migraciones 0317-0319
 * aplicadas; sin ella el archivo se SALTA (el CI no levanta Postgres).
 *
 * Cubre: D3a (pagado originado por el muerto: descartado + vivos desligados y rearrancados), decisión cerrada 1
 * (un vivo que ya lo consumió lo conserva), D3b + D9 (abierto compartido hereda compañía/organismo), D3c (abierto
 * sin vivos → descartado + aviso D6), D5 (impuesto siempre descartado, también pagado), canal Cliente intacto
 * (decisión cerrada 4), pagado de otro origen intacto, D11 (a quién se libera; revocado no libera lo propio),
 * idempotencia, el trigger FL409 (Tr), el CHECK del descarte, los índices «abierto» y `soatActualDelVin`, y el
 * saneo 0319 (solo descarta y reasigna; 2.ª pasada sin cambios).
 *
 * La liberación de comprobantes (D11) se sustituye por un espía: aquí se afirma A QUIÉN se le pide liberar; su
 * mecánica (SKIP LOCKED, periodo cerrado) la cubre `flito-comprobantes-liberar-descarte.test.ts`.
 * Datos sintéticos: ningún VIN, placa ni documento real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { URL_BASE, leerMigracion } from '../helpers/base-en-tx.js';

const liberarMock = vi.hoisted(() => vi.fn(async () => ({ liberados: 0, noLiberados: 0 })));
vi.mock('../../src/modules/flito-comprobantes/flito-comprobantes.liberar-descarte.js', () => ({
  liberarComprobantesDeDescarte: liberarMock,
}));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { descartarDeTramiteMuerto } = await import('../../src/modules/flito-sync/descarte-tramite-muerto.js');
const { soatActualDelVin } = await import('../../src/modules/flito-soat/flito-soat-actual.js');
const { flitoTramites } = await import('../../src/db/schema.js');

type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];
type Fila = Record<string, unknown>;

const describeDb = URL_BASE ? describe : describe.skip;
const ROLLBACK = Symbol('rollback');
let cliente: postgres.Sql;
let ddb: ReturnType<typeof drizzle>;

beforeAll(() => {
  if (!URL_BASE) return;
  cliente = postgres(URL_BASE, { max: 1, onnotice: () => {} });
  ddb = drizzle(cliente);
});
afterAll(async () => { if (cliente) await cliente.end(); });
beforeEach(() => { liberarMock.mockClear(); });

async function enTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await ddb.transaction(async (tx) => { await fn(tx as unknown as Tx); throw ROLLBACK; });
  } catch (e) { if (e !== ROLLBACK) throw e; }
}

const filas = async (tx: Tx, q: ReturnType<typeof sql>): Promise<Fila[]> => (await tx.execute(q)) as unknown as Fila[];
const una = async (tx: Tx, q: ReturnType<typeof sql>): Promise<Fila> => (await filas(tx, q))[0]!;

let n = 0;
const sufijo = () => `${Date.now().toString(36)}${(n += 1)}`.toUpperCase();

interface Base { usuarioId: number; companiaA: number; companiaB: number; orgA: string; orgB: string }

async function base(tx: Tx): Promise<Base> {
  const s = sufijo();
  const u = await una(tx, sql`INSERT INTO users (username, name, password_hash, role) VALUES (${`t14707_${s}`}, 'Prueba 14707', 'h', 'admin') RETURNING id`);
  const a = await una(tx, sql`INSERT INTO clients (name) VALUES (${`Cliente A ${s}`}) RETURNING id`);
  const b = await una(tx, sql`INSERT INTO clients (name) VALUES (${`Cliente B ${s}`}) RETURNING id`);
  const orgs = await filas(tx, sql`SELECT codigo FROM organismos_transito_config ORDER BY codigo LIMIT 2`);
  return { usuarioId: Number(u.id), companiaA: Number(a.id), companiaB: Number(b.id), orgA: String(orgs[0]!.codigo), orgB: String(orgs[1]!.codigo) };
}

async function vehiculo(tx: Tx): Promise<{ id: number; vin: string }> {
  const vin = `9FK14707${sufijo()}`.slice(0, 17).padEnd(17, '0');
  const v = await una(tx, sql`INSERT INTO vehicles (vin) VALUES (${vin}) RETURNING id`);
  return { id: Number(v.id), vin };
}

async function tramite(tx: Tx, o: {
  vehiculoId: number; companiaId: number; org: string; estado: string | null; flitEstado: string;
  soatId?: string | null; creado?: string; fechaAprobacion?: string | null;
}): Promise<string> {
  const t = await una(tx, sql`INSERT INTO flito_tramites
      (id_flit, sincronizado_en, vehiculo_id, compania_id, organismo_codigo, estado, flit_estado, soat_id, created_at, fecha_aprobacion)
    VALUES (${`R14707-${sufijo()}`}, now(), ${o.vehiculoId}, ${o.companiaId}, ${o.org}, ${o.estado}, ${o.flitEstado},
            ${o.soatId ?? null}, ${o.creado ?? '2026-11-01T00:00:00Z'}::timestamptz, ${o.fechaAprobacion ?? null}::timestamptz)
    RETURNING id`);
  return String(t.id);
}

async function soat(tx: Tx, o: {
  vin: string; vehiculoId: number; companiaId: number; org: string; estado: string; origen?: string;
  origenTramiteId?: string | null; enviadoPorId?: number | null;
}): Promise<string> {
  const s = await una(tx, sql`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, organismo_codigo, estado, origen, tramite_origen_id, enviado_por_id)
    VALUES (${o.vin}, ${o.vehiculoId}, ${o.companiaId}, ${o.org}, ${o.estado}::flito_soat_estado, ${o.origen ?? 'tramite'},
            ${o.origenTramiteId ?? null}, ${o.enviadoPorId ?? null}) RETURNING id`);
  return String(s.id);
}

async function ligar(tx: Tx, tramiteId: string, soatId: string): Promise<void> {
  await tx.execute(sql`UPDATE flito_tramites SET soat_id = ${soatId} WHERE id = ${tramiteId}`);
}

async function impuesto(tx: Tx, o: { tramiteId: string; companiaId: number; org: string; estado: string; enviadoPorId?: number | null }): Promise<string> {
  const i = await una(tx, sql`INSERT INTO flito_impuestos (tramite_id, compania_id, organismo_codigo, modalidad_aplicada, estado, enviado_por_id)
    VALUES (${o.tramiteId}, ${o.companiaId}, ${o.org}, 'requiere_gestion', ${o.estado}::flito_impuesto_estado, ${o.enviadoPorId ?? null}) RETURNING id`);
  return String(i.id);
}

/** FLIT deja muerto el trámite (lo que hace `escribirTramite`) y se lee la fila escrita. */
async function morir(tx: Tx, tramiteId: string, flitEstado = 'Anulado') {
  await tx.execute(sql`UPDATE flito_tramites SET estado = 'anulado', flit_estado = ${flitEstado} WHERE id = ${tramiteId}`);
  const [row] = await tx.select().from(flitoTramites).where(eq(flitoTramites.id, tramiteId));
  return row!;
}

const rearrancar = vi.fn(async () => true);
const opciones = { avisar: true, rearrancar };

describeDb('Épica #14707 — descartarDeTramiteMuerto (PostgreSQL real, ROLLBACK)', () => {
  it('D5 + D6: el impuesto solicitado del muerto pasa a descartado con historial y aviso a quien lo envió', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const imp = await impuesto(tx, { tramiteId: m, companiaId: b.companiaA, org: b.orgA, estado: 'solicitado', enviadoPorId: b.usuarioId });

      const r = await descartarDeTramiteMuerto(tx as never, await morir(tx, m), opciones);

      expect(r.impuestos).toBe(1);
      expect(r.avisos).toBe(1);
      const i = await una(tx, sql`SELECT estado::text, motivo_descarte, descartado_en FROM flito_impuestos WHERE id = ${imp}`);
      expect(i).toMatchObject({ estado: 'descartado', motivo_descarte: 'anulado' });
      expect(i.descartado_en).not.toBeNull();
      const h = await una(tx, sql`SELECT estado_anterior, estado_nuevo, origen FROM flito_estado_historial WHERE registro_id = ${imp} ORDER BY id DESC LIMIT 1`);
      expect(h).toMatchObject({ estado_anterior: 'solicitado', estado_nuevo: 'descartado', origen: 'sistema' });
      const av = await filas(tx, sql`SELECT usuario_id, tipo, concepto, motivo, tramite_id FROM flito_avisos_usuario WHERE registro_id = ${imp}`);
      expect(av).toEqual([{ usuario_id: b.usuarioId, tipo: 'solicitud_retirada', concepto: 'impuesto', motivo: 'anulado', tramite_id: m }]);
      // D11: anulado libera lo aplicado al impuesto descartado.
      expect(liberarMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tramiteIds: [m], conceptos: ['impuesto'] }));
    });
  });

  it('D5: un impuesto PAGADO del muerto también se descarta (sin aviso: no estaba solicitado)', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const imp = await impuesto(tx, { tramiteId: m, companiaId: b.companiaA, org: b.orgA, estado: 'pagado', enviadoPorId: b.usuarioId });
      const r = await descartarDeTramiteMuerto(tx as never, await morir(tx, m, 'Abortado'), opciones);
      expect(r).toMatchObject({ impuestos: 1, avisos: 0 });
      expect(await una(tx, sql`SELECT estado::text, motivo_descarte FROM flito_impuestos WHERE id = ${imp}`))
        .toEqual({ estado: 'descartado', motivo_descarte: 'abortado' });
    });
  });

  it('D3c + D6: SOAT abierto sin otros vivos → descartado (por el muerto) y aviso a enviado_por_id', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const s = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'solicitado', origenTramiteId: m, enviadoPorId: b.usuarioId });
      await ligar(tx, m, s);

      const r = await descartarDeTramiteMuerto(tx as never, await morir(tx, m), opciones);

      expect(r).toMatchObject({ soats: 1, avisos: 1, soatsHeredados: 0 });
      expect(await una(tx, sql`SELECT estado::text, motivo_descarte, descartado_por_tramite_id FROM flito_soat WHERE id = ${s}`))
        .toEqual({ estado: 'descartado', motivo_descarte: 'anulado', descartado_por_tramite_id: m });
      expect(await filas(tx, sql`SELECT concepto FROM flito_avisos_usuario WHERE registro_id = ${s}`)).toEqual([{ concepto: 'soat' }]);
      // El soat_id del muerto se conserva (historia).
      expect(await una(tx, sql`SELECT soat_id FROM flito_tramites WHERE id = ${m}`)).toEqual({ soat_id: s });
      expect(liberarMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tramiteIds: [m], conceptos: ['soat'], soatDescartadoId: s }));
    });
  });

  it('D3b + D9: SOAT abierto compartido con un vivo → sigue vivo y toma compañía/organismo del vivo más antiguo (auditado)', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado', creado: '2026-11-01T00:00:00Z' });
      const vivo = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaB, org: b.orgB, estado: 'asignado', flitEstado: 'Asignado', creado: '2026-11-02T00:00:00Z' });
      const s = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'pendiente', origenTramiteId: m });
      await ligar(tx, m, s); await ligar(tx, vivo, s);

      const r = await descartarDeTramiteMuerto(tx as never, await morir(tx, m), opciones);

      expect(r).toMatchObject({ soats: 0, soatsHeredados: 1 });
      expect(await una(tx, sql`SELECT estado::text, compania_id, organismo_codigo FROM flito_soat WHERE id = ${s}`))
        .toEqual({ estado: 'pendiente', compania_id: b.companiaB, organismo_codigo: b.orgB });
      const audit = await una(tx, sql`SELECT detail FROM audit_logs WHERE resource = 'flito_soat' AND resource_id = ${s} ORDER BY id DESC LIMIT 1`);
      expect(String(audit.detail)).toMatch(/^D9 \(Épica 14707\)/);
      expect(String(audit.detail)).not.toContain(v.vin);
      expect(await una(tx, sql`SELECT soat_id FROM flito_tramites WHERE id = ${vivo}`)).toEqual({ soat_id: s });
    });
  });

  it('D3a: SOAT pagado originado por el muerto → descartado; el vivo se desliga (historial), rearranca y su comprobante se libera', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado', creado: '2026-11-01T00:00:00Z' });
      const vivo = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado', creado: '2026-11-02T00:00:00Z' });
      const s = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'pagado', origenTramiteId: m });
      await ligar(tx, m, s); await ligar(tx, vivo, s);
      rearrancar.mockClear();

      const r = await descartarDeTramiteMuerto(tx as never, await morir(tx, m), opciones);

      expect(r).toMatchObject({ soats: 1, vivosRearrancados: 1 });
      expect(await una(tx, sql`SELECT estado::text FROM flito_soat WHERE id = ${s}`)).toEqual({ estado: 'descartado' });
      expect(await una(tx, sql`SELECT soat_id FROM flito_tramites WHERE id = ${vivo}`)).toEqual({ soat_id: null });
      expect(await una(tx, sql`SELECT campo, valor_anterior, valor_nuevo FROM flito_tramite_historial WHERE tramite_id = ${vivo} ORDER BY id DESC LIMIT 1`))
        .toEqual({ campo: 'soat_id', valor_anterior: s, valor_nuevo: null });
      expect(rearrancar).toHaveBeenCalledTimes(1);
      expect(rearrancar.mock.calls[0]![1]).toMatchObject({ id: vivo, soatId: null });
      expect(rearrancar.mock.calls[0]![2]).toBe(v.vin);
      // D11: lo del vivo desligado se libera SIEMPRE (pagaba un SOAT que ya no existe).
      expect(liberarMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tramiteIds: [vivo], conceptos: ['soat'] }));
    });
  });

  it('decisión cerrada 1: un vivo ya entregado/aprobado consumió el SOAT pagado → se conserva y se audita', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const vivo = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'entregado', flitEstado: 'Entregado' });
      const s = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'pagado', origenTramiteId: m });
      await ligar(tx, m, s); await ligar(tx, vivo, s);

      const r = await descartarDeTramiteMuerto(tx as never, await morir(tx, m), opciones);

      expect(r).toMatchObject({ soats: 0, soatsConservados: 1, vivosRearrancados: 0 });
      expect(await una(tx, sql`SELECT estado::text FROM flito_soat WHERE id = ${s}`)).toEqual({ estado: 'pagado' });
      expect(await una(tx, sql`SELECT soat_id FROM flito_tramites WHERE id = ${vivo}`)).toEqual({ soat_id: s });
      const audit = await una(tx, sql`SELECT detail FROM audit_logs WHERE resource = 'flito_soat' AND resource_id = ${s} ORDER BY id DESC LIMIT 1`);
      expect(String(audit.detail)).toMatch(/se conserva/);
    });
  });

  it('SOAT pagado de OTRO origen y SOAT del canal Cliente (decisión cerrada 4): no se tocan', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v1 = await vehiculo(tx);
      const otro = await tramite(tx, { vehiculoId: v1.id, companiaId: b.companiaA, org: b.orgA, estado: 'aprobado', flitEstado: 'Aprobado' });
      const m1 = await tramite(tx, { vehiculoId: v1.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const s1 = await soat(tx, { vin: v1.vin, vehiculoId: v1.id, companiaId: b.companiaA, org: b.orgA, estado: 'pagado', origenTramiteId: otro });
      await ligar(tx, m1, s1);
      const v2 = await vehiculo(tx);
      const m2 = await tramite(tx, { vehiculoId: v2.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const s2 = await soat(tx, { vin: v2.vin, vehiculoId: v2.id, companiaId: b.companiaA, org: b.orgA, estado: 'solicitado', origen: 'cliente', enviadoPorId: b.usuarioId });
      await ligar(tx, m2, s2);

      const r1 = await descartarDeTramiteMuerto(tx as never, await morir(tx, m1), opciones);
      const r2 = await descartarDeTramiteMuerto(tx as never, await morir(tx, m2), opciones);

      expect(r1.soats + r2.soats + r1.avisos + r2.avisos).toBe(0);
      expect(await una(tx, sql`SELECT estado::text FROM flito_soat WHERE id = ${s1}`)).toEqual({ estado: 'pagado' });
      expect(await una(tx, sql`SELECT estado::text FROM flito_soat WHERE id = ${s2}`)).toEqual({ estado: 'solicitado' });
      expect(liberarMock).not.toHaveBeenCalled();
    });
  });

  it('D11 revocado: lo propio NO se libera (pero el impuesto sí se descarta, D5)', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'aprobado', flitEstado: 'Aprobado' });
      const imp = await impuesto(tx, { tramiteId: m, companiaId: b.companiaA, org: b.orgA, estado: 'pagado' });
      const s = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'pagado', origenTramiteId: m });
      await ligar(tx, m, s);

      const r = await descartarDeTramiteMuerto(tx as never, await morir(tx, m, 'Revocado'), opciones);

      expect(r).toMatchObject({ impuestos: 1, soats: 1 });
      expect(await una(tx, sql`SELECT motivo_descarte FROM flito_impuestos WHERE id = ${imp}`)).toEqual({ motivo_descarte: 'revocado' });
      expect(liberarMock).not.toHaveBeenCalled();
    });
  });

  it('idempotente: la 2.ª llamada no cambia nada ni duplica avisos', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      await impuesto(tx, { tramiteId: m, companiaId: b.companiaA, org: b.orgA, estado: 'solicitado', enviadoPorId: b.usuarioId });
      const s = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'solicitado', origenTramiteId: m, enviadoPorId: b.usuarioId });
      await ligar(tx, m, s);
      const fila = await morir(tx, m);
      await descartarDeTramiteMuerto(tx as never, fila, opciones);
      const segunda = await descartarDeTramiteMuerto(tx as never, fila, opciones);
      expect(segunda).toEqual({
        impuestos: 0, soats: 0, soatsHeredados: 0, soatsConservados: 0, vivosRearrancados: 0,
        comprobantesLiberados: 0, comprobantesNoLiberados: 0, avisos: 0,
      });
      expect(await una(tx, sql`SELECT count(*)::int AS n FROM flito_avisos_usuario WHERE tramite_id = ${m}`)).toEqual({ n: 2 });
    });
  });

  it('un trámite vigente no descarta nada', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const t = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'rechazado', flitEstado: 'Rechazado' });
      await impuesto(tx, { tramiteId: t, companiaId: b.companiaA, org: b.orgA, estado: 'solicitado' });
      const [row] = await tx.select().from(flitoTramites).where(eq(flitoTramites.id, t));
      const r = await descartarDeTramiteMuerto(tx as never, row!, opciones);
      expect(r.impuestos).toBe(0);
    });
  });
});

describeDb('Épica #14707 — modelo 0318: trigger FL409 (Tr), CHECK, índices «abierto», soatActualDelVin', () => {
  it('Tr: salir de descartado lanza FL409 en SOAT e impuesto; el CHECK exige descartado_en + motivo', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const imp = await impuesto(tx, { tramiteId: m, companiaId: b.companiaA, org: b.orgA, estado: 'pendiente' });
      const s = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'pendiente', origenTramiteId: m });
      await ligar(tx, m, s);
      await descartarDeTramiteMuerto(tx as never, await morir(tx, m), opciones);

      const codigoDe = async (q: ReturnType<typeof sql>): Promise<string | undefined> => {
        try { await tx.transaction(async (sp) => { await sp.execute(q); }); return undefined; } catch (e) {
          const err = e as { code?: string; cause?: { code?: string } };
          return err.code ?? err.cause?.code;
        }
      };
      expect(await codigoDe(sql`UPDATE flito_soat SET estado = 'pendiente', descartado_en = NULL, motivo_descarte = NULL WHERE id = ${s}`)).toBe('FL409');
      expect(await codigoDe(sql`UPDATE flito_impuestos SET estado = 'pagado', descartado_en = NULL, motivo_descarte = NULL WHERE id = ${imp}`)).toBe('FL409');
      // La retención puede seguir limpiando columnas de una fila descartada: el trigger solo vigila `estado`.
      expect(await codigoDe(sql`UPDATE flito_soat SET poliza_runt = NULL WHERE id = ${s}`)).toBeUndefined();
      // CHECK: `descartado` sin fecha ni motivo no entra.
      const v2 = await vehiculo(tx);
      expect(await codigoDe(sql`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, estado) VALUES (${v2.vin}, ${v2.id}, ${b.companiaA}, 'descartado')`)).toBe('23514');
    });
  });

  it('un SOAT descartado no ocupa el «abierto» del VIN: nace otro y soatActualDelVin lo ignora', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      const v = await vehiculo(tx);
      const m = await tramite(tx, { vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const s = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'pendiente', origenTramiteId: m });
      await ligar(tx, m, s);
      await descartarDeTramiteMuerto(tx as never, await morir(tx, m), opciones);
      expect(await soatActualDelVin(tx as never, v.vin)).toBeNull();
      const nuevo = await soat(tx, { vin: v.vin, vehiculoId: v.id, companiaId: b.companiaA, org: b.orgA, estado: 'pendiente' });
      expect((await soatActualDelVin(tx as never, v.vin))?.id).toBe(nuevo);
    });
  });
});

describeDb('Épica #14707 — saneo 0319 (decisión cerrada 2: solo descarta y reasigna; idempotente)', () => {
  it('descarta impuestos y SOAT de muertos, hereda D9, conserva el pagado compartido; sin avisos ni desligar; 2.ª pasada sin cambios', async () => {
    await enTx(async (tx) => {
      const b = await base(tx);
      // A. impuesto de un muerto histórico.
      const va = await vehiculo(tx);
      const ma = await tramite(tx, { vehiculoId: va.id, companiaId: b.companiaA, org: b.orgA, estado: 'anulado', flitEstado: 'Abortado' });
      const impA = await impuesto(tx, { tramiteId: ma, companiaId: b.companiaA, org: b.orgA, estado: 'solicitado', enviadoPorId: b.usuarioId });
      // B1. SOAT abierto de un muerto, sin vivos.
      const sB1 = await soat(tx, { vin: va.vin, vehiculoId: va.id, companiaId: b.companiaA, org: b.orgA, estado: 'solicitado', origenTramiteId: ma, enviadoPorId: b.usuarioId });
      await ligar(tx, ma, sB1);
      // B3. SOAT abierto compartido con un vivo de otra compañía.
      const vb = await vehiculo(tx);
      const mb = await tramite(tx, { vehiculoId: vb.id, companiaId: b.companiaA, org: b.orgA, estado: 'anulado', flitEstado: 'Anulado', creado: '2026-11-01T00:00:00Z' });
      const vivoB = await tramite(tx, { vehiculoId: vb.id, companiaId: b.companiaB, org: b.orgB, estado: 'asignado', flitEstado: 'Asignado', creado: '2026-11-02T00:00:00Z' });
      const sB3 = await soat(tx, { vin: vb.vin, vehiculoId: vb.id, companiaId: b.companiaA, org: b.orgA, estado: 'pendiente', origenTramiteId: mb });
      await ligar(tx, mb, sB3); await ligar(tx, vivoB, sB3);
      // B4. SOAT pagado compartido con un vivo: se conserva.
      const vc = await vehiculo(tx);
      const mc = await tramite(tx, { vehiculoId: vc.id, companiaId: b.companiaA, org: b.orgA, estado: 'anulado', flitEstado: 'Revocado' });
      const vivoC = await tramite(tx, { vehiculoId: vc.id, companiaId: b.companiaA, org: b.orgA, estado: 'asignado', flitEstado: 'Asignado' });
      const sB4 = await soat(tx, { vin: vc.vin, vehiculoId: vc.id, companiaId: b.companiaA, org: b.orgA, estado: 'pagado', origenTramiteId: mc });
      await ligar(tx, mc, sB4); await ligar(tx, vivoC, sB4);

      const saneo = sql.raw(leerMigracion('0319_flito_tramite_muerto_saneo.sql'));
      await tx.execute(saneo);

      expect(await una(tx, sql`SELECT estado::text, motivo_descarte FROM flito_impuestos WHERE id = ${impA}`)).toEqual({ estado: 'descartado', motivo_descarte: 'abortado' });
      expect(await una(tx, sql`SELECT estado::text, motivo_descarte, descartado_por_tramite_id FROM flito_soat WHERE id = ${sB1}`))
        .toEqual({ estado: 'descartado', motivo_descarte: 'abortado', descartado_por_tramite_id: ma });
      expect(await una(tx, sql`SELECT estado::text, compania_id, organismo_codigo FROM flito_soat WHERE id = ${sB3}`))
        .toEqual({ estado: 'pendiente', compania_id: b.companiaB, organismo_codigo: b.orgB });
      expect(await una(tx, sql`SELECT estado::text FROM flito_soat WHERE id = ${sB4}`)).toEqual({ estado: 'pagado' });
      // Sin avisos y sin desligar vivos.
      expect(await una(tx, sql`SELECT count(*)::int AS n FROM flito_avisos_usuario WHERE tramite_id IN (${ma}, ${mb}, ${mc})`)).toEqual({ n: 0 });
      expect(await una(tx, sql`SELECT soat_id FROM flito_tramites WHERE id = ${vivoC}`)).toEqual({ soat_id: sB4 });
      const h = await una(tx, sql`SELECT motivo FROM flito_estado_historial WHERE registro_id = ${sB1} ORDER BY id DESC LIMIT 1`);
      expect(String(h.motivo)).toMatch(/^Saneo Épica 14707/);
      expect(String(h.motivo)).not.toContain(va.vin);

      const huella = sql`SELECT (SELECT count(*) FROM flito_estado_historial WHERE registro_id IN (${impA}, ${sB1}, ${sB3}, ${sB4}))::int AS hist,
                                (SELECT count(*) FROM audit_logs WHERE resource_id IN (${sB3}))::int AS audit`;
      const antes = await una(tx, huella);
      await tx.execute(saneo);
      expect(await una(tx, huella)).toEqual(antes);
    });
  });
});

describe('Épica #14707 — descarte-tramite-muerto (sin base)', () => {
  it('el archivo se salta sin TEST_DATABASE_URL en vez de fallar (CI sin Postgres)', () => {
    expect(typeof descartarDeTramiteMuerto).toBe('function');
  });
});
