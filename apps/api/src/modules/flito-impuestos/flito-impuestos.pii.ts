// FLITO Impuestos — registro de acceso a datos personales (Ley 1581 art. 17, AGENTS.md §16).
//
// El módulo NO tenía ninguno: `grep -c logPiiAccess` sobre sus ocho archivos daba 0, mientras
// `clients/`, `drivers/`, `flito-comparendos/`, `flito-conciliacion/`, `pesv/` y —desde el Feature
// #11912— `flito-soat/` sí registran. Y la cola de Impuestos devuelve `compradorNombre` y
// `compradorDocumento` —la CÉDULA del propietario del vehículo— además de la placa y el VIN, así que
// la deuda no era teórica: la pregunta «¿quién consultó mis datos?» no tenía respuesta para este
// módulo.
//
// Lo destapa la HU #11909 porque el export a Excel entrega ADEMÁS correo, celular, dirección y
// ciudad, y en un solo gesto: hasta `FLITO_COLA_EXPORT_MAX_FILAS` titulares por petición, fuera del
// perímetro y en un archivo que se reenvía. Se cierra aquí de una vez para las dos lecturas —el
// export y el `GET /` de la cola— en vez de dejar el registro solo en la ruta nueva, que habría
// dejado la lectura interactiva escribiendo nada mientras la de al lado escribe todo.
//
// Es un calco deliberado de `flito-soat.pii.ts` —mismo contrato, mismos nombres, misma división de
// responsabilidades— porque son la misma cosa en dos módulos: si cada uno arma su llamada a
// `logPiiAccess` por su cuenta, `resource_tipo` y `campos_accedidos` acaban escritos de dos maneras
// y el log deja de ser consultable, que es lo único que un registro de acceso tiene que ser
// (ADR-0006 §7.5).
//
// ── Lo que NO va aquí ────────────────────────────────────────────────────────────────────────────
//
// No sustituye a `audit()`: la bitácora responde «quién CAMBIÓ qué» —el envío al gestor, el rechazo,
// la carga de recibos— y esto responde «quién MIRÓ datos personales». Las mutaciones del router
// siguen anotándose con `audit()`.
//
// `GET /:id/historial` y `GET /:id/soportes` tampoco entran, por el mismo criterio que en SOAT: el
// historial devuelve estados y motivos y los soportes nombres de archivo y enlaces firmados.
// Ninguno proyecta una columna personal del titular, y registrar ahí escribiría una fila de «acceso
// a datos personales» por cada despliegue de un acordeón.
//
// `GET /:id` (el detalle) se deja FUERA en esta HU y se declara como deuda en vez de silenciarla:
// sí devuelve al comprador, así que le corresponde una línea, pero el alcance de la #11909 es el
// export y la cola de la que sale. Añadirlo es una llamada más en la ruta del detalle, con
// `accion: 'read'` y `filas: 1`, exactamente como hace `flito-soat.routes.ts`.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { CAMPOS_PII_COLA_EXPORT } from '../../shared/export/cola-flito-excel.js';

/**
 * `resource_tipo` de una lectura de Impuestos. Mismo literal con el que `audit()` anota las
 * escrituras del módulo (`resource: 'flito_impuesto'`), que es lo que permite cruzar las dos tablas.
 */
export const RECURSO_IMPUESTO = 'flito_impuesto';

/**
 * Columnas personales que devuelve la COLA (`GET /`), con el nombre que tienen en la BASE.
 *
 * Se usan los nombres de columna y no los del DTO (`nombre_completo`, no `compradorNombre`) por lo
 * mismo que el resto del repo: `pii_access_log` tiene que poder cruzarse con la tabla real, no con
 * la forma de una pantalla.
 *
 *   · `nombre_completo` y `numero_documento` (`flito_compradores`) — nombre y CÉDULA del propietario.
 *   · `tipo_documento` — QUÉ documento es esa cédula (`CC`, `NIT`, `PP`, `CE`), resuelto desde
 *     `flit_raw->>'tipo'` (HU #11947). La cola lo publica en `compradorTipoDocumento` desde esta HU,
 *     así que entra aquí en la misma edición. Es un dato del titular y no un formato: `CE` dice que
 *     quien figura es extranjero.
 *   · `placa` y `vin` (`vehicles`) — identifican indirectamente a ese propietario, misma
 *     clasificación que hacen `flito-conciliacion.pii.ts` y `flito-soat.pii.ts`.
 *
 * La lista describe lo que ESA ruta devuelve y nada más: un campo declarado que la ruta no entrega
 * hace que `campos_accedidos` deje de decir la verdad, que es lo único que este registro tiene que
 * hacer.
 */
export const CAMPOS_PII_IMPUESTO = ['nombre_completo', 'numero_documento', 'tipo_documento', 'placa', 'vin'] as const;

