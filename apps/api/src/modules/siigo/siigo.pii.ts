// Siigo — registro de acceso a datos personales del padrón de clientes (HU #11299).
//
// El informe de facturabilidad (HU #11296) devuelve NOMBRE e IDENTIFICACIÓN de clientes —la cédula
// cuando el cliente es persona natural, el NIT cuando es jurídica— y las listas de equivalencia de
// ciudad (HU #11294) devuelven el nombre de cada cliente pendiente. Ley 1581 art. 17 — el titular
// puede preguntar «¿quién consultó mis datos y para qué?», y hasta esta HU el módulo `siigo/` entero
// no escribía una sola línea en `pii_access_log`, mientras `drivers/`, `flito-comparendos/`,
// `flito-conciliacion/` y `pesv/` sí lo hacían (AGENTS.md §16).
//
// Es deuda preexistente —las rutas son de las HU #11294 y #11296— y se cierra AHORA porque el panel
// de Terceros las convierte en su fuente de datos: pasan de consulta puntual a barrido rutinario de
// hasta 500 fichas identificadas por llamada, y las de ciudad ni siquiera tienen tope. El control de
// acceso ya estaba bien (`requireRole('admin','auditor','financiera')`); lo que faltaba era poder
// reconstruir QUIÉN leyó el padrón.
//
// El corte del alcance: este archivo cubre **todas las lecturas de identidad que hace el panel que
// entrega esta HU** —las tres del informe de facturabilidad y las dos listas de equivalencia de
// ciudad—. Las que el panel no toca (`GET /clientes-ciudades/:id/propuesta`, el `select()` sin
// proyección de `terceros.routes.ts`, el job de archivo) quedan inventariadas para una HU aparte:
// cerrar una puerta y dejar abiertas otras dos de la MISMA pantalla sería media corrección, pero
// arrastrar aquí lo que este PR no entrega sería otra cosa distinta.
//
// Existe aparte del router por el mismo motivo que `flito-conciliacion.pii.ts` y
// `flito-comparendos.pii.ts`, que son sus precedentes exactos: son varios endpoints que devuelven lo
// mismo, y si cada uno arma su llamada a `logPiiAccess` por su cuenta, `resource_tipo` y
// `campos_accedidos` acaban escritos de tres maneras distintas y el log deja de ser consultable —
// que es lo único que un registro de acceso tiene que ser (ADR-0006 §7.5).
//
// ── Lo que NO hace ───────────────────────────────────────────────────────────────────────────────
//
// No sustituye a `audit()`: la bitácora responde «quién CAMBIÓ qué» —el recálculo de duplicados, la
// corrección de una ficha— y esto responde «quién MIRÓ datos personales».
//
// Y no cambia lo que las rutas devuelven. Añadir el rastro no altera ni una clave del DTO.

import type { Request } from 'express';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { maskDocument } from '../../shared/utils/pii.js';

/**
 * `resource_tipo` de una lectura de fichas de cliente.
 *
 * El literal es el MISMO con el que `audit()` anota las escrituras sobre clientes
 * (`clients.routes.ts` y `ciudades-mapeo.routes.ts` usan `resource: 'client'`), y no por descuido de
 * nombres: quien tenga que responder por un cliente concreto necesita cruzar «quién lo modificó»
 * (bitácora) con «quién leyó su ficha» (registro de acceso), y dos literales distintos para el mismo
 * objeto obligarían a traducir entre las dos tablas para hacer esa consulta. Que las dos preguntas
 * sean distintas ya lo dice la columna `accion`; el recurso es el mismo. Es el criterio que
 * `flito-comparendos.pii.ts` deja escrito para `RECURSO_NIT`.
 */
export const RECURSO_CLIENTE = 'client';

/**
 * Columnas personales que devuelve un `VeredictoCliente`: el listado y la ficha puntual.
 *
 * Se nombran las columnas de `clients`, no las claves del DTO (`nombre`, `documento`): el log tiene
 * que poder cruzarse con la tabla real. `document` es cédula o NIT según el tipo de persona —una
 * cédula es un documento de identidad y un NIT de persona natural TAMBIÉN lo es—, y `name` es el
 * nombre de esa persona cuando el cliente no es una compañía.
 *
 * El resto del veredicto (`facturable`, `pendienteClasificacion`, `faltantes`) NO va aquí: nombra
 * campos y motivos de un catálogo estático, no valores de la ficha.
 */
export const CAMPOS_PII_VEREDICTO = ['name', 'document'] as const;

/**
 * Lo personal que entregan las listas de equivalencia de ciudad: el NOMBRE del cliente y nada más.
 *
 * `GET /clientes-ciudades/propuestas` y `/obsoletas` devuelven `{ clienteId, nombre, ciudad… }` de
 * todos los clientes activos que cumplen el criterio, **sin paginar y sin tope** —a diferencia del
 * informe de facturabilidad, que al menos está acotado a 500—, así que en volumen son la lectura
 * más grande del módulo. La identificación no sale por ahí, y por eso `document` NO va en esta
 * lista: declararlo haría que «¿quién ha leído documentos?» señalara a quien solo vio nombres, que
 * es la misma exageración que se evita en {@link CAMPOS_PII_RESUMEN} por el otro lado.
 *
 * Que un nombre sea dato personal no depende de si el cliente es una empresa: `clients` mezcla
 * personas naturales y jurídicas en la misma tabla —es justo lo que el validador tiene que
 * clasificar—, así que la lista lleva nombres de persona sí o sí.
 */
