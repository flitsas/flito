// HU #14346 (Feature #14326, ADR-0039 §6.3) — dueño de la LT, con dos proveedores cruzados, contra PostgreSQL de verdad
// y dentro de una transacción con ROLLBACK (se SALTA sin TEST_DATABASE_URL). Las reglas viven en el SQL: `sinActaAbierta`,
// el `IN` de estados y el `FOR SHARE`, así que un double no las prueba. El orden de bloqueo se lee de las consultas reales.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('storage/key'),
  presignedGetEntityDocument: vi.fn().mockResolvedValue('http://signed'),
  getEntityDocumentStream: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/modules/flito-logistica/flito-logistica.acta-pdf.js', () => ({ generarActaPdf: vi.fn().mockResolvedValue('pdf') }));
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: vi.fn().mockResolvedValue({ valor: 18500, origen: 'generica', vigenciaId: null }),
}));
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      if (prop === 'transaction') return (fn: (tx: unknown) => unknown) => fn(actual.db);
      const d = actual.db as unknown as Record<string | symbol, unknown>;
      const v = d[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { confirmarRecogida } = await import('../../src/modules/flito-logistica/flito-logistica.recogida.js');
const { resolverTramite } = await import('../../src/modules/flito-logistica/flito-logistica.pendientes.js');
const { reasignarLicenciasDeCompania } = await import('../../src/modules/flito-parametrizacion/flito-logistica-proveedor-compania.service.js');

type Tx = postgres.TransactionSql;
const FIRMA = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]).toString('base64')}`;
const FIRMA_CRUDA = 'iVBORw0KGgo=';
const RECEPTOR = { receptorNombre: 'Recibe', receptorDocumento: '1036640908', firma: FIRMA_CRUDA };

let consultas: string[] = [];
const ctx = { userId: 0, username: 'op', role: 'admin', operaAjenas: true, alcance: { enlace: 'ninguno' } as const };
let n = 0;
const sello = () => `${String(Date.now()).slice(-6)}${n++}`;

interface Mundo {
  tx: Tx; A: string; B: string; cia: (proveedor: string | null) => Promise<number>; org: string;
  vehiculo: () => Promise<{ id: number; placa: string }>;
  tramite: (cia: number, vehiculoId: number, o?: { conCompania?: boolean }) => Promise<string>;
  doc: (cia: number | null, o?: { estado?: string; dueno?: string | null; actaId?: string | null }) => Promise<string>;
  viaje: (cia: number, docs: string[], o: { dueno: string; destino?: string; estado: string; acta: string; linea: string }) => Promise<{ trasladoId: string; actaId: string }>;
  actaSinViaje: (cia: number, estado: string, dueno: string) => Promise<string>;
  poner: (cia: number, proveedor: string | null) => Promise<void>;
  dueno: (id: string) => Promise<string | null>;
}

async function conMundo(fn: (m: Mundo) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      consultas = [];
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, {
        schema, logger: { logQuery: (q) => { consultas.push(q); } },
      });
      const prov = async (nombre: string) => (await tx`INSERT INTO flito_proveedores_logistica (nombre, activo, nit, contacto, telefono)
        VALUES (${`${nombre} ${sello()}`}, true, ${`9${sello()}`}, 'Ana', '3001112233') RETURNING id`)[0]!.id as string;
      const A = await prov('Proveedor A'); const B = await prov('Proveedor B');
      const [u] = await tx`INSERT INTO users (username, name, password_hash, role) VALUES (${`hu14346-${sello()}`}, 'Op', 'x', 'admin') RETURNING id`;
      ctx.userId = u!.id as number;
      const org = (await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`)[0]?.codigo as string
        ?? (await tx`INSERT INTO organismos_transito_config (codigo, activo) VALUES ('99999', true) RETURNING codigo`)[0]!.codigo as string;
      const vehiculo = async () => {
        const placa = `Z${sello().slice(-6)}`;
        return { id: (await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${`VIN${placa}`}) RETURNING id`)[0]!.id as number, placa };
      };
      const tramite = async (cia: number, vehiculoId: number) => (await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, compania_nit, organismo_codigo, flit_estado)
        VALUES (${`F${sello()}`}, now(), ${vehiculoId}, ${cia}, '900', ${org}, 'Aprobado') RETURNING id`)[0]!.id as string;
      await fn({
        tx, A, B, org, vehiculo, tramite,
        cia: async (proveedor) => (await tx`INSERT INTO clients (name, document, flito_proveedor_logistica_id, logistica_autogestionable)
          VALUES (${`Cia ${sello()}`}, ${`D${sello()}`}, ${proveedor}, false) RETURNING id`)[0]!.id as number,
        doc: async (cia, o = {}) => {
          const v = await vehiculo();
          const t = cia === null ? null : await tramite(cia, v.id);
          return (await tx`INSERT INTO flito_logistica_documentos (tramite_id, tipo, estado, organismo_codigo, compania_id, vehiculo_id, proveedor_logistica_id, acta_id)
            VALUES (${t}, 'licencia_transito', ${o.estado ?? 'clasificado'}, ${org}, ${cia}, ${v.id}, ${o.dueno ?? null}, ${o.actaId ?? null}) RETURNING id`)[0]!.id as string;
        },
        viaje: async (cia, docs, o) => {
          const destino = o.destino ?? 'cliente';
          const [tr] = await tx`INSERT INTO flito_logistica_traslados (compania_id, destino, origen, estado, mensajero_id) VALUES (${cia}, ${destino}, 'organismo', ${o.estado}, ${ctx.userId}) RETURNING id`;
          const [acta] = await tx`INSERT INTO flito_logistica_actas (compania_id, punto, estado, proveedor_logistica_id, traslado_id, mensajero_id)
            VALUES (${cia}, ${destino === 'flit' ? 'flit' : 'cliente'}, ${o.acta}, ${o.dueno}, ${tr!.id}, ${ctx.userId}) RETURNING id`;
          const motivo = destino === 'flit'
            ? (await tx`INSERT INTO flito_logistica_motivos_llegada (nombre) VALUES (${`Motivo ${sello()}`}) RETURNING id`)[0]!.id as string : null;
          for (const d of docs) {
            const [l] = await tx`INSERT INTO flito_logistica_traslado_lts (traslado_id, destino, documento_id, estado, concepto_precio, precio, motivo_llegada_id, motivo_por_id, motivo_en)
              VALUES (${tr!.id}, ${destino}, ${d}, ${o.linea}, ${destino === 'flit' ? 'logistica_flit' : 'logistica_cliente'}, '18500.00', ${motivo}, ${motivo ? ctx.userId : null}, ${motivo ? new Date().toISOString() : null}) RETURNING id`;
            await tx`INSERT INTO flito_logistica_acta_lineas (acta_id, documento_id, punto, traslado_lt_id, compania_id) VALUES (${acta!.id}, ${d}, ${destino === 'flit' ? 'flit' : 'cliente'}, ${l!.id}, ${cia})`;
            await tx`UPDATE flito_logistica_documentos SET acta_id = ${acta!.id} WHERE id = ${d}`;
          }
          return { trasladoId: tr!.id as string, actaId: acta!.id as string };
        },
        actaSinViaje: async (cia, estado, dueno) => (await tx`INSERT INTO flito_logistica_actas (compania_id, punto, estado, proveedor_logistica_id, mensajero_id)
          VALUES (${cia}, 'cliente', ${estado}, ${dueno}, ${ctx.userId}) RETURNING id`)[0]!.id as string,
        poner: async (cia, proveedor) => { await tx`UPDATE clients SET flito_proveedor_logistica_id = ${proveedor} WHERE id = ${cia}`; },
        dueno: async (id) => (await tx`SELECT proveedor_logistica_id p FROM flito_logistica_documentos WHERE id = ${id}`)[0]!.p as string | null,
      });
    });
  } finally { actual.db = null; await sql.end(); }
}

