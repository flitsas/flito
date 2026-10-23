// Dr. Flit IA — preparación del envío a la IA en el navegador (HU #13855, Feature #13696 IA-3).
// Diseño: docs/diseno/feature-13696-dr-flit-ia.md §Enmascaramiento (navegador) y restauración.
//
// PURO y SIN llamada HTTP: arma `{ mensaje, historial }` ya enmascarados y devuelve aparte el mapa
// `token → valor`, que solo vive en memoria del envío en curso (AC5): nunca va en el request, nunca en
// `sessionStorage` (la conversación guardada no lo conoce) y nada aquí escribe en consola. El mapa son
// `Map`: un `JSON.stringify` accidental lo vuelca como `{}`.
// Imports con extensión `.ts` para que `node --experimental-strip-types --test` lo cargue tal cual.

import {
  crearMapaMascara, enmascarar, restaurar, restaurarTexto, tipoDeTokenMascara, tokensDe, type MapaMascara,
} from '../../../../packages/shared-types/src/flito-dr-flit-mascara.ts';
import { sinValoresDeGestion, type TipoValorGestion, type ValorDetectado } from './drFlitGestion.ts';

/** Tope de mensajes del historial que viajan a la IA (los más recientes, AC7). */
export const MAX_HISTORIAL_IA = 12;
/** Tope de caracteres por texto enviado (mensaje y cada turno del historial, AC7). */
export const MAX_TEXTO_IA = 2000;
/**
 * `tipo` del mensaje del panel con la respuesta de texto de la IA. Lo pinta la HU de UI (IA-5); aquí
 * solo sirve para reconocerlo al armar el historial. Las respuestas deterministas de F3
 * (`explicacion`, `citas`, `sinResultados`, `casoRadicado`) NO viajan.
 */
export const TIPO_RESPUESTA_IA = 'respuestaIa';

export type RolIa = 'usuario' | 'drflit';
export interface TurnoIa { rol: RolIa; texto: string }
/** Cuerpo de `POST /api/flito/dr-flit/chat` (diseño §Contrato). Todo enmascarado. */
export interface EnvioIa { mensaje: string; historial: TurnoIa[] }

/** Forma mínima de un mensaje del panel que este módulo necesita leer. */
type MensajePanel = { id: string; ts: number; de: string; tipo: string; texto?: unknown };

