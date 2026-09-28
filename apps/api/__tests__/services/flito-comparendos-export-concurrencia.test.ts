// FLITO comparendos — DOS exports simultáneos (HU #11651 AC1/AC2/AC3, ADR-0004 §Coste).
//
// La HU #11558 midió el coste de UN export y lo dio por bueno. Este archivo mide el escenario que
// aquella medición no cubría y que es el del defecto:
//
//   `exportLimiter` (`flito-comparendos.routes.ts`) es `max: 5` por minuto con
//   `keyGenerator: userOrIpKey(…)` — cuota **por usuario**. No existe ninguna cota global ni
//   semáforo. Dos administradores distintos lanzan un export cada uno en el mismo segundo y el
//   limitador deja pasar a los dos, así que los dos workbooks coexisten en el heap del mismo
//   proceso. `sendExcel` construye el libro ENTERO en memoria (`workbook.xlsx.write(res)`), el API
//   corre en una sola instancia fork y PM2 tiene `max_memory_restart: '512M'`
//   (`ecosystem.config.cjs:22`). Si el par cruza ese techo, PM2 reinicia y se lleva por delante las
//   peticiones en vuelo de TODO el sistema, no solo las de comparendos.
//
// Por qué el par se mide en un PROCESO HIJO recién arrancado (`medirEnProcesoFresco`, Bug #13030) y
// no en el worker de Vitest. Porque el RSS es del proceso y no se devuelve: dentro del worker el
// delta dependía de lo que ese proceso ya había hecho —qué módulos cargó, qué basura y qué arenas
// del allocator dejó— y no solo de los dos workbooks. La HU #11651 lo intentó controlar ordenando
// las mediciones dentro del archivo, pero el orden no controla lo que el worker arrastra de fuera: en
// local, el mismo código daba 94,1 MB corrido solo y 72,9 MB dentro de la suite (el reposo subía 21
// MB y el delta bajaba lo mismo); en CI, PRs que solo añadían código SOAT llevaron el número a 131,4
// · 132,6 · 133,1 MB contra el tope de 131 sin que el export cambiara. Un número que se mueve con la
// suite no mide el export; el tope se conserva y lo que cambia es dónde se mide. Detalle y por qué no
// un pool aparte de Vitest: la documentación de `medirEnProcesoFresco` en `helpers/export-coste.ts`.
//
// Ese mismo efecto de proceso caliente es el que hizo que el «peor caso» de la HU #11558 reportara un
// delta MENOR que su caso realista: no es que fuera más barato, es que ya no había que pedirle
// páginas al sistema operativo.
//
// **Qué mide y qué no.** Mide la construcción del workbook en el proceso —donde está el riesgo de
// memoria— con filas sintéticas de la forma real. NO mide la consulta contra una tabla poblada: eso
// necesita PostgreSQL con volumen y es el AC5, declarado SIN-ENTORNO en la HU (la base local tiene
// menos de tres meses de histórico y el AC pide 24).

import { describe, it, expect } from 'vitest';
import { COMPARENDOS_EXPORT_MAX_FILAS } from '@operaciones/shared-types';
import {
  medirEnProcesoFresco, reportar, columnasFaltantes,
  PRESUPUESTO_MB, TECHO_PM2_MB, REGIMEN_API_MB,
} from '../helpers/export-coste.js';

/** El tope vigente. Si alguien lo sube, esta suite mide el valor nuevo y es ahí donde salta. */
const FILAS = COMPARENDOS_EXPORT_MAX_FILAS;

/**
 * Cuánto puede consumir el par simultáneo, en MB de RSS añadido.
 *
 * La mitad del presupuesto (262 / 2 = 131 MB). No es un número redondo elegido para que pase: es la
 * traducción de «con margen razonable» del AC2 a algo que un test puede comprobar. Que dos exports
 * a la vez se coman la mitad de lo que separa al API del reinicio ya es demasiado, porque el par
 * **no es el peor caso posible** —nada impide un tercero— y porque los 250 MB de régimen son una
 * estimación, no una medida del proceso de producción de hoy.
 *
 * Medido el 2026-08-22 con el tope en 2 000: 106 MB. Con el tope anterior de 5 000: 247 MB, que es
 * el 94 % del presupuesto entero y deja el proceso a 15 MB del `max_memory_restart`.
 *
 * Remedido el 2026-09-28 en proceso fresco con el semiespacio del runtime (Bug #13030): 117,6 · 118,9
 * · 119,4 MB con el tope en 2 000, y 309 MB con el tope en 5 000 (rojo, que es lo que debe dar). El
 * margen real es de ~12 MB, no de los ~58 que sugería el 72,9 que salía dentro de la suite: aquel
 * número era más bajo porque el worker ya traía crecida la memoria que el par tiene que pedir.
 */
const TOPE_DELTA_PAR_MB = PRESUPUESTO_MB / 2;

/**
 * Fracción mínima de turnos que el event loop tiene que seguir dando durante la generación.
 *
 * AC3: «ninguna petición en vuelo del resto del sistema se pierde». Comprimir el ZIP es trabajo
 * síncrono en el hilo que atiende al resto del API, así que el reparto se degrada —el ADR-0004 ya lo
 * predecía— pero no puede DETENERSE. Medido entre 0,26 y 0,41 en condiciones normales; con
 * `sendExcel` mutado para bloquear el hilo seis segundos cae a 0,05. El umbral separa las dos cosas
 * sin convertirse en una marca de rendimiento que la máquina de CI haga saltar sola.
 */
const ATENCION_MINIMA = 0.15;

