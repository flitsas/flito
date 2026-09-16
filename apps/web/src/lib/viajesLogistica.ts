// FLITO — Viajes adicionales DE UN TRÁMITE en la consola logística: lo que la sección del detalle,
// la fila y el modal de registro comparten sin ser UI (HU #12620, Feature #12617, Épica #12244).
// Diseño: `docs/ux/flito-logistica-viajes.md`.
//
// Todo lo que hay aquí es puro y se prueba sin DOM: la ruta, el copy de los totales y de la forma
// de fijación, la validez del formulario, el cuerpo del POST y la lectura de un fallo.

import {
  CODIGO_VIAJE_LOGISTICA, MOTIVO_VIAJE_LOGISTICA_LABEL, MOTIVOS_VIAJE_LOGISTICA,
  type ModoPrecioViaje, type MotivoViajeLogistica, type ViajeLogistica,
} from '@operaciones/shared-types';
import { ApiError, errorMessage } from './api.ts';
import { pesos } from './pesos.ts';

/** Los tres verbos cuelgan de la misma ruta; el DELETE le añade `/:viajeId`. */
export const rutaViajesDeTramite = (tramiteId: string): string =>
  `/flito/logistica/tramites/${tramiteId}/viajes`;

/** Opciones del selector de motivo, en el orden del catálogo compartido. */
export const OPCIONES_MOTIVO: readonly { valor: MotivoViajeLogistica; etiqueta: string }[] =
  MOTIVOS_VIAJE_LOGISTICA.map((valor) => ({ valor, etiqueta: MOTIVO_VIAJE_LOGISTICA_LABEL[valor] }));

export const MAX_DETALLE = 300;

/** «Viajes: 3 (incluye el viaje 1)». El N viene del servidor: aquí no se suma nada. */
export const textoTotalViajes = (totalViajes: number): string => `Viajes: ${totalViajes} (incluye el viaje 1)`;

/** «Adicionales: $107.000». El importe viene del servidor. */
export const textoTotalAdicionales = (totalAdicionales: number): string => `Adicionales: ${pesos(totalAdicionales)}`;

/**
 * Cómo se fijó el precio de un viaje, para la fila: «Tarifa vigente» cuando copió la tarifa;
 * «Precio manual (tarifa $45.000)» cuando se fijó a mano habiendo tarifa, para que se vea la
 * desviación; y «Precio manual · sin tarifa vigente» cuando no había con qué compararlo.
 */
export function etiquetaFijacion(viaje: Pick<ViajeLogistica, 'modo' | 'tarifaVigente'>): string {
  if (viaje.modo === 'inicial') return 'Tarifa vigente';
  return viaje.tarifaVigente === null ? 'Precio manual · sin tarifa vigente' : `Precio manual (tarifa ${pesos(viaje.tarifaVigente)})`;
}

/** «Devolución» · «Otro: cliente pidió entrega en sede norte». */
export function textoMotivo(viaje: Pick<ViajeLogistica, 'motivo' | 'motivoDetalle'>): string {
  const etiqueta = MOTIVO_VIAJE_LOGISTICA_LABEL[viaje.motivo];
  const detalle = viaje.motivoDetalle?.trim();
  return detalle ? `${etiqueta}: ${detalle}` : etiqueta;
}

/** Lo que dice la confirmación en fila de «Quitar»: qué se pierde y cuál es el camino de vuelta. */
export const textoConfirmarQuitar = (viaje: Pick<ViajeLogistica, 'numero' | 'valor'>): string =>
  `Se quitará el viaje N.º ${viaje.numero} de ${pesos(viaje.valor)}. Para corregirlo tendrás que registrarlo de nuevo.`;

// ── El formulario de registro ─────────────────────────────────────────────────────────────────────

export interface FormularioViaje {
  motivo: MotivoViajeLogistica | '';
  detalle: string;
  modo: ModoPrecioViaje;
  /** Lo tecleado en «Nuevo precio», tal cual: la validez la decide `precioManualValido`. */
  valor: string;
}

/** Un entero no negativo escrito sin nada más: `0` vale, `-1`, `1.5` y `''` no. */
export const precioManualValido = (texto: string): boolean => /^\d+$/.test(texto.trim());

/**
 * Validez del formulario (UX §modal): motivo elegido ∧ (no «Otro» ∨ detalle no vacío) ∧
 * (inicial CON tarifa ∨ manual con entero ≥ 0). Sin tarifa vigente, «inicial» no es válido: no
 * hay nada que copiar y nunca se copia un $0.
 */
