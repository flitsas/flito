// FLITO — bolsa que FLIT precarga para pagar trámites ante las secretarías (HU #11161, ajuste 0124).
//
// Es la INVERSA de la bolsa del cliente y conviene tenerlo presente al leer: aquí FLIT pone el
// dinero por adelantado y un tercero lo gasta pagando ante las secretarías. La pregunta que este
// módulo responde es «¿cuánto le queda a la bolsa de mi sector?», no «¿cuánto le debemos?».
//
// Una bolsa NO es una secretaría. Cubre parejas (secretaría, concepto) —Medellín, Envigado y
// Sabaneta solo para impuestos, por ejemplo— y ese par no puede repetirse en dos bolsas ACTIVAS.
// Esa exclusividad, garantizada por el índice parcial `uq_flito_bolsas_unicas_cobertura_activa`
// (ADR-0029 D3), es lo que hace que `bolsaQueCubre` devuelva como mucho una candidata y que el
// sellado de la liquidación no tenga que preguntarle a nadie a dónde va el dinero.
//
// HU #13906 (Feature #13887, ADR-0029): desde la 0257 este módulo lee y escribe el MODELO ÚNICO
// (`flito_bolsas_unicas` con `alcance='transito'`, su cobertura y el libro único). Las rutas
// `/transito/*` y sus DTO no cambian: el origen 'recarga' del libro único se sigue mostrando como
// 'carga' (`OrigenMovimientoTransito`) hasta que la HU-G retire estas rutas. El asiento es el núcleo
// común de `flito-bolsas.libro.ts` (`asentarEnBolsa`), así que las reglas de imputación (periodo,
// redondeo, tope, fecha) son por construcción las mismas en los dos alcances.
//
// RN-T1 (Q7): una bolsa inactiva no admite cargas (409 `bolsa_inactiva`) ni consumos; sí la
//        devolución de sus propios consumos al reversar una liquidación.

import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoBolsasUnicas, flitoBolsasUnicasCobertura, flitoBolsasUnicasMovimientos, flitoTramites,
  organismosTransitoConfig,
} from '../../db/schema.js';
import {
  type BolsaTransitoConNivel,
  type BolsaTransitoDto,
  CodigoErrorBolsa,
  type ConceptoBolsaTransito,
  CONCEPTOS_BOLSA_TRANSITO,
  type CoberturaBolsaTransito,
  type DatosBolsaTransito,
  deudaBolsaTransito,
  esConceptoBolsaTransito,
  type MovimientoBolsaDto,
  type MovimientoTransitoDto,
  nivelBolsaTransitoDe,
  type NivelBolsaTransito,
  type OrigenMovimientoTransito,
  porcentajeSaldo,
  type TipoMovimientoTransito,
} from '@operaciones/shared-types';
import {
  aMovimientoDto as aMovimientoLibro, asentarEnBolsa, BolsaError, bolsaBloqueadaPorId, type BolsaEnLibro,
  type CtxUsuario, type DatosMovimiento, esLlaveDuplicada, hoyIso, MSG_BOLSA_INACTIVA, movimientoPorLlave, num,
  PREFIJO_REVERSADO, redondear, type SoporteRecarga, type Tx, validarMovimiento,
} from './flito-bolsas.libro.js';
import { bolsaTransitoPara } from './flito-bolsas.resolver.js';

export type { BolsaTransitoConNivel, BolsaTransitoDto, MovimientoTransitoDto };

/** Tipo del comprobante de una carga en `flito_soportes`. */
const TIPO_SOPORTE_CARGA = 'carga_organismo';

/** Prefijo de familia de las llaves. El índice único es uno solo para todo el libro único. */
export const PREFIJO_CONSUMO = 'consumo:';

/** Filtro de alcance: las rutas de tránsito nunca ven ni tocan una bolsa de compañía. */
const DE_TRANSITO = eq(flitoBolsasUnicas.alcance, 'transito');

// ─────────────────────────── Cobertura ───────────────────────────────────────

