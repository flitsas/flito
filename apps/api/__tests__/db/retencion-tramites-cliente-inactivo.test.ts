// HU #13946 (Feature #13939) — Retener los trámites de FLIT de un cliente inactivo y liberarlos al activarlo.
//
// Contra PostgreSQL de verdad, dentro de una transacción con ROLLBACK (`base-en-tx.ts`); se SALTA sin
// TEST_DATABASE_URL. Mismo truco que `clients-estado.test.ts`: `db` es un Drizzle sobre la transacción del test y
// `db.transaction(fn)` ejecuta `fn` sobre él. Para el AC6 la «transacción» de la activación corre en un SAVEPOINT,
// así que su ROLLBACK real se observa desde fuera.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { TipoPropiedad } from '@operaciones/shared-types';
import type { TramiteFlit } from '../../src/modules/flito-sync/flit.port.js';
import type { ItemFlit2 } from '../../src/modules/flito-sync/flit2-sync.port.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
// Sin Redis en el test (la caché que tocan algunos módulos importados se desactiva).
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
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

// AC6: hace fallar el arranque del trámite cuyo radicado aparezca en el motivo del alta del SOAT.
const falla: { radicado: string | null } = { radicado: null };
vi.mock('../../src/shared/historial/estado-historial.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/shared/historial/estado-historial.js')>();
  return {
    ...real,
    registrarCambio: (async (...args: Parameters<typeof real.registrarCambio>) => {
      const motivo = (args[1] as { motivo?: string }).motivo ?? '';
      if (falla.radicado && motivo.includes(falla.radicado)) throw new Error('fallo simulado del arranque');
      return real.registrarCambio(...args);
    }) as typeof real.registrarCambio,
  };
});

const { sincronizar } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { cambiarEstadoCliente } = await import('../../src/modules/clients/clients.service.js');
const { listar, facetas } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');
const { aplicarPagina } = await import('../../src/modules/flito-sync/flit2-lectura.service.js');
const logistica = await import('../../src/modules/flito-logistica/flito-logistica.service.js');

type Tx = postgres.TransactionSql;
const SUFIJO = String(Date.now()).slice(-6);
let opciones: postgres.Sql['options'];

/** Cliente que gestiona SOAT e impuesto con FLITO + organismo con modalidad `requiere_gestion` vigente. */
async function sembrar(tx: Tx, { activo }: { activo: boolean }) {
  const nit = `13946${SUFIJO}${activo ? 'A' : 'I'}`;
  const [c] = await tx`INSERT INTO clients (name, document, active, soat_autogestionable, impuestos_autogestionable,
      logistica_autogestionable)
    VALUES (${'Cliente HU13946'}, ${nit}, ${activo}, false, false, false) RETURNING id`;
  const [org] = await tx`SELECT codigo FROM organismos_transito_config ORDER BY codigo LIMIT 1`;
  const organismo = org!.codigo as string;
  await tx`UPDATE flito_organismo_vigencias SET hasta = now() WHERE organismo_codigo = ${organismo} AND hasta IS NULL`;
  await tx`INSERT INTO flito_organismo_vigencias (organismo_codigo, modalidad, desde, motivo, actor_nombre)
    VALUES (${organismo}, 'requiere_gestion', now() - interval '1 day', 'test HU13946', 'test')`;
  return { id: c!.id as number, nit, organismo };
}

function tramiteFlit(n: string, nit: string, organismo: string, over: Partial<TramiteFlit> = {}): TramiteFlit {
  return {
    idFlit: `HU13946-${SUFIJO}-${n}`, estadoFlit: 'Asignado', vin: `VIN13946${SUFIJO}${n}`, placa: `R${n}${SUFIJO.slice(-3)}`,
    ciudad: null, tipoTramite: 'Matrícula inicial', facturaVentaFlitId: null, companiaNit: nit, transitoNombre: null,
    organismoCodigo: organismo, fechaAprobacion: null, fechaCreacionFlit: null, cilindraje: null, carroceria: null,
    tipoServicio: null, numMotor: null, numSerie: null, tipoPropiedad: TipoPropiedad.UNICO_PROPIETARIO,
    compradores: [{ nombreCompleto: 'Comprador Prueba', numeroDocumento: `9${SUFIJO}${n.length}`, correo: null, celular: null, direccion: null }],
    valorImpuestoLiquidado: 150000, raw: {}, ...over,
  } as TramiteFlit;
}

