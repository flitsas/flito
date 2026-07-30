// FLITO — bolsas prepago del cliente (HU #11121, Feature #11120 §2.1).
//
// Esta HU cubre el esquema y las ENTRADAS: la recarga que FLIT precarga en la bolsa del cliente.
// Las salidas automáticas cuelgan del sellado de la liquidación y llegan en la HU #11122; por eso
// `registrarMovimiento` ya recibe concepto, organismo, trámite y llave de idempotencia aunque una
// recarga no use ninguno.

import { and, desc, eq, like, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients, flitoBolsaCierres, flitoBolsaMovimientos, flitoBolsas, flitoOrganismoPagos, flitoSoportes,
} from '../../db/schema.js';
import { aIso, parseFechaQuery, TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import {
  type BolsaDto,
  type ConceptoBolsa,
  type MovimientoBolsaDto,
  type OrigenMovimientoBolsa,
  periodoDe,
  type TipoMovimientoBolsa,
} from '@operaciones/shared-types';

/** Error de negocio: lo traduce la capa HTTP a 400/409, no al error handler genérico. */
export class BolsaError extends Error {
  constructor(message: string, readonly estado: number = 400) {
    super(message);
    this.name = 'BolsaError';
  }
}

/** Transacción drizzle o el `db` raíz: ambos exponen select/insert/update. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Se consulta indistintamente dentro de una transacción o fuera de ella. */
type DbOrTx = typeof db | Tx;

export interface CtxUsuario {
  userId: number | null;
  nombre: string;
}

/** Comprobante ya subido al almacenamiento, pendiente de registrarse en `flito_soportes`. */
export interface SoporteRecarga {
  nombreArchivo: string;
  contentType: string;
  storageKey: string;
  hash: string;
  tamanoBytes: number;
}

export interface DatosRecarga {
  valor: number;
  /** ISO 'YYYY-MM-DD'. Por defecto, hoy. */
  fecha?: string;
  observacion?: string | null;
  soporte: SoporteRecarga;
  /**
   * Clave que envía el cliente en el encabezado `Idempotency-Key`. Debe acuñarse al ABRIR el
   * formulario, no al pulsar guardar: si se genera por clic, el doble clic produce dos claves y no
   * protege de nada.
   */
  claveIdempotencia: string;
}

/** Lo que necesita un movimiento para asentarse en el libro. */
interface DatosMovimiento {
  tipo: TipoMovimientoBolsa;
  origen: OrigenMovimientoBolsa;
  valor: number;
  fecha: string;
  concepto?: ConceptoBolsa | null;
  organismoCodigo?: string | null;
  tramiteId?: string | null;
  observacion?: string | null;
  /** Comprobante a registrar DENTRO de la misma transacción que el movimiento. */
  soporte?: SoporteRecarga | null;
  llaveIdempotencia?: string | null;
  /** Movimiento que este ajuste corrige (HU #11123). */
  corrigeMovimientoId?: string | null;
  /** Sustantivo para los mensajes de error: 'recarga', 'salida', 'ajuste'… */
  etiqueta?: string;
}

const DOS_DECIMALES = 100;

/** Techo de `numeric(14,2)`: 12 dígitos enteros. */
const TOPE_NUMERIC = 999_999_999_999.99;

/** Redondea a pesos con dos decimales: numeric(14,2) no admite más y el flotante arrastra ruido. */
function redondear(n: number): number {
  return Math.round(n * DOS_DECIMALES) / DOS_DECIMALES;
}

function num(v: string | null): number {
  return v === null ? 0 : Number(v);
}

/**
 * Hoy en Colombia, no en UTC. Una recarga registrada a las 8 p.m. de Bogotá ya es el día siguiente
 * en UTC: fecharla así la imputaría al periodo equivocado en el cierre de fin de mes.
 */
function hoyIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Periodo contable de una fecha 'YYYY-MM-DD' ya validada, sin pasar por el huso local. */
function periodoDeFecha(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return periodoDe(new Date(Date.UTC(y, m - 1, d)));
}

// ─────────────────────────── Lectura ─────────────────────────────────────────

/** Bolsa del cliente con el nombre de la compañía, o null si nunca ha tenido una. */
export async function bolsaDe(companiaId: number): Promise<BolsaDto | null> {
  const [fila] = await db
    .select({
      id: flitoBolsas.id,
      companiaId: flitoBolsas.companiaId,
      companiaNombre: clients.name,
      saldo: flitoBolsas.saldo,
      ultimaRecargaValor: flitoBolsas.ultimaRecargaValor,
      ultimaRecargaEn: flitoBolsas.ultimaRecargaEn,
    })
    .from(flitoBolsas)
    .innerJoin(clients, eq(flitoBolsas.companiaId, clients.id))
    .where(eq(flitoBolsas.companiaId, companiaId))
    .limit(1);

  if (!fila) return null;
  return {
    id: fila.id,
    companiaId: fila.companiaId,
    companiaNombre: fila.companiaNombre,
    saldo: num(fila.saldo),
    ultimaRecargaValor: fila.ultimaRecargaValor === null ? null : num(fila.ultimaRecargaValor),
    // aIso y no .toISOString(): el tipo declarado no garantiza que la columna llegue como Date
    // (ver shared/utils/fecha-rango.ts). Llamarlo a ciegas revienta en producción sin aviso del tsc.
    ultimaRecargaEn: aIso(fila.ultimaRecargaEn),
  };
}

export interface FiltroMovimientos {
  periodo?: string;
  limite?: number;
}

/** Libro de la bolsa, del movimiento más reciente al más antiguo. */
export async function movimientosDe(
  companiaId: number,
  filtro: FiltroMovimientos = {},
): Promise<MovimientoBolsaDto[]> {
  const condiciones = [eq(flitoBolsaMovimientos.companiaId, companiaId)];
  if (filtro.periodo) condiciones.push(eq(flitoBolsaMovimientos.periodo, filtro.periodo));

  const filas = await db
    .select()
    .from(flitoBolsaMovimientos)
    .where(and(...condiciones))
    .orderBy(desc(flitoBolsaMovimientos.createdAt))
    .limit(Math.min(filtro.limite ?? 200, 500));

  return filas.map(aMovimientoDto);
}

function aMovimientoDto(m: typeof flitoBolsaMovimientos.$inferSelect): MovimientoBolsaDto {
  return {
    id: m.id,
    companiaId: m.companiaId,
    tipo: m.tipo as TipoMovimientoBolsa,
    origen: m.origen as OrigenMovimientoBolsa,
    concepto: m.concepto === null ? null : (m.concepto as ConceptoBolsa),
    organismoCodigo: m.organismoCodigo,
    tramiteId: m.tramiteId,
    valor: num(m.valor),
    saldoResultante: num(m.saldoResultante),
    periodo: m.periodo,
    fecha: m.fecha,
    observacion: m.observacion,
    soporteId: m.soporteId,
    registradoPorNombre: m.registradoPorNombre,
    createdAt: aIso(m.createdAt) ?? '',
  };
}

// ─────────────────────────── Escritura ───────────────────────────────────────

/**
 * Bolsa del cliente con la fila BLOQUEADA (`FOR UPDATE`), creándola si es su primera vez (AC2).
 *
 * El lock es lo que hace correcto el saldo denormalizado: dos recargas simultáneas del mismo cliente
 * se serializan aquí en vez de pisarse el saldo la una a la otra.
 */
async function bolsaBloqueada(tx: Tx, companiaId: number): Promise<{ id: string; saldo: number }> {
  const bloquear = async () => {
    const [fila] = await tx
      .select({ id: flitoBolsas.id, saldo: flitoBolsas.saldo })
      .from(flitoBolsas)
      .where(eq(flitoBolsas.companiaId, companiaId))
      .for('update')
      .limit(1);
    return fila;
  };

  const existente = await bloquear();
  if (existente) return { id: existente.id, saldo: num(existente.saldo) };

  const [compania] = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, companiaId))
    .limit(1);
  if (!compania) throw new BolsaError('La compañía no existe', 404);

  // `FOR UPDATE` sobre una fila que aún no existe no bloquea nada: dos primeras recargas simultáneas
  // del mismo cliente llegarían ambas hasta aquí. `DO NOTHING` deja que una gane y que la otra
  // relea la fila ya creada —y la bloquee— en vez de reventar con un 23505 opaco.
  await tx
    .insert(flitoBolsas)
    .values({ companiaId, saldo: '0' })
    .onConflictDoNothing({ target: flitoBolsas.companiaId });

  const creada = await bloquear();
  if (!creada) throw new BolsaError('No fue posible abrir la bolsa del cliente', 409);
  return { id: creada.id, saldo: num(creada.saldo) };
}

