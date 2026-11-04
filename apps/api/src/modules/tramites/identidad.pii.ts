// Validación de identidad — registro de acceso a datos personales (Ley 1581 art. 17, AGENTS.md §16).
//
// Fotos biométricas y certificado fallan CERRADO: sin fila no se entregan. El estado (polling de la
// bandeja) falla ABIERTO. La regla completa está en la cabecera de `shared/pii-audit.ts`.
//
// Una consulta sin registros no escribe fila: no proyectó nada de nadie. `resource_id` es el trámite.

import type { Request } from 'express';
import { logPiiAccess, logPiiAccessOrThrow } from '../../shared/pii-audit.js';

/** Las tres capturas de `tramites_validaciones`: son los datos biométricos del titular. */
const FOTOS = ['foto_rostro', 'foto_cedula_frontal', 'foto_cedula_reverso'] as const;

/** Lo que entrega `GET /documentos/:tramiteId`, con el nombre de la columna en la base. */
export const CAMPOS_PII_DOCUMENTOS = [
  ...FOTOS, 'nombre', 'tipo_doc', 'documento', 'detalle', 'ip_address', 'ciudad_geo', 'lat', 'lng',
] as const;

/** Lo que imprime el certificado: lo anterior más el correo, la placa y el dispositivo de la sesión. */
export const CAMPOS_PII_CERTIFICADO = [...CAMPOS_PII_DOCUMENTOS, 'email', 'placa', 'user_agent'] as const;

/** Lo que entrega `GET /estado/:tramiteId`. */
export const CAMPOS_PII_ESTADO = ['nombre', 'documento', 'email'] as const;

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

function motivoFilas(filas: number): string {
  return `filas=${filas}`.slice(0, MOTIVO_MAX);
}

/** Lanza `PiiAccessLogError` si no se pudo escribir: quien llama no entrega las fotos. */
export async function registrarLecturaDocumentos(req: Request, tramiteId: number, filas: number): Promise<void> {
  await logPiiAccessOrThrow(req, {
    resourceTipo: 'validacion_identidad',
    resourceId: tramiteId,
    accion: 'decrypt',
    camposAccedidos: [...CAMPOS_PII_DOCUMENTOS],
    motivo: motivoFilas(filas),
  });
}

/** Lanza `PiiAccessLogError` si no se pudo escribir: quien llama no entrega el PDF. */
export async function registrarLecturaCertificado(req: Request, tramiteId: number, filas: number): Promise<void> {
  await logPiiAccessOrThrow(req, {
    resourceTipo: 'certificado_identidad',
    resourceId: tramiteId,
    accion: 'export',
    camposAccedidos: [...CAMPOS_PII_CERTIFICADO],
    motivo: motivoFilas(filas),
  });
}

export async function registrarLecturaEstado(req: Request, tramiteId: number, filas: number): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: 'validacion_identidad',
    resourceId: tramiteId,
    accion: 'read',
    camposAccedidos: [...CAMPOS_PII_ESTADO],
    motivo: motivoFilas(filas),
  });
}
