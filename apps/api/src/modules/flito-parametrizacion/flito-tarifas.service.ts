// FLITO — tarifas negociadas por compañía gestora, modeladas como VIGENCIAS (HU #12373,
// Feature #12365; antes HU #10963).
//
// Solo cubre los conceptos que SE NEGOCIAN: el SOAT, el impuesto y el derecho de trámite son
// desembolsos reales y se leen del documento pagado, no de una tabla de precios.
//
// RN-01 — Una vigencia no se borra ni se edita: se CIERRA y se abre otra. Cambiar un valor es cerrar
//         la abierta y abrir la nueva en UNA transacción, con el MISMO instante en las dos escrituras
//         (rangos `[a, ahora)` y `[ahora, ∞)`, sin hueco ni solape). El valor anterior se lee dentro de
//         esa transacción (`FOR UPDATE`), nunca del cuerpo de la petición (AC6).
// RN-02 — `tramite_digital` exige un tipo del catálogo cerrado (MATRICULA | TRASPASO | OTROS); un tipo
//         desconocido no cae a «OTROS» ni a una genérica: es «no configurado» al resolver y 400 al fijar.
// RN-03 — `logistica` lleva SIEMPRE tipo NULL: un solo valor por compañía.
// RN-04 — No existe eliminar ni desactivar; «dejar de cobrar» es cerrar sin abrir.
//
// `tarifaDe()` conserva su firma y resuelve «vigente ahora» (`vigente_hasta IS NULL`); la resolución
// por fecha de aprobación es el eslabón 2 (HU #12374).

import { and, asc, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  CONCEPTOS_TARIFA, LLAVES_TARIFA, tipoTramiteTarifaDe, valorTarifaValido,
  type ConceptoTarifa, type TipoTramiteTarifa,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoTarifasVigencias, users } from '../../db/schema.js';
import { createdInRangeCondition, type FechaRango } from '../../shared/utils/fecha-rango.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Error de negocio (400). Las subclases afinan el código HTTP en la ruta. */
export class TarifaError extends Error {}
/** La vigencia o la compañía pedida no existe (404). */
export class TarifaNoEncontradaError extends TarifaError {}
/** Alguien se adelantó: la llave ya tiene vigencia abierta o la pedida ya está cerrada (409). */
export class TarifaConflictoError extends TarifaError {
  constructor(message: string, public readonly vigenciaId: string | null = null) { super(message); }
}
/** Cero es un precio válido, pero solo a propósito (AC10). */
export class TarifaCeroSinConfirmarError extends TarifaError {
  constructor() { super('Un valor de cero significa cobrar $0. Confirme con confirmarCero: true'); }
}

const v = flitoTarifasVigencias;

/** La vigencia en la forma que la ventana de Clientes ya entiende (AC17). `id` es el de la vigencia. */
export interface Tarifa {
  id: string;
  companiaId: number;
  companiaNombre: string | null;
  concepto: ConceptoTarifa;
  /** null solo en logística. */
  tipoTramite: string | null;
  valor: number;
  /** true = vigencia abierta. Una cerrada solo se ve como respuesta de «dejar de cobrar». */
  activo: boolean;
  actualizadoEn: string;
  vigenteDesde: string;
}

/**
 * Valor de un concepto para un trámite concreto.
 *
 * `valor: null` significa **«No configurado»**, no «gratis». La distinción es el punto entero del
 * requerimiento §2.1: un concepto sin tarifa debe verse como tal en reportes y vistas operativas,
 * y nunca sumar un cero silencioso que haría cuadrar un total falso.
 */
export interface ValorTarifa {
  valor: number | null;
  /** De dónde salió: `especifica` (trámite digital por tipo), `generica` (logística), o ninguna. */
  origen: 'especifica' | 'generica' | 'no_configurada';
}

export const NO_CONFIGURADA: ValorTarifa = { valor: null, origen: 'no_configurada' };

/** La condición de llave (concepto + tipo) sobre la tabla; NULL se compara con IS NULL. */
function llave(concepto: ConceptoTarifa, tipo: TipoTramiteTarifa | null): SQL {
  return and(eq(v.concepto, concepto), tipo === null ? isNull(v.tipoTramite) : eq(v.tipoTramite, tipo))!;
}

