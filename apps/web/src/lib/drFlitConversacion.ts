// Dr. Flit — modelo de conversación (Feature #13694, slim §4). Puro: sin React, `api` ni
// `import.meta`, para que Playwright lo importe desde `src`.
// HU #13765 entrega los tipos de «Explícame un módulo» y `agregar` (memoria del panel). La unión
// crece por `tipo` (#13766: pregunta/citas/sinResultados) y #13767 añade serializar/restaurar sin
// cambiar estas formas. Títulos y resúmenes NUNCA se guardan en el mensaje: se derivan al pintar.

import type { EntradaAyuda } from '../content/ayuda/catalogo';
import type { FichaParseada } from './ayudaFicha';
import { resumenDeEntrada } from './ayudaBusqueda';

export const MAX_MENSAJES = 50;

/** Referencia a una ficha; sin `ancla` = la ficha completa. */
export interface RefFicha {
  clave: string;
  ancla?: string;
}

type Base = { id: string; ts: number };

export type MensajeDrFlit =
  /** «Explícame X»: la etiqueta se deriva del catálogo. */
  | (Base & { de: 'usuario'; tipo: 'modulo'; clave: string })
  /** Respuesta a «Explícame X»: el resumen se deriva al pintar, no se guarda. */
  | (Base & { de: 'drflit'; tipo: 'explicacion'; ref: RefFicha });

let secuencia = 0;

/** Id local del mensaje (no sale del navegador). */
export function nuevoIdMensaje(): string {
  secuencia += 1;
  return `m${Date.now().toString(36)}-${secuencia}`;
}

/** Inmutable, con tope de `MAX_MENSAJES` (se conservan los más recientes). */
export function agregar(mensajes: readonly MensajeDrFlit[], nuevo: MensajeDrFlit): MensajeDrFlit[] {
  return [...mensajes, nuevo].slice(-MAX_MENSAJES);
}

export interface ExplicacionModulo {
  etiqueta: string;
  resumen: string;
  /** `null` = ficha pendiente: no hay enlace (la página pendiente no añade nada al resumen). */
  href: string | null;
}

/**
 * Lo que Dr. Flit dice de un módulo (HU #13765 AC2/AC3). `ficha === null` (sin archivo) usa el
 * `resumenPendiente` del catálogo y no enlaza. El llamador ya filtró por permiso.
 */
export function explicacionDeModulo(entrada: EntradaAyuda, ficha: FichaParseada | null): ExplicacionModulo {
  return {
    etiqueta: entrada.etiqueta,
    resumen: resumenDeEntrada(entrada, ficha),
    href: ficha ? `/flito/ayuda/${entrada.clave}` : null,
  };
}
