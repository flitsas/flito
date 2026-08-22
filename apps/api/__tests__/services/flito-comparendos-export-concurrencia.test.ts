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
// Por qué en un archivo aparte del de `-coste`, que es la pregunta obvia. Porque el RSS no se
// devuelve: un proceso que ya construyó un workbook grande arranca el siguiente escenario con las
// arenas del allocator calientes y el delta sale optimista. Vitest reutiliza los workers entre
// archivos, pero el orden de ejecución dentro de un archivo sí es controlable, y aquí la primera
// medición que corre es la del par simultáneo — la que decide. Ese mismo efecto es el que hizo que
// el «peor caso» de la HU #11558 reportara un delta MENOR que su caso realista: no es que fuera más
// barato, es que ya no había que pedirle páginas al sistema operativo.
//
// **Qué mide y qué no.** Mide la construcción del workbook en el proceso —donde está el riesgo de
// memoria— con filas sintéticas de la forma real. NO mide la consulta contra una tabla poblada: eso
// necesita PostgreSQL con volumen y es el AC5, declarado SIN-ENTORNO en la HU (la base local tiene
// menos de tres meses de histórico y el AC pide 24).

import { describe, it, expect } from 'vitest';
import { COMPARENDOS_EXPORT_MAX_FILAS } from '@operaciones/shared-types';
import {
  medirExports, filasPeorCaso, filasRealistas, reportar, columnasFaltantes,
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
  // módulos, pero aquí es veneno: **el reintento corre sobre el proceso que acaba de fallar**, con
  // el RSS ya crecido por el intento anterior, así que el delta del segundo intento sale pequeño y
  // el test pasa. Medido con el tope puesto de nuevo en 5 000: primer intento 223 MB (falla),
  // reintento 83 MB sobre un reposo de 602 MB (pasa). Con el reintento activo, esta suite habría
  // certificado en verde exactamente la regresión que existe para cazar.
  it('el par en el PEOR caso cabe en el presupuesto de memoria del proceso', { timeout: 300_000, retry: 0 }, async () => {
    // Peor caso = la observación al máximo en todas las filas. No es de laboratorio: la columna
    // admite ese texto y nada impide que una operación lo llene. Es el archivo más grande que este
    // endpoint puede producir con el tope vigente, y es el que hay que presupuestar.
    const m = await medirExports([filasPeorCaso(FILAS), filasPeorCaso(FILAS)]);
    reportar('AC3 · peor caso · DOS simultáneos', FILAS, m);

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
    // Se afirma sobre el DELTA y no sobre el pico absoluto porque el RSS de partida de un worker de
    // Vitest no es el del API en producción; lo que la ruta AÑADE sí es comparable.
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
    // Corre DESPUÉS del peor caso a propósito (ver cabecera): su delta llega ya contaminado por el
    // proceso caliente, así que aquí no se afirma sobre el presupuesto —sería afirmar sobre una
    // medida que se sabe optimista—, solo que los dos archivos salen y que el event loop respira.
    const m = await medirExports([filasRealistas(FILAS), filasRealistas(FILAS)]);
    reportar('AC3 · realista · DOS simultáneos (proceso ya calentado)', FILAS, m);

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
