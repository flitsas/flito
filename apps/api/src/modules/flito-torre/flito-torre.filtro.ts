// Torre de Control Gerencial (Épica #14590, ADR-0043 D1/D4/D5, checklist §2-3) — el ÚNICO constructor de condiciones.
//
// RN-TOR-F1: ninguna métrica ni tablero arma su `WHERE` por fuera de `condicionesTorre()`. Exige `AlcanceResuelto`
//   (no hay sobrecarga sin él) y aplica `condicionPorCompania` sobre la columna de compañía de la tabla base.
// RN-TOR-F2: los rangos son días calendario de Bogotá (`TZ_COLOMBIA`) y se aplican como `[desde, hasta+1)`.
// RN-TOR-F3: topes del ADR — 24 meses de rango; 366 días si se agrupa por día. Más → `RangoTorreExcedidoError` (400).
// RN-TOR-F5: el preset `ultimos_6m` lo resuelve la API (`resolverRango`), alineado al mes, con el `hoy` de Bogotá.
// RN-TOR-F4: el departamento es `substr(organismo_codigo, 1, 2)` acotado a `DEPARTAMENTO_POR_CODIGO`; un código nulo
//   o con prefijo desconocido cae en «Sin secretaría». Una compañía nula cae en «Sin compañía».
// Todo valor del cliente viaja como parámetro de `sql` (un arreglo se expande a `($1, $2…)`: solo se usa tras comprobar
// que no está vacío); los identificadores son columnas Drizzle fijas.
import { inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  DEPARTAMENTO_POR_CODIGO, TOPES_TORRE, type AgrupacionTorre, type FiltroTorre, type RangoTorre,
} from '@operaciones/shared-types';
import { condicionPorCompania } from '../../shared/alcance-filas.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { hoyColombia, TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import { ErrorDominioTorre } from './flito-torre.service.js';

export class RangoTorreExcedidoError extends ErrorDominioTorre {
  readonly code = 'RANGO_EXCEDIDO';
  constructor(mensaje: string) { super(mensaje); }
}

export interface RangoResuelto { desde: string; hasta: string }

const CODIGOS_DEPARTAMENTO = Object.keys(DEPARTAMENTO_POR_CODIGO);

// ── Fechas puras (YYYY-MM-DD, sin zona: el día civil ya es de Bogotá) ─────────────────────────────────────

const aFecha = (s: string): Date => new Date(`${s}T00:00:00Z`);
const aTexto = (d: Date): string => d.toISOString().slice(0, 10);

export function sumarDias(s: string, dias: number): string {
  const d = aFecha(s); d.setUTCDate(d.getUTCDate() + dias); return aTexto(d);
}

/** Días calendario entre `desde` y `hasta`, ambos inclusive. */
export const diasDeRango = (r: RangoResuelto): number =>
  Math.round((aFecha(r.hasta).getTime() - aFecha(r.desde).getTime()) / 86_400_000) + 1;

const primeroDeMes = (s: string): string => `${s.slice(0, 7)}-01`;

export function mesAnterior(s: string): RangoResuelto {
  const finAnterior = sumarDias(primeroDeMes(s), -1);
  return { desde: primeroDeMes(finAnterior), hasta: finAnterior };
}

