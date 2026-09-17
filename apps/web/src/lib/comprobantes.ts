// FLITO — lo que la pantalla de Comprobantes (HU #12612, Feature #12605) necesita fuera del JSX:
// copy de celdas (ficha UX §5.2), agrupación por carga, chips de confianza (§7.5) y el envío en
// lotes con la regla propia de esta puerta: los PDF de más de una página (consolidados) viajan de
// UNO en uno, el resto de 5 en 5 (`CARGA_MASIVA_ARCHIVOS_POR_PETICION`).
//
// Nada de `extraccion` cruda: la cola y el detalle solo pintan lo que trae el DTO (ADR-0008).

import {
  ASOCIACIONES_COMPROBANTE, CAMPO_COMPROBANTE_LABEL, CAMPO_DERECHO_TRAMITE_LABEL, CAMPO_IMPUESTO_LABEL, CAMPO_SOAT_LABEL,
  CARGA_MASIVA_ARCHIVOS_POR_PETICION, MOTIVO_PENDIENTE_COMPROBANTE_LABEL, partirCargaMasivaEnTandas,
  type AceptarDiferenciaBody, type AdmisionConcepto, type AplicarComprobanteBody, type AsociacionComprobante, type CampoComprobanteDto, type CandidatoTramiteDto,
  type ComprobanteDetalleDto, type ComprobanteListaDto, type ErrorComprobanteDto, type EstadoComprobante, type ResultadoAplicarComprobanteDto,
  type ResultadoCargaComprobantes,
} from '@operaciones/shared-types';
import type { ChipTone } from '../components/flit/StatusChip';
import { ApiError, api } from './api';
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

// ─────────────── Estado de asociación (HU #12635, Feature #12606, UX slim §1.1-§1.4) ────────────

/** Los seis rótulos, en UNA constante exhaustiva: selector, chip de la fila y chip del detalle. */
export const ASOCIACION_COMPROBANTE_LABEL: Record<AsociacionComprobante, string> = {
  pendiente: 'Pendiente de asociar', rechazado_pago: 'Rechazado como pago', aplicado_automatico: 'Aplicado automático',
  aplicado_manual: 'Aplicado manual', adjuntado: 'Adjuntado', descartado: 'Descartado',
};

export const TONO_ASOCIACION: Record<AsociacionComprobante, ChipTone> = {
  pendiente: 'warning', rechazado_pago: 'warning', aplicado_automatico: 'success',
  aplicado_manual: 'success', adjuntado: 'active', descartado: 'neutral',
};

/** La pill (estado grueso) que cada opción del selector implica (slim §1.1-§1.2): nunca una combinación contradictoria. */
export const PILL_DE_ASOCIACION: Record<AsociacionComprobante, EstadoComprobante> = {
  pendiente: 'pendiente', rechazado_pago: 'pendiente', aplicado_automatico: 'aplicado',
  aplicado_manual: 'aplicado', adjuntado: 'aplicado', descartado: 'descartado',
};

/** Orden de las opciones del selector: el de las pills, no el de la constante. */
export const OPCIONES_ASOCIACION: readonly AsociacionComprobante[] = ['pendiente', 'rechazado_pago', 'aplicado_automatico', 'aplicado_manual', 'adjuntado', 'descartado'];

export const esAsociacionComprobante = (v: string | null | undefined): v is AsociacionComprobante =>
  ASOCIACIONES_COMPROBANTE.includes(v as AsociacionComprobante);

export type FilaAsociacion = Pick<ComprobanteListaDto, 'estado' | 'esPago' | 'aplicadoAutomaticamente' | 'motivoPendiente'>;

/**
 * Espejo EXACTO de `condicionAsociacion` del servidor (una fila devuelta por `?asociacion=X` pinta el
 * chip X), en este orden: descartado → pendiente con `destino_no_admite` = rechazado como pago →
 * pendiente → aplicado con `esPago === false` = adjuntado (ANTES de mirar si fue automático) →
 * automático → manual. Un `esPago` nulo en un aplicado cae como pago, igual que en SQL.
 */