/**
 * La bolsa ACTIVA que cubre un concepto ante una secretaría, o `null` si ninguna lo hace.
 *
 * Delega en `bolsaTransitoPara` (resolver común del gancho de descuento) y sale con la bolsa
 * BLOQUEADA. Que devuelva `null` es un desenlace NORMAL —la mayoría de las secretarías no están en
 * ninguna bolsa, o su bolsa está inactiva— y quien llama debe tratarlo como «aquí no hay nada que
 * descontar», nunca como un error.
 */
export async function bolsaQueCubre(
  tx: Tx,
  organismoCodigo: string,
  concepto: ConceptoBolsaTransito,
): Promise<(BolsaEnLibro & { nombre: string }) | null> {
  const r = await bolsaTransitoPara(tx, organismoCodigo, concepto);
  return r.bolsa ?? null;
}

/** Cobertura de varias bolsas de una sola consulta, con el alias del organismo ya resuelto. */
async function coberturaDe(bolsaIds: string[]): Promise<Map<string, CoberturaBolsaTransito[]>> {
  const porBolsa = new Map<string, CoberturaBolsaTransito[]>();
  if (bolsaIds.length === 0) return porBolsa;

  const filas = await db
    .select({
      bolsaId: flitoBolsasUnicasCobertura.bolsaId,
      organismoCodigo: flitoBolsasUnicasCobertura.organismoCodigo,
      organismoNombre: organismosTransitoConfig.alias,
      concepto: flitoBolsasUnicasCobertura.concepto,
    })
    .from(flitoBolsasUnicasCobertura)
    .leftJoin(
      organismosTransitoConfig,
      eq(organismosTransitoConfig.codigo, flitoBolsasUnicasCobertura.organismoCodigo),
    )
    .where(inArray(flitoBolsasUnicasCobertura.bolsaId, bolsaIds))
    .orderBy(flitoBolsasUnicasCobertura.organismoCodigo, flitoBolsasUnicasCobertura.concepto);

  for (const f of filas) {
    const lista = porBolsa.get(f.bolsaId) ?? [];
    lista.push({
      organismoCodigo: f.organismoCodigo,
      organismoNombre: f.organismoNombre,
      concepto: f.concepto as ConceptoBolsaTransito,
    });
    porBolsa.set(f.bolsaId, lista);
  }
  return porBolsa;
}

/**
 * Valida y normaliza lo que llega del formulario de creación.
 *
 * Deduplica secretarías y conceptos antes de materializar el producto: repetir Medellín en la lista
 * chocaría contra la clave primaria de la cobertura y convertiría un descuido de la pantalla en un
 * 500.
 */
function normalizarDatos(datos: DatosBolsaTransito): {
  nombre: string; organismos: string[]; conceptos: ConceptoBolsaTransito[];
} {
  const nombre = datos.nombre?.trim() ?? '';
  if (nombre.length < 3) throw new BolsaError('El nombre de la bolsa debe tener al menos 3 caracteres');
  if (nombre.length > 120) throw new BolsaError('El nombre de la bolsa no puede superar 120 caracteres');

  const organismos = [...new Set((datos.organismos ?? []).map((o) => o.trim()).filter(Boolean))];
  if (organismos.length === 0) throw new BolsaError('Selecciona al menos una secretaría');

  const conceptos = [...new Set(datos.conceptos ?? [])];
  if (conceptos.length === 0) throw new BolsaError('Selecciona al menos un concepto');
  for (const c of conceptos) {
    if (!esConceptoBolsaTransito(c)) throw new BolsaError(`Concepto no válido: ${c}`);
  }
  // Orden fijo para que la cobertura se lea igual venga como venga del formulario.
  conceptos.sort((a, b) => CONCEPTOS_BOLSA_TRANSITO.indexOf(a) - CONCEPTOS_BOLSA_TRANSITO.indexOf(b));

  return { nombre, organismos, conceptos };
}

/**
 * Traduce el choque contra `uq_flito_bolsas_unicas_cobertura_activa` en un mensaje que diga QUÉ se
 * solapa. Solo compiten las parejas ACTIVAS (D3): una bolsa inactiva no reserva su cobertura.
 *
 * Se consulta después del fallo y no antes: comprobar primero dejaría una ventana entre la
 * comprobación y el INSERT, y en algo que decide a dónde va el dinero esa ventana no es aceptable.
 * El índice es el árbitro; esto solo traduce su veredicto.
 */
