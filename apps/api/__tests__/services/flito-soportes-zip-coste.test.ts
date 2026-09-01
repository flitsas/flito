// FLITO — coste REAL del ZIP de soportes (Feature #11908, HU #11910).
//
// ── Por qué esto se MIDE y no se estima ──────────────────────────────────────────────────────────
//
// No existe ADR ni medida previa de este endpoint: ADR-0004 gobierna el `.xlsx` y su número no
// traslada. Un export de 2 000 filas son objetos JS VIVOS —`sendExcel` construye el workbook entero
// en el heap— y esto es otra cosa: I/O de MinIO y de FLIT, con `archiver` comprimiendo de forma
// SÍNCRONA en el mismo hilo que atiende al resto del API y los bytes pasando en streaming sin
// quedarse. Los dos consumen el mismo proceso y ninguno predice al otro. Heredar los 2 000 «porque
// también es un archivo» habría sido estimar por analogía sobre otro mecanismo.
//
// Se miden las TRES magnitudes que deciden el tope de `FLITO_ZIP_SOPORTES_MAX_BYTES`:
//
//   · **RSS** — es el que ADR-0004 vigila, y aquí es donde se espera la diferencia: si el streaming
//     funciona, el delta NO crece con el tamaño del lote.
//   · **Lag del event loop y fracción de turnos atendidos** — es lo que de verdad se raciona.
//     `zlib` a nivel 9 sobre contenido ya comprimido (un PDF lo está) es trabajo síncrono, y la
//     pregunta del AC3 de la HU #11651 vale igual aquí: «ninguna petición en vuelo del resto del
//     sistema se pierde».
//   · **Bytes de salida y tiempo** — cuánto tarda el peor lote legal en llegar al cliente.
//
// El escenario es el PEOR CASO LEGAL de la HU: el ZIP mixto del AC4 con 100 trámites × 3 tipos = 300
// entradas. El contenido es pseudoaleatorio a propósito: un PDF real ya viene comprimido, así que
// `deflate` no lo aplasta y el coste de CPU es el máximo. Con texto repetido el número saldría
// optimista y el tope se fijaría sobre una medición que no describe el archivo real.
//
// El presupuesto contra el que se lee (`PRESUPUESTO_MB` = techo PM2 512 − régimen 250) se IMPORTA
// del instrumento del `.xlsx` en vez de reescribirlo: el techo del proceso es uno y no puede tener
// dos definiciones.

import { describe, it, expect, vi } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import type { Response } from 'express';

// El módulo construye `zipSoportesLimiter` al importarse, y eso llama a `makeStore` → `getRedis()`.
// Sin este mock, medir el coste del ZIP arranca un cliente de Redis y la suite muere con
// `MaxRetriesPerRequestError` antes de llegar a ninguna cifra.
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
import { mb, PRESUPUESTO_MB, REGIMEN_API_MB, TECHO_PM2_MB } from '../helpers/export-coste.js';
import {
  emitirZipSoportes, type EntradaZip,
} from '../../src/shared/soportes/soportes-zip.js';

/** El peor lote legal del AC4: 100 trámites × 3 tipos. */
const ENTRADAS = 300;
/** Tamaño de cada documento. Un recibo o una póliza escaneada están en este orden de magnitud. */
const BYTES_POR_DOCUMENTO = 300 * 1024;

/**
 * Contenido pseudoaleatorio DETERMINISTA (xorshift32), no `crypto.randomBytes`.
 *
 * Determinista para que dos corridas midan lo mismo; **de verdad incompresible** para que `deflate`
 * no lo aplaste: un PDF ya viene comprimido, y con contenido que se comprime la medición sale
 * optimista por los dos lados —menos CPU y menos bytes de salida— y el tope acabaría fijado sobre un
 * archivo que no existe.
 *
 * La primera versión de esto era un LCG del que se tomaba el byte 16-23, y **el ZIP salió de 4,7 MB
 * para 88 MB de contenido**: los bits altos de un LCG son mucho menos aleatorios de lo que parecen.
 * Se deja escrito porque el síntoma —una medición que pasa y no mide nada— es silencioso.
 */
