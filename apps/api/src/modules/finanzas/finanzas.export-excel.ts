// Finanzas — el reporte de costos y su consolidado, en `.xlsx` (HU #12531, Feature #12530).
//
// Sustituye al CSV (`aCsv`/`aCsvConsolidado`, HU #12432/#12433). Lo que cambia no es el separador:
// es que cada celda lleva su TIPO. El CSV entregaba «450000» y «2026-09-14» como texto y Excel en
// español los adivinaba —a veces bien, a veces como texto que no suma ni ordena—; aquí el dinero es
// un `number` con el formato contable de Financiero, la fecha es un `Date` y el `null` es una celda
// VACÍA, no una cadena vacía ni un cero que cuadraría un total que no existe.
//
// Vive aparte de `finanzas.service.ts` por el mismo motivo que sus hermanos (`finanzas.consolidado.ts`,
// `finanzas.reporte-columnas.ts`): el archivo principal ya ronda el `max-lines`, y lo que hay aquí
// —la forma de dos hojas— no lo usa ninguna consulta.
//
// ── Qué campo alimenta cada columna ──────────────────────────────────────────────────────────────
//
// El mapeo es el que hacía `aCsv` para las 32 columnas que ya existían (fuente de verdad: HU #12432,
// RN-08), más las cuatro del titular que estrena esta HU (Nombre completo, Correo, Teléfono,
// Dirección). «Flit» es el identificador del trámite en FLIT; «Trámite» son los pesos del derecho de
// tránsito; «Tipo» es el documento del titular y la categoría se llama «Tipo trámite».

import type { ExcelColumn } from '../../shared/utils/excel.js';
import { celdaConciliacion } from './finanzas.conciliacion-soat.js';
import { SIN_APROBAR, type ConsolidadoReporte } from './finanzas.consolidado.js';
import type { FilaReporte } from './finanzas.service.js';

/**
 * El formato contable de pesos del Excel de Financiero, EXACTO: `$` pegado al margen izquierdo,
 * cifra alineada a la derecha, dos decimales, negativo con signo, cero como guion y el texto a la
 * izquierda. Se aplica a la COLUMNA (`sendExcel` → `getColumn(key).numFmt`), no celda a celda.
 */
export const FORMATO_DINERO = '_-"$" * #,##0.00_-;-"$" * #,##0.00_-;_-"$" * "-"??_-;_-@_-';
/** Solo el día. Es lo que Excel enseña; el valor de la celda es un `Date` a las 00:00 UTC. */
export const FORMATO_FECHA = 'yyyy-mm-dd';
/** Entero pelado, para los conteos del consolidado. */
export const FORMATO_ENTERO = '0';

/** Nombre de la hoja de cada libro. Ninguno se llama «Datos»: el archivo dice qué es al abrirlo. */
export const HOJA_DETALLE = 'Reporte de costos';
export const HOJA_CONSOLIDADO = 'Consolidado';

/** Rótulo de la columna «Liquidación» cuando la fila NO está sellada: sus valores son un estimado. */
export const ESTIMADO = 'Estimado';

const dinero = (header: string, key: string): ExcelColumn => ({ header, key, width: 16, numFmt: FORMATO_DINERO });

/**
 * Las 36 columnas del detalle, en el orden del Excel de Financiero (tres secciones: identificación,
 * datos del trámite, valores). Exportada para que el test afirme el orden entero como un solo array.
 */
