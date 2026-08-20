// FLITO Conciliación — el asiento del dinero (HU #11677, Feature #11623, CF-03/CF-04/CF-07).
//
// **Esta es la única función del módulo que mueve un peso.** Todo lo demás —cargar, cruzar,
// re-cruzar, descartar— deja la boleta quieta. Aquí sale dinero de la bolsa del cliente y de la
// bolsa de tránsito, y no vuelve.
//
// Vive en un archivo propio y no dentro de `flito-conciliacion.service.ts` por dos motivos: aquel va
// por 667 de sus 800 líneas contables, y —más importante— separar «lo que decide» de «lo que paga»
// hace que el diff que toca el dinero se pueda revisar entero de una sentada.
//
// ── Cómo se sostiene el «nunca dos veces» (ADR-0006 §2, opción A) ────────────────────────────────
//
// La conciliación asienta con LA MISMA LLAVE que usa el sellado de la liquidación:
// `salida:soat:<soatId>` en el libro del cliente y `consumo:soat:<soatId>` en el de tránsito. No es
// una coincidencia ni un atajo: es la decisión central del ADR. Sus consecuencias, las tres:
//
//   1. **Concilio y luego liquido.** Al sellar, `registrarSalidasLiquidacion` encuentra la llave
//      ocupada, `asentarMovimiento` devuelve `duplicado: true` ANTES del lock y el saldo no se
//      mueve. `liquidar()` ignora ese retorno, así que **no hay una sola línea que tocar en
//      `flito-liquidacion.service.ts`**. El GMF sigue calculándose sobre el subtotal al sellar, sin
//      enterarse — que es lo que exige el AC4.
//   2. **Liquido y luego concilio.** Aquí es `asentarMovimiento` quien nos devuelve `duplicado` a
//      nosotros. El saldo tampoco se mueve (CF-04: «puede descontar entonces, pero nunca dos veces»)
//      y el movimiento existente se ADOPTA: pasa a `origen='conciliacion'`. Ver `adoptar()`.
//   3. **La garantía no vive en un `if`.** Vive en `idx_flito_bolsa_mov_llave`, un índice único de
//      PostgreSQL, y se cumple aunque este código se equivoque o aunque dos transacciones —el botón
//      «Conciliar» y el botón «Liquidar»— entren a la vez. Para dinero de terceros esa diferencia
//      decide (ADR §2.2).
//
// ── Por qué `tramite_id` va en NULL, y por qué eso protege ───────────────────────────────────────
//
// `flito_tramites.soat_id` es muchos-a-uno: un SOAT tiene N trámites y **no hay uno «correcto» que
// poner** (ADR §4.1). Como efecto lateral, el movimiento queda fuera del barrido de
// `reversarSalidasLiquidacion` por DOS condiciones independientes —`origen <> 'automatico'` y
// `tramite_id IS NULL`— en vez de una. Que sean dos es deliberado: si mañana alguien poblara
// `tramite_id`, la protección del CF-07 se reduciría a una sola condición sin que nada avisara. Eso
// es lo que fija `flito-conciliacion-conciliar.test.ts` con un test explícito.
//
// ── El hueco de `alertasDeConciliacion`, decidido y no ignorado ──────────────────────────────────
//
// `alertasDeConciliacion` (`flito-bolsas.service.ts`) cuenta movimientos `origen='automatico'` sin
// soporte. Un movimiento de conciliación NO entra ahí, y **no se añade** a ese filtro: el
// comprobante PSE cuelga de la BOLETA y no de cada uno de sus N movimientos, así que incluirlo
// convertiría cada SOAT conciliado en una alerta permanente que nadie podría cerrar. El hueco que
// eso deja —una boleta conciliada sin comprobante que el tablero no ve— se cierra con un predicado
// A NIVEL DE BOLETA (`estado='conciliada'` sin soporte vivo con `conciliacion_boleta_id`), y ese
// predicado va en la **HU #11678**, que es la que crea la vía para subir el comprobante. Añadirlo
// hoy reproduciría el mismo fallo a otra escala: toda boleta conciliada sería una alerta incerrable
// hasta que exista el botón para cerrarla. Queda escrito aquí y en el comentario de
// `alertasDeConciliacion` para que no sea una decisión tácita.
//
// Diseño y tradeoffs: docs/adr/ADR-0006-flito-conciliacion-boletas-soat.md §2, §4 y §7.3
// Copy del aviso de éxito: docs/ux/flito-conciliacion.md, «El copy exacto — AC4 y AC5»

