// ADR-0041 §13 (Enmienda 1, Épica #13763) — costo de proveedor en el reporte de costos y al sellar, contra
// PostgreSQL de verdad: las reglas viven en SQL correlacionado y solo una base real las ejecuta. Se SALTA sin
// TEST_DATABASE_URL. Todo dentro de una transacción con ROLLBACK (`enTx`); `db` del módulo se redirige a un
// drizzle montado sobre ESA transacción, así que corre la consulta REAL del reporte (`reporteCostos`).
//
// Matriz regla → casos:
//   C2 / RN-CP-02  SOAT con proveedor y vigencia en `enviado_en` (otra vigencia posterior no se usa); `gestion_operaciones`;
//                  sin proveedor; H-1 sin `enviado_en` ⇒ sin_proveedor; H-4 compañía autogestiona SOAT ⇒ sin_proveedor
//   C3 / RN-CP-03  SOAT compartido por 3 trámites ⇒ uno `costo`, dos `ya_contado`; empate de `created_at` por `id`;
//                  H-5 el primero se elige entre compañías distintas
//   C4 / RN-CP-04  primera entrega con proveedor y vigencia en `entregado_en`; segunda entrega de otro proveedor ignorada;
//                  H-3 primera entrega `legado` o anterior al corte se salta y cuenta la primera VÁLIDA; sin entregas y
//                  autogestionada ⇒ sin_proveedor
//   Enmienda 1.1   sin entrega y compañía con proveedor de logística ⇒ su vigencia de HOY; sin vigencia ⇒
//                  sin_configurar; sin proveedor ⇒ sin_proveedor; con entrega manda el acta; nunca se sella
//   C7 / RN-CP-07  proveedor sin vigencia ⇒ `sin_configurar`; filtro `costoProveedorSinConfigurar` pagina y cuenta
//   C1 / RN-CP-01  con y sin vigencias de proveedor: total, gmf, reintegro, servicio, totales, consolidado y etapas idénticos
//   C6 / RN-CP-06  `costosProveedorParaSellar`: congela lo definitivo; H-1/H-2 dejan `null` lo que espera su evento;
//                  sello con la clave manda; sello sin la clave o concepto null ⇒ vivo `estimado`
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, { get: (_t, k) => (actual.db as Record<string | symbol, unknown>)[k] }),
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const schema = await import('../../src/db/schema.js');
const { reporteCostos } = await import('../../src/modules/finanzas/finanzas.service.js');
const { consolidadoReporte } = await import('../../src/modules/finanzas/finanzas.consolidado.js');
const { costosProveedorParaSellar } = await import('../../src/modules/finanzas/finanzas.costos-proveedor.js');

type Tx = postgres.TransactionSql;
let n = 0;
const sello = () => `${String(Date.now()).slice(-7)}${n++}`;
const HACE = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();

interface Mundo {
  tx: Tx; org: string; buscar: string;
  proveedor(o?: { soat?: boolean; nombre?: string }): Promise<string>;
  vigencia(p: string, concepto: 'logistica' | 'soat_con_tramite', valor: number, desde: string, hasta?: string | null): Promise<string>;
  cia(o?: { autoSoat?: boolean; autoLog?: boolean; provLog?: string | null }): Promise<number>;
  soat(cia: number, o: { proveedor?: string | null; enviado?: string | null; operaciones?: boolean }): Promise<string>;
  tramite(cia: number, o?: { soat?: string | null; creado?: string; id?: string }): Promise<{ id: string; idFlit: string }>;
  entrega(tramite: string, cia: number, proveedor: string | null, o: { entregado: string; legado?: boolean; actaCreada?: string; destino?: 'flit' | 'cliente' }): Promise<void>;
  corte(en: string): Promise<void>;
  sellar(tramite: string, detalle: Record<string, unknown>): Promise<void>;
}

