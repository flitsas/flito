// HU #14348 (Feature #14326, ADR-0039 §8) — el flujo único del escaneo, contra PostgreSQL de verdad: «gestionable» y el alcance
// viven en el WHERE y el duplicado en carrera en `pg_advisory_xact_lock`. Dentro de una tx con ROLLBACK, salvo la prueba
// de concurrencia, que necesita transacciones reales y borra lo suyo. Se SALTA sin TEST_DATABASE_URL.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { MENSAJE_LT_NO_ENCONTRADA } from '@operaciones/shared-types';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null; real: boolean } = { db: null, real: false };
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('k'), presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn(),
}));
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      if (prop === 'transaction' && !actual.real) return (fn: (tx: unknown) => unknown) => fn(actual.db);
      const d = actual.db as unknown as Record<string | symbol, unknown>;
      const v = d[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');

type Sql = postgres.Sql | postgres.TransactionSql;
const OPS = { enlace: 'ninguno' } as const;
let n = 0;
const sello = () => `${String(Date.now()).slice(-6)}${n++}`;

interface Mundo {
  tx: Sql; A: string; B: string; org: string; ctx: { userId: number; username: string; role: string; operaAjenas: boolean; alcance: typeof OPS };
  cia: (p: string | null, autogestionada?: boolean) => Promise<number>;
  vehiculo: () => Promise<{ id: number; placa: string; vin: string }>;
  tramite: (cia: number | null, vehiculoId: number, o?: { estado?: string; organismo?: string | null }) => Promise<string>;
  doc: (o: { cia: number; vehiculoId: number; tramiteId: string; numero: string; dueno?: string | null }) => Promise<string>;
  documentos: () => Promise<number>;
}

const montar = async (tx: Sql): Promise<Mundo> => {
  const prov = async (nombre: string) => (await tx`INSERT INTO flito_proveedores_logistica (nombre, activo, nit, contacto, telefono)
    VALUES (${`${nombre} ${sello()}`}, true, ${`9${sello()}`}, 'Ana', '3001112233') RETURNING id`)[0]!.id as string;
  const [u] = await tx`INSERT INTO users (username, name, password_hash, role) VALUES (${`hu14348-${sello()}`}, 'Op', 'x', 'admin') RETURNING id`;
  const org = (await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`)[0]?.codigo as string
    ?? (await tx`INSERT INTO organismos_transito_config (codigo, activo) VALUES ('99999', true) RETURNING codigo`)[0]!.codigo as string;
  return {
    tx, A: await prov('A'), B: await prov('B'), org,
    ctx: { userId: u!.id as number, username: 'op', role: 'admin', operaAjenas: true, alcance: OPS },
    cia: async (p, autogestionada = false) => (await tx`INSERT INTO clients (name, document, flito_proveedor_logistica_id, logistica_autogestionable)
      VALUES (${`Cia ${sello()}`}, ${`D${sello()}`}, ${p}, ${autogestionada}) RETURNING id`)[0]!.id as number,
    vehiculo: async () => {
      const placa = `X${sello().slice(-6)}`; const vin = `VIN${placa}`;
      return { id: (await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${vin}) RETURNING id`)[0]!.id as number, placa, vin };
    },
    tramite: async (cia, vehiculoId, o = {}) => (await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, compania_nit, organismo_codigo, flit_estado)
      VALUES (${`F${sello()}`}, now(), ${vehiculoId}, ${cia}, '900', ${o.organismo === undefined ? org : o.organismo}, ${o.estado ?? 'Aprobado'}) RETURNING id`)[0]!.id as string,
    doc: async (o) => (await tx`INSERT INTO flito_logistica_documentos (tramite_id, tipo, estado, organismo_codigo, compania_id, vehiculo_id, numero_licencia, numero_lt, proveedor_logistica_id)
      VALUES (${o.tramiteId}, 'licencia_transito', 'clasificado', ${org}, ${o.cia}, ${o.vehiculoId}, ${o.numero}, 'LT-ORIGINAL', ${o.dueno ?? null}) RETURNING id`)[0]!.id as string,
    documentos: async () => (await tx`SELECT count(*)::int c FROM flito_logistica_documentos`)[0]!.c as number,
  };
};

async function conMundo(fn: (m: Mundo) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(await montar(tx));
    });
  } finally { actual.db = null; await sql.end(); }
}

const manual = (placa: string, numero = `L${sello()}`) => ({ placa, numeroLicencia: numero, numeroLt: 'LT-NUEVO' });
const NO_ENCONTRADO = (e: { placa: string; numeroLicencia: string }) => ({
  resultado: 'sin_match', motivo: MENSAJE_LT_NO_ENCONTRADA, placa: e.placa, vin: '', numeroLicencia: e.numeroLicencia,
});

describe.skipIf(!URL_BASE)('flujo único del escaneo (PostgreSQL)', () => {
  describe('AC1 — sin trámite aprobado o con logística autogestionada', () => {
    it('sin trámite aprobado y autogestionada: mismo cuerpo exacto, sin escribir, y el motivo real solo en el aviso', async () => {
      await conMundo(async (m) => {
        const antes = await m.documentos();
        const sinNada = await m.vehiculo();
        const noAprobado = await m.vehiculo(); await m.tramite(await m.cia(m.A), noAprobado.id, { estado: 'En proceso' });
        const auto = await m.vehiculo(); await m.tramite(await m.cia(m.A, true), auto.id);
        const motivos: string[] = [];
        const opc = { alNoEncontrar: (x: string) => { motivos.push(x); } };
        for (const v of [sinNada, noAprobado, auto]) {
          const e = manual(v.placa);
          const r = await svc.escanearLt(e, null, {}, m.ctx, opc);
          expect(r).toStrictEqual(NO_ENCONTRADO(e));
        }
        expect(motivos).toEqual(['inexistente', 'inexistente', 'no_gestionada']);
        expect(await m.documentos()).toBe(antes);
      });
    });

    it('un `tramiteId` autogestionado o inventado también es no encontrado', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo();
        const auto = await m.tramite(await m.cia(m.A, true), v.id);
        await m.tramite(await m.cia(m.A), v.id);
        const e = manual(v.placa);
        expect(await svc.escanearLt(e, null, {}, m.ctx, { tramiteId: auto })).toStrictEqual(NO_ENCONTRADO(e));
        expect(await svc.escanearLt(e, null, {}, m.ctx, { tramiteId: '00000000-0000-4000-8000-000000000000' })).toStrictEqual(NO_ENCONTRADO(e));
      });
    });
  });

  describe('AC2 — cualquier trámite con logística activa', () => {
    it('Operaciones gestiona el de cualquier proveedor, y la LT queda con el dueño de esa compañía', async () => {
      await conMundo(async (m) => {
        for (const p of [m.A, m.B]) {
          const v = await m.vehiculo(); await m.tramite(await m.cia(p), v.id);
          const r = await svc.escanearLt(manual(v.placa), null, {}, m.ctx);
          expect(r.resultado).toBe('recogido');
          const [d] = await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_documentos WHERE id = ${r.documentoId!}`;
          expect(d!.p).toBe(p);
        }
      });
    });

    it('compañía con logística activa y sin proveedor: se gestiona y la LT queda sin dueño', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo(); await m.tramite(await m.cia(null), v.id);
        const r = await svc.escanearLt(manual(v.placa), null, {}, m.ctx);
        expect(r.resultado).toBe('recogido');
        const [d] = await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_documentos WHERE id = ${r.documentoId!}`;
        expect(d!.p).toBeNull();
      });
    });
  });

  describe('AC3 — varios trámites de una placa', () => {
    it('elige solo entre los gestionables; los candidatos no traen `gestionable`', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo();
        const t1 = await m.tramite(await m.cia(m.A), v.id); const t2 = await m.tramite(await m.cia(m.B), v.id);
        const auto = await m.tramite(await m.cia(m.A, true), v.id);
        const r = await svc.escanearLt(manual(v.placa), null, {}, m.ctx);
        expect(r.resultado).toBe('elegir_tramite');
        const ids = r.candidatos!.map((c: { tramiteId: string }) => c.tramiteId);
        expect(ids.sort()).toEqual([t1, t2].sort());
        expect(ids).not.toContain(auto);
        for (const c of r.candidatos!) expect(c).not.toHaveProperty('gestionable');
      });
    });

    it('uno gestionable y uno autogestionado: se usa el gestionable sin preguntar', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo(); const t = await m.tramite(await m.cia(m.A), v.id); await m.tramite(await m.cia(m.B, true), v.id);
        const r = await svc.escanearLt(manual(v.placa), null, {}, m.ctx);
        expect(r.resultado).toBe('recogido');
        const [d] = await m.tx`SELECT tramite_id t FROM flito_logistica_documentos WHERE id = ${r.documentoId!}`;
        expect(d!.t).toBe(t);
      });
    });

    it('consultar-vehiculo tampoco ofrece el autogestionado', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo(); const t = await m.tramite(await m.cia(m.A), v.id); await m.tramite(await m.cia(m.B, true), v.id);
        const r = await svc.consultarVehiculo(v.placa, OPS);
        expect(r.encontrado && r.candidatos.map((c: { tramiteId: string }) => c.tramiteId)).toEqual([t]);
      });
    });
  });

  it('AC5: dejar pendiente con varios gestionables: queda pendiente y sin dueño', async () => {
    await conMundo(async (m) => {
      const v = await m.vehiculo(); await m.tramite(await m.cia(m.A), v.id); await m.tramite(await m.cia(m.B), v.id);
      const r = await svc.escanearLt(manual(v.placa), null, {}, m.ctx, { dejarPendiente: true });
      expect(r.pendienteTramite).toBe(true);
      const [d] = await m.tx`SELECT tramite_id t, compania_id c, proveedor_logistica_id p FROM flito_logistica_documentos WHERE id = ${r.documentoId!}`;
      expect(d).toMatchObject({ t: null, c: null, p: null });
    });
  });

  it('AC5: la función está sembrada solo a admin', async () => {
    await conMundo(async (m) => {
      const filas = await m.tx`SELECT rol_codigo r FROM permisos_rol_funcion WHERE funcion_codigo = 'logistica.documento.dejar_pendiente'`;
      expect(filas.map((f) => f.r)).toEqual(['admin']);
      const [f] = await m.tx`SELECT padre_codigo p FROM permisos_funciones WHERE codigo = 'logistica.documento.dejar_pendiente'`;
      expect(f!.p).toBe('accion.mi_ruta.escanear');
    });
  });

  describe('AC6 — licencia ya registrada', () => {
    it('Operaciones recibe duplicado con la compañía, y el número se completa ya decidido', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo(); const cia = await m.cia(m.A); const t = await m.tramite(cia, v.id);
        const numero = `L${sello()}`;
        const d = await m.doc({ cia, vehiculoId: v.id, tramiteId: t, numero, dueno: m.A });
        const r = await svc.escanearLt(manual(v.placa, numero), null, {}, m.ctx);
        expect(r).toMatchObject({ resultado: 'duplicado', documentoId: d });
        expect(r.companiaNombre).toMatch(/^Cia /);
        expect((await m.tx`SELECT numero_lt n FROM flito_logistica_documentos WHERE id = ${d}`)[0]!.n).toBe('LT-NUEVO');
      });
    });

    it('fuera del alcance: no encontrado, sin completar el número (la rama que abrirá F4.2)', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo(); const cia = await m.cia(m.A); const t = await m.tramite(cia, v.id);
        const numero = `L${sello()}`;
        const d = await m.doc({ cia, vehiculoId: v.id, tramiteId: t, numero, dueno: m.A });
        const e = manual(v.placa, numero);
        const motivos: string[] = [];
        const r = await svc.escanearLt(e, null, {}, { ...m.ctx, alcance: { enlace: 'proveedor', proveedorId: m.B } } as never, { alNoEncontrar: (x: string) => { motivos.push(x); } });
        expect(r).toStrictEqual(NO_ENCONTRADO(e));
        expect(motivos).toEqual(['lt_ajena']);
        expect((await m.tx`SELECT numero_lt n FROM flito_logistica_documentos WHERE id = ${d}`)[0]!.n).toBe('LT-ORIGINAL');
      });
    });

    it('validar-lt: ya_registrada para Operaciones', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo(); const cia = await m.cia(m.A); const t = await m.tramite(cia, v.id);
        const numero = `L${sello()}`;
        await m.doc({ cia, vehiculoId: v.id, tramiteId: t, numero });
        expect((await svc.validarLt(manual(v.placa, numero), OPS)).resultado).toBe('ya_registrada');
      });
    });
  });

  describe('AC9 — misma decisión en validar-lt y consultar-vehiculo', () => {
    it('validar-lt responde el mismo cuerpo que el escaneo en los casos sin resultado, y consultar-vehiculo `{encontrado:false}`', async () => {
      await conMundo(async (m) => {
        const sinNada = await m.vehiculo();
        const auto = await m.vehiculo(); await m.tramite(await m.cia(m.A, true), auto.id);
        const conLt = await m.vehiculo(); const cia = await m.cia(m.A); const t = await m.tramite(cia, conLt.id);
        await m.doc({ cia, vehiculoId: conLt.id, tramiteId: t, numero: `L${sello()}` });
        for (const v of [sinNada, auto]) {
          const e = manual(v.placa);
          expect(await svc.validarLt(e, OPS)).toStrictEqual(await svc.escanearLt(e, null, {}, m.ctx));
          expect(await svc.consultarVehiculo(v.placa, OPS)).toStrictEqual({ encontrado: false });
        }
        expect(await svc.consultarVehiculo(conLt.placa, OPS)).toStrictEqual({ encontrado: false });
      });
    });

    it('un alcance sin acceso (rama de proveedor con NINGUNA_FILA) no encuentra nada, ni en las tres rutas', async () => {
      await conMundo(async (m) => {
        const v = await m.vehiculo(); await m.tramite(await m.cia(m.A), v.id);
        const a = { enlace: 'proveedor', proveedorId: m.A } as const;
        const e = manual(v.placa);
        expect(await svc.escanearLt(e, null, {}, { ...m.ctx, alcance: a } as never)).toStrictEqual(NO_ENCONTRADO(e));
        expect(await svc.validarLt(e, a)).toStrictEqual(NO_ENCONTRADO(e));
        expect(await svc.consultarVehiculo(v.placa, a)).toStrictEqual({ encontrado: false });
      });
    });
  });

  it('AC7: dos escaneos simultáneos del mismo número dejan una sola licencia (transacciones reales)', async () => {
    const sql = postgres(URL_BASE!, { max: 6, onnotice: () => {} });
    actual.db = drizzle(sql, { schema });
    actual.real = true;
    const creados: { proveedores: string[]; cias: number[]; vehiculos: number[]; usuarios: number[] } = { proveedores: [], cias: [], vehiculos: [], usuarios: [] };
    try {
      const m = await montar(sql);
      creados.proveedores.push(m.A, m.B); creados.usuarios.push(m.ctx.userId);
      for (let vuelta = 0; vuelta < 5; vuelta++) {
        const v = await m.vehiculo(); creados.vehiculos.push(v.id);
        const cia = await m.cia(m.A); creados.cias.push(cia);
        const t1 = await m.tramite(cia, v.id); const t2 = await m.tramite(cia, v.id);
        const numero = `L${sello()}`;
        const r = await Promise.all([
          svc.escanearLt(manual(v.placa, numero), null, {}, m.ctx, { tramiteId: t1 }),
          svc.escanearLt(manual(v.placa, numero), null, {}, m.ctx, { tramiteId: t2 }),
        ]);
        const [{ c }] = await sql`SELECT count(*)::int c FROM flito_logistica_documentos WHERE numero_licencia = ${numero}`;
        expect(c).toBe(1);
        expect(r.map((x: { resultado: string }) => x.resultado).sort()).toEqual(['duplicado', 'recogido']);
      }
    } finally {
      await sql`DELETE FROM flito_logistica_documento_eventos WHERE documento_id IN (SELECT id FROM flito_logistica_documentos WHERE vehiculo_id = ANY(${creados.vehiculos}))`;
      await sql`DELETE FROM flito_logistica_documentos WHERE vehiculo_id = ANY(${creados.vehiculos})`;
      await sql`DELETE FROM flito_tramites WHERE vehiculo_id = ANY(${creados.vehiculos})`;
      await sql`DELETE FROM vehicles WHERE id = ANY(${creados.vehiculos})`;
      await sql`DELETE FROM clients WHERE id = ANY(${creados.cias})`;
      await sql`DELETE FROM users WHERE id = ANY(${creados.usuarios})`;
      await sql`DELETE FROM flito_proveedores_logistica WHERE id = ANY(${creados.proveedores})`;
      await sql`DELETE FROM flito_proveedores WHERE id = ANY(${creados.proveedores})`;
      actual.db = null; actual.real = false;
      await sql.end();
    }
  }, 30_000);
});
