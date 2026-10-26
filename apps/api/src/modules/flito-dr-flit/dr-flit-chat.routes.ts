// FLITO — Dr. Flit IA: chat (HU #13856, Feature #13696, IA-4). Sub-router de `dr-flit.routes.ts`, que lo
// monta DESPUÉS de su `authMiddleware` (RN-DRF-R1: auth → función de Dr. Flit de la ruta, 403
// drflit-funcion-no-habilitada; HU #13941). Diseño: docs/diseno/feature-13696-dr-flit-ia.md («Contrato de endpoints») · ADR-0027.
//
//   POST /chat  { mensaje, historial }  →  200 RespuestaChatDrFlit (con `degradado` si no hubo respuesta)
//
// RN-DRF-CH1  Orden: exigirIaDrFlit (403 `drflit-funcion-no-habilitada`, HU #13941) → drflitChatLimiter (429) → Zod `.strict()` (400 `campo-invalido`, sin eco del valor)
//             → IA apagada (200 `ia-apagada`, aun sin autorización) → autorización `ia` vigente (428
//             `autorizacion-requerida`) → servicio (re-enmascarado → manuales [200 `sin-manuales`] → cupo →
//             contexto → llamada).
// RN-DRF-CH2  Nunca 5xx por la IA: los fallos del proveedor salen como 200 `degradado` (servicio).
// RN-DRF-CH3  Log por petición (también 400/428/429): SOLO metadatos — usuarioId, status, intent,
//             degradado, latenciaMs, tokens, modelo, fichasEnContexto, citas. Nunca mensaje, historial,
//             reply ni nada del proveedor.
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  LIMITES_CHAT_DRFLIT, ROLES_HISTORIAL_DRFLIT, type ChatDrFlitRequest,
} from '@operaciones/shared-types';
import { drflitChatLimiter } from '../../shared/middleware/rateLimiter.js';
import { loggerFor } from '../../shared/logger.js';
import { iaDisponible } from './dr-flit.config.js';
import { respuestaDegradada, responderChatIa, type MetricasChatIa } from './dr-flit-ia.service.js';
import { exigirIaDrFlit } from './dr-flit.funciones.js';

const log = loggerFor('drflit-ia');
const L = LIMITES_CHAT_DRFLIT;

const turnoSchema = z.object({
  rol: z.enum(ROLES_HISTORIAL_DRFLIT),
  texto: z.string().trim().min(L.turno.min).max(L.turno.max),
}).strict();

const chatSchema = z.object({
  mensaje: z.string().trim().min(L.mensaje.min).max(L.mensaje.max),
  historial: z.array(turnoSchema).max(L.historialMax).default([]),
}).strict();

/** Mensaje propio por campo: nunca el de Zod (un enum incluye `received`). */
function mensajeDe(campo: string): string {
  if (campo === 'mensaje') return `Escriba un mensaje de ${L.mensaje.min} a ${L.mensaje.max} caracteres.`;
  if (campo === 'historial') return `El historial admite hasta ${L.historialMax} mensajes.`;
  if (campo.startsWith('historial.')) return `Cada mensaje del historial debe tener de ${L.turno.min} a ${L.turno.max} caracteres y un rol válido.`;
  return 'Solicitud inválida.';
}

/** Zod → `res.locals.chat` o 400 `campo-invalido` sin eco (RN-DRF-R3). */
export function validarChat(req: Request, res: Response, next: NextFunction): void {
  const b = chatSchema.safeParse(req.body ?? {});
  if (b.success) {
    res.locals.chat = b.data satisfies ChatDrFlitRequest;
    next();
    return;
  }
  const issue = b.error.issues[0];
  if (!issue || issue.code === 'unrecognized_keys') {
    res.status(400).json({ error: 'La solicitud trae campos no permitidos.', codigo: 'campo-invalido' });
    return;
  }
  // `historial.3.texto` → `historial.3`: el índice basta para ubicar, el campo hoja no aporta.
  const campo = issue.path.slice(0, 2).join('.');
  res.status(400).json({ error: mensajeDe(campo), codigo: 'campo-invalido', ...(campo ? { campo } : {}) });
}

/** IA apagada o sin clave → 200 `ia-apagada` (antes de la autorización: sin IA no hace falta consentir). */
export function responderSiIaApagada(_req: Request, res: Response, next: NextFunction): void {
  if (iaDisponible()) { next(); return; }
  res.locals.metricasChat = { degradado: 'ia-apagada' } satisfies Partial<MetricasChatIa>;
  res.json(respuestaDegradada('ia-apagada', null));
}

/** Registra UNA línea de metadatos al terminar la respuesta (RN-DRF-CH3). */
function medirChat(req: Request, res: Response, next: NextFunction): void {
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const m = (res.locals.metricasChat ?? {}) as Partial<MetricasChatIa>;
    log.info({
      usuarioId: req.user?.sub ?? null,
      status: res.statusCode,
      intent: m.intent ?? null,
      degradado: m.degradado ?? null,
      latenciaMs: Number((process.hrtime.bigint() - inicio) / 1_000_000n),
      tokensEntrada: m.tokensEntrada ?? null,
      tokensSalida: m.tokensSalida ?? null,
      modelo: m.modelo ?? null,
      fichasEnContexto: m.fichasEnContexto ?? 0,
      citas: m.citas ?? 0,
    }, 'drflit chat');
  });
  next();
}

/**
 * `exigirAutorizacionIa` lo inyecta `dr-flit.routes.ts` (`exigirAutorizacionVigente('ia')`, 428): así
 * este archivo no importa el router padre y no hay ciclo de módulos.
 */
export function crearRouterChat(exigirAutorizacionIa: RequestHandler): Router {
  const router = Router();
  router.post('/chat', medirChat, exigirIaDrFlit, drflitChatLimiter, validarChat, responderSiIaApagada, exigirAutorizacionIa,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const r = await responderChatIa(req, req.user!.sub, res.locals.chat as ChatDrFlitRequest);
        res.locals.metricasChat = r.metricas;
        res.json(r.respuesta);
      } catch (e) {
        next(e);
      }
    });
  return router;
}