/** Tipo del comprobante de recarga en `flito_soportes`, junto a los de SOAT, impuesto y derecho. */
const TIPO_SOPORTE_RECARGA = 'recarga_bolsa';

/**
 * Movimiento ya asentado con esa llave, o `undefined`.
 *
 * La llave lleva prefijo por familia (`recarga:…`, y `tramite:…` en la HU #11122) porque el índice
 * único es uno solo para toda la tabla: sin prefijo, una llave de recarga podría colisionar con una
 * de salida automática y una de las dos se perdería en silencio.
 */
async function movimientoPorLlave(tx: Tx, llave: string): Promise<MovimientoBolsaDto | undefined> {
  const [fila] = await tx
    .select()
    .from(flitoBolsaMovimientos)
    .where(eq(flitoBolsaMovimientos.llaveIdempotencia, llave))
    .limit(1);
  return fila ? aMovimientoDto(fila) : undefined;
}

/** Violación de unicidad de Postgres. */
function esLlaveDuplicada(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/**
 * Registra el comprobante ya subido al almacenamiento. Trunca a lo que aguantan las columnas: un
 * nombre de archivo largo no puede tumbar una recarga con un 22001 después de haber subido el
 * archivo (`flito_soportes.nombre_archivo` es varchar(300) y `content_type` varchar(100)).
 */
async function insertarSoporte(tx: Tx, soporte: SoporteRecarga, ctx: CtxUsuario): Promise<string> {
  const [s] = await tx.insert(flitoSoportes).values({
    tipo: TIPO_SOPORTE_RECARGA,
    nombreArchivo: soporte.nombreArchivo.slice(0, 300),
    contentType: soporte.contentType.slice(0, 100),
    storageKey: soporte.storageKey,
    hash: soporte.hash,
    tamanoBytes: soporte.tamanoBytes,
    subidoPorId: ctx.userId,
    subidoPorNombre: ctx.nombre.slice(0, 150),
  }).returning({ id: flitoSoportes.id });
  return s.id;
}

/**
 * Asienta un movimiento y deja el saldo de la bolsa al día, dentro de una sola transacción.
 *
 * No valida saldo suficiente a propósito: una salida puede dejar la bolsa en negativo (decisión de
 * negocio del refinamiento del Feature). Lo que no se admite es un valor no positivo — la dirección
 * la marca `tipo`, no el signo.
 */
async function registrarMovimiento(
  companiaId: number,
  datos: DatosMovimiento,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; duplicado: boolean }> {
  // Se valida antes de abrir la transacción: no hay por qué pedirle una a Postgres solo para
  // rechazar un valor negativo. `asentarMovimiento` vuelve a validar porque también se le entra
  // desde la liquidación, con una transacción ya abierta.
  validarMovimiento(datos);
  return db.transaction((tx) => asentarMovimiento(tx, companiaId, datos, ctx));
}

/** Comprueba y normaliza lo que no depende de la base: valor redondeado y fecha contable. */
function validarMovimiento(datos: DatosMovimiento): { valor: number; fecha: string } {
  const etiqueta = datos.etiqueta ?? 'movimiento';
  const valor = redondear(datos.valor);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new BolsaError(`El valor de la ${etiqueta} debe ser mayor que cero`);
  }
  // numeric(14,2) tope en 999.999.999.999,99. Pasarse no es un error de negocio sino un 22003 de
  // Postgres, que llegaría como 500 y con el comprobante ya subido.
  if (valor > TOPE_NUMERIC) {
    throw new BolsaError(`El valor de la ${etiqueta} excede el máximo admitido`);
  }
  // Un '2026-02-31' pasa el regex de la ruta pero no es un día real; sin esto, el periodo saldría
  // corrido y el CHECK de la tabla reventaría como error 500 en vez de como error de negocio.
  const fecha = parseFechaQuery(datos.fecha);
  if (fecha === null) throw new BolsaError('La fecha del movimiento no es válida');
  // Nadie recarga mañana. Sin este tope, un dedazo en el año imputa el dinero a un periodo futuro
  // que el cierre mensual (HU #11126) nunca revisaría. La retroactividad sí se permite: los soportes
  // del organismo llegan tarde con frecuencia.
  if (fecha > hoyIso()) throw new BolsaError('La fecha del movimiento no puede ser futura');
  return { valor, fecha };
}

