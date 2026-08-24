// FLITO comparendos — instrumento de medición del coste del export (HU #11558, HU #11651).
//
// Vive aquí y no dentro de un `.test.ts` desde la HU #11651: la medición dejó de ser un solo
// escenario. El coste de UN export (secuencial) y el de DOS SIMULTÁNEOS son dos preguntas distintas
// y tienen que medirse en procesos distintos —Vitest aísla por archivo—, porque el RSS no se
// devuelve: un proceso que ya construyó un workbook de 5 000 filas arranca el siguiente escenario
// con las arenas del allocator calientes y el delta sale optimista. Un helper compartido es lo que
// permite tener dos archivos de test midiendo lo mismo sin copiar el instrumento.
//
// Qué mide y qué NO. Mide la construcción del workbook en el proceso —que es donde está el riesgo de
// memoria: `sendExcel` hace `workbook.xlsx.write(res)` con el libro ENTERO en el heap— con filas
// sintéticas de la forma real. **No** mide la consulta contra una tabla poblada: eso necesita
// PostgreSQL con volumen (ver AC5 de la HU #11651, declarado SIN-ENTORNO).

import { PassThrough } from 'node:stream';
import type { Response } from 'express';
import { sendExcel } from '../../src/shared/utils/excel.js';
import { COLUMNAS_EXPORT } from '../../src/modules/flito-comparendos/flito-comparendos.export.service.js';
import { COMPARENDOS_OBSERVACION_MAX } from '@operaciones/shared-types';

/** Techo de PM2 (`max_memory_restart`, `ecosystem.config.cjs:22`) en MB. La referencia de todo esto. */
export const TECHO_PM2_MB = 512;

/**
 * Lo que ocupa el proceso del API **antes** de que nadie exporte, en MB.
 *
 * Es el extremo PESIMISTA del rango que la HU #11651 cita del PR #153 (~150-250 MB en régimen). Se
 * toma el peor de los dos a propósito: el presupuesto que sale de aquí es lo único que separa un
 * export legítimo de un `max_memory_restart`, y calcularlo con el extremo optimista sería regalarse
 * 100 MB de margen que en la máquina de producción puede no haber.
 */
export const REGIMEN_API_MB = 250;

/**
 * Cuánta memoria puede AÑADIR la generación de exports sin que PM2 reinicie el proceso.
 *
 * 512 − 250 = 262 MB. Es el número contra el que se lee cada medición de este módulo, y la razón de
 * que las aserciones se hagan sobre el DELTA y no sobre el pico absoluto: el RSS de partida de un
 * worker de Vitest (que carga media API y varía entre archivos) no es el del API en producción, pero
 * lo que la ruta AÑADE sí es comparable.
 */
export const PRESUPUESTO_MB = TECHO_PM2_MB - REGIMEN_API_MB;

export interface Medicion {
  /** Cuántos exports se generaron a la vez en esta medición. */
  simultaneos: number;
  ms: number;
  rssReposoMB: number;
  rssPicoMB: number;
  rssDeltaMB: number;
  heapPicoMB: number;
  /** Bytes de cada archivo generado. Uno por export: los dos tienen que salir enteros. */
  bytesPorExport: number[];
  lagMaxMs: number;
  /** Cuántas veces le tocó el turno a la sonda mientras se generaban los exports. */
  turnos: number;
  /**
   * Qué porcentaje de los turnos que le TOCABAN llegó a recibir la sonda (0 a 1).
   *
   * Es la parte del AC3 de la HU #11651 que el lag máximo no demuestra por sí solo: «ninguna
   * petición en vuelo del resto del sistema se pierde». La sonda es una petición cualquiera del API
   * pidiendo el hilo cada 20 ms; si la generación lo monopolizara, esta fracción se desplomaría.
   *
   * Se publica como FRACCIÓN y no como el contador crudo por una razón que costó un test en rojo:
   * `turnos` crece con la duración de la medición, así que un umbral fijo sobre él afirma cosas
   * distintas según lo que tarde el export —y con el tope en 2 000 el export es tan rápido que el
   * contador no llega ni a diez—. La fracción no depende de la duración y significa siempre lo
   * mismo. Medido: entre 0,26 y 0,41 en condiciones normales; 0,05 con `sendExcel` mutado para
   * bloquear el hilo seis segundos.
   */
  atencion: number;
}

