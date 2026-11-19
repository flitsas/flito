// Dr. Flit IA — orquesta una respuesta del chat (HU #13856, Feature #13696, IA-4).
// Diseño: docs/diseno/feature-13696-dr-flit-ia.md · ADR-0027. La ruta (`dr-flit-chat.routes.ts`) ya
// pasó función `drflit.ia.usar` → limiter → Zod → IA apagada → autorización `ia`; aquí sigue: re-enmascarado →
// manuales (RN-DRF-S6) → cupo → contexto → llamada → parser. Las fichas se resuelven antes del cupo (RN-DRF-S5).
//
// RN-DRF-S1  Cupo: se reserva ANTES de llamar. Sin cupo → `cupo-agotado` sin llamar al modelo. Si la
//            llamada falla (timeout, red, 429/529/5xx, 4xx) se DEVUELVE sobre el mismo `dia` de la
//            reserva. Una respuesta fuera de contrato (o cortada / rechazada por el modelo) SÍ consume:
//            hubo llamada real (ADR-0027, pregunta 7).
// RN-DRF-S2  Re-enmascarado en el servidor (defensa ante un cliente manipulado): mensaje e historial pasan
//            por `enmascarar` con UN mapa cuyos contadores arrancan después de los tokens que ya trae la
//            petición, para que un valor en claro nunca reciba un token que el navegador ya usó.
// RN-DRF-S3  Nunca 5xx por la IA: todo fallo del proveedor termina en `degradado`.
// RN-DRF-S4  Logs: solo metadatos (`statusCode`, `error.type`); nunca mensaje, historial, reply ni cuerpo.
import type { Request } from 'express';
import {
  crearMapaMascara, enmascarar, tipoDeTokenMascara, tokensDe,
  type ChatDrFlitRequest, type CupoIaDrFlit, type MotivoDegradadoDrFlit, type RespuestaChatDrFlit,
  type TurnoHistorialDrFlit,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { armarContexto, manualesDisponibles, type FichaAyudaApi } from './dr-flit-ia.contexto.js';
import { devolverCupoIa, reservarCupoIa } from './dr-flit-ia.cupo.js';
import { armarCuerpoMensajes } from './dr-flit-ia.prompt.js';
import { llamarMensajesIa } from './dr-flit-ia.client.js';
import { parsearSalidaIa } from './dr-flit-ia.parser.js';

const log = loggerFor('drflit-ia');

/** Metadatos de una llamada al chat: lo ÚNICO que se loguea (AC9). */
export interface MetricasChatIa {
  intent: RespuestaChatDrFlit['intent'];
  degradado: MotivoDegradadoDrFlit | null;
  tokensEntrada: number | null;
  tokensSalida: number | null;
  modelo: string | null;
  fichasEnContexto: number;
  citas: number;
}

export interface ResultadoChatIa {
  respuesta: RespuestaChatDrFlit;
  metricas: MetricasChatIa;
}

export function respuestaDegradada(motivo: MotivoDegradadoDrFlit, cupo: CupoIaDrFlit | null): RespuestaChatDrFlit {
  return {
    intent: null, reply: null, enManuales: null, citedSlugs: [], citas: [],
    gestionTarget: null, gestionRef: null, degradado: motivo, cupo,
  };
}

const metricasVacias = (degradado: MotivoDegradadoDrFlit | null, modelo: string | null): MetricasChatIa => ({
  intent: null, degradado, tokensEntrada: null, tokensSalida: null, modelo, fichasEnContexto: 0, citas: 0,
});

/** Ver RN-DRF-S2. Devuelve los textos re-enmascarados y todos los tokens de la petición. */
export function reenmascararPeticion(entrada: ChatDrFlitRequest): {
  mensaje: string; historial: TurnoHistorialDrFlit[]; tokens: string[];
} {
  const mapa = crearMapaMascara();
  for (const t of tokensDe([entrada.mensaje, ...entrada.historial.map((h) => h.texto)].join('\n'))) {
    const tipo = tipoDeTokenMascara(t);
    const n = Number(/_(\d+)\]$/.exec(t)?.[1] ?? 0);
    if (tipo && n > (mapa.contadores.get(tipo) ?? 0)) mapa.contadores.set(tipo, n);
  }
  const historial = entrada.historial.map((h) => ({ rol: h.rol, texto: enmascarar(h.texto, mapa) }));
  const mensaje = enmascarar(entrada.mensaje, mapa);
  const tokens = tokensDe([mensaje, ...historial.map((h) => h.texto)].join('\n'));
  return { mensaje, historial, tokens };
}

