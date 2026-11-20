// HU #13959 (Feature #13940) — RN-PROV-5 contra PostgreSQL de verdad: un proveedor SOAT inactivo o eliminado no se
// puede elegir como destino, y la comprobación serializa con la desactivación (AC6).
//
// Sin `TEST_DATABASE_URL` se SALTA (el CI no levanta Postgres; el contrato de las rutas lo mide
// `services/proveedores-soat-inactivo.routes.test.ts`). Hay que LEER que no dice `skipped`.
//
// Dos bloques:
//   · Lecturas en una transacción con ROLLBACK (`base-en-tx.ts`): los textos de `exigirProveedorSoatUsable` y el
//     canal «SOAT sin trámite» con gestor inactivo (AC5, regresión: `resolverDestinoCanalCliente` ya lo hacía).
//   · AC6, la carrera, con DOS sesiones: tienen que verse, así que el proveedor y la compañía se CONFIRMAN con el
//     prefijo `zz_prueba13959` y se borran en `afterAll` (y al arrancar, por si una corrida anterior murió).
//     Limpieza manual: DELETE FROM clients WHERE name LIKE 'zz_prueba13959%';
//                      DELETE FROM flito_proveedores_soat WHERE nombre LIKE 'zz_prueba13959%';
//
// ── La carrera ─────────────────────────────────────────────────────────────────────────────────────
// A (la desactivación de la HU #13958, RN-PROV-2): `FOR UPDATE` sobre P → `activo = false` → espera a B (tope 400 ms)
// → confirma. B (fijar P como gestor por defecto): en su tx, `exigirProveedorSoatUsable` (`FOR SHARE`) → UPDATE clients.
//   · CON `FOR SHARE`: B espera el lock de A; A agota el tope y confirma; B relee P ya inactivo y lanza → el gestor NO
//     se escribe. Queda aplicada solo la desactivación.
//   · SIN `FOR SHARE` (READ COMMITTED): B lee la versión confirmada (`activo = true`) sin esperar, escribe y confirma
//     ANTES que A (la señal lo garantiza) → los dos cambios aplicados → rojo.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

// `flito-soat-cliente.service` arrastra Redis por sus imports; aquí no hace falta.
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { exigirProveedorSoatUsable, ProveedorSoatNoUsableError } =
  await import('../../src/modules/flito-parametrizacion/flito-proveedores-estado.service.js');
const { resolverDestinoCanalCliente } = await import('../../src/modules/flito-soat/flito-soat-cliente.service.js');

type TxArg = Parameters<typeof exigirProveedorSoatUsable>[0];
const INEXISTENTE = 'f0000000-0000-4000-8000-0000000fffff';

/** Corre `fn` con un Drizzle sobre una transacción que siempre se deshace. */
async function conBase(fn: (tx: postgres.TransactionSql, d: ReturnType<typeof drizzle<typeof schema>>) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => fn(tx, drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema })));
  } finally { await sql.end(); }
}

const proveedor = async (tx: postgres.TransactionSql, nombre: string, extra: { activo?: boolean; eliminado?: boolean } = {}) =>
  (await tx`INSERT INTO flito_proveedores_soat (nombre, activo, deleted_at)
    VALUES (${nombre}, ${extra.activo ?? true}, CASE WHEN ${extra.eliminado === true} THEN now() END) RETURNING id`)[0]!.id as string;

