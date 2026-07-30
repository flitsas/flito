// FLITO — bolsas prepago del cliente (HU #11121, Feature #11120 §2.1).
//
// Esta HU cubre el esquema y las ENTRADAS: la recarga que FLIT precarga en la bolsa del cliente.
// Las salidas automáticas cuelgan del sellado de la liquidación y llegan en la HU #11122; por eso
// `registrarMovimiento` ya recibe concepto, organismo, trámite y llave de idempotencia aunque una
// recarga no use ninguno.

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoBolsaMovimientos, flitoBolsas, flitoSoportes } from '../../db/schema.js';
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

  return db.transaction(async (tx) => {
    // Reenvío con la misma llave: se devuelve el movimiento original sin volver a mover el saldo.
    // Va ANTES del lock porque no necesita bloquear nada — si ya existe, no hay nada que escribir.
    if (datos.llaveIdempotencia) {
      const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
      if (previo) return { movimiento: previo, duplicado: true };
    }

    const bolsa = await bolsaBloqueada(tx, companiaId);
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
        periodo: periodoDeFecha(fecha),
        fecha,
        observacion: datos.observacion ?? null,
        soporteId,
        registradoPorId: ctx.userId,
        registradoPorNombre: ctx.nombre,
        llaveIdempotencia: datos.llaveIdempotencia ?? null,
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
  });
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
