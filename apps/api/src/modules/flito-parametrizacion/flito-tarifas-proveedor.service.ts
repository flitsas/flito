// FLITO — tarifas de proveedor: el COSTO que cada proveedor le cobra a FLIT por concepto (ADR-0041, Épica #13763).
// No es la tarifa al cliente (`flito-tarifas.service.ts`): ninguna función de aquí lee `flito_tarifas_vigencias`, y
// nada de aquí se exporta hacia otros módulos (R8: ningún proceso lee estos costos todavía).
//
// RN-TP-01 — Vigencias `[vigente_desde, vigente_hasta)`: nunca se borran ni se pisan. Cambiar = cerrar la abierta y
//            abrir otra en UNA transacción con el MISMO `now()`; dejar de cobrar = cerrar sin abrir (R4). El valor
//            anterior se lee en la transacción (`FOR UPDATE`), nunca del cuerpo.
// RN-TP-02 — Las filas de la vista son los conceptos de los servicios VIGENTES del proveedor (perfil con
//            `deleted_at IS NULL`, R2). Escribir un concepto de un servicio sin perfil vivo → 422.
// RN-TP-03 — $0 es un costo válido y distinto de «Sin configurar» (= sin vigencia abierta). Sin confirmación en API.
// RN-TP-04 — Concurrencia (R6): orden de bloqueo padre (`FOR SHARE`) → perfil (`FOR SHARE`) → vigencia
//            (`FOR UPDATE`), el de ADR-0039 §4.3. Vigencia del path ya cerrada, abierta existente al fijar, o
//            23505/23P01 de esta tabla → `TarifaProveedorCambiadaError` (409).
// RN-TP-05 — Proveedor inactivo o eliminado: no se fija, cambia ni cierra (409 `PROVEEDOR_NO_ACTIVO`); su vista y su
//            historial se leen igual. Quitar un servicio NO cierra su vigencia: queda latente, sale de la vista y, si
//            el servicio se reasigna, la fila reaparece con su último valor. En el historial se marca con
//            `servicioAsignado: false` (decisión del humano, posterior al ADR).
// RN-TP-06 — Frontera: el router va sin `conAlcance`; todo enlace distinto de `ninguno` recibe 403 (R7, ADR-0039).
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  CODIGO_TARIFA_PROVEEDOR_CAMBIADA, CONCEPTOS_COSTO_PROVEEDOR, CONCEPTOS_DE_SERVICIO, MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO,
  SERVICIOS_PROVEEDOR, SERVICIO_DE_CONCEPTO_COSTO,
  type ConceptoCostoProveedor, type ResultadoCambioCostoProveedor, type ResumenProveedorCostos, type ServicioProveedor,
  type VigenciaCostoProveedor, type VistaCostosProveedor,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  flitoProveedores, flitoProveedoresLogistica, flitoProveedoresSoat, flitoTarifasProveedorVigencias, users,
} from '../../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Ejecutor = typeof db | Tx;

/** Error de negocio de las tarifas de proveedor. Las subclases deciden el código HTTP en la ruta. */
export class TarifaProveedorError extends Error {}

/** 404 `PROVEEDOR_NO_ENCONTRADO`: proveedor inexistente, o eliminado cuando se intenta escribir. */
export class TarifaProveedorProveedorNoEncontradoError extends TarifaProveedorError {
  readonly code = 'PROVEEDOR_NO_ENCONTRADO';
  constructor() { super('Proveedor no encontrado'); }
}

/** 404 `VIGENCIA_NO_ENCONTRADA`. */
export class VigenciaCostoNoEncontradaError extends TarifaProveedorError {
  readonly code = 'VIGENCIA_NO_ENCONTRADA';
  constructor() { super('Vigencia no encontrada'); }
}