describe.skipIf(!URL_BASE)('RN-PROV-5 — exigirProveedorSoatUsable y canal sin trámite (tx con ROLLBACK)', () => {
  it('AC1/AC2: inactivo → texto con el nombre; eliminado (aunque activo) o inexistente → «no existe o fue eliminado»', async () => {
    await conBase(async (tx, d) => {
      const inactivo = await proveedor(tx, 'Gestora HU13959', { activo: false });
      const eliminado = await proveedor(tx, 'Eliminada HU13959', { eliminado: true });
      const vigente = await proveedor(tx, 'Vigente HU13959');
      const ex = d as unknown as TxArg;
      await expect(exigirProveedorSoatUsable(ex, inactivo))
        .rejects.toThrow(new ProveedorSoatNoUsableError('El gestor Gestora HU13959 está inactivo: elige otro gestor.', 'inactivo'));
      await expect(exigirProveedorSoatUsable(ex, eliminado))
        .rejects.toThrow('El gestor seleccionado no existe o fue eliminado.');
      await expect(exigirProveedorSoatUsable(ex, INEXISTENTE))
        .rejects.toThrow('El gestor seleccionado no existe o fue eliminado.');
      await expect(exigirProveedorSoatUsable(ex, vigente)).resolves.toBeUndefined();
    });
  });

  it('AC5: canal «SOAT sin trámite» con el gestor por defecto inactivo → la solicitud nace sin destino (contingencia)', async () => {
    await conBase(async (tx, d) => {
      const p = await proveedor(tx, 'Gestora HU13959');
      const [c] = await tx`INSERT INTO clients (name, soat_sin_tramite, flito_proveedor_soat_sin_tramite_id)
        VALUES ('Compania HU13959', true, ${p}) RETURNING id`;
      const ex = d as unknown as Parameters<typeof resolverDestinoCanalCliente>[0];
      expect(await resolverDestinoCanalCliente(ex, c!.id as number)).toMatchObject({ proveedorSoatId: p, gestionOperaciones: false });
      await tx`UPDATE flito_proveedores_soat SET activo = false WHERE id = ${p}`;
      expect(await resolverDestinoCanalCliente(ex, c!.id as number)).toMatchObject({ proveedorSoatId: null, gestionOperaciones: true });
    });
  });

  it('AC5: gestor por defecto ELIMINADO aunque siga `activo = true` → la solicitud nace sin destino (contingencia)', async () => {
    await conBase(async (tx, d) => {
      const p = await proveedor(tx, 'Eliminada HU13959', { activo: true, eliminado: true });
      const [c] = await tx`INSERT INTO clients (name, soat_sin_tramite, flito_proveedor_soat_sin_tramite_id)
        VALUES ('Compania eliminada HU13959', true, ${p}) RETURNING id`;
      const ex = d as unknown as Parameters<typeof resolverDestinoCanalCliente>[0];
      expect(await resolverDestinoCanalCliente(ex, c!.id as number)).toMatchObject({ proveedorSoatId: null, gestionOperaciones: true });
    });
  });
});

function senal() {
  let disparar!: () => void;
  const p = new Promise<void>((r) => { disparar = r; });
  return { disparar, esperar: (ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]) };
}

describe.skipIf(!URL_BASE)('AC6 — desactivar P y fijarlo como gestor por defecto a la vez: nunca quedan los dos', () => {
  const sql = postgres(URL_BASE ?? '', { max: 3, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  let p = '';
  let compania = 0;

  async function limpiar(): Promise<void> {
    await sql`DELETE FROM clients WHERE name LIKE 'zz_prueba13959%'`;
    await sql`DELETE FROM flito_proveedores_soat WHERE nombre LIKE 'zz_prueba13959%'`;
  }

  beforeAll(async () => {
    await limpiar();
    p = (await sql`INSERT INTO flito_proveedores_soat (nombre) VALUES ('zz_prueba13959 P') RETURNING id`)[0]!.id as string;
    compania = (await sql`INSERT INTO clients (name) VALUES ('zz_prueba13959 Compania') RETURNING id`)[0]!.id as number;
  });
  afterAll(async () => { await limpiar(); await sql.end(); });

  it('la desactivación toma P primero → la asignación espera, relee P inactivo y se rechaza', async () => {
    const aBloqueo = senal();
    const bTermino = senal();

    const a = sql.begin(async (tx) => {
      await tx`SELECT activo FROM flito_proveedores_soat WHERE id = ${p} AND deleted_at IS NULL FOR UPDATE`;
      await tx`UPDATE flito_proveedores_soat SET activo = false WHERE id = ${p}`;
      aBloqueo.disparar();
      await bTermino.esperar(400); // con FOR SHARE, B está esperando el lock: se agota el tope y A confirma
    });

    await aBloqueo.esperar(5_000);
    const b = db.transaction(async (tx) => {
      await exigirProveedorSoatUsable(tx as unknown as TxArg, p);
      await tx.update(schema.clients).set({ flitoProveedorSoatSinTramiteId: p }).where(eq(schema.clients.id, compania));
    }).finally(() => bTermino.disparar());

    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(ProveedorSoatNoUsableError);
    expect((rb as PromiseRejectedResult).reason.message).toBe('El gestor zz_prueba13959 P está inactivo: elige otro gestor.');

    const [prov] = await sql`SELECT activo FROM flito_proveedores_soat WHERE id = ${p}`;
    const [cli] = await sql`SELECT flito_proveedor_soat_sin_tramite_id AS gestor FROM clients WHERE id = ${compania}`;
    expect(prov!.activo).toBe(false);
    expect(cli!.gestor).toBeNull();
  });
});
