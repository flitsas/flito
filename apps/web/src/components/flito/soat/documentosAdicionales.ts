// FLITO — documentos adicionales del SOAT (HU #13363): reglas, copy y formateadores compartidos.
//
// Spec: docs/ux/flito-soat-documentos-adicionales.md §3.3, §3.4, §5. Un solo módulo para el selector
// del alta, el toast del 201, la tarjeta del 202 y la lista del detalle — y para la HU #13365, que
// monta el mismo selector en el detalle (contexto `'detalle'`, cupos por carga, sin `presentes`).
//
// Los descartes del servidor se traducen **por `codigo`** (`MotivoDescarteDocumentoAdicional`),
// nunca por su `motivo` de texto: ese texto es del servidor y cambia con cualquier corrección de
// estilo. Un código desconocido cae al genérico.
//
// Límites: los mismos que aplica el backend de la HU #13362 (`flito-soat-documentos.upload.ts`). La
// validación en pantalla es una ayuda para no mandar lo que el servidor va a rechazar; quien decide
// es él (revisa el contenido real, no la extensión).
import { MotivoDescarteDocumentoAdicional, type ResultadoDocumentosAdicionales } from '@operaciones/shared-types';

const MB = 1024 * 1024;
/** 15 MB por archivo, inclusivo: exactamente 15 MB entra. */
export const MAX_BYTES_ADICIONAL = 15 * MB;
export const MAX_ADICIONALES = 20;
export const MAX_TOTAL_ADICIONALES = 250 * MB;
/** Largo de la columna `etiqueta varchar(150)` (`LARGO_ETIQUETA` del servicio de la #13362). */
export const LARGO_ETIQUETA_ADICIONAL = 150;

/**
 * Tope de la llamada de alta cuando lleva adicionales (decisión de David, 2026-10-07): 10 minutos,
 * solo para ESA llamada vía `api.postConTimeout`. El default de 90 s del resto de la app no cambia.
 * Con 250 MB en una conexión móvil lenta, 90 s acababa en un falso error con la solicitud guardada.
 */
export const TIMEOUT_ALTA_CON_ADICIONALES_MS = 600_000;

/** Sugerencia del diálogo del sistema; no es la validación (ver `validarAdicionales`). */
export const ACCEPT_ADICIONALES =
  '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif';

const EXTENSIONES = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/** Un archivo elegido en el selector. `motivo` presente = no se va a adjuntar. */
export interface ElegidoAdicional {
  /** Clave estable de la fila (React y foco). No viaja. */
  clave: string;
  archivo: File;
  etiqueta: string;
  motivo?: MotivoDescarteDocumentoAdicional;
}

/** Lo mínimo para comparar cupos y repetidos: un archivo elegido o un documento ya guardado. */
export interface PresenteAdicional { nombre: string; tamanoBytes: number }

let secuencia = 0;
const nuevaClave = () => `adic-${++secuencia}`;

function extension(nombre: string): string {
  const i = nombre.lastIndexOf('.');
  return i < 0 ? '' : nombre.slice(i + 1).toLowerCase();
}

/** Por extensión **y** tipo. Un tipo vacío o genérico no descalifica: HEIC suele llegar sin tipo. */
function formatoPermitido(archivo: File): boolean {
  if (!EXTENSIONES.has(extension(archivo.name))) return false;
  const tipo = archivo.type.toLowerCase();
  return tipo === '' || tipo === 'application/octet-stream' || MIMES.has(tipo);
}

/**
 * Valida `nuevos` **en el orden de elección** (§3.3). Los cupos de 20 y de 250 MB los consumen los
 * válidos que llegaron antes, empezando por `presentes` (los ya válidos en la lista, o los ya
 * guardados en la #13365). `ajenos` solo cuentan para «repetido» (la factura de venta del alta: el
 * mismo archivo no se adjunta dos veces, pero no gasta cupo de adicionales).
 */
export function validarAdicionales(
  nuevos: File[], presentes: PresenteAdicional[] = [], ajenos: PresenteAdicional[] = [],
): ElegidoAdicional[] {
  const vistos = [...presentes, ...ajenos];
  let cantidad = presentes.length;
  let total = presentes.reduce((s, p) => s + p.tamanoBytes, 0);
  return nuevos.map((archivo) => {
    const fila: ElegidoAdicional = { clave: nuevaClave(), archivo, etiqueta: '' };
    const repetido = vistos.some((v) => v.nombre === archivo.name && v.tamanoBytes === archivo.size);
    if (!formatoPermitido(archivo)) fila.motivo = MotivoDescarteDocumentoAdicional.FORMATO_NO_PERMITIDO;
    else if (archivo.size > MAX_BYTES_ADICIONAL) fila.motivo = MotivoDescarteDocumentoAdicional.SUPERA_TAMANO;
    else if (repetido) fila.motivo = MotivoDescarteDocumentoAdicional.DOCUMENTO_REPETIDO;
    else if (cantidad >= MAX_ADICIONALES) fila.motivo = MotivoDescarteDocumentoAdicional.SUPERA_CANTIDAD;
    else if (total + archivo.size > MAX_TOTAL_ADICIONALES) fila.motivo = MotivoDescarteDocumentoAdicional.SUPERA_TOTAL;
    else {
      cantidad += 1;
      total += archivo.size;
      vistos.push({ nombre: archivo.name, tamanoBytes: archivo.size });
    }
    return fila;
  });
}