/**
 * Resuelve la tarifa VIGENTE AHORA: la vigencia abierta de la llave exacta. Un tipo fuera del
 * catálogo (o vacío) en trámite digital es «no configurado»: falla cerrado en vez de adivinar.
 * Para logística el tipo se ignora (RN-03) y el origen sigue rotulándose `generica`, que es lo que
 * la liquidación muestra como «Tarifa genérica».
 */
export async function tarifaDe(
  companiaId: number | null, concepto: ConceptoTarifa, tipoTramite: string | null,
): Promise<ValorTarifa> {
  if (companiaId === null) return NO_CONFIGURADA;
  const tipo = concepto === 'logistica' ? null : tipoTramiteTarifaDe(tipoTramite);
  if (concepto === 'tramite_digital' && tipo === null) return NO_CONFIGURADA;

  const [abierta] = await db.select({ valor: v.valor })
    .from(v)
    .where(and(eq(v.companiaId, companiaId), llave(concepto, tipo), isNull(v.vigenteHasta)))
    .limit(1);
  if (!abierta) return NO_CONFIGURADA;
  return { valor: Number(abierta.valor), origen: concepto === 'logistica' ? 'generica' : 'especifica' };
}

const COLUMNAS_TARIFA = {
  id: v.id, companiaId: v.companiaId, companiaNombre: clients.name, concepto: v.concepto,
  tipoTramite: v.tipoTramite, valor: v.valor, vigenteDesde: v.vigenteDesde, vigenteHasta: v.vigenteHasta,
  fijadoEn: v.fijadoEn,
};

type FilaTarifa = {
  id: string; companiaId: number; companiaNombre: string | null; concepto: string; tipoTramite: string | null;
  valor: string; vigenteDesde: Date; vigenteHasta: Date | null; fijadoEn: Date;
};

function aTarifa(f: FilaTarifa): Tarifa {
  return {
    id: f.id, companiaId: f.companiaId, companiaNombre: f.companiaNombre,
    concepto: f.concepto as ConceptoTarifa, tipoTramite: f.tipoTramite,
    valor: Number(f.valor), activo: f.vigenteHasta === null,
    actualizadoEn: f.fijadoEn.toISOString(), vigenteDesde: f.vigenteDesde.toISOString(),
  };
}

/** Las vigencias ABIERTAS, con el nombre de su compañía. Orden estable para la ventana de Clientes. */
export async function listarTarifas(companiaId?: number): Promise<Tarifa[]> {
  const filas = await db.select(COLUMNAS_TARIFA).from(v)
    .leftJoin(clients, eq(v.companiaId, clients.id))
    .where(and(isNull(v.vigenteHasta), companiaId ? eq(v.companiaId, companiaId) : undefined))
    .orderBy(asc(clients.name), asc(v.concepto), asc(v.tipoTramite));
  return filas.map(aTarifa);
}

async function leerTarifa(id: string): Promise<Tarifa> {
  const [fila] = await db.select(COLUMNAS_TARIFA).from(v)
    .leftJoin(clients, eq(v.companiaId, clients.id))
    .where(eq(v.id, id)).limit(1);
  if (!fila) throw new TarifaNoEncontradaError('La tarifa no existe');
  return aTarifa(fila);
}

// ───────────────────────────── Vista por cliente (CF-03..05) ─────────────────────────────

export interface UsuarioRef { id: number; nombre: string | null }

export interface FilaVistaTarifa {
  concepto: ConceptoTarifa;
  tipoTramite: TipoTramiteTarifa | null;
  vigenciaId: string | null;
  /** null = «no configurado». Nunca 0 por defecto. */
  valor: number | null;
  vigenteDesde: string | null;
  fijadoPor: UsuarioRef | null;
  /** Solo en la fila de logística: true cuando FLIT la gestiona (la compañía NO la autogestiona). */
  flitoGestionaLogistica?: boolean;
}

export interface VistaTarifasCompania {
  companiaId: number;
  companiaNombre: string;
  tarifas: FilaVistaTarifa[];
}