async function errorDeSolapamiento(
  organismos: string[],
  conceptos: ConceptoBolsaTransito[],
  bolsaIdExcluida?: string,
): Promise<BolsaError> {
  const chocan = await db
    .select({
      organismoCodigo: flitoBolsasUnicasCobertura.organismoCodigo,
      organismoNombre: organismosTransitoConfig.alias,
      concepto: flitoBolsasUnicasCobertura.concepto,
      bolsaNombre: flitoBolsasUnicas.nombre,
      bolsaId: flitoBolsasUnicasCobertura.bolsaId,
    })
    .from(flitoBolsasUnicasCobertura)
    .innerJoin(flitoBolsasUnicas, eq(flitoBolsasUnicas.id, flitoBolsasUnicasCobertura.bolsaId))
    .leftJoin(
      organismosTransitoConfig,
      eq(organismosTransitoConfig.codigo, flitoBolsasUnicasCobertura.organismoCodigo),
    )
    .where(and(
      eq(flitoBolsasUnicasCobertura.activa, true),
      inArray(flitoBolsasUnicasCobertura.organismoCodigo, organismos),
      inArray(flitoBolsasUnicasCobertura.concepto, conceptos),
    ));

  const ajenos = chocan.filter((c) => c.bolsaId !== bolsaIdExcluida);
  if (ajenos.length === 0) {
    return new BolsaError('Ya existe una bolsa con esa cobertura', 409, CodigoErrorBolsa.COBERTURA_OCUPADA);
  }
  const detalle = ajenos
    .slice(0, 3)
    .map((c) => `${c.organismoNombre ?? c.organismoCodigo} (${c.concepto}) ya está en «${c.bolsaNombre ?? ''}»`)
    .join('; ');
  const resto = ajenos.length > 3 ? ` y ${ajenos.length - 3} más` : '';
  return new BolsaError(
    `Una secretaría no puede tener el mismo concepto en dos bolsas: ${detalle}${resto}.`,
    409,
    CodigoErrorBolsa.COBERTURA_OCUPADA,
  );
}

const nombreEnUso = (nombre: string): BolsaError =>
  new BolsaError(`Ya existe una bolsa llamada «${nombre}»`, 409, CodigoErrorBolsa.NOMBRE_EN_USO);

// ─────────────────────────── Lectura ─────────────────────────────────────────

function aBolsaDto(
  f: typeof flitoBolsasUnicas.$inferSelect,
  cobertura: CoberturaBolsaTransito[],
): BolsaTransitoDto {
  return {
    id: f.id,
    nombre: f.nombre ?? '',
    saldo: num(f.saldo),
    // El libro único llama «entrada» a lo que aquí fue siempre «carga»: mismo dato, mismo DTO.
    ultimaCargaValor: f.ultimaEntradaValor === null ? null : num(f.ultimaEntradaValor),
    ultimaCargaEn: f.ultimaEntradaEn?.toISOString() ?? null,
    cobertura,
  };
}

function conNivel(base: BolsaTransitoDto, cargado: string, consumido: string): BolsaTransitoConNivel {
  return {
    ...base,
    nivel: nivelBolsaTransitoDe(base.saldo, base.ultimaCargaValor),
    porcentaje: porcentajeSaldo(base.saldo, base.ultimaCargaValor),
    deuda: deudaBolsaTransito(base.saldo),
    totalCargado: redondear(num(cargado)),
    totalConsumido: redondear(num(consumido)),
  };
}

const M = flitoBolsasUnicasMovimientos;
const TOTALES = {
  cargado: sql<string>`coalesce(sum(case when ${M.tipo} = 'entrada' then ${M.valor} else 0 end), 0)`,
  consumido: sql<string>`coalesce(sum(case when ${M.tipo} = 'salida' then ${M.valor} else 0 end), 0)`,
};

