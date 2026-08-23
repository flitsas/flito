// Siigo — lo que se HACE desde la bandeja de fallidos (HU #11340, Feature #11244).
//
// Aparte de `siigo.bandeja.service.ts`, que solo consulta. No es una partición por tamaño: son dos
// responsabilidades que fallan de formas distintas —una consulta lenta molesta, una acción mal hecha
// emite un documento ante la DIAN— y mezclarlas dejaría el `UNION ALL` de tres patas y el reintento
// en lote en el mismo archivo, por encima del techo de 800 líneas que el gate hace cumplir.
//
// ── LA LÍNEA QUE NO SE CRUZA (AC4) ─────────────────────────────────────────────────────────────
//
// **Este archivo no emite y no llama a Siigo para emitir.** El reintento de la bandeja rearma la
// fila de cola y vuelve; la emisión la hace después el trabajador, por la cadena que ya existe:
//
//     bandeja → encolar() → siigo.cola.cron → procesarCicloEmision() → tomarLote() [SKIP LOCKED]
//             → emitirFactura() → reclamarFallida()
//
// Quien impide la doble factura es `reclamarFallida()` —`facturacion.emision.service.ts`—, cuya
// condición `estado = 'fallida'` viaja DENTRO del `UPDATE`, más la reserva de la clave de
// idempotencia y el índice de trámites vivos. **Esta historia no implementa idempotencia propia y no
// debe implementarla**: una segunda guarda que se creyera suficiente sería peor que ninguna. Si en
// este archivo aparece un `UPDATE` sobre `siigo_facturas`, está mal.
//
// La única rama que SÍ sale a la red es el reenvío del correo, y ahí la factura ya existe: no puede
// duplicar nada. Reutiliza `enviarFacturaPorCorreo`, que ya envuelve la llamada en
// `ejecutarConResiliencia` —cuyo limitador DUERME en vez de rechazar cuando la ventana está llena—.
// **No se vuelve a envolver**: dos capas de resiliencia multiplicarían los reintentos (4×4 = hasta
// dieciséis peticiones por correo) contra una cuota de 100 por minuto compartida con la emisión.

import {
  SIIGO_BANDEJA_MOTIVO_DESCARTE_ETIQUETA, SIIGO_BANDEJA_NOTA_MAX, SIIGO_BANDEJA_TOPE_REENVIO,
  SIIGO_BANDEJA_TOPE_REINTENTO, resumirCorreo, resumirReintento,
} from '@operaciones/shared-types';
import type {
  SiigoBandejaDescarte, SiigoBandejaFuente, SiigoBandejaItemCorreo, SiigoBandejaItemReintento,
  SiigoBandejaMotivoDescarte, SiigoBandejaRespuestaCorreo, SiigoBandejaRespuestaDescarte,
  SiigoBandejaRespuestaReactivacion, SiigoBandejaRespuestaReintento, SiigoBandejaResultado,
} from '@operaciones/shared-types';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { siigoColaFacturacion, siigoFacturaEnvios, siigoFacturas } from '../../db/schema.js';
import { descartarDefinitivo, encolar, SiigoColaError } from './facturacion.cola.service.js';
import { contenidoDeLotes, type ContenidoLote } from './facturacion.lote.repo.js';
import { descartesVigentes, guiaDelCaso } from './siigo.bandeja.service.js';
import { enviarFacturaPorCorreo, SiigoEnvioError } from './siigo.envio-correo.service.js';
import { registrarHito } from './siigo.linea-tiempo.service.js';
import { sanearMensaje } from './siigo.redaccion.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** Fallo de uso de la bandeja. La ruta lo traduce a HTTP; este archivo no sabe de códigos. */
export class SiigoBandejaError extends Error {
  readonly codigo:
    | 'no_existe'
    /** La pata no admite esta acción: un rechazo de la DIAN no se da por perdido, se corrige. */
    | 'fuente_no_admite'
    /** Un trabajador tiene la fila arrendada ahora mismo. Se reintenta en un minuto. */
    | 'en_proceso'
    /** Ya se emitió: hay documento ante la DIAN. */
    | 'ya_emitida'
    /** No estaba dado por perdido, así que no hay nada que resucitar. */
    | 'no_descartado'
    /** El lote es anterior a A1 y no se puede reencolar tal cual. */
    | 'no_aplica';

  constructor(codigo: SiigoBandejaError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoBandejaError';
    this.codigo = codigo;
  }
}

