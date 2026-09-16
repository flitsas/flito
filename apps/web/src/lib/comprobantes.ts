// FLITO — lo que la pantalla de Comprobantes (HU #12612, Feature #12605) necesita fuera del JSX:
// copy de celdas (ficha UX §5.2), agrupación por carga, chips de confianza (§7.5) y el envío en
// lotes con la regla propia de esta puerta: los PDF de más de una página (consolidados) viajan de
// UNO en uno, el resto de 5 en 5 (`CARGA_MASIVA_ARCHIVOS_POR_PETICION`).
//
// Nada de `extraccion` cruda: la cola y el detalle solo pintan lo que trae el DTO (ADR-0008).

import {
  CAMPO_COMPROBANTE_LABEL, CAMPO_DERECHO_TRAMITE_LABEL, CAMPO_IMPUESTO_LABEL, CAMPO_SOAT_LABEL,
  CARGA_MASIVA_ARCHIVOS_POR_PETICION, partirCargaMasivaEnTandas,
  type CampoComprobanteDto, type ComprobanteListaDto, type ResultadoCargaComprobantes,
} from '@operaciones/shared-types';
import type { ChipTone } from '../components/flit/StatusChip';
import { enviarCargaEnTandas, fusionarResultadoCarga, type ItemCarga } from './carga-masiva';
import { PDF_WORKER_SRC } from './pdfWorker';

export const RUTA_COMPROBANTES = '/flito/comprobantes';

// ───────────────────────────────── Copy de celdas (§5.2) ─────────────────────────────────────────

/** `p. 3` · `p. 3-4` · `p. 3, 7` · `p. 1-2, 5`: rangos consecutivos con guion. `null` si el archivo entero es el documento. */
export function textoPaginas(paginas: number[] | null): string | null {
  if (!paginas || paginas.length === 0) return null;
  const orden = [...paginas].sort((a, b) => a - b);
  const rangos: string[] = [];
  let ini = orden[0];
  let fin = orden[0];
  for (const p of orden.slice(1)) {
    if (p === fin + 1) { fin = p; continue; }
    rangos.push(ini === fin ? `${ini}` : `${ini}-${fin}`);
    ini = p; fin = p;
  }
  rangos.push(ini === fin ? `${ini}` : `${ini}-${fin}`);
  return `p. ${rangos.join(', ')}`;
}

/** Los últimos 6 del VIN: 17 caracteres monoespaciados ensanchan la celda y son PII de vehículo. */
export const VIN_VISIBLE = 6;
export const vinRecortado = (vin: string): string => `…${vin.slice(-VIN_VISIBLE)}`;

/**
 * La llave con la que el OCR intentó cruzar, en el orden de la ficha: ID FLIT → VIN → placa.
 * `null` si no leyó ninguna. El VIN va recortado y SIN `title` con el completo (UX-4/§8: ni uuid ni
 * VIN entero en DOM visible, aria-label, title ni data-*); el VIN completo solo se lee en el detalle.
 */
export function llaveLeida(c: Pick<ComprobanteListaDto, 'idFlitLeido' | 'vinLeido' | 'placaLeida'>): string | null {
  if (c.idFlitLeido) return c.idFlitLeido;
  if (c.vinLeido) return vinRecortado(c.vinLeido);
  if (c.placaLeida) return c.placaLeida;
  return null;
}