export const COLUMNAS_EXPORT_DETALLE: readonly ExcelColumn[] = [
  // Identificación
  { header: 'Empresa', key: 'empresa', width: 28 },
  { header: 'Flit', key: 'flit', width: 12 },
  { header: 'Placa', key: 'placa', width: 10 },
  { header: 'VIN', key: 'vin', width: 20 },
  { header: 'Nombres', key: 'nombres', width: 22 },
  { header: 'Apellidos', key: 'apellidos', width: 22 },
  { header: 'Razón social', key: 'razonSocial', width: 28 },
  { header: 'Nombre completo', key: 'nombreCompleto', width: 32 },
  { header: 'Tipo', key: 'tipoDocumento', width: 8 },
  { header: 'Documento', key: 'documento', width: 14 },
  { header: 'Correo', key: 'correo', width: 26 },
  { header: 'Teléfono', key: 'telefono', width: 14 },
  { header: 'Dirección', key: 'direccion', width: 30 },
  // Datos del trámite
  { header: 'Tipo trámite', key: 'tipoTramite', width: 16 },
  { header: 'Marca', key: 'marca', width: 14 },
  { header: 'Línea', key: 'linea', width: 14 },
  { header: 'OT', key: 'ot', width: 18 },
  { header: 'Estado', key: 'estado', width: 14 },
  { header: 'Creado', key: 'creado', width: 12, numFmt: FORMATO_FECHA },
  { header: 'Aprobado', key: 'aprobado', width: 12, numFmt: FORMATO_FECHA },
  { header: 'Mes', key: 'mes', width: 9 },
  { header: 'Trimestre', key: 'trimestre', width: 10 },
  { header: 'Estado factura', key: 'estadoFactura', width: 16 },
  { header: 'Factura', key: 'factura', width: 14 },
  // Valores
  dinero('SOAT', 'soat'),
  dinero('Impuesto', 'impuesto'),
  dinero('Trámite', 'tramite'),
  dinero('GMF', 'gmf'),
  dinero('Logística', 'logistica'),
  dinero('Total reintegro', 'totalReintegro'),
  dinero('Trámite digital', 'tramiteDigital'),
  dinero('Servicio', 'servicio'),
  dinero('Total', 'total'),
  { header: 'Liquidación', key: 'liquidacion', width: 12 },
  // Todo lo que impide liquidar, no solo las tarifas: quien concilia necesita la lista completa.
  { header: 'Qué falta para liquidar', key: 'queFalta', width: 36 },
  // HU #11679 (AC4): el SOAT ya descontado de bolsa frente al que sigue por cobrar, con su boleta.
  { header: 'SOAT conciliado', key: 'soatConciliado', width: 18 },
];

/**
 * Un ISO de instante → `Date` del DÍA en UTC (00:00Z), o `null`.
 *
 * Se toma el día del ISO (`slice(0, 10)`) y NO el instante: `fechaAprobacion` ya viene normalizada
 * por `aFila`, y el día que Financiero cuadra es el del ISO en UTC —el mismo que `periodoDe` usa para
 * el mes y el trimestre—, no el de la zona del proceso. Con `new Date(iso)` y `numFmt` de día, Excel
 * mostraría el 13 para una aprobación del 14 a las 04:30Z en un proceso en -05.
 */
