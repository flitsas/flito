// FLITO — núcleo del LIBRO ÚNICO de bolsas (HU #13899, Feature #13886, ADR-0029).
//
// Sale de `flito-bolsas.service.ts` (que estaba en su techo de max-lines) el asiento de movimientos,
// la imputación de periodo y las salidas/reversos de la liquidación, ahora sobre `flito_bolsas_unicas*`
// y por `bolsa_id`. `flito-bolsas.service.ts` re-exporta lo público para no tocar a sus importadores.
//
// Reglas que este archivo hace cumplir (HU #13899):
//   RN-A1 (D6) Nadie AUTOCREA una bolsa: el INSERT … ON CONFLICT DO NOTHING de la primera recarga murió.
//         Sin bolsa: recarga, movimiento manual y corrección → 409 `bolsa_inexistente`; liquidación y
//         conciliación simplemente no asientan (`asentarSiHayBolsa` → null).
//   RN-A2 (Q7) Bolsa INACTIVA: no recibe recargas, manuales, correcciones (409 `bolsa_inactiva`) ni
//         descuentos (no asienta). SÍ admite la devolución de sus propios movimientos (reverso de la
//         liquidación) y el cierre mensual.
//   RN-A3 (ADR-0006) Las llaves no cambian: `salida:soat:<soatId>` la comparten sellado, conciliación y
//         (HU-C) comprobante, y la garantía anti doble cobro la da el índice único de la llave.
//   RN-A4 Orden de locks: compañía antes que tránsito, en todas las rutas de escritura (sin deadlocks).
//   RN-A5 La llave se relee DENTRO del lock (READ COMMITTED ve lo que la otra tx acaba de confirmar):
//         dos escritores de la misma llave se serializan por el `FOR UPDATE` de la bolsa.
//   RN-CLI-9 (HU #13953, AC5) Cliente ELIMINADO (`clients.deleted_at`): su bolsa no admite recargas, manuales ni
//         correcciones (409 «El cliente fue eliminado; su bolsa no admite movimientos.»). Se mira ANTES que la
//         bolsa (manda el motivo más fuerte). Los reversos y lecturas históricas no pasan por aquí.