export function formularioValido(f: FormularioViaje, tarifaVigente: number | null): boolean {
  if (f.motivo === '') return false;
  if (f.motivo === 'otro' && f.detalle.trim().length === 0) return false;
  if (f.detalle.length > MAX_DETALLE) return false;
  if (f.modo === 'inicial') return tarifaVigente !== null;
  return precioManualValido(f.valor);
}

export type CuerpoRegistro =
  | { modo: 'inicial'; motivo: MotivoViajeLogistica; motivoDetalle?: string }
  | { modo: 'manual'; valor: number; motivo: MotivoViajeLogistica; motivoDetalle?: string };

/**
 * El body del POST. En `inicial` NO viaja `valor` (lo pone el servidor copiando la tarifa); el
 * detalle solo viaja cuando hay algo escrito. Llamar solo con un formulario válido.
 */
export function cuerpoRegistro(f: FormularioViaje): CuerpoRegistro {
  const motivo = f.motivo as MotivoViajeLogistica;
  const detalle = f.detalle.trim();
  const base = detalle ? { motivo, motivoDetalle: detalle } : { motivo };
  return f.modo === 'inicial' ? { modo: 'inicial', ...base } : { modo: 'manual', valor: Number(f.valor.trim()), ...base };
}

// ── Qué hacer con un error ────────────────────────────────────────────────────────────────────────

/** Lo que falla al PEDIR la lista. El 403 no se reintenta: reintentar no lo arregla. */
export interface ErrorCarga { mensaje: string; reintentable: boolean }

export function errorDeCarga(err: unknown): ErrorCarga {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 403) return { mensaje: 'No tienes permiso para ver los viajes.', reintentable: false };
  return { mensaje: `No se pudieron cargar los viajes de este trámite. ${errorMessage(err)}`, reintentable: true };
}

/**
 * La lectura de un fallo del POST o del DELETE, en una sola función pura: qué se dice EN LÍNEA
 * (sin cerrar el modal ni la confirmación) y qué tiene que rehacer la sección.
 */
export interface FalloEscritura {
  mensaje: string;
  /** Repedir la lista: lo que se ve ya no es lo que hay. */
  recargarLista: boolean;
  /** El trámite está liquidado: la sección pasa a solo lectura en el acto, sin sondear. */
  soloLectura: boolean;
  /** 422 sin tarifa: el modal se queda abierto y pasa a «Nuevo precio». */
  forzarManual: boolean;
}

const SIN_NADA = { recargarLista: false, soloLectura: false, forzarManual: false };

export function codigoDe(err: unknown): string | undefined {
  return err instanceof ApiError ? (err.rawDetails as { codigo?: string } | null | undefined)?.codigo : undefined;
}

export function falloDeEscritura(err: unknown, accion: 'registrar' | 'quitar'): FalloEscritura {
  const status = err instanceof ApiError ? err.status : 0;
  const codigo = codigoDe(err);
  // El literal es el del servidor a propósito (AC6, AC8): es el que verá quien lo intente otra vez.
  const delServidor = errorMessage(err);

  if (codigo === CODIGO_VIAJE_LOGISTICA.TRAMITE_LIQUIDADO) {
    return { ...SIN_NADA, mensaje: delServidor, recargarLista: true, soloLectura: true };
  }
  if (codigo === CODIGO_VIAJE_LOGISTICA.LOGISTICA_AUTOGESTIONADA) {
    return { ...SIN_NADA, mensaje: delServidor, recargarLista: true };
  }
  if (codigo === CODIGO_VIAJE_LOGISTICA.TARIFA_LOGISTICA_NO_CONFIGURADA) {
    return { ...SIN_NADA, mensaje: `${delServidor} Elige «Nuevo precio».`, forzarManual: true };
  }
  if (codigo === CODIGO_VIAJE_LOGISTICA.VIAJE_NO_ENCONTRADO) {
    return { ...SIN_NADA, mensaje: 'Ese viaje ya no estaba en el trámite. La lista se actualizó.', recargarLista: true };
  }
  if (status === 404) return { ...SIN_NADA, mensaje: 'Este trámite ya no existe.' };
  if (status === 403) {
    return {
      ...SIN_NADA,
      mensaje: accion === 'registrar'
        ? 'No tienes permiso para registrar viajes.'
        : 'No tienes permiso para quitar viajes.',
    };
  }
  return {
    ...SIN_NADA,
    mensaje: accion === 'registrar'
      ? `No se pudo registrar el viaje. Vuelve a intentarlo. ${delServidor}`
      : `No se pudo quitar el viaje. Vuelve a intentarlo. ${delServidor}`,
  };
}
