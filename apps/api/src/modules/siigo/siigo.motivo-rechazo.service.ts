// Siigo — explicar por qué la DIAN rechazó una factura (HU #11333, Feature #11243).
//
// Un rechazo sin motivo obliga a entrar a Siigo Nube a averiguarlo, factura por factura. Lo que esta
// historia entrega no es el dato crudo del rechazo: es la frase que le dice a quien opera qué tiene
// que corregir.
//
// TRES DECISIONES
//
//   1. **La traducción no se inventa aquí: ya existe.** `siigo.errors.ts` mapea más de cincuenta
//      códigos a una descripción operativa, con su acción y su responsable. Este archivo la CONSUME.
//      Escribir un segundo diccionario habría creado dos verdades sobre el mismo código, y la que se
//      quedaría desactualizada sería siempre la copia.
//   2. **El motivo va donde va el estado.** Se entrega a `aplicarEstadoDian` y acaba en la columna
//      `motivo` de la fila del historial, no en una tabla aparte. Un motivo guardado lejos del estado
//      que explica es un motivo que alguien tendrá que volver a cruzar a mano.
//   3. **«No se pudo consultar» no es «no hay causa».** Son dos cosas distintas y el AC5 exige
//      distinguirlas: `null` significa que nadie ha preguntado, y el marcador de pendiente significa
//      que se preguntó y no se pudo. Sin esa diferencia, quien opera no sabe si esperar o ir a mirar.

import { sql } from 'drizzle-orm';
import { SIIGO_MOTIVO_RECHAZO_PENDIENTE, esMotivoPendiente } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { loggerFor } from '../../shared/logger.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { claveResiliencia } from './siigo.catalogos.service.js';
import { campoLegible, guiaParaCodigo } from './siigo.errors.js';
import { aplicarEstadoDian } from './siigo.estado-dian.service.js';
import { modoSiigo } from './siigo.mock.js';
import { OPERACION_MOTIVO_RECHAZO } from './siigo.freno.service.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { motivoLegible } from './siigo.productos.service.js';
import { detalleTecnico, sanearMensaje } from './siigo.redaccion.js';
import { ejecutarConResiliencia } from './siigo.resiliencia.js';
import type { SiigoAmbiente } from './credenciales.service.js';

const log = loggerFor('siigo.motivo-rechazo');

/** Consultar el detalle de errores es una petición pequeña, como la del estado. */
export const TIMEOUT_MOTIVO_MS = 15_000;

/**
 * Cuántos errores se enumeran.
 *
 * El AC3 exige conservarlos todos, y se conservan: lo que se acota es el TEXTO visible. Un rechazo
 * con veinte errores produciría un párrafo que nadie lee y que además va a una columna de una tabla
 * inmutable. Los primeros son los que se corrigen primero; el resto se cuenta.
 */
export const MAX_MOTIVOS_ENUMERADOS = 5;

/** Cuántos errores se leen de la respuesta. Ver el tope de `MAX_MOTIVOS_ENUMERADOS`, y además: el
 *  array lo llena Siigo, no nosotros. */
export const MAX_ERRORES_LEIDOS = 50;

/** Circuito propio, separado del sondeo: son endpoints distintos y pueden caerse por separado. */
export function claveCortacircuitosMotivo(ambiente: string): string {
  return `siigo:motivo-rechazo:${ambiente}`;
}

/** Un error del rechazo, ya normalizado. */
export interface ErrorDeRechazo {
  codigo: string;
  campos: string[];
}

/**
 * Normaliza lo que devuelve `GET /v1/invoices/{id}/stamp/errors`.
 *
 * La forma exacta **no está documentada** —`docs/integraciones/siigo-api.md` §3 solo dice qué
 * devuelve el endpoint, no con qué estructura—, así que se aceptan las tres que Siigo usa en el
 * resto de su API: el arreglo suelto, el envoltorio `results` y el envoltorio `Errors`. Rechazar por
 * la forma del envoltorio dejaría sin explicación un rechazo que sí venía explicado.
 *
 * Lo que NO se acepta es inventar un error donde no lo hay: una respuesta que no contenga errores
 * reconocibles devuelve la lista vacía, y quien llama decide qué significa eso.
 */