import { and, eq, getTableColumns, like } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoBolsasUnicas, flitoBolsasUnicasCierres, flitoBolsasUnicasMovimientos, flitoSoportes } from '../../db/schema.js';
import { aIso, parseFechaQuery, TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';
import {
  CodigoErrorBolsa,
  type ConceptoBolsa,
  type MovimientoBolsaDto,
  type OrigenMovimientoBolsa,
  periodoDe,
  type TipoMovimientoBolsa,
} from '@operaciones/shared-types';

/** Error de negocio: lo traduce la capa HTTP a 4xx (con `codigo` si lo trae), no al error handler. */
export class BolsaError extends Error {
  constructor(message: string, readonly estado: number = 400, readonly codigo?: string) {
    super(message);
    this.name = 'BolsaError';
  }
}

/** Transacción drizzle o el `db` raíz: ambos exponen select/insert/update. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Se consulta indistintamente dentro de una transacción o fuera de ella. */
export type DbOrTx = typeof db | Tx;

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

/** Lo que necesita un movimiento para asentarse en el libro. */
export interface DatosMovimiento {
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
  /** HU #13902: comprobante que originó el descuento (o cuya salida se revierte). */
  comprobanteId?: string | null;
  /** HU #13902 (D13): salida que esta entrada revierte; el índice único parcial impide revertir dos veces. */
  revierteMovimientoId?: string | null;
  /** Sustantivo para los mensajes de error: 'recarga', 'salida', 'ajuste'… */
  etiqueta?: string;
  /** Tipo en `flito_soportes` (HU #13906: tránsito usa 'carga_organismo'). Por defecto 'recarga_bolsa'. */
  tipoSoporte?: string;
  /** HU #13906: acota el INSERT con un SAVEPOINT (tránsito, Bug #11685 punto 3) para que la relectura tras un 23505 pueda correr. */
  savepoint?: boolean;
}

/** Bolsa bloqueada lista para asentar. */
export interface BolsaEnLibro { id: string; saldo: number; companiaId: number | null; activa: boolean }

const DOS_DECIMALES = 100;
/** Techo de `numeric(14,2)`: 12 dígitos enteros. Compartido con el libro de tránsito (HU #11161). */
export const TOPE_NUMERIC = 999_999_999_999.99;

/** Redondea a pesos con dos decimales: numeric(14,2) no admite más y el flotante arrastra ruido. */
export function redondear(n: number): number {
  return Math.round(n * DOS_DECIMALES) / DOS_DECIMALES;
}

export function num(v: string | null): number {
  return v === null ? 0 : Number(v);
}

/** Hoy en Colombia, no en UTC: a las 8 p.m. de Bogotá ya es mañana en UTC y el periodo saldría corrido. */
export function hoyIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_COLOMBIA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Periodo contable de una fecha 'YYYY-MM-DD' ya validada, sin pasar por el huso local. */
export function periodoDeFecha(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return periodoDe(new Date(Date.UTC(y, m - 1, d)));
}

/** Periodo contable siguiente a 'YYYY-MM'. */
export function periodoSiguiente(periodo: string): string {
  const [anio, mes] = periodo.split('-').map(Number);
  return mes === 12 ? `${anio + 1}-01` : `${anio}-${String(mes + 1).padStart(2, '0')}`;
}

/**
 * Violación de unicidad de Postgres. HU #13907: drizzle envuelve el error del driver en un `DrizzleQueryError`
 * («Failed query: …») con el `PostgresError` en `cause`; se mira el error y su causa.
 */
export function esLlaveDuplicada(e: unknown): boolean {
  const codigo = (x: unknown) => (typeof x === 'object' && x !== null ? (x as { code?: string }).code : undefined);
  return codigo(e) === '23505' || (typeof e === 'object' && e !== null && codigo((e as { cause?: unknown }).cause) === '23505');
}

// ─────────────────────────── Bolsa ───────────────────────────────────────────

export const MSG_BOLSA_INEXISTENTE = 'Crea la bolsa de la compañía primero';
export const MSG_BOLSA_INACTIVA = 'Reactiva la bolsa primero';

const COLUMNAS_BOLSA = {
  id: flitoBolsasUnicas.id,
  saldo: flitoBolsasUnicas.saldo,
  companiaId: flitoBolsasUnicas.companiaId,
  activa: flitoBolsasUnicas.activa,
};

function aBolsa(f: { id: string; saldo: string; companiaId: number | null; activa: boolean }): BolsaEnLibro {
  return { id: f.id, saldo: num(f.saldo), companiaId: f.companiaId, activa: f.activa };
}

/** Condición «la bolsa de alcance compañía de C» (la unicidad la da el índice parcial). */
export function deCompania(companiaId: number) {
  return and(eq(flitoBolsasUnicas.alcance, 'compania'), eq(flitoBolsasUnicas.companiaId, companiaId))!;
}

/**
 * Bolsa de la compañía con la fila BLOQUEADA (`FOR UPDATE`), o `undefined` si no tiene. NO la crea
 * (RN-A1). El lock es lo que hace correcto el saldo denormalizado.
 */
export async function bolsaCompaniaBloqueada(tx: Tx, companiaId: number): Promise<BolsaEnLibro | undefined> {
  const [fila] = await tx.select(COLUMNAS_BOLSA).from(flitoBolsasUnicas)
    .where(deCompania(companiaId)).for('update').limit(1);
  return fila ? aBolsa(fila) : undefined;
}

/** Bolsa por id, bloqueada. */
export async function bolsaBloqueadaPorId(tx: Tx, bolsaId: string): Promise<BolsaEnLibro | undefined> {
  const [fila] = await tx.select(COLUMNAS_BOLSA).from(flitoBolsasUnicas)
    .where(eq(flitoBolsasUnicas.id, bolsaId)).for('update').limit(1);
  return fila ? aBolsa(fila) : undefined;
}

/** La bolsa existe y está activa, o 409 con el código del contrato (D6/Q7). */
export function exigirActiva(bolsa: BolsaEnLibro | undefined): BolsaEnLibro {
  if (!bolsa) throw new BolsaError(MSG_BOLSA_INEXISTENTE, 409, CodigoErrorBolsa.BOLSA_INEXISTENTE);
  if (!bolsa.activa) throw new BolsaError(MSG_BOLSA_INACTIVA, 409, CodigoErrorBolsa.BOLSA_INACTIVA);
  return bolsa;
}

/** RN-CLI-9 (HU #13953, AC5): texto del 409 de un movimiento sobre la bolsa de un cliente eliminado. */
export const MSG_CLIENTE_ELIMINADO_BOLSA = 'El cliente fue eliminado; su bolsa no admite movimientos.';

/**
 * RN-CLI-9: 409 si el cliente está eliminado. `bloquear` toma `FOR SHARE` (solo dentro de la tx del asiento), igual
 * que RN-CLI-6: la baja lógica y el movimiento no se cruzan. Cliente inexistente → no decide (lo hace la bolsa).
 */
export async function exigirClienteNoEliminado(tx: DbOrTx, companiaId: number, bloquear = false): Promise<void> {
  const consulta = tx.select({ deletedAt: clients.deletedAt }).from(clients).where(eq(clients.id, companiaId)).limit(1);
  const [cliente] = bloquear ? await consulta.for('share') : await consulta;
  // `!= null`: los dobles de prueba que devuelven una fila sin la clave no se leen como eliminados.
  if (cliente?.deletedAt != null) throw new BolsaError(MSG_CLIENTE_ELIMINADO_BOLSA, 409);
}

/** Fuera de transacción: 409 si la compañía no tiene bolsa o está inactiva. Para validar antes de subir/escribir. */
export async function exigirBolsaActivaDe(tx: DbOrTx, companiaId: number): Promise<BolsaEnLibro> {
  await exigirClienteNoEliminado(tx, companiaId);
  const [fila] = await tx.select(COLUMNAS_BOLSA).from(flitoBolsasUnicas).where(deCompania(companiaId)).limit(1);
  return exigirActiva(fila ? aBolsa(fila) : undefined);
}

// ─────────────────────────── Movimientos ────────────────────────────────────

export function aMovimientoDto(
  m: typeof flitoBolsasUnicasMovimientos.$inferSelect,
  companiaId: number | null,
  idFlit: string | null = null,
): MovimientoBolsaDto {
  return {
    id: m.id,
    bolsaId: m.bolsaId,
    companiaId,
    tipo: m.tipo as TipoMovimientoBolsa,
    origen: m.origen as OrigenMovimientoBolsa,
    concepto: m.concepto === null ? null : (m.concepto as ConceptoBolsa),
    organismoCodigo: m.organismoCodigo,
    tramiteId: m.tramiteId,
    comprobanteId: m.comprobanteId,
    revierteMovimientoId: m.revierteMovimientoId,
    idFlit,
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

/** Movimiento ya asentado con esa llave (en cualquier bolsa: el índice es de tabla entera), o `undefined`. */
export async function movimientoPorLlave(tx: DbOrTx, llave: string): Promise<MovimientoBolsaDto | undefined> {
  const [fila] = await tx
    // Plano (columnas del movimiento + compañía de la bolsa): la misma forma que la fila del libro viejo.
    .select({ ...getTableColumns(flitoBolsasUnicasMovimientos), companiaId: flitoBolsasUnicas.companiaId })
    .from(flitoBolsasUnicasMovimientos)
    .innerJoin(flitoBolsasUnicas, eq(flitoBolsasUnicasMovimientos.bolsaId, flitoBolsasUnicas.id))
    .where(eq(flitoBolsasUnicasMovimientos.llaveIdempotencia, llave))
    .limit(1);
  return fila ? aMovimientoDto(fila, fila.companiaId) : undefined;
}

/**
 * Registra el comprobante ya subido al almacenamiento. Trunca a lo que aguantan las columnas: un
 * nombre largo no puede tumbar una recarga con un 22001 después de haber subido el archivo.
 */
export async function insertarSoporte(
  tx: Tx, soporte: SoporteRecarga, ctx: CtxUsuario, tipo: string = 'recarga_bolsa',
): Promise<string> {
  const [s] = await tx.insert(flitoSoportes).values({
    tipo,
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

/** Comprueba y normaliza lo que no depende de la base: valor redondeado y fecha contable. */
export function validarMovimiento(datos: DatosMovimiento): { valor: number; fecha: string } {
  const etiqueta = datos.etiqueta ?? 'movimiento';
  const valor = redondear(datos.valor);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new BolsaError(`El valor de la ${etiqueta} debe ser mayor que cero`);
  }
  // Pasarse del tope no es negocio sino un 22003 de Postgres, que llegaría como 500.
  if (valor > TOPE_NUMERIC) throw new BolsaError(`El valor de la ${etiqueta} excede el máximo admitido`);
  // Un '2026-02-31' pasa el regex de la ruta pero no es un día real.
  const fecha = parseFechaQuery(datos.fecha);
  if (fecha === null) throw new BolsaError('La fecha del movimiento no es válida');
  // Nadie recarga mañana; la retroactividad sí se permite (los soportes llegan tarde).
  if (fecha > hoyIso()) throw new BolsaError('La fecha del movimiento no puede ser futura');
  return { valor, fecha };
}

/**
 * Traduce un `23505` de la llave en el movimiento que sí quedó asentado, o `null`. Es la red de DEBAJO
 * de la relectura bajo el lock (RN-A5): solo se llega si la llave colisiona entre bolsas distintas
 * (conciliación y liquidación derivan la compañía de fuentes que pueden divergir, Bug #11685). La
 * relectura va en su propio `try`: sin savepoint, la tx ya está abortada (`25P02`) y debe subir el
 * `23505` original, que dice la verdad.
 */
async function reintentoPorLlave(tx: Tx, e: unknown, llave: string | null | undefined): Promise<MovimientoBolsaDto | null> {
  if (!esLlaveDuplicada(e) || !llave) return null;
  try {
    return (await movimientoPorLlave(tx, llave)) ?? null;
  } catch {
    return null;
  }
}

/** Periodos ya cerrados de una bolsa. */
export async function periodosCerrados(tx: DbOrTx, bolsaId: string): Promise<Set<string>> {
  const filas = await tx.select({ periodo: flitoBolsasUnicasCierres.periodo })
    .from(flitoBolsasUnicasCierres).where(eq(flitoBolsasUnicasCierres.bolsaId, bolsaId));
  return new Set(filas.map((f) => f.periodo));
}

/**
 * Periodo al que se IMPUTA un movimiento cuya fecha cae en `periodoNatural`: si está cerrado se corre al
 * primero abierto (el reporte de cierre ya se firmó, HU #11126 AC3), nunca a uno futuro. La fecha real
 * se conserva, así que el rezago queda visible comparando `fecha` con `periodo`.
 */
export async function periodoImputable(tx: DbOrTx, bolsaId: string, periodoNatural: string): Promise<string> {
  const cerrados = await periodosCerrados(tx, bolsaId);
  if (!cerrados.has(periodoNatural)) return periodoNatural;
  const tope = periodoDeFecha(hoyIso());
  let p = periodoNatural;
  while (cerrados.has(p) && p < tope) p = periodoSiguiente(p);
  return p;
}

/**
 * El cuerpo del asiento sobre una bolsa YA bloqueada y una transacción YA abierta (la del sellado, la
 * de la conciliación…: si esa se deshace, el movimiento se deshace con ella). No valida saldo: una
 * salida puede dejar la bolsa en negativo (D11). No mira `activa`: eso lo decide quien llama (RN-A2).
 */
export async function asentarEnBolsa(
  tx: Tx, bolsa: BolsaEnLibro, datos: DatosMovimiento, ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; duplicado: boolean }> {
  const { valor, fecha } = validarMovimiento(datos);
  // RN-A5: relectura de la llave DENTRO del lock.
  if (datos.llaveIdempotencia) {
    const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
    if (previo) return { movimiento: previo, duplicado: true };
  }

  const periodo = await periodoImputable(tx, bolsa.id, periodoDeFecha(fecha));
  const saldoResultante = redondear(bolsa.saldo + (datos.tipo === 'entrada' ? valor : -valor));
  // El comprobante se registra DENTRO de la tx del dinero: sin movimiento no queda soporte huérfano.
  const soporteId = datos.soporte ? await insertarSoporte(tx, datos.soporte, ctx, datos.tipoSoporte) : null;

  let fila: typeof flitoBolsasUnicasMovimientos.$inferSelect;
  try {
    const insertar = (q: Tx) => q.insert(flitoBolsasUnicasMovimientos).values({
      bolsaId: bolsa.id,
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
      comprobanteId: datos.comprobanteId ?? null,
      revierteMovimientoId: datos.revierteMovimientoId ?? null,
    }).returning();
    [fila] = datos.savepoint ? await tx.transaction((sp) => insertar(sp)) : await insertar(tx);
  } catch (e) {
    const previo = await reintentoPorLlave(tx, e, datos.llaveIdempotencia);
    if (!previo) throw e;
    return { movimiento: previo, duplicado: true };
  }

  // La última recarga solo la mueven las recargas: es la base del nivel de riesgo (HU #11125).
  const esRecarga = datos.origen === 'recarga';
  await tx.update(flitoBolsasUnicas).set({
    saldo: String(saldoResultante),
    updatedAt: new Date(),
    ...(esRecarga ? { ultimaEntradaValor: String(valor), ultimaEntradaEn: new Date() } : {}),
  }).where(eq(flitoBolsasUnicas.id, bolsa.id));
  bolsa.saldo = saldoResultante;

  return { movimiento: aMovimientoDto(fila, bolsa.companiaId), duplicado: false };
}

/**
 * Asiento sobre la bolsa de la compañía EXIGIENDO que exista y esté activa (recarga, manual,
 * corrección): 409 `bolsa_inexistente` / `bolsa_inactiva` (RN-A1, RN-A2). El reenvío con la misma llave
 * devuelve el original ANTES del lock: si ya existe, no hay nada que escribir.
 */
export async function asentarMovimiento(
  tx: Tx, companiaId: number, datos: DatosMovimiento, ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; duplicado: boolean }> {
  validarMovimiento(datos);
  if (datos.llaveIdempotencia) {
    const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
    if (previo) return { movimiento: previo, duplicado: true };
  }
  await exigirClienteNoEliminado(tx, companiaId, true);
  const bolsa = exigirActiva(await bolsaCompaniaBloqueada(tx, companiaId));
  return asentarEnBolsa(tx, bolsa, datos, ctx);
}

/**
 * Asiento de un DESCUENTO (liquidación, conciliación): sin bolsa o con la bolsa inactiva no asienta y
 * devuelve `null`, sin error (D6/D10/Q7). Una llave ya ocupada se devuelve como duplicado aunque la
 * bolsa ya no esté activa: es la adopción de ADR-0006, no dinero nuevo.
 */
export async function asentarSiHayBolsa(
  tx: Tx, companiaId: number, datos: DatosMovimiento, ctx: CtxUsuario,
): Promise<{ movimiento: MovimientoBolsaDto; duplicado: boolean } | null> {
  validarMovimiento(datos);
  if (datos.llaveIdempotencia) {
    const previo = await movimientoPorLlave(tx, datos.llaveIdempotencia);
    if (previo) return { movimiento: previo, duplicado: true };
  }
  const bolsa = await bolsaCompaniaBloqueada(tx, companiaId);
  if (!bolsa || !bolsa.activa) return null;
  return asentarEnBolsa(tx, bolsa, datos, ctx);
}

// ─────────────── Salidas automáticas del sellado de la liquidación (HU #11122) ───────────────

/** Un concepto liquidado que consume bolsa. */
export interface SalidaConcepto {
  concepto: ConceptoBolsa;
  valor: number;
  /** `null` en trámite digital y logística: son honorarios de FLIT, sin organismo natural. */
  organismoCodigo: string | null;
  /** Llave SIN prefijo de familia: el SOAT se cobra una vez por vehículo, el derecho una por trámite. */
  llave: string;
}

export interface DatosSalidasLiquidacion {
  companiaId: number;
  tramiteId: string;
  /** Fecha contable del descuento; normalmente el día del sellado. */
  fecha: string;
  conceptos: SalidaConcepto[];
}

export const PREFIJO_SALIDA = 'salida:';
/**
 * Prefijo de la llave de una salida cuya liquidación se reversa: libera la llave original —volver a
 * liquidar vuelve a cobrar— sin perder cuál fue. Es lo único que se reescribe de una fila del libro.
 */
export const PREFIJO_REVERSADO = 'rev:';

/**
 * Llave con que queda un movimiento reversado. HU #13969: lleva el id del movimiento para ser única por
 * movimiento — la llave viva (`salida:comprobante:<id>`, `salida:soat:<id>`, `consumo:…`) se reutiliza al
 * volver a aplicar/liquidar, y con solo `rev:<llave>` la segunda reversión chocaba con el índice único
 * parcial de la llave (23505). Sigue empezando por `rev:`, así que ninguna búsqueda de lo vivo
 * (`salida:%` / `consumo:%`) la ve. Los `rev:<llave>` ya existentes no se migran.
 */
export function llaveReversada(movimientoId: string | number, llave: string | null): string {
  // Las salidas que se reversan siempre tienen llave (se filtran por `salida:%` / `consumo:%`); `null` es tipado.
  if (llave === null) return `${PREFIJO_REVERSADO}${movimientoId}`.slice(0, 200);
  return `${PREFIJO_REVERSADO}${movimientoId}:${llave}`.slice(0, 200);
}

/**
 * Una salida por concepto liquidado, dentro de la tx del sellado. NO valida saldo (AC3 de #11122).
 * HU #13899 (AC6): sin bolsa o con la bolsa inactiva el sellado sigue y NO se crea bolsa ni movimiento.
 */
export async function registrarSalidasLiquidacion(
  tx: Tx, datos: DatosSalidasLiquidacion, ctx: CtxUsuario,
): Promise<MovimientoBolsaDto[]> {
  const asentados: MovimientoBolsaDto[] = [];
  // En serie: cada asiento lee el saldo que dejó el anterior.
  for (const c of datos.conceptos) {
    const r = await asentarSiHayBolsa(tx, datos.companiaId, {
      tipo: 'salida',
      origen: 'automatico',
      valor: c.valor,
      fecha: datos.fecha,
      concepto: c.concepto,
      organismoCodigo: c.organismoCodigo,
      tramiteId: datos.tramiteId,
      llaveIdempotencia: `${PREFIJO_SALIDA}${c.llave}`,
      etiqueta: 'salida',
    }, ctx);
    // Duplicado = reintento del sellado o concepto que otro trámite del vehículo ya pagó.
    if (r && !r.duplicado) asentados.push(r.movimiento);
  }
  return asentados;
}

/**
 * Deshace las salidas vivas de un trámite con CONTRAMOVIMIENTOS (append-only), en la tx del reverso.
 * Solo alcanza a las que conservan su llave sin prefijar: reversar dos veces no acredita dos veces.
 * Se permite aunque la bolsa esté inactiva (RN-A2: devolver lo que se le cobró).
 */
export async function reversarSalidasLiquidacion(
  tx: Tx, tramiteId: string, ctx: CtxUsuario,
): Promise<MovimientoBolsaDto[]> {
  const salidas = await tx.select().from(flitoBolsasUnicasMovimientos).where(and(
    eq(flitoBolsasUnicasMovimientos.tramiteId, tramiteId),
    eq(flitoBolsasUnicasMovimientos.origen, 'automatico'),
    eq(flitoBolsasUnicasMovimientos.tipo, 'salida'),
    like(flitoBolsasUnicasMovimientos.llaveIdempotencia, `${PREFIJO_SALIDA}%`),
  ));

  const contras: MovimientoBolsaDto[] = [];
  for (const s of salidas) {
    const bolsa = await bolsaBloqueadaPorId(tx, s.bolsaId);
    if (!bolsa) continue; // imposible por la FK; se deja por tipado
    const { movimiento } = await asentarEnBolsa(tx, bolsa, {
      tipo: 'entrada',
      origen: 'automatico',
      valor: num(s.valor),
      fecha: hoyIso(),
      concepto: s.concepto === null ? null : (s.concepto as ConceptoBolsa),
      organismoCodigo: s.organismoCodigo,
      tramiteId: s.tramiteId,
      observacion: `Reverso de la liquidación: devuelve la salida de ${s.concepto ?? 'concepto'}`,
      // Llave propia por movimiento revertido: dos reversos seguidos no acreditan dos veces.
      llaveIdempotencia: `contra:${s.id}`,
      etiqueta: 'devolución',
    }, ctx);
    contras.push(movimiento);
    await tx.update(flitoBolsasUnicasMovimientos)
      .set({ llaveIdempotencia: llaveReversada(s.id, s.llaveIdempotencia) })
      .where(eq(flitoBolsasUnicasMovimientos.id, s.id));
  }
  return contras;
}