/**
 * El cuerpo del asiento, sobre una transacción YA abierta.
 *
 * Existe separado de `registrarMovimiento` porque las salidas automáticas (HU #11122) tienen que
 * asentarse dentro de la MISMA transacción que sella la liquidación: si el sellado se deshace, el
 * descuento debe deshacerse con él, y una transacción anidada no daría esa garantía.
 */
export async function asentarMovimiento(
  tx: Tx,
  companiaId: number,
  datos: DatosMovimiento,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; duplicado: boolean }> {
  const { valor, fecha } = validarMovimiento(datos);

  // Reenvío con la misma llave: se devuelve el movimiento original sin volver a mover el saldo.
  // Va ANTES del lock porque no necesita bloquear nada — si ya existe, no hay nada que escribir.
  if (datos.llaveIdempotencia) {
    const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
    if (previo) return { movimiento: previo, duplicado: true };
  }

  const bolsa = await bolsaBloqueada(tx, companiaId);

  // Periodo al que se IMPUTA el movimiento, que no siempre es el de su fecha. Un soporte del
  // organismo con fecha de julio que llega en agosto, con julio ya cerrado, se imputa a agosto: el
  // reporte de cierre de julio ya se firmó y no puede cambiar (HU #11126, AC3). La fecha real se
  // conserva intacta, así que el rezago es visible comparando `fecha` con `periodo`.
  const periodo = await periodoImputable(tx, companiaId, periodoDeFecha(fecha));

  const delta = datos.tipo === 'entrada' ? valor : -valor;
  const saldoResultante = redondear(bolsa.saldo + delta);

  // El comprobante se registra DENTRO de la transacción del dinero: si el movimiento no cuaja, no
  // puede quedar una fila de soporte apuntando a una recarga que nunca ocurrió.
  const soporteId = datos.soporte ? await insertarSoporte(tx, datos.soporte, ctx) : null;

  const [fila] = await tx
    .insert(flitoBolsaMovimientos)
    .values({
      bolsaId: bolsa.id,
      companiaId,
      tipo: datos.tipo,
      origen: datos.origen,
      concepto: datos.concepto ?? null,
      organismoCodigo: datos.organismoCodigo ?? null,
      tramiteId: datos.tramiteId ?? null,
      valor: String(valor),
      saldoResultante: String(saldoResultante),
      periodo,
      fecha,
      observacion: datos.observacion ?? null,
      soporteId,
      registradoPorId: ctx.userId,
      registradoPorNombre: ctx.nombre,
      llaveIdempotencia: datos.llaveIdempotencia ?? null,
      corrigeMovimientoId: datos.corrigeMovimientoId ?? null,
    })
    .returning();

  // La última recarga solo la mueven las entradas de tipo recarga: es la base del nivel de riesgo
  // (HU #11125) y un ajuste manual no debería redefinirla.
  const esRecarga = datos.origen === 'recarga';
  await tx
    .update(flitoBolsas)
    .set({
      saldo: String(saldoResultante),
      updatedAt: new Date(),
      ...(esRecarga ? { ultimaRecargaValor: String(valor), ultimaRecargaEn: new Date() } : {}),
    })
    .where(eq(flitoBolsas.id, bolsa.id));

  return { movimiento: aMovimientoDto(fila), duplicado: false };
}

/** Llave de idempotencia de una recarga, con el prefijo de su familia. */
export function llaveRecarga(companiaId: number, clave: string): string {
  return `recarga:${companiaId}:${clave}`;
}

/**
 * Registra una recarga: dinero que FLIT precarga en la bolsa del cliente (AC1).
 *
 * Crea la bolsa si es la primera recarga del cliente (AC2) y actualiza el monto de la última
 * recarga, que es la base con la que la HU #11125 clasifica el riesgo del saldo.
 *
 * Es IDEMPOTENTE por `llaveIdempotencia`: reenviar la misma recarga —doble clic, reintento de red—
 * devuelve el movimiento original con `duplicado: true` y no vuelve a acreditar el dinero. Importa
 * porque el libro es append-only: lo que entra mal, entra para siempre.
 */