/** 409 R6: la vigencia del path ya no está abierta, ya hay una abierta al fijar, o 23505/23P01 de esta tabla. */
export class TarifaProveedorCambiadaError extends TarifaProveedorError {
  readonly code = CODIGO_TARIFA_PROVEEDOR_CAMBIADA;
  constructor() { super(MENSAJE_TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO); }
}

/** 409 `PROVEEDOR_NO_ACTIVO`: escritura sobre un proveedor inactivo (D6). */
export class ProveedorNoActivoError extends TarifaProveedorError {
  readonly code = 'PROVEEDOR_NO_ACTIVO';
  constructor() { super('El proveedor está inactivo'); }
}

/** 422 `SERVICIO_NO_PRESTADO`: el concepto es de un servicio sin perfil vivo para ese proveedor (R2). */
export class ServicioCostoNoPrestadoError extends TarifaProveedorError {
  readonly code = 'SERVICIO_NO_PRESTADO';
  constructor() { super('El proveedor no presta ese servicio'); }
}

export interface DatosFijarCosto { proveedorId: string; concepto: ConceptoCostoProveedor; valor: number }

/** Exactamente uno de los dos (lo garantiza el Zod de la ruta). */
export type CambiosCosto = { valor: number } | { cerrar: true };

/** La vista sin `capacidades`: esas las calcula la ruta con el motor de permisos. */
export type VistaCostosSinCapacidades = Omit<VistaCostosProveedor, 'capacidades'>;


/** Lo que devuelve una escritura: el DTO más el nombre del proveedor, que solo usa `audit()` en la ruta. */
export type ConProveedor<T> = { resultado: T; proveedorNombre: string };

const t = flitoTarifasProveedorVigencias;
const fijador = alias(users, 'tp_fijador');
const cerrador = alias(users, 'tp_cerrador');

/** Perfil (tabla) de cada servicio: un servicio está vigente si su perfil existe con `deleted_at IS NULL` (R2). */
const PERFIL = { soat: flitoProveedoresSoat, logistica: flitoProveedoresLogistica } as const;

/** Único punto donde el `numeric` de PostgreSQL (string) pasa a número. */
export const aNumero = (v: string | number): number => Number(v);

const COLUMNAS_VIGENCIA = {
  id: t.id, proveedorId: t.proveedorId, servicio: t.servicio, concepto: t.concepto, valor: t.valor,
  vigenteDesde: t.vigenteDesde, vigenteHasta: t.vigenteHasta,
  fijadoPorId: t.fijadoPorId, fijadoPorNombre: fijador.name, fijadoEn: t.fijadoEn,
  cerradoPorId: t.cerradoPorId, cerradoPorNombre: cerrador.name, cerradoEn: t.cerradoEn,
};

interface FilaVigencia {
  id: string; proveedorId: string; servicio: string; concepto: string; valor: string;
  vigenteDesde: Date; vigenteHasta: Date | null;
  fijadoPorId: number | null; fijadoPorNombre: string | null; fijadoEn: Date;
  cerradoPorId: number | null; cerradoPorNombre: string | null; cerradoEn: Date | null;
}

const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();

function aVigencia(f: FilaVigencia, servicioAsignado: boolean): VigenciaCostoProveedor {
  return {
    id: f.id, proveedorId: f.proveedorId, servicio: f.servicio as ServicioProveedor,
    concepto: f.concepto as ConceptoCostoProveedor, valor: aNumero(f.valor),
    vigenteDesde: iso(f.vigenteDesde), vigenteHasta: f.vigenteHasta ? iso(f.vigenteHasta) : null,
    fijadoPor: f.fijadoPorId != null ? { id: f.fijadoPorId, nombre: f.fijadoPorNombre ?? null } : null,
    fijadoEn: iso(f.fijadoEn),
    cerradoPor: f.cerradoPorId != null ? { id: f.cerradoPorId, nombre: f.cerradoPorNombre ?? null } : null,
    cerradoEn: f.cerradoEn ? iso(f.cerradoEn) : null,
    servicioAsignado,
  };
}