/** Bolsa con su nivel ya clasificado, o `null` si no existe (o no es de tránsito). */
export async function bolsaTransitoDe(bolsaId: string): Promise<BolsaTransitoConNivel | null> {
  const [fila] = await db
    .select()
    .from(flitoBolsasUnicas)
    .where(and(eq(flitoBolsasUnicas.id, bolsaId), DE_TRANSITO))
    .limit(1);
  if (!fila) return null;

  // El valor se guarda siempre positivo y la dirección la da `tipo`, así que los dos totales salen
  // de la misma pasada filtrando por dirección.
  const [[totales], cobertura] = await Promise.all([
    db.select(TOTALES).from(M).where(eq(M.bolsaId, bolsaId)),
    coberturaDe([bolsaId]),
  ]);

  return conNivel(
    aBolsaDto(fila, cobertura.get(bolsaId) ?? []),
    totales?.cargado ?? '0',
    totales?.consumido ?? '0',
  );
}

/**
 * Orden en que se atienden las bolsas: primero la que más urge (HU #11210).
 *
 * `sin_cargas` va por delante de `normal` a propósito, aunque no sea una alarma: una bolsa creada a
 * la que nunca se le ha cargado nada es un trámite pendiente de alguien, mientras que una en nivel
 * normal no pide nada.
 */
const ORDEN_NIVEL: Record<NivelBolsaTransito, number> = {
  en_prestamo: 0, agotada: 1, critico: 2, bajo: 3, sin_cargas: 4, normal: 5,
};

/**
 * Todas las bolsas de tránsito, de la más urgente a la más tranquila (HU #11210, AC9).
 *
 * Tres consultas fijas, no una por bolsa: el listado se pinta entero de una vez y un N+1 aquí
 * crecería con cada bolsa que se abra.
 */
export async function bolsasTransito(): Promise<BolsaTransitoConNivel[]> {
  const filas = await db.select().from(flitoBolsasUnicas).where(DE_TRANSITO).orderBy(flitoBolsasUnicas.nombre);
  if (filas.length === 0) return [];

  const ids = filas.map((f) => f.id);
  const [totales, cobertura] = await Promise.all([
    db.select({ bolsaId: M.bolsaId, ...TOTALES }).from(M).where(inArray(M.bolsaId, ids)).groupBy(M.bolsaId),
    coberturaDe(ids),
  ]);

  const totalPorBolsa = new Map(totales.map((t) => [t.bolsaId, t]));

  return filas
    .map((f) => {
      const t = totalPorBolsa.get(f.id);
      return conNivel(
        aBolsaDto(f, cobertura.get(f.id) ?? []),
        t?.cargado ?? '0',
        t?.consumido ?? '0',
      );
    })
    .sort((a, b) => ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel] || a.saldo - b.saldo);
}

/** Movimientos de la bolsa, del más reciente al más antiguo, con el trámite legible. */
export async function movimientosTransitoDe(bolsaId: string): Promise<MovimientoTransitoDto[]> {
  const filas = await db
    .select({ m: M, idFlit: flitoTramites.idFlit })
    .from(M)
    .leftJoin(flitoTramites, eq(M.tramiteId, flitoTramites.id))
    .where(eq(M.bolsaId, bolsaId))
    .orderBy(desc(M.createdAt));

  return filas.map(({ m, idFlit }) => aMovimientoDto(aMovimientoLibro(m, null, idFlit ?? null)));
}

// ─────────────────────────── Creación y edición ──────────────────────────────

/** Cobertura de una bolsa: el producto de sus secretarías por sus conceptos, con su estado. */
function filasCobertura(bolsaId: string, organismos: string[], conceptos: ConceptoBolsaTransito[], activa: boolean) {
  return organismos.flatMap((organismoCodigo) =>
    conceptos.map((concepto) => ({ bolsaId, organismoCodigo, concepto, activa })));
}

/**
 * Crea una bolsa con su cobertura.
 *
 * Bolsa y cobertura se escriben en la MISMA transacción: una bolsa sin cobertura no cubriría nada y
 * sería dinero sin destino, exactamente el estado que este modelo existe para evitar.
 */