export async function registrarRecarga(
  companiaId: number,
  datos: DatosRecarga,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; saldo: number; duplicado: boolean }> {
  const llaveIdempotencia = llaveRecarga(companiaId, datos.claveIdempotencia);
  const movimientoDe = (m: MovimientoBolsaDto, duplicado: boolean) =>
    ({ movimiento: m, saldo: m.saldoResultante, duplicado });

  try {
    const { movimiento, duplicado } = await registrarMovimiento(
      companiaId,
      {
        tipo: 'entrada',
        origen: 'recarga',
        valor: datos.valor,
        fecha: datos.fecha ?? hoyIso(),
        observacion: datos.observacion ?? null,
        soporte: datos.soporte,
        llaveIdempotencia,
        etiqueta: 'recarga',
      },
      ctx,
    );
    return movimientoDe(movimiento, duplicado);
  } catch (e) {
    // Carrera: dos peticiones con la misma llave a la vez. El pre-chequeo de ambas salió vacío y el
    // índice único frenó a la segunda al escribir. Es el mismo caso de negocio que el replay, así que
    // se resuelve igual: se devuelve el que sí quedó asentado.
    if (!esLlaveDuplicada(e)) throw e;
    const previo = await movimientoPorLlave(db as unknown as Tx, llaveIdempotencia);
    if (!previo) throw e;
    return movimientoDe(previo, true);
  }
}

// ─────────────── Salidas automáticas del sellado de la liquidación (HU #11122) ───────────────

/** Un concepto liquidado que consume bolsa. */
export interface SalidaConcepto {
  concepto: ConceptoBolsa;
  valor: number;
  /**
   * Organismo al que se imputa. `null` en trámite digital y logística: son honorarios de FLIT, no
   * desembolsos a un organismo, así que no tienen uno natural al que cargarlos.
   */
  organismoCodigo: string | null;
  /**
   * Llave de idempotencia SIN prefijo de familia. La pone quien conoce la naturaleza del concepto:
   * el SOAT se cobra una vez por vehículo, el derecho una vez por trámite.
   */
  llave: string;
}

export interface DatosSalidasLiquidacion {
  companiaId: number;
  tramiteId: string;
  /** Fecha contable del descuento; normalmente el día del sellado. */
  fecha: string;
  conceptos: SalidaConcepto[];
}

/**
 * Asienta una salida por cada concepto liquidado, dentro de la transacción del sellado (AC1).
 *
 * NO valida saldo: la bolsa puede quedar en negativo. Si el organismo ya aprobó, el gasto ocurrió;
 * frenar el descuento no lo deshace, solo desalinea el sistema de la realidad (AC3).
 *
 * Los conceptos con valor nulo no llegan aquí: los filtra quien construye la lista, porque `null`
 * significa «no aplica» y no cero (AC2).
 */
export async function registrarSalidasLiquidacion(
  tx: Tx,
  datos: DatosSalidasLiquidacion,
  ctx: CtxUsuario,
): Promise<MovimientoBolsaDto[]> {
  const asentados: MovimientoBolsaDto[] = [];
  for (const c of datos.conceptos) {
    // En serie y no en paralelo: cada asiento lee el saldo que dejó el anterior, así que el
    // `saldo_resultante` de la última línea es el saldo real de la bolsa.
    const { movimiento, duplicado } = await asentarMovimiento(
      tx,
      datos.companiaId,
      {
        tipo: 'salida',
        origen: 'automatico',
        valor: c.valor,
        fecha: datos.fecha,
        concepto: c.concepto,
        organismoCodigo: c.organismoCodigo,
        tramiteId: datos.tramiteId,
        llaveIdempotencia: `${PREFIJO_SALIDA}${c.llave}`,
        etiqueta: 'salida',
      },
      ctx,
    );
    // Un duplicado no es un error: es el reintento del sellado (AC6) o un concepto que otro trámite
    // del mismo vehículo ya pagó (AC4). Simplemente no vuelve a mover el saldo.
    if (!duplicado) asentados.push(movimiento);
  }
  return asentados;
}

const PREFIJO_SALIDA = 'salida:';
/**
 * Prefijo que se antepone a la llave de una salida cuando su liquidación se reversa. Libera la llave
 * original —para que volver a liquidar vuelva a cobrar— sin perder de vista cuál fue.
 *
 * Es lo único que se reescribe de una fila del libro, y no toca el dinero: valor, saldo resultante y
 * fecha quedan intactos. El movimiento sigue ahí; lo que deja de estar es su reserva de la llave.
 */
const PREFIJO_REVERSADO = 'rev:';

/**
 * Deshace las salidas de un trámite con CONTRAMOVIMIENTOS, dentro de la transacción del reverso
 * (AC5). No borra nada: el libro es append-only, así que devolver el dinero es una entrada nueva.
 *
 * Solo alcanza a las salidas vivas —las que aún conservan su llave sin prefijar—, de modo que
 * reversar dos veces no acredita el dinero dos veces.
 */
