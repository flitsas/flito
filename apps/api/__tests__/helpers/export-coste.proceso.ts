// FLITO — proceso hijo de la medición de exports (Bug #13030, sobre la HU #11651).
//
// Lo arranca `medirEnProcesoFresco` (`export-coste.ts`) con `child_process.fork`; NO es un test ni se
// importa desde ninguno. Existe para que la medición del par de exports corra en un proceso que no
// ha hecho nada antes: sin los módulos, el heap ni las arenas del allocator que el worker de Vitest
// arrastra de la suite. Por qué eso importa está en la cabecera de
// `flito-comparendos-export-concurrencia.test.ts`.
//
// Protocolo: recibe el escenario como JSON en `argv[2]`, genera las filas AQUÍ (pasarlas por IPC
// dejaría el array serializado en el heap del hijo antes del reposo) y devuelve la `Medicion` por el
// canal IPC. Cualquier fallo sale con código ≠ 0 y el mensaje en stderr: el padre lo convierte en un
// test rojo, nunca en una medición vacía.

import {
  medirExports, filasPeorCaso, filasRealistas, type Medicion, type EscenarioMedicion,
} from './export-coste.js';

async function main(): Promise<void> {
  const escenario = JSON.parse(process.argv[2] ?? '') as EscenarioMedicion;
  const generar = escenario.filas === 'peor' ? filasPeorCaso : filasRealistas;
  const lotes = Array.from({ length: escenario.simultaneos }, () => generar(escenario.n));
  const m: Medicion = await medirExports(lotes);
  await new Promise<void>((resolve, reject) => {
    process.send!(m, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[export-coste.proceso] ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