function selectVigencias(ej: Ejecutor, condicion: SQL | undefined) {
  return ej.select(COLUMNAS_VIGENCIA).from(t)
    .leftJoin(fijador, eq(t.fijadoPorId, fijador.id))
    .leftJoin(cerrador, eq(t.cerradoPorId, cerrador.id))
    .where(condicion);
}

/** Lee una vigencia escrita en la transacción `ej` (la API solo escribe sobre servicios vigentes). */
async function leerVigencia(ej: Ejecutor, id: string): Promise<VigenciaCostoProveedor> {
  const [f] = await selectVigencias(ej, eq(t.id, id)).limit(1);
  if (!f) throw new VigenciaCostoNoEncontradaError();
  return aVigencia(f as FilaVigencia, true);
}

/** Servicios con perfil vivo, por proveedor. */
async function serviciosVigentes(ej: Ejecutor, ids: string[]): Promise<Map<string, Set<ServicioProveedor>>> {
  const mapa = new Map<string, Set<ServicioProveedor>>(ids.map((id) => [id, new Set()]));
  if (ids.length === 0) return mapa;
  for (const servicio of SERVICIOS_PROVEEDOR) {
    const perfil = PERFIL[servicio];
    const filas = await ej.select({ id: perfil.id }).from(perfil).where(and(inArray(perfil.id, ids), isNull(perfil.deletedAt)));
    for (const f of filas) mapa.get(f.id)?.add(servicio);
  }
  return mapa;
}

const ordenServicios = (s: Set<ServicioProveedor>): ServicioProveedor[] => SERVICIOS_PROVEEDOR.filter((x) => s.has(x));

/**
 * ¿Choque de llave de ESTA tabla (único parcial 23505 o EXCLUDE 23P01)? Drizzle envuelve el error de postgres: el
 * `code` viaja en `cause`. Si el driver informa la restricción, se exige que sea una de las dos de la 0300.
 */
const RESTRICCIONES_DE_LLAVE = new Set(['uq_flito_tarifas_prov_abierta', 'flito_tarifas_prov_sin_solape']);
export function esChoqueDeLlaveCosto(e: unknown): boolean {
  for (let err: unknown = e, i = 0; err && typeof err === 'object' && i < 5; i++) {
    const { code, cause, constraint_name: restriccion } = err as { code?: string; cause?: unknown; constraint_name?: string };
    if (code === '23505' || code === '23P01') return restriccion === undefined || RESTRICCIONES_DE_LLAVE.has(restriccion);
    err = cause;
  }
  return false;
}

/**
 * Padre `FOR SHARE` (RN-TP-04): inexistente o eliminado → 404; inactivo → 409 (RN-TP-05). Luego el perfil del servicio
 * `FOR SHARE`: sin perfil vivo → 422 (RN-TP-02). Devuelve el nombre para la auditoría.
 */
async function bloquearProveedorYServicio(tx: Tx, proveedorId: string, servicio: ServicioProveedor): Promise<string> {
  const [p] = await tx.select({ nombre: flitoProveedores.nombre, activo: flitoProveedores.activo, deletedAt: flitoProveedores.deletedAt })
    .from(flitoProveedores).where(eq(flitoProveedores.id, proveedorId)).for('share');
  if (!p || p.deletedAt != null) throw new TarifaProveedorProveedorNoEncontradoError();
  if (!p.activo) throw new ProveedorNoActivoError();
  const perfil = PERFIL[servicio];
  const [vivo] = await tx.select({ id: perfil.id }).from(perfil)
    .where(and(eq(perfil.id, proveedorId), isNull(perfil.deletedAt))).for('share');
  if (!vivo) throw new ServicioCostoNoPrestadoError();
  return p.nombre;
}