/**
 * Lo que dice el servidor cuando un lote es anterior a A1.
 *
 * **Este caso revienta en producción si se ignora.** Los lotes creados antes de A1 tienen
 * `conceptos = []`, y `encolar` les lanza `sin_conceptos`. Sin tratarlo, una sola factura histórica
 * dentro de una selección de cien tumbaría la petición entera con un 500 y ninguna de las otras
 * noventa y nueve se reintentaría. Sale como `no_aplica` con la acción concreta.
 */
const TEXTO_SIN_CONCEPTOS =
  'Este lote es anterior a la elección de conceptos y no dice qué facturar. Reenvíalo desde el '
  + 'reporte de costos eligiendo los conceptos; reintentarlo desde aquí no puede saber qué emitir.';

const TEXTO_SIN_TRAMITES =
  'Este lote no registra qué trámites contiene y no se puede reconstruir. Reenvía los trámites '
  + 'desde el reporte de costos.';

const TEXTO_DESCARTADO =
  'Alguien lo dio por perdido con un motivo. No vuelve con un reintento normal: hay que resucitarlo '
  + 'a propósito, y ese acto queda registrado.';

// ── AC2 y AC3 — reintentar la emisión en lote ───────────────────────────────

export interface EntradaReintento {
  ambiente: SiigoAmbiente;
  facturaIds: string[];
  usuarioId: number | null;
  ahora?: Date;
}

interface FilaCola {
  id: string;
  estado: string;
  /** El desenlace del trabajador. Manda sobre el de la factura: es más reciente y más específico. */
  errorCode: string | null;
}

interface FilaFactura {
  id: string;
  estado: string;
  loteId: string;
  errorCode: string | null;
}

/**
 * AC2 — Reintenta un lote de emisiones fallidas. **No llama a Siigo ni una sola vez.**
 *
 * El tope es duro y se aplica ANTES de tocar la base: `facturaIds` llega ya recortado por Zod en la
 * ruta y aquí se vuelve a recortar, porque esta función tiene más de una puerta posible.
 *
 * **El fallo de una no se lleva por delante a las demás** (misma regla que `enviarAFacturacion`):
 * cada factura tiene su propio desenlace, incluido el error inesperado, y el bucle no lanza nunca.
 * Quien selecciona cien casos de la bandeja no los ha revisado uno por uno; si el primero histórico
 * tumbara la petición, la única forma de operar la bandeja sería de una en una.
 *
 * En SERIE y no en paralelo: cada encolado son cuatro sentencias con un `ON CONFLICT`, y cien en
 * paralelo agotarían el pool de conexiones para atender un solo clic.
 */
export async function reintentarEmision(e: EntradaReintento): Promise<SiigoBandejaRespuestaReintento> {
  const ahora = e.ahora ?? new Date();
  const ids = [...new Set(e.facturaIds.filter(Boolean))].slice(0, SIIGO_BANDEJA_TOPE_REINTENTO);
  if (ids.length === 0) {
    return { ambiente: e.ambiente, items: [], resumen: resumirReintento([]) };
  }

  const facturas = await cargarFacturas(e.ambiente, ids);
  const lotes = await contenidoDeLotes([...new Set([...facturas.values()].map((f) => f.loteId))]);
  const colas = await colaPorLote([...lotes.keys()]);
  // Quién está dado por perdido POR UNA PERSONA. Es lo que separa esta acción de `reactivar`: el
  // trabajador que agota su techo también deja la fila `fallido_definitivo`, y ESO sí lo desatasca
  // un reintento normal —para eso existe la bandeja—. Lo que una persona decidió no vuelve solo.
  const descartados = await descartesVigentes('siigo_cola', [...colas.values()].map((c) => c.id));

  const items: SiigoBandejaItemReintento[] = [];
  for (const facturaId of ids) {
    items.push(await reintentarUna({
      facturaId, factura: facturas.get(facturaId), lotes, colas, descartados, entrada: e, ahora,
    }));
  }
  return { ambiente: e.ambiente, items, resumen: resumirReintento(items) };
}

interface ContextoReintento {
  facturaId: string;
  factura: FilaFactura | undefined;
  lotes: Map<string, ContenidoLote>;
  colas: Map<string, FilaCola>;
  descartados: Map<string, SiigoBandejaDescarte>;
  entrada: EntradaReintento;
  ahora: Date;
}

/**
 * Una factura. El orden de las comprobaciones ES la regla, no una preferencia de escritura:
 *
 *   1. ¿Existe y sigue fallida? — sobre lo que no falló no hay nada que reintentar.
 *   2. **¿Lo arregla reintentar?** (AC3) — se decide con el código YA PERSISTIDO y sin tocar la cola.
 *      Ponerlo después de encolar habría gastado la escritura para nada; ponerlo después de llamar a
 *      Siigo habría gastado además una petición de la cuota, que es justo lo que el AC3 prohíbe.
 *   3. ¿Alguien lo dio por perdido? — eso solo lo deshace `reactivar`, y con registro.
 *   4. ¿Se puede reencolar el lote? — los anteriores a A1 no, y lo dicen sin reventar.
 */