function documento(semilla: number, bytes: number): Buffer {
  const buf = Buffer.allocUnsafe(bytes);
  let x = (semilla * 2654435761) >>> 0 || 1;
  for (let i = 0; i + 4 <= bytes; i += 4) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    buf.writeUInt32LE(x, i);
  }
  return buf;
}

/**
 * Respuesta simulada: un stream que cuenta bytes y los tira.
 *
 * Consumirlos importa. Un sumidero que no drenara acumularía el ZIP entero en el buffer del stream y
 * la medición estaría midiendo el test, no `emitirZipSoportes`; el `res` de verdad es un socket que
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

/** Fuerza una recolección completa antes de medir. Sin esto el delta de RSS es bimodal (HU #11794). */
async function recolectarBasura(): Promise<void> {
  try {
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose_gc');
    (vm.runInNewContext('gc') as () => void)();
    v8.setFlagsFromString('--no-expose_gc');
  } catch { /* sin `gc()` la medición sigue valiendo, solo vuelve a ser bimodal */ }
}

describe('coste del ZIP de soportes — el peor lote legal del AC4', () => {
  it(`${ENTRADAS} entradas de ${mb(BYTES_POR_DOCUMENTO)} MB: RSS, lag del event loop y bytes`, async () => {
    // Las entradas se generan PEREZOSAMENTE (`abrir()` fabrica el buffer en su turno), que es como
    // se comporta el endpoint de verdad: MinIO entrega un stream cuando le toca, no 300 a la vez.
    // Tenerlos todos materializados de antemano mediría el fixture y no el archivador.
    //
    // De paso cuenta cuántos documentos están ABIERTOS a la vez: es la prueba directa del
    // backpressure, y no depende de la memoria ni del reloj (ver el aserto de `maxEnVuelo`).
    let enVuelo = 0;
    let maxEnVuelo = 0;
    const entradas: EntradaZip[] = Array.from({ length: ENTRADAS }, (_, i) => ({
      nombreBase: `ABC${String(i).padStart(3, '0')}-MEDELLIN`,
      tipo: 'factura_soat' as const,
      // Un documento por registro, que es el reparto del ZIP de SOAT. Alimenta la cabecera
      // `X-Soportes-Registros`; dejarlo sin valor colapsaría los 300 en un solo `Set`.
      registroId: `reg-${i}`,
      bytes: BYTES_POR_DOCUMENTO,
      abrir: async () => {
        enVuelo += 1;
        maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
        const stream = Readable.from([documento(i + 1, BYTES_POR_DOCUMENTO)]);
        stream.on('end', () => { enVuelo -= 1; });
        return { stream, extension: 'pdf' };
      },
    }));

    const { res, bytes } = sumidero();

    await recolectarBasura();
    const rssReposo = process.memoryUsage().rss;
    let rssPico = rssReposo;
    let heapPico = process.memoryUsage().heapUsed;
    let lagMax = 0;

    // Sonda del event loop: un `setInterval` de 20 ms cuyo retraso REAL se mide. Es la forma barata
    // de ver si la compresión —trabajo síncrono en el mismo hilo que atiende al resto del API— deja
    // de dar paso a nadie mientras se construye el archivo.
    const PERIODO = 20;
    let ultimo = performance.now();
    let turnos = 0;
    const sonda = setInterval(() => {
      const ahora = performance.now();
      lagMax = Math.max(lagMax, ahora - ultimo - PERIODO);
      ultimo = ahora;
      turnos += 1;
      const uso = process.memoryUsage();
      rssPico = Math.max(rssPico, uso.rss);
      heapPico = Math.max(heapPico, uso.heapUsed);
    }, PERIODO);

    const t0 = performance.now();
    const incluidas = await emitirZipSoportes(res, entradas);
    const ms = Math.round(performance.now() - t0);

    clearInterval(sonda);
    const uso = process.memoryUsage();
    rssPico = Math.max(rssPico, uso.rss);
    heapPico = Math.max(heapPico, uso.heapUsed);

    const rssDeltaMB = mb(rssPico - rssReposo);
    const entrada = ENTRADAS * BYTES_POR_DOCUMENTO;
    const turnosPosibles = Math.max(1, ms / PERIODO);
    const atencion = turnos / turnosPosibles;

    // A `stdout` a propósito: el número que el work item pide no puede existir solo dentro de un
    // `expect`. Es lo mismo que hace `reportar()` con el `.xlsx`.
    process.stdout.write(
      `\n  [coste zip soportes] ${incluidas} entradas × ${mb(BYTES_POR_DOCUMENTO)} MB `
      + `(${mb(entrada)} MB de contenido) · ${ms} ms · `
      + `RSS ${mb(rssReposo)} → ${mb(rssPico)} MB (delta ${rssDeltaMB} MB de un presupuesto de `
      + `${PRESUPUESTO_MB} MB = techo PM2 ${TECHO_PM2_MB} − régimen ${REGIMEN_API_MB}) · `
      + `heap pico ${mb(heapPico)} MB · zip ${mb(bytes())} MB · `
      + `lag máx del event loop ${Math.round(lagMax)} ms · el event loop atendió ${turnos} de sus `
      + `turnos (${Math.round(atencion * 100)} %)\n`,
    );

    // Las 300 entradas salen: si el archivo se quedara corto, el resto de números no diría nada.
    expect(incluidas).toBe(ENTRADAS);
    // Y el contenido es de verdad incompresible: si el ZIP pesara mucho menos que la entrada, esta
    // medición estaría midiendo `deflate` sobre un fixture que no se parece a un PDF.
    expect(bytes()).toBeGreaterThan(entrada * 0.9);

    // ── El umbral, y por qué NO es un número mágico ──────────────────────────────────────────────
    //
    // Lo que se afirma es la PROPIEDAD, no un valor medido con margen: **el coste de memoria no
    // escala con el contenido**. Si alguien volviera a bufferizar —`arrayBuffer()` por factura,
    // `await stream.toArray()`, o encolar los 300 `append` sin esperar al evento `entry`— los 88 MB
    // de documentos vivirían a la vez en el proceso y el delta pasaría de aquí. Con el tope en
    // 200 MiB ese mismo error costaría 200 MB de los 262 de presupuesto: un `max_memory_restart`.
    //
    // Un umbral fijo del estilo «lo medido + 20 %» habría hecho otra cosa: dos corridas del mismo
    // código dan deltas muy distintos según dónde esté V8 en su ciclo (medido aquí: 66,6 MB en frío
    // y 9,1 MB con las arenas calientes, el mismo bimodalismo que documenta `export-coste.ts`), así
    // que ese umbral se «recalibraría» al primer rojo y dejaría de decir nada.
    expect(rssDeltaMB, 'el ZIP no puede retener el contenido: va en streaming').toBeLessThan(mb(entrada));
    // Y el techo duro del proceso, que es la razón última de todo esto.
    expect(rssDeltaMB).toBeLessThan(PRESUPUESTO_MB);

    // ── El aserto que NO depende de la memoria ni del reloj ──────────────────────────────────────
    //
    // `archive.append()` ENCOLA: devuelve al momento y el trabajo se hace después. Un bucle que no
    // espere el evento `entry` abre los 300 documentos de golpe, y con `retry: 1` en el config eso
    // se cuela — medido: el mutante «quitar el `await anexar`» da 150,9 MB de delta y 506 ms de lag
    // en la primera corrida, y 0,3 MB en el reintento, que ya arranca con el RSS caliente. Esto lo
    // atrapa las dos veces y sin ruido: como mucho UN documento abierto a la vez.
    expect(maxEnVuelo, 'el archivador tiene que ir de uno en uno').toBe(1);

    // Y el hilo sigue atendiendo. El umbral es flojo a propósito —la CI comparte CPU y esto no puede
    // ser un test de cronómetro—, pero un `zlib` que monopolizara el hilo varios segundos seguidos
    // no llegaría ni a esto: con el archivador bloqueando, la fracción medida se desploma.
    expect(atencion).toBeGreaterThan(0.05);
  }, 120_000);
});
