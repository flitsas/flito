// Siigo — la cola de emisión: qué queda por facturar y cuándo le toca (HU #11327, Feature #11242).
//
// **Este archivo es el ÚNICO que escribe en `siigo_cola_facturacion`.** No es una preferencia de
// estilo: la fila de cola lleva un arrendamiento y dos contadores con techos distintos, y las tres
// cosas solo significan algo si se mueven juntas. Un `UPDATE` suelto desde otro módulo que tocara el
// estado sin soltar el arrendamiento dejaría una fila terminada y arrendada —cosa que un CHECK
// prohíbe—, y uno que tocara los contadores sin la cita dejaría una fila que no vuelve nunca.
//
// **Y este archivo NO escribe en `siigo_facturas`. Nunca.** Lee el `ResultadoEmision` que devuelve
// `emitirFactura` y guarda lo que dice. La razón es que el estado del documento tiene un dueño
// —`facturacion.emision.service.ts` y, cuando aquel se queda a medias, la reconciliación— y un
// segundo escritor sobre una fila que representa un documento ante la DIAN es exactamente la clase de
// cosa que produce una factura marcada como fallida estando viva. Hay una prueba que lo comprueba.
//
// DÓNDE ESTÁ LA EXCLUSIÓN (AC6)
//
// En `tomarLote`, y **en la base de datos, no en una variable**. Ver el comentario largo de esa
// función: la sentencia selecciona y marca a la vez, así que no existe el instante entre «la vi» y
// «la marqué» por el que se cuelan dos trabajadores.

import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  ConceptoFacturable,
  SiigoColaDesenlace, SiigoColaEstado, SiigoColaItem, SiigoColaResultadoEncolado,
} from '@operaciones/shared-types';
import { SIIGO_COLA_ARRENDAMIENTO_MIN } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { siigoColaFacturacion } from '../../db/schema.js';
import { asegurarLote, lotesDeTramites } from './facturacion.lote.repo.js';
import { huellaDeLote, type EmisionElegida } from './facturacion.armado.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { sanearMensaje } from './siigo.redaccion.js';
import { OPERACION_ENCOLAR } from './siigo.freno.service.js';
import { modoSiigo } from './siigo.mock.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** Fallo de uso de la cola. La ruta de la HU #11328 lo traducirá a HTTP. */
export class SiigoColaError extends Error {
  readonly codigo: 'sin_tramites' | 'sin_conceptos' | 'lote' | 'no_existe';

  constructor(codigo: SiigoColaError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoColaError';
    this.codigo = codigo;
  }
}

const COLUMNAS = {
  id: siigoColaFacturacion.id,
  loteId: siigoColaFacturacion.loteId,
  ambiente: siigoColaFacturacion.ambiente,
  estado: siigoColaFacturacion.estado,
  intentos: siigoColaFacturacion.intentos,
  maxIntentos: siigoColaFacturacion.maxIntentos,
  esperas: siigoColaFacturacion.esperas,
  maxEsperas: siigoColaFacturacion.maxEsperas,
  proximoIntentoAt: siigoColaFacturacion.proximoIntentoAt,
  ultimoIntentoAt: siigoColaFacturacion.ultimoIntentoAt,
  facturaId: siigoColaFacturacion.facturaId,
  desenlace: siigoColaFacturacion.desenlace,
  errorCode: siigoColaFacturacion.errorCode,
  errorDetalle: siigoColaFacturacion.errorDetalle,
  createdAt: siigoColaFacturacion.createdAt,
  updatedAt: siigoColaFacturacion.updatedAt,
};

