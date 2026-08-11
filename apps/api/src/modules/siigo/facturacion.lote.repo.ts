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

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { siigoLotesFacturacion, siigoLoteTramites } from '../../db/schema.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** La única estrategia de lote admitida hoy. Consolidar exige migración (D-1, diferida). */
export const ESTRATEGIA_LOTE = 'por_tramite';

export interface EntradaLote {
  ambiente: SiigoAmbiente;
  /** sha256 hex del conjunto ORDENADO de trámites. La calcula `huellaDeTramites`. */
  huella: string;
  /** Los trámites del conjunto. Es la preimagen de la huella, no una segunda verdad. */
  tramiteIds: string[];
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