async function reintentarUna(c: ContextoReintento): Promise<SiigoBandejaItemReintento> {
  const base = {
    facturaId: c.facturaId, motivo: null, guia: null, colaId: null, loteId: null, estado: null,
  };
  if (!c.factura) {
    return { ...base, resultado: 'error', motivo: 'La factura no existe en este ambiente.' };
  }
  if (c.factura.estado === 'emitida') {
    return { ...base, resultado: 'ya_enviado', loteId: c.factura.loteId, motivo: 'Ya está emitida.' };
  }
  if (c.factura.estado !== 'fallida') {
    return {
      ...base, resultado: 'ya_en_cola', loteId: c.factura.loteId,
      motivo: 'La emisión sigue en curso: no hay nada que reintentar todavía.',
    };
  }

  const cola = c.colas.get(c.factura.loteId);
  // El código de la COLA manda sobre el de la factura, y cae al de la factura cuando la cola no
  // tiene: el desenlace del trabajador es más reciente y más específico que lo último que se
  // escribió en el documento, pero una factura fallida SIN fila de cola —emisión directa
  // histórica— solo tiene el suyo, y quedarse sin código ahí perdería el diagnóstico entero.
  const guiaReal = guiaDelCaso(cola?.errorCode ?? c.factura.errorCode);

  // AC3 — aquí, en memoria, antes de escribir nada y sin una sola petición a Siigo.
  //
  // `sirveReintentar` y NO `reintentable`: son dos preguntas distintas y usar la equivocada
  // descartaba justo los casos más claros. `reintentable` significa «vuelve solo» —y por eso su
  // responsable es siempre `automatico`—; lo que el AC3 pregunta es si reintentar SIRVE, que
  // incluye lo que ya no vuelve solo pero se desatasca pulsando (una emisión que la reconciliación
  // comprobó que Siigo no tiene, por ejemplo).
  if (!guiaReal.sirveReintentar) {
    return {
      ...base,
      resultado: 'descartado_datos',
      motivo: guiaReal.texto,
      guia: guiaReal,
      loteId: c.factura.loteId,
      colaId: cola?.id ?? null,
      estado: null,
    };
  }

  const descarte = cola ? c.descartados.get(cola.id) : undefined;
  if (descarte) {
    return {
      ...base,
      resultado: 'fallido_definitivo',
      motivo: `${TEXTO_DESCARTADO} Motivo registrado: ${etiqueta(descarte)}.`,
      guia: guiaReal,
      loteId: c.factura.loteId,
      colaId: cola?.id ?? null,
    };
  }

  const contenido = c.lotes.get(c.factura.loteId);
  const impedimento = queImpide(contenido);
  if (impedimento) {
    return {
      ...base, resultado: 'no_aplica', motivo: impedimento, guia: guiaReal,
      loteId: c.factura.loteId, colaId: cola?.id ?? null,
    };
  }

  try {
    const r = await encolar({
      tramiteIds: contenido!.tramiteIds,
      conceptos: contenido!.conceptos,
      emision: contenido!.emision,
      ambiente: c.entrada.ambiente,
      usuarioId: c.entrada.usuarioId,
      // `reactivar: true` **y no es una contradicción con el AC5**: lo que el AC5 protege es la
      // decisión de una PERSONA, y esa se filtró tres comprobaciones más arriba. Lo que queda aquí
      // son filas que el trabajador dejó `fallido_definitivo` al agotar su techo de intentos, que es
      // exactamente el trabajo atascado que esta bandeja existe para desatascar. Sin esto, el botón
      // de reintentar no haría nada en la mayoría de los casos y el AC2 sería falso.
      reactivar: true,
      ahora: c.ahora,
    });
    return {
      ...base,
      resultado: r.resultado as SiigoBandejaResultado,
      colaId: r.colaId,
      loteId: r.loteId,
      estado: r.estado,
      guia: guiaReal,
    };
  } catch (err) {
    if (err instanceof SiigoColaError && err.codigo === 'sin_conceptos') {
      return { ...base, resultado: 'no_aplica', motivo: TEXTO_SIN_CONCEPTOS, guia: guiaReal };
    }
    if (err instanceof SiigoColaError && err.codigo === 'sin_tramites') {
      return { ...base, resultado: 'no_aplica', motivo: TEXTO_SIN_TRAMITES, guia: guiaReal };
    }
    // `sanearMensaje` SIEMPRE: un error del motor envuelto por drizzle llega con la sentencia y sus
    // parámetros dentro —aquí, identificadores de trámite— y este texto acaba en pantalla.
    return {
      ...base,
      resultado: 'error',
      guia: guiaReal,
      motivo: sanearMensaje(err instanceof Error ? err.message : 'Fallo al reintentar.'),
    };
  }
}