async function companiaDe(companiaId: number) {
  const [c] = await db.select({ id: clients.id, name: clients.name, logisticaAutogestionable: clients.logisticaAutogestionable })
    .from(clients).where(eq(clients.id, companiaId)).limit(1);
  if (!c) throw new TarifaNoEncontradaError('La compañía no existe');
  return c;
}

/** Las cuatro filas fijas de `LLAVES_TARIFA`, en ese orden, con la vigencia abierta de cada una si la hay. */
export async function vistaPorCompania(companiaId: number): Promise<VistaTarifasCompania> {
  const c = await companiaDe(companiaId);
  const abiertas = await db.select({
    id: v.id, concepto: v.concepto, tipoTramite: v.tipoTramite, valor: v.valor, vigenteDesde: v.vigenteDesde,
    fijadoPorId: v.fijadoPorId, fijadoPorNombre: users.name,
  }).from(v)
    .leftJoin(users, eq(v.fijadoPorId, users.id))
    .where(and(eq(v.companiaId, companiaId), isNull(v.vigenteHasta)));

  const tarifas = LLAVES_TARIFA.map((k): FilaVistaTarifa => {
    const a = abiertas.find((f) => f.concepto === k.concepto && (f.tipoTramite ?? null) === k.tipoTramite);
    const fila: FilaVistaTarifa = {
      concepto: k.concepto, tipoTramite: k.tipoTramite,
      vigenciaId: a?.id ?? null, valor: a ? Number(a.valor) : null,
      vigenteDesde: a ? a.vigenteDesde.toISOString() : null,
      fijadoPor: a?.fijadoPorId != null ? { id: a.fijadoPorId, nombre: a.fijadoPorNombre ?? null } : null,
    };
    if (k.concepto === 'logistica') fila.flitoGestionaLogistica = !c.logisticaAutogestionable;
    return fila;
  });
  return { companiaId: c.id, companiaNombre: c.name, tarifas };
}

// ───────────────────────────── Historial (CF-13, CF-14) ─────────────────────────────

export interface VigenciaHistorial {
  id: string;
  concepto: ConceptoTarifa;
  tipoTramite: TipoTramiteTarifa | null;
  valor: number;
  vigenteDesde: string;
  vigenteHasta: string | null;
  fijadoPor: UsuarioRef | null;
  fijadoEn: string;
  cerradoPor: UsuarioRef | null;
  cerradoEn: string | null;
}

export interface FiltrosHistorial {
  concepto?: ConceptoTarifa;
  /** Ya normalizado; para logística se ignora. */
  tipoTramite?: TipoTramiteTarifa | null;
  /** Días calendario de Colombia: vigencias ABIERTAS (`vigente_desde`) dentro del rango (AC14). */
  rango?: FechaRango;
}

const fijador = alias(users, 'fijador');
const cerrador = alias(users, 'cerrador');

/** Del más reciente al más antiguo dentro de cada llave; las llaves en el orden de la vista. */
export async function historial(companiaId: number, f: FiltrosHistorial = {}): Promise<VigenciaHistorial[]> {
  await companiaDe(companiaId);
  const condiciones: (SQL | undefined)[] = [eq(v.companiaId, companiaId)];
  if (f.concepto) {
    condiciones.push(f.concepto === 'logistica' || f.tipoTramite === undefined
      ? eq(v.concepto, f.concepto) : llave(f.concepto, f.tipoTramite));
  }
  if (f.rango) condiciones.push(createdInRangeCondition(v.vigenteDesde, f.rango) ?? undefined);

  const filas = await db.select({
    id: v.id, concepto: v.concepto, tipoTramite: v.tipoTramite, valor: v.valor,
    vigenteDesde: v.vigenteDesde, vigenteHasta: v.vigenteHasta,
    fijadoPorId: v.fijadoPorId, fijadoPorNombre: fijador.name, fijadoEn: v.fijadoEn,
    cerradoPorId: v.cerradoPorId, cerradoPorNombre: cerrador.name, cerradoEn: v.cerradoEn,
  }).from(v)
    .leftJoin(fijador, eq(v.fijadoPorId, fijador.id))
    .leftJoin(cerrador, eq(v.cerradoPorId, cerrador.id))
    .where(and(...condiciones))
    .orderBy(asc(v.concepto), asc(v.tipoTramite), desc(v.vigenteDesde));

  return filas.map((r) => ({
    id: r.id, concepto: r.concepto as ConceptoTarifa, tipoTramite: (r.tipoTramite ?? null) as TipoTramiteTarifa | null,
    valor: Number(r.valor), vigenteDesde: r.vigenteDesde.toISOString(),
    vigenteHasta: r.vigenteHasta ? r.vigenteHasta.toISOString() : null,
    fijadoPor: r.fijadoPorId != null ? { id: r.fijadoPorId, nombre: r.fijadoPorNombre ?? null } : null,
    fijadoEn: r.fijadoEn.toISOString(),
    cerradoPor: r.cerradoPorId != null ? { id: r.cerradoPorId, nombre: r.cerradoPorNombre ?? null } : null,
    cerradoEn: r.cerradoEn ? r.cerradoEn.toISOString() : null,
  }));
}

