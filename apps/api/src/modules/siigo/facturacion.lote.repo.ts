// Siigo — el lote de facturación y lo que contiene (HU #11323, extraído en la HU #11327).
//
// **Por qué está aquí y no dentro de la emisión.** Hasta ahora el único que necesitaba un lote era
// quien acababa de elegir los trámites y los iba a emitir en el acto, así que `asegurarLote` vivía
// como función privada de `facturacion.emision.service.ts`. Con la cola aparecen dos usuarios más
// —el encolado, que crea el lote sin emitir nada, y el trabajador, que solo tiene un `loteId` y
// necesita saber qué hay dentro— y dejarlo donde estaba obligaría a que la cola importase el módulo
// de emisión entero para crear una fila.
//
// **LA HUELLA NO SE PUEDE INVERTIR, Y ESO ERA UN AGUJERO.** La identidad del lote es el sha256 del
// conjunto ordenado de trámites: sirve para reconocer «esto ya se encoló» —que es lo que impide dos
// claves de idempotencia para el mismo contenido— pero no para saber QUÉ contiene. Mientras emitía
// quien acababa de elegir, daba igual: los ids estaban en la mano. El trabajador de la cola toma una
// fila con un `loteId` y nada más. Por eso la pertenencia se escribe ahora en `siigo_lote_tramites`,
// **en el lote y no en la cola**: la cola dice cuándo toca trabajar, el lote dice sobre qué.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { esConceptoFacturable, type ConceptoFacturable, type SiigoDestinatario } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { siigoLotesFacturacion, siigoLoteTramites } from '../../db/schema.js';
import type { EmisionElegida } from './facturacion.armado.js';
// Solo el tipo: la regla de qué se hace con esa elección vive en `facturacion.correo.ts`, y este
// archivo es un repositorio. Un `import type` no deja nada en el bundle ni crea dependencia real.
import type { CorreoDelEnvio } from './facturacion.correo.js';
// El predicado de «esta columna contiene una dirección del titular» se importa, no se copia: es
// el mismo dato con la misma forma en las dos tablas y lo purga el mismo flujo. Dos copias eran
// dos criterios que se desincronizan, y el que se quedara atrás dejaría vivo lo que dice borrar.
import { correoDelTitularEn, correosDeBusqueda } from './siigo.envio-correo.service.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** La única estrategia de lote admitida hoy. Consolidar exige migración (D-1, diferida). */
export const ESTRATEGIA_LOTE = 'por_tramite';

export interface EntradaLote {
  ambiente: SiigoAmbiente;
  /** sha256 hex de trámites Y conceptos, ambos ordenados. La calcula `huellaDeLote`. */
  huella: string;
  /** Los trámites del conjunto. Es la preimagen de la huella, no una segunda verdad. */
  tramiteIds: string[];
  /**
   * Los conceptos que se van a facturar (A1). Preimagen de la huella igual que los trámites.
   *
   * Se guardan porque el envío solo ENCOLA: la emisión ocurre después, en el cron, y sin esto
   * volvería a deducir la lista de la liquidación y saldría una factura que nadie pidió.
   */
  conceptos: readonly string[];
  /**
   * La emisión elegida al enviar (A2). Todo `null` = lote anterior a la 0148, sin con qué emitir.
   *
   * **Ya NO significa «usar la configuración global»**: esa configuración se retiró el 2026-08-13 y
   * `prepararEmision` rechaza el lote que llegue sin comprobante, vendedor y forma de pago.
   */
  emision?: EmisionElegida | null;
  /**
   * Lo que el envío eligió sobre el correo al cliente (HU #11708). Ausente = no se pidió, que es lo
   * que significan también los lotes anteriores a la migración 0161.
   *
   * **No entra en la huella**, al revés que `conceptos` y `emision`. Ver el comentario de la columna
   * en `schema.ts`: el correo no cambia el documento que ve la DIAN, así que darle identidad propia
   * al lote sería crear una segunda clave de idempotencia para la misma factura.
   */
  correo?: CorreoDelEnvio | null;
  creadoPor: number | null;
}

/**
 * El lote del conjunto, creado o recuperado, con su pertenencia registrada.
 *
 * La identidad es el CONTENIDO, no un id nuevo: con un id aleatorio, dos encolados del mismo trámite
 * darían dos lotes, dos claves de idempotencia y dos facturas DIAN. El `ON CONFLICT` deja que lo
 * garantice el índice único, porque entre un SELECT y un INSERT cabe otra petición.
 *
 * **Devuelve `null` en vez de lanzar** cuando el lote desaparece entre el INSERT y el SELECT —solo
 * puede pasar si alguien lo borra a mano en ese instante—. No es rigidez: este módulo es un
 * repositorio y sus llamadores traducen ese hueco a errores distintos (la emisión, a un fallo de
 * datos; el encolado, a un rechazo del encolado). Lanzar aquí obligaría a uno de los dos a
 * reinterpretar un error ajeno leyendo su mensaje.
 */