import { eq, inArray } from 'drizzle-orm';
import {
  CodigoErrorConciliacion,
  type BolsaTransitoAfectadaDto, type ConciliacionRealizadaDto, type LineaAdoptadaDto,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  flitoBolsaMovimientos, flitoBolsas, flitoBolsasTransito, flitoBolsaTransitoMovimientos,
  flitoConciliacionBoletas, flitoConciliacionLineas,
} from '../../db/schema.js';
import {
  asentarMovimiento, num, redondear, type CtxUsuario, type Tx,
} from '../flito-bolsas/flito-bolsas.service.js';
import {
  PREFIJO_CONSUMO, registrarConsumoTransito,
} from '../flito-bolsas/flito-bolsas-transito.service.js';
import {
  ConciliacionError, detalleDesde, recruzarEnTx, type FilaLinea, type RecruceEnTx, type SoatInfo,
} from './flito-conciliacion.service.js';

/**
 * Llave del SOAT en el libro del CLIENTE. Es literalmente la que construye `salidasDe`
 * (`flito-liquidacion.service.ts`) más el prefijo de familia que le antepone
 * `registrarSalidasLiquidacion`. Si alguna de las dos cambiara sin la otra, el doble cobro volvería
 * en silencio: por eso el test de esta HU afirma la cadena completa y no solo el sufijo.
 */
const LLAVE_SALIDA_SOAT = 'salida:soat:';

/** Llave del SOAT en el libro de TRÁNSITO, sin el prefijo de familia (lo pone el consumo). */
function llaveSoat(soatId: string): string {
  return `soat:${soatId}`;
}

/** Concepto con el que la salida entra en los dos libros. Una boleta es de un solo concepto. */
const CONCEPTO_SOAT = 'soat';

/**
 * Lo que una bolsa de tránsito acumuló en esta conciliación.
 *
 * Se agrupa por BOLSA y no por organismo —aunque la UX hable de «la bolsa de tránsito de Medellín»—
 * porque el saldo es de la bolsa: dos secretarías cubiertas por la misma bolsa comparten saldo, y
 * pintar dos líneas con el mismo saldo resultante sería enseñar el mismo dinero dos veces.
 */
interface AcumuladoTransito {
  descontado: number;
}

/**
 * Concilia una boleta: asienta el descuento en las dos bolsas y la sella (AC1).
 *
 * **Todo o nada (AC3).** Una sola transacción para las N líneas: si el asiento de la última falla,
 * ninguna de las anteriores queda asentada y la boleta sigue `cargada`. No hay conciliación parcial
 * porque media boleta conciliada obligaría a llevar dos verdades sobre el mismo pago externo.
 *
 * **El re-cruce va DENTRO de la transacción** y no se fía del botón: entre la carga y el clic pueden
 * haber pasado días, y un SOAT pudo salir de `pagado`, cambiar de valor o conciliarse en otra
 * boleta. Si alguna línea deja de cuadrar, el diagnóstico actualizado se PERSISTE y la transacción
 * hace COMMIT **antes** de responder el 409 — lanzar desde dentro perdería con el rollback justo el
 * cuadre nuevo que el usuario necesita ver (ADR §7.3).
 */
export async function conciliarBoleta(
  id: string,
  ctx: CtxUsuario,
): Promise<ConciliacionRealizadaDto> {
  // Un acto que mueve dinero de terceros exige un actor con nombre y con id: el CHECK
  // `flito_concil_boleta_sello_chk` no admite media firma, y sin esto sería un 23514 en mitad de la
  // transacción del dinero en vez de un rechazo limpio en la puerta.
  if (ctx.userId === null) {
    throw new ConciliacionError(
      403, CodigoErrorConciliacion.SIN_ACTOR,
      'No se puede conciliar sin un usuario identificado: es un acto que mueve dinero.',
    );
  }

  const salida = await db.transaction(async (tx) => {
    const recruce = await recruzarEnTx(tx, id);
    const detalle = detalleDesde(recruce);
    // CF-02: basta UNA línea fuera de `ok`. Se DEVUELVE en vez de lanzarse para que el re-cruce que
    // acaba de escribirse sobreviva al commit.
    if (detalle.sinCuadrar > 0) return { conciliada: false as const, detalle };
    return { conciliada: true as const, datos: await asentar(tx, recruce, ctx) };
  });

  if (!salida.conciliada) {
    throw new ConciliacionError(
      409, CodigoErrorConciliacion.BOLETA_INCOMPLETA,
      `La boleta cambió desde que la cargaste: ${salida.detalle.sinCuadrar} de `
      + `${salida.detalle.filas} líneas no cuadran. No se descontó nada.`,
      { boleta: salida.detalle, sinCuadrar: salida.detalle.sinCuadrar },
    );
  }
  return salida.datos;
}

