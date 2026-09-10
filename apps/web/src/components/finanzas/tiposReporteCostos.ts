// Reporte de costos — tipos y constantes que comparten la página y sus piezas (HU #12434).
//
// Están alineados al contrato del API (`FilaReporte`, `TotalesReporte`, `FacetasReporte` en
// `finanzas.service.ts` y `ConsolidadoReporte` en `finanzas.consolidado.ts`). La pantalla NO
// calcula nada con ellos: reintegro, servicio, mes, trimestre y el consolidado llegan hechos.

import type { SiigoEstadoReporte } from '@operaciones/shared-types';

export interface Fila {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  vin: string | null; marca: string | null; linea: string | null;
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
  soat: number | null; impuesto: number | null; derechoTramite: number | null;
  logistica: number | null; tramiteDigital: number | null; gmf: number | null; total: number | null;
  sellada: boolean;
  estadoLiquidacion: 'liquidado' | 'facturado' | null;
  noConfigurados: string[];
  /** Conceptos que esperan su documento pagado, no una tarifa. Hoy solo el derecho de tránsito. */
  sinRecibo: string[];
  /** Los que FLITO gestiona y aún no tienen valor pagado (SOAT, impuesto). Bloquean la liquidación. */
  pendientesPago: string[];
  /** Los que la compañía se gestiona sola: no se cobran ni se esperan. */
  autogestionados: string[];
  /** Los que no aplican por el organismo, no por la compañía. Hoy solo el impuesto. */
  noAplican: string[];
  /**
   * Facturación electrónica de la fila. **El servidor ya las mandaba** (`FilaReporte extends
   * FacturacionDeFila`) y esta interfaz no las declaraba, así que la columna «Factura DIAN» solo
   * podía apoyarse en el mapa de fichas —que por diseño únicamente devuelve trámites CON factura— y
   * un trámite recién encolado se seguía pintando «—» (HU #11329).
   */
  estadoFacturacion: SiigoEstadoReporte;
  facturaNumero: string | null;
  facturaRequiereRevision: boolean;
  /**
   * Conciliación del SOAT de la fila (HU #11679, Feature #11623). No hay un cuarto campo con el
   * NOMBRE DEL ARCHIVO de la boleta y no es un olvido: es texto libre que podría arrastrar la placa
   * de un tercero a un reporte que `auditor` lee sin registro de acceso.
   */
  soatConciliado: boolean;
  boletaReferencia: string | null;
  soatConciliadoEn: string | null;
  /**
   * Titular, organismo y periodo (HU #12432). El tipo de documento llega YA RESUELTO
   * (`'CC' | 'NIT' | 'PP' | 'CE'`): aquí no hay tabla de mapeo, se imprime lo que manda el API.
   */
  titularNombres: string | null;
  titularApellidos: string | null;
  titularRazonSocial: string | null;
  titularTipoDocumento: 'CC' | 'NIT' | 'PP' | 'CE' | null;
  titularDocumento: string | null;
  organismoCodigo: string | null;
  organismoNombre: string | null;
  /** `YYYY-MM` y `YYYY-Tn` de la fecha de aprobación, en UTC. null sin aprobar. */
  mes: string | null;
  trimestre: string | null;
  /**
   * RN-02: SOAT + impuesto + derecho + GMF + logística, y solo el trámite digital. `null` cuando un
   * sumando que FLITO gestiona sigue pendiente: la pantalla pinta el motivo, nunca «$ 0».
   */
  totalReintegro: number | null;
  totalServicio: number | null;
}

export interface Totales {
  soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number;
  gmf: number; total: number; filasIncompletas: number;
  /** RN-02 sobre el universo filtrado, agregados en SQL como los demás (CF-10). */
  totalReintegro: number; totalServicio: number;
}
export interface Resumen { listo: number; incompleto: number; porFacturar: number; facturado: number }
export interface Reporte {
  items: Fila[]; total: number; page: number; pageSize: number; totales: Totales; resumen: Resumen;
}
export interface Opcion { valor: string; nombre: string }
export interface Facetas { estados: string[]; empresas: Opcion[]; tipos: string[]; organismos: Opcion[] }

// ── Consolidado (HU #12433) ──────────────────────────────────────────────────

export type TipoPeriodo = 'mes' | 'trimestre';

export interface FilaConsolidado extends Totales {
  clienteClave: string;
  clienteNombre: string;
  /** `'YYYY-MM'` o `'YYYY-Tn'`; `null` = sin fecha de aprobación (se rotula «Sin aprobar»). */
  periodo: string | null;
  tramites: number;
}
export interface ConsolidadoReporte {
  periodo: TipoPeriodo;
  items: FilaConsolidado[];
  totales: Totales;
}

export const pesos = (n: number) =>
  n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/**
 * Estado con el que arranca el reporte. Cerrar el mes se hace sobre lo aprobado, así que ese es el
 * punto de partida útil; los demás estados siguen a un clic en las pastillas.
 */
export const ESTADO_POR_DEFECTO = 'Aprobado';

/**
 * Etiquetas de los conceptos. Se usan para cruzar con `noConfigurados`, `sinRecibo`,
 * `pendientesPago` y `autogestionados`, para que el motivo de la ausencia y el concepto no puedan
 * divergir. El ENCABEZADO de la columna del derecho es «Trámite» (RN-08), pero la clave con la que
 * el API nombra el concepto sigue siendo «Derecho de tránsito»: son dos cosas distintas.
 */
export const CONCEPTO = {
  soat: 'SOAT', impuesto: 'Impuesto', derecho: 'Derecho de tránsito',
  digital: 'Trámite digital', logistica: 'Logística',
} as const;