export const CAMPOS_PII_NOMBRE_CLIENTE = ['name'] as const;

/**
 * Lo que entrega el resumen de facturabilidad: **nada personal**, y por eso la lista va vacía.
 *
 * No es un olvido ni una lista pendiente de llenar. El resumen recorre el padrón para contar, pero
 * lo que devuelve son conteos por motivo: ni un nombre, ni una identificación, ni un identificador
 * de cliente. Declarar `name` y `document` aquí haría que el log afirmara que alguien leyó
 * identidades que nunca salieron de la base, y un registro de acceso que exagera es tan inservible
 * como uno que falta: la consulta «¿quién ha leído documentos?» devolvería a todo el que abrió el
 * panel. Es el mismo criterio con el que `flito-conciliacion.pii.ts` deja fuera la columna «Nombre»
 * del Excel y con el que `flito-comparendos.routes.ts` distingue las dos escrituras de `/nits`: lo
 * que decide no es la ruta ni el verbo, sino si la RESPUESTA entrega datos personales.
 *
 * Se registra igual, con la lista vacía, porque el barrido del padrón sí ocurrió y `motivo` deja
 * constancia de cuántas fichas se evaluaron. `pii_access_log.campos_accedidos` tiene
 * `DEFAULT ARRAY[]::text[]` (mig. 0059): el vacío es un valor previsto, no un hueco.
 */
export const CAMPOS_PII_RESUMEN: readonly string[] = [];

export interface AccesoCliente {
  /** `search` = barrido o listado; `read` = la ficha de un cliente concreto. */
  accion: 'read' | 'search';
  /** Columnas personales que la RESPUESTA devuelve. Usar las constantes de este archivo. */
  campos: readonly string[];
  /**
   * `clients.id` cuando la lectura es de un cliente concreto.
   *
   * Aquí sí cabe —a diferencia de comparendos y conciliación, cuyos identificadores son uuid—:
   * `pii_access_log.resource_id` es `integer` y `clients.id` también. Un listado va con `null`: no
   * apunta a una ficha sino a un tramo del padrón.
   */
  clienteId?: number | null;
  /** Cuántas fichas se entregaron. Un listado de 500 no es la misma lectura que uno de 1. */
  filas?: number;
  /** Cuántas fichas se recorrieron para un agregado, cuando no se entregó ninguna. */
  evaluados?: number;
  /** Filtros aplicados. Se enmascaran aquí: el llamador pasa los valores tal cual los recibió. */
  filtros?: Record<string, unknown>;
}

/** `pii_access_log.motivo` es `varchar(200)`: pasarse sería un 22001 en vez de un rastro. */
const MOTIVO_MAX = 200;

/** Claves de filtro cuyo VALOR es un dato personal y no puede ir literal al motivo. */
const FILTRO_SENSIBLE = /nit|documento|document|cedula|c[eé]dula|identificacion|identificaci[oó]n|nombre|name/i;

/**
 * Resume los filtros para el motivo, enmascarando los valores personales.
 *
 * Hoy este router no acepta ningún filtro por identidad —solo `motivo`, `incluirFacturables`,
 * `limit` y `offset`, que son criterios de negocio—, así que el enmascarado no tiene nada que hacer.
 * Va igual, y no por simetría con `flito-comparendos.pii.ts`: el día que alguien añada un
 * `?documento=` al informe —que es la petición más natural del mundo para una pantalla de
 * corrección— el valor entraría solo en el motivo, y escribir la cédula dentro del rastro de quién
 * la miró es publicar el dato en el registro que existe para protegerlo. Se conserva la CLAVE
 * siempre: saber que alguien buscó «por documento» es justamente lo que hace útil el registro.
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
    // Arrays y objetos: constancia de que el filtro se usó, sin volcar su contenido.
    partes.push(`${clave}=[…]`);
  }
  return partes.join(' ');
}

/**
 * Deja el registro de acceso a fichas de cliente en `pii_access_log` (Ley 1581 art. 17).
 *
 * Es `await` y no fuego-y-olvido a propósito: `logPiiAccess` ya es best-effort —atrapa su propio
 * error y nunca tumba la operación principal—, así que esperar cuesta una inserción y garantiza que
 * el rastro está escrito ANTES de que la respuesta salga. Un registro de acceso que se pierde porque
 * el proceso murió entre la respuesta y el INSERT no es un registro de acceso.
 *
 * Lo que se escribe son NOMBRES DE CAMPO y el identificador del cliente. Nunca los valores leídos:
 * un log de accesos que copiara las cédulas que se consultaron sería una segunda base de datos de
 * identidades, y encima append-only.
 */
export async function registrarAccesoCliente(req: Request, acceso: AccesoCliente): Promise<void> {
  const detalles = [
    acceso.filas === undefined ? null : `filas=${acceso.filas}`,
    acceso.evaluados === undefined ? null : `evaluados=${acceso.evaluados}`,
    acceso.clienteId === undefined || acceso.clienteId === null ? null : `cliente=${acceso.clienteId}`,
    acceso.filtros ? resumirFiltros(acceso.filtros) : null,
  ].filter((p): p is string => p !== null && p !== '');

  const motivo = `Lectura de fichas de cliente${detalles.length > 0 ? ` — ${detalles.join(' ')}` : ''}`;

  await logPiiAccess(req, {
    resourceTipo: RECURSO_CLIENTE,
    resourceId: acceso.clienteId ?? null,
    accion: acceso.accion,
    camposAccedidos: [...acceso.campos],
    motivo: motivo.slice(0, MOTIVO_MAX),
  });
}
