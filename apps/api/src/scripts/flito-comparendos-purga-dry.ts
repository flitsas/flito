// FLITO comparendos — pasada EN SECO de la purga por retención (Bug #11518, sobre la HU #11511).
//
// Para qué sirve
// ──────────────
// `COMPARENDOS_PURGA_CRON_ENABLED=1` enciende un cron que BORRA: comparendos que nadie ha vuelto a
// ver desde el corte de retención, su timeline por CASCADE y las corridas de sync anteriores al
// corte. La documentación de `.env.example` y RN-30 del cron mandan mirar antes una pasada en seco —
// pero `runComparendosPurgaOnce` no tenía ningún invocador fuera del propio cron, así que la
// instrucción no se podía ejecutar. Esto es ese invocador.
//
// Cuándo se usa
// ─────────────
//   · ANTES de poner `COMPARENDOS_PURGA_CRON_ENABLED=1` en un ambiente con histórico, para saber
//     cuánto se llevaría la primera pasada. El conteo NO está acotado por el tope de lotes: dice
//     cuánto hay en total, no cuánto cabe en una pasada (eso lo dice `truncado`).
//   · ANTES de subir `COMPARENDOS_PURGA_MAX_RATIO`, que es lo único que la RN-30 admite como razón
//     para subirlo: ver el ratio real de una base con años de histórico.
//   · Cuando el log del cron reporte una pasada ABORTADA y haga falta reproducir el freno sin
//     esperar 24 h a la siguiente.
//
//   npm run comparendos:purga:dry -w apps/api
//
// Por qué NO acepta un flag para borrar de verdad
// ───────────────────────────────────────────────
// Es un script pensado para correrse contra producción con las manos de un operador. `dryRun: true`
// va escrito como literal y no sale de `process.argv`: un argumento que lo desactivara convertiría
// la salvaguarda en el arma más fácil de disparar del repositorio —un `--apply` de más en una
// terminal equivocada y el borrado no vuelve—. Si algún día hace falta forzar la pasada real a mano,
// que sea un script SEPARADO, con su propio nombre y su propia revisión.
//
// Qué imprime
// ───────────
// El `ResultadoPurga` COMPLETO, `abortadoPor` incluido. Un operador que ve «abortada» sin saber por
// cuál de las dos causas —ratio o sync obsoleto— no puede decidir nada: la primera se corrige
// subiendo el umbral a conciencia, la segunda arreglando el sync, y confundirlas es exactamente el
// error que borra datos vigentes.
//
// Salida del proceso: 0 si la pasada corrió (aunque el freno saltara: en seco eso es información,
// no un fallo), 1 si reventó, 2 si se invocó con un flag que este script no ofrece.

import { runComparendosPurgaOnce, type ResultadoPurga } from '../modules/flito-comparendos/flito-comparendos-purga.cron.js';
import { env } from '../config/env.js';

/** Flags que un operador podría teclear esperando que borre. Mejor decírselo que dar un falso dry. */
const FLAGS_PROHIBIDOS = ['--apply', '--execute', '--live', '--no-dry-run', '--force'];

const LINEA = '─'.repeat(78);

function imprimir(resultado: ResultadoPurga): void {
  const motivo = resultado.abortadoPor;

  console.log(`\n${LINEA}\n  PURGA DE COMPARENDOS POR RETENCIÓN — PASADA EN SECO (no se borra nada)\n${LINEA}`);
  console.log(`  retención (meses):        ${env.COMPARENDOS_RETENTION_MONTHS}`);
  console.log(`  corte:                    ${resultado.corte}`);
  console.log(`  max ratio (freno):        ${env.COMPARENDOS_PURGA_MAX_RATIO}`);
  console.log(`  max días sin sync:        ${env.COMPARENDOS_PURGA_SYNC_MAX_DIAS}`);
  console.log(`  cron encendido:           ${env.COMPARENDOS_PURGA_CRON_ENABLED ? 'SÍ' : 'no'}`);
  console.log(`${LINEA}`);
  console.log(`  registros a borrar:       ${resultado.registros}`);
  console.log(`  eventos de timeline:      ${resultado.eventos}   (caen por CASCADE con su registro)`);
  console.log(`  corridas de sync:         ${resultado.syncRuns}`);
  console.log(`  truncado:                 ${resultado.truncado ? 'SÍ — no cabe en una pasada, quedará trabajo' : 'no'}`);
  console.log(`  dryRun:                   ${resultado.dryRun}`);
  console.log(`  abortadoPor:              ${motivo ?? 'null (hoy el freno NO saltaría)'}`);

  if (motivo === 'ratio') {
    console.log(`${LINEA}`);
    console.log('  FRENO «ratio»: los candidatos superan COMPARENDOS_PURGA_MAX_RATIO de la tabla.');
    console.log('  Con el cron encendido, la pasada se abortaría ENTERA y no borraría ni una fila.');
    console.log('  Si es la primera puesta al día de una base con histórico, sube el ratio a');
    console.log('  conciencia UNA vez tras revisar estos números. Si no lo es, el corte o el reloj');
    console.log('  (`ultimo_visto_en`) están mal y subir el umbral borraría datos vigentes.');
  } else if (motivo === 'sync_inactivo') {
    console.log(`${LINEA}`);
    console.log('  FRENO «sync_inactivo»: no hay corridas de sync `completed`/`partial` recientes.');
    console.log('  `ultimo_visto_en` solo avanza cuando el sync corre, así que estos candidatos');
    console.log('  pueden ser comparendos VIGENTES que nadie ha vuelto a consultar. NO subas el');
    console.log('  ratio: lo que hay que arreglar es el sync (revisa COMPARENDOS_SIMIT_MODE, el');
    console.log('  token y el log de las últimas corridas).');
  }

  console.log(`${LINEA}`);
  console.log('  ResultadoPurga completo:');
  console.log(JSON.stringify(resultado, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  console.log(`${LINEA}`);
  // Todo en cero puede ser «no hay nada que purgar» o «otra instancia tenía el lock y esta pasada no
  // llegó a mirar». El resultado no las distingue, así que se dice en voz alta en vez de dejar que
  // un cero se lea como una respuesta.
  if (resultado.registros === 0 && resultado.syncRuns === 0) {
    console.log('  Nota: 0 y 0 también es lo que sale si otra instancia tenía el lock');
    console.log('  `flito-comparendos-purga` tomado (el cron corriendo). Repite si tienes dudas.');
    console.log(`${LINEA}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const prohibido = process.argv.slice(2).find((a) => FLAGS_PROHIBIDOS.includes(a));
  if (prohibido) {
    console.error(`\n  ${prohibido} no existe en este script: SOLO hace pasadas en seco, a propósito.`);
    console.error('  La purga real la ejecuta el cron, con su puerta COMPARENDOS_PURGA_CRON_ENABLED');
    console.error('  y sus frenos de RN-30. Este script existe para decidir si encenderlo.\n');
    process.exit(2);
  }

  // `dryRun: true` literal. No se lee de argv y no hay rama que lo cambie (ver cabecera).
  const resultado = await runComparendosPurgaOnce({ dryRun: true });
  imprimir(resultado);
  process.exit(0);
}

main().catch((err) => {
  console.error('purga de comparendos (dry-run) FALLÓ:', err);
  process.exit(1);
});