export async function reversarSalidasLiquidacion(
  tx: Tx,
  tramiteId: string,
  ctx: CtxUsuario,
): Promise<MovimientoBolsaDto[]> {
  const salidas = await tx
    .select()
    .from(flitoBolsaMovimientos)
    .where(and(
      eq(flitoBolsaMovimientos.tramiteId, tramiteId),
      eq(flitoBolsaMovimientos.origen, 'automatico'),
      eq(flitoBolsaMovimientos.tipo, 'salida'),
      like(flitoBolsaMovimientos.llaveIdempotencia, `${PREFIJO_SALIDA}%`),
    ));

  const contras: MovimientoBolsaDto[] = [];
  for (const s of salidas) {
    const { movimiento } = await asentarMovimiento(
      tx,
      s.companiaId,
      {
        tipo: 'entrada',
        origen: 'automatico',
        valor: num(s.valor),
        fecha: hoyIso(),
        concepto: s.concepto === null ? null : (s.concepto as ConceptoBolsa),
        organismoCodigo: s.organismoCodigo,
        tramiteId: s.tramiteId,
        observacion: `Reverso de la liquidación: devuelve la salida de ${s.concepto ?? 'concepto'}`,
        // Llave propia por movimiento revertido: dos reversos seguidos no pueden acreditar dos veces.
        llaveIdempotencia: `contra:${s.id}`,
        etiqueta: 'devolución',
      },
      ctx,
    );
    contras.push(movimiento);

    // Se libera la llave de la salida original para que volver a liquidar el trámite vuelva a
    // cobrar. Sin esto, el segundo sellado vería la llave ocupada y no descontaría nada.
    await tx
      .update(flitoBolsaMovimientos)
      .set({ llaveIdempotencia: `${PREFIJO_REVERSADO}${s.llaveIdempotencia}`.slice(0, 200) })
      .where(eq(flitoBolsaMovimientos.id, s.id));
  }
  return contras;
}

// ───────────── Movimientos manuales y correcciones (HU #11123) ───────────────

const MOTIVO_MINIMO = 5;

export interface DatosMovimientoManual {
  tipo: TipoMovimientoBolsa;
  valor: number;
  motivo: string;
  fecha?: string;
  concepto?: ConceptoBolsa | null;
  organismoCodigo?: string | null;
  soporte?: SoporteRecarga | null;
}

/** Comprueba el motivo, que es lo único que hace auditable un movimiento manual. */
function motivoValido(motivo: string): string {
  const texto = motivo.trim();
  if (texto.length < MOTIVO_MINIMO) throw new BolsaError('Indica el motivo del movimiento');
  return texto;
}

/**
 * Rechaza escribir en un periodo ya cerrado (AC4).
 *
 * Distinto del rezago del asiento automático: allí el movimiento viene de un hecho que ya ocurrió
 * —el organismo cobró— y perderlo sería peor que imputarlo con desfase. Aquí lo escribe una persona
 * que puede elegir la fecha, así que apuntar a un mes ya conciliado es un error suyo, no un dato que
 * salvar.
 */
async function exigirPeriodoAbierto(tx: DbOrTx, companiaId: number, fecha: string): Promise<void> {
  const periodo = periodoDeFecha(fecha);
  if (await periodoEstaCerrado(tx, companiaId, periodo)) {
    throw new BolsaError(
      'No se pueden registrar ni editar movimientos de un periodo cerrado',
      409,
    );
  }
}

/**
 * Registra una entrada, salida o ajuste manual (AC1).
 *
 * No lleva llave de idempotencia: dos ajustes iguales el mismo día son dos ajustes, y quien los
 * registra los está viendo en pantalla. Lo que los hace rastreables es el motivo y la evidencia.
 */
export async function registrarMovimientoManual(
  companiaId: number,
  datos: DatosMovimientoManual,
  ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; saldo: number }> {
  const motivo = motivoValido(datos.motivo);
  const fecha = datos.fecha ?? hoyIso();
  await exigirPeriodoAbierto(db, companiaId, fecha);

  const { movimiento } = await registrarMovimiento(
    companiaId,
    {
      tipo: datos.tipo,
      origen: 'manual',
      valor: datos.valor,
      fecha,
      concepto: datos.concepto ?? null,
      organismoCodigo: datos.organismoCodigo ?? null,
      observacion: motivo,
      soporte: datos.soporte ?? null,
      etiqueta: datos.tipo === 'entrada' ? 'entrada manual' : 'salida manual',
    },
    ctx,
  );
  return { movimiento, saldo: movimiento.saldoResultante };
}

/**
 * Corrige el valor de un movimiento MANUAL con un ajuste que lo referencia (AC2).
 *
 * No se toca la fila original: el libro es append-only y el histórico debe seguir mostrando qué se
 * registró primero. La corrección asienta solo la DIFERENCIA, en la dirección que haga falta, de
 * modo que el saldo quede como si el valor correcto se hubiera registrado desde el principio.
 *
 * Los movimientos automáticos no se corrigen por aquí (AC5): vienen de un hecho —el sellado de una
 * liquidación— y cambiarles el valor desalinearía la bolsa de lo que dice la liquidación. Para esos
 * se registra un ajuste manual suelto, que deja constancia de que la corrección es una decisión de
 * una persona y no una enmienda al hecho.
 */
