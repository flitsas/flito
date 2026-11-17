/*
 * Estados de dominio del grupo Conductores y jornada (Épica #14560, S4) sobre el registro ESTADO→{tono, glifo} del kit.
 * Se importa por efecto en las páginas que pintan <EtiquetaEstado estado="…">. Tonos fijados por el integrador y la
 * diseñadora: vigente=ok, por vencer=warn, vencido=danger; alcoholimetría negativa=ok [check], positiva=danger
 * [alerta], pendiente/inconclusa=warn [espera].
 */
import { registrarEstados } from '../flit/kit/tonos';

registrarEstados({
  // Documentos del conductor (licencia, examen psicosensométrico)
  vigente: { tono: 'ok', glifo: 'check' },
  'por-vencer': { tono: 'warn', glifo: 'espera' },
  vencido: { tono: 'danger', glifo: 'alerta' },
  // Jornada (Decreto 1079/2015)
  'jornada-en-curso': { tono: 'info', glifo: 'reloj' },
  'jornada-cerrada': { tono: 'ok', glifo: 'finalizado' },
  'jornada-cierre-auto': { tono: 'warn', glifo: 'alerta' },
  // Resultado de la prueba de alcoholimetría
  'alcohol-negativo': { tono: 'ok', glifo: 'check' },
  'alcohol-positivo': { tono: 'danger', glifo: 'alerta' },
  'alcohol-inconcluso': { tono: 'warn', glifo: 'espera' },
  'alcohol-pendiente': { tono: 'warn', glifo: 'espera' },
});

/** Clave de registro para el resultado de alcoholimetría que llega del API (`negativo|positivo|inconcluso|…`). */
export function estadoAlcohol(resultado: string): string {
  return `alcohol-${resultado}`;
}