/**
 * El cuerpo del asiento, con la boleta ya bloqueada y todas sus líneas en `ok`.
 *
 * **Las líneas se asientan EN SERIE**, y no es una elección de estilo: cada asiento lee el saldo que
 * dejó el anterior, así que el `saldo_resultante` de la última línea es el saldo real de la bolsa —
 * que es lo que el extracto usa para auditar sin recalcular. En paralelo, la última línea dejaría de
 * coincidir con el saldo. Es el mismo motivo por el que `registrarSalidasLiquidacion` lo hace así.
 */
async function asentar(
  tx: Tx,
  recruce: RecruceEnTx,
  ctx: CtxUsuario,
): Promise<ConciliacionRealizadaDto> {
  const { boleta } = recruce;
  const ahora = new Date();
  // La fecha contable es la del PAGO en el portal, no la de hoy: un pago del 30 que se concilia el 2
  // pertenece al mes del pago. `periodoImputable` ya sabe qué hacer si ese periodo está cerrado.
  const fecha = boleta.fechaPago;
  // Sin placa, sin VIN y sin número de póliza: la observación acaba en el .xlsx que exporta el
  // extracto, que es un archivo que sale del sistema (ADR §4.2). Todo lo demás se alcanza por
  // identificador, desde la línea de la boleta y con el control de acceso de este módulo.
  const observacion = `Conciliación de la boleta ${boleta.referencia}`;

  const adoptados: LineaAdoptadaDto[] = [];
  const transito = new Map<string, AcumuladoTransito>();
  const selladas: FilaLinea[] = [];
  let descontadoCliente = 0;
  let totalConciliado = 0;

  for (const linea of recruce.lineas) {
    const soat = soatDe(recruce, linea);
    const valor = soat.valorPagado as number;
    totalConciliado = redondear(totalConciliado + valor);

    const { movimiento, duplicado } = await asentarMovimiento(tx, boleta.companiaId, {
      tipo: 'salida',
      origen: 'conciliacion',
      valor,
      fecha,
      concepto: CONCEPTO_SOAT,
      organismoCodigo: soat.organismoCodigo,
      // Ver la cabecera: NULL porque no hay un trámite correcto que poner, no porque falte.
      tramiteId: null,
      observacion,
      llaveIdempotencia: `${LLAVE_SALIDA_SOAT}${soat.id}`,
      etiqueta: 'salida',
    }, ctx);

    if (duplicado) {
      adoptados.push(await adoptar(tx, linea, soat, movimiento));
      // El aviso de la pantalla lee `adoptados`; este flag es el de la LÍNEA y ya no aplica: su
      // movimiento acaba de dejar de ser `automatico`. Se limpia para que la respuesta inmediata
      // diga exactamente lo mismo que dirá el detalle al recargar la página.
      recruce.ctx.descontados.delete(soat.id);
    } else {
      descontadoCliente = redondear(descontadoCliente + valor);
    }

    const movimientoTransitoId = await asentarTransito(tx, soat, valor, fecha, ctx, transito);

    await tx.update(flitoConciliacionLineas)
      .set({ conciliadaEn: ahora, movimientoBolsaId: movimiento.id, movimientoTransitoId })
      .where(eq(flitoConciliacionLineas.id, linea.id));
    selladas.push({ ...linea, conciliadaEn: ahora });
  }

  await tx.update(flitoConciliacionBoletas)
    .set({
      estado: 'conciliada',
      conciliadaEn: ahora,
      conciliadaPorId: ctx.userId,
      conciliadaPorNombre: ctx.nombre.slice(0, 150),
      updatedAt: ahora,
    })
    .where(eq(flitoConciliacionBoletas.id, boleta.id));

  const selladaDb = {
    ...boleta,
    estado: 'conciliada',
    conciliadaEn: ahora,
    conciliadaPorNombre: ctx.nombre.slice(0, 150),
  };

  return {
    boleta: detalleDesde({ ...recruce, boleta: selladaDb, lineas: selladas }),
    soatConciliados: selladas.length,
    totalConciliado,
    cliente: {
      companiaId: boleta.companiaId,
      nombre: recruce.companiaNombre,
      descontado: descontadoCliente,
      saldoResultante: await saldoCliente(tx, boleta.companiaId),
    },
    transito: await resumirTransito(tx, transito),
    adoptados,
  };
}

