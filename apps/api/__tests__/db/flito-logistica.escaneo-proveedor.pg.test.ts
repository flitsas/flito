// HU #14352 (Feature #14326, ADR-0039 §8, R18) — el escaneo del usuario de proveedor contra PostgreSQL de verdad: el alcance y «gestionable» viven en el
// WHERE, la respuesta es una sola, byte a byte, y lo ajeno no se toca. Dentro de una tx con ROLLBACK. Se SALTA sin TEST_DATABASE_URL.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { MENSAJE_LT_NO_ENCONTRADA } from '@operaciones/shared-types';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null; antesDeTx?: () => Promise<void> } = { db: null };
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: vi.fn().mockResolvedValue('k'), presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn() }));
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      if (prop === 'transaction') return async (fn: (tx: unknown) => unknown) => { await actual.antesDeTx?.(); return fn(actual.db); };
      const d = actual.db as unknown as Record<string | symbol, unknown>;
      const v = d[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');

type Sql = postgres.TransactionSql;
let n = 0;
const sello = () => `${String(Date.now()).slice(-6)}${n++}`;
const manual = (placa: string, numero = `L${sello()}`) => ({ placa, numeroLicencia: numero, numeroLt: 'LT-NUEVO' });
const NO_ENCONTRADO = (e: { placa: string; numeroLicencia: string }) => ({
  resultado: 'sin_match', motivo: MENSAJE_LT_NO_ENCONTRADA, placa: e.placa, vin: '', numeroLicencia: e.numeroLicencia,
});
/** Una lectura PDF417, para probar que el nombre leído tampoco viaja. */
const PROHIBIDOS = ['idFlit', 'companiaNombre', 'organismoCodigo', 'documentoId', 'candidatos', 'propietarioNombre'];

interface Mundo {
  tx: Sql; A: string; B: string; org: string; ctxA: Parameters<typeof svc.escanearLt>[3]; ctxOps: Parameters<typeof svc.escanearLt>[3];
  cia: (p: string | null, auto?: boolean) => Promise<number>;
  vehiculo: () => Promise<{ id: number; placa: string; vin: string }>;
  tramite: (cia: number | null, vehiculoId: number, o?: { organismo?: string | null }) => Promise<string>;
  doc: (o: { cia: number; vehiculoId: number; tramiteId: string; numero: string; dueno: string | null }) => Promise<string>;
  estado: () => Promise<unknown>;
}

async function conMundo(fn: (m: Mundo) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      const prov = async (nombre: string) => (await tx`INSERT INTO flito_proveedores_logistica (nombre, activo, nit, contacto, telefono)
        VALUES (${`${nombre} ${sello()}`}, true, ${`9${sello()}`}, 'Ana', '3001112233') RETURNING id`)[0]!.id as string;
      const A = await prov('A'); const B = await prov('B');
      const [u] = await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_id) VALUES (${`hu14352-${sello()}`}, 'Mensajero A', 'x', 'admin', ${A}) RETURNING id`;
      const org = (await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`)[0]?.codigo as string
        ?? (await tx`INSERT INTO organismos_transito_config (codigo, activo) VALUES ('99999', true) RETURNING codigo`)[0]!.codigo as string;
      const base = { userId: u!.id as number, username: 'm', role: 'x', operaAjenas: true };
      await fn({
        tx, A, B, org,
        ctxA: { ...base, alcance: { enlace: 'proveedor', proveedorId: A } },
        ctxOps: { ...base, alcance: { enlace: 'ninguno' } },
        cia: async (p, auto = false) => (await tx`INSERT INTO clients (name, document, flito_proveedor_logistica_id, logistica_autogestionable)
          VALUES (${`Cia ${sello()}`}, ${`D${sello()}`}, ${p}, ${auto}) RETURNING id`)[0]!.id as number,
        vehiculo: async () => {
          const placa = `X${sello().slice(-6)}`; const vin = `VIN${placa}`;
          return { id: (await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${vin}) RETURNING id`)[0]!.id as number, placa, vin };
        },
        tramite: async (cia, vehiculoId, o = {}) => (await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, compania_nit, organismo_codigo, flit_estado)
          VALUES (${`F${sello()}`}, now(), ${vehiculoId}, ${cia}, '900', ${o.organismo === undefined ? org : o.organismo}, 'Aprobado') RETURNING id`)[0]!.id as string,
        doc: async (o) => (await tx`INSERT INTO flito_logistica_documentos (tramite_id, tipo, estado, organismo_codigo, compania_id, vehiculo_id, numero_licencia, numero_lt, proveedor_logistica_id, updated_at)
          VALUES (${o.tramiteId}, 'licencia_transito', 'clasificado', ${org}, ${o.cia}, ${o.vehiculoId}, ${o.numero}, 'LT-ORIGINAL', ${o.dueno}, now() - interval '1 day') RETURNING id`)[0]!.id as string,
        estado: async () => (await tx`SELECT
          (SELECT count(*)::int FROM flito_logistica_documentos) AS documentos,
          (SELECT count(*)::int FROM flito_logistica_documento_eventos) AS eventos,
          (SELECT coalesce(json_agg(json_build_object('n', numero_lt, 'u', updated_at) ORDER BY id), '[]'::json) FROM flito_logistica_documentos) AS filas`)[0],
      });
    });
  } finally { actual.db = null; await sql.end(); }
}