/** Proveedores activos y vivos, por nombre, con cuántos conceptos les faltan (R5). */
export async function listarProveedoresConCostos(): Promise<ResumenProveedorCostos[]> {
  const proveedores = await db.select({ id: flitoProveedores.id, nombre: flitoProveedores.nombre }).from(flitoProveedores)
    .where(and(eq(flitoProveedores.activo, true), isNull(flitoProveedores.deletedAt)))
    .orderBy(asc(flitoProveedores.nombre));
  if (proveedores.length === 0) return [];
  const ids = proveedores.map((p) => p.id);
  const servicios = await serviciosVigentes(db, ids);
  const abiertas = await db.select({ proveedorId: t.proveedorId, concepto: t.concepto }).from(t)
    .where(and(inArray(t.proveedorId, ids), isNull(t.vigenteHasta)));
  return proveedores.map((p) => {
    const suyos = ordenServicios(servicios.get(p.id) ?? new Set());
    const conceptos = suyos.flatMap((s) => CONCEPTOS_DE_SERVICIO[s]);
    const configurados = new Set(abiertas.filter((a) => a.proveedorId === p.id).map((a) => a.concepto));
    return {
      id: p.id, nombre: p.nombre, servicios: suyos, conceptos: conceptos.length,
      faltan: conceptos.filter((c) => !configurados.has(c)).length,
    };
  });
}

async function proveedorLeible(proveedorId: string) {
  const [p] = await db.select({
    id: flitoProveedores.id, nombre: flitoProveedores.nombre, activo: flitoProveedores.activo, deletedAt: flitoProveedores.deletedAt,
  }).from(flitoProveedores).where(eq(flitoProveedores.id, proveedorId)).limit(1);
  if (!p) throw new TarifaProveedorProveedorNoEncontradoError();
  return p;
}

/** Filas por concepto de los servicios vigentes (R2). Se consulta aunque el proveedor esté inactivo o eliminado (D6). */
export async function vistaCostosProveedor(proveedorId: string): Promise<VistaCostosSinCapacidades> {
  const p = await proveedorLeible(proveedorId);
  const eliminado = p.deletedAt != null;
  const suyos = ordenServicios((await serviciosVigentes(db, [proveedorId])).get(proveedorId) ?? new Set());
  const abiertas = await selectVigencias(db, and(eq(t.proveedorId, proveedorId), isNull(t.vigenteHasta)));
  const filas = suyos.flatMap((servicio) => CONCEPTOS_DE_SERVICIO[servicio].map((concepto) => {
    const a = abiertas.find((f) => f.concepto === concepto);
    return { servicio, concepto, vigencia: a ? aVigencia(a as FilaVigencia, true) : null };
  }));
  return { proveedor: { id: p.id, nombre: p.nombre, activo: p.activo && !eliminado, eliminado }, filas };
}

/** Todas las vigencias, incluidas las de servicios retirados (R5), por `concepto, vigente_desde DESC`. */
export async function historialCostosProveedor(
  proveedorId: string, concepto?: ConceptoCostoProveedor,
): Promise<VigenciaCostoProveedor[]> {
  await proveedorLeible(proveedorId);
  const suyos = (await serviciosVigentes(db, [proveedorId])).get(proveedorId) ?? new Set();
  const filas = await selectVigencias(db, and(eq(t.proveedorId, proveedorId), concepto ? eq(t.concepto, concepto) : undefined))
    .orderBy(asc(t.concepto), desc(t.vigenteDesde));
  return filas.map((f) => aVigencia(f as FilaVigencia, suyos.has(f.servicio as ServicioProveedor)));
}