/** Preset o rango explícito → días de Bogotá. `hoy` se inyecta para los tests. */
export function resolverRango(rango: RangoTorre, hoy: string = hoyColombia()): RangoResuelto {
  if ('desde' in rango) return { desde: rango.desde, hasta: rango.hasta };
  switch (rango.preset) {
    case 'hoy': return { desde: hoy, hasta: hoy };
    case 'ayer': { const a = sumarDias(hoy, -1); return { desde: a, hasta: a }; }
    case 'semana': { const dow = (aFecha(hoy).getUTCDay() + 6) % 7; return { desde: sumarDias(hoy, -dow), hasta: hoy }; }
    case 'mes': return { desde: primeroDeMes(hoy), hasta: hoy };
    case 'mes_anterior': return mesAnterior(hoy);
    case 'trimestre': {
      const mes = Number(hoy.slice(5, 7));
      const inicio = `${hoy.slice(0, 4)}-${String(Math.floor((mes - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
      return { desde: inicio, hasta: hoy };
    }
    case 'anio': return { desde: `${hoy.slice(0, 4)}-01-01`, hasta: hoy };
    case 'ultimos_6m': {
      // RN-TOR-F5 (ADR-0044 D7): alineado al mes, del día 1 del mes de hace 5 meses hasta hoy (18-nov → 1-jun).
      const meses = Number(hoy.slice(0, 4)) * 12 + (Number(hoy.slice(5, 7)) - 1) - 5;
      return { desde: `${Math.floor(meses / 12)}-${String((meses % 12) + 1).padStart(2, '0')}-01`, hasta: hoy };
    }
  }
}

/** RN-TOR-F3. Lanza `RangoTorreExcedidoError` si el rango pasa del tope. */
export function exigirTopesRango(r: RangoResuelto, agrupacion?: AgrupacionTorre): void {
  const limite = aFecha(r.desde);
  limite.setUTCMonth(limite.getUTCMonth() + TOPES_TORRE.MESES_RANGO_MAX);
  if (aFecha(r.hasta).getTime() >= limite.getTime()) {
    throw new RangoTorreExcedidoError(`El periodo no puede pasar de ${TOPES_TORRE.MESES_RANGO_MAX} meses.`);
  }
  if (agrupacion === 'dia' && diasDeRango(r) > TOPES_TORRE.DIAS_RANGO_MAX_POR_DIA) {
    throw new RangoTorreExcedidoError(`Para agrupar por día el periodo no puede pasar de ${TOPES_TORRE.DIAS_RANGO_MAX_POR_DIA} días.`);
  }
}

// ── SQL de fechas ────────────────────────────────────────────────────────────────────────────────────────

/** Columna de fecha de una métrica: `timestamptz`, o `date` (p. ej. `fecha_pago` de derechos). */
export interface FechaBase { expr: SQL | AnyColumn; esDate?: boolean }

/** `[desde 00:00, hasta+1 00:00)` en Bogotá (RN-TOR-F2). */
export function condicionRango(f: FechaBase, r: RangoResuelto): SQL {
  if (f.esDate) return sql`(${f.expr} >= ${r.desde}::date AND ${f.expr} < (${r.hasta}::date + 1))`;
  return sql`(${f.expr} >= (${r.desde}::date AT TIME ZONE ${TZ_COLOMBIA})
    AND ${f.expr} < ((${r.hasta}::date + 1) AT TIME ZONE ${TZ_COLOMBIA}))`;
}

/** La fecha como `timestamp` local de Bogotá (para `date_trunc`). */
export function fechaLocal(f: FechaBase): SQL {
  return f.esDate ? sql`(${f.expr})::timestamp` : sql`(${f.expr} AT TIME ZONE ${TZ_COLOMBIA})`;
}

// ── Dimensiones y condiciones ───────────────────────────────────────────────────────────────────────────

/** Columnas de la tabla base de una métrica (las de trámite pueden venir de un JOIN). */
export interface DimensionesBase {
  compania: AnyColumn;
  organismo: AnyColumn;
  tipoTramite: AnyColumn;
  flitEstado: AnyColumn;
}

export interface OpcionesCondiciones {
  /** `null` = la métrica (o el bloque) no se acota por rango. */
  rango: RangoResuelto | null;
  fecha?: FechaBase;
  /** Bloques que ignoran un filtro de la barra (p. ej. la fuga ignora el rango). */
  ignorar?: readonly (keyof FiltroTorre)[];
}

const enLista = (col: AnyColumn, valores: readonly string[]): SQL =>
  sql`lower(${col}) IN ${valores.map((v) => v.toLowerCase())}`;

/**
 * RN-TOR-F1: el constructor único. Devuelve la lista de condiciones (AND) del filtro + el alcance + el rango.
 * `alcance` es obligatorio: no hay forma de llamarlo sin él.
 */
export function condicionesTorre(
  filtro: FiltroTorre, alcance: AlcanceResuelto, dims: DimensionesBase, op: OpcionesCondiciones,
): SQL[] {
  const ignora = (k: keyof FiltroTorre) => op.ignorar?.includes(k) ?? false;
  const conds: SQL[] = [];
  const porAlcance = condicionPorCompania(dims.compania, alcance);
  if (porAlcance) conds.push(porAlcance);
  if (op.rango && op.fecha && !ignora('rango')) conds.push(condicionRango(op.fecha, op.rango));
  if (filtro.companiaIds?.length && !ignora('companiaIds')) conds.push(inArray(dims.compania, filtro.companiaIds));
  if (filtro.organismos?.length && !ignora('organismos')) conds.push(inArray(dims.organismo, filtro.organismos));
  if (filtro.departamentos?.length && !ignora('departamentos')) {
    conds.push(sql`substr(${dims.organismo}, 1, 2) IN ${filtro.departamentos}`);
  }
  if (filtro.tiposTramite?.length && !ignora('tiposTramite')) conds.push(enLista(dims.tipoTramite, filtro.tiposTramite));
  if (filtro.flitEstados?.length && !ignora('flitEstados')) conds.push(enLista(dims.flitEstado, filtro.flitEstados));
  return conds;
}

/**
 * RN-TOR-F1 para tablas que solo tienen compañía (bolsas): alcance + `companiaIds`. Los demás filtros de la barra no
 * aplican y el bloque los declara en `filtrosIgnorados`.
 */
export function condicionesCompania(filtro: FiltroTorre, alcance: AlcanceResuelto, compania: AnyColumn): SQL[] {
  const conds: SQL[] = [];
  const porAlcance = condicionPorCompania(compania, alcance);
  if (porAlcance) conds.push(porAlcance);
  if (filtro.companiaIds?.length) conds.push(inArray(compania, filtro.companiaIds));
  return conds;
}

/** `WHERE` listo: `true` si no hay condiciones. */
export function donde(conds: readonly SQL[]): SQL {
  return conds.length ? sql.join(conds.map((c) => sql`(${c})`), sql` AND `) : sql`true`;
}

/** Clave de grupo (texto). `null` = «Sin compañía» / «Sin secretaría» / «Sin tipo». */
export function claveAgrupacion(a: AgrupacionTorre, dims: DimensionesBase, fecha: FechaBase | undefined): SQL {
  const local = fecha ? fechaLocal(fecha) : sql`NULL::timestamp`;
  switch (a) {
    case 'dia': return sql`to_char(date_trunc('day', ${local}), 'YYYY-MM-DD')`;
    case 'semana': return sql`to_char(date_trunc('week', ${local}), 'YYYY-MM-DD')`;
    case 'mes': return sql`to_char(date_trunc('month', ${local}), 'YYYY-MM')`;
    case 'trimestre': return sql`to_char(date_trunc('quarter', ${local}), 'YYYY-"T"Q')`;
    case 'compania': return sql`${dims.compania}::text`;
    case 'organismo': return sql`${dims.organismo}::text`;
    case 'departamento':
      return sql`CASE WHEN substr(${dims.organismo}, 1, 2) IN ${CODIGOS_DEPARTAMENTO} THEN substr(${dims.organismo}, 1, 2) END`;
    case 'tipo_tramite': return sql`${dims.tipoTramite}::text`;
    case 'flit_estado': return sql`${dims.flitEstado}::text`;
  }
}

export const esTemporal = (a: AgrupacionTorre | undefined): boolean =>
  a === 'dia' || a === 'semana' || a === 'mes' || a === 'trimestre';
