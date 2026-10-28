// FLITO — canal Cliente del SOAT: copy y reglas del TIPO de solicitud (Inicial / Renovación), HU #14019.
//
// Diseño: docs/ux/flito-soat-cliente-tipo-renovacion-slim.md (§3.4 mapeo de mensajes, §5 tarjeta
// «Ya está en FLITO», §6 pastilla). Aquí vive solo texto y validación pura; ninguna función toca la red.
//
// **Nunca el código ni el texto crudo del API** (AC8): todo lo que no se reconoce cae en el genérico.

import { CodigoErrorSolicitudSoat, TipoSoat, type SoatFlitoContexto } from '@operaciones/shared-types';
import type { DesenlaceRunt, FalloCanal } from './soatCliente';
import { fechaLargaOGuion } from './soatCliente';

/** Rótulo de la pastilla neutra de la cola y del detalle (UX §6, delta 1). */
export const ROTULO_TIPO: Record<TipoSoat, string> = {
  [TipoSoat.INICIAL]: 'Inicial',
  [TipoSoat.RENOVACION]: 'Renovación',
};

/** Subtítulo de la cabecera según el tipo (UX §3.1). No es región viva: el anuncio lo hace el selector. */
export function subtituloSolicitud(tipo: TipoSoat | null): string {
  if (tipo === TipoSoat.RENOVACION) {
    return 'Escriba la placa y el documento del propietario, adjunte la factura si la tiene y complete el propietario.';
  }
  if (tipo === TipoSoat.INICIAL) return 'Escriba el VIN, adjunte la factura de venta y complete el propietario.';
  return 'Elija el tipo de SOAT para empezar.';
}

export const MENSAJE_ELIJA_TIPO = 'Elija el tipo de SOAT antes de consultar.';
export const ANUNCIO_TIPO: Record<TipoSoat, string> = {
  [TipoSoat.INICIAL]: 'Formulario de SOAT inicial',
  [TipoSoat.RENOVACION]: 'Formulario de renovación',
};

// ───────────────────────────── Placa y documento (bloque 1 de la renovación) ──────────────────────

export const normalizarPlaca = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function errorPlaca(v: string): string | null {
  const n = normalizarPlaca(v);
  return n.length >= 5 && n.length <= 7 ? null : 'Escriba la placa sin espacios, por ejemplo ABC123.';
}

export function errorDocumentoVehiculo(v: string): string | null {
  const n = v.trim();
  return n.length >= 4 && n.length <= 30 ? null : 'Escriba el documento del propietario.';
}

// ───────────────────────────── Desenlaces del RUNT en renovación (UX §3.4) ───────────────────────

const SIN_ANTERIOR: DesenlaceRunt = {
  tono: 'warning',
  titulo: 'El RUNT no registra un SOAT anterior para esta placa',
  detalle: 'Si este vehículo nunca ha tenido SOAT, elija «SOAT inicial» arriba para solicitarlo.',
  foco: 'placa',
};
const DOCUMENTO_NO_CORRESPONDE: DesenlaceRunt = {
  tono: 'warning',
  titulo: 'El documento no corresponde al propietario de esta placa',
  detalle: 'Revise el número del documento y vuelva a consultar.',
  foco: 'documento',
};
const PLACA_NO_CUADRA: DesenlaceRunt = {
  tono: 'danger',
  titulo: 'Revise la placa: no coincide con la que el RUNT tiene registrada.',
  detalle: 'Compruébela en la tarjeta de propiedad y vuelva a consultar.',
  foco: 'placa',
};
const PLACA_SIN_REGISTRO: DesenlaceRunt = {
  tono: 'danger',
  titulo: 'El RUNT no tiene registrado ningún vehículo con esa placa.',
  detalle: 'Compruébela en la tarjeta de propiedad y vuelva a consultar.',
  foco: 'placa',
};
/** En renovación «completar» pide solo el propietario: la factura es opcional (UX §3.3). */
const RUNT_CAIDO_RENOVACION: DesenlaceRunt = {
  tono: 'warning',
  titulo: 'El RUNT no está respondiendo en este momento.',
  detalle: 'Puede volver a consultar, o completar el propietario y guardar la solicitud pendiente de validar. Lo que escriba no se pierde.',
  foco: 'boton',
  guardable: true,
};
/** El genérico pulido de la renovación: jamás el texto ni el código del API (UX §3.4). */
export const DESENLACE_GENERICO_RENOVACION: DesenlaceRunt = {
  tono: 'warning',
  titulo: 'No pudimos consultar el vehículo',
  detalle: 'Revise la placa y el documento, o inténtelo de nuevo en unos minutos.',
  foco: 'boton',
};