export async function corregirMovimiento(
  movimientoId: string,
  valorCorregido: number,
  motivoBruto: string,
  ctx: CtxUsuario,
): Promise<{ correccion: MovimientoBolsaDto; saldo: number }> {
  const motivo = motivoValido(motivoBruto);

  const [original] = await db
    .select()
    .from(flitoBolsaMovimientos)
    .where(eq(flitoBolsaMovimientos.id, movimientoId))
    .limit(1);
  if (!original) throw new BolsaError('El movimiento no existe', 404);

  if (original.origen !== 'manual') {
    throw new BolsaError(
      'Un movimiento automático no se edita: corrígelo con un ajuste manual',
      409,
    );
  }
  await exigirPeriodoAbierto(db, original.companiaId, original.fecha);

  const valorOriginal = num(original.valor);
  const diferencia = redondear(valorCorregido - valorOriginal);
  if (diferencia === 0) throw new BolsaError('El valor corregido es igual al actual');

  // Si el movimiento era una salida y sube de valor, hay que sacar más: la corrección va en la misma
  // dirección que el original. Si baja, va en la contraria.
  const mismaDireccion = diferencia > 0;
  const tipo: TipoMovimientoBolsa = mismaDireccion
    ? (original.tipo as TipoMovimientoBolsa)
    : (original.tipo === 'entrada' ? 'salida' : 'entrada');

  const { movimiento } = await registrarMovimiento(
    original.companiaId,
    {
      tipo,
      origen: 'manual',
      valor: Math.abs(diferencia),
      fecha: hoyIso(),
      concepto: original.concepto === null ? null : (original.concepto as ConceptoBolsa),
      organismoCodigo: original.organismoCodigo,
      tramiteId: original.tramiteId,
      observacion: `Corrección de ${valorOriginal} a ${valorCorregido}: ${motivo}`,
      corrigeMovimientoId: original.id,
      etiqueta: 'corrección',
    },
    ctx,
  );
  return { correccion: movimiento, saldo: movimiento.saldoResultante };
}

// ─────────────────── Cierre mensual del periodo (HU #11126) ──────────────────

/** Periodos ya cerrados de un cliente. */
async function periodosCerrados(tx: DbOrTx, companiaId: number): Promise<Set<string>> {
  const filas = await tx
    .select({ periodo: flitoBolsaCierres.periodo })
    .from(flitoBolsaCierres)
    .where(eq(flitoBolsaCierres.companiaId, companiaId));
  return new Set(filas.map((f) => f.periodo));
}

/** True si ese periodo ya está cerrado para el cliente. */
export async function periodoEstaCerrado(
  tx: DbOrTx, companiaId: number, periodo: string,
): Promise<boolean> {
  const [fila] = await tx
    .select({ id: flitoBolsaCierres.id })
    .from(flitoBolsaCierres)
    .where(and(
      eq(flitoBolsaCierres.companiaId, companiaId),
      eq(flitoBolsaCierres.periodo, periodo),
    ))
    .limit(1);
  return fila !== undefined;
}

/**
 * Periodo al que se puede imputar un movimiento cuya fecha cae en `periodoNatural`.
 *
 * Si ese periodo está cerrado, el movimiento no se rechaza: se corre al primer periodo abierto
 * desde entonces. Los soportes del organismo llegan tarde con frecuencia y perderlos sería peor que
 * imputarlos con un mes de desfase, que además queda visible al comparar `fecha` con `periodo`.
 */
async function periodoImputable(
  tx: DbOrTx, companiaId: number, periodoNatural: string,
): Promise<string> {
  const cerrados = await periodosCerrados(tx, companiaId);
  if (!cerrados.has(periodoNatural)) return periodoNatural;

  // Se avanza mes a mes hasta encontrar uno abierto. El tope es el periodo de hoy: nunca se imputa
  // a un mes futuro, aunque alguien haya cerrado por adelantado.
  const tope = periodoDeFecha(hoyIso());
  let p = periodoNatural;
  while (cerrados.has(p) && p < tope) p = periodoSiguiente(p);
  return p;
}