export async function crearBolsaTransito(
  datos: DatosBolsaTransito,
  ctx: CtxUsuario,
): Promise<BolsaTransitoConNivel> {
  const { nombre, organismos, conceptos } = normalizarDatos(datos);

  const id = await db.transaction(async (tx) => {
    let bolsaId: string;
    try {
      const [creada] = await tx.insert(flitoBolsasUnicas)
        .values({ alcance: 'transito', nombre, saldo: '0', creadaPorId: ctx.userId })
        .returning();
      bolsaId = creada.id;
    } catch (e) {
      if (esLlaveDuplicada(e)) throw nombreEnUso(nombre);
      throw e;
    }

    try {
      await tx.insert(flitoBolsasUnicasCobertura).values(filasCobertura(bolsaId, organismos, conceptos, true));
    } catch (e) {
      if (!esLlaveDuplicada(e)) throw e;
      throw await errorDeSolapamiento(organismos, conceptos);
    }
    return bolsaId;
  });

  const bolsa = await bolsaTransitoDe(id);
  if (!bolsa) throw new BolsaError('No fue posible crear la bolsa', 500);
  return bolsa;
}

/**
 * Redefine nombre y cobertura de una bolsa. El SALDO no se toca: es dinero real y no se edita.
 *
 * La cobertura se reemplaza entera (borrar + insertar) en vez de calcular el diferencial: el
 * formulario manda el estado final, y un diff sobre tres conceptos no compra nada frente a la
 * simplicidad de reescribirla. Sigue dentro de una transacción, así que nadie ve la bolsa sin
 * cobertura a medio camino. La cobertura nueva hereda el `activa` de la bolsa (invariante del modelo).
 */
export async function actualizarBolsaTransito(
  bolsaId: string,
  datos: DatosBolsaTransito,
  _ctx: CtxUsuario,
): Promise<BolsaTransitoConNivel> {
  const { nombre, organismos, conceptos } = normalizarDatos(datos);

  await db.transaction(async (tx) => {
    const existe = await bolsaTransitoBloqueada(tx, bolsaId);

    try {
      await tx.update(flitoBolsasUnicas)
        .set({ nombre, updatedAt: new Date() })
        .where(eq(flitoBolsasUnicas.id, bolsaId));
    } catch (e) {
      if (esLlaveDuplicada(e)) throw nombreEnUso(nombre);
      throw e;
    }

    await tx.delete(flitoBolsasUnicasCobertura)
      .where(eq(flitoBolsasUnicasCobertura.bolsaId, bolsaId));

    try {
      await tx.insert(flitoBolsasUnicasCobertura)
        .values(filasCobertura(bolsaId, organismos, conceptos, existe.activa));
    } catch (e) {
      if (!esLlaveDuplicada(e)) throw e;
      throw await errorDeSolapamiento(organismos, conceptos, bolsaId);
    }
  });

  const bolsa = await bolsaTransitoDe(bolsaId);
  if (!bolsa) throw new BolsaError('La bolsa no existe', 404);
  return bolsa;
}

// ─────────────────────────── Escritura del libro ─────────────────────────────

/** Bloquea la bolsa (`FOR UPDATE`) y exige que sea de tránsito. La bolsa se crea explícitamente. */
async function bolsaTransitoBloqueada(tx: Tx, bolsaId: string): Promise<BolsaEnLibro> {
  const bolsa = await bolsaBloqueadaPorId(tx, bolsaId);
  // Una bolsa de compañía tiene `companiaId`; por las rutas de tránsito no existe.
  if (!bolsa || bolsa.companiaId !== null) throw new BolsaError('La bolsa no existe', 404);
  return bolsa;
}

/**
 * El asiento de tránsito sobre el núcleo común (`asentarEnBolsa`).
 *
 * Pre-chequeo de la llave ANTES de tocar el saldo: un reintento del sellado no puede mover la bolsa
 * ni un peso (AC10). La SEGUNDA lectura, ya dentro del lock, la hace `asentarEnBolsa` (Bug #11685,
 * punto 1): la familia `consumo:soat:*` tiene dos escritores —sellado y conciliación— que en un
 * trámite sin cliente solo se serializan por el lock de ESTA bolsa.
 *
 * NO valida saldo suficiente: la bolsa puede quedar en negativo y eso es el préstamo (AC5).
 */
