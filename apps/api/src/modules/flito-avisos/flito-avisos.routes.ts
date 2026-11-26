// FLITO avisos (HTTP) — Épica #14707 (ADR-0049 §7, diseño §3.3). Montado en `/api/flito/avisos`.
//
// Bandeja PERSONAL: `authMiddleware` en todo el router y SIN `requireRole` ni función de permiso, porque cada usuario
// solo lee y marca lo suyo (el `usuario_id` sale del token, nunca de la petición — RN-AV1). Sin PII en la URL: la
// lectura no lleva query string y el «visto» lleva los ids (opacos) en el BODY. Las dos rutas están en
// `RUTAS_TRANSVERSALES` (frontera por enlace): un usuario con enlace (compañía, proveedor, organismo) también ve los
// SUYOS (decisión del humano, 2026-11-26).
//
//   GET  /        → `AvisosUsuarioRespuesta` (no vistos, máx. 50, + conteo total). `Cache-Control: no-store`.
//   POST /visto   → body `{ ids: uuid[] }` (1..200) → 200 `{ marcados }`. Ajenos/inexistentes: ignorados (RN-AV3).
//
// La respuesta proyecta la placa (cuasi-PII, la misma que el usuario ya veía en su cola) y el radicado; ningún dato
// del titular. Sin registro en `pii_access_log` (ADR-0049 §8; lo confirma `security-agent`). Logs y auditoría: solo
// conteos.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { MAX_IDS_AVISOS_VISTOS, type MarcarAvisosVistosRespuesta } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { listarAvisosNoVistos, marcarAvisosVistos } from './flito-avisos.service.js';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req: Request, res: Response) => {
  const r = await listarAvisosNoVistos(req.user!.sub);
  res.set('Cache-Control', 'no-store');
  res.json(r);
});

const vistoSchema = z.object({ ids: z.array(z.string().guid()).min(1).max(MAX_IDS_AVISOS_VISTOS) }).strict();

router.post('/visto', async (req: Request, res: Response) => {
  const parsed = vistoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Lista de avisos inválida.' });
    return;
  }
  const marcados = await marcarAvisosVistos(req.user!.sub, parsed.data.ids);
  if (marcados > 0) {
    await audit(req, { action: 'update', resource: 'flito_aviso_usuario', detail: `avisos marcados como vistos: ${marcados}` });
  }
  const cuerpo: MarcarAvisosVistosRespuesta = { marcados };
  res.json(cuerpo);
});

export default router;