/** Un ítem de FLIT 2 asignado, con comprador principal y el organismo por código. */
function itemFlit2(n: string, nit: string, organismo: string): ItemFlit2 {
  return {
    idFlit2: crypto.randomUUID(), radicado: `HU13946F2-${SUFIJO}-${n}`, syncVersion: 1, eliminado: false,
    estado: 'asignado', familia: 'MATRICULAS', fechaCreacion: null, fechaAprobacion: null,
    vehiculo: {
      vin: `VIN2F${SUFIJO}${n}`, placa: `F${n}${SUFIJO.slice(-3)}`, marca: null, linea: null, cilindraje: null,
      carroceria: null, tipoServicio: null, numMotor: null, numSerie: null,
    },
    organismo: { codigoSecretaria: organismo, ciudad: null, nombre: null }, companiaNit: nit, facturaAdjuntoId: null,
    compradores: [{
      ordinal: 1, porcentajeParticipacion: 100, rolActor: 'comprador', tipoPersona: null, tipoDocumento: 'CC',
      numeroDocumento: `8${SUFIJO}${n.length}`, nombreCompleto: 'Comprador F2', direccion: null, ciudad: null, celular: null,
      correo: null,
    }],
    raw: {},
  };
}
const contadores = () => ({ leidos: 0, nuevos: 0, actualizados: 0, sinCambios: 0, conflictos: 0, sinVehiculo: 0,
  eliminadosIgnorados: 0, invalidos: 0, companiasFaltantes: 0, organismosSinEmparejar: 0 }) as never;

const flit = (tramites: TramiteFlit[]) => ({ obtenerTramites: async () => tramites }) as never;
const rango = { desde: '2026-01-01', hasta: '2026-12-31' } as never;

async function estado(tx: Tx, idFlit: string) {
  const [t] = await tx`SELECT t.id, t.retenido, t.soat_id, t.flit_estado, t.tipo_tramite, t.fuente,
      (SELECT count(*)::int FROM flito_impuestos i WHERE i.tramite_id = t.id) AS impuestos
    FROM flito_tramites t WHERE t.id_flit = ${idFlit}`;
  return t as { id: string; retenido: boolean; soat_id: string | null; flit_estado: string; tipo_tramite: string; impuestos: number };
}

async function conBase(fn: (tx: Tx) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      // Igual que `clients-estado.test.ts`: la TransactionSql no expone `options` (parsers de Drizzle).
      opciones = sql.options;
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(tx);
    });
  } finally {
    actual.db = null; falla.radicado = null;
    await sql.end();
  }
}