/**
 * En qué punto del cobro está el trámite. Es EL filtro de esta pantalla, así que se pide con un
 * clic y no combinando dos desplegables. Las cuatro etapas son excluyentes y cubren todo.
 */
export type Etapa = '' | 'listo' | 'incompleto' | 'por_facturar' | 'facturado';

export const ETAPAS: Array<{ v: Etapa; label: string; ayuda: string; cuenta?: (r: Resumen) => number }> = [
  { v: '', label: 'Todos', ayuda: 'Todos los trámites del filtro, en cualquier etapa.' },
  {
    v: 'listo', label: 'Listos para liquidar', cuenta: (r) => r.listo,
    ayuda: 'Sin liquidar y con SOAT, impuesto, derecho de tránsito, logística y trámite digital resueltos —saltando los que la compañía autogestiona—. Se pueden sellar ya.',
  },
  {
    v: 'incompleto', label: 'Incompletos', cuenta: (r) => r.incompleto,
    ayuda: 'Sin liquidar porque falta una tarifa, un recibo o un pago. Cada fila dice qué.',
  },
  {
    v: 'por_facturar', label: 'Por facturar', cuenta: (r) => r.porFacturar,
    ayuda: 'Liquidados con valores ya sellados, todavía sin facturar.',
  },
  { v: 'facturado', label: 'Facturados', cuenta: (r) => r.facturado, ayuda: 'Ya facturados.' },
];

/**
 * Un concepto sin valor no siempre significa lo mismo, y decir lo que no es hace daño. Cinco casos:
 *
 *   falta = 'tarifa' → no hay tarifa negociada con la compañía. Se arregla en Clientes y
 *                      proveedores. Solo aplica a logística y trámite digital.
 *   falta = 'recibo' → falta el DOCUMENTO pagado. Es el caso del derecho de tránsito, que se lee
 *                      del recibo, igual que el SOAT y el impuesto.
 *   falta = 'pago'   → FLITO lo gestiona para esta compañía y aún no tiene valor pagado.
 *   falta = 'auto'   → la compañía se lo gestiona por su cuenta. No es una ausencia.
 *   falta = 'nada'   → no aplica porque el ORGANISMO no entrega ese concepto en gestión.
 *   sin falta        → no aplica a este trámite. Un guion, porque no hay nada que hacer.
 *
 * En ningún caso se pinta «$ 0»: un cero se suma en la cabeza de quien lee.
 */
export type Falta = 'tarifa' | 'recibo' | 'pago' | 'auto' | 'nada';
export const TEXTO_FALTA: Record<Falta, string> = {
  tarifa: 'No configurado', recibo: 'Sin recibo', pago: 'Sin pagar',
  auto: 'Autogestiona', nada: 'No aplica',
};

/**
 * Alto común de los controles del filtro. Va en estilo y no en clase porque `flitInp` ya trae su
 * relleno vertical: dos utilidades peleando por la misma propiedad se resuelven por el orden de la
 * hoja, no por el del atributo, y la fila quedaba desalineada a capricho del build.
 */
export const ALTO_CONTROL = { height: 40, paddingTop: 0, paddingBottom: 0 } as const;

/**
 * Todo lo que le impide liquidarse, en una sola lista. A quien mira la fila le da igual si lo que
 * falta es una tarifa, un recibo o un pago: lo que necesita saber es qué tiene que resolver.
 */
export const faltantes = (f: Fila): string[] => [...f.noConfigurados, ...f.sinRecibo, ...f.pendientesPago];

/** Por qué está vacía la celda de este concepto, si es que lo está. El backend ya lo decidió. */
export function faltaDe(f: Fila, concepto: string): Falta | undefined {
  if (f.noConfigurados.includes(concepto)) return 'tarifa';
  if (f.sinRecibo.includes(concepto)) return 'recibo';
  if (f.pendientesPago.includes(concepto)) return 'pago';
  if (f.autogestionados.includes(concepto)) return 'auto';
  if (f.noAplican.includes(concepto)) return 'nada';
  return undefined;
}

/**
 * Por qué un SUBTOTAL viene en null (RN-02): el primer sumando que sigue pendiente, con su motivo.
 * Solo cuentan las tres ausencias que bloquean (tarifa, recibo, pago): lo autogestionado y lo que
 * no aplica no dejan el subtotal en null, el API los salta.
 */
export function faltaDeSubtotal(f: Fila, conceptos: readonly string[]): { falta?: Falta; faltan: string[] } {
  const faltan = conceptos.filter((c) => f.noConfigurados.includes(c) || f.sinRecibo.includes(c) || f.pendientesPago.includes(c));
  return { falta: faltan.length ? faltaDe(f, faltan[0]) : undefined, faltan };
}

/** Sumandos de cada subtotal, con los nombres con los que el API los reporta como pendientes. */
export const CONCEPTOS_REINTEGRO = [CONCEPTO.soat, CONCEPTO.impuesto, CONCEPTO.derecho, CONCEPTO.logistica] as const;
export const CONCEPTOS_SERVICIO = [CONCEPTO.digital] as const;

// ── El estado del filtro, en un solo objeto ──────────────────────────────────

/**
 * Todo lo que acota el reporte, junto: la página lo guarda, la tarjeta de filtros lo edita y
 * `params()` lo traduce a la query. `tipoPeriodo` no viaja al detalle (el selector solo rellena
 * `aprobadoDesde/aprobadoHasta`), pero sí al consolidado como `periodo=`.
 */
export interface FiltrosDetalle {
  buscar: string; empresa: string; tipo: string; etapa: Etapa;
  desde: string; hasta: string; aprobadoDesde: string; aprobadoHasta: string;
  estados: string[]; organismos: string[]; docCompleta: boolean;
  tipoPeriodo: TipoPeriodo;
}
