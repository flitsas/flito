// FLITO — rutas de los servicios adicionales de un trámite (HU #12545, Feature #12544).
//
// Montado bajo `/api/finanzas` (app.ts), junto a `finanzas.routes.ts` pero en directorio PROPIO:
// `finanzas/` es legacy del motor de permisos (una sola `requireRole`, la valla lo vigila) y no
// admite `exigirFuncion`; este módulo nace reconducido (ADR-0017, opción D-a). Tres funciones:
//   · finanzas.servicios_adicionales.ver     → admin, financiera, auditor (mismo alcance que LECTURA)
//   · finanzas.servicios_adicionales.asignar → admin, financiera
//   · finanzas.servicios_adicionales.quitar  → admin, financiera
// Todo id que no sea uuid es 404 (el id es opaco), nunca 400 ni 22P02. Las mutaciones auditan con
// `resource: 'flito_tramite_servicio_adicional'` (AuditAction es cerrado: create/delete).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CODIGO_SERVICIO_ADICIONAL_TRAMITE as CODIGO } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  AsignacionNoEncontradaError, ServicioAdicionalTramiteError, ServicioYaAsignadoError, TipoNoDisponibleError,
  TramiteLiquidadoError, TramiteNoEncontradoError, asignar, listar, quitar,
} from './finanzas-servicios-adicionales.service.js';

const router = Router();
router.use(authMiddleware);

const uuidSchema = z.string().uuid();
/** Un id que no es uuid es «no existe» (404): el id es opaco para el cliente. */
const idUuid = (raw: string): string | null => (uuidSchema.safeParse(raw).success ? raw : null);

const asignarSchema = z.object({
  tipoId: z.string({ required_error: 'es obligatorio', invalid_type_error: 'debe ser texto' }).uuid('debe ser un uuid'),
});

/** «campo: regla» por cada problema, para que el 400 diga QUÉ campo y QUÉ regla. */
function mensajeDe(e: z.ZodError): string {
  return `Datos inválidos: ${e.issues.map((i) => (i.path.length ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ')}`;
}

/** La clase del error decide el código y el `codigo` del cuerpo. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof TramiteNoEncontradoError || e instanceof AsignacionNoEncontradaError) { res.status(404).json({ error: e.message }); return; }
  if (e instanceof TipoNoDisponibleError) { res.status(404).json({ error: e.message, codigo: CODIGO.TIPO_NO_DISPONIBLE }); return; }
  if (e instanceof ServicioYaAsignadoError) { res.status(409).json({ error: e.message, codigo: CODIGO.SERVICIO_YA_ASIGNADO }); return; }
  if (e instanceof TramiteLiquidadoError) { res.status(409).json({ error: e.message, codigo: CODIGO.TRAMITE_LIQUIDADO }); return; }
  if (e instanceof ServicioAdicionalTramiteError) { res.status(400).json({ error: e.message }); return; }
  throw e;
}

const NO_EXISTE_TRAMITE = { error: 'El trámite no existe' };

router.get('/tramites/:id/servicios-adicionales', exigirFuncion('finanzas.servicios_adicionales.ver'), async (req: Request, res: Response) => {
  const tramiteId = idUuid(req.params.id);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  try {
    const cuerpo = await listar(tramiteId);
    // Sin caché: un servicio asignado hace un segundo tiene que salir sin recargar la pantalla.
    res.set('Cache-Control', 'no-store');
    res.json(cuerpo);
  } catch (e) { fallo(res, e); }
});

router.post('/tramites/:id/servicios-adicionales', exigirFuncion('finanzas.servicios_adicionales.asignar'), async (req: Request, res: Response) => {
  const parsed = asignarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  const tramiteId = idUuid(req.params.id);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  try {
    const { asignacion, idFlit } = await asignar(tramiteId, parsed.data.tipoId, req.user?.sub ?? null);
    await audit(req, {
      action: 'create', resource: 'flito_tramite_servicio_adicional', resourceId: asignacion.id,
      detail: `Servicio «${asignacion.nombre}» (${asignacion.valor}) asignado al trámite ${idFlit}; tipo ${asignacion.tipoId}`,
    });
    res.status(201).json(asignacion);
  } catch (e) { fallo(res, e); }
});

router.delete('/tramites/:id/servicios-adicionales/:asignacionId', exigirFuncion('finanzas.servicios_adicionales.quitar'), async (req: Request, res: Response) => {
  const tramiteId = idUuid(req.params.id);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  const asignacionId = idUuid(req.params.asignacionId);
  if (asignacionId === null) { res.status(404).json({ error: 'La asignación no existe en este trámite' }); return; }
  try {
    const quitada = await quitar(tramiteId, asignacionId);
    // El `detail` lleva nombre y valor porque la fila ya no existe.
    await audit(req, {
      action: 'delete', resource: 'flito_tramite_servicio_adicional', resourceId: asignacionId,
      detail: `Servicio «${quitada.nombre}» (${quitada.valor}) quitado del trámite ${quitada.idFlit}; tipo ${quitada.tipoId}`,
    });
    res.status(204).end();
  } catch (e) { fallo(res, e); }
});

export default router;