describe.skipIf(!URL_BASE)('escaneo del proveedor (PostgreSQL, tx con ROLLBACK)', () => {
  it('AC1, AC2 y AC8: los cuatro casos dan la misma respuesta, sin escribir, y el motivo real solo a soporte', () => conMundo(async (m) => {
    const sinTramite = await m.vehiculo();
    const deOtro = await m.vehiculo(); await m.tramite(await m.cia(m.B), deOtro.id);
    const auto = await m.vehiculo(); await m.tramite(await m.cia(m.A, true), auto.id);
    const conLtAjena = await m.vehiculo();
    const ciaB = await m.cia(m.B);
    const tB = await m.tramite(ciaB, conLtAjena.id);
    const numeroAjeno = `L${sello()}`;
    await m.doc({ cia: ciaB, vehiculoId: conLtAjena.id, tramiteId: tB, numero: numeroAjeno, dueno: m.B });
    const antes = await m.estado();
    const motivos: string[] = [];
    const opc = { alNoEncontrar: (x: string) => { motivos.push(x); } };
    const NUMERO = `L${sello()}`;
    const respuestas: unknown[] = [];
    // Misma lectura en los cuatro: lo único que cambia es a quién le toca. El caso de la LT ajena lleva el número ya registrado.
    for (const [v, numero] of [[sinTramite, NUMERO], [deOtro, NUMERO], [auto, NUMERO]] as const) {
      respuestas.push({ e: { placa: v.placa, numeroLicencia: numero }, r: await svc.escanearLt(manual(v.placa, numero), null, {}, m.ctxA, opc) });
    }
    respuestas.push({ e: { placa: conLtAjena.placa, numeroLicencia: numeroAjeno }, r: await svc.escanearLt(manual(conLtAjena.placa, numeroAjeno), null, {}, m.ctxA, opc) });
    for (const x of respuestas as { e: { placa: string; numeroLicencia: string }; r: object }[]) {
      expect(x.r).toStrictEqual(NO_ENCONTRADO(x.e));
      for (const campo of PROHIBIDOS) expect(x.r).not.toHaveProperty(campo);
    }
    // Byte a byte con la misma lectura: placa y licencia fijas, y el dueño es lo único que varía.
    const texto = async (mutar: () => Promise<void>, lectura: { placa: string; numero: string }) => {
      await mutar();
      return JSON.stringify(await svc.escanearLt(manual(lectura.placa, lectura.numero), null, {}, m.ctxA));
    };
    const v = await m.vehiculo();
    const numero = `L${sello()}`;
    const lectura = { placa: v.placa, numero };
    const vacio = await texto(async () => {}, lectura);
    const t = await m.tramite(await m.cia(m.B), v.id);
    const otro = await texto(async () => {}, lectura);
    const autoCia = await m.cia(m.A, true);
    const gestion = await texto(async () => { await m.tx`UPDATE flito_tramites SET compania_id = ${autoCia} WHERE id = ${t}`; }, lectura);
    const ltAjena = await texto(async () => { await m.doc({ cia: ciaB, vehiculoId: conLtAjena.id, tramiteId: await m.tramite(ciaB, conLtAjena.id), numero, dueno: m.B }); }, lectura);
    expect(new Set([vacio, otro, gestion, ltAjena]).size).toBe(1);
    expect(motivos).toEqual(['inexistente', 'fuera_de_alcance', 'no_gestionada', 'lt_ajena']);
    expect((await m.estado() as { documentos: number }).documentos).toBe((antes as { documentos: number }).documentos + 1); // la del último `doc` de este test
  }));

  it('AC2: escanear una LT de otro proveedor no le cambia `numero_lt` ni `updated_at`, ni ningún conteo', () => conMundo(async (m) => {
    const v = await m.vehiculo();
    const ciaB = await m.cia(m.B);
    const numero = `L${sello()}`;
    await m.doc({ cia: ciaB, vehiculoId: v.id, tramiteId: await m.tramite(ciaB, v.id), numero, dueno: m.B });
    const antes = await m.estado();
    await svc.escanearLt(manual(v.placa, numero), null, {}, m.ctxA);
    expect(await m.estado()).toEqual(antes);
  }));

  it('AC3: la licencia propia repetida recibe `duplicado` con sus datos; Operaciones sobre la de otro, también', () => conMundo(async (m) => {
    const v = await m.vehiculo();
    const ciaA = await m.cia(m.A);
    const numero = `L${sello()}`;
    const id = await m.doc({ cia: ciaA, vehiculoId: v.id, tramiteId: await m.tramite(ciaA, v.id), numero, dueno: m.A });
    const r = await svc.escanearLt(manual(v.placa, numero), null, {}, m.ctxA);
    expect(r).toMatchObject({ resultado: 'duplicado', documentoId: id });
    expect(r.companiaNombre).toContain('Cia');
    expect(r).not.toHaveProperty('propietarioNombre');
    expect((await m.tx`SELECT numero_lt FROM flito_logistica_documentos WHERE id = ${id}`)[0]!.numero_lt).toBe('LT-NUEVO');
  }));

  it('AC4: un trámite propio y otro ajeno: se liga al propio sin preguntar, sin indicar el otro; el conteo va a soporte', () => conMundo(async (m) => {
    const v = await m.vehiculo();
    const ciaA = await m.cia(m.A);
    const tA = await m.tramite(ciaA, v.id);
    await m.tramite(await m.cia(m.B), v.id);
    const conteos: number[] = [];
    const r = await svc.escanearLt(manual(v.placa), null, {}, m.ctxA, { alContarFueraDeAlcance: (x) => { conteos.push(x); } });
    expect(r.resultado).toBe('recogido');
    expect(r).not.toHaveProperty('candidatos');
    expect(conteos).toEqual([1]);
    const [d] = await m.tx`SELECT tramite_id, proveedor_logistica_id FROM flito_logistica_documentos WHERE id = ${r.documentoId!}`;
    expect(d).toMatchObject({ tramite_id: tA, proveedor_logistica_id: m.A });
  }));

  it('AC5: varios propios y uno de B: elige solo entre los de A; si todos los propios tienen licencia, «Sin trámite pendiente»', () => conMundo(async (m) => {
    const v = await m.vehiculo();
    const ciaA = await m.cia(m.A);
    const t1 = await m.tramite(ciaA, v.id);
    const t2 = await m.tramite(ciaA, v.id);
    const tB = await m.tramite(await m.cia(m.B), v.id);
    const r = await svc.escanearLt(manual(v.placa), null, {}, m.ctxA);
    expect(r.resultado).toBe('elegir_tramite');
    expect(r.candidatos!.map((c) => c.tramiteId).sort()).toEqual([t1, t2].sort());
    expect(JSON.stringify(r)).not.toContain(tB);
    await m.doc({ cia: ciaA, vehiculoId: v.id, tramiteId: t1, numero: `L${sello()}`, dueno: m.A });
    await m.doc({ cia: ciaA, vehiculoId: v.id, tramiteId: t2, numero: `L${sello()}`, dueno: m.A });
    const s = await svc.escanearLt(manual(v.placa), null, {}, m.ctxA);
    expect(s).toMatchObject({ resultado: 'sin_match', motivo: 'El vehículo no tiene un trámite aprobado pendiente de LT.' });
    expect(JSON.stringify(s)).not.toContain(tB);
  }));

  it('AC6: `tramiteId` ajeno, inventado o sin compañía u organismo: la misma respuesta, sin escribir', () => conMundo(async (m) => {
    const v = await m.vehiculo();
    const ajeno = await m.tramite(await m.cia(m.B), v.id);
    await m.tramite(await m.cia(m.A), v.id);
    const sinOrganismo = await m.tramite(await m.cia(m.A), v.id, { organismo: null });
    const sinCompania = await m.tramite(null, v.id);
    const antes = await m.estado();
    for (const tramiteId of [ajeno, '00000000-0000-4000-8000-000000000000', sinOrganismo, sinCompania]) {
      const e = manual(v.placa);
      expect(await svc.escanearLt(e, null, {}, m.ctxA, { tramiteId })).toStrictEqual(NO_ENCONTRADO(e));
    }
    expect(await m.estado()).toEqual(antes);
  }));

  it('Operaciones conserva su motivo y se gestiona lo de cualquier proveedor (R13, R19)', () => conMundo(async (m) => {
    const v = await m.vehiculo();
    await m.tramite(await m.cia(m.B), v.id);
    const r = await svc.escanearLt(manual(v.placa), null, {}, m.ctxOps);
    expect(r.resultado).toBe('recogido');
    const sinOrg = await m.vehiculo();
    await m.tramite(await m.cia(m.A), sinOrg.id, { organismo: null });
    expect(await svc.escanearLt(manual(sinOrg.placa), null, {}, m.ctxOps)).toMatchObject({ resultado: 'sin_match', motivo: expect.stringContaining('organismo') });
    expect(await svc.escanearLt(manual(sinOrg.placa), null, {}, m.ctxA)).toMatchObject({ motivo: MENSAJE_LT_NO_ENCONTRADA });
  }));

  it('AC9: validar-lt no dice `ya_registrada` de lo ajeno; consultar-vehiculo, `encontrado:false` idéntico, y sus candidatos solo de lo propio', () => conMundo(async (m) => {
    const v = await m.vehiculo();
    const ciaB = await m.cia(m.B);
    const numero = `L${sello()}`;
    await m.doc({ cia: ciaB, vehiculoId: v.id, tramiteId: await m.tramite(ciaB, v.id), numero, dueno: m.B });
    const e = manual(v.placa, numero);
    const alcance = m.ctxA.alcance;
    expect(await svc.validarLt(e, alcance)).toStrictEqual(NO_ENCONTRADO(e));
    expect(await svc.consultarVehiculo(v.placa, alcance)).toStrictEqual({ encontrado: false });
    expect(await svc.consultarVehiculo('NOEXISTE', alcance)).toStrictEqual({ encontrado: false });
    const mixto = await m.vehiculo();
    const propio = await m.tramite(await m.cia(m.A), mixto.id);
    const ajeno = await m.tramite(ciaB, mixto.id);
    const c = await svc.consultarVehiculo(mixto.placa, alcance);
    expect(c).toMatchObject({ encontrado: true });
    const cand = (c as { candidatos: { tramiteId: string; vin: string | null; vehiculo: object }[] }).candidatos;
    expect(cand.map((x) => x.tramiteId)).toEqual([propio]);
    expect(JSON.stringify(c)).not.toContain(ajeno);
    expect(cand[0]!.vin).toBe(mixto.vin);
  }));

  it('la compañía cambió de proveedor tras leer los trámites: no se crea una LT de otro a nombre de A', () => conMundo(async (m) => {
    const v = await m.vehiculo();
    const c = await m.cia(m.A);
    await m.tramite(c, v.id);
    // Se simula la carrera: la lectura ya se hizo con A; dentro de la transacción el cliente trae a B.
    const antes = await m.estado();
    actual.antesDeTx = async () => { await m.tx`UPDATE clients SET flito_proveedor_logistica_id = ${m.B} WHERE id = ${c}`; };
    const e = manual(v.placa);
    const r = await svc.escanearLt(e, null, {}, m.ctxA).finally(() => { actual.antesDeTx = undefined; });
    expect(r).toStrictEqual(NO_ENCONTRADO(e));
    expect(await m.estado()).toEqual(antes);
  }));
});