// ───────────────────────────── Escrituras (CF-07..11) ─────────────────────────────

export interface DatosFijar {
  companiaId: number;
  concepto: ConceptoTarifa;
  tipoTramite?: string | null;
  valor: number;
  confirmarCero?: boolean;
}

function validarValor(valor: unknown): asserts valor is number {
  if (!valorTarifaValido(valor)) {
    throw new TarifaError('El valor debe ser un número mayor o igual a cero, con a lo sumo dos decimales');
  }
}

/** La llave que se va a escribir, o el error que explica por qué no (RN-02, RN-03). */
export function tipoDeLlave(concepto: ConceptoTarifa, tipoTramite: string | null | undefined): TipoTramiteTarifa | null {
  if (!CONCEPTOS_TARIFA.includes(concepto)) throw new TarifaError('Concepto de tarifa desconocido');
  const vacio = (tipoTramite ?? '').trim() === '';
  if (concepto === 'logistica') {
    if (!vacio) throw new TarifaError('La logística tiene un solo valor por compañía; no lleva tipo');
    return null;
  }
  const tipo = tipoTramiteTarifaDe(tipoTramite);
  if (tipo === null) throw new TarifaError('El tipo de trámite debe ser Matricula, Traspaso u Otros');
  return tipo;
}

const esChoqueDeLlave = (e: unknown): boolean => {
  const code = (e as { code?: string }).code;
  return code === '23505' || code === '23P01';
};

/**
 * FIJAR: abre la PRIMERA vigencia de una llave que no tiene ninguna abierta. Si ya la tiene, 409 con
 * el id de la abierta: se cambia con `cambiarOCerrar`, no se crea otra (lo impide el índice parcial).
 */
export async function fijarTarifa(d: DatosFijar, usuarioId: number | null): Promise<Tarifa> {
  validarValor(d.valor);
  const tipo = tipoDeLlave(d.concepto, d.tipoTramite);
  if (d.valor === 0 && !d.confirmarCero) throw new TarifaCeroSinConfirmarError();
  await companiaDe(d.companiaId).catch(() => { throw new TarifaError('La compañía no existe'); });

  const ahora = new Date();
  try {
    const [fila] = await db.insert(v).values({
      companiaId: d.companiaId, concepto: d.concepto, tipoTramite: tipo, valor: String(d.valor),
      vigenteDesde: ahora, fijadoPorId: usuarioId, fijadoEn: ahora,
    }).returning({ id: v.id });
    return await leerTarifa(fila.id);
  } catch (e) {
    if (!esChoqueDeLlave(e)) throw e;
    const [abierta] = await db.select({ id: v.id }).from(v)
      .where(and(eq(v.companiaId, d.companiaId), llave(d.concepto, tipo), isNull(v.vigenteHasta))).limit(1);
    throw new TarifaConflictoError('Ya hay un valor vigente para esa tarifa. Cámbielo con Editar.', abierta?.id ?? null);
  }
}

export interface CambiosTarifa {
  valor?: number;
  /** `false` = dejar de cobrar (lo que la ventana de Clientes manda al desmarcar «Activa»). */
  activo?: boolean;
  /** Alias explícito de `activo: false`. */
  cerrar?: boolean;
  confirmarCero?: boolean;
}

