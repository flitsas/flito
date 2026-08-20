// Carga y ejecución de axe para los specs de accesibilidad (HU #11650).
//
// POR QUÉ EXISTE ESTE ARCHIVO
// El repo no tiene `@axe-core/playwright`: `axe.min.js` se inyecta en la página desde disco
// (`QA_AXE_PATH`) o desde un CDN (`QA_AXE_CDN=1`). Hasta esta HU, cuando no había ninguno de los
// dos, los specs se saltaban solos —o peor, sólo dejaban un `console.warn` y seguían— y la corrida
// salía en VERDE sin haber medido nada. Así se certificó la HU #11560 con siete specs de
// accesibilidad que nunca llegaron a ejecutarse.
//
// De las tres salidas posibles, la de «verde silencioso» es la peor: un test que no puede correr y
// LO DICE avisa; un test que no existe no engaña a nadie; un test que no corre y reporta éxito hace
// creer que hay cobertura donde no la hay. Por eso aquí, si axe no está, se LANZA y el spec FALLA.
//
// El mensaje separa a propósito las dos causas de fallo (AC2): esto es un fallo de ENTORNO —no se
// pudo cargar la herramienta— y no nombra ninguna regla, porque ninguna regla llegó a evaluarse.
// Los incumplimientos reales los reporta `esperarSinViolacionesGraves`, con su regla y su selector.
import { expect, type Page } from '@playwright/test';

export interface ViolacionAxe {
  id: string;
  impact: string;
  nodes: number;
  help: string;
  /** Selectores CSS de los nodos que incumplen: sin esto un fallo real no se puede localizar. */
  selectores: string[];
}

const CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';

const AXE_PATH = process.env.QA_AXE_PATH;
// `PESV_A11Y_AXE_CDN` es el nombre histórico del interruptor en el spec de PESV. Se sigue honrando
// para que quien ya lo usaba no vea cambiar el comportamiento (HU #11650, AC3).
const USAR_CDN = process.env.QA_AXE_CDN === '1' || process.env.PESV_A11Y_AXE_CDN === '1';

/** Fallo de ENTORNO: la herramienta no se pudo cargar. NO es un incumplimiento de accesibilidad. */
export class AxeNoDisponibleError extends Error {
  constructor(causa: string) {
    super(
      `[a11y · FALLO DE ENTORNO] No se pudo ejecutar axe: ${causa}.\n`
      + '\n'
      + 'Esto NO es un incumplimiento de accesibilidad. NINGUNA regla llegó a evaluarse, así que\n'
      + 'este resultado no dice nada —ni a favor ni en contra— sobre el contraste ni sobre ninguna\n'
      + 'otra regla de esta pantalla. Lo que está incompleto es el entorno de pruebas.\n'
      + '\n'
      + 'Cómo resolverlo (basta una de las dos):\n'
      + '  · QA_AXE_PATH=/ruta/a/axe.min.js   → inyección determinista desde disco, sin red.\n'
      + `  · QA_AXE_CDN=1                     → se descarga de ${CDN_URL} (requiere red).\n`
      + '\n'
      + 'Este spec falla a propósito en lugar de saltarse (HU #11650): un chequeo que no se ejecuta\n'
      + 'y aun así sale en verde hace creer que hay cobertura donde no la hay.',
    );
    this.name = 'AxeNoDisponibleError';
  }
}

/**
 * Inyecta axe en la página. Lanza `AxeNoDisponibleError` si no hay de dónde cargarlo, si la
 * inyección falla, o si el script se cargó pero no dejó un `axe.run` utilizable.
 */
export async function cargarAxe(page: Page): Promise<void> {
  if (!AXE_PATH && !USAR_CDN) {
    throw new AxeNoDisponibleError(
      'no hay ninguna fuente configurada (ni QA_AXE_PATH ni QA_AXE_CDN=1)',
    );
  }

  try {
    if (AXE_PATH) await page.addScriptTag({ path: AXE_PATH });
    else await page.addScriptTag({ url: CDN_URL });
  } catch (e) {
    const detalle = e instanceof Error ? e.message.split('\n')[0] : String(e);
    throw new AxeNoDisponibleError(
      AXE_PATH
        ? `falló la inyección de QA_AXE_PATH=${AXE_PATH} (${detalle})`
        : `falló la descarga desde el CDN (${detalle})`,
    );
  }

  // El script pudo cargar y aun así no ser axe (ruta equivocada, 404 servido como HTML, bundle
  // recortado). Sin esta comprobación el fallo saldría como un TypeError críptico dentro del
  // `evaluate`, que es justo la confusión que el AC2 quiere evitar.
  const listo = await page.evaluate(
    () => typeof (window as unknown as { axe?: { run?: unknown } }).axe?.run === 'function',
  );
  if (!listo) {
    throw new AxeNoDisponibleError(
      'el script se inyectó pero no dejó un `window.axe.run` utilizable'
      + (AXE_PATH ? ` (QA_AXE_PATH=${AXE_PATH})` : ' (descarga desde el CDN)'),
    );
  }
}

/**
 * Carga axe y lo corre sobre el documento completo con las etiquetas WCAG 2.0/2.1/2.2 nivel A y AA.
 * Devuelve las violaciones. Si axe no está disponible, LANZA: nunca devuelve una lista vacía que se
 * pueda confundir con «no hay violaciones».
 */
export async function correrAxe(page: Page): Promise<ViolacionAxe[]> {
  await cargarAxe(page);
  return page.evaluate(async () => {
    // @ts-expect-error axe se inyecta en tiempo de ejecución
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] },
    });
    return r.violations.map(
      (v: { id: string; impact?: string; nodes: { target: unknown[] }[]; help?: string }) => ({
        id: v.id,
        impact: v.impact ?? 'minor',
        nodes: v.nodes.length,
        help: v.help ?? '',
        selectores: v.nodes.slice(0, 5).map((n) => JSON.stringify(n.target)),
      }),
    );
  });
}

/**
 * Afirma que no hay violaciones serias ni críticas. Imprime TODAS las violaciones —también las
 * moderadas y leves— para que queden en la evidencia y no se vuelvan deuda invisible.
 *
 * Sólo se llama con un resultado real de axe: si axe no se pudo cargar, `correrAxe` ya lanzó y esta
 * función no llega a ejecutarse. Por eso aquí nombrar reglas SÍ es legítimo (AC2).
 */
export function esperarSinViolacionesGraves(violaciones: ViolacionAxe[], ambito: string): void {
  console.log(`[a11y · ${ambito}] ${violaciones.length} violaciones: ${JSON.stringify(violaciones)}`);
  const graves = violaciones.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    graves,
    `INCUMPLIMIENTO de accesibilidad (axe SÍ se ejecutó) — violaciones serias/críticas en `
    + `«${ambito}»: ${JSON.stringify(graves)}`,
  ).toEqual([]);
}
