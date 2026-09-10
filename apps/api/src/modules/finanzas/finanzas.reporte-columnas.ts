// Reporte de costos — titular, organismo de tránsito, periodo y subtotales (HU #12432, Feature #12404).
//
// Lo que Financiero copiaba a mano al Excel de 31 columnas: quién es el titular del vehículo, ante
// qué organismo se hizo el trámite, en qué mes y trimestre se aprobó, y cuánto de la fila es
// reintegro (lo que FLITO desembolsó) y cuánto es servicio (lo que FLITO cobra por hacerlo).
//
// Vive aparte de `finanzas.service.ts` por el mismo motivo que sus dos hermanos
// (`finanzas.facturacion-electronica.ts`, `finanzas.conciliacion-soat.ts`): un `SELECT_*` que se
// compone en `SELECT_FILA` y una función `*DeFila`, autocontenidos, y el archivo principal ya ronda
// las 700 líneas.
//
// ── El titular NO se clasifica aquí ──────────────────────────────────────────────────────────────
//
// La tabla «`n` = NIT = jurídica; `cc`/`ce`/`ps` = natural» tiene UNA sola copia en el repo, en
// `cola-flito-derivados.ts`, y es la que ya clasifica los Excel de SOAT e Impuestos (RN-01). Copiarla
// daría dos tablas que coinciden hoy y divergen en cuanto FLIT añada un tipo — y la divergencia no
// falla: solo hace que el mismo titular sea persona natural en un archivo y jurídica en otro.
// `bloqueTitular` además absorbe S-05 (apellidos que llegan como `' '`) y el descarte de valores no
// escalares, que son garantías que no hay que volver a ganar aquí.
//
// ── El documento: subconsulta correlacionada, NO un join ─────────────────────────────────────────
//
// El número de documento no viaja en `flit_raw`: está en `flito_compradores`, que puede tener VARIAS
// filas por trámite. Un `leftJoin` en `conJoins` multiplicaría la fila del trámite y con ella los
// totales de dinero, el `count(distinct)` de la paginación y el CSV — el mismo abanico que
// `SELECT_CONCILIACION_SOAT` explica en su cabecera. La subconsulta devuelve exactamente un valor por
// fila POR CONSTRUCCIÓN (`ORDER BY id LIMIT 1`: el primer comprador), y no toca a ninguno de los
// otros llamadores de `conJoins`.

import { sql } from 'drizzle-orm';
import { flitoCompradores, flitoTramites, organismosTransitoConfig } from '../../db/schema.js';
import {
  bloqueTitular, CLASE_ID, ciudadDeOrganismo, expresionesFlitRaw,
} from '../../shared/export/cola-flito-derivados.js';
import { celdaTexto } from '../../shared/export/cola-flito-excel.js';

/** Los cuatro tipos de documento que la tabla compartida sabe afirmar. `null` = no clasificado. */
export type TipoDocumentoTitular = (typeof CLASE_ID)[keyof typeof CLASE_ID];

const CLASES_ID: readonly string[] = Object.values(CLASE_ID);
const esTipoDocumento = (v: string | null): v is TipoDocumentoTitular => v !== null && CLASES_ID.includes(v);

/** Lo que las columnas de este archivo aportan a cada fila del reporte. */
export interface ColumnasDeFila {
  titularNombres: string | null;
  titularApellidos: string | null;
  titularRazonSocial: string | null;
  titularTipoDocumento: TipoDocumentoTitular | null;
  /** Se muestra SIEMPRE que exista, aunque el tipo no clasifique: el número no depende del tipo. */
  titularDocumento: string | null;
  organismoCodigo: string | null;
  organismoNombre: string | null;
  /** `YYYY-MM` de la fecha de aprobación, en UTC. null sin aprobar. */
  mes: string | null;
  /** `YYYY-Tn`, trimestre calendario (T1 = enero-marzo … T4 = octubre-diciembre). null sin aprobar. */
  trimestre: string | null;
}

