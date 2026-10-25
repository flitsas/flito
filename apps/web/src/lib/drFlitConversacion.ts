// Dr. Flit — modelo de conversación (Feature #13694, slim §4). Puro: sin React, `api` ni
// `import.meta`, para que Playwright lo importe desde `src`.
// HU #13765 entrega los tipos de «Explícame un módulo» y `agregar` (memoria del panel). La unión
// crece por `tipo` (#13766: pregunta/citas/sinResultados) y #13767 añade serializar/restaurar sin
// cambiar estas formas. Títulos y resúmenes NUNCA se guardan en el mensaje: se derivan al pintar.

import type { EntradaAyuda } from '../content/ayuda/catalogo';
import type { FichaParseada } from './ayudaFicha';
import { resumenDeEntrada } from './ayudaBusqueda';
import { entradaAyudaPorClave, esClaveAyuda, puedeVerEntradaAyuda, type UsuarioAyuda } from './ayudaFlito';
import { anclaExiste, MAX_CITAS } from './drFlitBusqueda';
import { borrarCrudo, leerCrudo } from './drFlitAlmacen';
import { sinValoresDeGestion, type MensajeGestion } from './drFlitGestion';

/** Versión de la forma guardada. Un `tipo` nuevo NO la sube (se descarta al restaurar). */
export const VERSION_CONVERSACION = 1;
export const MAX_MENSAJES = 50;
/** Tope de la pregunta del usuario (HU #13766 AC6). */
export const MAX_PREGUNTA = 300;

/** `intent` de una `respuestaIa` guardable (HU #13857 IA-5 + HU #13858 IA-6). */
export type IntentRespuestaIa = 'duda' | 'no_claro' | 'soporte' | 'gestion-sin-valor' | 'gestion-documento';
const INTENTS_RESPUESTA_IA: readonly string[] = ['duda', 'no_claro', 'soporte', 'gestion-sin-valor', 'gestion-documento'];

/** Referencia a una ficha; sin `ancla` = la ficha completa. */
export interface RefFicha {
  clave: string;
  ancla?: string;
}

type Base = { id: string; ts: number };

/** HU #13942: por qué Dr. Flit no atendió (sin la función o retirada con el panel abierto). */
export const MOTIVOS_AVISO_FUNCION = ['sin-soporte', 'sin-manuales', 'sin-gestion', 'retirada'] as const;
export type MotivoAvisoFuncion = (typeof MOTIVOS_AVISO_FUNCION)[number];

export type MensajeDrFlit =
  /** «Tengo una pregunta»: el texto tal cual (≤ `MAX_PREGUNTA`). Nunca sale del navegador. */
  | (Base & { de: 'usuario'; tipo: 'pregunta'; texto: string })
  /** «Explícame X»: la etiqueta se deriva del catálogo. */
  | (Base & { de: 'usuario'; tipo: 'modulo'; clave: string })
  /** Respuesta a «Explícame X»: el resumen se deriva al pintar, no se guarda. */
  | (Base & { de: 'drflit'; tipo: 'explicacion'; ref: RefFicha })
  /** Respuesta a una pregunta: 1..3 referencias `{clave, ancla}`; los títulos se derivan al pintar. */
  | (Base & { de: 'drflit'; tipo: 'citas'; respondeA: string; refs: RefFicha[] })
  /** Sin coincidencias: la consulta se lee del mensaje `respondeA`, no se copia. */
  | (Base & { de: 'drflit'; tipo: 'sinResultados'; respondeA: string })
  /**
   * HU #13806: caso de soporte radicado. SOLO el número (nada del formulario, P9-6). Tipo nuevo sin
   * subir `VERSION_CONVERSACION`: un código anterior lo descarta al restaurar.
   */
  | (Base & { de: 'drflit'; tipo: 'casoRadicado'; numero: number })
  /**
   * HU #13942: Dr. Flit no puede atender lo pedido porque al usuario le falta la función (copys 3, 4,
   * 5 y 6 de `docs/ux/flito-dr-flit-funciones.md`). Solo el motivo: el texto se deriva al pintar y nada
   * de la pregunta (placa, VIN, documento) se copia. Tipo nuevo sin subir `VERSION_CONVERSACION`.
   */
  | (Base & { de: 'drflit'; tipo: 'avisoFuncion'; respondeA?: string; motivo: MotivoAvisoFuncion })
  /**
   * HU #13857 (IA-5): respuesta de texto de la IA (`intent` duda o no_claro). `texto` es el `reply` TAL
   * COMO LLEGÓ (con tokens de máscara, nunca valores): la pantalla los restaura solo mientras el mapa
   * del envío vive en memoria (AC9). Las citas se guardan como en F3 (`{clave, ancla}`); los títulos
   * se derivan al pintar. Tipo nuevo sin subir `VERSION_CONVERSACION`.
   * HU #13858 (IA-6): también `soporte` (oferta de F5, `texto` = reply o `null`) y los dos copys fijos
   * de gestión sin consulta: `gestion-sin-valor` y `gestion-documento` (`texto` siempre `null`: ningún
   * valor ni documento se guarda). La oferta de F6 con valor NO es `respuestaIa`: es `ofertaGestion`.
   */
  | (Base & {
    de: 'drflit'; tipo: 'respuestaIa'; respondeA: string; intent: IntentRespuestaIa; texto: string | null;
    enManuales: boolean; refs: RefFicha[];
  })
  /**
   * HU #13836 (F6): oferta, resultado y marcador de una consulta de gestión. Oferta y resultado
   * solo viven en memoria; `serializar` los quita y cambia el mensaje con el valor por el marcador.
   */
  | MensajeGestion;

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