export function asociacionDe(c: FilaAsociacion): AsociacionComprobante {
  if (c.estado === 'descartado') return 'descartado';
  if (c.estado === 'pendiente') return c.motivoPendiente === 'destino_no_admite' ? 'rechazado_pago' : 'pendiente';
  if (c.esPago === false) return 'adjuntado';
  return c.aplicadoAutomaticamente ? 'aplicado_automatico' : 'aplicado_manual';
}

type FilaTextoAsociacion = FilaAsociacion & Pick<ComprobanteListaDto, 'detallePendiente' | 'aplicadoEn' | 'aplicadoPorNombre' | 'descartadoEn' | 'descartadoPorNombre'>;

/**
 * Segundo renglón de Estado (slim §1.4), en la fila y en la cabecera del detalle: se recorta lo que
 * el chip ya dice («automático»/«manual» se fueron al rótulo). `porQuien` añade «Descartado por X» en el detalle.
 */
export function textoAsociacion(c: FilaTextoAsociacion, porQuien = false): string {
  const asociacion = asociacionDe(c);
  if (asociacion === 'pendiente' || asociacion === 'rechazado_pago') {
    return c.detallePendiente ?? (c.motivoPendiente ? MOTIVO_PENDIENTE_COMPROBANTE_LABEL[c.motivoPendiente] : '');
  }
  if (asociacion === 'descartado') {
    const cuando = c.descartadoEn ? fechaCarga(c.descartadoEn) : '';
    return porQuien ? [`Descartado por ${c.descartadoPorNombre ?? '—'}`, cuando].filter(Boolean).join(' · ') : cuando;
  }
  const cuando = c.aplicadoEn ? fechaCarga(c.aplicadoEn) : '';
  if (c.aplicadoAutomaticamente) return cuando;
  return [`por ${c.aplicadoPorNombre ?? '—'}`, cuando].filter(Boolean).join(' · ');
}

/** Destino de «Ver trámite» (AC3): Gestión Trámites filtrada por la placa, en otra pestaña. `null` sin placa: sin filtro no hay enlace. */
export function hrefVerTramite(tramite: { placa: string | null } | null): string | null {
  if (!tramite?.placa) return null;
  return `/flito/tramites?placa=${encodeURIComponent(tramite.placa)}`;
}

// ───────────────────────── Asociación (HU #12634, Feature #12606, UX slim §1-§5) ─────────────────

/** Copy de `AdmisionConcepto` (slim §2): sufijo de las opciones del select y 2.ª línea del combobox. */
export const ADMISION_LABEL: Record<AdmisionConcepto, string> = {
  admite: 'admite', ya_pagado: 'ya pagado', no_gestionado: 'no gestionado',
  estado_no_permitido: 'estado no permitido', liquidado: 'liquidado', ya_documentado: 'ya documentado',
};

/** La misma ayuda en los tres `textarea` de motivo (aplicar, descartar, reemplazar): slim §4. */
export const AYUDA_MOTIVO = 'Mínimo 5 caracteres. Queda en la auditoría del comprobante. No escribas datos personales (nombres, cédulas, teléfonos).';
export const MOTIVO_MIN = 5;
export const MOTIVO_MAX = 500;
export const BUSCAR_MIN = 3;
export const BUSCAR_MAX = 60;

export const buscarTramites = (buscar: string) =>
  api.post<{ candidatos: CandidatoTramiteDto[] }>(`${RUTA_COMPROBANTES}/tramites/buscar`, { buscar });

export const aplicarComprobante = (id: string, body: AplicarComprobanteBody) =>
  api.post<ResultadoAplicarComprobanteDto>(`${RUTA_COMPROBANTES}/${id}/aplicar`, body);

export const descartarComprobante = (id: string, motivo: string) =>
  api.post<{ ok: true }>(`${RUTA_COMPROBANTES}/${id}/descartar`, { motivo });

