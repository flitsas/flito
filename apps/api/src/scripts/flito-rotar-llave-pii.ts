/**
 * Feature #13978, HU #13987 (ADR-0034 D3) — rotación de `PII_ENC_KEY`.
 *
 * Runbook: `docs/arquitectura/runbook-rotacion-llave-pii.md`. Léelo antes de ejecutar en un ambiente remoto.
 *
 * Exactamente un modo:
 *   --dry-run --target-version=N    descifra, recifra en memoria y cuenta; cero escrituras
 *   --commit --target-version=N     recifra a la versión vigente; reanudable e idempotente
 *   --verificar --target-version=N  sale 0 solo si cada celda está en N y es legible. Gate para retirar la llave anterior
 *   --solo-llaves                   compara las llaves con el registro. Para la prueba de custodia
 *   --limpiar-objetos               borra los objetos anteriores de MinIO, al cerrar la ventana de rollback
 *
 * Salida: 0 terminada; 2 quedan pendientes, se puede volver a correr; 1 abortó con cero escrituras.
 * Imprime conteos e ids de fila. Nunca valores, causas, llaves, claves de objeto ni `numero` de manifiesto.
 */

import { codigoSalidaRotacion, ejecutarRotacion, type ModoRotacion, type OpcionesRotacion } from '../modules/privacy/rotacion/motor.js';

const MODOS_CON_VERSION: readonly ModoRotacion[] = ['dry-run', 'commit', 'verificar'];
const MODOS: readonly ModoRotacion[] = [...MODOS_CON_VERSION, 'solo-llaves', 'limpiar-objetos'];
const RE_VERSION = /^--target-version=([1-9]\d*)$/;

/** `null` si los argumentos no son exactamente un modo con lo que ese modo exige. */
export function opcionesDesdeArgs(args: string[]): OpcionesRotacion | null {
  const modos = MODOS.filter((m) => args.includes(`--${m}`));
  const versiones = args.filter((a) => a.startsWith('--target-version'));
  const conocidos = modos.length + versiones.length;
  if (modos.length !== 1 || conocidos !== args.length) return null;
  const [modo] = modos;
  if (!MODOS_CON_VERSION.includes(modo)) return versiones.length === 0 ? { modo } : null;
  const coincide = versiones.length === 1 ? RE_VERSION.exec(versiones[0]) : null;
  return coincide ? { modo, versionObjetivo: Number(coincide[1]) } : null;
}

const argv1 = process.argv[1] ?? '';
const isDirectRun = (
  process.env.VITEST !== 'true' &&
  process.env.NODE_ENV !== 'test' &&
  (argv1.endsWith('flito-rotar-llave-pii.ts') || argv1.endsWith('flito-rotar-llave-pii.js'))
);

if (isDirectRun) {
  const opciones = opcionesDesdeArgs(process.argv.slice(2));
  if (!opciones) {
    console.error('[abort] indica un modo: --dry-run, --commit o --verificar con --target-version=N; o --solo-llaves; o --limpiar-objetos');
    process.exit(1);
  }
  ejecutarRotacion(opciones).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (r.abortado) console.error(`[abort] ${r.motivoAborto}; no se escribió nada`);
    process.exit(codigoSalidaRotacion(r));
  }).catch((e) => {
    console.error('[error]', e instanceof Error ? e.name : 'fallo');
    process.exit(1);
  });
}
