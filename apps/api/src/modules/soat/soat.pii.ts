// SOAT legacy — registro de acceso a datos personales (Ley 1581 art. 17, AGENTS.md §16).
//
// Listado y export de `soat_requests`. Fallan ABIERTO: la regla está en la cabecera de
// `shared/pii-audit.ts`. Registran también con 0 filas, y el motivo solo lleva el conteo: ningún
// filtro ni valor de la consulta.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';

const RECURSO = 'soat_request';

/** Lo que entrega `GET /api/soat`, con el nombre de la columna en la base. */
export const CAMPOS_PII_LISTADO_SOAT = ['owner_name', 'owner_document', 'plate', 'vin', 'soat_holder', 'notes'] as const;

/** Lo que entrega `GET /api/soat/export`: el archivo no lleva `soat_holder` ni `notes`. */
export const CAMPOS_PII_EXPORT_SOAT = ['owner_name', 'owner_document', 'plate', 'vin'] as const;

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

function motivoFilas(filas: number): string {
  return `filas=${filas}`.slice(0, MOTIVO_MAX);
}

export async function registrarListadoSolicitudesSoat(req: Request, filas: number): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO,
    resourceId: null,
    accion: 'search',
    camposAccedidos: [...CAMPOS_PII_LISTADO_SOAT],
    motivo: motivoFilas(filas),
  });
}

export async function registrarExportSolicitudesSoat(req: Request, filas: number): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO,
    resourceId: null,
    accion: 'export',
    camposAccedidos: [...CAMPOS_PII_EXPORT_SOAT],
    motivo: motivoFilas(filas),
  });
}
