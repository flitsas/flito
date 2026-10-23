// Dr. Flit IA — llamada al chat (HU #13857 IA-5, Feature #13696). Separada de `drFlitIa.ts` (IA-3), que
// es puro y se prueba con `node --test` sin el cliente HTTP. Solo viaja `envio` (ya enmascarado por
// `prepararEnvioIa`); el mapa de máscara nunca sale de quien llama. HTTP solo por `lib/api.ts`.

import type {
  AutorizacionAceptadaDrFlit, ChatDrFlitRequest, EstadoAutorizacionDrFlit, RespuestaChatDrFlit,
} from '@operaciones/shared-types';
import { api, ApiError } from './api';
import type { EnvioIa } from './drFlitIa';

const BASE = '/flito/dr-flit';

/** `GET /autorizacion?finalidad=ia`: texto vigente + `ia: { disponible, cupo }`. */
export function consultarAutorizacionIa(): Promise<EstadoAutorizacionDrFlit> {
  return api.get<EstadoAutorizacionDrFlit>(`${BASE}/autorizacion?finalidad=ia`);
}

/** Registra la autorización `ia` con la versión MOSTRADA. */
export function aceptarAutorizacionIa(version: string): Promise<AutorizacionAceptadaDrFlit> {
  return api.post<AutorizacionAceptadaDrFlit>(`${BASE}/autorizacion`, { finalidad: 'ia', version });
}

/** La versión mostrada ya no es la vigente (400 `version-no-vigente`; 409 en el contrato de F5). */
export function esVersionNoVigente(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 409) return true;
  const codigo = (e.rawDetails as { codigo?: unknown } | undefined)?.codigo;
  return e.status === 400 && codigo === 'version-no-vigente';
}

/** Resultado del chat ya clasificado para el panel. Nada de esto se muestra crudo. */
export type ResultadoChatIa =
  | { tipo: 'respuesta'; respuesta: RespuestaChatDrFlit }
  /** 428 `autorizacion-requerida`: la versión de la autorización cambió. */
  | { tipo: 'autorizacion-requerida' }
  /** Cualquier otra falla (red, 429 `demasiados-mensajes`, 4xx/5xx): cae en silencio al modo de F3. */
  | { tipo: 'falla' };

export async function enviarChatIa(envio: EnvioIa): Promise<ResultadoChatIa> {
  const cuerpo: ChatDrFlitRequest = { mensaje: envio.mensaje, historial: envio.historial };
  try {
    return { tipo: 'respuesta', respuesta: await api.post<RespuestaChatDrFlit>(`${BASE}/chat`, cuerpo) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 428) return { tipo: 'autorizacion-requerida' };
    return { tipo: 'falla' };
  }
}