/** Corre `fn` con un mundo aislado (prefijo de búsqueda propio) dentro de una transacción con ROLLBACK. */
async function conMundo(fn: (m: Mundo) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      // `TransactionSql` no trae `options` (drizzle lee de ahí los parsers): se le prestan los de la conexión.
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      const buscar = `CP${sello()}`;
      const org = (await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`)[0]?.codigo as string
        ?? (await tx`INSERT INTO organismos_transito_config (codigo, activo) VALUES ('99999', true) RETURNING codigo`)[0]!.codigo as string;
      let k = 0;
      const m: Mundo = {
        tx, org, buscar,
        proveedor: async (o = {}) => {
          const nombre = o.nombre ?? `Prov ${sello()}`;
          const [l] = await tx`INSERT INTO flito_proveedores_logistica (nombre, activo, nit) VALUES (${nombre}, true, ${`8${sello()}`}) RETURNING id`;
          const id = l!.id as string;
          if (o.soat) await tx`INSERT INTO flito_proveedores_soat (id, nombre, activo) VALUES (${id}, ${nombre}, true)`;
          return id;
        },
        vigencia: async (p, concepto, valor, desde, hasta = null) => {
          const [v] = await tx`INSERT INTO flito_tarifas_proveedor_vigencias (proveedor_id, servicio, concepto, valor, vigente_desde, vigente_hasta, cerrado_en, cerrado_por_id)
            VALUES (${p}, ${concepto === 'logistica' ? 'logistica' : 'soat'}, ${concepto}, ${valor}, ${desde}, ${hasta}, ${hasta},
              ${hasta === null ? null : (await tx`SELECT id FROM users LIMIT 1`)[0]?.id ?? null}) RETURNING id`;
          return v!.id as string;
        },
        cia: async (o = {}) => (await tx`INSERT INTO clients (name, document, soat_autogestionable, logistica_autogestionable, flito_proveedor_logistica_id)
          VALUES (${`Cia ${sello()}`}, ${`D${sello()}`}, ${o.autoSoat ?? false}, ${o.autoLog ?? false}, ${o.provLog ?? null}) RETURNING id`)[0]!.id as number,
        soat: async (cia, o) => {
          const placa = `S${sello().slice(-6)}`;
          const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${`VIN${placa}`}) RETURNING id`;
          return (await tx`INSERT INTO flito_soat (compania_id, vehiculo_id, vin, estado, proveedor_soat_id, enviado_en, gestion_operaciones)
            VALUES (${cia}, ${v!.id}, ${`VIN${placa}`}, 'pagado'::flito_soat_estado, ${o.proveedor ?? null}, ${o.enviado ?? null}, ${o.operaciones ?? false})
            RETURNING id`)[0]!.id as string;
        },
        tramite: async (cia, o = {}) => {
          const placa = `T${sello().slice(-6)}`;
          const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${`VIN${placa}`}) RETURNING id`;
          const idFlit = `${buscar}-${String(++k).padStart(2, '0')}`;
          const [t] = await tx`INSERT INTO flito_tramites (id, id_flit, sincronizado_en, vehiculo_id, compania_id, compania_nit, organismo_codigo, flit_estado, soat_id, created_at)
            VALUES (${o.id ?? (await tx`SELECT gen_random_uuid() AS u`)[0]!.u}, ${idFlit}, now(), ${v!.id}, ${cia}, '900', ${org}, 'Aprobado', ${o.soat ?? null}, ${o.creado ?? new Date().toISOString()})
            RETURNING id`;
          return { id: t!.id as string, idFlit };
        },
        entrega: async (tramite, cia, proveedor, o) => {
          const destino = o.destino ?? 'cliente';
          let [d] = await tx`SELECT id FROM flito_logistica_documentos WHERE tramite_id = ${tramite} AND tipo = 'licencia_transito'`;
          if (!d) {
            const veh = (await tx`SELECT vehiculo_id FROM flito_tramites WHERE id = ${tramite}`)[0]!.vehiculo_id;
            [d] = await tx`INSERT INTO flito_logistica_documentos (tramite_id, tipo, estado, organismo_codigo, compania_id, vehiculo_id)
              VALUES (${tramite}, 'licencia_transito', 'entregado', ${org}, ${cia}, ${veh}) RETURNING id`;
          }
          const [t] = await tx`INSERT INTO flito_logistica_traslados (compania_id, destino, origen, estado, registrado_en, legado)
            VALUES (${cia}, ${destino}, 'organismo', 'entregado', now(), ${o.legado ?? false}) RETURNING id`;
          await tx`INSERT INTO flito_logistica_actas (compania_id, punto, estado, proveedor_logistica_id, traslado_id, entregado_en, created_at)
            VALUES (${cia}, ${destino}, 'entregada', ${proveedor}, ${t!.id}, ${o.entregado}, ${o.actaCreada ?? o.entregado})`;
          // Hacia FLIT la línea exige motivo de llegada (`ck_flito_log_traslado_lts_motivo`).
          const motivo = destino === 'flit'
            ? (await tx`INSERT INTO flito_logistica_motivos_llegada (nombre, activo) VALUES (${`Motivo ${sello()}`}, true) RETURNING id`)[0]!.id
            : null;
          await tx`INSERT INTO flito_logistica_traslado_lts (traslado_id, destino, documento_id, estado, concepto_precio, precio, motivo_llegada_id)
            VALUES (${t!.id}, ${destino}, ${d!.id}, 'entregado', 'logistica_cliente', 18500, ${motivo})`;
        },
        corte: async (en) => {
          await tx`INSERT INTO flito_logistica_corte_proveedor (unica, corte_en) VALUES (true, ${en})
            ON CONFLICT (unica) DO UPDATE SET corte_en = EXCLUDED.corte_en`;
        },
        sellar: async (tramite, detalle) => {
          await tx`INSERT INTO flito_liquidaciones (tramite_id, estado, base_gmf, tasa_gmf, valor_gmf, total, detalle)
            VALUES (${tramite}, 'liquidado', 0, 0.004, 0, 0, ${JSON.stringify(detalle)}::jsonb)`;
        },
      };
      // Sin corte por defecto: cada caso que lo necesita lo siembra (la 0298 lo siembra en los ambientes).
      await tx`DELETE FROM flito_logistica_corte_proveedor`;
      await fn(m);
    });
  } finally { await sql.end(); }
}

/** El consolidado sin las claves del costo de proveedor: lo que es COBRO (C1). */
function soloCobro(c: Awaited<ReturnType<typeof consolidadoReporte>>) {
  const quitar = <T extends Record<string, unknown>>(t: T) => {
    const { costoProveedorSoat: _a, costoProveedorLogistica: _b, costoProveedorTotal: _c, tramitesCostoSinConfigurar: _d, ...resto } = t;
    return resto;
  };
  return { ...c, items: c.items.map(quitar), totales: quitar(c.totales) };
}

const fila = async (m: Mundo, idFlit: string) => {
  const r = await reporteCostos({ buscar: idFlit, pageSize: 50 });
  const f = r.items.find((x) => x.idFlit === idFlit);
  if (!f) throw new Error(`sin fila ${idFlit}`);
  return f;
};

describe.skipIf(!URL_BASE)('ADR-0041 §13 — costo de proveedor (PostgreSQL)', () => {
  describe('C2 / RN-CP-02 — SOAT con trámite', () => {
    it('vigencia en `enviado_en`; la vigencia posterior no se usa', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true, nombre: `Seguros ${sello()}` });
      const vieja = await m.vigencia(p, 'soat_con_tramite', 12000, HACE(30), HACE(5));
      await m.vigencia(p, 'soat_con_tramite', 99999, HACE(5));
      const cia = await m.cia();
      const s = await m.soat(cia, { proveedor: p, enviado: HACE(10) });
      const t = await m.tramite(cia, { soat: s });
      const f = await fila(m, t.idFlit);
      expect(f.costoProveedorSoat).toMatchObject({ estado: 'costo', proveedorId: p, vigenciaId: vieja, valor: 12000, contadoEnIdFlit: null });
      expect(f.costoProveedorSoat.fechaReferencia).not.toBeNull();
      expect(f.costoProveedorTotal).toBe(12000);
    }));

    it('`gestion_operaciones` ⇒ gestionado_operaciones; sin proveedor ⇒ sin_proveedor; sin SOAT ⇒ sin_proveedor', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'soat_con_tramite', 12000, HACE(30));
      const cia = await m.cia();
      const ops = await m.tramite(cia, { soat: await m.soat(cia, { proveedor: p, enviado: HACE(1), operaciones: true }) });
      const sinProv = await m.tramite(cia, { soat: await m.soat(cia, { proveedor: null, enviado: HACE(1) }) });
      const sinSoat = await m.tramite(cia);
      expect((await fila(m, ops.idFlit)).costoProveedorSoat.estado).toBe('gestionado_operaciones');
      expect((await fila(m, sinProv.idFlit)).costoProveedorSoat.estado).toBe('sin_proveedor');
      const f = await fila(m, sinSoat.idFlit);
      expect(f.costoProveedorSoat).toEqual({
        estado: 'sin_proveedor', proveedorId: null, proveedor: null, vigenciaId: null, valor: null,
        fechaReferencia: null, contadoEnTramiteId: null, contadoEnIdFlit: null,
      });
      expect(f.costoProveedorTotal).toBeNull();
    }));

    it('H-1 — con proveedor y sin `enviado_en` ⇒ sin_proveedor (sin valor estimado)', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'soat_con_tramite', 12000, HACE(30));
      const cia = await m.cia();
      const t = await m.tramite(cia, { soat: await m.soat(cia, { proveedor: p, enviado: null }) });
      expect((await fila(m, t.idFlit)).costoProveedorSoat).toMatchObject({ estado: 'sin_proveedor', valor: null });
    }));

    it('H-4 — la compañía autogestiona el SOAT ⇒ sin_proveedor', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'soat_con_tramite', 12000, HACE(30));
      const cia = await m.cia({ autoSoat: true });
      const t = await m.tramite(cia, { soat: await m.soat(cia, { proveedor: p, enviado: HACE(1) }) });
      expect((await fila(m, t.idFlit)).costoProveedorSoat).toMatchObject({ estado: 'sin_proveedor', valor: null });
    }));
  });

  describe('C3 / RN-CP-03 — SOAT compartido', () => {
    it('3 trámites ⇒ uno costo y dos ya_contado con el idFlit del primero; empate de created_at por id', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'soat_con_tramite', 15000, HACE(30));
      const cia = await m.cia();
      const s = await m.soat(cia, { proveedor: p, enviado: HACE(2) });
      const mismo = HACE(3);
      // Mismo created_at: gana el id menor.
      const a = await m.tramite(cia, { soat: s, creado: mismo, id: 'ffffffff-0000-4000-8000-000000000001' });
      const b = await m.tramite(cia, { soat: s, creado: mismo, id: '00000000-0000-4000-8000-000000000001' });
      const c = await m.tramite(cia, { soat: s, creado: HACE(1) });
      const fb = await fila(m, b.idFlit);
      expect(fb.costoProveedorSoat).toMatchObject({ estado: 'costo', valor: 15000 });
      for (const x of [a, c]) {
        expect((await fila(m, x.idFlit)).costoProveedorSoat).toMatchObject({
          estado: 'ya_contado', valor: null, contadoEnTramiteId: b.id, contadoEnIdFlit: b.idFlit,
        });
      }
    }));

    it('H-5 — el primero se elige entre todos los trámites del soat_id, sin mirar la compañía', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'soat_con_tramite', 15000, HACE(30));
      const cia1 = await m.cia(); const cia2 = await m.cia();
      const s = await m.soat(cia1, { proveedor: p, enviado: HACE(2) });
      const primero = await m.tramite(cia2, { soat: s, creado: HACE(4) });
      const segundo = await m.tramite(cia1, { soat: s, creado: HACE(1) });
      expect((await fila(m, primero.idFlit)).costoProveedorSoat.estado).toBe('costo');
      expect((await fila(m, segundo.idFlit)).costoProveedorSoat).toMatchObject({ estado: 'ya_contado', contadoEnIdFlit: primero.idFlit });
    }));
  });

  describe('C4 / RN-CP-04 — logística, valor fijo por trámite', () => {
    it('primera entrega con su vigencia en `entregado_en`; la segunda, de otro proveedor, se ignora', () => conMundo(async (m) => {
      const pa = await m.proveedor({ nombre: `Mensajería ${sello()}` }); const pb = await m.proveedor();
      const va = await m.vigencia(pa, 'logistica', 8000, HACE(30), HACE(3));
      await m.vigencia(pa, 'logistica', 50000, HACE(3));
      await m.vigencia(pb, 'logistica', 70000, HACE(30));
      const cia = await m.cia();
      const t = await m.tramite(cia);
      await m.entrega(t.id, cia, pa, { entregado: HACE(5), destino: 'flit' });
      await m.entrega(t.id, cia, pb, { entregado: HACE(1), destino: 'cliente' });
      const f = await fila(m, t.idFlit);
      expect(f.costoProveedorLogistica).toMatchObject({ estado: 'costo', proveedorId: pa, vigenciaId: va, valor: 8000 });
      expect(f.costoProveedorTotal).toBe(8000);
    }));

    it('H-3 — primera entrega `legado` o con acta anterior al corte se salta; cuenta la primera VÁLIDA', () => conMundo(async (m) => {
      const pa = await m.proveedor(); const pb = await m.proveedor(); const pc = await m.proveedor();
      for (const p of [pa, pb, pc]) await m.vigencia(p, 'logistica', p === pc ? 9100 : 1, HACE(60));
      await m.corte(HACE(10));
      const cia = await m.cia();
      const t = await m.tramite(cia);
      await m.entrega(t.id, cia, pa, { entregado: HACE(8), legado: true, destino: 'flit' });
      await m.entrega(t.id, cia, pb, { entregado: HACE(7), actaCreada: HACE(20), destino: 'cliente' });
      const t2 = await m.tramite(cia);
      await m.entrega(t2.id, cia, pa, { entregado: HACE(8), legado: true, destino: 'flit' });
      await m.entrega(t2.id, cia, pc, { entregado: HACE(2), destino: 'cliente' });
      expect((await fila(m, t.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'sin_proveedor', valor: null });
      expect((await fila(m, t2.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'costo', proveedorId: pc, valor: 9100 });
    }));

    it('sin entregas ⇒ sin_proveedor; compañía que autogestiona logística ⇒ sin_proveedor', () => conMundo(async (m) => {
      const p = await m.proveedor();
      await m.vigencia(p, 'logistica', 8000, HACE(30));
      const cia = await m.cia(); const auto = await m.cia({ autoLog: true });
      const sinEntrega = await m.tramite(cia);
      const autog = await m.tramite(auto);
      await m.entrega(autog.id, auto, p, { entregado: HACE(1) });
      expect((await fila(m, sinEntrega.idFlit)).costoProveedorLogistica.estado).toBe('sin_proveedor');
      expect((await fila(m, autog.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'sin_proveedor', valor: null });
    }));
  });

  describe('Enmienda 1.1 — logística estimada por la compañía antes de la entrega', () => {
    it('sin entrega y compañía con proveedor ⇒ la vigencia `logistica` de HOY de ese proveedor', () => conMundo(async (m) => {
      const p = await m.proveedor({ nombre: `Sura ${sello()}` });
      await m.vigencia(p, 'logistica', 1111, HACE(60), HACE(10));
      const vHoy = await m.vigencia(p, 'logistica', 6500, HACE(10));
      const cia = await m.cia({ provLog: p });
      const t = await m.tramite(cia);
      const f = await fila(m, t.idFlit);
      expect(f.costoProveedorLogistica).toMatchObject({ estado: 'costo', proveedorId: p, vigenciaId: vHoy, valor: 6500 });
      expect(Date.now() - new Date(f.costoProveedorLogistica.fechaReferencia!).getTime()).toBeLessThan(86_400_000);
      expect(f.costoProveedorTotal).toBe(6500);
    }));

    it('proveedor de la compañía sin vigencia hoy ⇒ sin_configurar con su nombre; sin proveedor configurado ⇒ sin_proveedor', () => conMundo(async (m) => {
      const nombre = `Sin tarifa ${sello()}`;
      const p = await m.proveedor({ nombre });
      await m.vigencia(p, 'logistica', 4000, HACE(60), HACE(10));
      const conProv = await m.tramite(await m.cia({ provLog: p }));
      const sinProv = await m.tramite(await m.cia());
      expect((await fila(m, conProv.idFlit)).costoProveedorLogistica).toMatchObject({
        estado: 'sin_configurar', proveedorId: p, proveedor: nombre, vigenciaId: null, valor: null,
      });
      expect((await fila(m, sinProv.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'sin_proveedor', valor: null });
    }));

    it('con entrega válida manda el proveedor del acta aunque la compañía tenga otro; autogestiona ⇒ sin_proveedor', () => conMundo(async (m) => {
      const pActa = await m.proveedor(); const pCia = await m.proveedor();
      await m.vigencia(pActa, 'logistica', 8000, HACE(30));
      await m.vigencia(pCia, 'logistica', 6500, HACE(30));
      const cia = await m.cia({ provLog: pCia });
      const t = await m.tramite(cia);
      await m.entrega(t.id, cia, pActa, { entregado: HACE(2) });
      expect((await fila(m, t.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'costo', proveedorId: pActa, valor: 8000 });
      const auto = await m.tramite(await m.cia({ autoLog: true, provLog: pCia }));
      expect((await fila(m, auto.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'sin_proveedor', valor: null });
    }));
  });

  describe('C7 / RN-CP-07 — sin configurar', () => {
    it('proveedor sin vigencia en la fecha ⇒ sin_configurar; el filtro pagina y cuenta solo esos', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'logistica', 8000, HACE(2)); // empieza DESPUÉS de la entrega
      const cia = await m.cia();
      const sinConf = [await m.tramite(cia), await m.tramite(cia), await m.tramite(cia)];
      for (const t of sinConf) await m.entrega(t.id, cia, p, { entregado: HACE(5) });
      const conValor = await m.tramite(cia);
      await m.entrega(conValor.id, cia, p, { entregado: HACE(1) });
      const f = await fila(m, sinConf[0]!.idFlit);
      expect(f.costoProveedorLogistica).toMatchObject({ estado: 'sin_configurar', proveedorId: p, vigenciaId: null, valor: null });
      // Lo que «sin configurar» NO hace: bloquear o marcar incompleta la fila (no entra en noConfigurados).
      expect(f.noConfigurados).not.toContain('Costo de proveedor');

      const todos = await reporteCostos({ buscar: m.buscar });
      expect(todos.total).toBe(4);
      const p1 = await reporteCostos({ buscar: m.buscar, costoProveedorSinConfigurar: true, page: 1, pageSize: 2 });
      const p2 = await reporteCostos({ buscar: m.buscar, costoProveedorSinConfigurar: true, page: 2, pageSize: 2 });
      expect(p1.total).toBe(3);
      expect(p1.items).toHaveLength(2);
      expect(p2.items).toHaveLength(1);
      expect([...p1.items, ...p2.items].map((x) => x.idFlit).sort()).toEqual(sinConf.map((t) => t.idFlit).sort());
    }));
  });

  describe('C1 / RN-CP-01 — el costo NO suma al cobro', () => {
    it('mismo universo con y sin vigencias de proveedor ⇒ total, gmf, RN-02, totales, consolidado y etapas idénticos', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      const cia = await m.cia();
      const s = await m.soat(cia, { proveedor: p, enviado: HACE(3) });
      const t1 = await m.tramite(cia, { soat: s });
      await m.entrega(t1.id, cia, p, { entregado: HACE(2) });
      await m.tramite(cia);
      const cobro = async () => {
        const r = await reporteCostos({ buscar: m.buscar });
        return {
          filas: r.items.map((f) => ({ id: f.idFlit, total: f.total, gmf: f.gmf, reintegro: f.totalReintegro, servicio: f.totalServicio, noConf: f.noConfigurados })),
          totales: r.totales, etapas: r.resumen, total: r.total,
          consolidado: soloCobro(await consolidadoReporte({ buscar: m.buscar }, 'mes')),
        };
      };
      const sin = await cobro();
      expect((await fila(m, t1.idFlit)).costoProveedorSoat.estado).toBe('sin_configurar');
      await m.vigencia(p, 'soat_con_tramite', 123456, HACE(30));
      await m.vigencia(p, 'logistica', 654321, HACE(30));
      const con = await cobro();
      expect((await fila(m, t1.idFlit)).costoProveedorTotal).toBe(777777);
      expect(con).toEqual(sin);
      // El consolidado SÍ muestra el costo, como grupo aparte (sin margen): suma solo lo que tiene valor.
      const c = await consolidadoReporte({ buscar: m.buscar }, 'mes');
      expect(c.totales).toMatchObject({ costoProveedorSoat: 123456, costoProveedorLogistica: 654321, costoProveedorTotal: 777777, tramitesCostoSinConfigurar: 0 });
    }));

    it('detalle: `totalesCostosProveedor` = costo del consolidado para el mismo filtro, y `totales` no cambia', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      const cia = await m.cia();
      const s = await m.soat(cia, { proveedor: p, enviado: HACE(3) });
      const t1 = await m.tramite(cia, { soat: s, creado: HACE(4) });
      await m.tramite(cia, { soat: s, creado: HACE(1) }); // ya_contado: no suma
      await m.entrega(t1.id, cia, p, { entregado: HACE(2) });
      const sinConf = await m.tramite(cia);
      await m.entrega(sinConf.id, cia, p, { entregado: HACE(1) });
      const antes = await reporteCostos({ buscar: m.buscar });
      await m.vigencia(p, 'soat_con_tramite', 20000, HACE(30));
      await m.vigencia(p, 'logistica', 5000, HACE(30));
      const r = await reporteCostos({ buscar: m.buscar });
      const c = await consolidadoReporte({ buscar: m.buscar }, 'mes');
      const { costoProveedorSoat, costoProveedorLogistica, costoProveedorTotal, tramitesCostoSinConfigurar } = c.totales;
      expect(r.totalesCostosProveedor).toEqual({ costoProveedorSoat, costoProveedorLogistica, costoProveedorTotal, tramitesCostoSinConfigurar });
      expect(r.totalesCostosProveedor).toEqual({ costoProveedorSoat: 20000, costoProveedorLogistica: 10000, costoProveedorTotal: 30000, tramitesCostoSinConfigurar: 0 });
      expect(antes.totalesCostosProveedor.tramitesCostoSinConfigurar).toBe(2);
      // RN-CP-01: el cobro del pie no se mueve al aparecer el costo.
      expect(r.totales).toEqual(antes.totales);
      expect(r.totales).not.toHaveProperty('costoProveedorTotal');
    }));

    it('consolidado: ya_contado no suma; sin_configurar cuenta como «parcial» y no suma', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'soat_con_tramite', 15000, HACE(30));
      const cia = await m.cia();
      const s = await m.soat(cia, { proveedor: p, enviado: HACE(2) });
      await m.tramite(cia, { soat: s, creado: HACE(3) });
      await m.tramite(cia, { soat: s, creado: HACE(1) }); // ya_contado
      const sinConf = await m.tramite(cia);
      await m.entrega(sinConf.id, cia, p, { entregado: HACE(1) }); // logística sin vigencia
      const c = await consolidadoReporte({ buscar: m.buscar }, 'mes');
      expect(c.totales).toMatchObject({ costoProveedorSoat: 15000, costoProveedorLogistica: 0, costoProveedorTotal: 15000, tramitesCostoSinConfigurar: 1 });
    }));
  });

  describe('C6 / RN-CP-06 — sellado', () => {
    it('congela lo definitivo; SOAT sin enviar (H-1) y logística sin entrega (H-2) quedan null', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'soat_con_tramite', 12000, HACE(30));
      await m.vigencia(p, 'logistica', 8000, HACE(30));
      const cia = await m.cia();
      const listo = await m.tramite(cia, { soat: await m.soat(cia, { proveedor: p, enviado: HACE(2) }) });
      await m.entrega(listo.id, cia, p, { entregado: HACE(1) });
      const db = actual.db as Parameters<typeof costosProveedorParaSellar>[0];
      const g = { gestionaSoat: true, gestionaLogistica: true };
      const s1 = await costosProveedorParaSellar(db, listo.id, g);
      expect(s1).toMatchObject({ version: 1, soat: { estado: 'costo', valor: 12000, proveedorId: p }, logistica: { estado: 'costo', valor: 8000 } });

      const abierto = await m.tramite(cia, { soat: await m.soat(cia, { proveedor: p, enviado: null }) });
      expect(await costosProveedorParaSellar(db, abierto.id, g)).toEqual({ version: 1, soat: null, logistica: null });

      // Lo que NO depende de un evento futuro se congela: no gestiona ⇒ sin_proveedor definitivo.
      const s3 = await costosProveedorParaSellar(db, abierto.id, { gestionaSoat: false, gestionaLogistica: false });
      expect(s3.soat?.estado).toBe('sin_proveedor');
      expect(s3.logistica?.estado).toBe('sin_proveedor');
    }));

    it('sello con la clave manda (cambiar la vigencia no lo mueve); sin la clave o concepto null ⇒ vivo `estimado`', () => conMundo(async (m) => {
      const p = await m.proveedor({ soat: true });
      await m.vigencia(p, 'logistica', 8000, HACE(30));
      const cia = await m.cia();
      const congelado = await m.tramite(cia);
      await m.entrega(congelado.id, cia, p, { entregado: HACE(1) });
      const db = actual.db as Parameters<typeof costosProveedorParaSellar>[0];
      const sellado = await costosProveedorParaSellar(db, congelado.id, { gestionaSoat: true, gestionaLogistica: true });
      await m.sellar(congelado.id, { costosProveedor: sellado });
      await m.tx`UPDATE flito_tarifas_proveedor_vigencias SET valor = 1 WHERE proveedor_id = ${p}`;
      expect((await fila(m, congelado.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'costo', valor: 8000 });

      const viejo = await m.tramite(cia);
      await m.entrega(viejo.id, cia, p, { entregado: HACE(1) });
      await m.sellar(viejo.id, {});
      expect((await fila(m, viejo.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'estimado', valor: 1 });

      // H-2: sellado antes de la primera entrega ⇒ null; tras la entrega se lee en vivo como estimado.
      const antes = await m.tramite(cia);
      const s = await costosProveedorParaSellar(db, antes.id, { gestionaSoat: true, gestionaLogistica: true });
      expect(s.logistica).toBeNull();
      await m.sellar(antes.id, { costosProveedor: s });
      expect((await fila(m, antes.idFlit)).costoProveedorLogistica.estado).toBe('sin_proveedor');
      await m.entrega(antes.id, cia, p, { entregado: HACE(0) });
      expect((await fila(m, antes.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'estimado', valor: 1 });
    }));

    it('Enmienda 1.1 — sin entrega se congela null aunque la compañía dé estimación; el reporte la lee `estimado`', () => conMundo(async (m) => {
      const p = await m.proveedor();
      await m.vigencia(p, 'logistica', 6500, HACE(30));
      const cia = await m.cia({ provLog: p });
      const t = await m.tramite(cia);
      const db = actual.db as Parameters<typeof costosProveedorParaSellar>[0];
      const s = await costosProveedorParaSellar(db, t.id, { gestionaSoat: true, gestionaLogistica: true });
      expect(s.logistica).toBeNull();
      await m.sellar(t.id, { costosProveedor: s });
      expect((await fila(m, t.idFlit)).costoProveedorLogistica).toMatchObject({ estado: 'estimado', proveedorId: p, valor: 6500 });
    }));
  });
});
