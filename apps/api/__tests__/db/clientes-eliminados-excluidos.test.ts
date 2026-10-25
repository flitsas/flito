// HU #13953 (Feature #13943, Épica #13671) — Excluir clientes eliminados de listados, selectores y del cruce por NIT.
//
// Contra PostgreSQL de verdad, dentro de una transacción con ROLLBACK (`base-en-tx.ts`); se SALTA sin
// TEST_DATABASE_URL. Mismo truco que `retencion-tramites-cliente-inactivo.test.ts`: `db` es un Drizzle sobre la
// transacción del test y `db.transaction(fn)` ejecuta `fn` sobre él.
//
// Cubre lo que decide contra la fila real (`deleted_at` de la 0257): cruce por NIT de FLIT 1 y FLIT 2 (AC6/AC7),
// tarifa (AC4), movimientos de bolsa (AC5), alta de bolsa y la lectura histórica que NO filtra (AC8). Las rutas
// (AC1/AC2/AC3, gestor por defecto) con la BD mockeada viven en `services/clientes-eliminados.routes.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { CONCEPTOS_BOLSA_COMPANIA, TipoPropiedad } from '@operaciones/shared-types';
import type { TramiteFlit } from '../../src/modules/flito-sync/flit.port.js';
import type { ItemFlit2 } from '../../src/modules/flito-sync/flit2-sync.port.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
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

const { sincronizar } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { aplicarPagina } = await import('../../src/modules/flito-sync/flit2-lectura.service.js');
const { companiaPorNit } = await import('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js');
const { fijarTarifa, TarifaClienteEliminadoError, TarifaNoEncontradaError } =
  await import('../../src/modules/flito-parametrizacion/flito-tarifas.service.js');
const { registrarRecarga, registrarMovimientoManual } = await import('../../src/modules/flito-bolsas/flito-bolsas.service.js');
const { crearBolsaCompania } = await import('../../src/modules/flito-bolsas/flito-bolsas.catalogo.service.js');
const { listar } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');

type Tx = postgres.TransactionSql;
const SUFIJO = String(Date.now()).slice(-6);
const MSG_BOLSA = 'El cliente fue eliminado; su bolsa no admite movimientos.';
const ctx = { userId: null, nombre: 'test HU13953' };

async function cliente(tx: Tx, nit: string, { eliminado, nombre }: { eliminado: boolean; nombre?: string }) {
  const [c] = await tx`INSERT INTO clients (name, document, branch_office, soat_autogestionable, impuestos_autogestionable,
      logistica_autogestionable, deleted_at)
    VALUES (${nombre ?? `Cliente HU13953 ${eliminado ? 'eliminado' : 'vigente'}`}, ${nit}, 0, false, false, false,
      CASE WHEN ${eliminado} THEN now() END) RETURNING id`;
  return c!.id as number;
}

async function organismo(tx: Tx): Promise<string> {
  const [org] = await tx`SELECT codigo FROM organismos_transito_config ORDER BY codigo LIMIT 1`;
  return org!.codigo as string;
}

function tramiteFlit(n: string, nit: string, org: string): TramiteFlit {
  return {
    idFlit: `HU13953-${SUFIJO}-${n}`, estadoFlit: 'Asignado', vin: `VIN13953${SUFIJO}${n}`, placa: `E${n}${SUFIJO.slice(-3)}`,
    ciudad: null, tipoTramite: 'Matrícula inicial', facturaVentaFlitId: null, companiaNit: nit, transitoNombre: null,
    organismoCodigo: org, fechaAprobacion: null, fechaCreacionFlit: null, cilindraje: null, carroceria: null,
    tipoServicio: null, numMotor: null, numSerie: null, tipoPropiedad: TipoPropiedad.UNICO_PROPIETARIO,
    compradores: [{ nombreCompleto: 'Comprador Prueba', numeroDocumento: `7${SUFIJO}${n.length}`, correo: null, celular: null, direccion: null }],
    valorImpuestoLiquidado: 150000, raw: {},
  } as TramiteFlit;
}