async function asentar(
  tx: Tx,
  bolsa: BolsaEnLibro,
  datos: DatosMovimiento,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoTransitoDto; duplicado: boolean }> {
  // Savepoint (Bug #11685 punto 3): tras un 23505 la relectura por llave puede correr y el choque es duplicado.
  const r = await asentarEnBolsa(tx, bolsa, { ...datos, savepoint: true }, { userId: ctx.userId, nombre: ctx.nombre.slice(0, 150) });
  return { movimiento: aMovimientoDto(r.movimiento), duplicado: r.duplicado };
}

/** El libro único dice 'recarga'; el contrato de `/transito/*` sigue diciendo 'carga'. */
function aMovimientoDto(m: MovimientoBolsaDto): MovimientoTransitoDto {
  return {
    id: m.id,
    bolsaId: m.bolsaId,
    organismoCodigo: m.organismoCodigo,
    concepto: m.concepto as ConceptoBolsaTransito | null,
    tipo: m.tipo as TipoMovimientoTransito,
    origen: (m.origen === 'recarga' ? 'carga' : m.origen) as OrigenMovimientoTransito,
    tramiteId: m.tramiteId,
    idFlit: m.idFlit,
    valor: m.valor,
    saldoResultante: m.saldoResultante,
    periodo: m.periodo,
    fecha: m.fecha,
    observacion: m.observacion,
    soporteId: m.soporteId,
    registradoPorNombre: m.registradoPorNombre,
    createdAt: m.createdAt,
  };
}

// ─────────────────────────── Carga (AC2, AC6) ────────────────────────────────

export interface DatosCargaTransito {
  valor: number;
  fecha?: string;
  observacion?: string | null;
  soporte?: SoporteRecarga | null;
}

/**
 * Carga saldo en la bolsa.
 *
 * Si venía en negativo, la carga NETA la deuda por pura aritmética (AC6): −4.000.000 más una carga
 * de 10.000.000 deja 6.000.000. Por eso el préstamo no necesita tabla ni estado propio.
 * RN-T1 (Q7): sobre una bolsa inactiva → 409 `bolsa_inactiva` (primero hay que reactivarla).
 */
export async function registrarCargaTransito(
  bolsaId: string,
  datos: DatosCargaTransito,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoTransitoDto; saldo: number }> {
  const asiento: DatosMovimiento = {
    tipo: 'entrada',
    origen: 'recarga',
    valor: datos.valor,
    fecha: datos.fecha ?? hoyIso(),
    observacion: datos.observacion ?? null,
    soporte: datos.soporte ?? null,
    tipoSoporte: TIPO_SOPORTE_CARGA,
    etiqueta: 'carga',
  };
  validarMovimiento(asiento);
  return db.transaction(async (tx) => {
    const bolsa = await bolsaTransitoBloqueada(tx, bolsaId);
    if (!bolsa.activa) throw new BolsaError(MSG_BOLSA_INACTIVA, 409, CodigoErrorBolsa.BOLSA_INACTIVA);
    const { movimiento } = await asentar(tx, bolsa, asiento, ctx);
    return { movimiento, saldo: movimiento.saldoResultante };
  });
}

// ─────────────────────────── Consumo (AC3, AC4, AC8) ─────────────────────────

export interface DatosConsumoTransito {
  organismoCodigo: string;
  concepto: ConceptoBolsaTransito;
  /**
   * Trámite cuyo pago originó el consumo.
   *
   * **Nullable**, y la columna lo era desde la 0120: lo que estaba de más era este tipo. Un consumo
   * de CONCILIACIÓN (Feature #11623) no cuelga de ningún trámite —un SOAT tiene N trámites y no hay
   * uno «correcto» que poner, ADR-0006 §4.1—, y elegir uno haría que el reverso *de ese* trámite
   * pareciera pertinente cuando no lo es.
   */
  tramiteId: string | null;
  /** Valor SIN GMF: el gravamen ya viene incluido en el comprobante del organismo (AC4). */
  valor: number;
  fecha: string;
  /** Llave sin prefijo de familia; la pone quien conoce la naturaleza del consumo. */
  llave: string;
  /**
   * Quién produce el consumo. Por defecto `automatico`, que es el sellado de la liquidación.
   *
   * La conciliación asienta con `conciliacion`, y eso NO es una etiqueta: es lo que deja el
   * movimiento fuera del barrido de `reversarConsumoTransito` —que filtra por `origen='automatico'`—
   * y hace que un cambio de estado del trámite no devuelva un dinero que sí se pagó (CF-07).
   */
  origen?: 'automatico' | 'conciliacion';
}