// Las expresiones `->>` con la clave como PARÁMETRO y el `case jsonb_typeof` que descarta objetos y
// arrays: es la misma proyección que alimenta los Excel de la cola.
const raw = expresionesFlitRaw(flitoTramites.flitRaw);

/**
 * Se compone en `SELECT_FILA`. Los nombres llevan sufijo `Flit` porque son el dato CRUDO del
 * payload, todavía sin clasificar: la fila expone `titularNombres`/`titularRazonSocial` ya repartidos
 * por `columnasDeFila`, y un nombre igual en la proyección y en la fila invitaría a leer el crudo.
 */
export const SELECT_COLUMNAS_REPORTE = {
  titularTipoFlit: raw.tipo,
  titularNombresFlit: raw.nombres,
  titularApellidosFlit: raw.apellidos,
  titularDocumento: sql<string | null>`(SELECT ${flitoCompradores.numeroDocumento} FROM ${flitoCompradores}
    WHERE ${flitoCompradores.tramiteId} = ${flitoTramites.id} ORDER BY ${flitoCompradores.id} LIMIT 1)`,
  organismoCodigo: flitoTramites.organismoCodigo,
  // Solo existe `alias` en `organismos_transito_config`; el nombre se resuelve en `nombreOrganismo`.
  organismoAlias: organismosTransitoConfig.alias,
} as const;

/**
 * El nombre que se ENSEÑA de un organismo: el alias configurado manda; sin alias, la ciudad del
 * catálogo compartido; sin catálogo, el código pelado. Nunca null para un código presente: un
 * organismo que existe en la base tiene que poder elegirse en el filtro aunque nadie lo haya
 * bautizado todavía.
 *
 * Es UNA función y la usan la columna y la faceta, para que el filtro ofrezca exactamente el nombre
 * que la columna muestra.
 */
export function nombreOrganismo(codigo: string | null | undefined, alias: string | null | undefined): string | null {
  const cod = celdaTexto(codigo);
  if (cod === null) return null;
  return celdaTexto(alias) ?? ciudadDeOrganismo(cod) ?? cod;
}

/**
 * Mes y trimestre de una fecha de aprobación, en UTC.
 *
 * Getters UTC y no locales A PROPÓSITO: el proceso de la API no fija `TZ`, el filtro por aprobación
 * ya corta por día en la base, y la HU 2 agrupa en SQL con `AT TIME ZONE 'UTC'`. Con `getMonth()`,
 * un trámite aprobado el 1 de octubre a las 04:30Z saldría en septiembre en un servidor en Bogotá
 * y en octubre en uno en UTC — y el consolidado y el detalle dejarían de cuadrar (CF-13).
 */
export function periodoDe(fechaAprobacionIso: string | null): { mes: string | null; trimestre: string | null } {
  if (fechaAprobacionIso === null) return { mes: null, trimestre: null };
  const d = new Date(fechaAprobacionIso);
  if (Number.isNaN(d.getTime())) return { mes: null, trimestre: null };
  const anio = d.getUTCFullYear();
  const mes = d.getUTCMonth() + 1;
  return {
    mes: `${anio}-${String(mes).padStart(2, '0')}`,
    trimestre: `${anio}-T${Math.ceil(mes / 3)}`,
  };
}

/** Los conceptos ya resueltos de una fila, tal como los deja `aFila`. */
export interface ConceptosDeFila {
  soat: number | null; impuesto: number | null; derechoTramite: number | null;
  gmf: number | null; logistica: number | null; tramiteDigital: number | null;
  noConfigurados: string[]; sinRecibo: string[]; pendientesPago: string[];
}

/** Las etiquetas con las que `aFila` nombra cada concepto en sus listas de pendientes. */
const ETIQUETA = {
  soat: 'SOAT', impuesto: 'Impuesto', derechoTramite: 'Derecho de tránsito',
  logistica: 'Logística', tramiteDigital: 'Trámite digital',
} as const;

