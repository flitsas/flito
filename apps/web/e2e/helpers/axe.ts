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
 *
 * Los `incomplete` NO se devuelven, pero desde el Bug #11766 SÍ se imprimen. Un `incomplete` es
 * «axe no pudo decidir»: para `color-contrast` es lo que sale cuando el fondo del nodo es un
 * `background-image` —un gradiente, por ejemplo—, porque axe no muestrea la imagen. Hasta este bug
 * esta función hacía `return r.violations.map(...)` a secas: los `incomplete` se descartaban aquí
 * dentro y ningún spec podía verlos AUNQUE QUISIERA. No es que los tests los ignorasen; es que no
 * llegaban. Así vivió #11766 —texto blanco a 1,81:1 sobre los cuatro gradientes del kit— con los
 * specs de accesibilidad en verde.
 *
 * Descartar en silencio lo que no se pudo medir es la misma «salida verde silenciosa» que la
 * cabecera de este archivo declara la peor de las tres. Se imprimen, entonces.
 *
 * Lo que NO se hace aquí y hay que saberlo: no se falla por un `incomplete`. Convertirlos en fallo
 * pide antes medir qué pantallas se pondrían en rojo y por qué, y esa medición no está hecha. El
 * incumplimiento de contraste sobre los gradientes lo cierra `npm run check:contraste`, que no
 * necesita navegador y mide el token en vez del píxel.
 */
export async function correrAxe(page: Page): Promise<ViolacionAxe[]> {
  await cargarAxe(page);
  const { violaciones, incompletos } = await page.evaluate(async () => {
    // @ts-expect-error axe se inyecta en tiempo de ejecución
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] },
    });
    // ── Redacción de los selectores (Bug #11766) ─────────────────────────────────────────
    // Un `target` de axe NO es sólo etiquetas y clases: puede transportar el VALOR LITERAL de un
    // atributo. `filterAttributes` (axe-core, `getSelector`) admite cualquier atributo que no
    // esté en `ignoredAttributes`, no lleve `:` y cuyo valor mida menos de
    // MAXATTRIBUTELENGTH = 31 caracteres. En esa lista de ignorados NO están `aria-label`,
    // `name`, `title`, `alt`, `placeholder`, `value` ni ningún `data-*`, así que un selector
    // puede salir como `[aria-label="Eliminar vehículo ABC123"]` — con la placa dentro, y las
    // placas y los NIT son dato sensible según AGENTS.md §14. En este repo hay etiquetas así por
    // debajo del umbral (`Vehicles.tsx:261`, `FlitTopbar.tsx:128`) y `data-testid` con id de
    // compañía (`BolsasTablero.tsx:242`).
    //
    // Se redacta AQUÍ y no en el `console.log` a propósito: `resumir` es el único punto por el
    // que pasan las violaciones Y los incompletos, así que una sola regla cubre los dos volcados
    // —incluido el de `esperarSinViolacionesGraves`, que ya existía—. Si esto se mueve al sitio
    // de impresión hay que acordarse de hacerlo dos veces, y ese es el olvido que se paga.
    //
    // Se conserva el NOMBRE del atributo (dice qué clase de nodo era) y se tira el valor, salvo
    // los atributos cuyo vocabulario cierra la especificación: ésos no pueden llevar texto libre
    // y son justo los que más ayudan a localizar el nodo (`button[type="submit"]`).
    const ATRIBUTOS_DE_VOCABULARIO_CERRADO = new Set([
      'type', 'role', 'dir', 'lang', 'method', 'rel', 'target', 'scope',
      'aria-current', 'aria-haspopup', 'aria-live', 'aria-modal', 'aria-orientation', 'aria-sort',
    ]);
    const redactarSelector = (sel: string): string =>
      sel.replace(
        /\[([A-Za-z_][-\w.]*)([~^$*|]?=)"((?:[^"\\]|\\.)*)"\]/g,
        (entero: string, nombre: string, operador: string) =>
          ATRIBUTOS_DE_VOCABULARIO_CERRADO.has(nombre.toLowerCase())
            ? entero
            : `[${nombre}${operador}"…"]`,
      );
    // El `target` puede anidar arrays (un nodo dentro de un iframe), de ahí el recorrido.
    const redactarTarget = (t: unknown): unknown =>
      typeof t === 'string' ? redactarSelector(t) : Array.isArray(t) ? t.map(redactarTarget) : t;

    const resumir = (v: {
      id: string;
      impact?: string;
      nodes: { target: unknown[] }[];
      help?: string;
    }) => ({
      id: v.id,
      impact: v.impact ?? 'minor',
      nodes: v.nodes.length,
      help: v.help ?? '',
      selectores: v.nodes.slice(0, 5).map((n) => JSON.stringify(redactarTarget(n.target))),
    });
    return { violaciones: r.violations.map(resumir), incompletos: r.incomplete.map(resumir) };
  });
  if (incompletos.length > 0) {
    console.log(
      `[a11y · axe NO PUDO MEDIR] ${incompletos.length} regla(s) incompletas — no son un`
      + ` incumplimiento probado, pero tampoco están medidas: ${JSON.stringify(incompletos)}`,
    );
  }
  return violaciones;
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