/** Periodo contable siguiente a 'YYYY-MM'. */
export function periodoSiguiente(periodo: string): string {
  const [anio, mes] = periodo.split('-').map(Number);
  return mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, '0')}`;
}

export interface CierreDto {
  id: string;
  companiaId: number;
  periodo: string;
  saldoInicial: number;
  totalEntradas: number;
  totalSalidas: number;
  saldoFinal: number;
  movimientos: number;
  observaciones: string | null;
  cerradoPorNombre: string;
  cerradoEn: string;
}

function aCierreDto(c: typeof flitoBolsaCierres.$inferSelect): CierreDto {
  return {
    id: c.id,
    companiaId: c.companiaId,
    periodo: c.periodo,
    saldoInicial: num(c.saldoInicial),
    totalEntradas: num(c.totalEntradas),
    totalSalidas: num(c.totalSalidas),
    saldoFinal: num(c.saldoFinal),
    movimientos: c.movimientos,
    observaciones: c.observaciones,
    cerradoPorNombre: c.cerradoPorNombre,
    cerradoEn: aIso(c.cerradoEn) ?? '',
  };
}

/** Cierres de un cliente, del más reciente al más antiguo. */
export async function cierresDe(companiaId: number): Promise<CierreDto[]> {
  const filas = await db
    .select()
    .from(flitoBolsaCierres)
    .where(eq(flitoBolsaCierres.companiaId, companiaId))
    .orderBy(desc(flitoBolsaCierres.periodo));
  return filas.map(aCierreDto);
}

/**
 * Cierra un periodo: congela sus movimientos y deja el reporte de auditoría (AC1).
 *
 * El disparo es manual y el periodo no tiene por qué ser el mes anterior: Financiera cierra cuando
 * ha conciliado. Lo que no se admite es cerrar un mes que aún no ha terminado, porque el saldo final
 * que quedaría sellado no sería el del periodo.
 *
 * El saldo inicial sale del cierre anterior, no de recalcular el libro entero: encadenar los cierres
 * es lo que hace que el arrastre sea auditable mes a mes.
 */
export async function cerrarPeriodo(
  companiaId: number,
  periodo: string,
  observaciones: string | null,
  ctx: CtxUsuario,
): Promise<CierreDto> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    throw new BolsaError('El periodo debe tener la forma AAAA-MM');
  }
  const enCurso = periodoDeFecha(hoyIso());
  if (periodo > enCurso) throw new BolsaError('No se puede cerrar un periodo futuro');
  if (periodo === enCurso) {
    throw new BolsaError('El periodo en curso no ha terminado: solo se cierra un mes ya cumplido');
  }

  return db.transaction(async (tx) => {
    // Se bloquea la bolsa mientras se cierra: sin el lock, un movimiento que entre entre el conteo y
    // el INSERT quedaría dentro del periodo pero fuera del reporte.
    const bolsa = await bolsaBloqueada(tx, companiaId);

    if (await periodoEstaCerrado(tx, companiaId, periodo)) {
      throw new BolsaError('El periodo ya está cerrado', 409);
    }

    const [totales] = await tx
      .select({
        entradas: sql<string>`coalesce(sum(case when ${flitoBolsaMovimientos.tipo} = 'entrada' then ${flitoBolsaMovimientos.valor} else 0 end), 0)`,
        salidas: sql<string>`coalesce(sum(case when ${flitoBolsaMovimientos.tipo} = 'salida' then ${flitoBolsaMovimientos.valor} else 0 end), 0)`,
        movimientos: sql<number>`count(*)::int`,
      })
      .from(flitoBolsaMovimientos)
      .where(and(
        eq(flitoBolsaMovimientos.companiaId, companiaId),
        eq(flitoBolsaMovimientos.periodo, periodo),
      ));

    const [previo] = await tx
      .select({ saldoFinal: flitoBolsaCierres.saldoFinal })
      .from(flitoBolsaCierres)
      .where(and(
        eq(flitoBolsaCierres.companiaId, companiaId),
        lt(flitoBolsaCierres.periodo, periodo),
      ))
      .orderBy(desc(flitoBolsaCierres.periodo))
      .limit(1);

    const saldoInicial = previo ? num(previo.saldoFinal) : 0;
    const totalEntradas = redondear(num(totales?.entradas ?? '0'));
    const totalSalidas = redondear(num(totales?.salidas ?? '0'));
    const saldoFinal = redondear(saldoInicial + totalEntradas - totalSalidas);

    const [fila] = await tx.insert(flitoBolsaCierres).values({
      bolsaId: bolsa.id,
      companiaId,
      periodo,
      saldoInicial: String(saldoInicial),
      totalEntradas: String(totalEntradas),
      totalSalidas: String(totalSalidas),
      saldoFinal: String(saldoFinal),
      movimientos: totales?.movimientos ?? 0,
      observaciones: observaciones?.trim() ? observaciones.trim() : null,
      cerradoPorId: ctx.userId,
      cerradoPorNombre: ctx.nombre.slice(0, 150),
    }).returning();

    return aCierreDto(fila);
  });
}

// ───────── Extracto por OT y bolsa simbólica del organismo (HU #11124) ───────

export interface LineaAgrupada {
  clave: string;
  entradas: number;
  salidas: number;
  movimientos: number;
}

export interface ExtractoCliente {
  companiaId: number;
  saldoActual: number;
  totalEntradas: number;
  totalSalidas: number;
  porOrganismo: LineaAgrupada[];
  porConcepto: LineaAgrupada[];
}

/** Agrupa el libro de un cliente por una columna, sumando entradas y salidas por separado. */
async function agrupar(
  companiaId: number,
  columna: typeof flitoBolsaMovimientos.organismoCodigo | typeof flitoBolsaMovimientos.concepto,
  periodo?: string,
): Promise<LineaAgrupada[]> {
  const condiciones = [eq(flitoBolsaMovimientos.companiaId, companiaId)];
  if (periodo) condiciones.push(eq(flitoBolsaMovimientos.periodo, periodo));

  const filas = await db
    .select({
      clave: columna,
      entradas: sql<string>`coalesce(sum(case when ${flitoBolsaMovimientos.tipo} = 'entrada' then ${flitoBolsaMovimientos.valor} else 0 end), 0)`,
      salidas: sql<string>`coalesce(sum(case when ${flitoBolsaMovimientos.tipo} = 'salida' then ${flitoBolsaMovimientos.valor} else 0 end), 0)`,
      movimientos: sql<number>`count(*)::int`,
    })
    .from(flitoBolsaMovimientos)
    .where(and(...condiciones))
    .groupBy(columna);

  return filas.map((f) => ({
    // `null` es una agrupación legítima, no un fallo: las recargas no tienen organismo ni concepto,
    // y el trámite digital y la logística no tienen organismo por ser honorarios de FLIT.
    clave: f.clave ?? 'sin_asignar',
    entradas: redondear(num(f.entradas)),
    salidas: redondear(num(f.salidas)),
    movimientos: f.movimientos,
  }));
}

/**
 * Extracto del cliente: el saldo con su consumo desglosado por organismo y por concepto (AC1).
 *
 * Los desgloses se calculan del mismo libro que produce el saldo, así que cuadran por construcción:
 * saldo = entradas − salidas, y cada agrupación reparte esas mismas sumas por una dimensión distinta.
 */
export async function extractoDe(companiaId: number, periodo?: string): Promise<ExtractoCliente> {
  const [totales] = await db
    .select({
      entradas: sql<string>`coalesce(sum(case when ${flitoBolsaMovimientos.tipo} = 'entrada' then ${flitoBolsaMovimientos.valor} else 0 end), 0)`,
      salidas: sql<string>`coalesce(sum(case when ${flitoBolsaMovimientos.tipo} = 'salida' then ${flitoBolsaMovimientos.valor} else 0 end), 0)`,
    })
    .from(flitoBolsaMovimientos)
    .where(periodo
      ? and(eq(flitoBolsaMovimientos.companiaId, companiaId), eq(flitoBolsaMovimientos.periodo, periodo))
      : eq(flitoBolsaMovimientos.companiaId, companiaId));

  const [porOrganismo, porConcepto, bolsa] = await Promise.all([
    agrupar(companiaId, flitoBolsaMovimientos.organismoCodigo, periodo),
    agrupar(companiaId, flitoBolsaMovimientos.concepto, periodo),
    bolsaDe(companiaId),
  ]);

  return {
    companiaId,
    saldoActual: bolsa?.saldo ?? 0,
    totalEntradas: redondear(num(totales?.entradas ?? '0')),
    totalSalidas: redondear(num(totales?.salidas ?? '0')),
    porOrganismo,
    porConcepto,
  };
}

export interface LineaOrganismo {
  concepto: string;
  cobrado: number;
  movimientos: number;
}

export interface BolsaSimbolicaOrganismo {
  organismoCodigo: string;
  /** Lo cobrado a los clientes por cuenta de este organismo, desglosado por concepto. */
  porConcepto: LineaOrganismo[];
  totalCobrado: number;
  totalPagado: number;
  /** Lo que FLIT todavía le debe al organismo. Puede ser negativo si se le pagó de más. */
  saldoPendiente: number;
}

/**
 * Estado de cuenta de un organismo (AC2). NO tiene saldo real: es la diferencia entre lo que se
 * cobró a los clientes por su cuenta y lo que FLIT ya le pagó.
 *
 * Solo cuentan las SALIDAS: una entrada con organismo sería un contramovimiento de reverso, y
 * sumarla como «cobrado» inflaría la deuda con el organismo. Por eso se restan.
 */
export async function bolsaSimbolicaDe(organismoCodigo: string): Promise<BolsaSimbolicaOrganismo> {
  const [filas, pagos] = await Promise.all([
    db.select({
      concepto: flitoBolsaMovimientos.concepto,
      salidas: sql<string>`coalesce(sum(case when ${flitoBolsaMovimientos.tipo} = 'salida' then ${flitoBolsaMovimientos.valor} else -${flitoBolsaMovimientos.valor} end), 0)`,
      movimientos: sql<number>`count(*)::int`,
    })
      .from(flitoBolsaMovimientos)
      .where(eq(flitoBolsaMovimientos.organismoCodigo, organismoCodigo))
      .groupBy(flitoBolsaMovimientos.concepto),
    db.select({
      total: sql<string>`coalesce(sum(${flitoOrganismoPagos.valor}), 0)`,
    })
      .from(flitoOrganismoPagos)
      .where(eq(flitoOrganismoPagos.organismoCodigo, organismoCodigo)),
  ]);

  const porConcepto: LineaOrganismo[] = filas.map((f) => ({
    concepto: f.concepto ?? 'sin_concepto',
    cobrado: redondear(num(f.salidas)),
    movimientos: f.movimientos,
  }));
  const totalCobrado = redondear(porConcepto.reduce((a, l) => a + l.cobrado, 0));
  const totalPagado = redondear(num(pagos[0]?.total ?? '0'));

  return {
    organismoCodigo,
    porConcepto,
    totalCobrado,
    totalPagado,
    saldoPendiente: redondear(totalCobrado - totalPagado),
  };
}

export interface DatosPagoOrganismo {
  valor: number;
  fecha?: string;
  observacion?: string | null;
  soporte?: SoporteRecarga | null;
}

/**
 * Registra un pago de FLIT al organismo (AC3). Baja su pendiente y **no toca** la bolsa de ningún
 * cliente: es dinero de FLIT, no del saldo prepago.
 */
export async function registrarPagoOrganismo(
  organismoCodigo: string,
  datos: DatosPagoOrganismo,
  ctx: CtxUsuario,
): Promise<{ id: string; saldoPendiente: number }> {
  const valor = redondear(datos.valor);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new BolsaError('El valor del pago debe ser mayor que cero');
  }
  if (valor > TOPE_NUMERIC) throw new BolsaError('El valor del pago excede el máximo admitido');

  const fecha = parseFechaQuery(datos.fecha ?? hoyIso());
  if (fecha === null) throw new BolsaError('La fecha del pago no es válida');
  if (fecha > hoyIso()) throw new BolsaError('La fecha del pago no puede ser futura');

  const id = await db.transaction(async (tx) => {
    const soporteId = datos.soporte ? await insertarSoporte(tx, datos.soporte, ctx) : null;
    const [fila] = await tx.insert(flitoOrganismoPagos).values({
      organismoCodigo,
      valor: String(valor),
      fecha,
      observacion: datos.observacion?.trim() ? datos.observacion.trim() : null,
      soporteId,
      registradoPorId: ctx.userId,
      registradoPorNombre: ctx.nombre.slice(0, 150),
    }).returning({ id: flitoOrganismoPagos.id });
    return fila.id;
  });

  const { saldoPendiente } = await bolsaSimbolicaDe(organismoCodigo);
  return { id, saldoPendiente };
}

/** Saldo total prepago de todos los clientes. Lo consume el tablero de la HU #11127. */
export async function saldoConsolidado(): Promise<{ clientes: number; saldoTotal: number }> {
  const [fila] = await db
    .select({
      clientes: sql<number>`count(*)::int`,
      saldoTotal: sql<string>`coalesce(sum(${flitoBolsas.saldo}), 0)`,
    })
    .from(flitoBolsas);
  return { clientes: fila?.clientes ?? 0, saldoTotal: num(fila?.saldoTotal ?? '0') };
}
