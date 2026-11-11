// Épica #13763 (ADR-0041 §4.1, §5) — la tabla `flito_tarifas_proveedor_vigencias` contra PostgreSQL de verdad. Se SALTA sin
// TEST_DATABASE_URL. Los casos de restricciones y de servicio retirado corren dentro de una transacción con ROLLBACK
// (`enTx`) tras aplicar la 0300 (idempotente). La carrera de dos aperturas necesita DOS conexiones con datos confirmados:
// usa fixtures propios y los borra al terminar; se salta si la base no tiene la 0300 aplicada.
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { abrirBase, enTx, leerMigracion, URL_BASE } from '../helpers/base-en-tx.js';

// El servicio solo se importa por su clasificador de errores: sin BD propia.
vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const { esChoqueDeLlaveCosto } = await import('../../src/modules/flito-parametrizacion/flito-tarifas-proveedor.service.js');
const { CONCEPTOS_DE_SERVICIO } = await import('@operaciones/shared-types');

type Tx = postgres.TransactionSql;
const MIGRACION = leerMigracion('0300_flito_tarifas_proveedor.sql');
let n = 0;
const sello = () => `${String(Date.now()).slice(-7)}${n++}`;

/** Un proveedor con perfil de Logística (el trigger de la 0292 crea el padre con el mismo id) y, opcional, de SOAT. */
async function proveedor(sql: Tx | postgres.Sql, conSoat = false): Promise<string> {
  const nombre = `TP13763 ${sello()}`;
  const [l] = await sql`INSERT INTO flito_proveedores_logistica (nombre, activo, nit) VALUES (${nombre}, true, ${`8${sello()}`}) RETURNING id`;
  const id = l!.id as string;
  if (conSoat) await sql`INSERT INTO flito_proveedores_soat (id, nombre, activo) VALUES (${id}, ${nombre}, true)`;
  return id;
}

const abrir = (tx: Tx, p: string, concepto: string, valor: number | string, servicio?: string) =>
  tx`INSERT INTO flito_tarifas_proveedor_vigencias (proveedor_id, servicio, concepto, valor)
     VALUES (${p}, ${servicio ?? (concepto === 'logistica' ? 'logistica' : 'soat')}, ${concepto}, ${valor}) RETURNING id`;