/**
 * Qué impide reencolar el lote tal cual, o `null` si nada lo impide.
 *
 * Se comprueba ANTES de llamar a `encolar` aunque `encolar` también lo detecte: el error de allá es
 * una excepción con un mensaje pensado para quien envía desde el reporte de costos, y aquí hay que
 * decirle a quien opera la bandeja qué hacer en su pantalla. El `catch` de abajo lo vuelve a cubrir
 * por si el lote cambia entre esta lectura y el encolado.
 */
function queImpide(contenido: ContenidoLote | undefined): string | null {
  if (!contenido) return TEXTO_SIN_TRAMITES;
  if (contenido.tramiteIds.length === 0) return TEXTO_SIN_TRAMITES;
  if (contenido.conceptos.length === 0) return TEXTO_SIN_CONCEPTOS;
  return null;
}

function etiqueta(d: SiigoBandejaDescarte): string {
  return d.motivo ? SIIGO_BANDEJA_MOTIVO_DESCARTE_ETIQUETA[d.motivo] : d.motivoEtiqueta;
}

async function cargarFacturas(
  ambiente: SiigoAmbiente, ids: string[],
): Promise<Map<string, FilaFactura>> {
  const filas = await db.select({
    id: siigoFacturas.id, estado: siigoFacturas.estado, loteId: siigoFacturas.loteId,
    errorCode: siigoFacturas.errorCode, ambiente: siigoFacturas.ambiente,
  }).from(siigoFacturas).where(inArray(siigoFacturas.id, ids));

  return new Map(filas
    // El ambiente se comprueba AQUÍ y no en el `WHERE` a propósito: así una factura de otro ambiente
    // desaparece igual, pero el filtro que la descarta está escrito donde se lee.
    .filter((f) => String(f.ambiente) === ambiente)
    .map((f) => [String(f.id), {
      id: String(f.id), estado: String(f.estado), loteId: String(f.loteId),
      errorCode: f.errorCode ?? null,
    }]));
}

/**
 * La fila de cola de cada lote. **Sin estado de módulo**: el mapa se devuelve y vive lo que vive la
 * petición. Un `Map` a nivel de módulo lo compartirían dos reintentos simultáneos, y el segundo
 * pisaría los códigos de error del primero — que es lo que decide si algo se reintenta (AC3).
 */
async function colaPorLote(loteIds: string[]): Promise<Map<string, FilaCola>> {
  if (loteIds.length === 0) return new Map();
  const filas = await db.select({
    id: siigoColaFacturacion.id, loteId: siigoColaFacturacion.loteId,
    estado: siigoColaFacturacion.estado, errorCode: siigoColaFacturacion.errorCode,
  }).from(siigoColaFacturacion).where(inArray(siigoColaFacturacion.loteId, loteIds));

  return new Map(filas.map((f) => [String(f.loteId), {
    id: String(f.id), estado: String(f.estado), errorCode: f.errorCode ?? null,
  }]));
}

// ── AC2 y AC3 — reenviar el correo en lote ──────────────────────────────────

export interface EntradaReenvio {
  ambiente: SiigoAmbiente;
  facturaIds: string[];
  usuarioId: number | null;
}

/**
 * AC2 — Reenvía el correo de varias facturas. **Esta sí sale a la red, y por eso el tope es 20.**
 *
 * Devuelve 200 y no 202 porque cuando contesta el acta YA existe: el envío ocurrió (o se comprobó que
 * no podía ocurrir) dentro de esta petición. Un 202 prometería algo en marcha que no lo está.
 *
 * En serie, obligatoriamente: `ejecutarConResiliencia` —dentro de `enviarFacturaPorCorreo`— hace
 * cola con `esperarTurno`, que DUERME cuando la ventana de 100 por minuto está llena. En paralelo,
 * veinte correos dormirían a la vez reteniendo veinte conexiones del pool.
 */
