// Contrato `ia-consumo` v1, regla 2 (ADR-0047) — escritor del registro de consumo de IA.
//
// Nunca bloquea ni rompe la llamada a la IA: `encolarConsumoIa` es síncrono, no lanza y no toca la BD. La
// cola vive en memoria, acotada a TOPE_COLA filas (llena ⇒ se descarta, se cuenta en
// `ia_consumo_descartados_total{motivo="cola_llena"}` y se avisa en el log como mucho una vez por minuto).
// Se vacía por lotes cada INTERVALO_MS o al llegar a LOTE_MAX filas, con un INSERT por tabla. Si la BD falla
// el lote se descarta (at-most-once, como ADR-0042 Q4), con un `warn` estructurado y la métrica `motivo="bd"`.
// El costo se calcula al vaciar (tarifas cacheadas, `costo.ts`), fuera del camino de la petición.
//
// `anotarConsumoIa(id, …)` corrige una fila ya encolada (p. ej. la respuesta llegó 200 pero el JSON no era
// interpretable, o la placa se supo después de leer el documento). Si la fila ya salió a la BD, se manda un
// UPDATE de mejor esfuerzo; si el lote estaba en vuelo, la corrección puede perderse.
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { iaConsumoDetalle, iaConsumoLog, iaTarifaModelo } from '../../db/schema/ia-consumo.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../logger.js';
import { iaConsumoDescartadosTotal, iaConsumoFlushTotal } from '../metrics.js';
import { calcularCostoIa, crearCacheTarifas, type TarifaIa } from './costo.js';

const log = loggerFor('ia-consumo');

export type FilaConsumoIa = typeof iaConsumoLog.$inferInsert;
export interface DetalleConsumoIa { promptTexto: string | null; respuestaTexto: string | null }
export type AnotacionConsumoIa = Partial<Pick<FilaConsumoIa,
  'placa' | 'resultado' | 'errorCodigo' | 'errorMensaje' | 'entidadTipo' | 'entidadId' | 'metadatos'>>;

export interface SumideroIa {
  insertar(filas: FilaConsumoIa[], detalles: Array<typeof iaConsumoDetalle.$inferInsert>): Promise<void>;
  actualizar(id: string, cambios: AnotacionConsumoIa): Promise<void>;
  cargarTarifas(): Promise<TarifaIa[]>;
}

export const TOPE_COLA = 10_000;
export const LOTE_MAX = 200;
export const INTERVALO_MS = 5_000;
export const TIMEOUT_LOTE_MS = 10_000;
export const TIMEOUT_CIERRE_MS = 3_000;
const AVISO_COLA_LLENA_MS = 60_000;

const sumideroBd: SumideroIa = {
  async insertar(filas, detalles) {
    await db.insert(iaConsumoLog).values(filas);
    if (detalles.length > 0) await db.insert(iaConsumoDetalle).values(detalles);
  },
  async actualizar(id, cambios) {
    await db.update(iaConsumoLog).set(cambios).where(eq(iaConsumoLog.id, id));
  },
  async cargarTarifas() {
    const filas = await db.select().from(iaTarifaModelo);
    return filas.map((t) => ({
      proveedor: t.proveedor,
      modelo: t.modelo,
      vigenteDesde: String(t.vigenteDesde),
      entrada: Number(t.precioEntradaMtok),
      salida: Number(t.precioSalidaMtok),
      cacheLectura: Number(t.precioCacheLecturaMtok),
      cacheEscritura: Number(t.precioCacheEscrituraMtok),
    }));
  },
};

interface Encolado { fila: FilaConsumoIa; detalle: DetalleConsumoIa | null }

let sumidero: SumideroIa = sumideroBd;
let tarifas = crearCacheTarifas(() => sumidero.cargarTarifas());
let cola: Encolado[] = [];
const pendientes = new Map<string, Encolado>();
let vaciadoEnCurso: Promise<void> | null = null;
let temporizador: ReturnType<typeof setInterval> | null = null;
let descartadosSinAviso = 0;
let ultimoAviso = -Infinity;

function medir(fn: () => void): void {
  try { fn(); } catch { /* una métrica nunca cuesta un registro */ }
}

/** Solo el código: el mensaje de la query lleva sus parámetros (prompts, placas). */
function codigoDeError(e: unknown): string {
  const err = e as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  return String(err?.cause?.code ?? err?.code ?? err?.name ?? 'desconocido');
}

function armarTemporizador(): void {
  if (temporizador) return;
  temporizador = setInterval(() => { void vaciarConsumoIa(); }, INTERVALO_MS);
  temporizador.unref();
}