/**
 * Asienta el consumo de un concepto en la bolsa ACTIVA que lo cubra, dentro de la transacción del
 * sellado o de la conciliación.
 *
 * No hace nada si ninguna bolsa activa cubre ese par: sellar un trámite de una secretaría que nadie
 * metió en una bolsa —o cuya bolsa se inactivó (Q7)— tiene que seguir funcionando igual (AC1). Nunca
 * crea una bolsa (D6).
 *
 * Devuelve `null` por DOS motivos distintos que colapsan en el mismo valor —ninguna bolsa cubre, o
 * la llave ya estaba ocupada—. Quien necesite distinguirlos (la conciliación lo necesita, para saber
 * si hay un movimiento previo que adoptar) tiene que releer por la llave, que es única.
 */
export async function registrarConsumoTransito(
  tx: Tx,
  datos: DatosConsumoTransito,
  ctx: CtxUsuario,
): Promise<MovimientoTransitoDto | null> {
  const llaveIdempotencia = `${PREFIJO_CONSUMO}${datos.llave}`;
  const previo = await movimientoPorLlave(tx, llaveIdempotencia);
  if (previo) return null;

  const bolsa = await bolsaQueCubre(tx, datos.organismoCodigo, datos.concepto);
  if (!bolsa) return null;

  const { movimiento, duplicado } = await asentar(tx, bolsa, {
    tipo: 'salida',
    origen: datos.origen ?? 'automatico',
    valor: datos.valor,
    fecha: datos.fecha,
    organismoCodigo: datos.organismoCodigo,
    concepto: datos.concepto,
    tramiteId: datos.tramiteId,
    llaveIdempotencia,
    etiqueta: 'salida',
  }, ctx);
  return duplicado ? null : movimiento;
}

/**
 * Devuelve a las bolsas lo que consumió este trámite (AC9).
 *
 * Igual que en la bolsa del cliente: el libro es append-only, así que devolver es asentar una
 * entrada nueva, y solo alcanza a los consumos VIVOS —los que conservan su llave sin prefijar—, de
 * modo que reversar dos veces no acredita dos veces. Se devuelve aunque la bolsa esté inactiva: es
 * la reversión de su propio movimiento (Q7).
 *
 * Un mismo trámite puede haber consumido de VARIAS bolsas (el derecho de una, el impuesto de otra),
 * así que cada contrapartida se asienta en la bolsa de la que salió el consumo original.
 */
export async function reversarConsumoTransito(
  tx: Tx,
  tramiteId: string,
  ctx: CtxUsuario,
): Promise<MovimientoTransitoDto[]> {
  const consumos = await tx
    .select()
    .from(M)
    .where(and(
      eq(M.tramiteId, tramiteId),
      eq(M.origen, 'automatico'),
      eq(M.tipo, 'salida'),
      like(M.llaveIdempotencia, `${PREFIJO_CONSUMO}%`),
    ));

  const contras: MovimientoTransitoDto[] = [];
  for (const c of consumos) {
    const bolsa = await bolsaBloqueadaPorId(tx, c.bolsaId);
    if (!bolsa) continue; // imposible por la FK; se deja por tipado
    const { movimiento } = await asentar(tx, bolsa, {
      tipo: 'entrada',
      origen: 'automatico',
      valor: num(c.valor),
      fecha: hoyIso(),
      organismoCodigo: c.organismoCodigo,
      concepto: c.concepto as ConceptoBolsaTransito | null,
      tramiteId: c.tramiteId,
      observacion: `Reverso de la liquidación: devuelve el consumo de ${c.concepto ?? 'el trámite'}`,
      llaveIdempotencia: `contra:${c.id}`,
    }, ctx);
    contras.push(movimiento);

    // Libera la llave del consumo original para que volver a liquidar vuelva a consumir.
    await tx
      .update(M)
      .set({ llaveIdempotencia: `${PREFIJO_REVERSADO}${c.llaveIdempotencia}`.slice(0, 200) })
      .where(eq(M.id, c.id));
  }
  return contras;
}
