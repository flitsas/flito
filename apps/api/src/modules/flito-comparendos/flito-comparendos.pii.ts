// FLITO comparendos — registro de acceso a datos personales (Feature #11492 17a, HU #11511).
//
// El tercer frente del hallazgo de seguridad de la HU #11500: los registros de comparendos y sus
// payloads son datos de terceros (Ley 1581 art. 17 — el titular puede preguntar «¿quién consultó mis
// datos y para qué?») y hoy se leen sin dejar rastro. Este archivo es el contrato que responde a esa
// pregunta, y existe aparte del router por dos motivos:
//
//   · La HU #11502 expone `GET /registros` y la 17b el visor. Si cada uno arma su propia llamada a
//     `logPiiAccess`, el `resource_tipo` y los `campos_accedidos` acaban escritos de tres maneras
//     distintas y el log deja de ser consultable — que es lo único que un registro de acceso tiene
//     que ser.
//   · El enmascarado de los filtros es exactamente el tipo de detalle que se olvida cuando se
//     escribe una vez por endpoint: `?nit=900123456` en el motivo del registro de acceso sería
//     escribir el dato que se está protegiendo dentro del rastro de quién lo miró.
//
// ── Cómo lo usa la HU #11502 ─────────────────────────────────────────────────────────────────────
//
//   await registrarAccesoComparendos(req, {
//     recurso: RECURSO_REGISTROS,
//     accion: 'search',                       // 'read' con :id, 'export' al descargar
//     campos: [...CAMPOS_PII_REGISTRO],       // añade CAMPOS_PII_PAYLOAD si devuelve payloads
//     filas: resultado.items.length,
//     filtros: { nit, placa, estado },        // se enmascaran aquí, no en el llamador
//   });
//
// Es `await` y no fuego-y-olvido a propósito: `logPiiAccess` ya es best-effort —atrapa su propio
// error y nunca tumba la operación principal—, así que esperar cuesta una inserción y garantiza que
// el rastro está escrito ANTES de que la respuesta salga. Un registro de acceso que se pierde porque
// el proceso murió entre la respuesta y el INSERT no es un registro de acceso.
//
// ── Lo que NO hace ───────────────────────────────────────────────────────────────────────────────
//
// No sustituye a `audit()`. La bitácora responde «quién CAMBIÓ qué» (parametrización, token, sync) y
// esto responde «quién MIRÓ datos personales». Un mismo endpoint puede necesitar los dos.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { maskDocument } from '../../shared/utils/pii.js';

/** `resource_tipo` de una lectura de comparendos consolidados (`flito_comparendos_registros`). */
export const RECURSO_REGISTROS = 'flito_comparendos_registro';

/** `resource_tipo` de una lectura de corridas de sync: `scope_nits` y el `nit` de cada paso. */
export const RECURSO_SYNC_RUN = 'flito_comparendos_sync_run';

/**
 * Columnas personales de un registro consolidado.
 *
 * `nit_monitoreado` es PII cuando el NIT es de una persona natural, y `placa` identifica
 * indirectamente al propietario — las dos lo dicen los COMMENT de la 0150. El resto del canónico
 * (código de infracción, monto, organismo) describe la infracción, no a una persona.
 */
export const CAMPOS_PII_REGISTRO = ['nit_monitoreado', 'placa'] as const;

/**
 * La observación de gestión (HU #11557).
 *
 * Va APARTE de {@link CAMPOS_PII_REGISTRO} por el mismo criterio que los payloads, y con un motivo
 * propio: **es el único campo del módulo que redacta una PERSONA**. El NIT y la placa vienen de una
 * fuente y están acotados por su forma; una observación es texto libre escrito mirando un caso
 * concreto, y ahí puede acabar un nombre, un teléfono o el número de un radicado sin que ninguna
 * validación pueda impedirlo. Declararla es lo que hace que `campos_accedidos` diga la verdad sobre
 * lo que la respuesta entregó — y una página del listado entrega hasta
 * `COMPARENDOS_REGISTROS_LIMIT_MAX` de ellas.
 *
 * Listada por separado, además, se puede responder «¿quién ha leído observaciones?» con una consulta
 * al log en vez de releyendo el código de cada endpoint.
 *
 * **Se añade solo cuando la respuesta la incluye.** Hasta la HU #11557 la columna existía pero
 * ningún camino de código la escribía; desde que hay un endpoint que la llena, toda lectura que la
 * devuelva tiene que declararla.
 */
export const CAMPOS_PII_OBSERVACION = ['observacion'] as const;