export const validos = (lista: ElegidoAdicional[]) => lista.filter((e) => !e.motivo);
export const aPresentes = (lista: ElegidoAdicional[]): PresenteAdicional[] =>
  lista.map((e) => ({ nombre: e.archivo.name, tamanoBytes: e.archivo.size }));

/**
 * Suma los válidos al multipart: archivos en `documentosAdicionales` y etiquetas en
 * `etiquetasDocumentosAdicionales`, **alineadas por índice** (la vacía viaja vacía y el servidor usa
 * el nombre del archivo). Sin válidos no añade nada: el alta es la de siempre (AC1).
 */
export function adjuntarAdicionales(form: FormData, lista: ElegidoAdicional[]): number {
  const ok = validos(lista);
  for (const e of ok) {
    form.append('documentosAdicionales', e.archivo);
    form.append('etiquetasDocumentosAdicionales', e.etiqueta.trim().slice(0, LARGO_ETIQUETA_ADICIONAL));
  }
  return ok.length;
}

// ── Copy ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Dónde se monta el selector: el alta (#13363) o la carga posterior desde el detalle (#13365). En el
 * detalle los cupos son **por carga** (no hay techo acumulado), y el copy lo dice (spec #13365 §4).
 */
export type ContextoAdicionales = 'alta' | 'detalle';

const MB_MAX_TOTAL = MAX_TOTAL_ADICIONALES / MB;

/** El motivo en pantalla (frase completa, con punto). Validación local del selector. */
export function motivoEnPantalla(codigo: string, contexto: ContextoAdicionales = 'alta'): string {
  const detalle = contexto === 'detalle';
  switch (codigo) {
    case MotivoDescarteDocumentoAdicional.FORMATO_NO_PERMITIDO: return 'Formato no permitido. Use PDF, JPG, PNG, WEBP o HEIC.';
    case MotivoDescarteDocumentoAdicional.SUPERA_TAMANO: return 'Pesa más de 15 MB.';
    case MotivoDescarteDocumentoAdicional.SUPERA_CANTIDAD:
      return detalle ? `Se cargan hasta ${MAX_ADICIONALES} archivos a la vez.` : 'Ya hay 20 archivos, que es el máximo.';
    case MotivoDescarteDocumentoAdicional.SUPERA_TOTAL:
      return detalle ? `Con este archivo la carga pasaría de ${MB_MAX_TOTAL} MB.` : 'Con este archivo se superarían los 250 MB en total.';
    case MotivoDescarteDocumentoAdicional.DOCUMENTO_REPETIDO: return 'Ya lo eligió.';
    default: return 'No se pudo adjuntar este archivo.';
  }
}

/**
 * El motivo de un descarte **del servidor**, dentro de una frase: minúscula y sin punto. El repetido
 * dice «ya estaba en la solicitud» y no «ya lo eligió»: el servidor lo detecta por contenido, aunque
 * el nombre fuera otro (§3.4).
 */
export function motivoEnFrase(codigo: string): string {
  switch (codigo) {
    case MotivoDescarteDocumentoAdicional.FORMATO_NO_PERMITIDO: return 'formato no permitido';
    case MotivoDescarteDocumentoAdicional.SUPERA_TAMANO: return 'pesa más de 15 MB';
    case MotivoDescarteDocumentoAdicional.SUPERA_CANTIDAD: return 'superaba el máximo de 20 archivos';
    case MotivoDescarteDocumentoAdicional.SUPERA_TOTAL: return 'superaba los 250 MB en total';
    case MotivoDescarteDocumentoAdicional.DOCUMENTO_REPETIDO: return 'ya estaba en la solicitud';
    default: return 'no se pudo adjuntar';
  }
}

type Descartado = ResultadoDocumentosAdicionales['descartados'][number];

const documentos = (n: number) => (n === 1 ? '1 documento' : `${n} documentos`);

/** Toast del 201 con descartes (§3.4): uno solo, que sustituye al de éxito. Máximo 3 nombres. */
export function textoToastDescartes(descartados: Descartado[]): string {
  const n = descartados.length;
  const lineas = descartados.slice(0, 3).map((d) => `— ${d.nombreArchivo}: ${motivoEnFrase(d.codigo)}.`);
  if (n > 3) lineas.push(`y ${n - 3} más.`);
  return [
    'Su solicitud se envió.',
    `No se ${n === 1 ? 'adjuntó' : 'adjuntaron'} ${documentos(n)}:`,
    ...lineas,
    'La solicitud sigue su curso sin ellos.',
  ].join('\n');
}

/** Línea de estado de la barra mientras viaja un alta con adicionales (§3.4). */
export function textoEnviandoAdicionales(n: number): string {
  return `Enviando la solicitud y ${documentos(n)}… puede tardar si son pesados.`;
}

// ── Copy de la carga y la eliminación desde el detalle (HU #13365, spec §3.3–§3.6, §5.3) ─────────

/** Toast de la carga limpia. */
export function textoCargados(n: number): string {
  return n === 1 ? 'Se cargó 1 documento.' : `Se cargaron ${n} documentos.`;
}

/** Línea `role="status"` mientras viaja la carga. */
export function textoGuardandoAdicionales(n: number): string {
  return `Guardando ${documentos(n)}… puede tardar si son pesados.`;
}

/** Encabezado del aviso de descartes. */
export function textoResumenDescartes(aceptados: number, total: number): string {
  return aceptados === 0 ? 'No se cargó ningún documento.' : `Se cargaron ${aceptados} de ${total} documentos.`;
}

/** Error de la carga por estado HTTP; `reintentable` = se ofrece «Reintentar». Nunca el texto del servidor. */
export function errorDeCarga(status: number): { texto: string; reintentable: boolean } {
  if (status === 429) return { texto: 'Se hicieron muchas cargas seguidas. Espere unos minutos e intente de nuevo.', reintentable: true };
  if (status === 413) return { texto: 'Son demasiados archivos para una sola carga. Quite algunos e intente de nuevo.', reintentable: true };
  if (status === 403) return { texto: 'Este usuario ya no tiene permiso para cargar documentos.', reintentable: false };
  if (status === 404) return { texto: 'Esta solicitud ya no está disponible. Cierre el detalle y vuelva a abrirlo.', reintentable: false };
  return { texto: 'No se pudieron guardar los documentos. Intente de nuevo.', reintentable: true };
}

/** Error de la eliminación por estado HTTP (el 404 no es error: la fila se quita). */
export function errorDeEliminacion(status: number): { texto: string; reintentable: boolean } {
  if (status === 429) return { texto: 'Se hicieron muchos cambios seguidos. Espere unos minutos e intente de nuevo.', reintentable: true };
  if (status === 403) return { texto: 'Este usuario ya no tiene permiso para eliminar documentos.', reintentable: false };
  return { texto: 'No se pudo eliminar. Intente de nuevo.', reintentable: true };
}

/** Línea de la tarjeta del 202 con aceptados (§3.4). */
export function textoGuardados(n: number): string {
  return n === 1
    ? 'Junto con la solicitud guardamos 1 documento adicional.'
    : `Junto con la solicitud guardamos ${n} documentos adicionales.`;
}

// ── Formateadores ───────────────────────────────────────────────────────────────────────────────

const TIPO_POR_MIME: Record<string, string> = {
  'application/pdf': 'PDF', 'image/jpeg': 'Imagen JPG', 'image/png': 'Imagen PNG',
  'image/webp': 'Imagen WEBP', 'image/heic': 'HEIC', 'image/heif': 'HEIF',
};
const TIPO_POR_EXTENSION: Record<string, string> = {
  pdf: 'PDF', jpg: 'Imagen JPG', jpeg: 'Imagen JPG', png: 'Imagen PNG', webp: 'Imagen WEBP', heic: 'HEIC', heif: 'HEIF',
};

/** «PDF», «Imagen JPG»… Nunca el MIME. Sin tipo reconocible, la extensión en mayúscula. */
export function tipoLegible(tipoContenido: string, nombre = ''): string {
  return TIPO_POR_MIME[tipoContenido.toLowerCase()]
    ?? TIPO_POR_EXTENSION[extension(nombre)]
    ?? (extension(nombre).toUpperCase() || 'Archivo');
}

/** HEIC/HEIF no tienen vista previa en el navegador (§4.1). */
export function tieneVistaPrevia(tipoContenido: string): boolean {
  const t = tipoContenido.toLowerCase();
  return t !== 'image/heic' && t !== 'image/heif';
}

/** `1,2 MB`; por debajo de 0,1 MB, `85 KB`. */
export function tamanoLegible(bytes: number): string {
  if (bytes < 0.1 * MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / MB).toFixed(1).replace('.', ',')} MB`;
}

const FORMATO_BOGOTA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** `dd/mm/aaaa hh:mm` en hora de Colombia, sin depender del huso de la máquina. */
export function fechaHoraBogota(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = Object.fromEntries(FORMATO_BOGOTA.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
