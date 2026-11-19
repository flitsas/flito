// Torre de Control (Épica #14590, ADR-0047, spec UX §5.2) — la URL del Detalle universal: SOLO datos opacos.
//
//   ?c=<conjunto>                 conjunto del catálogo (`CONJUNTOS_TORRE`)
//   ?m=<métrica>&fb=<fecha base>  métrica del Explorador
//   &s=<dim>:<v1>,<v2>;<dim2>:<v> segmentos (≤ 2, ≤ 10 valores); `~` = «Sin …» (null)
//   &o=<origen>                   de dónde se llegó («Volver a <área>»)
//   &p=mes                        periodo fijo del origen (el 360° siempre mira el mes en curso)
//
// La placa NUNCA va aquí (AGENTS §14): el filtro de placa vive en el estado del componente y viaja en el body del POST.
// Lo que se lee se valida contra el catálogo: un `?c=` desconocido o manipulado da «conjunto inválido», no una consulta.
import {
  CONJUNTOS_TORRE_IDS, DETALLE_METRICA_TORRE, DIMENSIONES_SEGMENTO_TORRE, FECHAS_BASE_TORRE, TOPES_TORRE,
  type ConjuntoTorreId, type DestinoCifra, type DimensionSegmentoTorre, type FechaBaseTorre, type MetricaTorreId,
  type OrigenDetalle, type SegmentoDetalle,
} from '@operaciones/shared-types';
import type { PageSlug } from './permissions';

export const RUTA_DETALLE_TORRE = '/flito/torre/detalle';

/** Pantallas desde las que se abre un detalle (para «Volver a <área>»). */
export const ORIGENES_DETALLE = {
  '360': { etiqueta: 'Resumen 360°', to: '/flito/torre/resumen', slug: 'torre_360' },
  comercial: { etiqueta: 'Comercial', to: '/flito/torre/comercial', slug: 'torre_comercial' },
  operativa: { etiqueta: 'Operativa', to: '/flito/torre/operativa', slug: 'torre_operativa' },
  financiera: { etiqueta: 'Financiera', to: '/flito/torre/financiera', slug: 'torre_financiera' },
  productos: { etiqueta: 'Productos', to: '/flito/torre/productos', slug: 'torre_productos' },
  explorador: { etiqueta: 'Explorador', to: '/flito/torre/explorador', slug: 'torre_explorador' },
} as const satisfies Record<string, { etiqueta: string; to: string; slug: PageSlug }>;
export type OrigenPantallaTorre = keyof typeof ORIGENES_DETALLE;

/**
 * Subvistas (`?vista=`) a las que vuelve «Volver a <área>» (spec UX §6.1). Solo las que existen: «Resumen» es la
 * vista por defecto y no viaja. `&ov=<vista>` en la URL del detalle; un valor desconocido se ignora.
 */
export const VISTAS_ORIGEN = {
  operativa: { inventario: 'Inventario por estado', soportes: 'Soportes' },
  // Productos (B3): «SOAT» es la pestaña por defecto y no viaja.
  productos: { impuestos: 'Impuestos', derechos: 'Derechos' },
} as const satisfies Partial<Record<OrigenPantallaTorre, Record<string, string>>>;
export type VistaOrigenTorre = keyof (typeof VISTAS_ORIGEN)['operativa'];
export type VistaProductosTorre = keyof (typeof VISTAS_ORIGEN)['productos'];

/** Etiqueta de la subvista de un origen, o `null` si ese origen no la tiene. */
export function etiquetaVistaOrigen(origen: OrigenPantallaTorre, vista: string | null): string | null {
  if (!vista) return null;
  const vistas = (VISTAS_ORIGEN as Partial<Record<OrigenPantallaTorre, Record<string, string>>>)[origen];
  return vistas && Object.prototype.hasOwnProperty.call(vistas, vista) ? vistas[vista] : null;
}

/** Ruta de vuelta a un origen, con su subvista si la tiene. */
export function rutaVolver(origen: OrigenPantallaTorre, vista: string | null): string {
  const base = ORIGENES_DETALLE[origen].to;
  return etiquetaVistaOrigen(origen, vista) ? `${base}?vista=${vista}` : base;
}

export interface DetalleEnUrl {
  origen: OrigenDetalle;
  segmentos: SegmentoDetalle[];
  volver: OrigenPantallaTorre | null;
  /** Subvista del origen a la que vuelve (`VISTAS_ORIGEN`); `null` = su vista por defecto. */
  vistaVolver: string | null;
  /** El origen fija el periodo (360°: «Este mes»), sin tocar el filtro guardado de la Torre. */
  periodoFijo: 'mes' | null;
}

const NULO = '~';
/** Claves de agrupación: ids numéricos, códigos DIVIPOLA/DANE, claves de estado, meses (`2026-10`) o niveles. */
const VALOR_OPACO = /^[A-Za-z0-9_.:-]{1,40}$/;
/**
 * El `motivo` (B3, RN-TOR-P4 del API) es texto del catálogo de motivos, no un dato del titular: ≤ 40 caracteres, sin
 * espacios al borde, con tildes y espacios dentro. Viaja con `encodeURIComponent` para que una coma o un `;` del motivo
 * no partan el segmento. Se rechazan los caracteres de control.
 */
const DIM_TEXTO = 'motivo';
const VALOR_TEXTO = /^[^\s\p{C}](?:[^\p{C}]{0,38}[^\s\p{C}])?$/u;
const codificarValor = (dim: string, v: string) => (dim === DIM_TEXTO ? encodeURIComponent(v) : v);
function decodificarValor(dim: string, v: string): string | null {
  if (dim !== DIM_TEXTO) return VALOR_OPACO.test(v) ? v : null;
  try {
    const d = decodeURIComponent(v);
    return VALOR_TEXTO.test(d) ? d : null;
  } catch { return null; }
}