const RE_TOKEN_CORTADO = /\[[A-Z]*(?:_\d*)?$/;

/** Tope del texto CRUDO que se enmascara: acota el tiempo de la máscara ante textos enormes. */
const MAX_CRUDO_IA = 2 * MAX_TEXTO_IA;

/**
 * Corta el crudo a `MAX_CRUDO_IA`. Si el corte cae a mitad de una palabra, la quita (hasta 64
 * caracteres): un valor partido («10203» de una cédula) podría quedar por debajo de los patrones.
 */
function recortarCrudo(texto: string): string {
  if (texto.length <= MAX_CRUDO_IA) return texto;
  const corte = texto.slice(0, MAX_CRUDO_IA);
  return (/\s/.test(texto[MAX_CRUDO_IA]) ? corte : corte.replace(/\S{1,64}$/, '')).trimEnd();
}

/**
 * Recorta el crudo a 2 × `MAX_TEXTO_IA`, enmascara y recorta a `MAX_TEXTO_IA` sin dejar medio token
 * al final (se enmascara ANTES del corte final).
 */
function enmascararYRecortar(texto: string, mapa: MapaMascara): string {
  const enmascarado = enmascarar(recortarCrudo(texto.trim()), mapa);
  if (enmascarado.length <= MAX_TEXTO_IA) return enmascarado;
  return enmascarado.slice(0, MAX_TEXTO_IA).replace(RE_TOKEN_CORTADO, '').trimEnd();
}

/**
 * Textos del panel que pueden ir como historial (AC7), en orden: preguntas del usuario y respuestas
 * de texto de la IA. Antes se aplica `sinValoresDeGestion` de F6: ofertas y resultados de gestión
 * no viajan y el turno del usuario con un valor de gestión queda como marcador (que no es texto).
 */
function textosDelHistorial(mensajes: readonly MensajePanel[]): { rol: RolIa; texto: string }[] {
  const salida: { rol: RolIa; texto: string }[] = [];
  for (const m of sinValoresDeGestion(mensajes) as MensajePanel[]) {
    if (typeof m.texto !== 'string' || !m.texto.trim()) continue;
    if (m.de === 'usuario' && m.tipo === 'pregunta') salida.push({ rol: 'usuario', texto: m.texto });
    else if (m.de === 'drflit' && m.tipo === TIPO_RESPUESTA_IA) salida.push({ rol: 'drflit', texto: m.texto });
  }
  return salida.slice(-MAX_HISTORIAL_IA);
}

/**
 * Prepara el envío (AC1–AC5, AC7): historial (máx. 12 más recientes) y mensaje enmascarados con UN
 * mismo mapa, numerado en orden cronológico (historial primero) → mismo valor, mismo token en todo
 * el payload. `mensajes` es la conversación del panel SIN el mensaje nuevo. El `mapa` se queda en
 * quien llama, en memoria; `envio` es lo único que puede salir del navegador.
 */
export function prepararEnvioIa(
  mensaje: string, mensajes: readonly MensajePanel[],
): { envio: EnvioIa; mapa: MapaMascara } {
  const mapa = crearMapaMascara();
  const historial = textosDelHistorial(mensajes)
    .map((t) => ({ rol: t.rol, texto: enmascararYRecortar(t.texto, mapa) }))
    .filter((t) => t.texto.length > 0);
  return { envio: { mensaje: enmascararYRecortar(mensaje, mapa), historial }, mapa };
}

/** Valor real de un token del envío (`[PLACA_2]` → `ABC123`); `null` si no existe (AC6). */
export function restaurarToken(token: string, mapa: MapaMascara): string | null {
  return restaurar(token, mapa);
}

/** Respuesta de la IA con los tokens cambiados por los valores del propio usuario (solo para mostrar). */
export function restaurarRespuesta(texto: string, mapa: MapaMascara): string {
  return restaurarTexto(texto, mapa);
}

const TIPO_GESTION_DE_TOKEN: Partial<Record<string, TipoValorGestion>> = {
  PLACA: 'placa', VIN: 'vin', TRAMITE: 'idFlit',
};

/**
 * `gestionRef` → valor para la oferta de F6 (`placa`, `vin`, `TRAMITE → idFlit`). `null` si el token no
 * es de este envío o es de un tipo que F6 no consulta (documento, correo).
 */
export function valorGestionDeRef(ref: string | null, mapa: MapaMascara): ValorDetectado | null {
  if (!ref) return null;
  const tipoToken = tipoDeTokenMascara(ref);
  const tipo = tipoToken ? TIPO_GESTION_DE_TOKEN[tipoToken] : undefined;
  const valor = restaurar(ref, mapa);
  return tipo && valor ? { tipo, valor } : null;
}

/** `gestionTarget` del contrato → tipo de token de la máscara (`cliente` no se consulta: D-9). */
const TOKEN_DE_TARGET: Partial<Record<string, string>> = { placa: 'PLACA', vin: 'VIN', tramite: 'TRAMITE' };

/**
 * HU #13858 (IA-6 AC2, AC4, AC5): valores de gestión que la oferta de F6 puede usar, SOLO del mensaje
 * de ESTE envío (`mensajeEnmascarado` = `envio.mensaje`) y restaurados de SU mapa, nunca del modelo.
 * Un token del historial (o de un `reply` viejo guardado con su propia numeración) no cuenta: el valor
 * tiene que estar escrito en el mensaje. `gestionRef` presente en el mensaje → solo ese valor; si no,
 * todos los del tipo pedido, en orden de lectura y sin repetir. Lista vacía = «necesito la placa…».
 */
export function valoresGestionDelEnvio(
  ref: string | null, target: string | null, mensajeEnmascarado: string, mapa: MapaMascara,
): ValorDetectado[] {
  const tipoToken = target ? TOKEN_DE_TARGET[target] : undefined;
  if (!tipoToken) return [];
  const delTipo = [...new Set(tokensDe(mensajeEnmascarado))].filter((t) => tipoDeTokenMascara(t) === tipoToken);
  const elegidos = ref && delTipo.includes(ref) ? [ref] : delTipo;
  return elegidos.flatMap((t) => {
    const v = valorGestionDeRef(t, mapa);
    return v ? [v] : [];
  });
}
