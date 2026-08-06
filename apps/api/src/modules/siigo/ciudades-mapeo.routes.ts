// Siigo API — equivalencia de la ciudad en texto libre (HU #11294).
// Montado en /api/siigo/clientes-ciudades.
//
// Permisos (AC7): lectura para quien lee clientes; **confirmar es escritura sobre el cliente**, así
// que va con el mismo rol que edita clientes (`admin`) y no con el de solo lectura. Confirmar fija
// el municipio que va a salir impreso en una factura ante la DIAN: no es un gesto de consulta.
//
// Ninguna ruta llama a Siigo: todo sale del catálogo local.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  SiigoCiudadMapeoError, confirmarCiudad, equivalenciasObsoletas,
  estadoMapeoCiudades, proponerEquivalencias,
} from './siigo.ciudades-mapeo.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');
const ESCRITURA = requireRole('admin');

const paisSchema = z.object({ pais: z.string().regex(/^[A-Za-z]{2}$/).optional() });

const confirmarSchema = z.object({
  countryCode: z.string().regex(/^[A-Za-z]{2}$/),
  stateCode: z.string().regex(/^[0-9]{1,5}$/),
  cityCode: z.string().regex(/^[0-9]{1,10}$/),
});

/** Traduce los fallos del servicio a un status. El mensaje es nuestro: no lleva nada de Siigo. */
function responderError(res: Response, e: unknown): boolean {
  if (!(e instanceof SiigoCiudadMapeoError)) return false;
  const status = e.codigo === 'cliente_no_encontrado' ? 404 : e.codigo === 'catalogo_vacio' ? 409 : 400;
  res.status(status).json({ error: e.message, codigo: e.codigo });
  return true;
}

// GET /estado — cuánto falta y de qué tipo (AC6).
router.get('/estado', LECTURA, async (req: Request, res: Response) => {
  const parsed = paisSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'País inválido' }); return; }
  try {
    res.json(await estadoMapeoCiudades(parsed.data.pais));
  } catch (e) {
    if (!responderError(res, e)) throw e;
  }
});

// GET /propuestas — la equivalencia propuesta de cada cliente pendiente (AC1, AC2, AC3).
router.get('/propuestas', LECTURA, async (req: Request, res: Response) => {
  const parsed = paisSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'País inválido' }); return; }
  try {
    const data = await proponerEquivalencias(parsed.data.pais);
    res.json({ total: data.length, data });
  } catch (e) {
    if (!responderError(res, e)) throw e;
  }
});

// GET /obsoletas — equivalencias cuyo texto de origen cambió después de confirmarse.
router.get('/obsoletas', LECTURA, async (_req: Request, res: Response) => {
  const data = await equivalenciasObsoletas();
  res.json({ total: data.length, data });
});

// POST /:id/confirmar — fija los códigos de un cliente (AC4).
router.post('/:id/confirmar', ESCRITURA, async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  const parsed = confirmarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  try {
    const r = await confirmarCiudad({ ...parsed.data, clienteId: id, usuarioId: req.user?.sub as number });
    await audit(req, {
      action: 'update',
      resource: 'client',
      resourceId: String(id),
      // Sin PII: el municipio y su código no identifican a nadie.
      detail: `Ciudad confirmada: ${r.cityName} (${parsed.data.countryCode}/${parsed.data.stateCode}/${r.cityCode})`,
    });
    res.json(r);
  } catch (e) {
    if (!responderError(res, e)) throw e;
  }
});

export default router;