function fecha(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function aItem(f: Record<string, unknown>): SiigoColaItem {
  return {
    id: String(f.id),
    loteId: String(f.loteId),
    ambiente: String(f.ambiente),
    estado: String(f.estado) as SiigoColaEstado,
    intentos: Number(f.intentos) || 0,
    maxIntentos: Number(f.maxIntentos) || 0,
    esperas: Number(f.esperas) || 0,
    maxEsperas: Number(f.maxEsperas) || 0,
    // La cita nunca es nula en la base (NOT NULL). Si aquí llegara algo ilegible se publica el
    // instante de lectura y no una cadena vacía: una fila sin cita legible es una anomalía que hay
    // que ver, no un hueco que se rellena en silencio.
    proximoIntentoAt: (fecha(f.proximoIntentoAt) ?? new Date()).toISOString(),
    ultimoIntentoAt: fecha(f.ultimoIntentoAt)?.toISOString() ?? null,
    facturaId: (f.facturaId as string | null) ?? null,
    desenlace: (f.desenlace as SiigoColaDesenlace | null) ?? null,
    errorCode: (f.errorCode as string | null) ?? null,
    errorDetalle: (f.errorDetalle as string | null) ?? null,
    createdAt: (fecha(f.createdAt) ?? new Date()).toISOString(),
    updatedAt: (fecha(f.updatedAt) ?? new Date()).toISOString(),
  };
}

// ── Encolar ─────────────────────────────────────────────────────────────────

export interface EntradaEncolado {
  tramiteIds: string[];
  /**
   * Los conceptos que se van a facturar (A1). No opcional a propósito: con un valor por omisión,
   * un llamador que se olvidara de pasarlos facturaría algo distinto de lo que se pidió, y el
   * síntoma sería una factura ante la DIAN, no un error de compilación.
   */
  conceptos: readonly ConceptoFacturable[];
  /** La emisión elegida para la empresa de estos trámites (A2). Ausente = configuración global. */
  emision?: EmisionElegida | null;
  ambiente: SiigoAmbiente;
  usuarioId: number | null;
  /**
   * Volver a poner en cola algo dado por perdido.
   *
   * Apagado por omisión, y con motivo: `fallido_definitivo` significa «esto no se arregla
   * reintentando» (AC2, AC5). Si el encolado normal lo reactivara, una pantalla que reencola al
   * refrescar volvería a poner en cola justo lo que ya se descartó, y el techo de intentos dejaría
   * de significar nada. Reactivar es una decisión de quien opera, no un efecto secundario.
   */
  reactivar?: boolean;
  ahora?: Date;
}

export interface ResultadoEncolado {
  colaId: string;
  loteId: string;
  estado: SiigoColaEstado;
  resultado: SiigoColaResultadoEncolado;
}

/**
 * AC1 — Pone un lote en la cola y VUELVE. No llama a Siigo ni una sola vez.
 *
 * Todo lo que hace es determinar el lote —que es un `INSERT ... ON CONFLICT` sobre una identidad
 * derivada del contenido— y crear su fila de cola. La emisión la hace después el trabajador. Que
 * aquí no haya ni una petición es lo que permite que quien pide facturar reciba respuesta en
 * milisegundos aunque Siigo esté lento, caído o frenado.
 *
 * Es idempotente por el índice único sobre `lote_id`, no por una comprobación previa: entre un
 * SELECT y un INSERT cabe otra petición, y el resultado de esa carrera serían dos filas de cola
 * pidiendo el mismo trabajo.
 */
export async function encolar(entrada: EntradaEncolado): Promise<ResultadoEncolado> {
  const ids = [...new Set(entrada.tramiteIds)].filter(Boolean).sort();
  if (ids.length === 0) {
    throw new SiigoColaError('sin_tramites', 'No se indicó ningún trámite que encolar.');
  }
  const conceptos = [...new Set(entrada.conceptos)].sort();
  if (conceptos.length === 0) {
    throw new SiigoColaError(
      'sin_conceptos',
      'No se indicó ningún concepto que facturar. Una factura sin líneas no es una factura.',
    );
  }
  const ahora = entrada.ahora ?? new Date();
  const { ambiente, usuarioId = null } = entrada;

  const loteId = await asegurarLote({
    ambiente,
    // C3 — la huella cubre trámites Y conceptos. Con solo los trámites, dos envíos del mismo
    // conjunto con selecciones distintas compartían identidad y el segundo no emitía nada.
    huella: huellaDeLote(ids, conceptos, entrada.emision),
    tramiteIds: ids,
    conceptos,
    emision: entrada.emision,
    creadoPor: usuarioId,
  });
  if (!loteId) {
    throw new SiigoColaError(
      'lote', 'El lote de facturación desapareció mientras se creaba. No se encoló nada.',
    );
  }

  const [creada] = await db.insert(siigoColaFacturacion)
    .values({
      loteId,
      ambiente,
      estado: 'pendiente',
      // La cita es AHORA: lo recién pedido sale en el próximo ciclo, no cuando toque a un reintento.
      proximoIntentoAt: ahora,
      encoladoPor: usuarioId,
      createdAt: ahora,
      updatedAt: ahora,
    })
    .onConflictDoNothing({ target: siigoColaFacturacion.loteId })
    .returning(COLUMNAS);

  if (creada) {
    const item = aItem(creada as Record<string, unknown>);
    await anotar(item, 'encolado', usuarioId);
    return { colaId: item.id, loteId, estado: item.estado, resultado: 'encolado' };
  }

  return resolverConflicto({ loteId, ahora, usuarioId, reactivar: entrada.reactivar === true });
}

async function resolverConflicto(ctx: {
  loteId: string; ahora: Date; usuarioId: number | null; reactivar: boolean;
}): Promise<ResultadoEncolado> {
  const existente = await filaDeLote(ctx.loteId);
  if (!existente) {
    // El índice dice que hay una fila para ese lote y la lectura no la encuentra: o la borraron en
    // este instante —no hay DELETE concedido, así que sería a mano— o hay algo roto. No se inventa
    // una segunda fila: eso sí produciría dos trabajos para el mismo lote.
    throw new SiigoColaError(
      'lote', 'La cola tiene ocupado ese lote con una fila que no se pudo leer. No se encoló nada.',
    );
  }
  const salida = (resultado: SiigoColaResultadoEncolado): ResultadoEncolado => ({
    colaId: existente.id, loteId: ctx.loteId, estado: existente.estado, resultado,
  });

  // Ya se envió: el documento existe. Reencolarlo no produciría una segunda factura —la clave de
  // idempotencia lo impide— pero sí una petición inútil, y sobre todo una respuesta que haría creer
  // que hay algo en marcha cuando lo que hay es una factura hecha.
  if (existente.estado === 'enviado') return salida('ya_enviado');
  if (existente.estado === 'pendiente' || existente.estado === 'error') return salida('ya_en_cola');
  if (!ctx.reactivar) return salida('fallido_definitivo');

  const reactivada = await reactivarFila(existente.id, ctx.ahora);
  if (!reactivada) {
    // Otro la reactivó entre la lectura y el UPDATE. La condición de estado viaja DENTRO del UPDATE
    // justo para esto: quien no recibe fila no ha reactivado nada y no debe decir que sí.
    const tras = await filaDeLote(ctx.loteId);
    return { colaId: existente.id, loteId: ctx.loteId, estado: tras?.estado ?? existente.estado, resultado: 'ya_en_cola' };
  }
  await anotar(reactivada, 'reactivado', ctx.usuarioId);
  return { colaId: reactivada.id, loteId: ctx.loteId, estado: reactivada.estado, resultado: 'reactivado' };
}

/**
 * Devuelve una fila dada por perdida a la cola, con los contadores a cero.
 *
 * La condición de estado va DENTRO del `UPDATE`, no en un `SELECT` previo: dos reactivaciones
 * simultáneas leerían las dos `fallido_definitivo` y las dos creerían haberla reactivado, con lo que
 * la segunda pisaría los contadores de un trabajo que ya podía estar en curso.
 */
async function reactivarFila(colaId: string, ahora: Date): Promise<SiigoColaItem | null> {
  const [fila] = await db.update(siigoColaFacturacion)
    .set({
      estado: 'pendiente',
      intentos: 0,
      esperas: 0,
      proximoIntentoAt: ahora,
      // El error anterior se borra: describía por qué se dio por perdida, y dejarlo haría creer que
      // el intento nuevo ya falló por lo mismo antes de haber empezado.
      errorCode: null,
      errorDetalle: null,
      desenlace: null,
      // Y la factura también. La columna dice «la factura que produjo el trabajo», y la del intento
      // anterior no la produjo este: dejarla haría que una fila recién puesta en cola afirmara un
      // documento que todavía no tiene. Si el trabajo vuelve a la misma factura —lo normal, porque
      // la clave es la misma—, el desenlace la escribirá otra vez.
      facturaId: null,
      updatedAt: ahora,
    })
    .where(and(
      eq(siigoColaFacturacion.id, colaId),
      eq(siigoColaFacturacion.estado, 'fallido_definitivo'),
    ))
    .returning(COLUMNAS);
  return fila ? aItem(fila as Record<string, unknown>) : null;
}

export type ResultadoDescarte =
  /** Estaba viva y ahora es terminal. Es el camino normal. */
  | { estado: 'marcada'; fila: SiigoColaItem }
  /**
   * Ya era `fallido_definitivo` **antes de que nadie la marcara**: el trabajador agotó su techo.
   *
   * NO es un error, y distinguirlo importa: el estado ya cumple el «deja de reintentarse» del AC5,
   * pero falta lo que el AC5 pide de verdad —motivo, quién y cuándo—, y eso se escribe en la
   * bitácora igual. Colapsarlo con «no se pudo» dejaría sin justificar precisamente los casos que
   * llevan más tiempo parados.
   */
  | { estado: 'ya_terminal'; fila: SiigoColaItem }
  /** Se emitió: hay un documento ante la DIAN y darlo por perdido sería mentir sobre él. */
  | { estado: 'emitida'; fila: SiigoColaItem }
  /** Un trabajador la tiene arrendada AHORA MISMO. No se pisa: se pide reintentar en un minuto. */
  | { estado: 'en_proceso'; fila: SiigoColaItem }
  | { estado: 'no_existe' };

/**
 * AC5 de la HU #11340 — Da una fila por perdida a mano.
 *
 * **Está aquí, y no en el servicio de la bandeja, porque este archivo es el único que escribe en
 * `siigo_cola_facturacion`** —hay una prueba que lo vigila—. Un `UPDATE` suelto desde otro módulo que
 * tocara el estado sin mirar el arrendamiento dejaría una fila terminada y arrendada, cosa que el
 * `CHECK siigo_cola_arrendamiento_estado_chk` prohíbe: el 500 saldría del motor, con la sentencia y
 * sus parámetros dentro, y por un camino que nadie prueba.
 *
 * **Las DOS condiciones del `WHERE` son la corrección, no una de ellas.**
 *
 *   · `estado IN ('pendiente', 'error')` — lo `enviado` ya produjo un documento y darlo por perdido
 *     sería mentir sobre una factura que existe ante la DIAN; lo que ya es `fallido_definitivo` no
 *     necesita marcarse otra vez, y marcarlo escribiría un segundo motivo encima del primero.
 *   · `tomado_por IS NULL` — sin esto se pisa una fila que un trabajador está emitiendo AHORA MISMO:
 *     el `UPDATE` la dejaría en un estado terminal con el arrendamiento puesto (el CHECK revienta) y,
 *     peor, el desenlace de esa emisión llegaría después sobre una fila que alguien dio por perdida.
 *
 * Cero filas NO es un error del sistema: tiene cuatro causas y solo dos son un problema, así que se
 * devuelve CUÁL fue en vez de un `null` que quien llama tendría que reinterpretar.
 *
 * **No toca `error_code` ni `error_detalle`, y es deliberado.** Esas columnas dicen POR QUÉ falló, y
 * es lo que la bandeja pinta y lo que decide si reintentar sirve de algo (AC3). El motivo del
 * descarte es otra cosa —una decisión de una persona— y su sitio es `siigo_operaciones`, que además
 * es WORM: escribirlo encima del código de error perdería el diagnóstico y guardaría la decisión en
 * una fila que sí se puede sobrescribir. Justo al revés de lo que hace falta.
 */
export async function descartarDefinitivo(args: {
  colaId: string; usuarioId: number | null; ahora?: Date;
}): Promise<ResultadoDescarte> {
  const ahora = args.ahora ?? new Date();
  const [fila] = await db.update(siigoColaFacturacion)
    .set({
      estado: 'fallido_definitivo',
      // Redundante con el `WHERE` y a propósito: si algún día alguien relaja la condición del
      // arrendamiento, esto evita que la fila quede terminada Y arrendada.
      tomadoPor: null,
      tomadoEn: null,
      updatedAt: ahora,
    })
    .where(and(
      eq(siigoColaFacturacion.id, args.colaId),
      sql`${siigoColaFacturacion.estado} IN ('pendiente', 'error')`,
      sql`${siigoColaFacturacion.tomadoPor} IS NULL`,
    ))
    .returning(COLUMNAS);
  if (fila) return { estado: 'marcada', fila: aItem(fila as Record<string, unknown>) };

  // La lectura va DESPUÉS del `UPDATE`, nunca antes: leer primero y decidir después es la carrera
  // que este archivo entero evita. Aquí ya no hay decisión que pueda correr —la escritura fracasó—
  // y esto solo sirve para explicar por qué.
  const actual = await filaDeCola(args.colaId);
  if (!actual) return { estado: 'no_existe' };
  if (actual.estado === 'enviado') return { estado: 'emitida', fila: actual };
  if (actual.estado === 'fallido_definitivo') return { estado: 'ya_terminal', fila: actual };
  return { estado: 'en_proceso', fila: actual };
}

/**
 * Crea la fila de cola de un lote que no la tenía, **naciendo ya dada por perdida**.
 *
 * Existe para una sola cosa: dar dónde escribir «deja de reintentarse» a una factura fallida que
 * nunca pasó por la cola —emisión directa, o anterior a que la cola existiera—. No encola nada, y
 * por eso no llama a `encolar` ni pasa por `asegurarLote`: el `lote_id` ya lo trae la factura.
 *
 * **Nace `fallido_definitivo` y esa es toda la corrección.** Antes esta fila se creaba llamando a
 * `encolar`, que la insertaba `pendiente` con la cita puesta para AHORA, y solo después —en otra
 * sentencia, sin transacción que las uniera— se la marcaba. En ese hueco la fila cumplía las tres
 * condiciones de `tomarLote` (`estado IN ('pendiente','error')`, `proximo_intento_at <= now`,
 * sin arrendamiento), así que era elegible de inmediato y no en el ciclo siguiente. Dos desenlaces:
 * si el cron entraba en la ventana, quien pidió darla por perdida recibía un 409 mientras el
 * documento se emitía ante la DIAN; y si el proceso moría entre las dos sentencias —un deploy, un
 * OOM, un corte—, la fila se quedaba `pendiente` **para siempre** y el cron la tomaba con certeza en
 * los dos minutos siguientes. Lo segundo no es una carrera: es determinista y silencioso.
 *
 * Las alternativas eran envolver los dos pasos en una transacción —lo que obliga a enhebrar el `tx`
 * por `encolar`, `asegurarLote`, `descartarDefinitivo` y `registrarOperacion`— o citarla en un
 * futuro inalcanzable, que deja una fila `pendiente` mintiendo en la bandeja y que cualquier
 * reactivación devuelve al presente. Nacer terminal no necesita ninguna de las dos: **el estado
 * inelegible es la primera cosa que la fila es**, y entre el INSERT y cualquier otra sentencia no
 * hay ningún instante en el que un trabajador pueda verla.
 *
 * No deja rastro de «encolado» en la bitácora, y también es a propósito: aquí no se encoló nada. El
 * hecho que hay que registrar es el descarte, y lo escribe quien llama en `siigo_operaciones` con el
 * motivo, el autor y la hora.
 */
export async function asegurarFilaDadaPorPerdida(args: {
  loteId: string; ambiente: SiigoAmbiente; usuarioId: number | null; ahora?: Date;
}): Promise<{ colaId: string; estado: SiigoColaEstado; creada: boolean }> {
  const ahora = args.ahora ?? new Date();

  const [creada] = await db.insert(siigoColaFacturacion)
    .values({
      loteId: args.loteId,
      ambiente: args.ambiente,
      // La línea que cierra la ventana. No es un valor inicial cualquiera: es la garantía.
      estado: 'fallido_definitivo',
      // Irrelevante mientras el estado sea terminal —`tomarLote` filtra por estado antes que por la
      // cita—, pero la columna no admite nulo y una fecha inventada confundiría a quien la lea.
      proximoIntentoAt: ahora,
      encoladoPor: args.usuarioId,
      createdAt: ahora,
      updatedAt: ahora,
    })
    // La fila normal ya existe y NO se toca: marcarla es trabajo de `descartarDefinitivo`, cuya
    // condición de estado y de arrendamiento viaja dentro del `UPDATE`.
    .onConflictDoNothing({ target: siigoColaFacturacion.loteId })
    .returning(COLUMNAS);

  if (creada) {
    const item = aItem(creada as Record<string, unknown>);
    return { colaId: item.id, estado: item.estado, creada: true };
  }

  const existente = await filaDeLote(args.loteId);
  if (!existente) {
    throw new SiigoColaError(
      'lote', 'La cola tiene ocupado ese lote con una fila que no se pudo leer. No se marcó nada.',
    );
  }
  return { colaId: existente.id, estado: existente.estado, creada: false };
}

/** Una fila de la cola por su id. Solo lectura; la escritura sigue viviendo en este archivo. */
export async function filaDeCola(colaId: string): Promise<SiigoColaItem | null> {
  const [f] = await db.select(COLUMNAS).from(siigoColaFacturacion)
    .where(eq(siigoColaFacturacion.id, colaId))
    .limit(1);
  return f ? aItem(f as Record<string, unknown>) : null;
}

/**
 * Deja rastro del encolado en la bitácora.
 *
 * Se registra solo cuando la cola CAMBIÓ —alta o reactivación—, no en cada llamada: un encolado que
 * no cambia nada es una respuesta idempotente, y escribir una fila por cada refresco de pantalla
 * llenaría de ruido la tabla desde la que se diagnostican las emisiones.
 *
 * La operación está en `OPERACIONES_INTERNAS` del freno, así que no entra en la proporción de
 * errores: no salió a la red y contarla debilitaría el freno inflando su denominador.
 */
async function anotar(
  item: SiigoColaItem, resultado: SiigoColaResultadoEncolado, usuarioId: number | null,
): Promise<void> {
  await registrarOperacion({
    operacion: OPERACION_ENCOLAR,
    entidadTipo: 'siigo_cola',
    entidadId: item.id,
    ambiente: item.ambiente,
    modo: modoSiigo(),
    resultado: 'ok',
    codigo: resultado,
    mensaje: `Lote ${item.loteId} ${resultado === 'encolado' ? 'encolado' : 'reactivado'} para emisión.`,
    createdBy: usuarioId,
  });
}

async function filaDeLote(loteId: string): Promise<SiigoColaItem | null> {
  const [f] = await db.select(COLUMNAS).from(siigoColaFacturacion)
    .where(eq(siigoColaFacturacion.loteId, loteId))
    .limit(1);
  return f ? aItem(f as Record<string, unknown>) : null;
}

// ── Tomar trabajo ───────────────────────────────────────────────────────────

/** Lo mínimo para decidir qué hacer con una fila. El resto lo sabe el lote. */
export interface FilaTomada {
  id: string;
  loteId: string;
  intentos: number;
  esperas: number;
  maxIntentos: number;
  maxEsperas: number;
}

export interface EntradaToma {
  ambiente: SiigoAmbiente;
  limite: number;
  /** Quién la toma. Host y pid, para que un diagnóstico diga qué instancia la tiene. */
  tomadoPor: string;
  ahora: Date;
  arrendamientoMin?: number;
}

/**
 * AC6 — Toma hasta `limite` filas y las marca como suyas. **UNA sola sentencia.**
 *
 * Aquí está la garantía de la historia y conviene explicar por qué no vale la versión de dos pasos.
 * El patrón que se copia habitualmente —`SELECT … FOR UPDATE SKIP LOCKED` con `db.execute`, y
 * después un `UPDATE` con los ids obtenidos— **no excluye nada** cuando el SELECT va fuera de una
 * transacción: los candados de fila viven lo que vive la transacción, y una sentencia suelta es su
 * propia transacción, así que se sueltan en cuanto el SELECT termina. Entre ese instante y el UPDATE
 * cabe entero el SELECT de la otra instancia, que ve las mismas filas sin bloquear y se las lleva
 * también. (Existe así en `rndc/retry.cron.ts`, donde la exclusión real la da el `withLock` de
 * alrededor, no el `SKIP LOCKED`; aquí el cerrojo del cron protege el CICLO, no la fila.)
 *
 * Con la CTE, el candado se toma dentro de la misma sentencia que hace el `UPDATE`, y no se suelta
 * hasta que esa sentencia confirma —y para entonces el arrendamiento ya está escrito—. No existe el
 * instante entre «la vi» y «la marqué». Un segundo trabajador que llegue mientras tanto salta esas
 * filas por el `SKIP LOCKED` y se lleva las siguientes, que es justo lo que se quiere: dos
 * instancias trabajando, ninguna repitiendo.
 *
 * El orden —cita, y luego antigüedad— es lo que impide que una fila con muchos reintentos se quede
 * atrás para siempre: cuando su cita vence, compite con el resto en igualdad.
 */
export async function tomarLote(entrada: EntradaToma): Promise<FilaTomada[]> {
  if (entrada.limite <= 0) return [];
  const minutos = entrada.arrendamientoMin ?? SIIGO_COLA_ARRENDAMIENTO_MIN;
  const corte = new Date(entrada.ahora.getTime() - minutos * 60_000);

  // Las fechas viajan como TEXTO ISO con su cast explícito, nunca como `Date`.
  //
  // No es cosmética: `db.execute` acaba en `client.unsafe(query, params)` de postgres.js, que —a
  // diferencia de su plantilla etiquetada— NO aplica los serializadores por tipo y le pasa el
  // parámetro tal cual al codificador. Un `Date` ahí revienta con «The "string" argument must be of
  // type string […]. Received an instance of Date», y revienta SIEMPRE: esta consulta no podía tomar
  // ni una sola fila contra una base real.
  //
  // No lo detectó ninguna prueba porque todas corren contra la base mockeada, que acepta cualquier
  // parámetro. Es el patrón que ya usa `jornadas/autoclose.cron.ts` por el mismo motivo.
  const resultado = await db.execute(sql`
    WITH candidatas AS (
      SELECT id FROM siigo_cola_facturacion
       WHERE ambiente = ${entrada.ambiente}
         AND estado IN ('pendiente', 'error')
         AND proximo_intento_at <= ${entrada.ahora.toISOString()}::timestamptz
         AND (tomado_en IS NULL OR tomado_en < ${corte.toISOString()}::timestamptz)
       ORDER BY proximo_intento_at, created_at
       LIMIT ${entrada.limite}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE siigo_cola_facturacion c
       SET tomado_por = ${entrada.tomadoPor},
           tomado_en = ${entrada.ahora.toISOString()}::timestamptz,
           updated_at = ${entrada.ahora.toISOString()}::timestamptz
      FROM candidatas k
     WHERE c.id = k.id
    RETURNING c.id, c.lote_id, c.intentos, c.esperas, c.max_intentos, c.max_esperas
  `);

  return filasDe(resultado).map((f) => ({
    id: String(f.id),
    loteId: String(f.lote_id),
    intentos: Number(f.intentos) || 0,
    esperas: Number(f.esperas) || 0,
    maxIntentos: Number(f.max_intentos) || 0,
    maxEsperas: Number(f.max_esperas) || 0,
  }));
}

/**
 * Las filas de un `execute`, venga como venga el driver.
 *
 * `postgres-js` devuelve un array; otros devuelven `{ rows }`. Un cambio de driver que rompiera esto
 * en silencio dejaría al trabajador creyendo que la cola está vacía, que es la avería más difícil de
 * ver: no hay error, simplemente deja de facturarse.
 */
function filasDe(r: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
  const rows = (r as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

// ── Cerrar el trabajo ───────────────────────────────────────────────────────

interface DesenlaceComun {
  colaId: string;
  /** El arrendamiento propio. Si la fila ya es de otro, no se escribe nada. */
  tomadoPor: string;
  desenlace: SiigoColaDesenlace;
  intentos: number;
  esperas: number;
  errorCode?: string | null;
  errorDetalle?: string | null;
  ahora: Date;
}

/**
 * Qué hacer con la fila, ya decidido por el trabajador.
 *
 * Es una unión discriminada y no un objeto con todo opcional **porque refleja los CHECK de la
 * tabla**: `enviado` exige factura y `error` exige cita. Con campos opcionales, olvidarse de uno
 * daría un error de restricción en tiempo de ejecución dentro de un ciclo de fondo, que es donde
 * menos se ve; así no compila.
 */
export type InstruccionDesenlace = DesenlaceComun & (
  | { estado: 'enviado'; facturaId: string }
  | { estado: 'error'; proximoIntentoAt: Date; facturaId?: string | null }
  | { estado: 'fallido_definitivo'; facturaId?: string | null }
);

/**
 * Escribe el desenlace y SUELTA el arrendamiento. Devuelve `false` si la fila ya no era nuestra.
 *
 * La condición sobre `tomado_por` no es decorativa. Un ciclo puede tardar más que el arrendamiento
 * —`emitirFactura` reintenta hasta cuatro veces con esperas, y el limitador puede dormir— y para
 * entonces otra instancia ha podido tomar la fila legítimamente. Sin la condición, el trabajador
 * lento escribiría el desenlace de SU intento sobre el trabajo del otro: en el peor caso, un
 * `fallido_definitivo` de hace veinte minutos encima de una fila que acaba de emitir.
 *
 * El arrendamiento se suelta siempre y en el mismo `UPDATE`. Dejarlo puesto haría que un
 * `fallido_definitivo` incumpliera el CHECK que prohíbe un trabajo terminado y arrendado, y que una
 * fila devuelta a `error` esperase además a que venciera el arrendamiento para volver a ser
 * elegible: dos relojes para la misma espera.
 */
export async function registrarDesenlace(i: InstruccionDesenlace): Promise<boolean> {
  const filas = await db.update(siigoColaFacturacion)
    .set({
      estado: i.estado,
      intentos: i.intentos,
      esperas: i.esperas,
      // Sin cita explícita se conserva la que hubiera: los estados terminales no la usan, y
      // moverla a `ahora` haría que un `fallido_definitivo` pareciera tener trabajo pendiente.
      ...(i.estado === 'error' ? { proximoIntentoAt: i.proximoIntentoAt } : {}),
      ultimoIntentoAt: i.ahora,
      tomadoPor: null,
      tomadoEn: null,
      facturaId: i.facturaId ?? null,
      desenlace: i.desenlace,
      errorCode: i.errorCode ? i.errorCode.slice(0, 80) : null,
      // `sanearMensaje` SIEMPRE: un error del motor envuelto por drizzle llega con la sentencia y
      // sus parámetros dentro, y esta columna acaba en pantalla.
      errorDetalle: i.errorDetalle ? sanearMensaje(i.errorDetalle) : null,
      updatedAt: i.ahora,
    })
    .where(and(
      eq(siigoColaFacturacion.id, i.colaId),
      eq(siigoColaFacturacion.tomadoPor, i.tomadoPor),
    ))
    .returning({ id: siigoColaFacturacion.id });
  return filas.length > 0;
}

/**
 * Suelta el arrendamiento sin tocar nada más. Es el apagado limpio (AC7).
 *
 * Lo que se libera vuelve a estar disponible en el ciclo siguiente con su cita intacta: no se
 * reintenta antes de tiempo ni gasta un intento. Sin esto, apagar el proceso con filas tomadas las
 * dejaría esperando a que venciera el arrendamiento —veinte minutos de nada— aunque el trabajador
 * supiera perfectamente que no las iba a mirar.
 */
export async function liberar(args: {
  colaId: string; tomadoPor: string; ahora: Date;
}): Promise<boolean> {
  const filas = await db.update(siigoColaFacturacion)
    .set({ tomadoPor: null, tomadoEn: null, updatedAt: args.ahora })
    .where(and(
      eq(siigoColaFacturacion.id, args.colaId),
      eq(siigoColaFacturacion.tomadoPor, args.tomadoPor),
    ))
    .returning({ id: siigoColaFacturacion.id });
  return filas.length > 0;
}

// ── Consultar ───────────────────────────────────────────────────────────────

/** La fila de la cola de cada trámite, para quien pregunta por trámites y no por lotes. */
export interface ColaDeTramite {
  tramiteId: string;
  cola: SiigoColaItem;
}

/**
 * AC1 — En qué punto está lo que se encoló, mientras el trabajador lo procesa.
 *
 * Se resuelve por la PERTENENCIA del lote y no recalculando la huella de cada trámite. Con la huella
 * solo se puede preguntar por el conjunto exacto que alguien encoló: mientras la estrategia sea
 * `por_tramite` coincide con «un trámite», y el día que se consolide, `huellaDeTramites([id])` no
 * encontraría el lote de {A, B} y la pantalla diría que ese trámite no está en cola cuando sí lo
 * está. La pertenencia responde bien en los dos casos.
 */
export async function colaDeTramites(
  ambiente: SiigoAmbiente, tramiteIds: string[],
): Promise<ColaDeTramite[]> {
  const ids = [...new Set(tramiteIds)].filter(Boolean);
  if (ids.length === 0) return [];

  const pertenencia = await lotesDeTramites(ambiente, ids);
  if (pertenencia.length === 0) return [];

  const loteIds = [...new Set(pertenencia.map((p) => p.loteId))];
  const filas = await db.select(COLUMNAS).from(siigoColaFacturacion)
    .where(and(
      eq(siigoColaFacturacion.ambiente, ambiente),
      sql`${siigoColaFacturacion.loteId} = ANY(${sql.param(loteIds)}::uuid[])`,
    ))
    .orderBy(desc(siigoColaFacturacion.createdAt));

  const porLote = new Map<string, SiigoColaItem>();
  for (const f of filas) {
    const item = aItem(f as Record<string, unknown>);
    porLote.set(item.loteId, item);
  }

  const salida: ColaDeTramite[] = [];
  for (const p of pertenencia) {
    const cola = porLote.get(p.loteId);
    // Un lote sin fila de cola es normal: lo crea también la emisión directa, que no encola nada.
    if (cola) salida.push({ tramiteId: p.tramiteId, cola });
  }
  return salida;
}