export const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Una fila del archivo tal como la deja `construirFilasExport`: **todas** las columnas de
 * `COLUMNAS_EXPORT`, el monto ya numérico y los instantes ya formateados.
 *
 * Se genera con textos DISTINTOS por fila a propósito: `exceljs` guarda las cadenas en una tabla
 * compartida, así que 5 000 filas idénticas comprimirían como una y la medición saldría optimista.
 *
 * **El número de columnas no se escribe aquí como literal y hay motivo** (corregido en la HU
 * #11651): la versión original de este generador producía 19 claves y decía «19 columnas» en un
 * comentario; la HU #11712 añadió `tipoRegistro` y `numeroResolucion` al archivo y nadie tocó la
 * medición, que desde entonces medía un archivo más estrecho que el real. `columnasFaltantes()`
 * existe para que ese desfase vuelva a ser un test en rojo y no un comentario que miente.
 */
export function fila(i: number, observacion: string | null): Record<string, unknown> {
  return {
    numeroComparendo: `0500100000001${String(i).padStart(7, '0')}`,
    tipoRegistro: i % 5 === 0 ? 'Resolución' : 'Comparendo',
    numeroResolucion: i % 5 === 0 ? `RES-2026-${String(i).padStart(6, '0')}` : null,
    placa: `AB${String(i % 1000).padStart(4, '0')}`,
    nitMonitoreado: `9001${String(i % 100000).padStart(5, '0')}`,
    fechaComparendo: '2026-06-02',
    codigoInfraccion: 'C29',
    descripcionInfraccion: `Estacionar en sitio prohibido o en zona de cargue ${i}`,
    municipioFuente: 'BELLO',
    organismo: `Secretaría de Movilidad de Bello ${i}`,
    monto: 604100 + i,
    estado: i % 7 === 0 ? 'Inactivo' : 'Activo',
    estadoFuente: 'PENDIENTE',
    origenMerge: 'Ambos',
    causal: 'Acuerdo de pago',
    observacion,
    gestionActualizadaEn: '2026-08-19 09:00',
    gestionActualizadaPor: 42,
    primeraVistoEn: '2026-08-12 04:00',
    ultimoVistoEn: '2026-08-19 09:00',
    inactivadoEn: null,
  };
}

/**
 * Las columnas del archivo real que este generador NO produce.
 *
 * Vacío = la medición mide el archivo entero. No vacío = alguien añadió una columna al export y la
 * medición se quedó corta, que es exactamente lo que pasó entre la HU #11712 y la HU #11651.
 */
export function columnasFaltantes(): string[] {
  const generada = fila(0, null);
  return COLUMNAS_EXPORT.map((c) => c.key).filter((k) => !(k in generada));
}

/**
 * Observación del tamaño máximo, con prosa en vez de un carácter repetido.
 *
 * `'x'.repeat(1000)` mediría mal el ARCHIVO: el deflate del `.xlsx` lo aplasta a casi nada y la
 * medición diría que el peor caso pesa lo mismo que el realista. Con palabras rotadas por fila la
 * compresión se parece a la de un texto de verdad, que es lo que va a haber en esa columna.
 */
export function observacionLarga(i: number): string {
  const palabras = [
    'acuerdo', 'pago', 'propietario', 'cuota', 'resolución', 'notificación', 'recurso', 'descargo',
    'audiencia', 'inspección', 'comparendo', 'organismo', 'traslado', 'prescripción', 'abogado',
  ];
  let texto = '';
  for (let n = 0; texto.length < COMPARENDOS_OBSERVACION_MAX - 12; n++) {
    texto += `${palabras[(i + n) % palabras.length]} ${(i * 7 + n) % 9973} `;
  }
  return texto.slice(0, COMPARENDOS_OBSERVACION_MAX);
}

/** Las filas del caso REALISTA: la observación casi siempre corta o ausente, que es lo que hay hoy. */
export function filasRealistas(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => fila(
    i,
    i % 4 === 0 ? `Acuerdo de pago con el propietario, cuota ${i} del mes entrante` : null,
  ));
}

/**
 * Las filas del PEOR caso: la observación al máximo en todas.
 *
 * No es un escenario de laboratorio: la columna admite ese texto y nada impide que una operación lo
 * llene. Es el archivo más grande que este endpoint puede producir con un tope dado.
 */
export function filasPeorCaso(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => fila(i, observacionLarga(i)));
}

/**
 * Respuesta simulada: un stream que cuenta bytes y los tira.
 *
 * Consumirlos importa. Un sumidero que no drenara acumularía el archivo entero en el buffer del
 * stream y la medición estaría midiendo el test, no `sendExcel`; el `res` de verdad es un socket que
 * drena a medida que el cliente descarga.
 */
function sumidero(): { res: Response; bytes: () => number } {
  const stream = new PassThrough();
  let total = 0;
  stream.on('data', (chunk: Buffer) => { total += chunk.length; });
  const res = stream as unknown as Response & { setHeader: (k: string, v: string) => void };
  res.setHeader = () => undefined as never;
  return { res: res as Response, bytes: () => total };
}

