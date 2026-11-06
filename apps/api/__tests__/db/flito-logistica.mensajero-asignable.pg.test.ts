// HU #14347 (Feature #14326, ADR-0039 §6.2, R14) — quién puede llevar un despacho, contra PostgreSQL de verdad y dentro de
// una transacción con ROLLBACK (se SALTA sin TEST_DATABASE_URL): las funciones efectivas y el enlace salen de la base.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('k'), presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn(),
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

type Tx = postgres.TransactionSql;
const OPERACIONES = { enlace: 'ninguno' } as const;
const CODIGO = 'MENSAJERO_NO_ASIGNABLE';
const FIRMA = 'iVBORw0KGgo=';
let n = 0;
const sello = () => `${String(Date.now()).slice(-6)}${n++}`;

interface Mundo {
  tx: Tx; A: string; B: string; flito: number; deA: number; deB: number; inactivoFlito: number; inactivoA: number; operador: number;
  cia: number; org: string;
}

async function conMundo(fn: (m: Mundo) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      const prov = async (nombre: string) => (await tx`INSERT INTO flito_proveedores_logistica (nombre, activo, nit, contacto, telefono)
        VALUES (${`${nombre} ${sello()}`}, true, ${`9${sello()}`}, 'Ana', '3001112233') RETURNING id`)[0]!.id as string;
      const A = await prov('A'); const B = await prov('B');
      // Rol creado por el administrador en el panel (ADR-0015): enlace proveedor, con las funciones del mensajero.
      const rolProv = `hu14347_${sello()}`;
      await tx`INSERT INTO permisos_roles (codigo, nombre, tipo_enlace, tipo_principal, es_sistema, activo) VALUES (${rolProv}, ${rolProv}, 'proveedor', 'interno', false, true)`;
      await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) SELECT ${rolProv}, funcion_codigo FROM permisos_rol_funcion WHERE rol_codigo = 'mensajero'`;
      const usuario = async (role: string, o: { activo?: boolean; proveedor?: string | null } = {}) => (await tx`INSERT INTO users (username, name, password_hash, role, active, flito_proveedor_id)
        VALUES (${`hu14347-${sello()}`}, 'Usuario', 'x', ${role}, ${o.activo ?? true}, ${o.proveedor ?? null}) RETURNING id`)[0]!.id as number;
      const org = (await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`)[0]?.codigo as string
        ?? (await tx`INSERT INTO organismos_transito_config (codigo, activo) VALUES ('99999', true) RETURNING codigo`)[0]!.codigo as string;
      await fn({
        tx, A, B, org,
        flito: await usuario('mensajero'), deA: await usuario(rolProv, { proveedor: A }), deB: await usuario(rolProv, { proveedor: B }),
        inactivoFlito: await usuario('mensajero', { activo: false }), inactivoA: await usuario(rolProv, { proveedor: A, activo: false }),
        operador: await usuario('admin'),
        cia: (await tx`INSERT INTO clients (name, document, flito_proveedor_logistica_id, logistica_autogestionable) VALUES (${`Cia ${sello()}`}, ${`D${sello()}`}, ${A}, false) RETURNING id`)[0]!.id as number,
      });
    });
  } finally { actual.db = null; await sql.end(); }
}

async function rechazo(p: Promise<unknown>): Promise<Error & { codigo?: string; status?: number }> {
  try { await p; } catch (e) { return e as Error & { codigo?: string; status?: number }; }
  throw new Error('se esperaba un rechazo');
}

const ctxDe = (m: Mundo) => ({ userId: m.operador, username: 'op', role: 'admin', operaAjenas: true, alcance: OPERACIONES });

