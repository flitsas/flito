// FLITO SOAT — registro de acceso a datos personales (Ley 1581 art. 17, AGENTS.md §16).
//
// La cola y el detalle de SOAT devuelven `compradores[].nombreCompleto` y
// `compradores[].numeroDocumento` —la CÉDULA del propietario del vehículo— además de la placa y el
// VIN, y el módulo `flito-soat` no llamaba a `logPiiAccess` en ningún punto: `grep -c logPiiAccess`
// sobre el módulo daba 0 mientras `clients/`, `drivers/`, `flito-comparendos/`,
// `flito-conciliacion/` y `pesv/` sí registran. Es la misma deuda que cerró `clients.pii.ts` para el
// padrón, en un módulo que además acaba de ganar un lector EXTERNO (el rol `cliente`, Feature
// #11912): a partir de esta HU, «¿quién consultó mis datos?» puede tener por respuesta una empresa
// tercera, y esa respuesta tiene que estar escrita.
//
// Existe aparte del router por el mismo motivo que `flito-conciliacion.pii.ts` y
// `flito-comparendos.pii.ts`, que son sus precedentes exactos: son dos endpoints que devuelven lo
// mismo, y si cada uno arma su llamada a `logPiiAccess` por su cuenta, `resource_tipo` y
// `campos_accedidos` acaban escritos de dos maneras distintas y el log deja de ser consultable —que
// es lo único que un registro de acceso tiene que ser (ADR-0006 §7.5).
//
// ── Lo que NO va aquí ────────────────────────────────────────────────────────────────────────────
//
// No sustituye a `audit()`: la bitácora responde «quién CAMBIÓ qué» —el envío al gestor, el rechazo,
// la carga de la factura— y esto responde «quién MIRÓ datos personales». Las mutaciones de este
// router siguen anotándose con `audit()` y no se registran aquí: quien las hace ya recibió el dato
// por la lectura que las precede.
//
// `GET /:id/historial` y `GET /:id/soportes` tampoco entran, y no es un olvido: el historial
// devuelve estados y motivos —y desde esta HU ni siquiera el nombre del empleado cuando pregunta un
// cliente— y los soportes devuelven nombres de archivo y enlaces firmados. Ninguno proyecta una
// columna personal del titular. Registrar ahí escribiría una fila de «acceso a datos personales»
// por cada despliegue de un acordeón, sin que nadie haya mirado a nadie.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { CAMPOS_PII_COLA_EXPORT } from '../../shared/export/cola-flito-excel.js';

/** `resource_tipo` de una lectura de SOAT. Mismo literal con el que `audit()` anota las escrituras. */
export const RECURSO_SOAT = 'flito_soat';

/**
 * Columnas personales que la cola y el detalle entregan, con el nombre que tienen en la BASE.
 *
 * Se usan los nombres de columna y no los del DTO (`nombre_completo`, no `nombreCompleto`) por lo
 * mismo que el resto del repo: `pii_access_log` tiene que poder cruzarse con la tabla real, no con
 * la forma de una pantalla.
 *
 *   · `nombre_completo` y `numero_documento` (`flito_compradores`) — nombre y CÉDULA del propietario.
 *   · `placa` y `vin` (`vehicles`) — identifican indirectamente a ese propietario. Es la misma
 *     clasificación que ya hace `flito-conciliacion.pii.ts` con la placa y la que sostiene la regla
 *     14 de AGENTS.md, que las mantiene fuera de cualquier path y de cualquier query string.
 *
 * La lista describe lo que estas DOS rutas devuelven y nada más. Un campo declarado que la ruta no
 * entrega fue un bloqueante en su día y no se repite: quien añada una columna personal a la
 * proyección de `cola()`/`detalle()` la añade aquí en la misma edición.
 */
export const CAMPOS_PII_SOAT = ['nombre_completo', 'numero_documento', 'placa', 'vin'] as const;

