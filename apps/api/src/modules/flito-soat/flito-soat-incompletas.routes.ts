// FLITO — SOAT, canal Cliente (HTTP): lectura de las solicitudes INCOMPLETAS por RUNT caído.
// Feature #12841, HU #12997. Diseño: docs/diseno-feature-12841-solicitud-incompleta-runt.md (§11 manda).
// Montado en `/api/flito/soat`, ANTES del router del módulo (ver `app.ts`).
//
//   POST /cliente/incompletas/buscar — pastillas «Por validar» / «Descartadas» (`soat.incompletas.buscar`).
//   GET  /cliente/incompletas/:id    — detalle (`soat.incompleta.ver`), 404-no-403 fuera de alcance.
//
// Funciones PROPIAS y no las de la cola (§11.1 del diseño, opción A): el catálogo es «una función por
// ruta». La 0211 las reparte a todo rol que ya tenga `soat.cola.ver` / `soat.solicitud.ver`, así que
// quien ve la cola ve sus incompletas aunque no pueda reintentarlas (P-2 del UX).
// `soat.solicitud.reintentar_runt` no guarda nada aquí (HU #12998).
//
// PII (AGENTS.md §14): el filtro —VIN o documento del propietario— viaja SOLO en el cuerpo; en la URL
// solo el uuid opaco de la incompleta. Retención: la del canal Cliente, ver la cabecera del servicio.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { EstadoSolicitudIncompletaSoat } from '@operaciones/shared-types';
import { contextoSoat } from './flito-soat.service.js';
import { buscarIncompletas, detalleIncompleta } from './flito-soat-incompletas.service.js';
import {
  CAMPOS_PII_INCOMPLETA_DETALLE, CAMPOS_PII_INCOMPLETA_FILA, registrarAccesoIncompleta,
} from './flito-soat.pii.js';

const router = Router();
router.use(authMiddleware);

const ESTADOS = [
  EstadoSolicitudIncompletaSoat.INCOMPLETA,
  EstadoSolicitudIncompletaSoat.DESCARTADA,
  EstadoSolicitudIncompletaSoat.COMPLETADA,
] as const;

/** AC2: `.strict()` — un campo extra es 400, no se ignora. */
export const buscarIncompletasSchema = z.object({
  estados: z.array(z.enum(ESTADOS)).min(1).default([EstadoSolicitudIncompletaSoat.INCOMPLETA]),
  texto: z.string().trim().max(40).optional(),
  pagina: z.number().int().min(1).default(1),
  porPagina: z.number().int().min(1).max(100).default(25),
}).strict();

router.post('/cliente/incompletas/buscar', exigirFuncion('soat.incompletas.buscar'), async (req: Request, res: Response) => {
  // Se valida ANTES de resolver el contexto: un body inválido no toca la base (AC2).
  const parsed = buscarIncompletasSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Filtro inválido', detalles: parsed.error.flatten() }); return; }
  const { estados, texto, pagina, porPagina } = parsed.data;

  const ctx = await contextoSoat(req.user!);
  const r = await buscarIncompletas({
    estados: [...new Set(estados)], texto: texto || undefined, pagina, porPagina,
  }, ctx);
  // Sin filas no se entregó ningún dato personal: no se anota un acceso que no ocurrió.
  if (r.items.length > 0) {
    await registrarAccesoIncompleta(req, { accion: 'search', filas: r.items.length, campos: CAMPOS_PII_INCOMPLETA_FILA });
  }
  res.json(r);
});

const idSchema = z.string().uuid();

router.get('/cliente/incompletas/:id', exigirFuncion('soat.incompleta.ver'), async (req: Request, res: Response) => {
  if (!idSchema.safeParse(req.params.id).success) { res.status(404).json({ error: 'La solicitud no existe' }); return; }
  const ctx = await contextoSoat(req.user!);
  const d = await detalleIncompleta(req.params.id, ctx);
  // 404 y no 403 fuera de alcance (AC3): no se confirma que el id exista. Tampoco se anota.
  if (!d) { res.status(404).json({ error: 'La solicitud no existe' }); return; }
  await registrarAccesoIncompleta(req, {
    accion: 'read', incompletaId: d.id, vin: d.vin, filas: 1, campos: CAMPOS_PII_INCOMPLETA_DETALLE,
  });
  res.json(d);
});

export default router;
