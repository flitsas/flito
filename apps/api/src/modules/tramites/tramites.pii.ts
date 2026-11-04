// Trámites legacy y bandeja de tránsito — registro de acceso a datos personales (Ley 1581 art. 17,
// AGENTS.md §16).
//
// Fallan ABIERTO: la regla está en la cabecera de `shared/pii-audit.ts`. Los listados registran
// también con 0 filas. El motivo solo lleva ids, conteos y el catálogo de tipos: `req.query.search`,
// la placa y el nombre son lo que este registro protege y nunca entran ahí.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';

const RECURSO_TRAMITE = 'tramite';

/**
 * Columnas personales de `tramites_digitales` que salen en un `select *`.
 *
 * `vehiculo` es personal porque lleva `_vendedor`, y `comprador` y `validacion_identidad` identifican
 * al titular. `documentos` (jsonb) no está: ningún flujo del repo escribe esa columna con datos del
 * titular, los archivos van en `tramites_documentos` y se declaran como `original_name`.
 */
export const CAMPOS_PII_TRAMITE = ['vin', 'placa', 'vehiculo', 'comprador', 'validacion_identidad', 'notas', 'workflow'] as const;

/** `GET /api/tramites/:id` añade los archivos del trámite, con su nombre original. */
export const CAMPOS_PII_TRAMITE_DETALLE = [...CAMPOS_PII_TRAMITE, 'original_name'] as const;

/** Lo que proyecta `GET /api/transito/traspasos`. */
export const CAMPOS_PII_TRASPASOS = ['vin', 'placa', 'vehiculo', 'comprador'] as const;

/** Lo que proyecta `GET /api/transito/traspasos/:id`. */
export const CAMPOS_PII_TRASPASO_DETALLE = [...CAMPOS_PII_TRASPASOS, 'notas', 'workflow'] as const;

/** La descarga de un documento del expediente. */
export const CAMPOS_PII_ARCHIVO = ['contenido_archivo', 'original_name'] as const;

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

export async function registrarLecturaCola(req: Request, filas: number): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO_TRAMITE,
    resourceId: null,
    accion: 'search',
    camposAccedidos: [...CAMPOS_PII_TRAMITE],
    motivo: `filas=${filas}`.slice(0, MOTIVO_MAX),
  });
}

export async function registrarLecturaTramite(req: Request, id: number): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO_TRAMITE,
    resourceId: id,
    accion: 'read',
    camposAccedidos: [...CAMPOS_PII_TRAMITE_DETALLE],
  });
}

export async function registrarLecturaArchivo(
  req: Request,
  doc: { tramiteId: number; docId: number; tipo: string },
): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: 'tramite_doc',
    resourceId: doc.docId,
    accion: 'read',
    camposAccedidos: [...CAMPOS_PII_ARCHIVO],
    motivo: `tramite ${doc.tramiteId} · tipo=${doc.tipo}`.slice(0, MOTIVO_MAX),
  });
}

export async function registrarLecturaBandejaTransito(
  req: Request,
  origen: 'pendientes' | 'mis-tramites',
  filas: number,
): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO_TRAMITE,
    resourceId: null,
    accion: 'search',
    camposAccedidos: [...CAMPOS_PII_TRAMITE],
    motivo: `origen=${origen} · filas=${filas}`.slice(0, MOTIVO_MAX),
  });
}

export async function registrarLecturaTraspasos(req: Request, filas: number): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO_TRAMITE,
    resourceId: null,
    accion: 'search',
    camposAccedidos: [...CAMPOS_PII_TRASPASOS],
    motivo: `origen=traspasos · filas=${filas}`.slice(0, MOTIVO_MAX),
  });
}

export async function registrarLecturaTraspaso(req: Request, id: number): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO_TRAMITE,
    resourceId: id,
    accion: 'read',
    camposAccedidos: [...CAMPOS_PII_TRASPASO_DETALLE],
    motivo: 'origen=traspasos',
  });
}
