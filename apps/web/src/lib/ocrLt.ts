// FLITO Logística — OCR del número de LT (formato «LT» + 11 dígitos, p. ej. LT10000848803).
//
// El número de LT NO viaja en el PDF417: va impreso justo debajo del código. Aquí se reconoce con
// Tesseract.js 100% en el cliente (encaja con la operación offline del mensajero). El runtime y el
// modelo se auto-alojan en /public/tesseract (same-origin → el Service Worker los cachea; además
// Tesseract guarda el modelo en IndexedDB), así que tras el primer uso funciona sin señal.
//
// Rendimiento: se fija el core LSTM plano (compatible con todo equipo) y se reutiliza un único worker
// (singleton). El resultado es ASISTIVO: se prellena el campo y el mensajero puede corregirlo.

import type { Worker } from 'tesseract.js';

let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, PSM } = await import('tesseract.js');
      const worker = await createWorker('eng', 1, {
        workerPath: '/tesseract/worker.min.js',
        corePath: '/tesseract/tesseract-core-lstm.wasm.js', // archivo exacto → sin auto-selección de variantes
        langPath: '/tesseract/',
        workerBlobURL: false, // carga el worker same-origin (cacheable por el SW), no como blob
        gzip: true,
      });
      await worker.setParameters({
        tessedit_char_whitelist: 'LT0123456789', // solo L, T y dígitos
        tessedit_pageseg_mode: PSM.SINGLE_LINE,   // una sola línea de texto
      });
      return worker;
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** Dispara la carga del worker (para solaparla con el usuario apuntando la cámara). No lanza. */
export function precargarOcr(): void { getWorker().catch(() => {}); }

/**
 * Extrae el N.º de LT de una imagen recortada (la banda bajo el código). Devuelve `LT` + 11 dígitos,
 * o null si no reconoce el patrón. Tolerante: si pierde el prefijo pero hay 11 dígitos, los prefija.
 */
export async function ocrNumeroLt(source: HTMLCanvasElement): Promise<string | null> {
  const worker = await getWorker();
  const { data } = await worker.recognize(source);
  const txt = (data.text || '').toUpperCase().replace(/[^LT0-9]/g, '');
  // Caso limpio: "LT" + 11 dígitos.
  const limpio = txt.match(/LT(\d{11})/);
  if (limpio) return `LT${limpio[1]}`;
  // El prefijo "LT" se confunde seguido (T→1, L→1…). Como el formato es SIEMPRE LT + 11 dígitos, el
  // número son los ÚLTIMOS 11 dígitos del bloque (11–13); los de más vienen del prefijo mal leído.
  const digitos = txt.replace(/\D/g, '');
  if (digitos.length >= 11 && digitos.length <= 13) return `LT${digitos.slice(-11)}`;
  return null;
}
