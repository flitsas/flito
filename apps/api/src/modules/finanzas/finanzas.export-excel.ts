// Finanzas — el reporte de costos y su consolidado, en `.xlsx` (HU #12531 y #12536, Feature #12530).
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
// ── El detalle replica LITERALMENTE el Excel de Financiero (HU #12536) ────────────────────────────
//
// Desde la decisión del PO del 2026-09-14 el detalle ya no lleva las 36 columnas canónicas de la
// HU #12432: lleva las 31 del archivo con el que Financiero trabaja hoy, con sus cabeceras tal cual
// —«cliente» en minúscula, «Tramite» sin tilde, «Vin», «Columna1»/«Columna2»— y en su orden, para que
// el archivo descargado se pegue sobre el suyo sin remapear nada. Qué campo alimenta cada columna:
//
//   cliente ← empresa · Mes/Trimestre ← trimestre · FLIT ← idFlit · Placa y Placa2 ← placa (dos
//   veces, como en el adjunto) · Tipo ← titularTipoDocumento (CC/NIT) · CC-NIT ← titularDocumento
//   COMO TEXTO · Nombres/Apellidos/Correo/Teléfono/Dirección ← titular* · Nombre completo ←
//   nombreCompletoTitular · Estado ← estado · OT ← organismoNombre · Tipo Trámite y Tramite ←
//   tipoTramite (la misma categoría, dos veces) · SOAT/Impuesto/GMF ← el concepto · Trámite ←
//   derechoTramite (pesos) · Total Reintegro ← totalReintegro · Servicio ← totalServicio · Factura ←
//   facturaNumero · Vin ← vin · fecha_aprobacion ← fechaExcel(fechaAprobacion) · Filtromes ← mes.
//
// Dos columnas no se llaman como lo que llevan, y es a propósito:
//   · «Modelo» ← linea. En el Excel de Financiero «Modelo» es la LÍNEA del vehículo (ONIX, LOGAN),
//     no el año-modelo ni la marca: así lo usa Financiero y así lo decidió el PO (épica #12243).
//   · «Columna1» ← logistica. Es la columna sin nombre que en el adjunto contiene la logística.
// Y dos van siempre vacías: «Columna2» (formato de dinero en la columna, como el adjunto) y
// «Factura Terceros» (FLITO no la conoce; se deja para que Financiero la rellene a mano).
//
// Salen del archivo: Marca, Creado, Estado factura, Trámite digital, Total, Liquidación, Qué falta
// para liquidar, SOAT conciliado y Razón social como columna aparte (va dentro de Nombre completo).
// El consolidado (13 columnas) no cambia.

import type { ExcelColumn } from '../../shared/utils/excel.js';
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

const dinero = (header: string, key: string): ExcelColumn => ({ header, key, width: 16, numFmt: FORMATO_DINERO });

/**
 * Las 31 columnas del detalle, con las cabeceras LITERALES del Excel de Financiero y en su orden
 * (HU #12536). Las claves son únicas aunque la fuente se repita —`placa`/`placa2`,
 * `tipoTramite`/`tramiteCategoria`— porque ExcelJS pisa las claves repetidas en `addRow`.
 * Exportada para que el test afirme el orden entero como un solo array.
 */
export const COLUMNAS_EXPORT_DETALLE: readonly ExcelColumn[] = [
  { header: 'cliente', key: 'cliente', width: 28 },
  { header: 'Mes/Trimestre', key: 'mesTrimestre', width: 14 },
  { header: 'FLIT', key: 'flit', width: 12 },
  { header: 'Placa', key: 'placa', width: 10 },
  { header: 'Tipo', key: 'tipo', width: 8 },
  { header: 'CC-NIT', key: 'ccNit', width: 14 },
  { header: 'Nombres', key: 'nombres', width: 22 },
  { header: 'Apellidos', key: 'apellidos', width: 22 },
  { header: 'Nombre completo', key: 'nombreCompleto', width: 32 },
  { header: 'Modelo', key: 'modelo', width: 14 },
  { header: 'Estado', key: 'estado', width: 14 },
  { header: 'Correo', key: 'correo', width: 26 },
  { header: 'OT', key: 'ot', width: 18 },
  { header: 'Tipo Trámite', key: 'tipoTramite', width: 16 },
  { header: 'Teléfono/Celular', key: 'telefono', width: 16 },
  { header: 'Dirección', key: 'direccion', width: 30 },
  dinero('SOAT', 'soat'),
  dinero('Trámite', 'tramite'),
  dinero('Impuesto', 'impuesto'),
  dinero('Columna1', 'columna1'),
  dinero('Columna2', 'columna2'),
  dinero('GMF', 'gmf'),
  dinero('Total Reintegro', 'totalReintegro'),
  dinero('Servicio', 'servicio'),
  { header: 'Factura', key: 'factura', width: 14 },
  { header: 'Factura Terceros', key: 'facturaTerceros', width: 16 },
  { header: 'Vin', key: 'vin', width: 20 },
  { header: 'Placa2', key: 'placa2', width: 10 },
  { header: 'Tramite', key: 'tramiteCategoria', width: 16 },
  { header: 'fecha_aprobacion', key: 'fechaAprobacion', width: 16, numFmt: FORMATO_FECHA },
  { header: 'Filtromes', key: 'filtromes', width: 10 },
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

/**
 * Las filas del detalle con las CLAVES de `COLUMNAS_EXPORT_DETALLE`. El dinero va como número —GMF y
 * los totales incluidos, como VALOR y no como fórmula: sellado en las liquidadas y estimado en el
 * resto, que es exactamente lo que `aFila` ya resolvió—; los `null` se quedan `null`. El documento
 * va como TEXTO: un NIT o una cédula no es una cifra y Excel le quitaría los ceros a la izquierda.
 */
export function filasExcelDetalle(filas: FilaReporte[]): Record<string, unknown>[] {
  return filas.map((f) => ({
    cliente: f.empresa, mesTrimestre: f.trimestre, flit: f.idFlit, placa: f.placa,
    tipo: f.titularTipoDocumento, ccNit: f.titularDocumento,
    nombres: f.titularNombres, apellidos: f.titularApellidos, nombreCompleto: nombreCompletoTitular(f),
    modelo: f.linea, estado: f.estado, correo: f.titularCorreo, ot: f.organismoNombre,
    tipoTramite: f.tipoTramite, telefono: f.titularTelefono, direccion: f.titularDireccion,
    soat: f.soat, tramite: f.derechoTramite, impuesto: f.impuesto, columna1: f.logistica, columna2: null,
    gmf: f.gmf, totalReintegro: f.totalReintegro, servicio: f.totalServicio,
    factura: f.facturaNumero, facturaTerceros: null,
    vin: f.vin, placa2: f.placa, tramiteCategoria: f.tipoTramite,
    fechaAprobacion: fechaExcel(f.fechaAprobacion), filtromes: f.mes,
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