/**
 * Deja constancia de que la diferencia documental de UN comprobante es correcta (HU #12654 → #12655).
 * No toca el valor ni el sello: el servidor solo firma quién, cuándo y por qué. Los textos que la
 * acompañan (chips, botón, modal, aviso) están en `lib/diferenciaDocumental.ts`.
 */
export const aceptarDiferencia = (id: string, motivo: string) =>
  api.post<{ ok: true }>(`${RUTA_COMPROBANTES}/${id}/diferencia/aceptar`, { motivo } satisfies AceptarDiferenciaBody);
export {
  avisoAceptadas, MOTIVO_DIFERENCIA_MAX, MOTIVO_DIFERENCIA_MIN, motivoDiferenciaValido, nombreAccesibleAceptar,
  ROTULO_ACEPTAR, textoDiferencia, textoOrigen,
} from './diferenciaDocumental';

/** El cuerpo `{ error, codigo, … }` de un error del módulo, o `null` si no es un `ApiError` con `codigo`. La pantalla decide por `codigo`, nunca por texto. */
export function errorComprobante(e: unknown): (ErrorComprobanteDto & { status: number }) | null {
  if (!(e instanceof ApiError)) return null;
  const raw = e.rawDetails as Partial<ErrorComprobanteDto> | null | undefined;
  if (!raw || typeof raw.codigo !== 'string') return null;
  return { ...raw, error: raw.error ?? e.message, codigo: raw.codigo, status: e.status };
}

export type LlaveSugerido = 'ID FLIT' | 'VIN' | 'placa';

/**
 * Por qué un candidato es «Sugerido» (slim D-2): el DTO del candidato no trae `cruce`, así que se
 * deriva sin dato nuevo: si el comprobante ya tiene `cruce` fijado y es ese trámite, se usa; si no,
 * por coincidencia con lo leído en el orden ID FLIT → VIN → placa. `null` = solo «Sugerido».
 */
export function llaveSugerido(
  c: Pick<CandidatoTramiteDto, 'tramiteId' | 'idFlit' | 'placa' | 'vin'>,
  d: Pick<ComprobanteDetalleDto, 'cruce' | 'tramite' | 'idFlitLeido' | 'vinLeido' | 'placaLeida'>,
): LlaveSugerido | null {
  if (d.tramite?.id === c.tramiteId && d.cruce && d.cruce !== 'manual') {
    return d.cruce === 'id_flit' ? 'ID FLIT' : d.cruce === 'vin' ? 'VIN' : 'placa';
  }
  const eq = (a: string | null, b: string | null) => !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
  if (eq(c.idFlit, d.idFlitLeido)) return 'ID FLIT';
  if (eq(c.vin, d.vinLeido)) return 'VIN';
  if (eq(c.placa, d.placaLeida)) return 'placa';
  return null;
}

/** Filtro en cliente de los sugeridos por lo escrito (slim §2): siguen primeros mientras coincidan con `idFlit`, `placa` o `vin`. */
export function coincideCandidato(c: Pick<CandidatoTramiteDto, 'idFlit' | 'placa' | 'vin'>, texto: string): boolean {
  const t = texto.trim().toUpperCase();
  if (!t) return true;
  return [c.idFlit, c.placa, c.vin].some((v) => !!v && v.toUpperCase().includes(t));
}

/** Campos que la persona puede corregir (slim D-5). `placa`, `vin` e `idFlit` se muestran con chip pero no se editan; `tipoDocumento`, `esComprobantePago` y `concepto` no se listan. */
export const CAMPOS_EDITABLES = new Set(['valorTotal', 'fechaPago', 'numeroDocumento', 'emisor']);
export const CAMPOS_OCULTOS = new Set(['tipoDocumento', 'esComprobantePago', 'concepto']);
export const esCampoEditable = (campo: string): boolean => CAMPOS_EDITABLES.has(campo) || campo.startsWith('destino.');

/**
 * Solo el delta (slim D-7): claves cuyo valor `trim()` difiere de lo leído. Un campo vaciado a mano
 * no viaja (no hay «borrar lectura» en el contrato). `undefined` si no hay ninguna.
 */