const redondear = (v: number): number => Math.round(v * 100) / 100;

/**
 * «Total reintegro» y «Servicio» de UNA fila (RN-02): reintegro = SOAT + impuesto + derecho de
 * tránsito + GMF + logística; servicio = trámite digital. Se calcula en JS sobre los valores que
 * `aFila` ya resolvió, no con una expresión SQL nueva: la fila ya sabe qué falta y por qué.
 *
 * Un concepto en `null` significa dos cosas distintas, y el subtotal las trata distinto:
 *   - autogestionado o «no aplica»: FLITO no lo desembolsó ni lo espera → cuenta 0.
 *   - PENDIENTE (en `pendientesPago`, `sinRecibo` o `noConfigurados`): el valor existirá y aún no
 *     está → el subtotal es `null`. Un número que cuadra sin ese sumando cuadra de mentira.
 *
 * El GMF nunca está pendiente: se calcula sobre la base. Y reintegro + servicio = total de la fila,
 * que es lo que permite a Financiero comprobar el reparto con una resta.
 */
export function subtotalesDe(f: ConceptosDeFila): { totalReintegro: number | null; totalServicio: number | null } {
  const pendientes = new Set([...f.noConfigurados, ...f.sinRecibo, ...f.pendientesPago]);
  const pendiente = (etiqueta: string): boolean => pendientes.has(etiqueta);

  const reintegroPendiente = pendiente(ETIQUETA.soat) || pendiente(ETIQUETA.impuesto)
    || pendiente(ETIQUETA.derechoTramite) || pendiente(ETIQUETA.logistica);
  const totalReintegro = reintegroPendiente
    ? null
    : redondear((f.soat ?? 0) + (f.impuesto ?? 0) + (f.derechoTramite ?? 0) + (f.gmf ?? 0) + (f.logistica ?? 0));
  const totalServicio = pendiente(ETIQUETA.tramiteDigital) ? null : redondear(f.tramiteDigital ?? 0);
  return { totalReintegro, totalServicio };
}

/**
 * Las columnas de este archivo a partir de la fila cruda del `select`. Lee las claves de
 * `SELECT_COLUMNAS_REPORTE` y la fecha de aprobación ya normalizada por `aFila`.
 */
export function columnasDeFila(r: Record<string, unknown>, fechaAprobacionIso: string | null): ColumnasDeFila {
  const titular = bloqueTitular({
    tipo: r.titularTipoFlit, nombres: r.titularNombresFlit, apellidos: r.titularApellidosFlit,
  });
  const codigo = celdaTexto(r.organismoCodigo as string | null);
  return {
    titularNombres: titular.nombrePila,
    titularApellidos: titular.apellidos,
    titularRazonSocial: titular.razonSocial,
    titularTipoDocumento: esTipoDocumento(titular.claseId) ? titular.claseId : null,
    titularDocumento: celdaTexto(r.titularDocumento as string | null),
    organismoCodigo: codigo,
    organismoNombre: nombreOrganismo(codigo, r.organismoAlias as string | null),
    ...periodoDe(fechaAprobacionIso),
  };
}

/**
 * Las entradas de la faceta de organismos: una por código PRESENTE en los trámites (el null no
 * genera entrada), con el mismo nombre que enseña la columna, ordenadas por ese nombre. El orden
 * va aquí y no en SQL porque el nombre puede venir del catálogo compilado, que la base no conoce.
 */
export function facetaOrganismos(
  filas: Array<{ codigo: string | null; alias: string | null }>,
): Array<{ valor: string; nombre: string }> {
  const vistos = new Map<string, string>();
  for (const f of filas) {
    const codigo = celdaTexto(f.codigo);
    if (codigo === null || vistos.has(codigo)) continue;
    vistos.set(codigo, nombreOrganismo(codigo, f.alias) ?? codigo);
  }
  return [...vistos.entries()]
    .map(([valor, nombre]) => ({ valor, nombre }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
