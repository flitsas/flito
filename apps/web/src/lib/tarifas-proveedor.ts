// FLITO — Tarifas › Proveedores (Épica #13763, ADR-0041 §6). Lo que cada proveedor le cobra a FLITO.
//
// Cliente de datos del modo Proveedores. Todo pasa por `api` (`src/lib/api.ts`): aquí solo se arman
// las rutas, se leen los códigos de error del contrato y se valida el valor antes de escribir.
// El id de la URL es el `uuid` opaco de `flito_proveedores`; ningún nombre ni NIT sale a una URL.

import {
  ETIQUETA_CONCEPTO_COSTO, MENSAJE_VALOR_COSTO_INVALIDO,
  type CambiarCostoProveedorBody, type ConceptoCostoProveedor, type FilaCostoProveedor, type FijarCostoProveedorBody,
  type ResultadoCambioCostoProveedor, type ResumenProveedorCostos, type VigenciaCostoProveedor, type VistaCostosProveedor,
} from '@operaciones/shared-types';
import { api, ApiError } from './api';

export const RUTA_TARIFAS_PROVEEDORES = '/flito/parametrizacion/tarifas-proveedores';
/** Ruta de la página (SPA), no del API. */
export const PAGINA_PROVEEDORES = '/flito/tarifas/proveedores';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (s: string | undefined): s is string => !!s && UUID.test(s);

export const tarifasProveedorApi = {
  listar: () => api.get<ResumenProveedorCostos[]>(RUTA_TARIFAS_PROVEEDORES),
  vista: (proveedorId: string) =>
    api.get<VistaCostosProveedor>(`${RUTA_TARIFAS_PROVEEDORES}/${encodeURIComponent(proveedorId)}`),
  historial: (proveedorId: string, concepto: ConceptoCostoProveedor | null) =>
    api.get<VigenciaCostoProveedor[]>(
      `${RUTA_TARIFAS_PROVEEDORES}/${encodeURIComponent(proveedorId)}/historial${concepto ? `?concepto=${concepto}` : ''}`,
    ),
  fijar: (proveedorId: string, cuerpo: FijarCostoProveedorBody) =>
    api.post<VigenciaCostoProveedor>(`${RUTA_TARIFAS_PROVEEDORES}/${encodeURIComponent(proveedorId)}/vigencias`, cuerpo),
  cambiar: (vigenciaId: string, cuerpo: CambiarCostoProveedorBody) =>
    api.patch<ResultadoCambioCostoProveedor>(`${RUTA_TARIFAS_PROVEEDORES}/vigencias/${encodeURIComponent(vigenciaId)}`, cuerpo),
};

/** Código de negocio del cuerpo de error (`{ error, code }`), si lo trae. */
export function codigoError(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const raw = (e.rawDetails ?? null) as { code?: unknown } | null;
  return raw && typeof raw.code === 'string' ? raw.code : null;
}

export const estadoError = (e: unknown): number => (e instanceof ApiError ? e.status : 0);

export const etiquetaConcepto = (c: ConceptoCostoProveedor): string => ETIQUETA_CONCEPTO_COSTO[c];

/** Frase de validación tal como la pinta la web (el 400 del API trae la misma sin punto final). */
export const MENSAJE_VALOR_INVALIDO = `${MENSAJE_VALOR_COSTO_INVALIDO}.`;

export type ValorLeido = { ok: true; valor: number } | { ok: false; mensaje: string };

/**
 * Pesos enteros, sin IVA ni decimales. Acepta `45000` y `45.000` (punto de miles bien agrupado).
 * Vacío, negativo, texto o decimales → el mensaje único de la spec.
 */
export function leerValorPesos(texto: string): ValorLeido {
  const limpio = texto.trim().replace(/^\$\s*/, '');
  if (!/^(\d+|\d{1,3}(\.\d{3})+)$/.test(limpio)) return { ok: false, mensaje: MENSAJE_VALOR_INVALIDO };
  const valor = Number(limpio.replace(/\./g, ''));
  if (!Number.isSafeInteger(valor) || valor < 0) return { ok: false, mensaje: MENSAJE_VALOR_INVALIDO };
  return { ok: true, valor };
}

export interface GrupoConceptos { titulo: string; filas: FilaCostoProveedor[] }

/** LOGÍSTICA primero, luego SOAT; solo los servicios que el proveedor tiene hoy (los manda el servidor). */
export function agruparFilas(filas: FilaCostoProveedor[]): GrupoConceptos[] {
  const orden: Array<{ servicio: FilaCostoProveedor['servicio']; titulo: string }> = [
    { servicio: 'logistica', titulo: 'Logística' },
    { servicio: 'soat', titulo: 'SOAT' },
  ];
  return orden
    .map(({ servicio, titulo }) => ({ titulo, filas: filas.filter((f) => f.servicio === servicio) }))
    .filter((g) => g.filas.length > 0);
}