/**
 * Los payloads crudos, para cuando un endpoint los devuelva.
 *
 * Van APARTE de `CAMPOS_PII_REGISTRO` y no fundidos con ellos: desde la HU #11511 el payload está
 * podado a la lista blanca del `field_map` y ya no debería llevar datos de persona, pero sigue
 * siendo la respuesta de un tercero sobre un tercero. Listarlos por separado es lo que permite
 * responder «¿alguien ha mirado los payloads?» sin leer el código de cada endpoint.
 */
export const CAMPOS_PII_PAYLOAD = ['payload_simit', 'payload_municipal'] as const;

/** Lo personal de una corrida: la lista de NITs del alcance y el NIT de cada paso. */
export const CAMPOS_PII_SYNC_RUN = ['scope_nits', 'nit'] as const;

export interface AccesoComparendos {
  /** `RECURSO_REGISTROS` o `RECURSO_SYNC_RUN`. */
  recurso: string;
  /** `search` = listado con filtros; `read` = un recurso concreto; `export` = descarga. */
  accion: 'read' | 'search' | 'export';
  /** Columnas personales que la respuesta devuelve. Usar las constantes de este archivo. */
  campos: readonly string[];
  /** Cuántas filas se entregaron. Un listado de 4 000 filas no es la misma lectura que una de 1. */
  filas?: number;
  /** UUID del recurso leído, cuando lo hay. Ver la nota de `resource_id` más abajo. */
  referencia?: string | null;
  /** Filtros aplicados. Se enmascaran aquí: el llamador pasa los valores tal cual los recibió. */
  filtros?: Record<string, unknown>;
}

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

/** Claves de filtro cuyo VALOR es un dato personal y no puede ir literal al motivo. */
const FILTRO_SENSIBLE = /nit|documento|cedula|c[eé]dula|placa|identificacion|identificaci[oó]n/i;

/**
 * Resume los filtros para el motivo, enmascarando los valores personales.
 *
 * Se conserva la CLAVE siempre —saber que alguien buscó «por placa» es justamente lo que hace útil
 * el registro— y se enmascara el valor. Los valores no textuales (booleanos, números, fechas) van
 * tal cual: son criterios de negocio, no identidades.
 */
function resumirFiltros(filtros: Record<string, unknown>): string {
  const partes: string[] = [];
  for (const [clave, valor] of Object.entries(filtros)) {
    if (valor === undefined || valor === null || valor === '') continue;
    if (typeof valor === 'string') {
      partes.push(`${clave}=${FILTRO_SENSIBLE.test(clave) ? maskDocument(valor) : valor.slice(0, 40)}`);
      continue;
    }
    if (typeof valor === 'number' || typeof valor === 'boolean') {
      partes.push(`${clave}=${String(valor)}`);
      continue;
    }
    // Arrays y objetos: se deja constancia de que el filtro se usó, sin volcar su contenido. Un
    // `nits: [...]` con el catálogo entero no cabe en 200 caracteres y no aporta nada que
    // `scope_nits` de la corrida no cuente ya.
    partes.push(`${clave}=[…]`);
  }
  return partes.join(' ');
}

/**
 * Deja el registro de acceso en `pii_access_log` (Ley 1581 art. 17).
 *
 * Sobre `resource_id`: la columna de `pii_access_log` es `integer` y los identificadores de este
 * módulo son UUID, así que **no caben**. En vez de inventarse un número —que sería peor que no
 * poner nada: apuntaría a otro recurso— el UUID viaja dentro de `motivo`, que es texto. Cambiar la
 * columna a texto tocaría una tabla append-only por trigger que comparten media docena de módulos, y
 * eso es una decisión de plataforma, no de esta HU.
 */
export async function registrarAccesoComparendos(req: Request, acceso: AccesoComparendos): Promise<void> {
  const detalles = [
    acceso.filas === undefined ? null : `filas=${acceso.filas}`,
    acceso.referencia ? `id=${acceso.referencia}` : null,
    acceso.filtros ? resumirFiltros(acceso.filtros) : null,
  ].filter((p): p is string => p !== null && p !== '');

  const motivo = `Lectura ${acceso.recurso}${detalles.length > 0 ? ` — ${detalles.join(' ')}` : ''}`;

  await logPiiAccess(req, {
    resourceTipo: acceso.recurso,
    // Ver la nota de arriba: el UUID va en `motivo`, no aquí.
    resourceId: null,
    accion: acceso.accion,
    camposAccedidos: [...acceso.campos],
    motivo: motivo.slice(0, MOTIVO_MAX),
  });
}