export async function asegurarLote(entrada: EntradaLote): Promise<string | null> {
  const loteId = await crearORecuperar(entrada);
  if (!loteId) return null;
  await registrarPertenencia(loteId, entrada.tramiteIds);
  return loteId;
}

async function crearORecuperar(entrada: EntradaLote): Promise<string | null> {
  const [creado] = await db.insert(siigoLotesFacturacion)
    .values({
      ambiente: entrada.ambiente,
      estrategia: ESTRATEGIA_LOTE,
      huella: entrada.huella,
      // Ordenados al guardar, igual que al calcular la huella: la fila y el hash tienen que contar
      // la misma historia para que se puedan contrastar cuando alguien pregunte por una factura.
      conceptos: [...new Set(entrada.conceptos)].sort(),
      documentoTipoCodigo: entrada.emision?.documentoTipoCodigo ?? null,
      vendedorCodigo: entrada.emision?.vendedorCodigo ?? null,
      formaPagoCodigo: entrada.emision?.formaPagoCodigo ?? null,
      centroCostoCodigo: entrada.emision?.centroCostoCodigo ?? null,
      correoSolicitado: entrada.correo?.solicitado ?? false,
      correoDestinatarios: entrada.correo?.destinatarios ?? [],
      creadoPor: entrada.creadoPor,
    })
    .onConflictDoNothing({
      target: [
        siigoLotesFacturacion.ambiente, siigoLotesFacturacion.estrategia, siigoLotesFacturacion.huella,
      ],
    })
    .returning({ id: siigoLotesFacturacion.id });
  if (creado) return String(creado.id);

  const [existente] = await db.select({ id: siigoLotesFacturacion.id })
    .from(siigoLotesFacturacion)
    .where(and(
      eq(siigoLotesFacturacion.ambiente, entrada.ambiente),
      eq(siigoLotesFacturacion.estrategia, ESTRATEGIA_LOTE),
      eq(siigoLotesFacturacion.huella, entrada.huella),
    ))
    .limit(1);
  return existente ? String(existente.id) : null;
}

/**
 * Deja escrito qué contiene el lote. Repetible: la misma pareja no se duplica.
 *
 * Se hace SIEMPRE, también cuando el lote ya existía, y a propósito: un lote creado antes de la
 * migración 0144 no tiene pertenencia, y el reintento de hoy es la única ocasión de que la gane sin
 * que nadie tenga que acordarse.
 */
async function registrarPertenencia(loteId: string, tramiteIds: string[]): Promise<void> {
  const ids = [...new Set(tramiteIds)].filter(Boolean);
  if (ids.length === 0) return;
  await db.insert(siigoLoteTramites)
    .values(ids.map((tramiteId) => ({ loteId, tramiteId })))
    .onConflictDoNothing({ target: [siigoLoteTramites.loteId, siigoLoteTramites.tramiteId] });
}

/**
 * Los trámites de un lote, ORDENADOS.
 *
 * El orden no es cosmético: la clave de idempotencia se deriva de la huella, y la huella se calcula
 * sobre los ids ordenados. Devolverlos en el orden que quisiera el planificador haría que el mismo
 * lote produjera claves distintas según el plan de la consulta — que es exactamente la carrera que
 * todo este modelo existe para cerrar. `emitirFactura` los vuelve a ordenar, así que esto es la
 * segunda cerradura de la misma puerta y no sobra.
 */
export async function tramitesDelLote(loteId: string): Promise<string[]> {
  const filas = await db.select({ tramiteId: siigoLoteTramites.tramiteId })
    .from(siigoLoteTramites)
    .where(eq(siigoLoteTramites.loteId, loteId))
    .orderBy(asc(siigoLoteTramites.tramiteId));
  return filas.map((f) => String(f.tramiteId));
}

/**
 * Los conceptos que este lote va a facturar (A1).
 *
 * **Vacío significa «lote anterior a A1», no «ninguno».** Aquellos lotes se crearon cuando la
 * factura llevaba todos los conceptos aplicables de la liquidación, y quien llama tiene que
 * distinguir los dos casos: emitir un lote vacío como si nadie hubiera elegido nada produciría una
 * factura sin líneas, y tratarlo como «todos» es lo que aquellos lotes de verdad significaban.
 */