export async function reenviarCorreo(e: EntradaReenvio): Promise<SiigoBandejaRespuestaCorreo> {
  const ids = [...new Set(e.facturaIds.filter(Boolean))].slice(0, SIIGO_BANDEJA_TOPE_REENVIO);
  if (ids.length === 0) {
    return { ambiente: e.ambiente, items: [], resumen: resumirCorreo([]) };
  }

  const ultimas = await ultimasActas(ids);
  const items: SiigoBandejaItemCorreo[] = [];
  for (const facturaId of ids) items.push(await reenviarUno(facturaId, ultimas, e));
  return { ambiente: e.ambiente, items, resumen: resumirCorreo(items) };
}

async function reenviarUno(
  facturaId: string,
  ultimas: Map<string, { id: string; codigo: string | null }>,
  e: EntradaReenvio,
): Promise<SiigoBandejaItemCorreo> {
  const base = { facturaId, motivo: null, guia: null, envioId: null, destinatarios: 0 };
  const previa = ultimas.get(facturaId);

  // AC3 aplicado al correo, y **antes de la red**: un cliente sin dirección en su ficha nunca llegó a
  // Siigo, así que no hay cuota que gastar ni nada que reintentar — lo que hay es un dato que falta.
  // Es la misma distinción que `SIIGO_ENVIO_RESULTADOS` hace entre `fallido` y `no_realizado`.
  // Mismo predicado que la emisión, y aquí importa especialmente: el reenvío no lo reintenta nadie
  // solo —no hay cron que lo haga—, así que `reintentable` es `false` para TODOS los códigos de
  // correo y usarlo habría descartado hasta los fallos pasajeros de Siigo.
  const guia = guiaDelCaso(previa?.codigo);
  if (previa && !guia.sirveReintentar) {
    return { ...base, resultado: 'descartado_datos', motivo: guia.texto, guia, envioId: previa.id };
  }

  try {
    const acta = await enviarFacturaPorCorreo(facturaId, { solicitadoPor: e.usuarioId });
    return {
      ...base,
      resultado: acta.resultado,
      envioId: acta.id,
      // Cuántas direcciones, nunca cuáles: el acta es el único registro autorizado para guardarlas
      // —y el único que se puede purgar por un derecho de supresión—, así que duplicarlas aquí
      // abriría una copia que ninguna purga alcanza.
      destinatarios: acta.destinatarios.length,
      motivo: acta.motivo,
      guia: acta.resultado === 'enviado' ? null : guiaDelCaso(acta.codigo),
    };
  } catch (err) {
    if (err instanceof SiigoEnvioError) {
      // No es un fallo del sistema: la petición no tenía sentido (la factura no existe, no está
      // emitida, o el ambiente no manda correos). Sale como caso de la fila, no como 500 del lote.
      const g = guiaDelCaso(err.codigo);
      return { ...base, resultado: 'no_realizado', motivo: err.message, guia: g };
    }
    return {
      ...base,
      resultado: 'error',
      motivo: sanearMensaje(err instanceof Error ? err.message : 'Fallo al reenviar el correo.'),
    };
  }
}

/** La última acta de cada factura. Es la que dice si hay algo que reintentar y con qué código. */
async function ultimasActas(
  facturaIds: string[],
): Promise<Map<string, { id: string; codigo: string | null }>> {
  const filas = await db.select({
    id: siigoFacturaEnvios.id,
    facturaId: siigoFacturaEnvios.facturaId,
    codigo: siigoFacturaEnvios.codigo,
    resultado: siigoFacturaEnvios.resultado,
  }).from(siigoFacturaEnvios)
    .where(inArray(siigoFacturaEnvios.facturaId, facturaIds))
    .orderBy(desc(siigoFacturaEnvios.createdAt), desc(siigoFacturaEnvios.id))
    .limit(SIIGO_BANDEJA_TOPE_REENVIO * 20);

  const salida = new Map<string, { id: string; codigo: string | null }>();
  for (const f of filas) {
    const clave = String(f.facturaId);
    if (salida.has(clave)) continue;
    salida.set(clave, { id: String(f.id), codigo: f.codigo ?? null });
  }
  return salida;
}

// ── AC5 — darlo por perdido ─────────────────────────────────────────────────

export interface EntradaDescarte {
  ambiente: SiigoAmbiente;
  fuente: SiigoBandejaFuente;
  refId: string;
  /** Del catálogo CERRADO. La ruta lo valida con Zod contra el mismo catálogo; aquí llega ya tipado. */
  motivo: SiigoBandejaMotivoDescarte;
  /** Aclaración opcional, corta y saneada. Ver `SIIGO_BANDEJA_NOTA_MAX`. */
  nota?: string | null;
  usuarioId: number | null;
  ahora?: Date;
}