async function licencia(m: Mundo, estado = 'clasificado', dueno: string | null = m.A): Promise<string> {
  const placa = `Y${sello().slice(-6)}`;
  const [v] = await m.tx`INSERT INTO vehicles (plate) VALUES (${placa}) RETURNING id`;
  const [t] = await m.tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, compania_nit, organismo_codigo, flit_estado) VALUES (${`F${sello()}`}, now(), ${v!.id}, ${m.cia}, '900', ${m.org}, 'Aprobado') RETURNING id`;
  return (await m.tx`INSERT INTO flito_logistica_documentos (tramite_id, tipo, estado, organismo_codigo, compania_id, vehiculo_id, proveedor_logistica_id)
    VALUES (${t!.id}, 'licencia_transito', ${estado}, ${m.org}, ${m.cia}, ${v!.id}, ${dueno}) RETURNING id`)[0]!.id as string;
}

/** Viaje registrado, con su acta de A. */
async function viaje(m: Mundo): Promise<{ trasladoId: string; actaId: string }> {
  const r = await svc.registrarTraslado({ companiaId: m.cia, destino: 'cliente', lts: [{ documentoId: await licencia(m) }] }, ctxDe(m));
  return { trasladoId: r.id, actaId: r.actaId };
}

/** Acta sin viaje, generada y de A: es el camino legado de `despachar`. */
const actaLegada = async (m: Mundo) => (await m.tx`INSERT INTO flito_logistica_actas (compania_id, punto, estado, proveedor_logistica_id) VALUES (${m.cia}, 'cliente', 'generada', ${m.A}) RETURNING id`)[0]!.id as string;
const estadoActa = async (m: Mundo, id: string) => (await m.tx`SELECT estado, mensajero_id FROM flito_logistica_actas WHERE id = ${id}`)[0]!;

describe.skipIf(!URL_BASE)('mensajero asignable (PostgreSQL, tx con ROLLBACK)', () => {
  it('AC1 y AC2: Operaciones despacha con uno de FLITO y con uno del dueño del acta', async () => {
    await conMundo(async (m) => {
      const a = await viaje(m);
      await expect(svc.despacharTraslado(a.trasladoId, { mensajeroId: m.flito }, ctxDe(m))).resolves.toMatchObject({ estado: 'en_ruta' });
      const b = await viaje(m);
      await expect(svc.despachar(b.actaId, { mensajeroId: m.deA }, ctxDe(m))).resolves.toMatchObject({ estado: 'en_ruta' });
    });
  });

  it('AC3: Operaciones con un mensajero de otro proveedor: la API lo rechaza y el acta no cambia', async () => {
    await conMundo(async (m) => {
      const v = await viaje(m);
      const antes = await estadoActa(m, v.actaId);
      const e = await rechazo(svc.despacharTraslado(v.trasladoId, { mensajeroId: m.deB }, ctxDe(m)));
      expect([e.status, e.codigo]).toEqual([422, CODIGO]);
      expect(await estadoActa(m, v.actaId)).toEqual(antes);
    });
  });

  it('AC4: con alcance de proveedor A solo se acepta el de A; ni el de B ni el de FLITO', async () => {
    await conMundo(async (m) => {
      const alcance = { enlace: 'proveedor', proveedorId: m.A } as const;
      await expect(svc.exigirMensajeroAsignable(actual.db as never, m.deA, alcance, m.A)).resolves.toBeUndefined();
      expect((await rechazo(svc.exigirMensajeroAsignable(actual.db as never, m.deB, alcance, m.A))).codigo).toBe(CODIGO);
      expect((await rechazo(svc.exigirMensajeroAsignable(actual.db as never, m.flito, alcance, m.A))).codigo).toBe(CODIGO);
      const ids = (await svc.mensajerosAsignables(alcance)).map((x: { id: number }) => x.id);
      expect(ids).toContain(m.deA);
      expect(ids).not.toContain(m.deB);
      expect(ids).not.toContain(m.flito);
    });
  });

  it('un alcance de proveedor sin id, o un enlace sin resolver, no alcanza a nadie', async () => {
    await conMundo(async (m) => {
      for (const alcance of [{ enlace: 'proveedor', proveedorId: null }, { enlace: null }, { enlace: 'organismos_transito', organismos: ['1'] }] as const) {
        expect((await rechazo(svc.exigirMensajeroAsignable(actual.db as never, m.deA, alcance, m.A))).codigo).toBe(CODIGO);
        expect(await svc.mensajerosAsignables(alcance)).toEqual([]);
      }
    });
  });

  it('un acta sin dueño solo admite mensajeros de FLITO', async () => {
    await conMundo(async (m) => {
      await expect(svc.exigirMensajeroAsignable(actual.db as never, m.flito, OPERACIONES, null)).resolves.toBeUndefined();
      expect((await rechazo(svc.exigirMensajeroAsignable(actual.db as never, m.deA, OPERACIONES, null))).codigo).toBe(CODIGO);
    });
  });

  it('un administrador (entrega y opera ajenas) o un usuario eliminado no son asignables', async () => {
    await conMundo(async (m) => {
      expect((await rechazo(svc.exigirMensajeroAsignable(actual.db as never, m.operador, OPERACIONES, m.A))).codigo).toBe(CODIGO);
      await m.tx`UPDATE users SET deleted_at = now() WHERE id = ${m.flito}`;
      expect((await rechazo(svc.exigirMensajeroAsignable(actual.db as never, m.flito, OPERACIONES, m.A))).codigo).toBe(CODIGO);
    });
  });

  it('AC5: el inactivo, de FLITO o del proveedor, no se lista y la API lo rechaza', async () => {
    await conMundo(async (m) => {
      const ids = (await svc.mensajerosAsignables(OPERACIONES, m.A)).map((x: { id: number }) => x.id);
      expect(ids).toEqual(expect.arrayContaining([m.flito, m.deA]));
      expect(ids).not.toContain(m.inactivoFlito);
      expect(ids).not.toContain(m.inactivoA);
      for (const id of [m.inactivoFlito, m.inactivoA]) {
        expect((await rechazo(svc.exigirMensajeroAsignable(actual.db as never, id, OPERACIONES, m.A))).codigo).toBe(CODIGO);
      }
    });
  });

  it('mensajerosAsignables para un acta: los de FLITO y los de su dueño; sin acta, con su proveedor para que la pantalla filtre', async () => {
    await conMundo(async (m) => {
      const delActa = (await svc.mensajerosAsignables(OPERACIONES, m.A)).map((x: { id: number }) => x.id);
      expect(delActa).toEqual(expect.arrayContaining([m.flito, m.deA]));
      expect(delActa).not.toContain(m.deB);
      const todos = await svc.mensajerosAsignables(OPERACIONES);
      expect(todos.find((x: { id: number }) => x.id === m.deB)).toMatchObject({ proveedorId: m.B });
      expect(todos.find((x: { id: number }) => x.id === m.flito)).toMatchObject({ proveedorId: null });
      expect((await svc.facetas(OPERACIONES)).mensajeros.map((x: { id: number }) => x.id)).not.toContain(m.inactivoFlito);
    });
  });

  describe('AC6 — los cuatro caminos', () => {
    for (const [nombre, mensajero] of [['de otro proveedor', 'deB'], ['inactivo', 'inactivoFlito']] as const) {
      it(`POST /traslados rechaza a un mensajero ${nombre}, sin crear el viaje`, async () => {
        await conMundo(async (m) => {
          const d = await licencia(m);
          const e = await rechazo(svc.registrarTraslado({ companiaId: m.cia, destino: 'cliente', lts: [{ documentoId: d }], mensajeroId: m[mensajero] }, ctxDe(m)));
          expect([e.status, e.codigo]).toEqual([422, CODIGO]);
          expect((await m.tx`SELECT count(*)::int c FROM flito_logistica_traslados WHERE compania_id = ${m.cia}`)[0]!.c).toBe(0);
        });
      });

      it(`/traslados/:id/despachar rechaza a un mensajero ${nombre}`, async () => {
        await conMundo(async (m) => {
          const v = await viaje(m);
          expect((await rechazo(svc.despacharTraslado(v.trasladoId, { mensajeroId: m[mensajero] }, ctxDe(m)))).codigo).toBe(CODIGO);
        });
      });

      it(`/actas/:id/despachar rechaza a un mensajero ${nombre}, con viaje y sin viaje`, async () => {
        await conMundo(async (m) => {
          const v = await viaje(m);
          expect((await rechazo(svc.despachar(v.actaId, { mensajeroId: m[mensajero], firmaEntrega: FIRMA }, ctxDe(m)))).codigo).toBe(CODIGO);
          const legada = await actaLegada(m);
          const antes = await estadoActa(m, legada);
          expect((await rechazo(svc.despachar(legada, { mensajeroId: m[mensajero], firmaEntrega: FIRMA }, ctxDe(m)))).codigo).toBe(CODIGO);
          expect(await estadoActa(m, legada)).toEqual(antes);
        });
      });

      it(`mensajerosAsignables no devuelve a un mensajero ${nombre}`, async () => {
        await conMundo(async (m) => {
          const ids = (await svc.mensajerosAsignables(OPERACIONES, m.A)).map((x: { id: number }) => x.id);
          expect(ids).not.toContain(m[mensajero]);
        });
      });
    }

    it('POST /traslados con un mensajero del dueño: se acepta; sin elegir, queda a nombre de quien registra', async () => {
      await conMundo(async (m) => {
        const r = await svc.registrarTraslado({ companiaId: m.cia, destino: 'cliente', lts: [{ documentoId: await licencia(m) }], mensajeroId: m.deA }, ctxDe(m));
        expect(r.mensajeroId).toBe(m.deA);
        const s = await svc.registrarTraslado({ companiaId: m.cia, destino: 'cliente', lts: [{ documentoId: await licencia(m) }] }, ctxDe(m));
        expect(s.mensajeroId).toBe(m.operador);
      });
    });
  });
});