function itemFlit2(n: string, nit: string, org: string): ItemFlit2 {
  return {
    idFlit2: crypto.randomUUID(), radicado: `HU13953F2-${SUFIJO}-${n}`, syncVersion: 1, eliminado: false,
    estado: 'asignado', familia: 'MATRICULAS', fechaCreacion: null, fechaAprobacion: null,
    vehiculo: {
      vin: `VIN3F${SUFIJO}${n}`, placa: `G${n}${SUFIJO.slice(-3)}`, marca: null, linea: null, cilindraje: null,
      carroceria: null, tipoServicio: null, numMotor: null, numSerie: null,
    },
    organismo: { codigoSecretaria: org, ciudad: null, nombre: null }, companiaNit: nit, facturaAdjuntoId: null,
    compradores: [{
      ordinal: 1, porcentajeParticipacion: 100, rolActor: 'comprador', tipoPersona: null, tipoDocumento: 'CC',
      numeroDocumento: `6${SUFIJO}${n.length}`, nombreCompleto: 'Comprador F2', direccion: null, ciudad: null, celular: null,
      correo: null,
    }],
    raw: {},
  };
}
const contadores = () => ({ leidos: 0, nuevos: 0, actualizados: 0, sinCambios: 0, conflictos: 0, sinVehiculo: 0,
  eliminadosIgnorados: 0, invalidos: 0, companiasFaltantes: 0, organismosSinEmparejar: 0 }) as never;
const flit = (tramites: TramiteFlit[]) => ({ obtenerTramites: async () => tramites }) as never;
const rango = { desde: '2026-01-01', hasta: '2026-12-31' } as never;

async function tramite(tx: Tx, idFlit: string) {
  const [t] = await tx`SELECT id, compania_id, compania_nit FROM flito_tramites WHERE id_flit = ${idFlit}`;
  return t as { id: string; compania_id: number | null; compania_nit: string | null };
}

async function conBase(fn: (tx: Tx) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      await fn(tx);
    });
  } finally {
    actual.db = null;
    await sql.end();
  }
}