/** Encola una fila (y su detalle, si la bandera lo permite). Síncrono, nunca lanza. */
export function encolarConsumoIa(fila: FilaConsumoIa, detalle: DetalleConsumoIa | null = null): void {
  try {
    if (!env.IA_CONSUMO_LOG) return;
    if (cola.length >= TOPE_COLA) {
      descartadosSinAviso++;
      medir(() => iaConsumoDescartadosTotal.inc({ motivo: 'cola_llena' }));
      const ahora = Date.now();
      if (ahora - ultimoAviso >= AVISO_COLA_LLENA_MS) {
        ultimoAviso = ahora;
        log.warn({ descartados: descartadosSinAviso, tope: TOPE_COLA }, 'ia-consumo: cola llena, registros descartados');
        descartadosSinAviso = 0;
      }
      return;
    }
    const e: Encolado = { fila, detalle: env.IA_CONSUMO_DETALLE ? detalle : null };
    cola.push(e);
    if (fila.id) pendientes.set(fila.id, e);
    armarTemporizador();
    if (cola.length >= LOTE_MAX) void vaciarConsumoIa();
  } catch { /* el registro nunca rompe la llamada */ }
}

/** Corrige una fila encolada o ya escrita. Nunca lanza ni se espera. */
export function anotarConsumoIa(id: string | null | undefined, cambios: AnotacionConsumoIa): void {
  try {
    if (!id || !env.IA_CONSUMO_LOG) return;
    const e = pendientes.get(id);
    if (e) { Object.assign(e.fila, cambios); return; }
    void sumidero.actualizar(id, cambios).catch((err) => {
      medir(() => log.warn({ err: codigoDeError(err) }, 'ia-consumo: no se pudo anotar un registro ya escrito'));
    });
  } catch { /* idem */ }
}

async function escribirLote(lote: Encolado[]): Promise<void> {
  let tope: ReturnType<typeof setTimeout> | undefined;
  try {
    const listaTarifas = await tarifas.obtener();
    const filas = lote.map(({ fila }) => ({
      ...fila,
      costoUsdEstimado: fila.costoUsdEstimado ?? calcularCostoIa(listaTarifas, {
        proveedor: fila.proveedor,
        modeloSolicitado: fila.modeloSolicitado,
        modeloRespondido: fila.modeloRespondido,
        fechaInicio: fila.fechaInicio,
        tokensEntrada: fila.tokensEntrada,
        tokensSalida: fila.tokensSalida,
        tokensCacheLectura: fila.tokensCacheLectura,
        tokensCacheEscritura: fila.tokensCacheEscritura,
      }),
    }));
    const detalles = lote
      .filter((e) => e.detalle && e.fila.id)
      .map((e) => ({ consumoId: e.fila.id!, fechaInicio: e.fila.fechaInicio, ...e.detalle! }));
    await Promise.race([
      sumidero.insertar(filas, detalles),
      new Promise((_, rechazar) => { tope = setTimeout(() => rechazar(new Error('timeout')), TIMEOUT_LOTE_MS); }),
    ]);
    medir(() => iaConsumoFlushTotal.inc({ resultado: 'ok' }));
  } catch (e) {
    medir(() => iaConsumoFlushTotal.inc({ resultado: 'error' }));
    medir(() => iaConsumoDescartadosTotal.inc({ motivo: 'bd' }, lote.length));
    medir(() => log.warn({ err: codigoDeError(e), filas: lote.length }, 'ia-consumo: lote no escrito; registros descartados'));
  } finally {
    clearTimeout(tope);
    for (const { fila } of lote) if (fila.id) pendientes.delete(fila.id);
  }
}

/** Vacía la cola por lotes. Nunca rechaza; un vaciado en curso se comparte. */
export function vaciarConsumoIa(): Promise<void> {
  if (vaciadoEnCurso) return vaciadoEnCurso;
  if (cola.length === 0) return Promise.resolve();
  vaciadoEnCurso = (async () => {
    while (cola.length > 0) {
      const lote = cola.slice(0, LOTE_MAX);
      cola = cola.slice(LOTE_MAX);
      await escribirLote(lote);
    }
  })().finally(() => { vaciadoEnCurso = null; });
  return vaciadoEnCurso;
}

/** Apagado: para el temporizador y vacía la cola con tope de TIMEOUT_CIERRE_MS. Nunca rechaza. */
export async function cerrarConsumoIa(topeMs = TIMEOUT_CIERRE_MS): Promise<void> {
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
  let tope: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      vaciarConsumoIa(),
      new Promise<void>((resolver) => { tope = setTimeout(resolver, topeMs); }),
    ]);
  } finally {
    clearTimeout(tope);
    if (cola.length > 0) medir(() => log.warn({ filas: cola.length }, 'ia-consumo: apagado con registros sin escribir'));
  }
}

/** Solo tests: sustituye la BD y vacía el estado del proceso. */
export function configurarSumideroIaParaTests(s: SumideroIa | null): void {
  sumidero = s ?? sumideroBd;
  tarifas = crearCacheTarifas(() => sumidero.cargarTarifas());
  cola = [];
  pendientes.clear();
  vaciadoEnCurso = null;
  if (temporizador) { clearInterval(temporizador); temporizador = null; }
  descartadosSinAviso = 0;
  ultimoAviso = -Infinity;
}

/** Solo tests y diagnóstico. */
export function tamanoColaIa(): number { return cola.length; }
