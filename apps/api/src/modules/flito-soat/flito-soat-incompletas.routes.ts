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
//   POST /cliente/incompletas/:id/reintentar — reintento manual de la consulta al RUNT
//        (`soat.solicitud.reintentar_runt`, HU #12998). 200 con `ResultadoReintentoRunt` en sus tres
//        desenlaces · 409 `incompleta_ya_resuelta` { estado } · 404 fuera de alcance · 429.
//
// PII (AGENTS.md §14): el filtro —VIN o documento del propietario— viaja SOLO en el cuerpo; en la URL
// solo el uuid opaco de la incompleta. Retención: la del canal Cliente, ver la cabecera del servicio.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { soatClienteLimiter, soatPreconsultaLimiter } from '../../shared/middleware/rateLimiter.js';
import { CodigoErrorSolicitudSoat, EstadoSolicitudIncompletaSoat, type ResultadoReintentoRunt } from '@operaciones/shared-types';
import { contextoSoat } from './flito-soat.service.js';
import { buscarIncompletas, detalleIncompleta } from './flito-soat-incompletas.service.js';
import { IncompletaYaResueltaError, reintentarIncompleta, type ReintentoHecho } from './flito-soat-incompletas-reintento.service.js';
import { SolicitudSoatError } from './flito-soat-cliente.service.js';
import {
  CAMPOS_PII_INCOMPLETA_DETALLE, CAMPOS_PII_INCOMPLETA_FILA, registrarAccesoIncompleta,
  registrarAccesoRuntCliente,
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

/** AC7: el reintento no lleva cuerpo; cualquier campo es 400. */
const reintentoSchema = z.object({}).strict();

/**
 * El rastro del artículo 17: el reintento consulta el RUNT (un registro NACIONAL) por el VIN de la
 * incompleta, igual que el alta (`motivo: 'reintento'`). Solo `completada` es una entrega; el resto
 * son intentos que no divulgaron nada, salvo el SOAT activo del descarte por vigencia.
 */
async function registrarConsultaReintento(req: Request, hecho: ReintentoHecho): Promise<void> {
  const r = hecho.respuesta;
  if (r.resultado === 'completada') {
    await registrarAccesoRuntCliente(req, {
      vin: hecho.vin, placa: hecho.placa, conPropietario: false, motivo: 'reintento',
      conVigenciaProxima: r.vigenciaProxima !== null,
    });
    return;
  }
  const resultado = r.resultado === 'sigue_incompleta' ? CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE : r.motivo;
  await registrarAccesoRuntCliente(req, {
    vin: hecho.vin, conPropietario: false, motivo: 'reintento', resultado,
    ...(r.resultado === 'descartada' && r.soatActivo
      ? { soatActivoEnIntento: r.soatActivo.vencimiento ? 'con_fecha' as const : 'sin_fecha' as const }
      : {}),
  });
}

/** El `detail` de auditoría: uuid opaco y desenlace; sin VIN, placa ni documento (AC10). */
function detalleAuditoria(hecho: ReintentoHecho): string {
  const r = hecho.respuesta;
  if (r.resultado === 'completada') return `Reintento RUNT de solicitud SOAT pendiente de validar: completada (soat=${r.soatId})`;
  if (r.resultado === 'descartada') return `Reintento RUNT de solicitud SOAT pendiente de validar: descartada (motivo=${r.motivo})`;
  return `Reintento RUNT de solicitud SOAT pendiente de validar: el RUNT sigue sin responder (intentos=${r.intentos})`;
}

router.post('/cliente/incompletas/:id/reintentar', exigirFuncion('soat.solicitud.reintentar_runt'),
  soatClienteLimiter, soatPreconsultaLimiter, async (req: Request, res: Response) => {
    if (!idSchema.safeParse(req.params.id).success) { res.status(404).json({ error: 'La solicitud no existe' }); return; }
    if (!reintentoSchema.safeParse(req.body ?? {}).success) { res.status(400).json({ error: 'El reintento no lleva datos' }); return; }

    const ctx = await contextoSoat(req.user!);
    let hecho: ReintentoHecho | null;
    try {
      hecho = await reintentarIncompleta(req.params.id, ctx);
    } catch (e) {
      if (e instanceof SolicitudSoatError) {
        // La carrera (AC6): el RUNT SÍ se consultó antes del 409, y esa consulta queda en el registro.
        if (e instanceof IncompletaYaResueltaError && e.runtConsultado) {
          try {
            await registrarAccesoRuntCliente(req, { vin: e.vin, conPropietario: false, motivo: 'reintento', resultado: e.codigo });
          } catch { /* el rastro no cambia la respuesta: mismo criterio que el alta */ }
        }
        res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.datos ?? {}) });
        return;
      }
      throw e;
    }
    // 404 y no 403 fuera de alcance (AC7): no se confirma que el id exista.
    if (!hecho) { res.status(404).json({ error: 'La solicitud no existe' }); return; }

    try { await registrarConsultaReintento(req, hecho); } catch { /* la fila ya cambió: el 200 manda */ }
    await audit(req, {
      action: 'update', resource: 'flito_soat_incompletas', resourceId: req.params.id,
      detail: detalleAuditoria(hecho),
    });
    if (hecho.respuesta.resultado === 'completada' && hecho.destino) {
      // Mismo rastro que el alta normal (HU #12078, AC7): a qué destino se despachó.
      const destino = hecho.destino.gestionOperaciones ? 'gestion_operaciones' : `proveedor=${hecho.destino.proveedorSoatId}`;
      await audit(req, {
        action: 'create', resource: 'flito_soat', resourceId: hecho.respuesta.soatId,
        detail: `Alta de solicitud SOAT del canal Cliente por reintento RUNT (origen=cliente, estado=${hecho.respuesta.estado}, destino=${destino})`,
      });
    }
    res.json(hecho.respuesta satisfies ResultadoReintentoRunt);
  });

export default router;