export function deltaCampos(campos: readonly Pick<CampoComprobanteDto, 'campo' | 'valor'>[], valores: Readonly<Record<string, string>>): Record<string, string> | undefined {
  const delta: Record<string, string> = {};
  for (const c of campos) {
    if (!esCampoEditable(c.campo)) continue;
    const v = (valores[c.campo] ?? '').trim();
    if (v !== '' && v !== (c.valor ?? '')) delta[c.campo] = v;
  }
  return Object.keys(delta).length ? delta : undefined;
}

/**
 * Abre en otra pestaña el archivo de un comprobante (`GET /:id/archivo`, que exige token y redirige
 * a S3 prefirmado: no sirve como `href`). Con `aplicado` pide el soporte hijo que vio el destino
 * (`?aplicado=1`, AC6 de #12634). La pestaña se abre ANTES del `await` para que el bloqueador de
 * ventanas no la trague; si la descarga falla se cierra y el error sube a quien llamó.
 */
export async function abrirArchivoComprobante(id: string, aplicado = false): Promise<void> {
  const ventana = window.open('', '_blank');
  try {
    const blob = await api.get<Blob>(`${RUTA_COMPROBANTES}/${id}/archivo${aplicado ? '?aplicado=1' : ''}`);
    const url = URL.createObjectURL(blob);
    if (ventana) ventana.location.href = url; else window.open(url, '_blank', 'noopener');
  } catch (e) {
    ventana?.close();
    throw e;
  }
}

/**
 * AC8 (deuda de #12612): si el archivo es PDF lo dice el `contentType` del DTO o la cabecera
 * `%PDF` del blob, nunca `blob.type` (un `route.fulfill` o un proxy sin Content-Type lo deja vacío).
 */
export async function esPdfArchivo(contentType: string | null | undefined, blob: Blob): Promise<boolean> {
  if (contentType && contentType.toLowerCase().includes('pdf')) return true;
  try {
    const cabecera = await blob.slice(0, 5).text();
    return cabecera.startsWith('%PDF');
  } catch {
    return false;
  }
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

/** AC4 (deuda de #12612): un PDF que pdf.js no termina de abrir en 10 s cuenta 1 y la carga sigue. */
export const PDF_CONTEO_TIMEOUT_MS = 10_000;
const COPY_CONTEO_AGOTADO = `[comprobantes] pdf.js no abrió un PDF en ${PDF_CONTEO_TIMEOUT_MS / 1000} s: se cuenta como una página y el servidor decide.`;

const tiempoAgotado = (ms: number) => new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); });

export async function contarPaginasPdf(archivo: File): Promise<number> {
  const esPdf = archivo.type === 'application/pdf' || archivo.name.toLowerCase().endsWith('.pdf');
  if (!esPdf) return 1;
  let tarea: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | null = null;
  let colgado = false;
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
    workerCompartido ??= new pdfjs.PDFWorker();
    tarea = pdfjs.getDocument({ data: new Uint8Array(await archivo.arrayBuffer()), worker: workerCompartido });
    // `Promise.race`: un worker colgado (script que nunca llega, lector roto) no puede bloquear la
    // selección ni el envío. Se registra sin nombre de archivo ni contenido.
    const doc = await Promise.race([tarea.promise, tiempoAgotado(PDF_CONTEO_TIMEOUT_MS)]);
    if (doc === null) {
      colgado = true;
      console.warn(COPY_CONTEO_AGOTADO);
      // El worker que no respondió no sirve para el siguiente archivo: se suelta y se crea otro.
      workerCompartido.destroy();
      workerCompartido = null;
      return 1;
    }
    return doc.numPages;
  } catch {
    return 1;
  } finally {
    // Un worker colgado tampoco responde al `destroy`: no se le espera (ya se esperó lo pactado).
    const destruir = tarea?.destroy().catch(() => undefined);
    if (!colgado) await destruir;
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