export function fechaExcel(iso: string | null): Date | null {
  if (iso === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * «Nombre completo»: la razón social si existe; si no, `nombres apellidos` recortado; y `null` si no
 * hay nada. Se DERIVA aquí de las tres columnas partidas y no se lee `flito_compradores.nombre_completo`
 * (la cadena fundida del sync): el titular ya llega clasificado por `bloqueTitular` (RN-01), que es
 * quien decide qué es nombre y qué es razón social, y una columna más en el `select` sería una
 * segunda verdad. Respeta S-05: los apellidos «␠» ya llegan como `null` desde `columnasDeFila`.
 */
export function nombreCompletoTitular(f: Pick<FilaReporte, 'titularNombres' | 'titularApellidos' | 'titularRazonSocial'>): string | null {
  if (f.titularRazonSocial) return f.titularRazonSocial;
  const junto = [f.titularNombres, f.titularApellidos].filter((p): p is string => Boolean(p)).join(' ').trim();
  return junto === '' ? null : junto;
}

/** Texto de la columna «Liquidación»: sellada → «Liquidado»/«Facturado»; sin sellar → «Estimado». */
export function rotuloLiquidacion(f: Pick<FilaReporte, 'sellada' | 'estadoLiquidacion'>): string {
  if (!f.sellada) return ESTIMADO;
  return f.estadoLiquidacion === 'facturado' ? 'Facturado' : 'Liquidado';
}

/** Una lista vacía es una celda VACÍA, no una cadena vacía: `null` es lo que ExcelJS deja sin escribir. */
const listaOVacia = (partes: string[]): string | null => (partes.length === 0 ? null : partes.join(' | '));

/**
 * Las filas del detalle con las CLAVES de `COLUMNAS_EXPORT_DETALLE`. El dinero va como número —GMF y
 * los totales incluidos, como VALOR y no como fórmula: sellado en las liquidadas y estimado en el
 * resto, que es exactamente lo que `aFila` ya resolvió—; los `null` se quedan `null`.
 */
export function filasExcelDetalle(filas: FilaReporte[]): Record<string, unknown>[] {
  return filas.map((f) => ({
    empresa: f.empresa, flit: f.idFlit, placa: f.placa, vin: f.vin,
    nombres: f.titularNombres, apellidos: f.titularApellidos, razonSocial: f.titularRazonSocial,
    nombreCompleto: nombreCompletoTitular(f),
    tipoDocumento: f.titularTipoDocumento, documento: f.titularDocumento,
    correo: f.titularCorreo, telefono: f.titularTelefono, direccion: f.titularDireccion,
    tipoTramite: f.tipoTramite, marca: f.marca, linea: f.linea, ot: f.organismoNombre, estado: f.estado,
    creado: fechaExcel(f.fechaCreacion), aprobado: fechaExcel(f.fechaAprobacion),
    mes: f.mes, trimestre: f.trimestre,
    estadoFactura: f.estadoFacturacion, factura: f.facturaNumero,
    soat: f.soat, impuesto: f.impuesto, tramite: f.derechoTramite, gmf: f.gmf, logistica: f.logistica,
    totalReintegro: f.totalReintegro, tramiteDigital: f.tramiteDigital, servicio: f.totalServicio, total: f.total,
    liquidacion: rotuloLiquidacion(f),
    queFalta: listaOVacia([...f.noConfigurados, ...f.sinRecibo, ...f.pendientesPago]),
    soatConciliado: celdaConciliacion(f),
  }));
}

// ── Consolidado ─────────────────────────────────────────────────────────────

/**
 * Las 13 columnas del consolidado: las mismas de valor y con los mismos nombres que el detalle
 * (CF-14). «Trámites» e «Incompletos» son enteros; «Periodo» es texto (`2026-09`, `2026-T3`).
 */
export const COLUMNAS_EXPORT_CONSOLIDADO: readonly ExcelColumn[] = [
  { header: 'Cliente', key: 'cliente', width: 32 },
  { header: 'Periodo', key: 'periodo', width: 12 },
  { header: 'Trámites', key: 'tramites', width: 10, numFmt: FORMATO_ENTERO },
  dinero('SOAT', 'soat'),
  dinero('Impuesto', 'impuesto'),
  dinero('Trámite', 'tramite'),
  dinero('GMF', 'gmf'),
  dinero('Logística', 'logistica'),
  dinero('Total reintegro', 'totalReintegro'),
  dinero('Trámite digital', 'tramiteDigital'),
  dinero('Servicio', 'servicio'),
  dinero('Total', 'total'),
  { header: 'Incompletos', key: 'incompletos', width: 12, numFmt: FORMATO_ENTERO },
];

/** Las filas del consolidado con las claves de `COLUMNAS_EXPORT_CONSOLIDADO`, en el orden de `items`. */
export function filasExcelConsolidado(c: ConsolidadoReporte): Record<string, unknown>[] {
  return c.items.map((f) => ({
    cliente: f.clienteNombre, periodo: f.periodo ?? SIN_APROBAR, tramites: f.tramites,
    soat: f.soat, impuesto: f.impuesto, tramite: f.derechoTramite, gmf: f.gmf, logistica: f.logistica,
    totalReintegro: f.totalReintegro, tramiteDigital: f.tramiteDigital, servicio: f.totalServicio, total: f.total,
    incompletos: f.filasIncompletas,
  }));
}