/**
 * AC5 — Da un caso por perdido: exige motivo, deja de reintentarse y registra quién y cuándo.
 *
 * Las tres partes viven donde ya tenían sede y **no hay columna nueva para ninguna**:
 *
 *   · «deja de reintentarse» → `siigo_cola_facturacion.estado = 'fallido_definitivo'`. El índice
 *     parcial `idx_siigo_cola_lista` excluye ese estado, así que `tomarLote` no la vuelve a mirar
 *     nunca: no es que se salte una comprobación, es que la fila deja de existir para la consulta.
 *   · «motivo, quién y cuándo» → `siigo_operaciones`, WORM por disparador desde la `0126`.
 *   · «se conserva el marcado anterior» (AC6) → por construcción: esa tabla prohíbe UPDATE y DELETE.
 *
 * **El hito se escribe también cuando la fila ya era terminal**, y ese caso no es raro: es el normal.
 * El trabajador deja `fallido_definitivo` al agotar su techo, sin motivo ni autor, y justamente esos
 * son los casos que llevan más tiempo parados y a los que hay que ponerles una decisión.
 */
export async function descartarCaso(e: EntradaDescarte): Promise<SiigoBandejaRespuestaDescarte> {
  if (e.fuente === 'dian') {
    // Frontera del diseño: un documento rechazado por la DIAN EXISTE ante la autoridad y existirá
    // siempre. «Darlo por perdido» sugeriría que desaparece. Lo que procede es corregirlo en Siigo
    // Nube y registrar la corrección, que es lo que lo saca de la bandeja.
    throw new SiigoBandejaError(
      'fuente_no_admite',
      'Un rechazo de la DIAN no se da por perdido: se corrige. Registra la corrección en FLITO y el '
      + 'caso sale solo de la bandeja.',
    );
  }
  return e.fuente === 'correo' ? descartarCorreo(e) : descartarEmision(e);
}

async function descartarEmision(e: EntradaDescarte): Promise<SiigoBandejaRespuestaDescarte> {
  const ahora = e.ahora ?? new Date();
  const [factura] = await db.select({
    id: siigoFacturas.id, loteId: siigoFacturas.loteId, ambiente: siigoFacturas.ambiente,
  }).from(siigoFacturas).where(eq(siigoFacturas.id, e.refId)).limit(1);

  if (!factura || String(factura.ambiente) !== e.ambiente) {
    throw new SiigoBandejaError('no_existe', 'La factura no existe en este ambiente.');
  }

  const colaId = await asegurarFilaDeCola(String(factura.loteId), e, ahora);
  const r = await descartarDefinitivo({ colaId, usuarioId: e.usuarioId, ahora });

  if (r.estado === 'no_existe') {
    throw new SiigoBandejaError('no_existe', 'La fila de cola desapareció mientras se marcaba.');
  }
  if (r.estado === 'emitida') {
    throw new SiigoBandejaError(
      'ya_emitida',
      'Esta factura ya se emitió: existe un documento ante la DIAN y no se puede dar por perdida.',
    );
  }
  if (r.estado === 'en_proceso') {
    // NO se pisa. El desenlace de esa emisión llegaría después, encima de una fila que alguien acaba
    // de dar por perdida — y con el arrendamiento puesto el `CHECK` de la tabla ni lo permitiría.
    throw new SiigoBandejaError(
      'en_proceso',
      'Se está procesando ahora mismo. Inténtalo en un minuto: hasta que el intento termine no se '
      + 'sabe si hace falta darla por perdida.',
    );
  }

  const descarte = await anotarDescarte(e, 'siigo_cola', colaId, String(factura.id), ahora);
  return {
    fuente: 'emision',
    refId: e.refId,
    facturaId: String(factura.id),
    colaId,
    estado: r.fila.estado,
    descarte,
  };
}

async function descartarCorreo(e: EntradaDescarte): Promise<SiigoBandejaRespuestaDescarte> {
  const ahora = e.ahora ?? new Date();
  const [acta] = await db.select({
    id: siigoFacturaEnvios.id, facturaId: siigoFacturaEnvios.facturaId,
    resultado: siigoFacturaEnvios.resultado,
  }).from(siigoFacturaEnvios).where(eq(siigoFacturaEnvios.id, e.refId)).limit(1);

  if (!acta) throw new SiigoBandejaError('no_existe', 'Ese envío no existe.');
  if (String(acta.resultado) === 'enviado') {
    throw new SiigoBandejaError(
      'fuente_no_admite', 'Ese envío sí salió: no hay nada que dar por perdido.',
    );
  }

  // **No se toca `siigo_factura_envios`**: es append-only con una sola puerta (el disparador de la
  // `0141` solo deja purgar destinatarios). Abandonar un envío es una decisión NUESTRA sobre el
  // acta, no un hecho nuevo del envío, y su sitio es la bitácora.
  const descarte = await anotarDescarte(
    e, 'factura_envio', String(acta.id), String(acta.facturaId), ahora,
  );
  return {
    fuente: 'correo',
    refId: e.refId,
    facturaId: String(acta.facturaId),
    colaId: null,
    estado: null,
    descarte,
  };
}