/** Primera fijación, o volver a cobrar tras cerrar. `vigente_desde` = `now()` de la transacción (D5). */
export async function fijarCosto(d: DatosFijarCosto, usuarioId: number | null): Promise<ConProveedor<VigenciaCostoProveedor>> {
  if (!CONCEPTOS_COSTO_PROVEEDOR.includes(d.concepto)) throw new TarifaProveedorError('Concepto de costo desconocido');
  const servicio = SERVICIO_DE_CONCEPTO_COSTO[d.concepto];
  try {
    return await db.transaction(async (tx) => {
      const proveedorNombre = await bloquearProveedorYServicio(tx, d.proveedorId, servicio);
      const [abierta] = await tx.select({ id: t.id }).from(t)
        .where(and(eq(t.proveedorId, d.proveedorId), eq(t.concepto, d.concepto), isNull(t.vigenteHasta))).for('update');
      if (abierta) throw new TarifaProveedorCambiadaError();
      const [nueva] = await tx.insert(t).values({
        proveedorId: d.proveedorId, servicio, concepto: d.concepto, valor: String(d.valor),
        vigenteDesde: sql`now()`, fijadoPorId: usuarioId, fijadoEn: sql`now()`,
      }).returning({ id: t.id });
      return { resultado: await leerVigencia(tx, nueva!.id), proveedorNombre };
    });
  } catch (e) {
    if (esChoqueDeLlaveCosto(e)) throw new TarifaProveedorCambiadaError();
    throw e;
  }
}

/** Cambiar (cerrar y abrir con el mismo `now()`) o cerrar sin abrir la vigencia abierta `vigenciaId` (R4, R6). */
export async function cambiarOCerrarCosto(
  vigenciaId: string, cambios: CambiosCosto, usuarioId: number | null,
): Promise<ConProveedor<ResultadoCambioCostoProveedor>> {
  // Sin lock: solo para saber a qué padre y perfil bloquear primero (orden RN-TP-04). Se relee con FOR UPDATE.
  const [ref] = await db.select({ proveedorId: t.proveedorId, servicio: t.servicio }).from(t).where(eq(t.id, vigenciaId)).limit(1);
  if (!ref) throw new VigenciaCostoNoEncontradaError();
  try {
    return await db.transaction(async (tx) => {
      const proveedorNombre = await bloquearProveedorYServicio(tx, ref.proveedorId, ref.servicio as ServicioProveedor);
      const [v] = await tx.select({
        id: t.id, proveedorId: t.proveedorId, servicio: t.servicio, concepto: t.concepto, valor: t.valor, vigenteHasta: t.vigenteHasta,
      }).from(t).where(eq(t.id, vigenciaId)).for('update');
      if (!v) throw new VigenciaCostoNoEncontradaError();
      if (v.vigenteHasta !== null) throw new TarifaProveedorCambiadaError();
      const valorAnterior = aNumero(v.valor);
      const cierre = { vigenteHasta: sql`now()`, cerradoPorId: usuarioId, cerradoEn: sql`now()` };

      if ('cerrar' in cambios) {
        await tx.update(t).set(cierre).where(eq(t.id, v.id));
        return {
          resultado: { vigencia: await leerVigencia(tx, v.id), accion: 'cerrada' as const, valorAnterior, valorNuevo: null },
          proveedorNombre,
        };
      }
      if (cambios.valor === valorAnterior) {
        return {
          resultado: { vigencia: await leerVigencia(tx, v.id), accion: 'sin_cambio' as const, valorAnterior, valorNuevo: valorAnterior },
          proveedorNombre,
        };
      }
      await tx.update(t).set(cierre).where(eq(t.id, v.id));
      const [nueva] = await tx.insert(t).values({
        proveedorId: v.proveedorId, servicio: v.servicio, concepto: v.concepto, valor: String(cambios.valor),
        vigenteDesde: sql`now()`, fijadoPorId: usuarioId, fijadoEn: sql`now()`,
      }).returning({ id: t.id });
      return {
        resultado: { vigencia: await leerVigencia(tx, nueva!.id), accion: 'cambiada' as const, valorAnterior, valorNuevo: cambios.valor },
        proveedorNombre,
      };
    });
  } catch (e) {
    if (esChoqueDeLlaveCosto(e)) throw new TarifaProveedorCambiadaError();
    throw e;
  }
}