export function normalizarErrores(datos: unknown): ErrorDeRechazo[] {
  const crudos: unknown[] = Array.isArray(datos)
    ? datos
    : Array.isArray((datos as { results?: unknown })?.results)
      ? (datos as { results: unknown[] }).results
      : Array.isArray((datos as { Errors?: unknown })?.Errors)
        ? (datos as { Errors: unknown[] }).Errors
        : Array.isArray((datos as { errors?: unknown })?.errors)
          ? (datos as { errors: unknown[] }).errors
          : [];

  const salida: ErrorDeRechazo[] = [];
  // Tope de elementos: el array lo llena el proveedor y `siigo.client.ts` no acota el tamaño del
  // cuerpo. Recorrer cientos de miles de objetos para enseñar cinco no aporta nada y una respuesta
  // desmedida agotaría la memoria del proceso, que es un fallo que ningún `try` recoge.
  for (const c of crudos.slice(0, MAX_ERRORES_LEIDOS)) {
    if (c === null || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const codigo = [o.Code, o.code, o.Codigo, o.codigo].find((v) => typeof v === 'string' && v.trim() !== '');
    if (typeof codigo !== 'string') continue;
    const params = [o.Params, o.params].find(Array.isArray) as unknown[] | undefined;
    salida.push({
      codigo: codigo.trim(),
      campos: (params ?? []).filter((p): p is string => typeof p === 'string'),
    });
  }
  return salida;
}

/**
 * Compone el texto que verá quien opera (AC2, AC3, AC6).
 *
 * Pura, y por eso se puede probar sin red ni base. Enumera en vez de quedarse con el primero: un
 * rechazo con tres causas y una sola mostrada hace que se corrija una, se reintente, y vuelva a
 * rechazarse por la segunda — tres viajes para lo que era un viaje.
 *
 * El AC6 lo cubren DOS pasos, y hacen falta los dos: `campoLegible` sobre cada campo —que redacta
 * secretos y acota, porque los `Params` vienen de fuera— y `sanearMensaje` sobre el texto final, que
 * corta volcados de consultas y limita la longitud. Es el mismo saneo que protege la bitácora
 * inalterable, y aquí importa igual: este texto acaba en una columna que no se puede reescribir.
 *
 * Un matiz heredado que conviene conocer: el reconocimiento de SQL exige el identificador
 * ENTRECOMILLADO, que es como lo compila drizzle. Es deliberado —evita mutilar un texto en español
 * que mencione «select»— y significa que una sentencia escrita a mano sin comillas no se recorta.
 */
export function componerMotivo(errores: ErrorDeRechazo[]): string | null {
  if (errores.length === 0) return null;

  const visibles = errores.slice(0, MAX_MOTIVOS_ENUMERADOS);
  const partes = visibles.map((e, i) => {
    // La traducción sale del catálogo que ya existe. `guiaParaCodigo` devuelve además si el código
    // es conocido: cuando no lo es, su texto genérico incluye el código, que es exactamente lo que
    // alguien necesita para buscarlo — mejor que una frase inventada que suene bien y no diga nada.
    const guia = guiaParaCodigo(e.codigo, { params: e.campos });
    const prefijo = errores.length > 1 ? `${i + 1}. ` : '';
    // `campoLegible` y no `e.campos.join()`: los `Params` vienen de fuera y esa función es la que
    // los pasa por el redactado de secretos y los acota. Pintarlos a mano se saltaría la defensa.
    const campos = campoLegible(e.campos);
    return `${prefijo}${guia.descripcion}${campos !== '' ? ` (campo: ${campos})` : ''}`;
  });

  const sobrantes = errores.length - visibles.length;
  if (sobrantes > 0) partes.push(`y ${sobrantes} error(es) más.`);

  return sanearMensaje(partes.join(' '));
}

/** Cómo acabó la resolución del motivo. */
export type DesenlaceMotivo = 'resuelto' | 'sin_errores' | 'pendiente';

/**
 * Consulta y traduce el motivo del rechazo de UNA factura (AC1, AC2, AC3, AC5).
 *
 * Devuelve el texto, o el marcador de pendiente si no se pudo obtener. No lanza: quien llama está
 * en mitad de un ciclo y un rechazo sin explicar sigue siendo un rechazo que hay que registrar.
 */
export async function resolverMotivoDeRechazo(f: {
  id: string; ambiente: string; siigoInvoiceId: string; numero: string | null;
}): Promise<{ motivo: string; desenlace: DesenlaceMotivo }> {
  try {
    const datos = await ejecutarConResiliencia(
      () => siigoRequestOrThrow<unknown>({
        metodo: 'GET',
        ruta: `/v1/invoices/${encodeURIComponent(f.siigoInvoiceId)}/stamp/errors`,
        ambiente: f.ambiente as SiigoAmbiente,
        timeoutMs: TIMEOUT_MOTIVO_MS,
      }),
      {
        // La misma cuota de la empresa, por la misma razón que el sondeo: es la cuota real.
        clave: claveResiliencia(f.ambiente),
        claveCortacircuitos: claveCortacircuitosMotivo(f.ambiente),
        // Menos reintentos que una operación crítica, a propósito. Esta consulta NO decide el estado
        // de la factura —ya está rechazada— y cada intento pasa por un limitador que duerme. Con los
        // cuatro por defecto, un endpoint de errores degradado se comería el plazo del ciclo que
        // protege el cerrojo, y el sondeo de estado se quedaría sin correr por culpa del detalle.
        maxIntentos: 2,
      },
    );

    const errores = normalizarErrores(datos);
    const texto = componerMotivo(errores);
    if (texto === null) {
      // La DIAN rechazó pero Siigo no da detalle. No es un fallo nuestro y no se reintenta en bucle:
      // se dice lo que se sabe, que es que no hay detalle.
      return {
        motivo: 'La DIAN rechazó la factura y Siigo no devolvió el detalle del error.',
        desenlace: 'sin_errores',
      };
    }
    return { motivo: texto, desenlace: 'resuelto' };
  } catch (e) {
    // AC5 — sigue rechazada, y el motivo queda como pendiente: distinguible de un rechazo sin causa.
    log.warn({ err: detalleTecnico(e), facturaId: f.id }, 'no se pudo obtener el detalle del rechazo');
    await registrarOperacion({
      ambiente: f.ambiente,
      operacion: OPERACION_MOTIVO_RECHAZO,
      resultado: 'error_tecnico',
      modo: modoSiigo(),
      entidadTipo: 'siigo_factura',
      entidadId: f.id,
      mensaje: `No se pudo consultar el detalle del rechazo de la factura ${f.numero ?? f.id}: ${motivoLegible(e)}`,
    });
    return { motivo: SIIGO_MOTIVO_RECHAZO_PENDIENTE, desenlace: 'pendiente' };
  }
}

/** Tope duro del lote. Cada elemento cuesta una petición de la cuota que comparte con la emisión. */
export const TOPE_LOTE = 50;

export interface ResumenCicloMotivos {
  revisadas: number;
  resueltos: number;
  pendientes: number;
}

/**
 * Barrido de las que quedaron sin explicar (AC4, AC5).
 *
 * **Solo se pregunta por lo rechazado.** Las aceptadas y las que siguen en validación no entran en
 * la consulta: no es que se salten dentro del bucle, es que no se traen, así que no gastan una sola
 * petición (AC4).
 *
 * Entran las que no tienen motivo —nadie preguntó— y las que tienen el marcador de pendiente —se
 * preguntó y falló—. Las que ya tienen explicación quedan fuera: volver a pedirla gastaría cuota
 * para escribir lo mismo.
 */
export async function resolverMotivosPendientes(presupuesto = 10): Promise<ResumenCicloMotivos> {
  const resumen: ResumenCicloMotivos = { revisadas: 0, resueltos: 0, pendientes: 0 };
  // Acotado aquí y no en quien llama: un `NaN` o un negativo revientan la consulta, y un número
  // grande se traduce en tantas peticiones contra la cuota que comparte con la emisión.
  const lote = Math.min(Math.max(Math.trunc(presupuesto) || 0, 0), TOPE_LOTE);
  if (lote === 0) return resumen;

  const filas = await db.execute<Record<string, unknown>>(sql`
    WITH vigente AS (
      SELECT DISTINCT ON (factura_id) factura_id, estado, motivo
        FROM siigo_factura_estados_dian
       ORDER BY factura_id, secuencia DESC
    ),
    -- Último intento de resolver ESTE motivo. Sin esto, una factura cuyo detalle no se puede obtener
    -- nunca —un identificador que Siigo ya no reconoce— volvería a consultarse en todos los barridos
    -- para siempre. Es exactamente el bicho que el sondeo de estado ya corrigió, y no repetirlo aquí
    -- habría dejado el mismo consumo de cuota entrando por otra puerta.
    ultimo_intento AS (
      SELECT entidad_id, max(created_at) AS intentado_en
        FROM siigo_operaciones
       WHERE operacion = ${OPERACION_MOTIVO_RECHAZO}
         AND entidad_tipo = 'siigo_factura'
       GROUP BY entidad_id
    )
    SELECT f.id, f.ambiente, f.siigo_invoice_id, f.numero
      FROM siigo_facturas f
      JOIN vigente v ON v.factura_id = f.id
      LEFT JOIN ultimo_intento i ON i.entidad_id = f.id::text
     WHERE v.estado = 'rechazada'
       AND (v.motivo IS NULL OR v.motivo = ${SIIGO_MOTIVO_RECHAZO_PENDIENTE})
       AND f.siigo_invoice_id IS NOT NULL
       AND btrim(f.siigo_invoice_id) <> ''
       -- Espera fija y no creciente: a diferencia del estado, el detalle de un rechazo no cambia
       -- con el tiempo. O está disponible o no lo está, así que reintentar una vez por hora basta
       -- y no hace falta una curva.
       AND (i.intentado_en IS NULL OR i.intentado_en < now() - INTERVAL '1 hour')
     -- Sin inanición: primero las que nunca se intentaron, después las que llevan más esperando.
     -- Ordenar solo por fecha de emisión dejaría a las antiguas sin consultar para siempre.
     ORDER BY i.intentado_en ASC NULLS FIRST, f.created_at DESC
     LIMIT ${lote}
  `);

  for (const fila of filas as unknown as Array<Record<string, unknown>>) {
    const f = {
      id: String(fila.id),
      ambiente: String(fila.ambiente),
      siigoInvoiceId: String(fila.siigo_invoice_id ?? fila.siigoInvoiceId),
      numero: (fila.numero as string | null) ?? null,
    };
    resumen.revisadas += 1;

    const { motivo, desenlace } = await resolverMotivoDeRechazo(f);
    try {
      // El motivo va DONDE VA EL ESTADO. La ingesta añade fila cuando el motivo cambia, así que el
      // historial acaba contando la verdad: primero «rechazada, sin saber por qué», después
      // «rechazada, y por esto». Es una historia, no una corrección encubierta.
      await aplicarEstadoDian({ facturaId: f.id, estado: 'rechazada', motivo, fuente: 'sondeo' });
    } catch (e) {
      log.error({ err: detalleTecnico(e), facturaId: f.id }, 'no se pudo registrar el motivo del rechazo');
      resumen.pendientes += 1;
      continue;
    }

    if (esMotivoPendiente(motivo) || desenlace === 'pendiente') resumen.pendientes += 1;
    else resumen.resueltos += 1;
  }

  return resumen;
}