/**
 * Columnas personales que entrega el EXPORT a Excel de la cola (HU #11909).
 *
 * Es una lista APARTE de `CAMPOS_PII_SOAT` y no una ampliación de aquella, por el criterio que este
 * mismo archivo fija dos párrafos más arriba: la lista de una acción describe lo que ESA acción
 * devuelve, y declarar de más ya fue un bloqueante. La cola y el detalle no entregan el correo, el
 * celular ni la dirección del propietario; el archivo sí, y hasta esta HU eso no constaba en ninguna
 * parte — `pii_access_log` habría mentido por omisión justo en lo que la HU añade.
 *
 * Se construye SOBRE `CAMPOS_PII_SOAT` en vez de reescribirla para que las dos no puedan separarse
 * si mañana se renombra una columna, y se le resta `nombre_completo`: el archivo lleva la CÉDULA del
 * propietario y **no** su nombre (AC1, once columnas). El vocabulario compartido con la cola de
 * Impuestos —que exporta exactamente la misma hoja— vive en `shared/export/cola-flito-excel.ts`.
 */
export const CAMPOS_PII_SOAT_EXPORT = [
  ...CAMPOS_PII_SOAT.filter((c) => c !== 'nombre_completo'),
  ...CAMPOS_PII_COLA_EXPORT.filter((c) => !(CAMPOS_PII_SOAT as readonly string[]).includes(c)),
] as const;

export interface AccesoSoat {
  /**
   * `search` = la cola (un tramo). `read` = un SOAT concreto. `export` = el `.xlsx` de la cola.
   *
   * `export` es un valor propio y no un `search` con más filas: los agregados de
   * `/api/privacy/pii-access/stats` distinguen «alguien miró una pantalla» de «alguien se llevó un
   * archivo fuera del perímetro», y son dos hechos con consecuencias distintas para un titular que
   * pregunte por el artículo 17.
   */
  accion: 'read' | 'search' | 'export';
  /**
   * Qué columnas se entregaron, cuando no son las de la cola.
   *
   * Sin este parámetro, el export tendría que armar su propia llamada a `logPiiAccess` y el módulo
   * volvería a tener dos formas de escribir `resource_tipo` — que es exactamente lo que este archivo
   * existe para evitar. Por defecto, {@link CAMPOS_PII_SOAT}.
   */
  campos?: readonly string[];
  /**
   * Marcador del desenlace, cuando la lectura corrió pero no entregó nada (el 422 del export).
   *
   * Va DELANTE del resto en el motivo porque `motivo` se recorta por el final: sin él, la línea del
   * export rechazado por el tope sería indistinguible de una búsqueda cualquiera, y el dato con el
   * que ADR-0004 promete recalibrar el tope quedaría sesgado justo en la cola que se quiere medir.
   */
  resultado?: string;
  /**
   * El uuid del SOAT leído, en el detalle.
   *
   * `pii_access_log.resource_id` es `integer` y `flito_soat.id` es uuid, así que el identificador
   * viaja en `motivo`, que es texto — el mismo apaño que `flito-conciliacion.pii.ts` documenta. Va
   * el uuid y no la placa: la placa es justo uno de los campos que este registro protege y no puede
   * acabar guardada como el MOTIVO de su propia lectura.
   */
  soatId?: string | null;
  /** Cuántas filas se entregaron. Una página de 50 no es la misma lectura que un detalle. */
  filas?: number;
  /**
   * QUÉ archivo salió, cuando `accion: 'export'` ya no significa una sola cosa (HU #11910).
   *
   * Desde esta HU el módulo exporta dos cosas distintas: el `.xlsx` de la cola —once columnas con
   * cédula, correo, teléfono y dirección— y el ZIP de comprobantes, que publica la PLACA en el
   * nombre de cada entrada y los documentos dentro. Son dos hechos con consecuencias distintas para
   * un titular que pregunte por el artículo 17, y sin este campo las dos líneas del `pii_access_log`
   * serían indistinguibles: mismo `accion`, mismo `resource_tipo`, y solo `campos_accedidos` para
   * adivinar.
   *
   * **La ausencia significa el `.xlsx` de la cola**, que era el único export del módulo hasta ahora:
   * así la ruta de la HU #11909 no tiene que cambiar para seguir diciendo la verdad.
   */
  archivo?: 'zip_soportes';
}

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

