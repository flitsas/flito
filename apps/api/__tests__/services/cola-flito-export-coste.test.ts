// FLITO — coste de construir el `.xlsx` de las colas de SOAT e Impuestos (HU #11934, ADR-0004
// §Coste).
//
// ── Por qué esta medición es obligatoria en ESTA HU ─────────────────────────────────────────────
//
// ADR-0004 decidió el tope de filas y la cuota de exports **con un número medido delante**, y ese
// número salió de una hoja de QUINCE columnas. Su frontera está escrita: «cinco exports simultáneos
// = +239 MB de los 262 disponibles», o sea **23 MB de margen** hasta el `max_memory_restart: '512M'`
// de PM2 (`ecosystem.config.cjs`). La HU #11934 lleva la hoja de las colas de once columnas a
// veinticinco: 1,67 veces la hoja con la que se calibró el margen.
//
// Con 23 MB de holgura, «se parece a la otra, no pasará nada» no es una respuesta. Y no se puede
// estimar por regla de tres: el ancho de las columnas no se traduce linealmente en bytes de heap
// —`exceljs` comparte la tabla de cadenas, el ZIP comprime, y el propio ADR advierte que a esa escala
// pesa tanto el ruido del allocator y del GC como el tamaño del libro—. Se mide.
//
// ── Qué mide y qué NO ───────────────────────────────────────────────────────────────────────────
//
// Mide la construcción del workbook en el proceso —que es donde está el riesgo: `sendExcel` hace
// `workbook.xlsx.write(res)` con el libro ENTERO en el heap— con filas sintéticas de la forma real y
// **con la lista de columnas de producción**, no una copia. No mide la consulta contra una tabla
// poblada: eso necesita PostgreSQL con volumen y está declarado fuera de alcance desde la HU #11651.
//
// El instrumento es el mismo de comparendos (`../helpers/export-coste.ts`), parametrizado por esta HU
// para aceptar la lista de columnas: antes la tenía incrustada y no sabía medir más de una hoja.
//
// Los umbrales son de ORDEN DE MAGNITUD y no marcas de rendimiento: la máquina de CI no es la de
// nadie más y un test que salte por 300 ms se acaba borrando. Lo que tienen que cazar es el cambio
// que convierta este endpoint en un riesgo de disponibilidad.

import { describe, it, expect, vi } from 'vitest';
import {
  columnasFaltantes, filaCola, filasCola, medirExports, PRESUPUESTO_MB, reportar,
} from '../helpers/export-coste.js';
import { COLUMNAS_COLA_EXPORT } from '../../src/shared/export/cola-flito-excel.js';

/**
 * La lista de columnas vive en el mismo módulo que `exportColaLimiter`, y ese limitador se construye
 * al importar: sin este mock, `makeStore` abre un cliente de Redis que en CI no existe y la suite
 * termina con rechazos no atendidos aunque las tres mediciones pasen. Se mockea el cliente y no se
 * mueve la constante: el archivo se mide contra la lista de PRODUCCIÓN o no se está midiendo nada.
 */
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/** El tope real de producción (`FLITO_COLA_EXPORT_MAX_FILAS`), no el reducido de las suites funcionales. */
const FILAS = 2_000;

/**
 * Cuántos exports simultáneos hay que presupuestar.
 *
 * `exportColaLimiter` es `max: 5` por minuto y **por usuario**, cuenta al entrar la petición y no en
 * vuelo, y no hay cota global ni semáforo: una sola sesión puede tener los cinco construyéndose a la
 * vez. Es el escenario que ADR-0004 midió y el que decide el margen, no el export aislado.
 */
const SIMULTANEOS = 5;

/**
 * La señal de reapertura de ADR-0004 §Coste para UN export: «delta de RSS > ~150 MB» obliga a
 * reconsiderar la decisión y pasar a `WorkbookWriter` o a export asíncrono.
 */
const SENAL_REAPERTURA_MB = 150;

/** AC3 de la HU #11651: el event loop se degrada durante la generación, pero no se DETIENE. */
const ATENCION_MINIMA = 0.15;

