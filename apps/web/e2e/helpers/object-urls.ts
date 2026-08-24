// Instrumentación de `URL.createObjectURL` / `URL.revokeObjectURL` para los specs de descarga.
//
// Nació dentro de `flito-comparendos-filtros-export.spec.ts` (HU #11561) y se extrajo aquí en la
// HU #11652, cuando `download` y `downloadPost` —las otras dos formas de descargar de `lib/api.ts`—
// pasaron a necesitar exactamente la misma medición. Copiarla habría dejado dos definiciones de
// «revocado demasiado pronto» que pueden divergir, y esa es justo la afirmación que sostiene el AC2.
//
// ── Por qué se mide el TURNO y no solo el despacho del clic ────────────────────────────────────
//
// La versión original solo contaba las revocaciones ocurridas DENTRO del despacho de `a.click()`, y
// esa medida no caza el defecto que dice cazar: el código antiguo revocaba en la línea siguiente al
// clic, ya fuera del despacho pero en el mismo turno del bucle de eventos. Comprobado por mutación
// en la HU #11652 — al devolver `entregarArchivo` a la revocación síncrona, el test del AC3 de la
// #11561 seguía en verde.
//
// `revocadosEnElMismoTurno` es la que sí distingue: el turno del clic se cierra con un
// `setTimeout(…, 0)` programado DESDE el clic, así que corre antes que cualquier otro `setTimeout(…,
// 0)` que registre quien lo pulsó. Revocar cediendo el turno → 0; revocar en la vuelta síncrona,
// dentro o fuera del despacho → ≥ 1.
//
// Límite conocido de la medida: el cierre del turno es un macrotask, así que una revocación puesta en
// una MICROTAREA (`Promise.resolve().then(revocar)`, `queueMicrotask`) correría antes de él y se
// contaría como «cedió el turno» sin haberlo hecho de verdad. No se cierra a propósito: hoy nadie
// escribe eso —las tres descargas de `lib/api.ts` pasan por `entregarArchivo`, que cede con
// `setTimeout`— y el guardián sí caza la forma que el defecto tuvo. Queda anotado, no resuelto.
import type { Page } from '@playwright/test';

export interface ObjectUrls {
  creados: string[];
  revocados: string[];
  /** Revocaciones ocurridas dentro del despacho de `a.click()`. */
  revocadosEnElClic: number;
  /** Revocaciones ocurridas en el mismo turno del bucle de eventos que el clic. */
  revocadosEnElMismoTurno: number;
}

/** Instrumenta `URL.createObjectURL` / `revokeObjectURL` ANTES de que cargue la app. */
export async function instrumentarObjectUrls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __urls: ObjectUrls };
    w.__urls = { creados: [], revocados: [], revocadosEnElClic: 0, revocadosEnElMismoTurno: 0 };
    const crear = URL.createObjectURL.bind(URL);
    const revocar = URL.revokeObjectURL.bind(URL);
    // Se captura ya: si el spec acelera el reloj después, el cierre del turno no debe moverse.
    const programar = window.setTimeout.bind(window);
    let dentroDelClic = false;
    let dentroDelTurnoDelClic = false;
    URL.createObjectURL = (blob: Blob) => {
      const url = crear(blob);
      w.__urls.creados.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      w.__urls.revocados.push(url);
      if (dentroDelClic) w.__urls.revocadosEnElClic += 1;
      if (dentroDelTurnoDelClic) w.__urls.revocadosEnElMismoTurno += 1;
      revocar(url);
    };
    const clicOriginal = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function marcado(this: HTMLAnchorElement) {
      dentroDelClic = true;
      dentroDelTurnoDelClic = true;
      programar(() => { dentroDelTurnoDelClic = false; }, 0);
      try { clicOriginal.call(this); } finally { dentroDelClic = false; }
    };
  });
}

export const leerUrls = (page: Page): Promise<ObjectUrls> => page.evaluate(
  () => (window as unknown as { __urls: ObjectUrls }).__urls,
);