// ── Guardado y restauración (HU #13767; slim §4) ─────────────────────────────────────────────────
// Solo se guarda la unión: textos del usuario y referencias `{clave, ancla}`. Títulos, resúmenes y
// cuerpos de ficha NUNCA (AC4): se derivan al pintar. Nada de esto escribe en consola (AC6/AC7).

export interface ConversacionGuardada {
  v: typeof VERSION_CONVERSACION;
  mensajes: MensajeDrFlit[];
}

/**
 * `{ v: 1, mensajes }` con los `MAX_MENSAJES` más recientes (AC7). HU #13836 AC8: ningún valor de
 * gestión (placa, VIN, id FLIT) ni campo de tarjeta entra al almacén — el turno queda como marcador.
 */
export function serializar(mensajes: readonly MensajeDrFlit[]): string {
  const guardables = sinValoresDeGestion(mensajes) as MensajeDrFlit[];
  const guardada: ConversacionGuardada = { v: VERSION_CONVERSACION, mensajes: guardables.slice(-MAX_MENSAJES) };
  return JSON.stringify(guardada);
}

type Obj = Record<string, unknown>;
const esObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const esTexto = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

function refValida(x: unknown): RefFicha | null {
  if (!esObj(x) || typeof x.clave !== 'string' || !esClaveAyuda(x.clave)) return null;
  if (x.ancla === undefined) return { clave: x.clave };
  return esTexto(x.ancla) ? { clave: x.clave, ancla: x.ancla } : null;
}

