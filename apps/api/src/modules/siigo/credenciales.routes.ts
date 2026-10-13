// Siigo API — administración de credenciales (HU #11247). Montado en /api/siigo/credenciales.
//
// Solo admin: son las llaves de la integración que factura ante la DIAN.
//
// HU #13427 (Feature #13416, Administración · Integración con Siigo): cada acción tiene su operación.
// Registrar o desactivar credenciales de PRUEBAS y de PRODUCCIÓN son acciones distintas: el POST decide
// por el `ambiente` del cuerpo y el DELETE lee el ambiente de la credencial ANTES de decidir, ambos en
// línea con el código literal (`puedeAmbiente`, como `siigo.permisos.ts`). El listado lo da cualquiera de
// las tres acciones (`siigo.credenciales.ver`, de apoyo).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion, funcionesConcedidas, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { SiigoEncKeyError, siigoEncKeyDisponible } from '../../shared/utils/crypto.js';
import {
  ambienteDeCredencial, desactivarCredencial, guardarCredencial, listarCredenciales, SiigoCredencialError,
  type SiigoAmbiente,
} from './credenciales.service.js';
import { probarConexion } from './siigo.diagnostico.service.js';

const router = Router();
router.use(authMiddleware);

const credencialSchema = z.object({
  ambiente: z.enum(['pruebas', 'produccion']),
  username: z.string().trim().min(3).max(150),
  accessKey: z.string().min(8).max(500),
  notas: z.string().max(500).optional(),
});

const REGISTRAR = ['siigo.credenciales.registrar_pruebas', 'siigo.credenciales.registrar_produccion'] as const;

/** La decisión por ambiente, con el código LITERAL en cada rama (el lector de guardas solo acepta literales). */
function puedeAmbiente(req: Request, ambiente: SiigoAmbiente): Promise<boolean> {
  return ambiente === 'produccion'
    ? tieneFuncion(req, 'siigo.credenciales.registrar_produccion')
    : tieneFuncion(req, 'siigo.credenciales.registrar_pruebas');
}

const SIN_PERMISO = 'No tiene permiso para registrar ni desactivar credenciales de Siigo de este ambiente.';

/**
 * Quien no tiene NINGUNA de las dos no llega a la validación ni a la base. La sonda (`funcionesConcedidas`)
 * no deja rastro, así que el NO se decide otra vez con `puedeAmbiente` (→ `tieneFuncion`), que registra el
 * intento denegado en `permisos_intentos_denegados` igual que hacía `exigirFuncion` antes de partir la guarda.
 * `ambiente` = el que nombra el intento: el del cuerpo si es válido; si no se conoce, `produccion`.
 */
async function puedeAlguno(req: Request, ambiente: SiigoAmbiente): Promise<boolean> {
  if ((await funcionesConcedidas(req, REGISTRAR)).size > 0) return true;
  await puedeAmbiente(req, ambiente);
  return false;
}

// GET / — listado sin secretos. `accessKey` siempre viene enmascarada.
router.get('/', exigirFuncion('siigo.credenciales.ver'), async (_req: Request, res: Response) => {
  const data = await listarCredenciales();
  res.json({ data, llaveMaestraConfigurada: siigoEncKeyDisponible() });
});

// POST / — registra la credencial del ambiente. Reemplaza la activa anterior conservando historial.
router.post('/', async (req: Request, res: Response) => {
  const pedido: SiigoAmbiente = req.body?.ambiente === 'pruebas' ? 'pruebas' : 'produccion';
  if (!(await puedeAlguno(req, pedido))) { res.status(403).json({ error: SIN_PERMISO }); return; }
  const parsed = credencialSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  if (!(await puedeAmbiente(req, parsed.data.ambiente))) { res.status(403).json({ error: SIN_PERMISO, ambiente: parsed.data.ambiente }); return; }
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
router.post('/probar-conexion', exigirFuncion('siigo.credenciales.probar'), async (req: Request, res: Response) => {
  const ambiente = req.body?.ambiente === 'produccion' || req.body?.ambiente === 'pruebas'
    ? req.body.ambiente as 'produccion' | 'pruebas'
    : undefined;

  const resultado = await probarConexion({ ambiente, usuarioId: req.user?.sub as number });
  res.json(resultado);
});

// DELETE /:id — desactiva (soft delete). El historial de credenciales nunca se borra.
router.delete('/:id', async (req: Request, res: Response) => {
  // Aquí aún no se conoce el ambiente (leerlo exigiría tocar la base de credenciales antes de decidir): el
  // intento se registra como `registrar_produccion`, la acción más sensible que podría estar pidiendo.
  if (!(await puedeAlguno(req, 'produccion'))) { res.status(403).json({ error: SIN_PERMISO }); return; }
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
  const userId = req.user?.sub as number;
  // El ambiente de la credencial decide qué acción hace falta: se lee ANTES de desactivar.
  const ambiente = await ambienteDeCredencial(id);
  if (!ambiente) { res.status(404).json({ error: 'No encontrada' }); return; }
  if (!(await puedeAmbiente(req, ambiente))) { res.status(403).json({ error: SIN_PERMISO, ambiente }); return; }

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
