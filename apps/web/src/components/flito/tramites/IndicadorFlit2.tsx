// FLITO — Gestión Trámites · «Conexión» de FLIT 2 (HU #13678, Feature #13613; antes indicador en vivo
// de la HU #13189). Spec UX: `docs/ux/flito-tramites-sincronizacion-simplificada.md` (sección #13678).
// Contrato: `Flit2EstadoConexion` (shared-types).
//
// Reglas:
//   · el grupo FLIT 2 ya no muestra la mecánica de la lectura (frecuencia, próxima lectura, cuenta
//     regresiva, reintentos): solo si hay conexión y cuándo fue lo último;
//   · «Conexión» con precedencia (gana la primera fila): sin configurar → apagada en el servidor
//     (maestro o `automatica.activa=false`) → apagada (interruptor) → sin conexión (`problema` o
//     `alerta`) → conectado. Una lectura en curso no cambia el valor;
//   · el punto es estático (sin pulso), `aria-hidden` y usa tokens `-text`, que tienen par oscuro;
//   · jamás se pinta un código ni el texto del API.

import type { Flit2EstadoConexion } from '@operaciones/shared-types';
import type { TonoKit } from '../../flit/kit/tonos';

export type ConexionFlit2 = 'Conectado' | 'Sin conexión' | 'Sin configurar' | 'Apagada' | 'Apagada en el servidor';

/** Cómo está detenida la fuente según la sección Sincronización (interruptor o maestro), si lo está. */
export type DetenidaFlit2 = 'maestro' | 'interruptor' | null;

/** Valor de «Conexión» según la regla de la spec. `detenida` suma lo que sabe la sección de interruptores. */
export function conexionFlit2(d: Flit2EstadoConexion, detenida: DetenidaFlit2 = null): ConexionFlit2 {
  if (!d.configurado) return 'Sin configurar';
  const maestro = detenida === 'maestro' || (d.habilitada === false && d.motivoDeshabilitada === 'maestro');
  if (maestro || d.automatica?.activa === false) return 'Apagada en el servidor';
  if (detenida === 'interruptor' || d.habilitada === false) return 'Apagada';
  if (d.problema || d.alerta) return 'Sin conexión';
  return 'Conectado';
}

/** Tono del kit para la etiqueta de estado con punta (`.kit-etiqueta`, marcador E2E `data-tono`). */
export const TONO_CONEXION: Record<ConexionFlit2, TonoKit> = {
  Conectado: 'ok',
  'Sin conexión': 'danger',
  'Sin configurar': 'neutro',
  Apagada: 'neutro',
  'Apagada en el servidor': 'neutro',
};

/** Punto estático junto al valor de «Conexión»: el texto lleva el significado, el punto solo acompaña. */
export function PuntoFlit2(_props: { conexion: ConexionFlit2 }) {
  return (
    <span aria-hidden="true" className="kit-etiqueta__punto" data-testid="punto-flit2" />
  );
}

/**
 * HU #13634: umbral de atraso `U = 2 · intervaloMs + 5 min` (el mismo del servidor), en minutos
 * enteros; null sin un intervalo válido (entonces no se afirma un tiempo).
 */
export function umbralMin(intervaloMs: number | null | undefined): number | null {
  if (typeof intervaloMs !== 'number' || !Number.isFinite(intervaloMs) || intervaloMs <= 0) return null;
  return Math.round((2 * intervaloMs + 5 * 60_000) / 60_000);
}

/** «15 minutos»; desde 60 min, «2 h» o «2 h 5 min». */
export function duracionUmbral(min: number): string {
  if (min < 60) return `${min} minutos`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}