/**
 * Crea la fila de cola de una factura fallida que no la tenía (frontera 1 del diseño).
 *
 * Una factura emitida por la vía directa —o anterior a la cola— no tiene fila, y sin ella no hay
 * dónde escribir «deja de reintentarse». `asegurarLote` es un `ON CONFLICT` sobre
 * `(ambiente, estrategia, huella)` y devuelve **el mismo** `lote_id`, así que reencolar el contenido
 * exacto del lote no crea un segundo lote ni una segunda clave de idempotencia: crea la fila que
 * faltaba, o devuelve la que ya estaba.
 *
 * `reactivar: false`, y aquí sí importa: si la fila ya estaba `fallido_definitivo`, reactivarla para
 * marcarla acto seguido sería dejarla un instante elegible por el trabajador. La marca se escribe
 * sobre lo que hay.
 */
async function asegurarFilaDeCola(
  loteId: string, e: EntradaDescarte, ahora: Date,
): Promise<string> {
  const contenido = (await contenidoDeLotes([loteId])).get(loteId);
  const impedimento = queImpide(contenido);
  if (impedimento) throw new SiigoBandejaError('no_aplica', impedimento);

  try {
    const r = await encolar({
      tramiteIds: contenido!.tramiteIds,
      conceptos: contenido!.conceptos,
      emision: contenido!.emision,
      ambiente: e.ambiente,
      usuarioId: e.usuarioId,
      reactivar: false,
      ahora,
    });
    return r.colaId;
  } catch (err) {
    if (err instanceof SiigoColaError) throw new SiigoBandejaError('no_aplica', err.message);
    throw err;
  }
}

/**
 * Escribe el hecho en la bitácora WORM: motivo (código del catálogo), nota, quién y cuándo.
 *
 * El motivo va en `codigo` —columna corta y estable, que es lo que la pantalla indexa— y la nota en
 * `mensaje`. Separarlos no es cosmético: el motivo es un valor de catálogo que se puede agrupar y
 * traducir, y la nota es texto de una persona. Si viajaran juntos habría que parsear la frase para
 * saber cuál fue la decisión, que es justo lo que el catálogo cerrado evita.
 *
 * La nota pasa por `sanearMensaje` y se recorta al tope. Es la última barrera: lo que entra en esta
 * tabla no se puede rectificar ni suprimir (Ley 1581, art. 8), así que el filtro va ANTES del INSERT
 * y no depende de que quien llame se acuerde.
 */
async function anotarDescarte(
  e: EntradaDescarte,
  entidadTipo: 'siigo_cola' | 'factura_envio',
  entidadId: string,
  facturaId: string,
  ahora: Date,
): Promise<SiigoBandejaDescarte> {
  const nota = normalizarNota(e.nota);
  await registrarHito({
    hito: 'marcada_fallido_definitivo',
    facturaId,
    entidadTipo,
    entidadId,
    ambiente: e.ambiente,
    usuarioId: e.usuarioId,
    codigo: e.motivo,
    detalle: nota ?? undefined,
  });
  return {
    motivo: e.motivo,
    motivoEtiqueta: SIIGO_BANDEJA_MOTIVO_DESCARTE_ETIQUETA[e.motivo],
    nota,
    usuarioId: e.usuarioId,
    marcadoEn: ahora.toISOString(),
  };
}

export function normalizarNota(nota: string | null | undefined): string | null {
  if (typeof nota !== 'string') return null;
  const limpia = sanearMensaje(nota.trim()).slice(0, SIIGO_BANDEJA_NOTA_MAX).trim();
  return limpia === '' ? null : limpia;
}

// ── AC6 — resucitarlo ───────────────────────────────────────────────────────

export interface EntradaReactivacion {
  ambiente: SiigoAmbiente;
  fuente: SiigoBandejaFuente;
  refId: string;
  usuarioId: number | null;
  ahora?: Date;
}

