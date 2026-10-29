// FLITO Logística — copy y helpers de viajes a cliente (HU #14116).
// El precio `null` no se formatea (nunca `$0` por ausencia). `0` sí es un precio configurado.
import { ApiError } from './api';

export const DESTINO_CLIENTE = 'cliente' as const;

export function formatoPrecio(valor: number): string {
  return `$${valor.toLocaleString('es-CO')}`;
}

export function nombreCompania(nombre: string | null, companiaId: number): string {
  return nombre?.trim() || `compañía #${companiaId}`;
}

export function avisoSinPrecio(nombre: string): string {
  return `La compañía ${nombre} no tiene precio de entrega a cliente`;
}

export function nuevaKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

export function codigoDe(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const c = (e.rawDetails as { codigo?: unknown } | null | undefined)?.codigo;
  return typeof c === 'string' ? c : null;
}

export function mensajeCargarViajes(e: unknown): { texto: string; reintentar: boolean } {
  if (e instanceof ApiError && e.status === 403) {
    return { texto: 'No tienes permiso para registrar viajes.', reintentar: false };
  }
  return { texto: 'No se pudieron cargar las LT listas para viaje.', reintentar: true };
}

export function mensajeCargarEntregas(e: unknown): { texto: string; reintentar: boolean } {
  if (e instanceof ApiError && e.status === 403) {
    return { texto: 'No tienes entregas asignadas.', reintentar: false };
  }
  return { texto: 'No se pudieron cargar tus entregas.', reintentar: true };
}

/** Errores de POST /traslados → copy en el modal. Nunca el mensaje crudo. */
export function mensajeRegistrarViaje(e: unknown, nombre: string): string {
  const c = codigoDe(e);
  if (c === 'PRECIO_TRASLADO_NO_CONFIGURADO') return avisoSinPrecio(nombre);
  if (c === 'PROVEEDOR_LOGISTICA_REQUERIDO') {
    return 'Esta compañía no tiene proveedor de logística. Asígnalo antes de registrar el viaje.';
  }
  if (c === 'LOGISTICA_AUTOGESTIONADA') return 'La logística de esta compañía la gestiona el cliente.';
  if (c === 'LT_YA_EN_TRASLADO' || c === 'LT_ESTADO_NO_ADMISIBLE') {
    return 'Alguna LT de este grupo ya no está lista. Cierra y recarga la lista.';
  }
  if (c === 'LT_AJENA') return 'Solo puedes registrar el viaje de las LT que recogiste tú.';
  if (c === 'TRASLADO_COMPANIA_MIXTA' || c === 'TRASLADO_ORIGEN_MIXTO') {
    return 'Este grupo no se puede registrar junto. Recarga la lista.';
  }
  if (c === 'DESTINO_FLIT_NO_DISPONIBLE') return 'Aquí solo se registran viajes a cliente.';
  return 'No se pudo registrar el viaje. Las LT siguen aquí; vuelve a intentarlo.';
}

/** Errores de POST /actas/:id/entregar → copy en el paso. */
export function mensajeEntregar(e: unknown): string {
  const c = codigoDe(e);
  if (c === 'TRASLADO_ESTADO_NO_ADMISIBLE') {
    return 'Este viaje ya no se puede entregar. Vuelve a Entregas y recarga.';
  }
  if (c === 'TRASLADO_LTS_NO_COINCIDEN') {
    return 'Las LT marcadas no coinciden con este viaje. Recarga y vuelve a marcarlas.';
  }
  if (c === 'ENTREGA_SIN_ENTREGADAS') {
    return 'La entrega necesita al menos una LT. Para devolver todas usa Devolver el viaje.';
  }
  if (e instanceof ApiError && e.status === 403) return 'Esta entrega no es tuya.';
  return 'No se pudo registrar la entrega. Nombre, cédula y firma siguen aquí; vuelve a intentarlo.';
}

export function mensajeDevolverViaje(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return 'Esta entrega no es tuya.';
  return 'No se pudo devolver el viaje. El motivo sigue aquí; vuelve a intentarlo.';
}

export const NOMBRE_RECEPTOR_OK = /^[^\d]{3,}$/;
export const CEDULA_RECEPTOR_OK = /^\d{5,12}$/;
export const MAX_FIRMA = 1_000_000;