describe('la hoja de 25 columnas cabe en el presupuesto de heap (ADR-0004 §Coste)', () => {
  it('el generador produce **todas** las columnas del archivo real', () => {
    // Sin esto, la medición mediría una hoja más estrecha que la de producción y diría que el export
    // es barato. Es literalmente lo que pasó entre la HU #11712 y la #11651 en comparendos: el
    // generador se quedó en 19 claves, el archivo pasó a 21 y nadie tocó la medición. Se compara
    // contra la constante de PRODUCCIÓN, no contra un número escrito a mano.
    expect(columnasFaltantes(COLUMNAS_COLA_EXPORT, filaCola(0))).toEqual([]);
    expect(COLUMNAS_COLA_EXPORT).toHaveLength(25);
  });

  // `retry: 0`: el reintento del config global correría sobre el proceso que acaba de fallar, con el
  // RSS ya crecido, y convertiría cualquier aserción de memoria en un pase gratis.
  it('UN export al tope: duración, memoria y lag', { timeout: 120_000, retry: 0 }, async () => {
    const m = await medirExports([filasCola(FILAS)], COLUMNAS_COLA_EXPORT);
    reportar('cola FLITO · 25 columnas · 1 export', FILAS, m);

    expect(m.bytesPorExport[0]).toBeGreaterThan(0);
    expect(m.rssDeltaMB).toBeLessThan(SENAL_REAPERTURA_MB);
    expect(m.rssDeltaMB).toBeLessThan(PRESUPUESTO_MB);
    expect(m.ms).toBeLessThan(30_000);
    // El event loop se bloquea a ratos —comprimir el ZIP es trabajo síncrono en este mismo hilo— y el
    // ADR lo predecía. Lo que no puede pasar es que se bloquee SEGUNDOS: ahí el resto del API deja de
    // responder mientras alguien descarga.
    expect(m.lagMaxMs).toBeLessThan(5_000);
    expect(m.atencion).toBeGreaterThan(ATENCION_MINIMA);
  });

  it('**los CINCO simultáneos que permite la cuota caben en el presupuesto**', { timeout: 180_000, retry: 0 }, async () => {
    // El escenario que decide, y el que ADR-0004 dejó a 23 MB del techo con quince columnas. Los
    // cinco `sendExcel` se lanzan sin `await` entre medias a propósito: encadenarlos daría cinco
    // exports SECUENCIALES sobre un proceso caliente, que mide otra cosa.
    //
    // ── LO MEDIDO (2026-08-31, HU #11934) ─────────────────────────────────────────────────────
    //
    //   · UN export al tope: **+89,1 MB** de RSS, heap pico 134,8 MB, 678 ms, archivo 0,2 MB.
    //   · CINCO simultáneos, proceso EN FRÍO (este caso corrido solo, tres veces):
    //     **220,3 · 164,7 · 219,7 MB** de RSS añadido sobre un presupuesto de 262. Peor observado:
    //     220,3 MB → **~42 MB de margen**.
    //   · CINCO simultáneos con el proceso ya calentado por el caso de arriba: 131,7 MB. Es el
    //     número OPTIMISTA —el RSS no se devuelve al sistema operativo entre escenarios— y por eso
    //     no es el que se cita.
    //
    // **La hoja de 25 columnas cuesta MENOS que los 239 MB que ADR-0004 midió con quince**, y no es
    // una paradoja: aquella hoja es la de comparendos, con una columna de observación de hasta mil
    // caracteres; esta tiene 25 columnas ESTRECHAS, la mitad de ellas constantes o repetidas
    // (`Puertas`, `N_I`, `ClaseId`, `ClaseDeInterlocutor`, `Servicio`) que `exceljs` guarda una sola
    // vez en su tabla de cadenas. El margen contra el `max_memory_restart` pasa de 23 a ~42 MB: la
    // HU no lo estrecha. La dispersión entre corridas (165–220 MB) es el bimodalismo del allocator
    // que documenta `export-coste.ts`; se cita el peor.
    //
    // Ojo al leer el delta en una corrida COMPLETA del archivo: este caso va sobre un proceso ya
    // calentado por el anterior y su incremento sale más pequeño. El aserto se hace contra el
    // PRESUPUESTO, que es lo que separa al API de un reinicio de PM2.
    const lotes = Array.from({ length: SIMULTANEOS }, () => filasCola(FILAS));
    const m = await medirExports(lotes, COLUMNAS_COLA_EXPORT);
    reportar('cola FLITO · 25 columnas · 5 simultáneos', FILAS, m);

    // Los cinco archivos tienen que salir ENTEROS: un export que se quedara a medias bajaría el pico
    // y haría pasar la medición por el motivo contrario al que se busca.
    expect(m.bytesPorExport).toHaveLength(SIMULTANEOS);
    for (const bytes of m.bytesPorExport) expect(bytes).toBeGreaterThan(0);

    expect(m.rssDeltaMB).toBeLessThan(PRESUPUESTO_MB);
    expect(m.ms).toBeLessThan(120_000);
    expect(m.atencion).toBeGreaterThan(ATENCION_MINIMA);
  });
});