/**
 * El SOAT de una línea `ok`, con su valor pagado comprobado.
 *
 * Las tres comprobaciones son salvaguardas y no casos esperados: `evaluarFila` solo devuelve `ok`
 * con un SOAT resuelto y con `valor_pagado` que cuadra al peso, y el re-cruce acaba de correr dentro
 * de esta misma transacción. Llegar aquí sin valor significaría que la fila cambió DENTRO de la
 * transacción, y ante eso se aborta: descontar cero es peor que no descontar.
 */
function soatDe(recruce: RecruceEnTx, linea: FilaLinea): SoatInfo {
  const soat = linea.soatId ? recruce.ctx.porSoatId.get(linea.soatId) : undefined;
  if (!soat || soat.valorPagado === null || soat.valorPagado <= 0) {
    throw new ConciliacionError(
      409, CodigoErrorConciliacion.SIN_VALOR_PAGADO,
      `La línea ${linea.filaNumero} dejó de tener un valor pagado con el que descontar. `
      + 'No se descontó nada; vuelve a cruzar la boleta.',
      { filaNumero: linea.filaNumero },
    );
  }
  return soat;
}

/**
 * Adopta el movimiento que ya existía: lo pasa a `origen = 'conciliacion'` (ADR §2.4-ii).
 *
 * Es el «orden 2» — el trámite se liquidó antes de que Financiera cargara la boleta —, y sin esto el
 * CF-07 se cumpliría solo en uno de los dos órdenes: el movimiento seguiría siendo `automatico` con
 * su `tramite_id`, así que reversar la liquidación devolvería un dinero que sí se pagó en el portal.
 *
 * **La llave NO se toca**, y eso es lo que mantiene la reserva viva: el sellado sigue sin poder
 * cobrar. Se reescribe UNA columna, igual que `reversarSalidasLiquidacion` reescribe la llave de una
 * fila del libro «append-only» — el dinero (valor, saldo resultante, fecha) queda intacto.
 *
 * Si el movimiento previo ya era `conciliacion`, no hay nada que adoptar pero la línea SÍ cuenta como
 * ya descontada: lo que el aviso necesita decir es «esto no se volvió a cobrar», venga de donde
 * venga. En la práctica no ocurre —`idx_flito_concil_linea_soat_unica` lo impide— y por eso el
 * `UPDATE` se condiciona en vez de lanzarse siempre.
 */
async function adoptar(
  tx: Tx,
  linea: FilaLinea,
  soat: SoatInfo,
  movimiento: { id: string; origen: string; valor: number },
): Promise<LineaAdoptadaDto> {
  const adoptado = movimiento.origen === 'automatico';
  if (adoptado) {
    await tx.update(flitoBolsaMovimientos)
      .set({ origen: 'conciliacion' })
      .where(eq(flitoBolsaMovimientos.id, movimiento.id));
  }
  return {
    lineaId: linea.id,
    filaNumero: linea.filaNumero,
    soatId: soat.id,
    // El valor del MOVIMIENTO, no el `valor_pagado` de hoy. Los dos coinciden casi siempre —el cruce
    // exige que el Excel cuadre al peso con el SOAT—, pero solo casi: si el valor pagado se corrigió
    // después del sellado y la boleta trae el importe corregido, el que salió de la bolsa en su día
    // sigue siendo el del asiento. Este campo dice cuánto NO se volvió a cobrar, así que tiene que
    // ser lo que de verdad se cobró entonces.
    valor: movimiento.valor,
    movimientoBolsaId: movimiento.id,
    adoptado,
  };
}

/**
 * El OTRO lado del asiento: lo que se paga ANTE la secretaría también consume la bolsa de tránsito.
 *
 * Devuelve el id del movimiento para amarrarlo a la línea, o `null` si ninguna bolsa cubre el par
 * (organismo, `soat`) — que es un desenlace **normal y sin error**: la mayoría de las secretarías no
 * están en ninguna bolsa, y una línea sin cobertura descuenta solo la del cliente (AC1).
 *
 * `registrarConsumoTransito` devuelve `null` por DOS motivos que colapsan en el mismo valor: que
 * nadie cubra, y que la llave ya estuviera ocupada. Se distinguen releyendo por la llave —que es
 * única— en vez de cambiando la firma de una función que también usa `liquidar`.
 */
