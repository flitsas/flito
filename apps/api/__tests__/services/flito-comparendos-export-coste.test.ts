// FLITO comparendos — coste de construir el `.xlsx` de UN export (HU #11558, HU #11651, ADR-0004
// §Coste).
//
// El ADR aceptó el tope **con la condición de medirlo** en la HU: duración, delta de memoria y lag
// del event loop. No es un requisito de estilo. `sendExcel` construye el workbook ENTERO en memoria
// (`workbook.xlsx.write(res)`, sin `WorkbookWriter`), y el API corre en una sola instancia fork con
// `max_memory_restart: '512M'` (`ecosystem.config.cjs:22`): si un export legítimo cruzara ese techo,
// PM2 reiniciaría el proceso y se llevaría por delante las peticiones en vuelo de todo el sistema.
// «Un click reinicia el API» es un fallo de disponibilidad que ningún AC de la HU #11558 habría
// detectado.
//
// **Este archivo mide UN export. El que decide el tope es el vecino**,
// `flito-comparendos-export-concurrencia.test.ts`: el `exportLimiter` es por usuario, así que el
// escenario que hay que presupuestar no es un export sino varios coexistiendo en el proceso. La HU
// #11651 bajó el tope de 5 000 a 2 000 con esa medición delante.
//
// El instrumento vive en `../helpers/export-coste.ts` desde la HU #11651, compartido con el archivo
// de concurrencia: la medición dejó de ser un solo escenario y copiarla habría dejado dos
// instrumentos divergiendo.
//
// Los topes de las aserciones son de ORDEN DE MAGNITUD, no marcas de rendimiento: la máquina de CI
// no es la de nadie más, y un test que falle por 300 ms de diferencia se acaba borrando. Lo que
// tienen que cazar es el cambio que convierta este endpoint en un riesgo: pasar de MB a cientos de
// MB, o de segundos a decenas.

import { describe, it, expect } from 'vitest';
import { COMPARENDOS_EXPORT_MAX_FILAS } from '@operaciones/shared-types';
import {
  medirExports, filasRealistas, filasPeorCaso, reportar, PRESUPUESTO_MB,
} from '../helpers/export-coste.js';

/** El tope real de producción, no el reducido de la suite funcional: aquí se mide el peor caso. */
const FILAS = COMPARENDOS_EXPORT_MAX_FILAS;

/**
 * Cuánto puede añadir UN export al RSS del proceso, en MB.
 *
 * 150 MB no es un número inventado: es la **señal de reapertura** que ADR-0004 §Coste dejó escrita
 * («Delta de RSS por export > ~150 MB» obliga a reconsiderar la decisión y pasar a `WorkbookWriter`
 * o a export asíncrono). El tope anterior de 5 000 filas medía 152 MB en el peor caso —o sea que ya
 * la había cruzado, sin que nadie lo hubiera comprobado—; con 2 000 son 93 MB.
 */
const SENAL_REAPERTURA_MB = 150;

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

describe('coste de generar el export en el proceso del API (ADR-0004 §Coste)', () => {
  // `retry: 0`: el reintento del config global corre sobre el proceso que acaba de fallar, con el
  // RSS ya crecido, y convertiría cualquier aserción de memoria en un pase gratis (ver el comentario
  // largo en `flito-comparendos-export-concurrencia.test.ts`, donde se midió).
  it('el tope de filas en caso realista: duración, memoria y lag', { timeout: 120_000, retry: 0 }, async () => {
    const m = await medirExports([filasRealistas(FILAS)]);
    reportar('realista', FILAS, m);

    expect(m.bytesPorExport[0]).toBeGreaterThan(0);
    expect(m.rssDeltaMB).toBeLessThan(SENAL_REAPERTURA_MB);
    // Cordura del presupuesto: un solo export nunca debería acercarse a lo que separa al API del
    // reinicio. Si esto salta, el problema ya no es la calibración.
    expect(m.rssDeltaMB).toBeLessThan(PRESUPUESTO_MB);
    expect(m.ms).toBeLessThan(30_000);
    // El event loop se bloquea a ratos —la compresión del ZIP es trabajo síncrono en este mismo
    // hilo— y el ADR lo predecía. Lo que no puede pasar es que se bloquee SEGUNDOS: ahí el resto del
    // API deja de responder mientras alguien descarga.
    expect(m.lagMaxMs).toBeLessThan(5_000);
    expect(m.atencion).toBeGreaterThan(ATENCION_MINIMA);
  });

  it('el tope de filas en el PEOR caso: observación al máximo en todas', { timeout: 120_000, retry: 0 }, async () => {
    // El archivo más grande que este endpoint puede producir con el tope vigente. No es un escenario
    // de laboratorio: la columna admite ese texto y nada impide que una operación lo llene.
    const m = await medirExports([filasPeorCaso(FILAS)]);
    // Ojo al leer el delta de este segundo caso: corre sobre un proceso ya CALENTADO por el
    // anterior, así que su incremento sale más pequeño de lo que sería en frío —el RSS no se
    // devuelve—. El número comparable entre los dos es el pico absoluto y el de heap, no el delta.
    // Medido en frío (un proceso por escenario) con el tope en 2 000: +93 MB.
    reportar('peor caso (proceso ya calentado por el caso anterior)', FILAS, m);

    expect(m.bytesPorExport[0]).toBeGreaterThan(0);
    expect(m.rssDeltaMB).toBeLessThan(SENAL_REAPERTURA_MB);
    expect(m.ms).toBeLessThan(60_000);
    expect(m.lagMaxMs).toBeLessThan(5_000);
    expect(m.atencion).toBeGreaterThan(ATENCION_MINIMA);
  });
});