async function rechazo(p: Promise<unknown>): Promise<Error & { codigo?: string; status?: number }> {
  try { await p; } catch (e) { return e as Error & { codigo?: string; status?: number }; }
  throw new Error('se esperaba un rechazo');
}

/** Índice de la primera consulta que cumple la expresión. */
const primera = (re: RegExp, desde = 0) => consultas.findIndex((q, i) => i >= desde && re.test(q));
const CLIENTE_SHARE = /from "clients".*for share/is;
const LICENCIA_BLOQUEADA = /(from "flito_logistica_documentos".*for update|update "flito_logistica_documentos"|insert into "flito_logistica_documentos")/is;
const clienteAntesQueLicencias = () => {
  const c = primera(CLIENTE_SHARE); const l = primera(LICENCIA_BLOQUEADA);
  expect(c).toBeGreaterThanOrEqual(0);
  expect(l).toBeGreaterThan(c);
};

describe.skipIf(!URL_BASE)('dueño de la LT (PostgreSQL, tx con ROLLBACK)', () => {
  describe('AC1 y AC2 — al escanear o resolver', () => {
    it('AC1: escanear con trámite deja como dueño al proveedor de la compañía, leído con el cliente bloqueado', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const v = await m.vehiculo(); await m.tramite(cia, v.id);
        const r = await svc.escanearLt({ placa: v.placa, numeroLicencia: `L${sello()}`, numeroLt: 'LT1' }, null, {}, ctx);
        expect(r.resultado).toBe('recogido');
        expect(await m.dueno(r.documentoId!)).toBe(m.A);
        clienteAntesQueLicencias();
      });
    });

    it('AC1: resolver una pendiente la deja con el proveedor de ESA compañía, también en un acta de organismo nueva', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const v = await m.vehiculo(); const t = await m.tramite(cia, v.id);
        const [f] = await m.tx`INSERT INTO flito_logistica_recogida_firmantes (id, organismo_codigo, nombre, firma_storage_key, registrado_por_id) VALUES (gen_random_uuid(), ${m.org}, 'F', 'k', ${ctx.userId}) RETURNING id`;
        const [d] = await m.tx`INSERT INTO flito_logistica_documentos (tipo, estado, organismo_codigo, vehiculo_id, recogida_firmante_id) VALUES ('licencia_transito', 'recogido', ${m.org}, ${v.id}, ${f!.id}) RETURNING id`;
        const r = await resolverTramite(d!.id as string, t, ctx);
        expect(await m.dueno(d!.id as string)).toBe(m.A);
        const [a] = await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_actas WHERE id = ${r.actaId}`;
        expect(a!.p).toBe(m.A);
        clienteAntesQueLicencias();
      });
    });

    it('AC2: dejar pendiente, sin trámite, la deja sin dueño', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const v = await m.vehiculo();
        await m.tramite(cia, v.id); await m.tramite(cia, v.id);
        const r = await svc.escanearLt({ placa: v.placa, numeroLicencia: `L${sello()}`, numeroLt: 'LT1' }, null, {}, ctx, { dejarPendiente: true });
        expect(r.pendienteTramite).toBe(true);
        expect(await m.dueno(r.documentoId!)).toBeNull();
      });
    });
  });

  describe('AC3 — registrar un viaje', () => {
    const viaje = (companiaId: number, documentoId: string) => svc.registrarTraslado({ companiaId, destino: 'cliente', lts: [{ documentoId }] }, ctx);

    it('dueño distinto del proveedor actual → 409 LT_DE_OTRO_PROVEEDOR y sin acta', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.B); const d = await m.doc(cia, { dueno: m.A });
        const e = await rechazo(viaje(cia, d));
        expect([e.status, e.codigo]).toEqual([409, 'LT_DE_OTRO_PROVEEDOR']);
        expect((await m.tx`SELECT count(*)::int c FROM flito_logistica_actas WHERE compania_id = ${cia}`)[0]!.c).toBe(0);
      });
    });

    it('sin dueño, con proveedor actual → también se rechaza', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.B); const d = await m.doc(cia, { dueno: null });
        expect((await rechazo(viaje(cia, d))).codigo).toBe('LT_DE_OTRO_PROVEEDOR');
      });
    });

    it('dueño igual al proveedor actual → se registra y el acta queda con él, con el cliente bloqueado antes que las LT', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const d = await m.doc(cia, { dueno: m.A });
        const r = await viaje(cia, d);
        const [a] = await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_actas WHERE id = ${r.actaId}`;
        expect(a!.p).toBe(m.A);
        clienteAntesQueLicencias();
      });
    });
  });

  describe('AC4 — confirmar una recogida', () => {
    const confirmar = (org: string, documentoIds: string[]) => confirmarRecogida({
      organismoCodigo: org, documentoIds, firmante: { nombre: 'Func', documento: '1036640908', firma: FIRMA },
    }, ctx);
    const firmante = async (m: Mundo, id: string) => (await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_recogida_firmantes WHERE id = ${id}`)[0]!.p;
    const actaDe = async (m: Mundo, id: string) => (await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_actas WHERE id = ${id}`)[0]!.p;

    it('un mismo proveedor: acta y firmante quedan con él, con el cliente bloqueado antes que las LT', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A);
        const r = await confirmar(m.org, [await m.doc(cia, { dueno: m.A }), await m.doc(cia, { dueno: m.A })]);
        expect(await firmante(m, r.firmanteId)).toBe(m.A);
        expect(await actaDe(m, r.actas[0]!.actaId)).toBe(m.A);
        clienteAntesQueLicencias();
      });
    });

    it('proveedores distintos, en compañías distintas: el firmante queda sin proveedor y cada acta con el suyo', async () => {
      await conMundo(async (m) => {
        const ciaA = await m.cia(m.A); const ciaB = await m.cia(m.B);
        const r = await confirmar(m.org, [await m.doc(ciaA, { dueno: m.A }), await m.doc(ciaB, { dueno: m.B })]);
        expect(await firmante(m, r.firmanteId)).toBeNull();
        const porCia = new Map(r.actas.map((a) => [a.companiaId, a.actaId]));
        expect(await actaDe(m, porCia.get(ciaA)!)).toBe(m.A);
        expect(await actaDe(m, porCia.get(ciaB)!)).toBe(m.B);
      });
    });

    it('una pendiente, sin dueño, junto a una de A: el firmante queda sin proveedor', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A);
        const r = await confirmar(m.org, [await m.doc(cia, { dueno: m.A }), await m.doc(null, { estado: 'recogido' })]);
        expect(await firmante(m, r.firmanteId)).toBeNull();
      });
    });
  });

  describe('AC5 a AC7 — cambiar el proveedor', () => {
    it('AC5: sin acta o con acta de organismo firmada y sin viaje pasan a B; AC6: con acta abierta o entregadas siguen con A', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A);
        const sinActa = await m.doc(cia, { dueno: m.A });
        const sinDueno = await m.doc(cia, { dueno: null });
        const conOrganismo = await m.doc(cia, { dueno: m.A });
        const [f] = await m.tx`INSERT INTO flito_logistica_recogida_firmantes (id, organismo_codigo, nombre, firma_storage_key, registrado_por_id) VALUES (gen_random_uuid(), ${m.org}, 'F', 'k', ${ctx.userId}) RETURNING id`;
        const [org] = await m.tx`INSERT INTO flito_logistica_actas (compania_id, punto, organismo_codigo, firmante_id, estado, proveedor_logistica_id) VALUES (${cia}, 'organismo', ${m.org}, ${f!.id}, 'entregada', ${m.A}) RETURNING id`;
        await m.tx`INSERT INTO flito_logistica_acta_lineas (acta_id, documento_id, punto, compania_id) VALUES (${org!.id}, ${conOrganismo}, 'organismo', ${cia})`;
        const enGenerada = await m.doc(cia, { dueno: m.A, estado: 'en_acta' });
        const generada = await m.viaje(cia, [enGenerada], { dueno: m.A, estado: 'registrado', acta: 'generada', linea: 'registrado' });
        const enDespachada = await m.doc(cia, { dueno: m.A, estado: 'despachado' });
        const despachada = await m.viaje(cia, [enDespachada], { dueno: m.A, estado: 'en_ruta', acta: 'despachada', linea: 'en_ruta' });
        const actaLegada = await m.actaSinViaje(cia, 'despachada', m.A);
        const enLegada = await m.doc(cia, { dueno: m.A, estado: 'despachado', actaId: actaLegada });
        const entregada = await m.doc(cia, { dueno: m.A, estado: 'entregado' });

        expect(await reasignarLicenciasDeCompania(actual.db as never, cia, m.B)).toBe(3);

        for (const d of [sinActa, sinDueno, conOrganismo]) expect(await m.dueno(d)).toBe(m.B);
        for (const d of [enGenerada, enDespachada, enLegada, entregada]) expect(await m.dueno(d)).toBe(m.A);
        const actas = await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_actas WHERE id IN (${generada.actaId}, ${despachada.actaId}, ${actaLegada})`;
        expect(actas.map((a) => a.p)).toEqual([m.A, m.A, m.A]);
        expect(consultas.some((q) => /from "clients".*for update/is.test(q))).toBe(true);
      });
    });

    it('no toca las LT de otra compañía con el mismo proveedor', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const otra = await m.cia(m.A);
        const ajena = await m.doc(otra, { dueno: m.A });
        await reasignarLicenciasDeCompania(actual.db as never, cia, m.B);
        expect(await m.dueno(ajena)).toBe(m.A);
      });
    });

    it('reenviar el mismo proveedor: la LT sin dueño pasa a él, y la que ya es suya no cuenta', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const sinDueno = await m.doc(cia, { dueno: null }); const yaSuya = await m.doc(cia, { dueno: m.A });
        expect(await reasignarLicenciasDeCompania(actual.db as never, cia, m.A)).toBe(1);
        expect(await m.dueno(sinDueno)).toBe(m.A);
        expect(await m.dueno(yaSuya)).toBe(m.A);
        expect(await reasignarLicenciasDeCompania(actual.db as never, cia, m.A)).toBe(0);
      });
    });

    it('reenviar el mismo proveedor: la LT con dueño desfasado vuelve a él', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const d = await m.doc(cia, { dueno: m.B });
        expect(await reasignarLicenciasDeCompania(actual.db as never, cia, m.A)).toBe(1);
        expect(await m.dueno(d)).toBe(m.A);
      });
    });

    it('AC6 al reenviar el mismo proveedor: lo que está en acta abierta o entregado sigue igual', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A);
        const enGenerada = await m.doc(cia, { dueno: m.B, estado: 'en_acta' });
        await m.viaje(cia, [enGenerada], { dueno: m.B, estado: 'registrado', acta: 'generada', linea: 'registrado' });
        const enDespachada = await m.doc(cia, { dueno: m.B, estado: 'despachado' });
        await m.viaje(cia, [enDespachada], { dueno: m.B, estado: 'en_ruta', acta: 'despachada', linea: 'en_ruta' });
        const entregada = await m.doc(cia, { dueno: m.B, estado: 'entregado' });
        const entregadaSinDueno = await m.doc(cia, { dueno: null, estado: 'entregado' });

        expect(await reasignarLicenciasDeCompania(actual.db as never, cia, m.A)).toBe(0);

        for (const d of [enGenerada, enDespachada, entregada]) expect(await m.dueno(d)).toBe(m.B);
        expect(await m.dueno(entregadaSinDueno)).toBeNull();
      });
    });

    it('A → sin proveedor → B: la LT de A, sin acta, pasa a B al asignar el nuevo', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(null); const d = await m.doc(cia, { dueno: m.A });
        expect(await reasignarLicenciasDeCompania(actual.db as never, cia, m.B)).toBe(1);
        expect(await m.dueno(d)).toBe(m.B);
      });
    });
  });

  describe('AC8 — los siete caminos de cierre', () => {
    interface Esperado { noEntregada: string; entregada?: string }
    /** Arma el acta de A, cambia la compañía al proveedor indicado, cierra y devuelve las licencias que deben pasar y quedarse. */
    const CAMINOS: Array<[string, (m: Mundo, cia: number) => Promise<() => Promise<Esperado>>]> = [
      ['entregarTraslado (parcial)', async (m, cia) => {
        const ent = await m.doc(cia, { dueno: m.A, estado: 'despachado' }); const dev = await m.doc(cia, { dueno: m.A, estado: 'despachado' });
        const v = await m.viaje(cia, [ent, dev], { dueno: m.A, estado: 'en_ruta', acta: 'despachada', linea: 'en_ruta' });
        return async () => { await svc.entregarTraslado(v.trasladoId, { ...RECEPTOR, ltsDevueltas: [dev] }, ctx); return { noEntregada: dev, entregada: ent }; };
      }],
      ['firmarLlegadaFlit', async (m, cia) => {
        const llega = await m.doc(cia, { dueno: m.A, estado: 'despachado' }); const dev = await m.doc(cia, { dueno: m.A, estado: 'despachado' });
        const v = await m.viaje(cia, [llega, dev], { dueno: m.A, destino: 'flit', estado: 'en_ruta', acta: 'despachada', linea: 'en_ruta' });
        return async () => { await svc.firmarLlegadaFlit(v.trasladoId, { firma: FIRMA_CRUDA, ltsDevueltas: [dev] }, ctx); return { noEntregada: llega }; };
      }],
      ['devolverTraslado', async (m, cia) => {
        const d = await m.doc(cia, { dueno: m.A, estado: 'despachado' });
        const v = await m.viaje(cia, [d], { dueno: m.A, estado: 'en_ruta', acta: 'despachada', linea: 'en_ruta' });
        return async () => { await svc.devolverTraslado(v.trasladoId, 'ausente', ctx); return { noEntregada: d }; };
      }],
      ['anularTraslado', async (m, cia) => {
        const d = await m.doc(cia, { dueno: m.A, estado: 'en_acta' });
        const v = await m.viaje(cia, [d], { dueno: m.A, estado: 'registrado', acta: 'generada', linea: 'registrado' });
        return async () => { await svc.anularTraslado(v.trasladoId, 'error', ctx); return { noEntregada: d }; };
      }],
      ['entregar (acta de viaje, parcial)', async (m, cia) => {
        const ent = await m.doc(cia, { dueno: m.A, estado: 'despachado' }); const dev = await m.doc(cia, { dueno: m.A, estado: 'despachado' });
        const v = await m.viaje(cia, [ent, dev], { dueno: m.A, estado: 'en_ruta', acta: 'despachada', linea: 'en_ruta' });
        return async () => { await svc.entregar(v.actaId, { ...RECEPTOR, ltsDevueltas: [dev] }, ctx); return { noEntregada: dev, entregada: ent }; };
      }],
      ['registrarDevolucion (acta sin viaje)', async (m, cia) => {
        const acta = await m.actaSinViaje(cia, 'despachada', m.A);
        const d = await m.doc(cia, { dueno: m.A, estado: 'despachado', actaId: acta });
        return async () => { await svc.registrarDevolucion(acta, 'rechazo', ctx); return { noEntregada: d }; };
      }],
      ['reversar', async (m, cia) => {
        const d = await m.doc(cia, { dueno: m.A, estado: 'entregado' });
        const queda = await m.doc(cia, { dueno: m.A, estado: 'entregado' });
        await m.viaje(cia, [d, queda], { dueno: m.A, estado: 'entregado', acta: 'entregada', linea: 'entregado' });
        return async () => { await svc.reversar(d, 'clasificado' as never, 'error de entrega', ctx); return { noEntregada: d, entregada: queda }; };
      }],
    ];

    for (const [nombre, armar] of CAMINOS) {
      it(`${nombre} — con proveedor B: lo no entregado pasa a B y lo entregado sigue con A`, async () => {
        await conMundo(async (m) => {
          const cia = await m.cia(m.A);
          const cerrar = await armar(m, cia);
          await m.poner(cia, m.B);
          consultas = [];
          const e = await cerrar();
          expect(await m.dueno(e.noEntregada)).toBe(m.B);
          if (e.entregada) expect(await m.dueno(e.entregada)).toBe(m.A);
          clienteAntesQueLicencias();
        });
      });

      it(`${nombre} — sin proveedor: el dueño no cambia`, async () => {
        await conMundo(async (m) => {
          const cia = await m.cia(m.A);
          const cerrar = await armar(m, cia);
          await m.poner(cia, null);
          const e = await cerrar();
          expect(await m.dueno(e.noEntregada)).toBe(m.A);
          if (e.entregada) expect(await m.dueno(e.entregada)).toBe(m.A);
        });
      });
    }

    it('entregar un acta sin viaje: todo queda entregado y sigue con A, con la compañía ya en B', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A);
        const acta = await m.actaSinViaje(cia, 'despachada', m.A);
        const d = await m.doc(cia, { dueno: m.A, estado: 'despachado', actaId: acta });
        await m.poner(cia, m.B);
        consultas = [];
        await svc.entregar(acta, RECEPTOR, ctx);
        expect(await m.dueno(d)).toBe(m.A);
        clienteAntesQueLicencias();
      });
    });

    it('la LT reversada desde un acta aún abierta sigue con A hasta que esa acta se cierre', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A);
        const d = await m.doc(cia, { dueno: m.A, estado: 'en_acta' });
        const v = await m.viaje(cia, [d], { dueno: m.A, estado: 'registrado', acta: 'generada', linea: 'registrado' });
        await m.poner(cia, m.B);
        await svc.reversar(d, 'clasificado' as never, 'error', ctx);
        expect(await m.dueno(d)).toBe(m.A);
        await svc.anularTraslado(v.trasladoId, 'error', ctx);
        expect(await m.dueno(d)).toBe(m.B);
      });
    });
  });

  describe('AC9 — licencias existentes', () => {
    const MIG = '0294_flito_logistica_dueno_proveedor.sql';

    it('las no entregadas y sin acta abierta quedan con el proveedor actual; las demás sin dueño; dos aplicaciones, mismo resultado', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const sinProveedor = await m.cia(null);
        const libre = await m.doc(cia);
        const devuelta = await m.doc(cia, { estado: 'devuelto' });
        const entregada = await m.doc(cia, { estado: 'entregado' });
        const enActa = await m.doc(cia, { estado: 'en_acta' });
        await m.viaje(cia, [enActa], { dueno: m.A, estado: 'registrado', acta: 'generada', linea: 'registrado' });
        const actaLegada = await m.actaSinViaje(cia, 'despachada', m.A);
        const enLegada = await m.doc(cia, { estado: 'despachado', actaId: actaLegada });
        const actaCerrada = await m.actaSinViaje(cia, 'devuelta', m.A);
        const conCerrada = await m.doc(cia, { estado: 'clasificado', actaId: actaCerrada });
        const companiaSinProveedor = await m.doc(sinProveedor);
        const pendiente = await m.doc(null, { estado: 'recogido' });

        const estado = async () => Object.fromEntries(await Promise.all(Object.entries({ libre, devuelta, entregada, enActa, enLegada, conCerrada, companiaSinProveedor, pendiente })
          .map(async ([k, id]) => [k, await m.dueno(id)])));

        await m.tx.unsafe(leerMigracion(MIG));
        const primera = await estado();
        expect(primera).toEqual({
          libre: m.A, devuelta: m.A, conCerrada: m.A,
          entregada: null, enActa: null, enLegada: null, companiaSinProveedor: null, pendiente: null,
        });
        await m.tx.unsafe(leerMigracion(MIG));
        expect(await estado()).toEqual(primera);
      });
    });

    it('no pisa un dueño ya estampado', async () => {
      await conMundo(async (m) => {
        const cia = await m.cia(m.A); const d = await m.doc(cia, { dueno: m.B });
        await m.tx.unsafe(leerMigracion(MIG));
        expect(await m.dueno(d)).toBe(m.B);
      });
    });
  });
});