/**
 * Columnas personales que entrega el EXPORT a Excel (HU #11909, HU #11934).
 *
 * Lista APARTE y no una ampliación de la de arriba: son dos lecturas distintas y cada una declara lo
 * suyo. Sobre la cola, el archivo añade `correo`, `celular`, `direccion` y `ciudad`.
 *
 * **Desde la HU #11934 vuelve a declarar `nombre_completo`.** La hoja de once columnas no llevaba el
 * nombre del titular —solo su documento— y por eso la lista compartida lo excluía; la de veinticinco
 * lo publica en `NombrePila`/`Apellidos`/`RazonSocial`. Aquí no hay nada que editar porque la lista
 * compartida ya lo trae, y eso es exactamente lo que se buscaba al derivarla de ella.
 *
 * Sale de `CAMPOS_PII_COLA_EXPORT`, que es la lista de la hoja compartida por las dos colas: el
 * archivo es EL MISMO en SOAT y en Impuestos, así que su declaración de campos también tiene que
 * serlo o el `pii_access_log` diría dos cosas del mismo documento.
 */
export const CAMPOS_PII_IMPUESTO_EXPORT = CAMPOS_PII_COLA_EXPORT;

export interface AccesoImpuesto {
  /**
   * `search` = la cola (un tramo). `read` = un impuesto concreto. `export` = el `.xlsx` de la cola.
   *
   * `export` es un valor propio y no un `search` con más filas: los agregados de
   * `/api/privacy/pii-access/stats` distinguen «alguien miró una pantalla» de «alguien se llevó un
   * archivo fuera del perímetro».
   */
  accion: 'read' | 'search' | 'export';
  /**
   * El uuid del impuesto leído, en el detalle.
   *
   * `pii_access_log.resource_id` es `integer` y `flito_impuestos.id` es uuid, así que el
   * identificador viaja en `motivo`, que es texto — el mismo apaño que documentan
   * `flito-conciliacion.pii.ts` y `flito-soat.pii.ts`. Va el uuid y no la placa: la placa es uno de
   * los campos que este registro protege y no puede acabar guardada como el MOTIVO de su propia
   * lectura.
   */
  impuestoId?: string | null;
  /** Cuántas filas se entregaron DE VERDAD. No el tope, no lo pedido. */
  filas?: number;
  /** Qué columnas se entregaron, cuando no son las de la cola. Por defecto {@link CAMPOS_PII_IMPUESTO}. */
  campos?: readonly string[];
  /**
   * Marcador del desenlace, cuando la lectura corrió pero no entregó nada (el 422 del export).
   *
   * Va DELANTE del resto en el motivo porque `motivo` se recorta por el final: sin él, la línea de
   * un export rechazado por el tope sería indistinguible de una búsqueda cualquiera.
   */
  resultado?: string;
  /**
   * QUÉ archivo salió, cuando `accion: 'export'` ya no significa una sola cosa (HU #11910).
   *
   * Calco del campo gemelo de `flito-soat.pii.ts` y por lo mismo: desde esta HU el módulo exporta el
   * `.xlsx` de la cola —cédula, correo, teléfono y dirección— y el ZIP de soportes, que publica la
   * PLACA en el nombre de cada entrada. Sin este campo las dos líneas serían indistinguibles.
   *
   * **La ausencia significa el `.xlsx` de la cola**: así la ruta de la HU #11909 sigue diciendo la
   * verdad sin tocarla.
   */
  archivo?: 'zip_soportes';
}

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

/**
 * Deja constancia de una lectura de Impuestos.
 *
 * Es `await` y no fuego-y-olvido a propósito, como en los otros módulos: `logPiiAccess` ya es
 * best-effort —atrapa su propio error y nunca tumba la operación—, así que esperar cuesta una
 * inserción y garantiza que el rastro está escrito ANTES de que la respuesta salga. En el export eso
 * no es un detalle: la respuesta es un archivo que se empieza a escribir en el socket, y una vez
 * empezado ya no hay forma de anotar nada con la certeza de que se llegó a anotar.
 */
export async function registrarAccesoImpuesto(req: Request, acceso: AccesoImpuesto): Promise<void> {
  const partes = [
    acceso.resultado ? `resultado=${acceso.resultado}` : null,
    acceso.archivo ? `archivo=${acceso.archivo}` : null,
    acceso.impuestoId ? `impuesto ${acceso.impuestoId}` : null,
    acceso.filas === undefined ? null : `filas=${acceso.filas}`,
  ].filter((p): p is string => p !== null);

  const motivo = `Lectura de impuestos${partes.length > 0 ? ` — ${partes.join(' · ')}` : ''}`;

  await logPiiAccess(req, {
    resourceTipo: RECURSO_IMPUESTO,
    // Ver la nota de `impuestoId`: el uuid no cabe en una columna integer, así que va en el motivo.
    resourceId: null,
    accion: acceso.accion,
    camposAccedidos: [...(acceso.campos ?? CAMPOS_PII_IMPUESTO)],
    motivo: motivo.slice(0, MOTIVO_MAX),
  });
}