describe('dos exports simultáneos al tope (HU #11651 AC3)', () => {
  // `retry: 0` y NO es decoración — se descubrió mutando esta suite el 2026-08-22. El
  // `retry: 1` global de `vitest.config.ts` existe por un flake de mocks posicionales en otros
  // módulos, pero aquí era veneno: **el reintento corría sobre el proceso que acababa de fallar**,
  // con el RSS ya crecido por el intento anterior, así que el delta del segundo intento salía pequeño
  // y el test pasaba (tope en 5 000: 223 MB falla, reintento 83 MB pasa). Desde el Bug #13030 cada
  // medición corre en un hijo nuevo y ese mecanismo ya no existe, pero se mantiene en 0: una medición
  // de memoria que falla no es un flake de mocks y no tiene nada que ganar repitiéndose.
  it('el par en el PEOR caso cabe en el presupuesto de memoria del proceso', { timeout: 300_000, retry: 0 }, async () => {
    // Peor caso = la observación al máximo en todas las filas. No es de laboratorio: la columna
    // admite ese texto y nada impide que una operación lo llene. Es el archivo más grande que este
    // endpoint puede producir con el tope vigente, y es el que hay que presupuestar.
    const m = await medirEnProcesoFresco({ filas: 'peor', n: FILAS, simultaneos: 2 });
    reportar('AC3 · peor caso · DOS simultáneos (proceso fresco)', FILAS, m);

    // AC3: «los dos exports terminan correctamente». Se afirma sobre CADA archivo por separado —un
    // total agregado dejaría pasar el caso en que uno sale entero y el otro vacío, que es
    // exactamente la forma que tendría el fallo si los dos compitieran mal por el stream.
    expect(m.bytesPorExport).toHaveLength(2);
    for (const bytes of m.bytesPorExport) expect(bytes).toBeGreaterThan(0);

    // Los dos archivos llevan las MISMAS filas, así que tienen que pesar prácticamente lo mismo: un
    // export truncado a mitad de escritura pesaría una fracción, no un 0,3 % menos.
    //
    // **Y «prácticamente» no es pereza: la igualdad byte a byte NO está garantizada y se comprobó.**
    // `exceljs` estampa el instante de creación en `docProps/core.xml`; si los dos libros se cierran
    // a caballo de un segundo, el texto cambia y el deflate escupe uno o dos bytes de diferencia.
    // Con `toBe` esto sería un test que pasa casi siempre y falla sin motivo de vez en cuando —el
    // peor tipo de test—; salió a la luz mutando `sendExcel` para que bloqueara el hilo (373 991 vs
    // 373 992 bytes) y se corrigió aquí, no relajando el resto.
    const [a, b] = m.bytesPorExport as [number, number];
    expect(Math.abs(a - b) / Math.max(a, b)).toBeLessThan(0.01);

    // AC2 + AC3: el pico proyectado sobre un API en régimen se queda por debajo del techo de PM2.
    // Se afirma sobre el DELTA y no sobre el pico absoluto porque el RSS de partida del proceso de
    // medición (tsx + el instrumento) no es el del API en producción; lo que la ruta AÑADE sí es
    // comparable.
    expect(m.rssDeltaMB).toBeLessThan(TOPE_DELTA_PAR_MB);
    expect(REGIMEN_API_MB + m.rssDeltaMB).toBeLessThan(TECHO_PM2_MB);

    // AC3: «ninguna petición en vuelo del resto del sistema se pierde». El event loop se bloquea a
    // ratos —comprimir el ZIP es trabajo síncrono en este mismo hilo— y el ADR-0004 lo predecía; lo
    // que no puede pasar es que deje de repartir turnos, porque entonces el resto del API no
    // responde mientras dos personas descargan. `turnos` demuestra que siguió repartiendo; el lag
    // acota cuánto esperó el peor de ellos.
    expect(m.atencion).toBeGreaterThan(ATENCION_MINIMA);
    expect(m.lagMaxMs).toBeLessThan(5_000);
  });

  it('el par en el caso realista cuesta menos que el peor caso', { timeout: 300_000, retry: 0 }, async () => {
    // Realista = la observación casi siempre corta o ausente, que es lo que hay hoy en la tabla.
    // También en un hijo fresco (Bug #13030), así que ya no llega contaminado por el peor caso. Aquí
    // sigue sin afirmarse sobre el presupuesto porque el que lo decide es el peor caso —un archivo
    // más pequeño no puede ser el que presupuesta—; solo que los dos archivos salen y que el event
    // loop respira.
    const m = await medirEnProcesoFresco({ filas: 'realista', n: FILAS, simultaneos: 2 });
    reportar('AC3 · realista · DOS simultáneos (proceso fresco)', FILAS, m);

    for (const bytes of m.bytesPorExport) expect(bytes).toBeGreaterThan(0);
    expect(m.atencion).toBeGreaterThan(ATENCION_MINIMA);
    expect(m.lagMaxMs).toBeLessThan(5_000);
  });

  it('la medición cubre TODAS las columnas del archivo real', () => {
    // El guardián del instrumento, y no es hipotético: el generador de filas nacía con 19 columnas
    // en la HU #11558, la HU #11712 añadió `tipoRegistro` y `numeroResolucion` al export y nadie
    // tocó la medición. Desde entonces y hasta la HU #11651 se estuvo midiendo un archivo más
    // estrecho que el que produce el endpoint —y el comentario seguía diciendo «19 columnas», que
    // es la clase de frase que pasa las revisiones porque nadie la recalcula—. Una columna nueva en
    // `COLUMNAS_EXPORT` vuelve a poner esto en rojo en vez de abaratar la medición en silencio.
    expect(columnasFaltantes()).toEqual([]);
  });
});
