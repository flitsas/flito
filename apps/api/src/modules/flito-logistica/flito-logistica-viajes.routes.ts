// FLITO — rutas de los viajes adicionales de logística de un trámite (HU #12619, Feature #12617).
//
// Montado bajo `/api/flito/logistica` (app.ts) junto al router legado de logística, en fichero
// PROPIO: aquel está contra su techo de líneas y su `GET /:id` no choca con `/tramites/:id/viajes`.
// Tres funciones, sembradas por la 0199 SOLO a admin (el administrador reparte desde el panel):
//   · logistica.viajes.ver       → GET    /tramites/:tramiteId/viajes
//   · logistica.viajes.registrar → POST   /tramites/:tramiteId/viajes
//   · logistica.viajes.quitar    → DELETE /tramites/:tramiteId/viajes/:viajeId
// Sin PUT/PATCH: un viaje se quita y se vuelve a registrar. Todo id que no sea uuid es 404 (el id es
// opaco), nunca 400 ni 22P02. Las mutaciones auditan con `resource: 'flito_tramite_viaje_logistica'`
// y un `detail` sin PII (idFlit, número, modo y valor).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { MOTIVOS_VIAJE_LOGISTICA } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  TramiteNoEncontradoError, ViajeLogisticaError, ViajeNoEncontradoError, listar, quitar, registrar,
} from './flito-logistica-viajes.service.js';

const router = Router();
router.use(authMiddleware);

const uuidSchema = z.string().uuid();
/** Un id que no es uuid es «no existe» (404): el id es opaco para el cliente. */
const idUuid = (raw: string): string | null => (uuidSchema.safeParse(raw).success ? raw : null);

/** Tope de numeric(14,2): por encima la base respondería 22003 y aquí sería un 500 sin explicación. */
const VALOR_MAXIMO = 999_999_999_999.99;

const motivoYDetalle = {
  motivo: z.enum(MOTIVOS_VIAJE_LOGISTICA, {
    required_error: 'es obligatorio',
    invalid_type_error: `debe ser uno de: ${MOTIVOS_VIAJE_LOGISTICA.join(', ')}`,
  }),
  motivoDetalle: z.string({ invalid_type_error: 'debe ser texto' }).trim()
    .min(1, 'no puede estar en blanco').max(300, 'no puede superar 300 caracteres').optional(),
};

/** `inicial` no admite `valor` (strict: copia la tarifa); `manual` lo exige. */
const registrarSchema = z.discriminatedUnion('modo', [
  z.object({ modo: z.literal('inicial'), ...motivoYDetalle }).strict(),
  z.object({
    modo: z.literal('manual'),
    valor: z.number({ required_error: 'es obligatorio', invalid_type_error: 'debe ser un número' })
      .finite('debe ser un número').min(0, 'debe ser mayor o igual a 0').max(VALOR_MAXIMO, 'supera el máximo'),
    ...motivoYDetalle,
  }).strict(),
]).superRefine((d, ctx) => {
  if (d.motivo === 'otro' && d.motivoDetalle === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['motivoDetalle'], message: 'es obligatorio cuando el motivo es «otro»' });
  }
});

/** «campo: regla» por cada problema, para que el 400 diga QUÉ campo y QUÉ regla. */
function mensajeDe(e: z.ZodError): string {
  return `Datos inválidos: ${e.issues.map((i) => (i.path.length ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ')}`;
}

const NO_EXISTE_TRAMITE = { error: 'El trámite no existe' };

/** La clase del error decide el código y el `codigo` del cuerpo. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof TramiteNoEncontradoError) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  if (e instanceof ViajeLogisticaError) { res.status(e.status).json({ error: e.message, codigo: e.codigo }); return; }
  throw e;
}

router.get('/tramites/:tramiteId/viajes', exigirFuncion('logistica.viajes.ver'), async (req: Request, res: Response) => {
  const tramiteId = idUuid(req.params.tramiteId);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  try {
    const cuerpo = await listar(tramiteId);
    // Sin caché: un viaje registrado hace un segundo tiene que salir sin recargar la pantalla.
    res.set('Cache-Control', 'no-store');
    res.json(cuerpo);
  } catch (e) { fallo(res, e); }
});

router.post('/tramites/:tramiteId/viajes', exigirFuncion('logistica.viajes.registrar'), async (req: Request, res: Response) => {
  const parsed = registrarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  const tramiteId = idUuid(req.params.tramiteId);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  try {
    const { viaje, idFlit } = await registrar(tramiteId, parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'create', resource: 'flito_tramite_viaje_logistica', resourceId: viaje.id,
      detail: `Viaje adicional #${viaje.numero} (${viaje.modo}, ${viaje.valor}) registrado en el trámite ${idFlit}`,
    });
    res.status(201).json(viaje);
  } catch (e) { fallo(res, e); }
});

router.delete('/tramites/:tramiteId/viajes/:viajeId', exigirFuncion('logistica.viajes.quitar'), async (req: Request, res: Response) => {
  const tramiteId = idUuid(req.params.tramiteId);
  if (tramiteId === null) { res.status(404).json(NO_EXISTE_TRAMITE); return; }
  const viajeId = idUuid(req.params.viajeId);
  if (viajeId === null) { fallo(res, new ViajeNoEncontradoError()); return; }
  try {
    const quitado = await quitar(tramiteId, viajeId);
    // El `detail` lleva número, modo y valor porque la fila ya no existe.
    await audit(req, {
      action: 'delete', resource: 'flito_tramite_viaje_logistica', resourceId: viajeId,
      detail: `Viaje adicional #${quitado.numero} (${quitado.modo}, ${quitado.valor}) quitado del trámite ${quitado.idFlit}`,
    });
    res.status(204).end();
  } catch (e) { fallo(res, e); }
});

export default router;
