// FLITO — Dr. Flit (Feature #13695). HU #13803: autorización de tratamiento de datos (Ley 1581).
// Montado en `/api/flito/dr-flit` SIN `conAlcance`. Diseño: docs/diseno/feature-13695-dr-flit-soporte.md
// (contrato, D3) y ADR-0026.
//
//   GET  /autorizacion?finalidad=soporte|ia  — estado de la autorización VIGENTE del propio usuario,
//                                              texto vigente y disponibilidad del soporte.
//   POST /autorizacion                       — registra la aceptación (201 nueva · 200 ya existía).
//
// ── Frontera por enlace (ADR-0024, D3) ──────────────────────────────────────────────────────────
// Dr. Flit es un panel de sesión: sus rutas solo leen o escriben datos DEL PROPIO usuario (`sub` del
// token; nunca un id en la ruta ni en el cuerpo). Por eso no se declara un módulo de frontera: las
// rutas están en `RUTAS_TRANSVERSALES` (`shared/middleware/frontera-enlace.ts`) y así las alcanzan
// Corredor SOAT (`proveedor`) y Corredor Impuestos (`organismos_transito`). El enlace `compania` se
// cierra AQUÍ con `rechazarEnlaceCompania`, además de `requireRole` (todos los `USER_ROLES` menos
// `cliente`, P9-7), para no depender de que hoy solo `cliente` tenga ese enlace.
//
// RN-DRF-R1  Toda ruta: authMiddleware → requireRole(ROLES_SOPORTE_DRFLIT) → rechazarEnlaceCompania.
// RN-DRF-R2  El único query param (`finalidad`) es un enum sin PII (AGENTS.md §14).
// RN-DRF-R3  Los 400 no repiten el valor recibido: mensajes propios, `campo` es la ruta, nunca el valor.
// RN-DRF-R4  Nada de esta ruta se loguea con datos del usuario (IP y user agent van solo a la tabla).
// Las reglas del servicio (RN-DRF-A1..A4) están en `dr-flit.service.ts`.
import { isIP } from 'node:net';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  FINALIDADES_DRFLIT, ROLES_SOPORTE_DRFLIT, type EstadoAutorizacionDrFlit,
} from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { ADJUNTOS_DRFLIT, ambienteDespliegue, etiquetaAmbiente, soporteDisponible } from './dr-flit.config.js';
import {
  AutorizacionDrFlitError, aceptarAutorizacion, estadoAutorizacion, textoVigente,
} from './dr-flit.service.js';

const router = Router();

/**
 * Cierra el enlace `compania` (y un enlace que el resolutor no pudo decidir: sin `req.frontera` en una
 * transversal). `ninguno`, `proveedor` y `organismos_transito` pasan. Mismo cuerpo que la frontera.
 */
export function rechazarEnlaceCompania(req: Request, res: Response, next: NextFunction): void {
  const enlace = req.frontera?.enlace;
  if (enlace === undefined || enlace === 'compania') {
    res.status(403).json({ error: 'Sin permisos' });
    return;
  }
  next();
}

router.use(authMiddleware, requireRole(...ROLES_SOPORTE_DRFLIT), rechazarEnlaceCompania);

const MSG_FINALIDAD = 'La finalidad debe ser «soporte» o «ia».';
const finalidadSchema = z.enum(FINALIDADES_DRFLIT, { errorMap: () => ({ message: MSG_FINALIDAD }) });
const consultaSchema = z.object({ finalidad: finalidadSchema });
const aceptarSchema = z.object({
  finalidad: finalidadSchema,
  version: z.string({ errorMap: () => ({ message: 'La versión de la autorización es obligatoria.' }) })
    .min(1).max(40),
}).strict();

const MAX_USER_AGENT = 300;

function origenDe(req: Request): { ip: string | null; userAgent: string | null } {
  const ip = typeof req.ip === 'string' && isIP(req.ip) ? req.ip : null;
  const ua = req.get('user-agent');
  return { ip, userAgent: ua ? ua.slice(0, MAX_USER_AGENT) : null };
}

/** 400 sin eco del valor: el código según el campo, el mensaje propio del esquema. */
function responderInvalido(res: Response, error: z.ZodError): void {
  const issue = error.issues[0];
  const campo = issue?.path.join('.') || null;
  if (campo === 'finalidad') {
    res.status(400).json({ error: MSG_FINALIDAD, codigo: 'finalidad-invalida' });
    return;
  }
  const mensaje = issue?.code === 'unrecognized_keys' ? 'La solicitud trae campos no permitidos.'
    : campo === 'version' ? 'La versión de la autorización es obligatoria.' : 'Solicitud inválida.';
  res.status(400).json({ error: mensaje, codigo: 'campo-invalido', ...(campo ? { campo } : {}) });
}

router.get('/autorizacion', async (req: Request, res: Response) => {
  const q = consultaSchema.safeParse(req.query);
  if (!q.success) { responderInvalido(res, q.error); return; }
  const { finalidad } = q.data;
  const estado = await estadoAutorizacion(req.user!.sub, finalidad);
  const ambiente = ambienteDespliegue();
  const cuerpo: EstadoAutorizacionDrFlit = {
    finalidad,
    autorizado: estado.autorizado,
    versionVigente: estado.versionVigente,
    textoVigente: textoVigente(finalidad),
    aceptadaEn: estado.aceptadaEn ? estado.aceptadaEn.toISOString() : null,
    soporte: {
      disponible: soporteDisponible(),
      ambiente,
      ambienteEtiqueta: etiquetaAmbiente(ambiente),
      adjuntos: ADJUNTOS_DRFLIT,
    },
  };
  res.json(cuerpo);
});

router.post('/autorizacion', async (req: Request, res: Response) => {
  const b = aceptarSchema.safeParse(req.body ?? {});
  if (!b.success) { responderInvalido(res, b.error); return; }
  try {
    const { nueva, id, aceptada } = await aceptarAutorizacion(req.user!.sub, b.data.finalidad, b.data.version, origenDe(req));
    if (nueva) {
      await audit(req, {
        action: 'create', resource: 'drflit_autorizacion', resourceId: String(id),
        detail: `finalidad=${aceptada.finalidad} version=${aceptada.version}`,
      });
    }
    res.status(nueva ? 201 : 200).json(aceptada);
  } catch (e) {
    if (e instanceof AutorizacionDrFlitError) {
      res.status(409).json({ error: e.message, codigo: e.codigo });
      return;
    }
    throw e;
  }
});

export default router;