export interface ResultadoCambio {
  /** La vigencia NUEVA si se cambió, la CERRADA si se dejó de cobrar, la misma si no hubo cambio. */
  tarifa: Tarifa;
  accion: 'cambiada' | 'cerrada' | 'sin_cambio';
  /** El valor que estaba vigente al guardar, leído en la transacción (AC6). */
  valorAnterior: number;
  valorNuevo: number | null;
}

interface Abierta { id: string; companiaId: number; concepto: string; tipoTramite: string | null; valor: string; vigenteHasta: Date | null }

/** Bloquea la vigencia `id`; si no existe → 404; si ya está cerrada → 409 con la abierta de su llave. */
async function bloquearAbierta(tx: Tx, id: string): Promise<Abierta> {
  const [fila] = await tx.select({
    id: v.id, companiaId: v.companiaId, concepto: v.concepto, tipoTramite: v.tipoTramite,
    valor: v.valor, vigenteHasta: v.vigenteHasta,
  }).from(v).where(eq(v.id, id)).for('update');
  if (!fila) throw new TarifaNoEncontradaError('La tarifa no existe');
  if (fila.vigenteHasta !== null) {
    const [viva] = await tx.select({ id: v.id }).from(v)
      .where(and(eq(v.companiaId, fila.companiaId), llave(fila.concepto as ConceptoTarifa, fila.tipoTramite as TipoTramiteTarifa | null), isNull(v.vigenteHasta)))
      .limit(1);
    throw new TarifaConflictoError('Esa vigencia ya está cerrada; recargue la pantalla', viva?.id ?? null);
  }
  return fila;
}

/**
 * CAMBIAR o DEJAR DE COBRAR sobre la vigencia abierta `id`, en una sola transacción (RN-01):
 *   · `activo:false` / `cerrar:true` → cierra sin abrir (gana sobre `valor` si vienen los dos);
 *   · `valor` igual al vigente → no-op (la ventana de Clientes siempre manda `valor` al guardar);
 *   · `valor` distinto → cierra la abierta y abre la nueva con el MISMO `ahora`.
 * Un `FOR UPDATE` serializa dos cambios concurrentes: el segundo relee la fila ya cerrada y recibe 409.
 */
export async function cambiarOCerrar(id: string, cambios: CambiosTarifa, usuarioId: number | null): Promise<ResultadoCambio> {
  if (cambios.valor !== undefined) validarValor(cambios.valor);
  const cerrar = cambios.activo === false || cambios.cerrar === true;

  let r: { id: string; accion: ResultadoCambio['accion']; valorAnterior: number; valorNuevo: number | null };
  try {
    r = await db.transaction(async (tx) => {
      const abierta = await bloquearAbierta(tx, id);
      const valorAnterior = Number(abierta.valor);
      const ahora = new Date();
      const cierre = { vigenteHasta: ahora, cerradoPorId: usuarioId, cerradoEn: ahora };

      if (cerrar) {
        await tx.update(v).set(cierre).where(eq(v.id, abierta.id));
        return { id: abierta.id, accion: 'cerrada' as const, valorAnterior, valorNuevo: null };
      }
      if (cambios.valor === undefined || cambios.valor === valorAnterior) {
        return { id: abierta.id, accion: 'sin_cambio' as const, valorAnterior, valorNuevo: valorAnterior };
      }
      if (cambios.valor === 0 && !cambios.confirmarCero) throw new TarifaCeroSinConfirmarError();

      await tx.update(v).set(cierre).where(eq(v.id, abierta.id));
      const [nueva] = await tx.insert(v).values({
        companiaId: abierta.companiaId, concepto: abierta.concepto, tipoTramite: abierta.tipoTramite,
        valor: String(cambios.valor), vigenteDesde: ahora, fijadoPorId: usuarioId, fijadoEn: ahora,
      }).returning({ id: v.id });
      return { id: nueva.id, accion: 'cambiada' as const, valorAnterior, valorNuevo: cambios.valor };
    });
  } catch (e) {
    if (esChoqueDeLlave(e)) throw new TarifaConflictoError('Otro usuario cambió esta tarifa; recargue');
    throw e;
  }
  return { tarifa: await leerTarifa(r.id), accion: r.accion, valorAnterior: r.valorAnterior, valorNuevo: r.valorNuevo };
}
