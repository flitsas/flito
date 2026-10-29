// FLITO — Logística · registro masivo de viajes adicionales (HU #14128, Feature #14095).
// Diseño: `docs/ux/viajes-adicionales-masivo-14128-slim.md`. Funciones puras: lo que se pega, lo que se
// valida y el copy de cada rechazo. La placa es cuasi-PII: vive en estado y body, nunca en URL,
// localStorage ni consola.

import type { ViajeLogistica } from '@operaciones/shared-types';

export const MAX_PLACAS_MASIVO = 200;
export const RUTA_VIAJES_MASIVO = '/flito/logistica/viajes/masivo';

export interface CandidatoMasivo { tramiteId: string; idFlit: string }
export interface CreadoMasivo { placa: string; tramiteId: string; idFlit: string; viaje: ViajeLogistica }
export interface RechazoMasivo { placa: string; motivo: string; codigo: string; candidatos?: CandidatoMasivo[] }
export interface RespuestaMasivo { creados: CreadoMasivo[]; rechazados: RechazoMasivo[] }

export interface PlacaPegada { placa: string; valor: string }

/** «350.000», «$ 350000» → «350000». Lo que no es un entero queda tal cual para que se marque. */
export function limpiarValor(crudo: string): string {
  const t = crudo.replace(/[$\s]/g, '');
  const sinMiles = t.replace(/\./g, '');
  return /^\d+$/.test(sinMiles) ? sinMiles : t;
}

const ES_NUMERO = /^\$?[\d.]+$/;

/** Una placa por línea o separadas por coma, `;`, espacio o tab; una 2.ª columna numérica es el valor. */
export function parsearPlacas(texto: string): PlacaPegada[] {
  const salida: PlacaPegada[] = [];
  for (const linea of texto.split(/\r?\n/)) {
    const tokens = linea.replace(/\$\s+/g, '$').split(/[\t;, ]+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.length === 2 && ES_NUMERO.test(tokens[1])) {
      salida.push({ placa: tokens[0].toUpperCase(), valor: limpiarValor(tokens[1]) });
    } else {
      for (const t of tokens) salida.push({ placa: t.toUpperCase(), valor: '' });
    }
  }
  return salida;
}

export interface ResultadoAgregar { nuevas: PlacaPegada[]; repetidas: number; sobrantes: PlacaPegada[] }

/** Separa lo que entra, lo repetido (se omite) y lo que no cabe en el tope (se queda en el cuadro). */
export function repartirPegado(pegadas: PlacaPegada[], existentes: readonly string[]): ResultadoAgregar {
  const vistas = new Set(existentes);
  const nuevas: PlacaPegada[] = [];
  const sobrantes: PlacaPegada[] = [];
  let repetidas = 0;
  for (const p of pegadas) {
    if (vistas.has(p.placa)) { repetidas++; continue; }
    vistas.add(p.placa);
    if (existentes.length + nuevas.length < MAX_PLACAS_MASIVO) nuevas.push(p);
    else sobrantes.push(p);
  }
  return { nuevas, repetidas, sobrantes };
}

export const textoDeSobrantes = (s: readonly PlacaPegada[]): string =>
  s.map((p) => (p.valor ? `${p.placa}\t${p.valor}` : p.placa)).join('\n');

/** null = válido. Entero ≥ 0 en pesos (0 se permite); el servidor es la fuente de verdad del máximo. */
export function errorDeValor(valor: string): string | null {
  const v = valor.trim();
  if (v === '') return 'Escribe el valor.';
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) return 'Usa solo números, sin decimales.';
  return null;
}

export const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`;

/** Rechazos que se arreglan editando la lista (el resto queda solo en el resumen). */
export const CODIGOS_CORREGIBLES: readonly string[] = ['NO_ENCONTRADO', 'PLACA_INVALIDA', 'VALOR_INVALIDO'];

/** Copy por código (tuteo). Nunca se pinta el `motivo` crudo del servidor. */
export function textoDeRechazo(r: Pick<RechazoMasivo, 'codigo' | 'candidatos'>): string {
  switch (r.codigo) {
    case 'NO_ENCONTRADO': return 'No encontramos un trámite aprobado para esta placa. Revisa que esté bien escrita.';
    case 'VARIOS_TRAMITES_APROBADOS': {
      const ids = (r.candidatos ?? []).map((c) => c.idFlit).join(', ');
      return `Esta placa tiene varios trámites aprobados${ids ? ` (${ids})` : ''}. Regístrale el viaje desde el detalle de uno de ellos.`;
    }
    case 'PLACA_INVALIDA': return 'La placa no tiene un formato válido. Corrígela y reintenta.';
    case 'PLACA_REPETIDA': return 'La placa estaba más de una vez en la lista; solo se tomó una.';
    case 'VALOR_INVALIDO': return 'El valor no es válido. Escribe un valor en pesos, sin decimales, desde $0.';
    case 'TRAMITE_LIQUIDADO': return 'El trámite ya está liquidado. Reversa la liquidación para registrar el viaje.';
    case 'LOGISTICA_AUTOGESTIONADA': return 'La logística de esta compañía la gestiona el cliente.';
    default: return 'No se pudo registrar este viaje. Inténtalo de nuevo más tarde.';
  }
}

export interface FalloSolicitud { mensaje: string; reintentable: boolean }

/** Error de TODA la solicitud (red, 5xx, 403, 400/422): copy por causa, nunca `e.message`. */
export function falloDeSolicitud(status: number): FalloSolicitud {
  if (status === 403) return { mensaje: 'No tienes permiso para registrar viajes.', reintentable: false };
  if (status === 400 || status === 422) {
    return { mensaje: 'No pudimos registrar los viajes. Revisa la lista; tus placas siguen ahí.', reintentable: false };
  }
  return { mensaje: 'No pudimos registrar los viajes. Tus placas siguen en la lista; vuelve a intentarlo.', reintentable: true };
}
