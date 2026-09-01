// FLITO — instrumento de medición del coste de un export (HU #11558, HU #11651, HU #11934).
//
// **Deja de ser «de comparendos» con la HU #11934**, y el cambio es el que el ADR obliga a hacer:
// `medirExports` tenía `COLUMNAS_EXPORT` de comparendos incrustado, así que medir cualquier otra hoja
// era imposible sin estimar por analogía. Ahora la lista de columnas es un PARÁMETRO, con esa misma
// constante como valor por defecto para que las dos suites de comparendos no cambien ni una línea.
// La hoja de las colas de SOAT e Impuestos —25 columnas— se mide en
// `cola-flito-export-coste.test.ts` con este mismo instrumento y no con una regla de tres.
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
    // HU #11794. Una de cada tres filas sin notificar, que es la forma que tiene el dato real: el
    // proveedor manda el centinela `01/01/1900` en los comparendos aún no notificados y el merge lo
    // guarda como `null`. Un literal constante en todas mediría un archivo más barato que el real.
    fechaNotificacion: i % 3 === 0 ? null : '2026-06-19',
    codigoInfraccion: 'C29',
    descripcionInfraccion: `Estacionar en sitio prohibido o en zona de cargue ${i}`,
    municipioFuente: 'BELLO',
    municipioComparendo: 'BELLO',
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

/** La forma mínima de una columna de `sendExcel`, para no atarse al tipo de un módulo. */
export interface ColumnaMedida { header: string; key: string; width?: number }

/**
 * Las columnas del archivo real que un generador de filas NO produce.
 *
 * Vacío = la medición mide el archivo entero. No vacío = alguien añadió una columna al export y la
 * medición se quedó corta, que es exactamente lo que pasó entre la HU #11712 y la HU #11651.
 *
 * Los dos argumentos tienen defecto de comparendos para no tocar sus dos suites; cualquier otra hoja
 * pasa los suyos. La comprobación importa MÁS cuanto más ancha es la hoja: en una de 25 columnas,
 * olvidarse de generar seis se lee como «el export es barato».
 */
