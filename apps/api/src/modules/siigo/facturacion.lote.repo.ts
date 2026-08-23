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
import { esConceptoFacturable, type ConceptoFacturable } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { siigoLotesFacturacion, siigoLoteTramites } from '../../db/schema.js';
import type { EmisionElegida } from './facturacion.armado.js';
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
 * Todo lo que hace falta para volver a encolar varios lotes, **en dos consultas y no en 3·N**.
 *
 * Existe por la bandeja de fallidos (HU #11340): reintentar cien facturas con
 * `tramitesDelLote` + `conceptosDelLote` + `emisionDelLote` serían trescientas consultas antes de
 * empezar a encolar. Las tres funciones de una en una siguen ahí porque el trabajador las usa así
 * —toma UNA fila y pregunta por SU lote—, y esto no las sustituye: las agrupa.
 *
 * Vive en el repositorio y no en la bandeja **para que siga habiendo un solo lector del lote**. Si
 * la bandeja leyera `siigo_lotes_facturacion` por su cuenta, tendría su propia idea de qué contiene
 * un lote —empezando por cómo se filtra `conceptos` contra el catálogo— y dos lecturas distintas del
 * mismo lote es exactamente lo que produce una factura con líneas que nadie pidió.
 *
 * Un lote que no existe simplemente no sale en el mapa: quien pregunta distingue «vacío» de
 * «ausente», y son cosas distintas (ver `conceptosDelLote`).
 */
export interface ContenidoLote {
  tramiteIds: string[];
  /** Vacío = lote anterior a A1. **No es «ninguno»**: no se puede reencolar tal cual. */
  conceptos: ConceptoFacturable[];
  emision: EmisionElegida;
}

export async function contenidoDeLotes(loteIds: string[]): Promise<Map<string, ContenidoLote>> {
  const ids = [...new Set(loteIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const lotes = await db.select({
    id: siigoLotesFacturacion.id,
    conceptos: siigoLotesFacturacion.conceptos,
    documentoTipoCodigo: siigoLotesFacturacion.documentoTipoCodigo,
    vendedorCodigo: siigoLotesFacturacion.vendedorCodigo,
    formaPagoCodigo: siigoLotesFacturacion.formaPagoCodigo,
    centroCostoCodigo: siigoLotesFacturacion.centroCostoCodigo,
  }).from(siigoLotesFacturacion)
    .where(sql`${siigoLotesFacturacion.id} = ANY(${sql.param(ids)}::uuid[])`);

  const pertenencia = await db.select({
    loteId: siigoLoteTramites.loteId,
    tramiteId: siigoLoteTramites.tramiteId,
  }).from(siigoLoteTramites)
    .where(sql`${siigoLoteTramites.loteId} = ANY(${sql.param(ids)}::uuid[])`)
    // El MISMO orden que `tramitesDelLote`, y no por gusto: la clave de idempotencia se deriva de la
    // huella y la huella se calcula sobre los ids ordenados. Dos lecturas del mismo lote que
    // devolvieran órdenes distintos producirían huellas distintas, es decir, DOS LOTES para el mismo
    // contenido — la carrera que todo este modelo existe para cerrar.
    .orderBy(asc(siigoLoteTramites.tramiteId));

  const tramitesPorLote = new Map<string, string[]>();
  for (const p of pertenencia) {
    const lista = tramitesPorLote.get(String(p.loteId)) ?? [];
    lista.push(String(p.tramiteId));
    tramitesPorLote.set(String(p.loteId), lista);
  }

  return new Map(lotes.map((l) => [String(l.id), {
    tramiteIds: tramitesPorLote.get(String(l.id)) ?? [],
    conceptos: conceptosDeLaColumna(l.conceptos),
    emision: {
      documentoTipoCodigo: l.documentoTipoCodigo ?? null,
      vendedorCodigo: l.vendedorCodigo ?? null,
      formaPagoCodigo: l.formaPagoCodigo ?? null,
      centroCostoCodigo: l.centroCostoCodigo ?? null,
    },
  }]));
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
