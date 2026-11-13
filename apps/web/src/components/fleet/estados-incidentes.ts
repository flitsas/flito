/*
 * Estados de dominio de Incidentes viales (PESV) sobre el registro ESTADO → {tono, glifo} del UI Kit 2026.
 * Claves con prefijo `incidente-` para no chocar con los estados de otros módulos (el registro es global).
 * Un ícono por estado. Uso: <EtiquetaEstado estado={claveEstadoIncidente(i.estado)}>{i.estado}</EtiquetaEstado>.
 */
import { registrarEstados } from '../flit/kit/tonos';

registrarEstados({
  // Estado del incidente
  'incidente-reportado': { tono: 'warn', glifo: 'exclamacion' },
  'incidente-abierto': { tono: 'warn', glifo: 'alerta' },
  'incidente-en_investigacion': { tono: 'info', glifo: 'consulta' },
  'incidente-investigacion': { tono: 'info', glifo: 'consulta' },
  'incidente-cerrado': { tono: 'ok', glifo: 'check' },
  // Gravedad
  'incidente-gravedad-sin': { tono: 'neutro', glifo: 'menos' },
  'incidente-gravedad-leve': { tono: 'warn', glifo: 'exclamacion' },
  'incidente-gravedad-grave': { tono: 'danger', glifo: 'alerta' },
  'incidente-gravedad-fatal': { tono: 'danger', glifo: 'vencido' },
});

/** Clave registrada del estado del incidente (`en investigación` → `incidente-en_investigacion`). */
export function claveEstadoIncidente(estado: string): string {
  return `incidente-${estado.trim().toLowerCase().replace(/\s+/g, '_').normalize('NFD').replace(/[̀-ͯ]/g, '')}`;
}

/** Clave registrada de la gravedad (`sin` | `leve` | `grave` | `fatal`). */
export function claveGravedadIncidente(gravedad: string): string {
  return `incidente-gravedad-${gravedad}`;
}