export interface DependenciasChatIa {
  fichas?: (req: Request) => Promise<readonly FichaAyudaApi[]>;
  modelo?: string;
  maxTokens?: number;
}

/** Responde un mensaje del chat. Precondición: IA disponible y autorización `ia` vigente. */
export async function responderChatIa(
  req: Request, usuarioId: number, entrada: ChatDrFlitRequest, deps: DependenciasChatIa = {},
): Promise<ResultadoChatIa> {
  const modelo = deps.modelo ?? env.ANTHROPIC_MODEL_DRFLIT;
  // RN-DRF-S5  Re-enmascarado (puro) y fichas visibles ANTES de reservar: si el motor de permisos falla,
  //            200 `ia-error` sin consumir cupo (`cupo: null`) y sin llamar al modelo (nunca 5xx, CH2).
  const { mensaje, historial, tokens } = reenmascararPeticion(entrada);
  let fichas: readonly FichaAyudaApi[];
  try {
    fichas = await (deps.fichas ?? manualesDisponibles)(req);
  } catch {
    log.error({ usuarioId }, 'drflit ia: no se pudieron resolver las fichas visibles');
    return { respuesta: respuestaDegradada('ia-error', null), metricas: metricasVacias('ia-error', null) };
  }
  // RN-DRF-S6 (HU #13941, AC5)  Sin «Ver los manuales» o sin ninguna ficha visible: 200 `sin-manuales`, sin
  //            reservar cupo (`cupo: null`) y sin llamar al modelo.
  if (fichas.length === 0) {
    return { respuesta: respuestaDegradada('sin-manuales', null), metricas: metricasVacias('sin-manuales', null) };
  }

  const reserva = await reservarCupoIa(usuarioId);
  const cupo: CupoIaDrFlit = { usados: reserva.usados, tope: reserva.tope, restantes: reserva.restantes };
  if (!reserva.concedida) {
    return { respuesta: respuestaDegradada('cupo-agotado', cupo), metricas: metricasVacias('cupo-agotado', null) };
  }

  const ultimoUsuario = [...historial].reverse().find((h) => h.rol === 'usuario')?.texto ?? '';
  const contexto = armarContexto(fichas, `${mensaje} ${ultimoUsuario}`.trim());
  const cuerpo = armarCuerpoMensajes(
    { contexto, mensaje, historial },
    { modelo, maxTokens: deps.maxTokens ?? env.DRFLIT_IA_MAX_TOKENS },
  );
  const base = { ...metricasVacias(null, modelo), fichasEnContexto: contexto.indice.length };

  const r = await llamarMensajesIa(cuerpo);
  if (!r.ok) {
    const config = r.statusCode !== null && r.statusCode >= 400 && r.statusCode < 500 && r.statusCode !== 429;
    (config ? log.error : log.warn).call(log, {
      usuarioId, modelo, statusCode: r.statusCode, errorType: r.errorType,
    }, config ? 'drflit ia: el proveedor rechazó la llamada (revisar modelo o clave)' : 'drflit ia: fallo del proveedor');
    let devuelto = cupo;
    try {
      if (await devolverCupoIa(usuarioId, reserva.dia)) {
        devuelto = { usados: cupo.usados - 1, tope: cupo.tope, restantes: Math.min(cupo.tope, cupo.restantes + 1) };
      }
    } catch {
      log.error({ usuarioId }, 'drflit ia: no se pudo devolver el cupo');
    }
    return { respuesta: respuestaDegradada(r.motivo, devuelto), metricas: { ...base, degradado: r.motivo } };
  }

  const metricas = { ...base, tokensEntrada: r.tokensEntrada, tokensSalida: r.tokensSalida };
  // `max_tokens` (salida cortada) o `refusal`: no hay JSON confiable. Consume cupo (hubo llamada).
  const parseado = r.stopReason === 'end_turn'
    ? parsearSalidaIa(r.texto, { fichas, tokensPeticion: tokens })
    : { ok: false as const };
  if (!parseado.ok) {
    return {
      respuesta: respuestaDegradada('respuesta-invalida', cupo),
      metricas: { ...metricas, degradado: 'respuesta-invalida' },
    };
  }
  const s = parseado.salida;
  return {
    respuesta: { ...s, cupo },
    metricas: { ...metricas, intent: s.intent, citas: s.citas.length },
  };
}
