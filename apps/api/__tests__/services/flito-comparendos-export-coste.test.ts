// FLITO comparendos — coste de construir el `.xlsx` del export (HU #11558, ADR-0004 §Coste).
//
// El ADR acepta el tope de 5 000 filas **con la condición de medirlo en la HU**: duración, delta de
// memoria y lag del event loop. No es un requisito de estilo. `sendExcel` construye el workbook
// ENTERO en memoria (`workbook.xlsx.write(res)`, sin `WorkbookWriter`), y el API corre en una sola
// instancia fork con `max_memory_restart: '512M'` (`ecosystem.config.cjs`): si un export legítimo
// cruzara ese techo, PM2 reiniciaría el proceso y se llevaría por delante las peticiones en vuelo de
// todo el sistema. «Un click reinicia el API» es un fallo de disponibilidad que ningún AC de esta HU
// habría detectado.
//
// Qué mide esto y qué NO. Mide la construcción del workbook en el proceso —que es donde está el
// riesgo de memoria— con filas sintéticas de la forma real (19 columnas, los mismos tipos). **No**
// mide la consulta contra una tabla poblada: eso necesita PostgreSQL con volumen y queda para la
// verificación de qa-agent, que es quien tiene el ambiente.
//
// Los topes de las aserciones son de ORDEN DE MAGNITUD, no marcas de rendimiento: la máquina de CI
// no es la de nadie más, y un test que falle por 300 ms de diferencia se acaba borrando. Lo que
// tienen que cazar es el cambio que convierta este endpoint en un riesgo: pasar de MB a cientos de
// MB, o de segundos a decenas.

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { Response } from 'express';
import { sendExcel } from '../../src/shared/utils/excel.js';
import { COLUMNAS_EXPORT } from '../../src/modules/flito-comparendos/flito-comparendos.export.service.js';
import { COMPARENDOS_EXPORT_MAX_FILAS, COMPARENDOS_OBSERVACION_MAX } from '@operaciones/shared-types';

/** El tope real de producción, no el reducido de la suite funcional: aquí se mide el peor caso. */
const FILAS = COMPARENDOS_EXPORT_MAX_FILAS;

/** Techo de PM2 (`max_memory_restart`) en MB. La referencia contra la que se lee todo esto. */
const TECHO_PM2_MB = 512;

