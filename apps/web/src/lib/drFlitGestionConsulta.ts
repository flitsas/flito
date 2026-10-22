// Dr. Flit — consultas de gestión: llamadas al API y memoria de la pestaña (HU #13836 G1).
// Separado de `drFlitGestion.ts` (puro, probado con `node --test`) porque aquí entra `lib/api.ts`.
//
// - `consultarModulo` / `consultarGestion`: `POST /api/flito/<modulo>/buscar` con `{ valor }` en el
//   BODY (regla 14: el valor nunca va en la URL). `consultarGestion` es el punto de entrada para F4.
// - Memoria: la conversación con valores y los grupos de resultados viven aquí, en el módulo, para
//   sobrevivir a cerrar y abrir el panel o cambiar de pantalla (UX F6.9). NUNCA en el almacén: al
//   recargar la página esto se pierde y solo queda el marcador sin valor.

import type { ModuloGestion, ResultadoGestion } from '@operaciones/shared-types';
import { api, ApiError } from './api';
import { alLimpiarDrFlit } from './drFlitAlmacen';
import type { GrupoGestion } from './drFlitGestion';
import type { MensajeDrFlit } from './drFlitConversacion';

export type RespuestaModulo =
  | { ok: true; datos: ResultadoGestion<unknown> }
  | { ok: false; status: number };

/** Un módulo; no lanza: red/timeout = `status 0` (mismo copy que un 5xx). */
export async function consultarModulo(modulo: ModuloGestion, valor: string): Promise<RespuestaModulo> {
  try {
    const datos = await api.post<ResultadoGestion<unknown>>(`/flito/${modulo}/buscar`, { valor });
    return { ok: true, datos };
  } catch (e) {
    return { ok: false, status: e instanceof ApiError ? e.status : 0 };
  }
}

/** Todos los módulos en paralelo; la falla de uno queda aislada (`Promise.allSettled`). */
export async function consultarGestion(
  valor: string, modulos: readonly ModuloGestion[],
): Promise<Partial<Record<ModuloGestion, RespuestaModulo>>> {
  const resultados = await Promise.allSettled(modulos.map((m) => consultarModulo(m, valor)));
  const salida: Partial<Record<ModuloGestion, RespuestaModulo>> = {};
  resultados.forEach((r, i) => {
    salida[modulos[i]] = r.status === 'fulfilled' ? r.value : { ok: false, status: 0 };
  });
  return salida;
}

/** Respuesta → estado del grupo: 0 resultados o 403 ocultan el grupo (P9-A, UX F6.8). */
export function grupoDeRespuesta(r: RespuestaModulo): GrupoGestion {
  if (r.ok) return r.datos.total > 0 ? { estado: 'ok', total: r.datos.total, items: r.datos.items } : { estado: 'oculto' };
  return r.status === 403 ? { estado: 'oculto' } : { estado: 'error', status: r.status };
}

// ── Memoria de la pestaña ────────────────────────────────────────────────────────────────────────

export type GruposResultado = Partial<Record<ModuloGestion, GrupoGestion>>;

interface Memoria {
  userId: string | number;
  /** Conversación tal como está en pantalla (con valores). */
  mensajes: MensajeDrFlit[];
  /** Grupos por id de mensaje `resultadoGestion`. */
  resultados: ReadonlyMap<string, GruposResultado>;
  /** Lo que el almacén tenía al copiar `mensajes`: si ya no coincide, la memoria no vale. */
  guardado: string | null;
}

let memoria: Memoria | null = null;
/**
 * Sube con cada `olvidarGestion`. Una consulta captura la generación al lanzarse y `fijarGrupos`
 * descarta la respuesta si cambió: una respuesta que llega tras «Terminar chat» o tras cerrar sesión
 * no repuebla la memoria (Ley 1581: el valor no sobrevive a la salida).
 */
let generacion = 0;
const oyentes = new Set<() => void>();
const VACIO: ReadonlyMap<string, GruposResultado> = new Map();

/**
 * Mensajes en memoria de este usuario si siguen siendo la misma conversación que la guardada
 * (`guardado` idéntico al almacén actual); si no (otro usuario, sesión cerrada, chat terminado en
 * otra pestaña), se descarta y vale lo restaurado del almacén.
 */
export function mensajesEnMemoria(userId: string | number, crudo: string | null): MensajeDrFlit[] | null {
  if (memoria && memoria.userId === userId && crudo !== null && memoria.guardado === crudo) return memoria.mensajes;
  if (memoria) {
    memoria = null;
    oyentes.forEach((o) => o());
  }
  return null;
}

/** El panel copia aquí la conversación cada vez que la guarda. */
export function recordarMensajes(userId: string | number, mensajes: MensajeDrFlit[], guardado: string | null): void {
  const resultados = memoria && memoria.userId === userId ? memoria.resultados : VACIO;
  memoria = { userId, mensajes, resultados, guardado };
}

/**
 * «Terminar chat» y las salidas de sesión (registrada en el barrido de Dr. Flit): borra lo que está
 * en memoria (UX F6.9) e invalida las consultas en vuelo.
 */
export function olvidarGestion(): void {
  generacion += 1;
  memoria = null;
  oyentes.forEach((o) => o());
}
alLimpiarDrFlit(olvidarGestion);

/** Generación vigente: se captura al lanzar una consulta y se pasa a `fijarGrupos`. */
export function generacionGestion(): number {
  return generacion;
}

export function resultadosGestion(): ReadonlyMap<string, GruposResultado> {
  return memoria?.resultados ?? VACIO;
}

export function suscribirResultados(oyente: () => void): () => void {
  oyentes.add(oyente);
  return () => {
    oyentes.delete(oyente);
  };
}

/**
 * Cambia los grupos de un resultado. Funciona con el panel cerrado: la respuesta no se pierde. Si la
 * memoria se olvidó desde que se lanzó la consulta (`gen` vieja), descarta y devuelve `false`.
 */
export function fijarGrupos(
  userId: string | number, gen: number, id: string, cambio: (prev: GruposResultado) => GruposResultado,
): boolean {
  if (gen !== generacion) return false;
  if (!memoria || memoria.userId !== userId) memoria = { userId, mensajes: [], resultados: VACIO, guardado: null };
  const resultados = new Map(memoria.resultados);
  resultados.set(id, cambio(resultados.get(id) ?? {}));
  memoria = { ...memoria, resultados };
  oyentes.forEach((o) => o());
  return true;
}