/**
 * Genera `lotes.length` exports **a la vez** y mide lo que le cuesta al proceso.
 *
 * Un lote = un export = un `sendExcel` con su propio sumidero. Con un solo lote esto mide el coste
 * de un export aislado; con dos, el escenario del defecto de la HU #11651: `exportLimiter` es
 * `max: 5` por minuto **por usuario** (`keyGenerator: userOrIpKey(…)`), así que dos administradores
 * distintos lanzan dos exports simultáneos y el limitador deja pasar a los dos. No hay ninguna cota
 * global —ni semáforo— entre ellos: los dos workbooks coexisten en el heap del mismo proceso.
 *
 * Los `Promise.all` se lanzan sin `await` entre medias a propósito: encadenarlos daría dos exports
 * SECUENCIALES sobre un proceso caliente, que es justo lo que la medición de la HU #11558 ya hacía
 * y lo que el AC3 dice que no basta.
 *
 * **Cuánto cambia eso el número, medido y no supuesto** (A/B en procesos frescos, peor caso,
 * 2026-08-22): con dos exports de 5 000 filas, simultáneos cuestan 246 MB de RSS y encadenados 198
 * MB; con dos de 2 000, 105 y 95 MB. O sea que solapar cuesta un 24 % más, pero **el grueso del
 * coste no es el solapamiento**: es que el RSS no vuelve al sistema operativo entre un export y el
 * siguiente. Esto tiene una consecuencia que conviene no perder — un semáforo que serializara la
 * generación (una de las salidas retiradas del alcance de la HU #11651) habría recuperado esos 48 MB
 * y ninguno más: con el tope en 5 000 el proceso seguiría en 198 MB de los 262 de presupuesto. Lo
 * que baja el pico de verdad es no tener el libro entero en memoria (`WorkbookWriter`), o tener
 * menos filas.
 */
export async function medirExports(lotes: Record<string, unknown>[][]): Promise<Medicion> {
  const sumideros = lotes.map(() => sumidero());

  const rssReposo = process.memoryUsage().rss;
  let rssPico = rssReposo;
  let heapPico = process.memoryUsage().heapUsed;
  let lagMax = 0;

  // Sonda del event loop: un `setInterval` de 20 ms cuyo retraso REAL se mide. Es la forma barata de
  // ver si la compresión del ZIP —trabajo síncrono en el mismo hilo que atiende al resto del API—
  // deja de dar paso a nadie durante la generación. Con dos exports a la vez el dato importa el
  // doble: el AC3 pide que «ninguna petición en vuelo del resto del sistema se pierda».
  const PERIODO = 20;
  let ultimo = performance.now();
  let turnos = 0;
  const sonda = setInterval(() => {
    const ahora = performance.now();
    lagMax = Math.max(lagMax, ahora - ultimo - PERIODO);
    ultimo = ahora;
    turnos++;
    const uso = process.memoryUsage();
    rssPico = Math.max(rssPico, uso.rss);
    heapPico = Math.max(heapPico, uso.heapUsed);
  }, PERIODO);

  const t0 = performance.now();
  await Promise.all(lotes.map((filas, i) => sendExcel(
    sumideros[i]!.res,
    `medicion-${i}.xlsx`,
    COLUMNAS_EXPORT,
    filas,
  )));
  const ms = Math.round(performance.now() - t0);

  clearInterval(sonda);
  const uso = process.memoryUsage();
  rssPico = Math.max(rssPico, uso.rss);
  heapPico = Math.max(heapPico, uso.heapUsed);

  // Turnos que le habrían tocado a la sonda si nadie le hubiera quitado el hilo. El `max(1, …)`
  // evita dividir por cero en una medición absurdamente corta.
  const turnosPosibles = Math.max(1, ms / PERIODO);

  return {
    simultaneos: lotes.length,
    ms,
    rssReposoMB: mb(rssReposo),
    rssPicoMB: mb(rssPico),
    rssDeltaMB: mb(rssPico - rssReposo),
    heapPicoMB: mb(heapPico),
    bytesPorExport: sumideros.map((s) => s.bytes()),
    lagMaxMs: Math.round(lagMax),
    turnos,
    atencion: turnos / turnosPosibles,
  };
}

/**
 * Escribe la medición en la salida del test.
 *
 * Va a `stdout` a propósito: el ADR-0004 §Coste y el AC1 de la HU #11651 piden el NÚMERO registrado
 * en el work item, y un número que solo existe dentro de un `expect` no se puede pegar en ninguna
 * parte.
 */
export function reportar(caso: string, filas: number, m: Medicion): void {
  const total = m.bytesPorExport.reduce((t, b) => t + b, 0);
  process.stdout.write(
    `\n  [coste export] ${caso}: ${m.simultaneos} × ${filas} filas · ${m.ms} ms · `
    + `RSS ${m.rssReposoMB} → ${m.rssPicoMB} MB (delta ${m.rssDeltaMB} MB de un presupuesto de `
    + `${PRESUPUESTO_MB} MB = techo PM2 ${TECHO_PM2_MB} − régimen ${REGIMEN_API_MB}) · `
    + `heap pico ${m.heapPicoMB} MB · archivo(s) ${mb(total)} MB · `
    + `lag máx del event loop ${m.lagMaxMs} ms · el event loop atendió ${m.turnos} de sus turnos `
    + `(${Math.round(m.atencion * 100)} %)\n`,
  );
}