export async function conceptosDelLote(loteId: string): Promise<ConceptoFacturable[]> {
  const [fila] = await db.select({ conceptos: siigoLotesFacturacion.conceptos })
    .from(siigoLotesFacturacion)
    .where(eq(siigoLotesFacturacion.id, loteId))
    .limit(1);
  return conceptosDeLaColumna(fila?.conceptos);
}

/**
 * La columna `conceptos` leída como catálogo. **Una sola definición**, y por eso está exportada.
 *
 * Se filtra contra el catálogo en vez de confiar en la columna. `text[]` no tiene CHECK, y un valor
 * que ya no sea un concepto conocido —porque se renombró o se retiró— llegaría al armado como una
 * clave que el mapeo no tiene y acabaría en `concepto_sin_mapeo`, culpando al mapeo de un dato
 * viejo. Descartarlo aquí deja el fallo donde de verdad está.
 *
 * La usa también la reconciliación, que lee esta columna por un JOIN y no por este repositorio: sin
 * exportarla, ese segundo lector tendría su propia idea de qué contiene un lote, y dos lecturas
 * distintas del mismo lote es justo lo que produce un descuadre inventado.
 */
export function conceptosDeLaColumna(valor: readonly string[] | null | undefined): ConceptoFacturable[] {
  return [...(valor ?? [])].filter(esConceptoFacturable).sort();
}

/**
 * La emisión que se eligió para este lote (A2).
 *
 * **Todo `null` significa «lote anterior al 2026-08-13, sin con qué emitir».** Hasta la 0148
 * significaba «usar la configuración global» y quien llamaba tenía que resolver esa ausencia contra
 * los parámetros del ambiente; esa configuración ya no existe, así que ahora no hay nada detrás y
 * `prepararEmision` rechaza el lote pidiendo que se reenvíen los trámites. Ver la 0148.
 */
export async function emisionDelLote(loteId: string): Promise<EmisionElegida> {
  const [fila] = await db.select({
    documentoTipoCodigo: siigoLotesFacturacion.documentoTipoCodigo,
    vendedorCodigo: siigoLotesFacturacion.vendedorCodigo,
    formaPagoCodigo: siigoLotesFacturacion.formaPagoCodigo,
    centroCostoCodigo: siigoLotesFacturacion.centroCostoCodigo,
  })
    .from(siigoLotesFacturacion)
    .where(eq(siigoLotesFacturacion.id, loteId))
    .limit(1);
  return {
    documentoTipoCodigo: fila?.documentoTipoCodigo ?? null,
    vendedorCodigo: fila?.vendedorCodigo ?? null,
    formaPagoCodigo: fila?.formaPagoCodigo ?? null,
    centroCostoCodigo: fila?.centroCostoCodigo ?? null,
  };
}

/**
 * Lo que este lote eligió sobre el correo al cliente (HU #11708).
 *
 * **Ausente en la fila = no se pidió.** Es el valor por omisión de la columna y el que tienen los
 * lotes anteriores a la 0161, y significa exactamente lo mismo en los dos casos: la emisión no manda
 * correo y deja acta `no_realizado` con `no_solicitado`. No hay aquí ninguna deuda de compatibilidad
 * escondida, porque hasta esta historia el correo lo decidía el ambiente y no el lote.
 *
 * Un lote que no existe devuelve también «no solicitado», y no lanza: quien llama —el trabajador—
 * ya trata el lote sin trámites como un fallo de datos con su mensaje propio, y un segundo error
 * distinto para el mismo lote fantasma solo cambiaría cuál de los dos se ve.
 */
export async function correoDelLote(loteId: string): Promise<CorreoDelEnvio> {
  const [fila] = await db.select({
    solicitado: siigoLotesFacturacion.correoSolicitado,
    destinatarios: siigoLotesFacturacion.correoDestinatarios,
  })
    .from(siigoLotesFacturacion)
    .where(eq(siigoLotesFacturacion.id, loteId))
    .limit(1);
  return {
    solicitado: fila?.solicitado === true,
    destinatarios: (fila?.destinatarios ?? []) as SiigoDestinatario[],
  };
}

