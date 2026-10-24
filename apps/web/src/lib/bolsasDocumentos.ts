// Expediente documental de la compañía (HU #13892, Feature #13888; ADR-0028, spec
// `docs/ux/flito-bolsas-expediente-documental.md`). Etiquetas, género y validación local en un solo
// sitio: la concordancia («Expedida»/«Expedido», «cargada»/«cargado») no se decide en cada componente.

import {
  MIMES_DOCUMENTO_BOLSA, TAMANO_MAX_DOCUMENTO_BOLSA, TIPOS_DOCUMENTO_BOLSA_CON_VIGENCIA,
  type EstadoDocumentoBolsa, type TipoDocumentoBolsa,
} from '@operaciones/shared-types';
import type { ChipTone } from '../components/flit/StatusChip';

/** Funciones del árbol de permisos (ADR-0025). Ningún rol las trae por seed. */
export const FUNCION_VER_DOCUMENTOS_BOLSA = 'bolsas.documentos.ver';
export const FUNCION_CARGAR_DOCUMENTOS_BOLSA = 'bolsas.documentos.cargar';

const ETIQUETAS: Record<TipoDocumentoBolsa, { nombre: string; femenino: boolean }> = {
  camara_comercio: { nombre: 'Cámara de Comercio', femenino: true },
  rut: { nombre: 'RUT', femenino: false },
  cedula_representante: { nombre: 'Cédula del representante legal', femenino: true },
  certificado_bancario: { nombre: 'Certificado bancario', femenino: false },
  adicional: { nombre: 'Documento adicional', femenino: false },
};

/** Nombre corto, para frases («Descargar RUT», «RUT cargado.»). */
export const nombreDocumento = (tipo: TipoDocumentoBolsa): string => ETIQUETAS[tipo].nombre;

/** Nombre del encabezado de la fila: el adicional dice que es opcional. */
export const tituloDocumento = (tipo: TipoDocumentoBolsa): string =>
  (tipo === 'adicional' ? `${ETIQUETAS[tipo].nombre} (opcional)` : ETIQUETAS[tipo].nombre);

/** Concordancia de género: `participio('rut', 'expedid')` → «expedido». */
export const participio = (tipo: TipoDocumentoBolsa, raiz: string): string =>
  `${raiz}${ETIQUETAS[tipo].femenino ? 'a' : 'o'}`;

export const conVigencia = (tipo: TipoDocumentoBolsa): boolean =>
  (TIPOS_DOCUMENTO_BOLSA_CON_VIGENCIA as readonly string[]).includes(tipo);

export const ESTADO_DOCUMENTO: Record<EstadoDocumentoBolsa, { tono: ChipTone; texto: string }> = {
  pendiente: { tono: 'neutral', texto: 'Pendiente' },
  validando: { tono: 'active', texto: 'Validando…' },
  valido: { tono: 'success', texto: 'Válido' },
  vencido: { tono: 'warning', texto: 'Vigencia vencida' },
  no_validado: { tono: 'warning', texto: 'No se pudo validar' },
};

/** `accept` del input: extensión y MIME, para que el selector del sistema filtre en ambos. */
export const ACCEPT_DOCUMENTO_BOLSA = `.pdf,.jpg,.jpeg,.png,${MIMES_DOCUMENTO_BOLSA.join(',')}`;

const EXTENSIONES = ['pdf', 'jpg', 'jpeg', 'png'];

/**
 * Validación local antes del POST (AC7). El servidor revisa el MIME real; aquí se evita subir 16 MB
 * para que los rechace. Si el navegador no da tipo, manda la extensión.
 */
export function errorArchivoLocal(archivo: File): string | null {
  const ext = archivo.name.split('.').pop()?.toLowerCase() ?? '';
  const tipoOk = archivo.type
    ? (MIMES_DOCUMENTO_BOLSA as readonly string[]).includes(archivo.type)
    : EXTENSIONES.includes(ext);
  if (!tipoOk) return 'Ese formato no se acepta. Usa PDF, JPG o PNG.';
  if (archivo.size > TAMANO_MAX_DOCUMENTO_BOLSA) {
    const mb = (archivo.size / (1024 * 1024)).toLocaleString('es-CO', { maximumFractionDigits: 1 });
    const max = Math.round(TAMANO_MAX_DOCUMENTO_BOLSA / (1024 * 1024));
    return `El archivo pesa ${mb} MB. El máximo es ${max} MB.`;
  }
  return null;
}

/** Sondeo de «Validando…» (ADR-0028 §8): cada 5 s, tope 2 min, 3 fallos seguidos lo detienen. */
export const SONDEO_INTERVALO_MS = 5_000;
export const SONDEO_TOPE_MS = 120_000;
export const SONDEO_FALLOS_MAX = 3;

/** Día calendario en Bogotá de un instante (timestamp): `fechaDia` corta el ISO en UTC y se iría al día siguiente de noche. */
export function diaBogota(instante: string | null): string | null {
  if (!instante) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(instante));
}

const EXT_POR_MIME: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** Nombre de respaldo de la descarga, con la forma que declara el API (`<tipo>-v<n>.<ext>`). */
export const nombreRespaldo = (tipo: TipoDocumentoBolsa, version: number, mime: string): string =>
  `${tipo}-v${version}.${EXT_POR_MIME[mime] ?? 'pdf'}`;

/** «del RUT» / «de la Cámara de Comercio». */
export const delDocumento = (tipo: TipoDocumentoBolsa): string =>
  `${ETIQUETAS[tipo].femenino ? 'de la' : 'del'} ${ETIQUETAS[tipo].nombre}`;

/**
 * Chip del listado de bolsas (HU #13893). `warning` cubre todo lo que no es completo (falta uno,
 * vencido, no se pudo validar, validando): el porqué está en el detalle, no en el listado.
 */
export const CHIP_EXPEDIENTE: Record<'completo' | 'pendiente', { tono: ChipTone; texto: string; title?: string }> = {
  completo: { tono: 'success', texto: 'Docs completos' },
  pendiente: { tono: 'warning', texto: 'Docs pendientes', title: 'Revisa el expediente en el detalle de la bolsa.' },
};