/** Corre `fn` en un savepoint y devuelve el código SQLSTATE con que falló (o null si no falló). */
async function falla(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<string | null> {
  try { await tx.savepoint((sp) => fn(sp as Tx)); return null; } catch (e) { return (e as { code?: string }).code ?? 'sin-codigo'; }
}

const conTabla = (fn: (tx: Tx) => Promise<void>) => async () => {
  const sql = abrirBase();
  try { await enTx(sql, async (tx) => { await tx.unsafe(MIGRACION); await fn(tx); }); } finally { await sql.end(); }
};

describe.skipIf(!URL_BASE)('tarifas de proveedor (PostgreSQL)', () => {
  describe('R2 — par concepto ↔ servicio en BD', () => {
    it('el CHECK rechaza un par cruzado y acepta los tres válidos', conTabla(async (tx) => {
      const p = await proveedor(tx, true);
      expect(await falla(tx, (sp) => abrir(sp, p, 'logistica', 1, 'soat'))).toBe('23514');
      expect(await falla(tx, (sp) => abrir(sp, p, 'soat_con_tramite', 1, 'logistica'))).toBe('23514');
      expect(await falla(tx, (sp) => abrir(sp, p, 'tramite_digital', 1, 'soat'))).toBe('23514');
      for (const c of ['logistica', 'soat_con_tramite', 'soat_sin_tramite']) expect(await falla(tx, (sp) => abrir(sp, p, c, 1))).toBeNull();
    }));

    it('CONCEPTOS_DE_SERVICIO de shared-types coincide con el CHECK', conTabla(async (tx) => {
      const p = await proveedor(tx);
      for (const [servicio, conceptos] of Object.entries(CONCEPTOS_DE_SERVICIO)) {
        for (const c of conceptos) expect(await falla(tx, (sp) => abrir(sp, p, c, 1, servicio)), `${servicio}/${c}`).toBeNull();
      }
    }));
  });

  describe('R3/R4 — valor y forma de la vigencia', () => {
    it('valor negativo → 23514; $0 válido; numeric(14,2) redondea a 2 decimales', conTabla(async (tx) => {
      const p = await proveedor(tx);
      expect(await falla(tx, (sp) => abrir(sp, p, 'logistica', -1))).toBe('23514');
      const [v] = await abrir(tx, p, 'logistica', 0);
      expect((await tx`SELECT valor::text AS v FROM flito_tarifas_proveedor_vigencias WHERE id = ${v!.id}`)[0]!.v).toBe('0.00');
    }));

    it('cerrar exige cerrado_en y quién cerró; cerrar y abrir con el mismo now() no solapa', conTabla(async (tx) => {
      const p = await proveedor(tx);
      const [u] = await tx`INSERT INTO users (username, name, password_hash, role, active) VALUES (${`tp${sello()}`}, 'TP', 'h', 'admin', true) RETURNING id`;
      const [v] = await abrir(tx, p, 'logistica', 100);
      expect(await falla(tx, (sp) => sp`UPDATE flito_tarifas_proveedor_vigencias SET vigente_hasta = now() WHERE id = ${v!.id}`)).toBe('23514');
      expect(await falla(tx, (sp) => sp`UPDATE flito_tarifas_proveedor_vigencias SET vigente_hasta = now(), cerrado_en = now() WHERE id = ${v!.id}`)).toBe('23514');
      await tx`UPDATE flito_tarifas_proveedor_vigencias SET vigente_hasta = now(), cerrado_en = now(), cerrado_por_id = ${u!.id} WHERE id = ${v!.id}`;
      expect(await falla(tx, (sp) => sp`INSERT INTO flito_tarifas_proveedor_vigencias (proveedor_id, servicio, concepto, valor, vigente_desde)
        VALUES (${p}, 'logistica', 'logistica', 120, now())`)).toBeNull();
    }));
  });

  describe('R6 — una sola abierta por concepto y sin solapes', () => {
    it('segunda abierta del mismo concepto → 23505 de uq_flito_tarifas_prov_abierta, que el servicio traduce a 409', conTabla(async (tx) => {
      const p = await proveedor(tx);
      await abrir(tx, p, 'logistica', 100);
      let error: unknown;
      try { await tx.savepoint((sp) => abrir(sp as Tx, p, 'logistica', 200)); } catch (e) { error = e; }
      expect(error).toMatchObject({ code: '23505', constraint_name: 'uq_flito_tarifas_prov_abierta' });
      expect(esChoqueDeLlaveCosto(error)).toBe(true);
    }));

    it('una cerrada que se solapa con otra → 23P01 de flito_tarifas_prov_sin_solape, traducido a 409', conTabla(async (tx) => {
      const p = await proveedor(tx);
      const [u] = await tx`INSERT INTO users (username, name, password_hash, role, active) VALUES (${`tp${sello()}`}, 'TP', 'h', 'admin', true) RETURNING id`;
      await tx`INSERT INTO flito_tarifas_proveedor_vigencias (proveedor_id, servicio, concepto, valor, vigente_desde)
        VALUES (${p}, 'logistica', 'logistica', 1, now() - interval '1 day')`;
      let error: unknown;
      try {
        await tx.savepoint((sp) => sp`INSERT INTO flito_tarifas_proveedor_vigencias
          (proveedor_id, servicio, concepto, valor, vigente_desde, vigente_hasta, cerrado_en, cerrado_por_id)
          VALUES (${p}, 'logistica', 'logistica', 2, now() - interval '2 days', now() - interval '12 hours', now(), ${u!.id})`);
      } catch (e) { error = e; }
      expect(error).toMatchObject({ code: '23P01', constraint_name: 'flito_tarifas_prov_sin_solape' });
      expect(esChoqueDeLlaveCosto(error)).toBe(true);
    }));

    it('R5 — el proveedor con vigencias no se borra (FK RESTRICT)', conTabla(async (tx) => {
      const p = await proveedor(tx);
      await abrir(tx, p, 'logistica', 1);
      expect(await falla(tx, (sp) => sp`DELETE FROM flito_proveedores WHERE id = ${p}`)).toBe('23503');
    }));
  });

  describe('R5 — servicio retirado: la vigencia queda latente y reaparece al reasignarlo', () => {
    it('quitar SOAT no cierra su vigencia; sale de los servicios vigentes; al reasignarlo vuelve con su último valor', conTabla(async (tx) => {
      const p = await proveedor(tx, true);
      const [v] = await abrir(tx, p, 'soat_con_tramite', 45000);
      const servicios = async () => (await tx`SELECT servicio FROM flito_proveedor_servicios_v WHERE proveedor_id = ${p} ORDER BY servicio`)
        .map((f) => f.servicio as string);
      expect(await servicios()).toEqual(['logistica', 'soat']);

      await tx`UPDATE flito_proveedores_soat SET deleted_at = now() WHERE id = ${p}`;
      expect(await servicios()).toEqual(['logistica']);
      const [latente] = await tx`SELECT vigente_hasta, valor::text AS valor FROM flito_tarifas_proveedor_vigencias WHERE id = ${v!.id}`;
      expect(latente).toEqual({ vigente_hasta: null, valor: '45000.00' });

      await tx`UPDATE flito_proveedores_soat SET deleted_at = NULL WHERE id = ${p}`;
      expect(await servicios()).toEqual(['logistica', 'soat']);
      const abiertas = await tx`SELECT id FROM flito_tarifas_proveedor_vigencias
        WHERE proveedor_id = ${p} AND concepto = 'soat_con_tramite' AND vigente_hasta IS NULL`;
      expect(abiertas.map((f) => f.id)).toEqual([v!.id]);
    }));
  });

  describe('R6 — dos primeras fijaciones simultáneas (dos conexiones)', () => {
    it('la segunda espera a la primera y falla con 23505, que el servicio traduce a 409', async () => {
      const limpieza = abrirBase();
      const a = abrirBase();
      const b = abrirBase();
      let p: string | null = null;
      try {
        const [hay] = await limpieza`SELECT to_regclass('public.flito_tarifas_proveedor_vigencias') IS NOT NULL AS ok`;
        if (!hay!.ok) return; // Base sin la 0300: los casos en tx ya la cubren.
        p = await proveedor(limpieza);
        let soltar!: () => void;
        const primeraDentro = new Promise<void>((r) => { soltar = r; });
        let terminar!: () => void;
        const commit = new Promise<void>((r) => { terminar = r; });
        const primera = a.begin(async (tx) => {
          await abrir(tx as Tx, p!, 'logistica', 100);
          soltar();
          await commit;
        });
        await primeraDentro;
        const segunda = b.begin((tx) => abrir(tx as Tx, p!, 'logistica', 200)).then(() => null, (e: unknown) => e);
        await new Promise((r) => setTimeout(r, 200)); // la segunda queda esperando el índice único
        terminar();
        await primera;
        const error = await segunda;
        expect(error).toMatchObject({ code: '23505', constraint_name: 'uq_flito_tarifas_prov_abierta' });
        expect(esChoqueDeLlaveCosto(error)).toBe(true);
        expect((await limpieza`SELECT count(*)::int AS c FROM flito_tarifas_proveedor_vigencias WHERE proveedor_id = ${p}`)[0]!.c).toBe(1);
      } finally {
        if (p) {
          await limpieza`DELETE FROM flito_tarifas_proveedor_vigencias WHERE proveedor_id = ${p}`;
          await limpieza`DELETE FROM flito_proveedores_logistica WHERE id = ${p}`;
          await limpieza`DELETE FROM flito_proveedores WHERE id = ${p}`;
        }
        await Promise.all([a.end(), b.end(), limpieza.end()]);
      }
    });
  });
});