interface Medicion {
  ms: number;
  rssPicoMB: number;
  rssDeltaMB: number;
  heapPicoMB: number;
  bytes: number;
  lagMaxMs: number;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Una fila del archivo tal como la deja `construirFilasExport`: 19 columnas, el monto ya numérico y
 * los instantes ya formateados. Se genera con textos DISTINTOS por fila a propósito: `exceljs`
 * guarda las cadenas en una tabla compartida, así que 5 000 filas idénticas comprimirían como una y
 * la medición saldría optimista.
 */
function fila(i: number, observacion: string | null): Record<string, unknown> {
  return {
    numeroComparendo: `0500100000001${String(i).padStart(7, '0')}`,
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

async function medir(filas: Record<string, unknown>[]): Promise<Medicion> {
  const { res, bytes } = sumidero();

  const rssAntes = process.memoryUsage().rss;
  let rssPico = rssAntes;
  let heapPico = process.memoryUsage().heapUsed;
  let lagMax = 0;

  // Sonda del event loop: un `setInterval` de 20 ms cuyo retraso REAL se mide. Es la forma barata de
  // ver si la compresión del ZIP —trabajo síncrono en el mismo hilo que atiende al resto del API—
  // deja de dar paso a nadie durante la generación.
  const PERIODO = 20;
  let ultimo = performance.now();
  const sonda = setInterval(() => {
    const ahora = performance.now();
    lagMax = Math.max(lagMax, ahora - ultimo - PERIODO);
    ultimo = ahora;
    const uso = process.memoryUsage();
    rssPico = Math.max(rssPico, uso.rss);
    heapPico = Math.max(heapPico, uso.heapUsed);
  }, PERIODO);

  const t0 = performance.now();
  await sendExcel(res, 'medicion.xlsx', COLUMNAS_EXPORT, filas);
  const ms = Math.round(performance.now() - t0);

  clearInterval(sonda);
  const uso = process.memoryUsage();
  rssPico = Math.max(rssPico, uso.rss);

  return {
    ms,
    rssPicoMB: mb(rssPico),
    rssDeltaMB: mb(rssPico - rssAntes),
    heapPicoMB: mb(heapPico),
    bytes: bytes(),
    lagMaxMs: Math.round(lagMax),
  };
}

/**
 * Observación del tamaño máximo, con prosa en vez de un carácter repetido.
 *
 * `'x'.repeat(1000)` mediría mal el ARCHIVO: el deflate del `.xlsx` lo aplasta a casi nada y la
 * medición diría que el peor caso pesa lo mismo que el realista. Con palabras rotadas por fila la
 * compresión se parece a la de un texto de verdad, que es lo que va a haber en esa columna.
 */
function observacionLarga(i: number): string {
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

function reportar(caso: string, m: Medicion): void {
  // Va a la salida del test a propósito: el ADR pide el NÚMERO en la HU, y un número que solo existe
  // dentro de un `expect` no se puede pegar en ninguna parte.
  process.stdout.write(
    `\n  [coste export] ${caso}: ${FILAS} filas · ${m.ms} ms · RSS pico ${m.rssPicoMB} MB `
    + `(delta ${m.rssDeltaMB} MB, techo PM2 ${TECHO_PM2_MB} MB) · heap pico ${m.heapPicoMB} MB · `
    + `archivo ${mb(m.bytes)} MB · lag máx del event loop ${m.lagMaxMs} ms\n`,
  );
}

describe('coste de generar el export en el proceso del API (ADR-0004 §Coste)', () => {
  it('5 000 filas realistas: duración, memoria y lag', { timeout: 120_000 }, async () => {
    // Realista = la observación casi siempre corta o ausente, que es lo que hay hoy en la tabla.
    const datos = Array.from({ length: FILAS }, (_, i) => fila(
      i,
      i % 4 === 0 ? `Acuerdo de pago con el propietario, cuota ${i} del mes entrante` : null,
    ));

    const m = await medir(datos);
    reportar('realista', m);

    expect(m.bytes).toBeGreaterThan(0);
    // Se afirma sobre el DELTA y no sobre el pico absoluto: el RSS de partida de este proceso es el
    // de la suite (que carga media API y varía entre archivos), no el del API en producción. Lo que
    // esta ruta añade es el delta, y es lo único comparable contra el presupuesto de PM2: con un
    // proceso en régimen de ~200 MB, 250 MB de margen siguen dejando el pico por debajo de 512 MB.
    expect(m.rssDeltaMB).toBeLessThan(250);
    expect(m.ms).toBeLessThan(30_000);
    // El event loop se bloquea a ratos —la compresión del ZIP es trabajo síncrono en este mismo
    // hilo— y el ADR lo predecía. Lo que no puede pasar es que se bloquee SEGUNDOS: ahí el resto del
    // API deja de responder mientras alguien descarga.
    expect(m.lagMaxMs).toBeLessThan(5_000);
  });

  it('5 000 filas en el PEOR caso: observación al máximo en todas', { timeout: 120_000 }, async () => {
    // 5 000 × 1 000 caracteres es el archivo más grande que este endpoint puede producir con el tope
    // actual. No es un escenario de laboratorio: la columna admite ese texto y nada impide que una
    // operación lo llene.
    const datos = Array.from({ length: FILAS }, (_, i) => fila(i, observacionLarga(i)));

    const m = await medir(datos);
    // Ojo al leer el delta de este segundo caso: corre sobre un proceso ya CALENTADO por el
    // anterior, así que su incremento sale más pequeño de lo que sería en frío. El número
    // comparable entre los dos es el pico absoluto y el de heap, no el delta.
    reportar('peor caso (proceso ya calentado por el caso anterior)', m);

    expect(m.rssDeltaMB).toBeLessThan(250);
    expect(m.ms).toBeLessThan(60_000);
    expect(m.lagMaxMs).toBeLessThan(5_000);
  });
});