/**
 * El desenlace de un fallo de la renovación, o `null` si no es de esta familia (la rama común de
 * `reaccionA` lo resuelve). `SOAT_SIN_ANTERIOR` solo existe aquí; los demás se redactan hablando de la
 * placa y del documento, no del VIN.
 *
 * El backend solo devuelve `campo: 'vin' | 'placa'` en `runt_no_cuadra`: con `placa` se habla de la
 * placa; sin ese campo lo único que queda por cuadrar es el documento del propietario.
 */
export function desenlaceRenovacion(f: FalloCanal): DesenlaceRunt | null {
  switch (f.codigo) {
    case CodigoErrorSolicitudSoat.SOAT_SIN_ANTERIOR: return SIN_ANTERIOR;
    case CodigoErrorSolicitudSoat.RUNT_NO_CUADRA: return f.campo === 'placa' ? PLACA_NO_CUADRA : DOCUMENTO_NO_CORRESPONDE;
    case CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO: return PLACA_SIN_REGISTRO;
    case CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE: return RUNT_CAIDO_RENOVACION;
    default: return null;
  }
}

// ───────────────────────────── «Ya está en FLITO» (UX §5) ────────────────────────────────────────

export interface CopyRenovar {
  titulo: string;
  chip: string | null;
  /** `warning` para el vencido, `active` para el resto. */
  tono: 'active' | 'warning';
  frase: string;
  /** «Podrá renovarlo cuando falten 30 días o menos.» solo fuera de ventana. */
  detalle: string | null;
  /** Con proceso abierto o fuera de ventana no hay «Renovar». */
  puedeRenovar: boolean;
}

const diasTexto = (n: number): string => (n === 1 ? 'queda 1 día' : `quedan ${n} días`);

export function copyRenovar(ctx: SoatFlitoContexto): CopyRenovar {
  const dias = ctx.diasVigencia;
  const fecha = ctx.venceEl ? fechaLargaOGuion(ctx.venceEl) : null;
  if (dias !== null && dias < 0) {
    return {
      titulo: 'Ya está en FLITO · venció', chip: 'Renuévelo para dejarlo vigente', tono: 'warning',
      frase: fecha ? `Venció el ${fecha}.` : 'Venció.', detalle: null, puedeRenovar: ctx.renovable,
    };
  }
  if (ctx.renovable) {
    return {
      titulo: dias === 0 ? 'Ya está en FLITO · vence hoy' : `Ya está en FLITO · ${diasTexto(dias ?? 0)}`,
      chip: 'Puede renovarlo ya', tono: 'active',
      frase: fecha ? `Vence el ${fecha}.` : 'Vence pronto.', detalle: null, puedeRenovar: true,
    };
  }
  return {
    titulo: dias === null ? 'Ya está en FLITO' : `Ya está en FLITO · ${diasTexto(dias)}`,
    chip: null, tono: 'active',
    frase: fecha ? `Vence el ${fecha}.` : '',
    detalle: 'Podrá renovarlo cuando falten 30 días o menos.', puedeRenovar: false,
  };
}

/** La frase que gana el modal cuando el 409 de Inicial llega con contexto renovable (UX §5). */
export const FRASE_RENOVAR_EN_MODAL =
  'Este vehículo ya tiene SOAT en FLITO. Para un SOAT nuevo no hace falta pedir uno inicial: renueve el que tiene.';

/** ¿El contexto del 409 habilita «Renovar»? Solo con contexto propio, no abierto y en ventana. */
export const esRenovable = (ctx: SoatFlitoContexto | undefined | null): boolean =>
  Boolean(ctx && ctx.yaEnFlito && !ctx.abierto && ctx.renovable);

// ───────────────────────────── Cambio de tipo (UX §4) ────────────────────────────────────────────

export const TITULO_CAMBIAR_TIPO = '¿Cambiar el tipo de SOAT?';
export const TEXTO_CAMBIAR_TIPO = 'Se borrarán los datos que ya escribió o consultó.';
