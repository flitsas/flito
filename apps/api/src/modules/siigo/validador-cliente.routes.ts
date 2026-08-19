// Siigo API — informe de clientes no facturables (HU #11296). Montado en /api/siigo/clientes.
//
// Permisos (AC7): los mismos que leen clientes. Es un informe de lectura y **no permite modificar
// nada**: quien corrige un cliente lo hace por la ruta de clientes, con su propia guarda y su
// auditoría. Un informe que además edita se convierte en una segunda puerta a los mismos datos con
// permisos distintos, que es cómo se cuelan las inconsistencias de autorización.
//
// Ninguna ruta de aquí llama a Siigo (AC6): todo sale de la copia local.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { MOTIVOS_NO_FACTURABLE_CODIGOS } from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  informeClientes, recalcularDuplicados, resumenValidacionClientes, veredictoCliente,
} from './siigo.validador-cliente.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');
const ESCRITURA = requireRole('admin');

const informeSchema = z.object({
  motivo: z.enum(MOTIVOS_NO_FACTURABLE_CODIGOS as [string, ...string[]]).optional(),
  // Llega por query string. `'true'` explícito y nada más: un `?incluirFacturables=0` interpretado
  // como verdadero devolvería una lista que no es la que se pidió.
  incluirFacturables: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// GET /validacion — conteos por motivo: por dónde empezar a corregir.
router.get('/validacion', LECTURA, async (_req: Request, res: Response) => {
  res.json(await resumenValidacionClientes());
});

// GET /validacion/detalle — la lista, filtrable por motivo (AC5).
router.get('/validacion/detalle', LECTURA, async (req: Request, res: Response) => {
  const parsed = informeSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtros inválidos', details: parsed.error.flatten() });
    return;
  }
  const { motivo, incluirFacturables, limit, offset } = parsed.data;
  res.json(await informeClientes({
    motivo: motivo as never,
    incluirFacturables: incluirFacturables === 'true',
    limit,
    offset,
  }));
});

// GET /:id/validacion — el veredicto de un cliente puntual (AC5).
//
// Va DESPUÉS de las rutas fijas para que Express no capture `validacion` como un identificador.
router.get('/:id/validacion', LECTURA, async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  const veredicto = await veredictoCliente(id);
  if (veredicto === null) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }
  res.json(veredicto);
});

// POST /validacion/recalcular-duplicados — revisa los conflictos de identidad sobre los datos de hoy.
//
// La migración 0132 marcó los duplicados que existían entonces, pero nada volvía a mirarlos: uno
// creado después quedaría sin marca y por tanto pareciendo limpio, y uno ya resuelto arrastraría la
// marca para siempre. Es idempotente y no toca ningún otro campo.
router.post('/validacion/recalcular-duplicados', ESCRITURA, async (req: Request, res: Response) => {
  const resultado = await recalcularDuplicados();
  await audit(req, {
    action: 'update',
    resource: 'siigo_validacion_clientes',
    detail: `Conflictos de identidad recalculados: ${resultado.marcados} marcados, `
      + `${resultado.desmarcados} desmarcados`,
  });
  res.json(resultado);
});

export default router;