const FORMATO_PESOS = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/** `$ 950.000` o «—». Nunca `$ 0`: un comprobante sin valor no lo tiene, no vale cero. */
export function pesosComprobante(v: number | null): string {
  if (v === null || v === 0) return '—';
  return FORMATO_PESOS.format(v).replace(/\u00a0/g, ' ');
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** `16 sep 2026` (ficha UX §5.1). A mano y no con `toLocaleDateString`: cada motor abrevia distinto («16 de sept de 2026»). */
export function fechaCarga(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MESES_CORTOS[d.getMonth()]} ${d.getFullYear()}`;
}

export const horaCarga = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });

/** «Carga 16 sep 2026 · 10:42 · Ana Pérez». */
export const textoCarga = (c: Pick<ComprobanteListaDto, 'createdAt' | 'subidoPorNombre'>): string =>
  `Carga ${fechaCarga(c.createdAt)} · ${horaCarga(c.createdAt)} · ${c.subidoPorNombre}`;

/** El chip de filtro por carga: «Carga de hoy 10:42» si es de hoy, si no fecha · hora. */
export function etiquetaChipCarga(iso: string): string {
  const d = new Date(iso);
  const hoy = new Date();
  const esHoy = d.toDateString() === hoy.toDateString();
  return esHoy ? `Carga de hoy ${horaCarga(iso)}` : `Carga ${fechaCarga(iso)} · ${horaCarga(iso)}`;
}

/** Segundo renglón de «Leído»: qué cree el OCR que es. */
export function textoEsPago(esPago: boolean | null): string {
  if (esPago === true) return 'Pago';
  if (esPago === false) return 'Documentación';
  return 'Sin decidir';
}

/** `1.2 MB` / `340 KB` para el tamaño del `File` local en la tabla de resultado. */
export function textoTamano(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ────────────────────────────── Agrupación por carga (§5.1, D6) ──────────────────────────────────

export interface GrupoCarga {
  loteId: string;
  cabecera: ComprobanteListaDto;
  filas: ComprobanteListaDto[];
  /** Archivos distintos dentro del grupo (un consolidado de 4 documentos cuenta 1). */
  archivos: number;
}

/**
 * Corta la página en grupos consecutivos por `loteId` (la cabecera se pinta cuando cambia el lote
 * de la fila anterior; un grupo partido entre páginas repite su cabecera). Dentro del grupo, por
 * nombre de archivo y primera página.
 */
export function agruparPorCarga(items: readonly ComprobanteListaDto[]): GrupoCarga[] {
  const grupos: GrupoCarga[] = [];
  for (const item of items) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.loteId === item.loteId) ultimo.filas.push(item);
    else grupos.push({ loteId: item.loteId, cabecera: item, filas: [item], archivos: 0 });
  }
  for (const g of grupos) {
    g.filas.sort((a, b) => a.archivo.nombre.localeCompare(b.archivo.nombre) || (a.paginas?.[0] ?? 0) - (b.paginas?.[0] ?? 0));
    g.archivos = new Set(g.filas.map((f) => f.archivo.nombre)).size;
  }
  return grupos;
}

// ────────────────────────────── Chips de confianza (§7.5, D11) ───────────────────────────────────

/** El nivel lo trae el servidor; aquí solo se elige rótulo y tono. `valor` nulo manda: «Sin lectura». */
export function chipConfianza(campo: Pick<CampoComprobanteDto, 'valor' | 'nivel' | 'confiable' | 'confirmadoPor'>): { texto: string; tono: ChipTone } {
  if (campo.confirmadoPor) return { texto: 'Confirmado', tono: 'active' };
  if (campo.valor === null || campo.nivel === null) return { texto: 'Sin lectura', tono: 'neutral' };
  if (campo.nivel === 'alta') return { texto: 'Alta', tono: 'success' };
  if (campo.nivel === 'media') return { texto: 'Media', tono: campo.confiable ? 'success' : 'warning' };
  return { texto: 'Baja', tono: 'warning' };
}

const LABEL_DESTINO: Record<string, string> = { ...CAMPO_DERECHO_TRAMITE_LABEL, ...CAMPO_IMPUESTO_LABEL, ...CAMPO_SOAT_LABEL };

/** Rótulo de un `campos[i].campo`: los diez universales por su label; los del destino (`destino.x`) por el de su extractor. */
export function labelCampo(campo: string): string {
  if (campo.startsWith('destino.')) {
    const clave = campo.slice('destino.'.length);
    return LABEL_DESTINO[clave] ?? clave;
  }
  return (CAMPO_COMPROBANTE_LABEL as Record<string, string>)[campo] ?? campo;
}

// ─────────────────────────── Envío en lotes: consolidados de 1 en 1 ─────────────────────────────

/**
 * Cuenta las páginas de un PDF con pdf.js SIN renderizar nada (solo el índice). Cualquier cosa que
 * no sea PDF, o un PDF que pdf.js no abre, cuenta 1: el servidor es quien decide qué hacer con él
 * (`fallidos`), aquí solo se decide si viaja solo.
 */
type PdfWorker = InstanceType<(typeof import('pdfjs-dist'))['PDFWorker']>;
/**
 * UN worker para todo el lote. Sin él, `getDocument` crea (y `destroy` mata) un worker por archivo:
 * medido en el E2E, 12 archivos tardaban más de 5 s solo en arrancar workers. Con el worker
 * externo, `destroy()` de cada tarea suelta el documento y deja el worker vivo.
 */
let workerCompartido: PdfWorker | null = null;

export async function contarPaginasPdf(archivo: File): Promise<number> {
  const esPdf = archivo.type === 'application/pdf' || archivo.name.toLowerCase().endsWith('.pdf');
  if (!esPdf) return 1;
  let tarea: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | null = null;
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
    workerCompartido ??= new pdfjs.PDFWorker();
    tarea = pdfjs.getDocument({ data: new Uint8Array(await archivo.arrayBuffer()), worker: workerCompartido });
    const doc = await tarea.promise;
    return doc.numPages;
  } catch {
    return 1;
  } finally {
    await tarea?.destroy().catch(() => undefined);
  }
}

/**
 * Los sueltos van de 5 en 5 (`partirCargaMasivaEnTandas`) y cada consolidado en su propio envío
 * (un PDF de 30 páginas ya gasta solo el presupuesto de tiempo de una petición). El orden relativo
 * no importa: el resultado se fusiona por categoría.
 */
export function partirLoteComprobantes<T>(items: readonly T[], esConsolidado: (item: T) => boolean): T[][] {
  const sueltos = items.filter((i) => !esConsolidado(i));
  const consolidados = items.filter(esConsolidado);
  return [...partirCargaMasivaEnTandas(sueltos, CARGA_MASIVA_ARCHIVOS_POR_PETICION), ...consolidados.map((c) => [c])];
}

export const RESULTADO_CARGA_VACIO: ResultadoCargaComprobantes = { aplicados: [], pendientes: [], duplicados: [], fallidos: [], documentos: 0 };

/**
 * Envía el lote entero con el MISMO `loteId` en cada petición, parando en el primer no-200 (regla
 * HU #12051). Cada envío pasa por `enviarCargaEnTandas` (413/504, timeout por petición, FormData);
 * `documentos` no es arreglo y `fusionarResultadoCarga` no lo suma, así que se suma aquí.
 * `onProgreso` recibe el primer archivo del envío en curso y el total: cuenta archivos, no envíos.
 */
export async function enviarLoteComprobantes(
  items: readonly ItemCarga[],
  paginasPorItem: ReadonlyMap<ItemCarga, number>,
  loteId: string,
  onProgreso: (desde: number, total: number) => void,
): Promise<{ resultado: ResultadoCargaComprobantes | null; error: string | null }> {
  const envios = partirLoteComprobantes(items, (i) => (paginasPorItem.get(i) ?? 1) > 1);
  let acc: ResultadoCargaComprobantes | null = null;
  let enviados = 0;
  for (const envio of envios) {
    onProgreso(enviados + 1, items.length);
    const { resultado, error } = await enviarCargaEnTandas<ResultadoCargaComprobantes>(
      RUTA_COMPROBANTES, envio, () => {}, { loteId }, { conRutas: false },
    );
    if (resultado) {
      const documentos: number = (acc?.documentos ?? 0) + (resultado.documentos ?? 0);
      const fusionado: ResultadoCargaComprobantes = acc ? fusionarResultadoCarga(acc, resultado) : resultado;
      acc = { ...fusionado, documentos };
    }
    if (error) return { resultado: acc, error };
    enviados += envio.length;
  }
  return { resultado: acc, error: null };
}