async function asentarTransito(
  tx: Tx,
  soat: SoatInfo,
  valor: number,
  fecha: string,
  ctx: CtxUsuario,
  transito: Map<string, AcumuladoTransito>,
): Promise<string | null> {
  const nuevo = await registrarConsumoTransito(tx, {
    organismoCodigo: soat.organismoCodigo,
    concepto: CONCEPTO_SOAT,
    // Mismo motivo que en el libro del cliente, y misma consecuencia: `reversarConsumoTransito`
    // filtra por `tramite_id` Y por `origen='automatico'`, y este movimiento falla las dos.
    tramiteId: null,
    valor,
    fecha,
    llave: llaveSoat(soat.id),
    origen: 'conciliacion',
  }, ctx);

  if (nuevo) {
    acumular(transito, nuevo.bolsaId, valor);
    return nuevo.id;
  }

  const previo = await consumoPorLlave(tx, `${PREFIJO_CONSUMO}${llaveSoat(soat.id)}`);
  // Ninguna bolsa cubre este par: no hay nada que descontar ni que amarrar.
  if (!previo) return null;

  // La llave ya estaba: el sellado consumió esta bolsa antes. No se vuelve a mover un peso y el
  // movimiento se adopta, igual que en el libro del cliente.
  if (previo.origen === 'automatico') {
    await tx.update(flitoBolsaTransitoMovimientos)
      .set({ origen: 'conciliacion' })
      .where(eq(flitoBolsaTransitoMovimientos.id, previo.id));
  }
  // Cero: no salió un peso hoy, pero la bolsa SÍ participa y su saldo tiene que salir en el aviso.
  acumular(transito, previo.bolsaId, 0);
  return previo.id;
}

/** Movimiento de tránsito por su llave. El índice único garantiza que sea uno o ninguno. */
async function consumoPorLlave(
  tx: Tx,
  llave: string,
): Promise<{ id: string; bolsaId: string; origen: string } | undefined> {
  const [fila] = await tx.select({
    id: flitoBolsaTransitoMovimientos.id,
    bolsaId: flitoBolsaTransitoMovimientos.bolsaId,
    origen: flitoBolsaTransitoMovimientos.origen,
  })
    .from(flitoBolsaTransitoMovimientos)
    .where(eq(flitoBolsaTransitoMovimientos.llaveIdempotencia, llave))
    .limit(1);
  return fila;
}

function acumular(
  transito: Map<string, AcumuladoTransito>,
  bolsaId: string,
  valor: number,
): void {
  const previo = transito.get(bolsaId);
  transito.set(bolsaId, { descontado: redondear((previo?.descontado ?? 0) + valor) });
}

/**
 * Saldo del cliente DESPUÉS de la conciliación, leído de la bolsa.
 *
 * Se lee y no se deduce del último movimiento: cuando TODAS las líneas fueron adopciones no se
 * asentó nada, y el `saldo_resultante` de un movimiento viejo es el saldo de otro día. Es la cifra
 * que el usuario va a cotejar contra el extracto, así que sale de la misma fila que el extracto lee.
 */
async function saldoCliente(tx: Tx, companiaId: number): Promise<number> {
  const [fila] = await tx.select({ saldo: flitoBolsas.saldo })
    .from(flitoBolsas)
    .where(eq(flitoBolsas.companiaId, companiaId))
    .limit(1);
  return num(fila?.saldo ?? '0');
}

/** El desglose por bolsa de tránsito, con su nombre y su saldo de hoy. Vacío si no se tocó ninguna. */
async function resumirTransito(
  tx: Tx,
  transito: Map<string, AcumuladoTransito>,
): Promise<BolsaTransitoAfectadaDto[]> {
  const ids = [...transito.keys()];
  if (ids.length === 0) return [];

  const bolsas = await tx.select({
    id: flitoBolsasTransito.id,
    nombre: flitoBolsasTransito.nombre,
    saldo: flitoBolsasTransito.saldo,
  })
    .from(flitoBolsasTransito)
    .where(inArray(flitoBolsasTransito.id, ids));

  return bolsas.map((b) => ({
    bolsaId: b.id,
    nombre: b.nombre,
    descontado: transito.get(b.id)?.descontado ?? 0,
    saldoResultante: num(b.saldo),
  }));
}