/**
 * Borra las direcciones elegidas de los lotes de un titular (Ley 1581).
 *
 * Hermana de `purgarDestinatariosDeClientes`, que hace lo propio con las actas, y por el mismo
 * motivo: desde la HU #11708 esta tabla guarda direcciones, así que tiene que estar al alcance del
 * derecho de supresión. Una copia que la purga no alcanza es peor que no tener el dato, porque al
 * titular se le responde que se olvidó.
 *
 * **Se busca por los dos caminos, igual que en las actas y por las mismas tres razones**: la
 * compañía de los trámites del lote puede ser NULL, las direcciones escritas a mano pueden ser de un
 * tercero que no es el cliente de esos trámites, y una segunda ejecución del olvido ya no encuentra
 * clientes que buscar. El segundo camino es `correoDelTitularEn`, la MISMA función que usan las
 * actas: compara en minúsculas los dos lados porque la ruta del envío normaliza lo que se teclea y
 * la ficha del cliente se guarda tal cual se escribió, así que la coincidencia exacta no encontraba
 * la fila que ella misma acababa de producir. Por eso la 0161 no crea un GIN de contención —que este
 * predicado no usaría— sino un btree parcial sobre el mismo `jsonb_array_length(...) > 0` con el que
 * filtra la consulta de abajo. El razonamiento completo está en `correoDelTitularEn`.
 *
 * A diferencia del acta, aquí **no se conserva ninguna marca**: el lote no es un registro de lo que
 * pasó —eso es el acta— sino una instrucción de lo que había que hacer, y una instrucción cumplida
 * sin destinatarios no le debe nada a nadie. Vaciarla es idempotente: no hay disparador que se queje
 * de una segunda purga, y por eso tampoco hace falta excluir las ya purgadas.
 *
 * Recibe el ejecutor porque el olvido corre dentro de UNA transacción: con la conexión suelta, estas
 * direcciones podrían borrarse mientras el resto del olvido se deshace, o al revés.
 */
export async function purgarDestinatariosDeLotes(
  companiaIds: number[],
  correos: string[] = [],
  ejecutor: Pick<typeof db, 'select' | 'update'> = db,
): Promise<number> {
  const limpios = correosDeBusqueda(correos);
  if (companiaIds.length === 0 && limpios.length === 0) return 0;

  const porCompania = companiaIds.length > 0
    ? sql`EXISTS (
        SELECT 1 FROM siigo_lote_tramites slt
          JOIN flito_tramites ft ON ft.id = slt.tramite_id
         WHERE slt.lote_id = ${siigoLotesFacturacion.id}
           AND ft.compania_id IN (${sql.join(companiaIds.map((c) => sql`${c}`), sql`, `)}))`
    : sql`false`;

  const porCorreo = correoDelTitularEn(siigoLotesFacturacion.correoDestinatarios, limpios);

  // Solo los que tienen algo que borrar: sin este filtro, un olvido tocaría todos los lotes de la
  // compañía —que pueden ser miles— para dejarlos como estaban, y el resumen que se le entrega al
  // titular diría que se purgaron mil filas en las que no había ni una dirección.
  const lotes = await ejecutor.select({ id: siigoLotesFacturacion.id })
    .from(siigoLotesFacturacion)
    .where(and(
      sql`jsonb_array_length(${siigoLotesFacturacion.correoDestinatarios}) > 0`,
      sql`(${porCompania} OR ${porCorreo})`,
    ));

  if (lotes.length === 0) return 0;

  const purgados = await ejecutor.update(siigoLotesFacturacion)
    .set({ correoDestinatarios: [] })
    .where(inArray(siigoLotesFacturacion.id, lotes.map((l) => l.id)))
    .returning({ id: siigoLotesFacturacion.id });

  return purgados.length;
}

/**
 * Los lotes que contienen alguno de estos trámites, con su ambiente.
 *
 * Lo usa la consulta de estado de la cola: quien pregunta conoce trámites, no lotes.
 */
export async function lotesDeTramites(
  ambiente: SiigoAmbiente, tramiteIds: string[],
): Promise<Array<{ loteId: string; tramiteId: string }>> {
  if (tramiteIds.length === 0) return [];
  const filas = await db.select({
    loteId: siigoLoteTramites.loteId,
    tramiteId: siigoLoteTramites.tramiteId,
  })
    .from(siigoLoteTramites)
    .innerJoin(siigoLotesFacturacion, eq(siigoLotesFacturacion.id, siigoLoteTramites.loteId))
    .where(and(
      eq(siigoLotesFacturacion.ambiente, ambiente),
      sql`${siigoLoteTramites.tramiteId} = ANY(${sql.param(tramiteIds)}::uuid[])`,
    ));
  return filas.map((f) => ({ loteId: String(f.loteId), tramiteId: String(f.tramiteId) }));
}
