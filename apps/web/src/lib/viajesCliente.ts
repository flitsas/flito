// FLITO Logística — copy y helpers de viajes (HU #14116, destino HU #14123).
// El precio `null` no se formatea (nunca `$0` por ausencia). `0` sí es un precio configurado.
// La pestaña Viajes y la llegada a FLIT hablan de usted. La entrega a cliente sigue tuteando.
import { ApiError } from './api';

export const DESTINO_CLIENTE = 'cliente' as const;
export const DESTINO_FLIT = 'flit' as const;
export type DestinoViaje = typeof DESTINO_CLIENTE | typeof DESTINO_FLIT;

export function formatoPrecio(valor: number): string {
  return `$${valor.toLocaleString('es-CO')}`;
}

export function nombreCompania(nombre: string | null, companiaId: number): string {
  return nombre?.trim() || `compañía #${companiaId}`;
}

/** Mitad de la línea de la tarjeta. Con precio: «Cliente $12.000 por LT». Sin él: «FLIT: falta el precio». */
export function textoPrecioDestino(etiqueta: 'Cliente' | 'FLIT', precio: number | null): string {
  if (precio == null) return `${etiqueta}: falta el precio`;
  return `${etiqueta} ${formatoPrecio(precio)} por LT`;
}

export function avisoSinPrecio(nombre: string, destino: DestinoViaje = DESTINO_CLIENTE): string {
  const cual = destino === DESTINO_FLIT ? 'a FLIT' : 'a cliente';
  return `La compañía ${nombre} no tiene precio de entrega ${cual}.`;
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
    return { texto: 'No tiene permiso para registrar viajes.', reintentar: false };
  }
  return { texto: 'No se pudieron cargar las LT listas para viaje.', reintentar: true };
}

export function mensajeCargarEntregas(e: unknown): { texto: string; reintentar: boolean } {
  if (e instanceof ApiError && e.status === 403) {
    return { texto: 'No tienes entregas asignadas.', reintentar: false };
  }
  return { texto: 'No se pudieron cargar tus entregas.', reintentar: true };
}

/** Errores de POST /traslados → copy en el modal. Nunca el mensaje crudo. `destino` es el POST que falló. */
export function mensajeRegistrarViaje(e: unknown, nombre: string, destino: DestinoViaje = DESTINO_CLIENTE): string {
  const c = codigoDe(e);
  if (c === 'PRECIO_TRASLADO_NO_CONFIGURADO') return avisoSinPrecio(nombre, destino);
  if (c === 'MOTIVO_LLEGADA_REQUERIDO' || c === 'MOTIVO_LLEGADA_INACTIVO' || c === 'MOTIVO_LLEGADA_NO_EXISTE') {
    return 'Elija el motivo de llegada.';
  }
  if (c === 'PROVEEDOR_LOGISTICA_REQUERIDO') {
    return 'Esta compañía no tiene proveedor de logística. Asígnele uno antes de registrar el viaje.';
  }
  if (c === 'LOGISTICA_AUTOGESTIONADA') return 'La logística de esta compañía la gestiona el cliente.';
  if (c === 'LT_YA_EN_TRASLADO' || c === 'LT_ESTADO_NO_ADMISIBLE') {
    return 'Alguna LT de este grupo ya no está lista. Cierre y recargue la lista.';
  }
  if (c === 'LT_AJENA') return 'Solo puede registrar el viaje de las LT que recogió usted.';
  if (c === 'TRASLADO_COMPANIA_MIXTA' || c === 'TRASLADO_ORIGEN_MIXTO') {
    return 'Este grupo no se puede registrar junto. Recargue la lista.';
  }
  return 'No se pudo registrar el viaje. Las LT siguen aquí; vuelva a intentarlo.';
}

/** Errores de POST /traslados/:id/entregar cuando el destino es FLIT. En el paso, no en toast. */
export function mensajeLlegadaFlit(e: unknown): string {
  const c = codigoDe(e);
  if (c === 'FIRMA_LLEGADA_REQUERIDA') return 'Falta la firma de quien recibe en FLIT.';
  if (c === 'DATOS_INVALIDOS') return 'La llegada a FLIT no lleva cédula ni nombre.';
  if (c === 'TRASLADO_ESTADO_NO_ADMISIBLE' || c === 'ACTA_ESTADO_NO_ADMISIBLE') {
    return 'Este viaje ya no está en ruta. Vuelva y recargue.';
  }
  if (e instanceof ApiError && e.status === 403) return 'Esta llegada no es suya.';
  return 'No se pudo registrar la llegada. La firma sigue aquí; vuelva a intentarlo.';
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
