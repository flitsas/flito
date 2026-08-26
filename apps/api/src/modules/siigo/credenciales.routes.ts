// Siigo API — administración de credenciales (HU #11247). Montado en /api/siigo/credenciales.
//
// Solo admin: son las llaves de la integración que factura ante la DIAN.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { SiigoEncKeyError, siigoEncKeyDisponible } from '../../shared/utils/crypto.js';
import {
  desactivarCredencial, guardarCredencial, listarCredenciales, SiigoCredencialError,
} from './credenciales.service.js';
import { probarConexion } from './siigo.diagnostico.service.js';

const router = Router();
router.use(authMiddleware, requireRole('admin'));

const credencialSchema = z.object({
  ambiente: z.enum(['pruebas', 'produccion']),
  username: z.string().trim().min(3).max(150),
  accessKey: z.string().min(8).max(500),
  notas: z.string().max(500).optional(),
});

// GET / — listado sin secretos. `accessKey` siempre viene enmascarada.
router.get('/', async (_req: Request, res: Response) => {
  const data = await listarCredenciales();
  res.json({ data, llaveMaestraConfigurada: siigoEncKeyDisponible() });
});

// POST / — registra la credencial del ambiente. Reemplaza la activa anterior conservando historial.
router.post('/', async (req: Request, res: Response) => {
  const parsed = credencialSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const userId = req.user?.sub as number;

  try {
    const creada = await guardarCredencial({ ...parsed.data, userId });
    await audit(req, {
      action: 'create',
      resource: 'siigo_credencial',
      resourceId: String(creada.id),
      // Nunca el access_key, ni siquiera un prefijo: un fragmento sigue siendo material de la clave.
      detail: `ambiente=${creada.ambiente} username=${creada.username}`,
    });
    res.status(201).json(creada);
  } catch (e) {
    // 503 y no 500: el servicio está bien construido, es el entorno el que no está configurado.
    if (e instanceof SiigoEncKeyError) {
      res.status(503).json({ error: e.message, codigo: 'llave_maestra' });
      return;
    }
    throw e;
  }
});

// POST /probar-conexion — diagnóstico de la integración (HU #11253).
//
// Siempre responde 200 con el resultado dentro del cuerpo, incluso cuando la prueba falla. Un
// diagnóstico que devuelve 503 obliga a quien lo consume a leer el error de dos sitios distintos;
// aquí el veredicto viaja siempre en el mismo campo.
router.post('/probar-conexion', async (req: Request, res: Response) => {
  const ambiente = req.body?.ambiente === 'produccion' || req.body?.ambiente === 'pruebas'
    ? req.body.ambiente as 'produccion' | 'pruebas'
    : undefined;

  const resultado = await probarConexion({ ambiente, usuarioId: req.user?.sub as number });
  res.json(resultado);
});

// DELETE /:id — desactiva (soft delete). El historial de credenciales nunca se borra.
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const userId = req.user?.sub as number;

  const ok = await desactivarCredencial(id, userId);
  if (!ok) { res.status(404).json({ error: 'No encontrada' }); return; }
  await audit(req, {
    action: 'delete', resource: 'siigo_credencial', resourceId: String(id),
    detail: 'desactivada (activo=false)',
  });
  res.json({ success: true });
});

/** Traduce el error de negocio del servicio a un status. Exportado para reutilizarlo en las HUs
 *  siguientes, que resuelven la credencial desde el cliente HTTP y necesitan el mismo mapeo. */
export function statusDeCredencialError(e: SiigoCredencialError): number {
  return e.codigo === 'no_configurada' ? 409 : 503;
}

export default router;
