// FLITO Conciliación — registro de acceso a datos personales (Feature #11623, HU #11676).
//
// El cuadre de una boleta devuelve NÚMERO DE PÓLIZA y PLACA de vehículos de terceros: la póliza
// identifica un contrato de seguro de una persona y la placa identifica indirectamente a su
// propietario (Ley 1581 art. 17 — el titular puede preguntar «¿quién consultó mis datos?»). Toda
// lectura que los entregue deja rastro en `pii_access_log`.
//
// Existe aparte del router por el mismo motivo que `flito-comparendos.pii.ts`, que es su precedente
// exacto: son varios endpoints que devuelven lo mismo, y si cada uno arma su llamada a
// `logPiiAccess` por su cuenta, `resource_tipo` y `campos_accedidos` acaban escritos de tres maneras
// distintas y el log deja de ser consultable — que es lo único que un registro de acceso tiene que
// ser. El ADR-0006 §7.5 lo recomienda con esas palabras.
//
// ── Lo que NO va aquí ────────────────────────────────────────────────────────────────────────────
//
// La columna «Nombre» del Excel del portal —nombres completos de personas naturales— no aparece en
// esta lista porque **no se lee, no se persiste y no se devuelve** (AC11). Un campo que el sistema
// no tiene no se puede registrar como accedido.
//
// Tampoco sustituye a `audit()`: la bitácora responde «quién CAMBIÓ qué» (cargó, re-cruzó, descartó)
// y esto responde «quién MIRÓ datos personales». La carga necesita las dos.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';

/** `resource_tipo` de una lectura del cuadre de una boleta. */
export const RECURSO_BOLETA = 'flito_conciliacion_boleta';

/**
 * Columnas personales que devuelve el detalle de una boleta.
 *
 * `numero_poliza` va normalizada y sin dueño visible, pero sigue siendo el identificador de un
 * contrato de seguro de un tercero; `placa` identifica indirectamente al propietario. Las dos son
 * las que el ADR-0006 §7.5 obliga a declarar, y las dos son las que la regla 14 de AGENTS.md
 * mantiene fuera de cualquier path y de cualquier query string.
 */
export const CAMPOS_PII_LINEA = ['numero_poliza', 'placa'] as const;

export interface AccesoBoleta {
  /** `read` = una boleta concreta (carga, detalle, re-cruce). `search` = listado. */
  accion: 'read' | 'search';
  /**
   * Referencia legible de la boleta ('BOL-000123'), **no** su uuid ni ninguna póliza.
   *
   * `pii_access_log.resource_id` es `integer` y estas entidades son uuid, así que el identificador
   * viaja en `motivo`, que es texto. Se usa la referencia y no el uuid porque es lo que una persona
   * puede buscar después en la pantalla; y no es un dato personal.
   */
  referencia?: string | null;
  /** Cuántas líneas se entregaron. Una boleta de 500 líneas no es la misma lectura que una de 1. */
  lineas?: number;
}

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

/**
 * Deja el registro de acceso al cuadre de una boleta.
 *
 * Es `await` y no fuego-y-olvido a propósito: `logPiiAccess` ya es best-effort —atrapa su propio
 * error y nunca tumba la operación principal—, así que esperar cuesta una inserción y garantiza que
 * el rastro está escrito ANTES de que la respuesta salga. Un registro de acceso que se pierde
 * porque el proceso murió entre la respuesta y el INSERT no es un registro de acceso.
 */
export async function registrarAccesoBoleta(req: Request, acceso: AccesoBoleta): Promise<void> {
  const partes = [
    acceso.referencia ? `boleta ${acceso.referencia}` : null,
    acceso.lineas === undefined ? null : `${acceso.lineas} líneas`,
  ].filter((p): p is string => p !== null);

  const motivo = `Lectura de cuadre${partes.length > 0 ? ` — ${partes.join(' · ')}` : ''}`;

  await logPiiAccess(req, {
    resourceTipo: RECURSO_BOLETA,
    // Ver la nota de `referencia`: el uuid no cabe en una columna integer, así que va en el motivo.
    resourceId: null,
    accion: acceso.accion,
    camposAccedidos: [...CAMPOS_PII_LINEA],
    motivo: motivo.slice(0, MOTIVO_MAX),
  });
}
