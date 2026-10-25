// HU #13947 (Feature #13939) — `exigirClienteOperable` y la elegibilidad de facturas contra PostgreSQL de verdad.
//
// Mismo andamiaje que `clients-estado.test.ts`: todo en una transacción con ROLLBACK, se activa con TEST_DATABASE_URL
// y sin ella se SALTA. Mide lo que los dobles de prueba no pueden: que el `FOR SHARE` es SQL válido sobre `clients`,
// y la secuencia del AC8 (desactivar → el alta ve el cliente inactivo; reactivar → vuelve a admitir).
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
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

const { exigirClienteOperable, motivoClienteNoOperable, ClienteNoOperableError } =
  await import('../../src/modules/clients/cliente-operable.js');
const { cambiarEstadoCliente } = await import('../../src/modules/clients/clients.service.js');
const { evaluarElegibilidad } = await import('../../src/modules/siigo/facturacion.elegibilidad.service.js');

async function conBase(fn: (tx: postgres.TransactionSql, id: number) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      const [c] = await tx`INSERT INTO clients (name) VALUES ('Transportes HU13947') RETURNING id`;
      await fn(tx, c!.id as number);
    });
  } finally {
    actual.db = null;
    await sql.end();
  }
}

describe.skipIf(!URL_BASE)('cliente-operable — contra PostgreSQL (tx con ROLLBACK)', () => {
  it('activo → admite (el FOR SHARE corre sin error); sin compañía o inexistente → no decide', async () => {
    await conBase(async (_tx, id) => {
      await expect(exigirClienteOperable(actual.db!, id, 'SOAT')).resolves.toBeUndefined();
      await expect(exigirClienteOperable(actual.db!, null, 'SOAT')).resolves.toBeUndefined();
      await expect(exigirClienteOperable(actual.db!, 2_000_000_000, 'SOAT')).resolves.toBeUndefined();
    });
  });

  it('inactivo → ClienteNoOperableError (409) con el mensaje del AC para cada proceso', async () => {
    await conBase(async (tx, id) => {
      await tx`UPDATE clients SET active = false WHERE id = ${id}`;
      const e = await exigirClienteOperable(actual.db!, id, 'liquidaciones').catch((x) => x);
      expect(e).toBeInstanceOf(ClienteNoOperableError);
      expect(e.status).toBe(409);
      expect(e.message).toBe('El cliente Transportes HU13947 está inactivo: no se pueden crear liquidaciones para él.');
      expect(await motivoClienteNoOperable(actual.db!, id, 'impuestos', false))
        .toBe('El cliente Transportes HU13947 está inactivo: no se pueden crear impuestos para él.');
    });
  });

  it('AC8 (secuencial): tras `cambiarEstadoCliente` a inactivo el alta lo ve; al reactivar vuelve a admitir', async () => {
    await conBase(async (_tx, id) => {
      await cambiarEstadoCliente(id, { activo: false, activoEsperado: true });
      await expect(exigirClienteOperable(actual.db!, id, 'facturas')).rejects.toBeInstanceOf(ClienteNoOperableError);
      await cambiarEstadoCliente(id, { activo: true, activoEsperado: false });
      await expect(exigirClienteOperable(actual.db!, id, 'facturas')).resolves.toBeUndefined();
    });
  });

  it('elegibilidad: el trámite de un cliente inactivo sale con `cliente_no_facturable` y el mensaje del AC', async () => {
    await conBase(async (tx, id) => {
      const [v] = await tx`INSERT INTO vehicles DEFAULT VALUES RETURNING id`;
      const [t] = await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id)
        VALUES ('HU13947-1', now(), ${v!.id}, ${id}) RETURNING id`;
      const tramiteId = t!.id as string;
      const activo = await evaluarElegibilidad([tramiteId], 'pruebas');
      expect(activo[0]!.motivos.map((m) => m.motivo)).not.toContain('cliente_no_facturable');

      await tx`UPDATE clients SET active = false WHERE id = ${id}`;
      const [inactivo] = await evaluarElegibilidad([tramiteId], 'pruebas');
      expect(inactivo!.elegible).toBe(false);
      expect(inactivo!.motivos).toContainEqual({
        motivo: 'cliente_no_facturable',
        detalle: 'El cliente Transportes HU13947 está inactivo: no se pueden crear facturas para él.',
      });
    });
  });
});