describe.skipIf(!URL_BASE)('HU #13946 — retención de trámites de un cliente inactivo (PostgreSQL, ROLLBACK)', () => {
  it('AC1 + AC2: cliente inactivo → trámite nuevo retenido, sin SOAT ni impuesto, y fuera de la bandeja', async () => {
    await conBase(async (tx) => {
      const c = await sembrar(tx, { activo: false });
      const tf = tramiteFlit('1', c.nit, c.organismo);
      const r = await sincronizar(rango, flit([tf]));
      expect(r.tramitesFallidos).toBe(0);
      expect(r.soatCreados).toBe(0);
      expect(r.impuestosCreados).toBe(0);
      const t = await estado(tx, tf.idFlit);
      expect(t).toMatchObject({ retenido: true, soat_id: null, impuestos: 0 });
      const [s] = await tx`SELECT count(*)::int AS n FROM flito_soat WHERE vin = ${tf.vin}`;
      expect(s!.n).toBe(0);
      const bandeja = await listar({ buscar: tf.placa! });
      expect(bandeja.items.map((i) => i.tramiteId)).not.toContain(t.id);
      expect(bandeja.total).toBe(0);
    });
  });

  it('AC4: cliente activo → como hoy (no retenido, con SOAT e impuesto, en la bandeja)', async () => {
    await conBase(async (tx) => {
      const c = await sembrar(tx, { activo: true });
      const tf = tramiteFlit('4', c.nit, c.organismo);
      const r = await sincronizar(rango, flit([tf]));
      expect(r.tramitesFallidos).toBe(0);
      const t = await estado(tx, tf.idFlit);
      expect(t.retenido).toBe(false);
      expect(t.soat_id).not.toBeNull();
      expect(t.impuestos).toBe(1);
      const bandeja = await listar({ buscar: tf.placa! });
      expect(bandeja.items.map((i) => i.tramiteId)).toContain(t.id);
    });
  });

  it('AC5: update de FLIT sobre un retenido con el cliente aún inactivo → datos actualizados y sigue retenido', async () => {
    await conBase(async (tx) => {
      const c = await sembrar(tx, { activo: false });
      const tf = tramiteFlit('5', c.nit, c.organismo);
      expect((await sincronizar(rango, flit([tf]))).tramitesFallidos).toBe(0);
      const r = await sincronizar(rango, flit([{ ...tf, tipoTramite: 'Traspaso' }]));
      expect(r).toMatchObject({ tramitesFallidos: 0, tramitesActualizados: 1 });
      const t = await estado(tx, tf.idFlit);
      expect(t).toMatchObject({ retenido: true, tipo_tramite: 'Traspaso', soat_id: null, impuestos: 0 });
    });
  });

  it('AC3: activar el cliente con 2 retenidos → ambos liberados, con SOAT e impuesto, y en la bandeja', async () => {
    await conBase(async (tx) => {
      const c = await sembrar(tx, { activo: false });
      const a = tramiteFlit('3a', c.nit, c.organismo);
      const b = tramiteFlit('3b', c.nit, c.organismo);
      expect((await sincronizar(rango, flit([a, b]))).tramitesFallidos).toBe(0);
      expect((await estado(tx, a.idFlit)).retenido).toBe(true);
      expect((await estado(tx, b.idFlit)).retenido).toBe(true);

      const res = await cambiarEstadoCliente(c.id, { activo: true, activoEsperado: false });
      expect(res.active).toBe(true);
      for (const tf of [a, b]) {
        const t = await estado(tx, tf.idFlit);
        expect(t.retenido).toBe(false);
        expect(t.soat_id).not.toBeNull();
        expect(t.impuestos).toBe(1);
        const bandeja = await listar({ buscar: tf.placa! });
        expect(bandeja.items.map((i) => i.tramiteId)).toContain(t.id);
      }
    });
  });

  it('AC6: si el arranque de uno falla durante la activación → rollback completo (cliente inactivo, trámites retenidos)', async () => {
    await conBase(async (tx) => {
      const c = await sembrar(tx, { activo: false });
      const a = tramiteFlit('6a', c.nit, c.organismo);
      const b = tramiteFlit('6b', c.nit, c.organismo);
      expect((await sincronizar(rango, flit([a, b]))).tramitesFallidos).toBe(0);

      falla.radicado = b.idFlit;
      const externo = actual.db;
      await expect(tx.savepoint(async (sp) => {
        actual.db = drizzle(Object.assign(sp, { options: opciones }) as unknown as postgres.Sql, { schema });
        await cambiarEstadoCliente(c.id, { activo: true, activoEsperado: false });
      })).rejects.toThrow('fallo simulado del arranque');
      actual.db = externo;

      const [cli] = await tx`SELECT active FROM clients WHERE id = ${c.id}`;
      expect(cli!.active).toBe(false);
      for (const tf of [a, b]) {
        const t = await estado(tx, tf.idFlit);
        expect(t).toMatchObject({ retenido: true, soat_id: null, impuestos: 0 });
        const [s] = await tx`SELECT count(*)::int AS n FROM flito_soat WHERE vin = ${tf.vin}`;
        expect(s!.n).toBe(0);
      }
    });
  });

  it('FLIT 2 — AC1: cliente inactivo → el trámite nuevo nace retenido y no arranca; AC5: un update lo deja retenido', async () => {
    await conBase(async (tx) => {
      const c = await sembrar(tx, { activo: false });
      const it = itemFlit2('21', c.nit, c.organismo);
      await aplicarPagina(actual.db as never, [it], contadores());
      expect(await estado(tx, it.radicado)).toMatchObject({ fuente: 'flit2', retenido: true, soat_id: null, impuestos: 0 });
      await aplicarPagina(actual.db as never, [{ ...it, syncVersion: 2, familia: 'TRASPASO' }], contadores());
      expect(await estado(tx, it.radicado)).toMatchObject({ retenido: true, tipo_tramite: 'Traspaso', soat_id: null, impuestos: 0 });
    });
  });

  it('FLIT 2 — AC4: cliente activo → como hoy (no retenido, con SOAT e impuesto)', async () => {
    await conBase(async (tx) => {
      const c = await sembrar(tx, { activo: true });
      const it = itemFlit2('24', c.nit, c.organismo);
      await aplicarPagina(actual.db as never, [it], contadores());
      const t = await estado(tx, it.radicado);
      expect(t.retenido).toBe(false);
      expect(t.soat_id).not.toBeNull();
      expect(t.impuestos).toBe(1);
    });
  });

  it('FLIT 2 — AC3: activar el cliente libera el retenido de FLIT 2 y arranca SOAT e impuesto (RN-17: tiene principal)', async () => {
    await conBase(async (tx) => {
      const c = await sembrar(tx, { activo: false });
      const it = itemFlit2('23', c.nit, c.organismo);
      await aplicarPagina(actual.db as never, [it], contadores());
      await cambiarEstadoCliente(c.id, { activo: true, activoEsperado: false });
      const t = await estado(tx, it.radicado);
      expect(t.retenido).toBe(false);
      expect(t.soat_id).not.toBeNull();
      expect(t.impuestos).toBe(1);
    });
  });

  it('AC2 — facetas de la bandeja: lo de un retenido no aparece; lo de uno no retenido sí', async () => {
    await conBase(async (tx) => {
      const inactivo = await sembrar(tx, { activo: false });
      const activo = await sembrar(tx, { activo: true });
      const ciudadRet = `CIUDADRET${SUFIJO}`;
      const ciudadVis = `CIUDADVIS${SUFIJO}`;
      await sincronizar(rango, flit([tramiteFlit('f1', inactivo.nit, inactivo.organismo, { ciudad: ciudadRet })]));
      await sincronizar(rango, flit([tramiteFlit('f2', activo.nit, activo.organismo, { ciudad: ciudadVis })]));
      const f = await facetas();
      expect(f.ciudades).toContain(ciudadVis);
      expect(f.ciudades).not.toContain(ciudadRet);
    });
  });

  it('AC2 — logística: un retenido que FLIT aprueba no entra a la consola; uno no retenido aprobado sí', async () => {
    await conBase(async (tx) => {
      const inactivo = await sembrar(tx, { activo: false });
      const activo = await sembrar(tx, { activo: true });
      const ret = tramiteFlit('l1', inactivo.nit, inactivo.organismo, { estadoFlit: 'Aprobado' });
      const vis = tramiteFlit('l2', activo.nit, activo.organismo, { estadoFlit: 'Aprobado' });
      await sincronizar(rango, flit([ret, vis]));
      expect((await estado(tx, ret.idFlit)).retenido).toBe(true);
      const l = await logistica.listar({ empresas: [inactivo.nit, activo.nit] });
      expect(l.items.map((i) => i.idFlit)).toEqual([vis.idFlit]);
      const fac = await logistica.facetas();
      expect(fac.empresas.map((e) => e.nit)).not.toContain(inactivo.nit);
    });
  });
});
