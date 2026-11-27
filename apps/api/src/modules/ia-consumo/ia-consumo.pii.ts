// Épica #14548 (ADR-0051) — Lo que el visor escribe en `pii_access_log` (Ley 1581, AGENTS §16). Solo nombres, claves y
// formatos: el valor de un filtro, un motivo libre o el texto de un registro nunca llegan a la auditoría ni a un log.
// Búsqueda y detalle son vía abierta (`logPiiAccess`): si la escritura falla, la respuesta sale y el fallo queda en el log.
import type { Request } from 'express';
import { loggerFor } from '../../shared/logger.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import type { FiltrosIaEntrada } from './ia-consumo.esquemas.js';

const log = loggerFor('ia-consumo-visor');

export const RECURSO_IA_LOG = 'ia_consumo_log';

/**
 * Vía abierta (AGENTS §16): si el registro no se puede escribir, la respuesta sale igual y el fallo queda en el log.
 * `logPiiAccess` ya absorbe sus errores; este `catch` es el cinturón del contrato, y no registra ningún valor.
 */
function viaAbierta(escritura: Promise<void>): Promise<void> {
  return escritura.catch((e: unknown) => {
    log.error({ err: e instanceof Error ? e.message : undefined }, 'fallo escribiendo pii_access_log (visor de IA)');
  });
}

/** Claves de filtro con datos personales. En la auditoría viaja la clave, nunca el valor. */
const CLAVES_PII = ['usuario', 'placa', 'entidad'] as const;

/** Columnas personales que proyecta la lista (`ia_consumo_log`). */
const CAMPOS_PII_LISTA = ['usuario_id', 'usuario_login', 'placa', 'entidad_id'];

/** Lo que el detalle añade a la lista: el mensaje de error, y los metadatos solo si se devuelven. */
const CAMPO_PII_ERROR = 'error_mensaje';
const CAMPO_PII_METADATOS = 'metadatos';

/** Las claves de filtro con datos personales que vinieron en la búsqueda. */
export function clavesPiiDe(filtros: FiltrosIaEntrada | undefined): string[] {
  return CLAVES_PII.filter((clave) => filtros?.[clave] !== undefined);
}

/** `filas=<n> filtros_pii=<claves>` (`pii_access_log.motivo` es varchar(200); aquí cabe de sobra). */
export function motivoBusqueda(filas: number, claves: readonly string[]): string {
  return `filas=${filas} filtros_pii=${claves.length > 0 ? claves.join(',') : 'ninguno'}`;
}

/** Auditoría de una búsqueda, con o sin filas: una petición válida que proyecta datos personales queda registrada. */
export function auditarBusqueda(req: Request, filas: number, claves: readonly string[]): Promise<void> {
  return viaAbierta(logPiiAccess(req, {
    resourceTipo: RECURSO_IA_LOG,
    resourceId: null,
    accion: 'search',
    camposAccedidos: CAMPOS_PII_LISTA,
    motivo: motivoBusqueda(filas, claves),
  }));
}

/** Auditoría de un detalle: `id:<uuid>` como motivo (el id es técnico, no personal). */
export function auditarDetalle(req: Request, id: string, conMetadatos: boolean): Promise<void> {
  return viaAbierta(logPiiAccess(req, {
    resourceTipo: RECURSO_IA_LOG,
    resourceId: null,
    accion: 'read',
    camposAccedidos: [...CAMPOS_PII_LISTA, CAMPO_PII_ERROR, ...(conMetadatos ? [CAMPO_PII_METADATOS] : [])],
    motivo: `id:${id}`,
  }));
}