/** Reconstruye el mensaje campo a campo (sin arrastrar propiedades ajenas); `null` = se descarta. */
function mensajeValido(x: unknown): MensajeDrFlit | null {
  if (!esObj(x) || !esTexto(x.id) || typeof x.ts !== 'number' || !Number.isFinite(x.ts)) return null;
  const base = { id: x.id, ts: x.ts };
  switch (x.tipo) {
    case 'pregunta':
      return x.de === 'usuario' && esTexto(x.texto) && x.texto.length <= MAX_PREGUNTA
        ? { ...base, de: 'usuario', tipo: 'pregunta', texto: x.texto } : null;
    case 'modulo':
      return x.de === 'usuario' && typeof x.clave === 'string' && esClaveAyuda(x.clave)
        ? { ...base, de: 'usuario', tipo: 'modulo', clave: x.clave } : null;
    case 'explicacion': {
      const ref = x.de === 'drflit' ? refValida(x.ref) : null;
      return ref ? { ...base, de: 'drflit', tipo: 'explicacion', ref } : null;
    }
    case 'citas': {
      if (x.de !== 'drflit' || !esTexto(x.respondeA) || !Array.isArray(x.refs)) return null;
      if (x.refs.length < 1 || x.refs.length > MAX_CITAS) return null;
      const refs = x.refs.map(refValida);
      return refs.every((r): r is RefFicha => r !== null)
        ? { ...base, de: 'drflit', tipo: 'citas', respondeA: x.respondeA, refs } : null;
    }
    case 'sinResultados':
      return x.de === 'drflit' && esTexto(x.respondeA)
        ? { ...base, de: 'drflit', tipo: 'sinResultados', respondeA: x.respondeA } : null;
    case 'casoRadicado':
      return x.de === 'drflit' && typeof x.numero === 'number' && Number.isSafeInteger(x.numero) && x.numero > 0
        ? { ...base, de: 'drflit', tipo: 'casoRadicado', numero: x.numero } : null;
    case 'respuestaIa': {
      if (x.de !== 'drflit' || !esTexto(x.respondeA) || !Array.isArray(x.refs)) return null;
      if (typeof x.intent !== 'string' || !INTENTS_RESPUESTA_IA.includes(x.intent)) return null;
      if (x.texto !== null && !esTexto(x.texto)) return null;
      if (x.intent.startsWith('gestion') && x.texto !== null) return null;
      if (typeof x.enManuales !== 'boolean' || x.refs.length > MAX_CITAS) return null;
      const refs = x.refs.map(refValida);
      return refs.every((r): r is RefFicha => r !== null)
        ? {
          ...base, de: 'drflit', tipo: 'respuestaIa', respondeA: x.respondeA, intent: x.intent as IntentRespuestaIa, texto: x.texto,
          enManuales: x.enManuales, refs,
        }
        : null;
    }
    case 'avisoFuncion':
      if (x.de !== 'drflit' || typeof x.motivo !== 'string') return null;
      if (!(MOTIVOS_AVISO_FUNCION as readonly string[]).includes(x.motivo)) return null;
      if (x.respondeA !== undefined && !esTexto(x.respondeA)) return null;
      return {
        ...base, de: 'drflit', tipo: 'avisoFuncion', motivo: x.motivo as MotivoAvisoFuncion,
        ...(x.respondeA !== undefined ? { respondeA: x.respondeA } : {}),
      };
    case 'marcadorGestion':
      return x.de === 'drflit' && typeof x.consulta === 'boolean'
        ? { ...base, de: 'drflit', tipo: 'marcadorGestion', consulta: x.consulta } : null;
    default:
      return null;
  }
}

/** `null` = el valor entero es ilegible (JSON roto, `v` distinta, sin lista): hay que borrarlo. */
function restaurarOValidar(crudo: string): MensajeDrFlit[] | null {
  let dato: unknown;
  try {
    dato = JSON.parse(crudo);
  } catch {
    return null;
  }
  if (!esObj(dato) || dato.v !== VERSION_CONVERSACION || !Array.isArray(dato.mensajes)) return null;
  return dato.mensajes
    .map(mensajeValido)
    .filter((m): m is MensajeDrFlit => m !== null)
    .slice(-MAX_MENSAJES);
}

/** Tolerante por mensaje: descarta los inválidos y conserva el resto. Ilegible o `v` ≠ 1 → `[]`. */
export function restaurar(crudo: string | null): MensajeDrFlit[] {
  return crudo === null ? [] : restaurarOValidar(crudo) ?? [];
}

/** Lee la conversación del usuario; si el valor guardado es ilegible lo borra (AC6). No lanza. */
export function restaurarConversacion(userId: string | number): MensajeDrFlit[] {
  const crudo = leerCrudo(userId);
  if (crudo === null) return [];
  const mensajes = restaurarOValidar(crudo);
  if (mensajes === null) borrarCrudo(userId);
  return mensajes ?? [];
}

export type EstadoRef = 'disponible' | 'no-disponible' | 'por-verificar';

/**
 * Permiso primero y sin descargar nada (AC5): sin permiso → `no-disponible`. Visible pero sin la
 * ficha cargada → `por-verificar`. Cargada → comprueba el ancla (sin ancla = la ficha completa).
 */
export function estadoReferencia(
  user: UsuarioAyuda | null,
  ref: RefFicha,
  fichas?: ReadonlyMap<string, FichaParseada | null>,
): EstadoRef {
  const entrada = entradaAyudaPorClave(ref.clave);
  if (!entrada || !puedeVerEntradaAyuda(user, entrada)) return 'no-disponible';
  if (!fichas?.has(entrada.clave)) return 'por-verificar';
  if (ref.ancla === undefined) return 'disponible';
  return anclaExiste(fichas.get(entrada.clave) ?? null, ref.ancla) ? 'disponible' : 'no-disponible';
}

/** Referencias de la conversación (para cargar solo las fichas visibles que hacen falta). */
export function referenciasDe(mensajes: readonly MensajeDrFlit[]): RefFicha[] {
  return mensajes.flatMap((m) => (
    m.tipo === 'explicacion' ? [m.ref] : m.tipo === 'citas' || m.tipo === 'respuestaIa' ? m.refs : []));
}