describe.skipIf(!URL_BASE)('HU #13953 — clientes eliminados fuera de lo que decide (PostgreSQL, ROLLBACK)', () => {
  it('AC6 (resolutor): el único match eliminado → null; AC7: eliminado + vigente misma sucursal → el vigente', async () => {
    await conBase(async (tx) => {
      const solo = `13953${SUFIJO}S`;
      await cliente(tx, solo, { eliminado: true });
      expect(await companiaPorNit(solo)).toBeNull();

      const par = `13953${SUFIJO}P`;
      await cliente(tx, par, { eliminado: true });
      const vigente = await cliente(tx, par, { eliminado: false });
      expect((await companiaPorNit(par))?.id).toBe(vigente);
    });
  });

  it('AC6 FLIT 1: sync con CompaniaGestora cuyo único match está eliminado → compania_id NULL y compania_nit guardado', async () => {
    await conBase(async (tx) => {
      const nit = `13953${SUFIJO}A`;
      await cliente(tx, nit, { eliminado: true });
      const tf = tramiteFlit('1', nit, await organismo(tx));
      const r = await sincronizar(rango, flit([tf]));
      expect(r.tramitesFallidos).toBe(0);
      expect(await tramite(tx, tf.idFlit)).toMatchObject({ compania_id: null, compania_nit: nit });
    });
  });

  it('AC7 FLIT 1: NIT con un eliminado y un vigente → el trámite se asocia al vigente', async () => {
    await conBase(async (tx) => {
      const nit = `13953${SUFIJO}B`;
      await cliente(tx, nit, { eliminado: true });
      const vigente = await cliente(tx, nit, { eliminado: false });
      const tf = tramiteFlit('2', nit, await organismo(tx));
      expect((await sincronizar(rango, flit([tf]))).tramitesFallidos).toBe(0);
      expect((await tramite(tx, tf.idFlit)).compania_id).toBe(vigente);
    });
  });

  it('AC6 + AC7 FLIT 2: mismo resolutor (eliminado solo → NULL con NIT; con vigente → vigente)', async () => {
    await conBase(async (tx) => {
      const org = await organismo(tx);
      const solo = `13953${SUFIJO}C`;
      await cliente(tx, solo, { eliminado: true });
      const a = itemFlit2('3', solo, org);
      await aplicarPagina(actual.db as never, [a], contadores());
      expect(await tramite(tx, a.radicado)).toMatchObject({ compania_id: null, compania_nit: solo });

      const par = `13953${SUFIJO}D`;
      await cliente(tx, par, { eliminado: true });
      const vigente = await cliente(tx, par, { eliminado: false });
      const b = itemFlit2('4', par, org);
      await aplicarPagina(actual.db as never, [b], contadores());
      expect((await tramite(tx, b.radicado)).compania_id).toBe(vigente);
    });
  });

  it('AC4: fijar tarifa a un eliminado → 404 «Cliente no encontrado»; inexistente sigue como antes', async () => {
    await conBase(async (tx) => {
      const id = await cliente(tx, `13953${SUFIJO}T`, { eliminado: true });
      const e = await fijarTarifa({ companiaId: id, concepto: 'logistica', valor: 1000 }, null).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(TarifaClienteEliminadoError);
      expect(e).toBeInstanceOf(TarifaNoEncontradaError);
      expect((e as Error).message).toBe('Cliente no encontrado');
      const [n] = await tx`SELECT count(*)::int AS n FROM flito_tarifas_vigencias WHERE compania_id = ${id}`;
      expect(n!.n).toBe(0);
    });
  });

  it('AC5: recarga y movimiento manual de un eliminado → 409 con el texto de la HU (antes que «sin bolsa»)', async () => {
    await conBase(async (tx) => {
      const id = await cliente(tx, `13953${SUFIJO}M`, { eliminado: true });
      const soporte = { nombreArchivo: 'r.pdf', contentType: 'application/pdf', storageKey: 'k', hash: 'h', tamanoBytes: 1 };
      const recarga = await registrarRecarga(id, { valor: 1000, soporte, claveIdempotencia: `hu13953-${SUFIJO}` }, ctx)
        .catch((x: unknown) => x);
      expect(recarga).toMatchObject({ message: MSG_BOLSA, estado: 409 });
      const manual = await registrarMovimientoManual(id, { tipo: 'entrada', valor: 1000, motivo: 'ajuste de prueba' }, ctx)
        .catch((x: unknown) => x);
      expect(manual).toMatchObject({ message: MSG_BOLSA, estado: 409 });

      // Control: un vigente sin bolsa sigue con el 409 de siempre (no es el de eliminado).
      const vivo = await cliente(tx, `13953${SUFIJO}V`, { eliminado: false });
      const otro = await registrarMovimientoManual(vivo, { tipo: 'entrada', valor: 1000, motivo: 'ajuste de prueba' }, ctx)
        .catch((x: unknown) => x);
      expect((otro as Error).message).not.toBe(MSG_BOLSA);
    });
  });

  it('alta de bolsa para un eliminado → 404 «La compañía no existe» y sin fila', async () => {
    await conBase(async (tx) => {
      const id = await cliente(tx, `13953${SUFIJO}K`, { eliminado: true });
      const e = await crearBolsaCompania({ companiaId: id, conceptos: [CONCEPTOS_BOLSA_COMPANIA[0]!] }, ctx).catch((x: unknown) => x);
      expect(e).toMatchObject({ message: 'La compañía no existe', estado: 404 });
      const [n] = await tx`SELECT count(*)::int AS n FROM flito_bolsas_unicas WHERE compania_id = ${id}`;
      expect(n!.n).toBe(0);
    });
  });

  it('AC8: la lectura histórica NO filtra — un trámite existente sigue mostrando el nombre del cliente eliminado', async () => {
    await conBase(async (tx) => {
      const nit = `13953${SUFIJO}H`;
      const id = await cliente(tx, nit, { eliminado: false, nombre: 'Cliente HU13953 historico' });
      const tf = tramiteFlit('8', nit, await organismo(tx));
      expect((await sincronizar(rango, flit([tf]))).tramitesFallidos).toBe(0);
      const t = await tramite(tx, tf.idFlit);
      expect(t.compania_id).toBe(id);
      await tx`UPDATE clients SET deleted_at = now() WHERE id = ${id}`;
      const bandeja = await listar({ buscar: tf.placa! });
      const fila = bandeja.items.find((i) => i.tramiteId === t.id) as { companiaNombre?: string } | undefined;
      expect(fila?.companiaNombre).toBe('Cliente HU13953 historico');
    });
  });
});