const esConjunto = (v: string): v is ConjuntoTorreId => (CONJUNTOS_TORRE_IDS as readonly string[]).includes(v);
const esMetrica = (v: string): v is MetricaTorreId => Object.prototype.hasOwnProperty.call(DETALLE_METRICA_TORRE, v);
const esDimension = (v: string): v is DimensionSegmentoTorre => (DIMENSIONES_SEGMENTO_TORRE as readonly string[]).includes(v);
const esFechaBase = (v: string): v is FechaBaseTorre => (FECHAS_BASE_TORRE as readonly string[]).includes(v);
const esOrigen = (v: string): v is OrigenPantallaTorre => Object.prototype.hasOwnProperty.call(ORIGENES_DETALLE, v);

function segmentosATexto(segmentos: readonly SegmentoDetalle[]): string {
  return segmentos.map((s) => `${s.dimension}:${s.valores.map((v) => (v === null ? NULO : codificarValor(s.dimension, v))).join(',')}`).join(';');
}

/** `null` si el texto no es un segmento válido (la página lo trata como conjunto inválido). */
function textoASegmentos(texto: string): SegmentoDetalle[] | null {
  const partes = texto.split(';');
  if (partes.length > TOPES_TORRE.SEGMENTOS_MAX) return null;
  const out: SegmentoDetalle[] = [];
  for (const p of partes) {
    const i = p.indexOf(':');
    if (i <= 0) return null;
    const dim = p.slice(0, i);
    const valores = p.slice(i + 1).split(',');
    if (!esDimension(dim) || valores.length === 0 || valores.length > TOPES_TORRE.VALORES_SEGMENTO_MAX) return null;
    const leidos = valores.map((v) => (v === NULO ? null : decodificarValor(dim, v)));
    if (leidos.some((v, j) => v === null && valores[j] !== NULO)) return null;
    out.push({ dimension: dim, valores: leidos });
  }
  return out;
}

/** Ruta del detalle para un origen y sus segmentos. */
export function rutaDetalle(origen: OrigenDetalle, segmentos: readonly SegmentoDetalle[] = [], opciones: {
  volver?: OrigenPantallaTorre; vista?: string; periodoFijo?: 'mes';
} = {}): string {
  const q = new URLSearchParams();
  if (origen.tipo === 'conjunto') q.set('c', origen.conjunto);
  else {
    q.set('m', origen.metrica);
    if (origen.fechaBase) q.set('fb', origen.fechaBase);
  }
  if (segmentos.length) q.set('s', segmentosATexto(segmentos));
  if (opciones.volver) q.set('o', opciones.volver);
  if (opciones.volver && opciones.vista && etiquetaVistaOrigen(opciones.volver, opciones.vista)) q.set('ov', opciones.vista);
  if (opciones.periodoFijo) q.set('p', opciones.periodoFijo);
  return `${RUTA_DETALLE_TORRE}?${q.toString()}`;
}

/** Ruta de un `DestinoCifra` del API; `null` si no lleva a un conjunto (bloque o ninguno). */
export function rutaDestino(destino: DestinoCifra | undefined, opciones: {
  volver?: OrigenPantallaTorre; vista?: string; periodoFijo?: 'mes';
} = {}): string | null {
  if (!destino || destino.tipo !== 'conjunto') return null;
  return rutaDetalle(destino.origen, destino.segmentos ?? [], opciones);
}

/** Lee la URL del detalle. `null` = conjunto/métrica desconocida o parámetros manipulados. */
export function leerDetalleUrl(q: URLSearchParams): DetalleEnUrl | null {
  const c = q.get('c');
  const m = q.get('m');
  let origen: OrigenDetalle;
  if (c && !m) {
    if (!esConjunto(c)) return null;
    origen = { tipo: 'conjunto', conjunto: c };
  } else if (m && !c) {
    if (!esMetrica(m)) return null;
    const fb = q.get('fb');
    if (fb !== null && !esFechaBase(fb)) return null;
    origen = { tipo: 'metrica', metrica: m, ...(fb ? { fechaBase: fb } : {}) };
  } else return null;
  const s = q.get('s');
  const segmentos = s ? textoASegmentos(s) : [];
  if (!segmentos) return null;
  const o = q.get('o');
  const volver = o && esOrigen(o) ? o : null;
  const ov = q.get('ov');
  return {
    origen, segmentos, volver, vistaVolver: volver && etiquetaVistaOrigen(volver, ov) ? ov : null, periodoFijo: q.get('p') === 'mes' ? 'mes' : null,
  };
}

/** Clave de grupo del Explorador que significa «Sin …» (la API la manda así cuando el valor es null). */
const CLAVE_SIN_DATO = 'sin';

/**
 * «Ver registros» del Explorador (spec §8, AC12): la métrica con su fecha base y la clave de cada agrupación como
 * segmento (fila, o fila × columna en la tabla cruzada). La celda «Otros» no se puede expresar: no tiene enlace.
 */
export function rutaRegistrosMetrica(metrica: MetricaTorreId, fechaBase: FechaBaseTorre | null,
  claves: readonly (readonly [DimensionSegmentoTorre, string])[]): string {
  return rutaDetalle(
    { tipo: 'metrica', metrica, ...(fechaBase ? { fechaBase } : {}) },
    claves.map(([dimension, clave]) => ({ dimension, valores: [clave === CLAVE_SIN_DATO ? null : clave] })),
    { volver: 'explorador' },
  );
}