/**
 * AC6 — Devuelve a la vida lo que se dio por perdido. **El marcado anterior se conserva.**
 *
 * No se conserva porque este código lo copie a ningún sitio: se conserva porque la bitácora prohíbe
 * UPDATE y DELETE por disparador. Resucitar añade un hecho encima; no borra el de abajo. Por eso la
 * respuesta devuelve `descarteAnterior`: quien acaba de pulsar tiene derecho a ver qué deshizo, y es
 * también la prueba de que sigue escrito.
 *
 * Exige que estuviera descartado. Reactivar algo que nadie dio por perdido sería un botón que no
 * hace nada y una fila de bitácora que afirma una decisión que no se tomó.
 */
export async function reactivarCaso(
  e: EntradaReactivacion,
): Promise<SiigoBandejaRespuestaReactivacion> {
  if (e.fuente === 'dian') {
    throw new SiigoBandejaError(
      'fuente_no_admite',
      'Un rechazo de la DIAN no se resucita: se corrige en Siigo Nube y se registra la corrección.',
    );
  }
  return e.fuente === 'correo' ? reactivarCorreo(e) : reactivarEmision(e);
}

async function reactivarEmision(
  e: EntradaReactivacion,
): Promise<SiigoBandejaRespuestaReactivacion> {
  const ahora = e.ahora ?? new Date();
  const [factura] = await db.select({
    id: siigoFacturas.id, loteId: siigoFacturas.loteId, ambiente: siigoFacturas.ambiente,
  }).from(siigoFacturas).where(eq(siigoFacturas.id, e.refId)).limit(1);

  if (!factura || String(factura.ambiente) !== e.ambiente) {
    throw new SiigoBandejaError('no_existe', 'La factura no existe en este ambiente.');
  }

  const colas = await colaPorLote([String(factura.loteId)]);
  const cola = colas.get(String(factura.loteId));
  const anterior = cola ? (await descartesVigentes('siigo_cola', [cola.id])).get(cola.id) : undefined;
  if (!anterior) {
    throw new SiigoBandejaError(
      'no_descartado',
      'Este caso no está dado por perdido: no hay nada que resucitar. Usa el reintento normal.',
    );
  }

  const contenido = (await contenidoDeLotes([String(factura.loteId)])).get(String(factura.loteId));
  const impedimento = queImpide(contenido);
  if (impedimento) throw new SiigoBandejaError('no_aplica', impedimento);

  // `reactivar: true` — es LA acción. `encolar` deja los contadores a cero y la cita para ya, y su
  // `anotar` escribe el `factura_encolar` que, al ser el último hito de la entidad, deshace la marca
  // de descarte sin tocar la fila que la registró.
  const r = await encolar({
    tramiteIds: contenido!.tramiteIds,
    conceptos: contenido!.conceptos,
    emision: contenido!.emision,
    ambiente: e.ambiente,
    usuarioId: e.usuarioId,
    reactivar: true,
    ahora,
  });

  return {
    fuente: 'emision',
    refId: e.refId,
    facturaId: String(factura.id),
    colaId: r.colaId,
    estado: r.estado,
    resultado: r.resultado as SiigoBandejaResultado,
    descarteAnterior: anterior,
  };
}

async function reactivarCorreo(
  e: EntradaReactivacion,
): Promise<SiigoBandejaRespuestaReactivacion> {
  const [acta] = await db.select({
    id: siigoFacturaEnvios.id, facturaId: siigoFacturaEnvios.facturaId,
  }).from(siigoFacturaEnvios).where(eq(siigoFacturaEnvios.id, e.refId)).limit(1);

  if (!acta) throw new SiigoBandejaError('no_existe', 'Ese envío no existe.');

  const anterior = (await descartesVigentes('factura_envio', [String(acta.id)])).get(String(acta.id));
  if (!anterior) {
    throw new SiigoBandejaError(
      'no_descartado', 'Ese envío no está dado por perdido: no hay nada que resucitar.',
    );
  }

  // `reenvio_solicitado` ya está en `HITOS_SIN_LLAMADA` y es el hito de activación de esta entidad:
  // al ser el último, el caso vuelve a la bandeja. No se manda el correo aquí — eso es
  // `/reenviar-correo`, que gasta cuota y tiene su propio tope.
  await registrarHito({
    hito: 'reenvio_solicitado',
    facturaId: String(acta.facturaId),
    entidadTipo: 'factura_envio',
    entidadId: String(acta.id),
    ambiente: e.ambiente,
    usuarioId: e.usuarioId,
    detalle: 'Vuelve a la bandeja de fallidos: se deshizo el abandono del envío.',
  });

  return {
    fuente: 'correo',
    refId: e.refId,
    facturaId: String(acta.facturaId),
    colaId: null,
    estado: null,
    resultado: 'reactivado',
    descarteAnterior: anterior,
  };
}