/**
 * Deja constancia de una lectura de SOAT.
 *
 * Es `await` y no fuego-y-olvido a propósito, como en los otros dos módulos: `logPiiAccess` ya es
 * best-effort —atrapa su propio error y nunca tumba la operación—, así que esperar cuesta una
 * inserción y garantiza que el rastro está escrito ANTES de que la respuesta salga.
 */
export async function registrarAccesoSoat(req: Request, acceso: AccesoSoat): Promise<void> {
  const partes = [
    // Primero el marcador: `motivo` se recorta por el final y esto es lo que hace la línea
    // reconocible cuando el export no llegó a entregarse.
    acceso.resultado ? `resultado=${acceso.resultado}` : null,
    acceso.archivo ? `archivo=${acceso.archivo}` : null,
    acceso.soatId ? `soat ${acceso.soatId}` : null,
    acceso.filas === undefined ? null : `filas=${acceso.filas}`,
  ].filter((p): p is string => p !== null);

  const motivo = `Lectura de SOAT${partes.length > 0 ? ` — ${partes.join(' · ')}` : ''}`;

  await logPiiAccess(req, {
    resourceTipo: RECURSO_SOAT,
    // Ver la nota de `soatId`: el uuid no cabe en una columna integer, así que va en el motivo.
    resourceId: null,
    accion: acceso.accion,
    camposAccedidos: [...(acceso.campos ?? CAMPOS_PII_SOAT)],
    motivo: motivo.slice(0, MOTIVO_MAX),
  });
}

// ── Canal Cliente: la preconsulta al RUNT (Feature #11912, HU #11914) ────────────────────────────

/**
 * Columnas personales que devuelve `POST /cliente/preconsulta`.
 *
 * Es una lista DISTINTA de `CAMPOS_PII_SOAT` y no una copia por descuido: aquí no se lee ninguna
 * fila de FLITO —la solicitud todavía no existe—, se consulta el RUNT y se devuelve lo que responde.
 * Placa y VIN siempre; el nombre del propietario solo cuando el RUNT lo trae, y por eso el registro
 * lo declara caso a caso en vez de afirmar siempre que se accedió a él.
 *
 * `numero_documento` NO está: la preconsulta SÍ recibe el documento en el cuerpo (Bug #11927: la
 * pasarela lo exige con la placa) pero NO lo devuelve. Esta lista es de columnas ACCEDIDAS en la
 * respuesta, no de las que viajan de ida. El alta sí lo persiste, y esa ruta es una MUTACIÓN
 * —queda en `audit_logs`, no aquí—, por la misma división que explica la cabecera de este archivo.
 */
export const CAMPOS_PII_PRECONSULTA = ['placa', 'vin'] as const;
const CAMPO_PROPIETARIO = 'nombre_completo';

/**
 * Deja constancia de una preconsulta del canal Cliente.
 *
 * La consulta es a un registro NACIONAL sobre un vehículo que puede no ser de quien pregunta, y
 * quien pregunta es una empresa tercera: es exactamente el caso que el artículo 17 de la Ley 1581
 * quiere poder reconstruir. Va con `await` y sin identificar la placa en el motivo, por lo mismo que
 * el resto del archivo: la placa es uno de los campos que este registro protege y no puede acabar
 * guardada como el MOTIVO de su propia consulta.
 */
export async function registrarAccesoRuntCliente(
  req: Request,
  opciones: { conPropietario: boolean },
): Promise<void> {
  await logPiiAccess(req, {
    resourceTipo: RECURSO_SOAT,
    resourceId: null,
    accion: 'read',
    camposAccedidos: opciones.conPropietario
      ? [...CAMPOS_PII_PRECONSULTA, CAMPO_PROPIETARIO]
      : [...CAMPOS_PII_PRECONSULTA],
    motivo: 'Preconsulta RUNT del canal Cliente (alta de solicitud de SOAT)'.slice(0, MOTIVO_MAX),
  });
}