export function columnasFaltantes(
  columnas: readonly ColumnaMedida[] = COLUMNAS_EXPORT,
  generada: Record<string, unknown> = fila(0, null),
): string[] {
  return columnas.map((c) => c.key).filter((k) => !(k in generada));
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

// ── La hoja de las colas de SOAT e Impuestos (HU #11934) ─────────────────────────────────────────

/**
 * Una fila del `.xlsx` de las colas, con **las 25 claves** de `COLUMNAS_COLA_EXPORT`.
 *
 * Se escribe aquí y no en el archivo de test por lo mismo que la de comparendos: la medición de un
 * export y la de varios simultáneos viven en procesos distintos y un generador copiado divergiría.
 *
 * Los textos cambian por fila a propósito. `exceljs` guarda las cadenas en una tabla compartida, así
 * que 2 000 filas idénticas comprimirían como una y la medición saldría optimista — y en una hoja de
 * 25 columnas eso importa más, no menos: la mitad de sus valores (`Puertas`, `N_I`, `ClaseId`,
 * `ClaseDeInterlocutor`, `Servicio`, `Clase`…) SON repetitivos de verdad, y los que no lo son hay que
 * generarlos variados o se mide un archivo que no existe.
 *
 * El número de columnas NO se escribe como literal en ningún comentario de este bloque: para eso está
 * `columnasFaltantes(COLUMNAS_COLA_EXPORT, filaCola(0))`, que convierte el desfase en un test rojo en
 * vez de en una frase que envejece (es lo que pasó entre la HU #11712 y la #11651).
 */
export function filaCola(i: number): Record<string, unknown> {
  const juridica = i % 3 === 0;
  const razon = `TRANSPORTES Y LOGISTICA DEL ORIENTE ${i} SAS`;
  return {
    vin: `9BWZZZ377VT${String(i).padStart(6, '0')}`,
    placa: `AB${String(i % 1000).padStart(4, '0')}`,
    modelo: String(2010 + (i % 16)),
    servicio: i % 4 === 0 ? 'Publico' : 'Particular',
    marca: ['CHEVROLET', 'KIA', 'RENAULT', 'MAZDA', 'NISSAN'][i % 5],
    linea: `${['ONIX', 'STONIC', 'DUSTER', 'CX-30', 'VERSA'][i % 5]} ${i % 97}`,
    // Hoy llega vacía en todas las filas —FLIT aún no la manda— y así se mide: una celda nula no
    // ocupa lo mismo que un texto, y suponerla llena mediría un archivo que no existe.
    clase: null,
    carroceria: ['SUV', 'SEDAN', 'DOBLE CABINA CON PLATON', 'SIN CARROCERIA'][i % 4],
    cilindraje: String(1000 + (i % 3000)),
    capacidadCargaOPasajeros: String(i % 40),
    puertas: '4',
    organismoDetto: `STRIA TTOyTTE MCPAL ${['FUNZA', 'MOSQUERA', 'PALMIRA', 'ENVIGADO'][i % 4]}`,
    nI: 'IMPORTADO',
    claseDeInterlocutor: juridica ? 'PJUR' : 'PNAT',
    nombrePila: juridica ? null : `JUANA MARIA ${i}`,
    apellidos: juridica ? null : `PEREZ GOMEZ ${i}`,
    razonSocial: juridica ? razon : null,
    claseId: juridica ? 'NIT' : 'CC',
    numeroId: `10${String(i).padStart(8, '0')}`,
    direccion: `CALLE ${i % 200} # ${i % 90}-${i % 60} APARTAMENTO ${i % 900}`,
    municipio: ['FUNZA', 'MOSQUERA', 'PALMIRA', 'ENVIGADO', 'BOGOTA'][i % 5],
    departamento: ['CUNDINAMARCA', 'VALLE DEL CAUCA', 'ANTIOQUIA'][i % 3],
    celular: `31${String(i % 100000000).padStart(8, '0')}`,
    correo: `titular.numero.${i}@empresadetransportes${i % 40}.com.co`,
    organismoDettoCiudad: ['Funza', 'Mosquera', 'Palmira', 'Envigado'][i % 4],
  };
}

/** `n` filas de la hoja de las colas, todas distinguibles. */
export function filasCola(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => filaCola(i));
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
 * Fuerza una recolección COMPLETA antes de empezar a medir. Sin esto la medición es una moneda al
 * aire, y está medido (HU #11794, 2026-08-24).
 *
 * `rssDeltaMB` es `pico − reposo`, y las dos puntas dependían de dónde estuviera V8 en su ciclo
 * cuando el test arrancó: con basura acumulada del propio archivo y de los anteriores del mismo
 * fork, el reposo salía bajo y V8 llegaba al export con presupuesto de sobra, así que no recogía
 * durante la generación y el pico se disparaba. **El mismo código, corrido cuatro veces seguidas,
 * daba 145 · 66,6 · 65,7 · 146 MB contra un umbral de 150.** No es ruido de ±5 MB alrededor de un
 * valor: son dos modos separados por 80 MB, uno de los cuales roza el tope. Un test así no mide el
 * export, mide el planificador de la recolección — y acaba borrado o «recalibrado» el día que roce
 * el umbral por el lado malo.
 *
 * Con la recolección forzada, las mismas tres corridas dan 67,9 · 68,4 · 68,2 MB: ±0,5 MB, y además
 * **el número vuelve a parecerse al que este archivo documenta como medido en frío** (93 MB con el
 * tope en 2 000, un proceso por escenario), que es justo lo que se quería reproducir — el API en
 * régimen no llega a un export con el heap lleno de basura de otros veintidós archivos de tests.
 *
 * No ablanda ninguna aserción: el umbral de 150 MB sigue donde estaba y el margen que queda se mide
 * de verdad en vez de sortearse. Si el export creciera hasta rozarlo, esto lo diría **todas** las
 * veces en lugar de una de cada dos.
 *
 * El `--expose_gc` se enciende y se apaga aquí porque la suite no arranca con esa bandera y añadirla
 * al `vitest.config.ts` la pondría en los cientos de archivos que no la necesitan. Si el truco
 * fallara —otro runtime, otra versión—, la medición sigue: se pierde la estabilidad, no el test.
 */
async function recolectarBasura(): Promise<void> {
  try {
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose_gc');
    (vm.runInNewContext('gc') as () => void)();
    v8.setFlagsFromString('--no-expose_gc');
  } catch {
    // Sin `gc()` disponible la medición sigue siendo válida, solo vuelve a ser bimodal. Se prefiere
    // eso a que el helper reviente y se lleve por delante los dos archivos que lo usan.
  }
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
 *
 * @param columnas La hoja que se está midiendo. **Es un parámetro desde la HU #11934 y no un
 *   detalle**: el número de columnas es uno de los dos factores del tamaño del workbook, así que con
 *   la lista incrustada este instrumento solo sabía medir una hoja y cualquier otra habría tenido
 *   que estimarse «por analogía» — que es exactamente lo que ADR-0004 pide no hacer. El defecto es
 *   la de comparendos para que sus dos suites sigan llamando igual.
 */
export async function medirExports(
  lotes: Record<string, unknown>[][],
  columnas: readonly ColumnaMedida[] = COLUMNAS_EXPORT,
): Promise<Medicion> {
  const sumideros = lotes.map(() => sumidero());

  await recolectarBasura();
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
    [...columnas],
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
