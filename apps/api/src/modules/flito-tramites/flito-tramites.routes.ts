// FLITO Trámites unificado (HTTP). Porta packages/server/src/tramites/tramites.controlador.ts. Montado
// en /api/flito/tramites (coexiste con /api/tramites del grande). Los gestores NO entran: cada uno sigue
// en su propia cola (/soat, /impuestos); esta es la vista de quien despacha. Lectura Operaciones/Auditoría.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  crearEmpresaDesdeTramite, crearTramiteDemo, entregar, facetas, historial, listar, solicitarAmbos,
  solicitarImpuestos, solicitarSoat, type FiltrosListado, type TramitesCtx,
} from './flito-tramites.service.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('admin');
const LECTURA = requireRole('admin', 'auditor');

function ctxDe(user: { sub: number; username: string; role: string }): TramitesCtx {
  return { userId: user.sub, username: user.username, role: user.role };
}

const loteSchema = z.object({ tramiteIds: z.array(z.string().uuid()).min(1) });
const soatSchema = loteSchema.extend({ proveedorSoatId: z.string().uuid() });

function bad(res: Response): void { res.status(400).json({ error: 'Datos inválidos' }); }

// GET / — tabla unificada, PAGINADA y filtrada en servidor.
// Query: buscar, estado, tipoTramite, transito, ciudad, compania, soat=a,b, impuesto=c,d, page, pageSize.
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const q = req.query;
  const filtros: FiltrosListado = {
    buscar: str(q.buscar), estados: lista(q.estados), transitos: lista(q.transitos), ciudades: lista(q.ciudades),
    empresas: lista(q.empresas), soat: lista(q.soat), impuesto: lista(q.impuesto),
    page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 50,
  };
  res.json(await listar(filtros));
});

// GET /facetas — valores distintos para los dropdowns de filtro.
router.get('/facetas', LECTURA, async (_req: Request, res: Response) => {
  res.json(await facetas());
});

// GET /:id/historial — auditoría de cambios del trámite (campo por campo). Operaciones/Auditoría.
router.get('/:id/historial', LECTURA, async (req: Request, res: Response) => {
  res.json(await historial(req.params.id));
});

// POST /crear-empresa — crea la empresa (cliente) de un trámite con empresa inexistente y re-vincula
// por NIT los trámites pendientes. Solo Operaciones.
const crearEmpresaSchema = z.object({
  nombre: z.string().trim().min(1), nit: z.string().trim().min(1),
  soatAutogestionable: z.boolean().optional(), impuestosAutogestionable: z.boolean().optional(),
  logisticaAutogestionable: z.boolean().optional(),
});
router.post('/crear-empresa', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = crearEmpresaSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const d = parsed.data;
  const r = await crearEmpresaDesdeTramite(d.nombre, d.nit, {
    soat: d.soatAutogestionable ?? false, impuestos: d.impuestosAutogestionable ?? false, logistica: d.logisticaAutogestionable ?? false,
  }, ctxDe(req.user!));
  await audit(req, { action: 'create', resource: 'flito_tramite', detail: `Empresa ${parsed.data.nit} ${r.yaExistia ? 'reutilizada' : 'creada'}; ${r.revinculados} trámites re-vinculados` });
  res.json(r);
});

// POST /demo — crea un trámite DEMO aprobado (vehículo + trámite + comprador) para probar Logística
// sin depender del sync de FLIT. Solo Operaciones.
const demoSchema = z.object({
  placa: z.string().trim().min(4), vin: z.string().trim().min(11),
  propietarioNombre: z.string().trim().min(2), propietarioDocumento: z.string().trim().optional(),
  marca: z.string().trim().optional(), linea: z.string().trim().optional(), modelo: z.number().int().optional(),
  companiaId: z.number().int().positive(), organismoCodigo: z.string().trim().min(3),
  transitoNombre: z.string().trim().optional(), idFlit: z.string().trim().optional(),
  flitEstado: z.string().trim().optional(),
});
router.post('/demo', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = demoSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  try {
    const r = await crearTramiteDemo(parsed.data, ctxDe(req.user!));
    await audit(req, { action: 'create', resource: 'flito_tramite', detail: `Trámite DEMO ${r.idFlit} (placa ${r.placa}) creado` });
    res.status(201).json(r);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// POST /solicitar-soat — envío al gestor SOAT del lote, fijando proveedor. Solo Operaciones.
router.post('/solicitar-soat', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = soatSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const r = await solicitarSoat(parsed.data.tramiteIds, parsed.data.proveedorSoatId, ctxDe(req.user!));
  await audit(req, { action: 'update', resource: 'flito_tramite', detail: `Solicitud SOAT: ${r.enviados} enviados, ${r.yaEnviados} ya enviados, ${r.autogestionados} autogestionados, ${r.sinRegistro} sin registro` });
  res.json(r);
});

// POST /solicitar-impuestos — envío al gestor de impuestos (solo los que tienen factura de venta).
router.post('/solicitar-impuestos', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = loteSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const r = await solicitarImpuestos(parsed.data.tramiteIds, ctxDe(req.user!));
  await audit(req, { action: 'update', resource: 'flito_tramite', detail: `Solicitud impuestos: ${r.enviados} enviados, ${r.yaEnviados} ya enviados, ${r.noEnviables} no enviables` });
  res.json(r);
});

// POST /solicitar-ambos — SOAT y luego impuestos, secuencial.
router.post('/solicitar-ambos', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = soatSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const r = await solicitarAmbos(parsed.data.tramiteIds, parsed.data.proveedorSoatId, ctxDe(req.user!));
  await audit(req, { action: 'update', resource: 'flito_tramite', detail: `Solicitud SOAT+impuestos sobre ${parsed.data.tramiteIds.length} trámites` });
  res.json(r);
});

// POST /entregar — entrega en lote (delega en compuerta, que revalida cada uno). Solo Operaciones.
router.post('/entregar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = loteSchema.safeParse(req.body);
  if (!parsed.success) { bad(res); return; }
  const r = await entregar(parsed.data.tramiteIds, ctxDe(req.user!));
  await audit(req, { action: 'update', resource: 'flito_tramite', detail: `Entrega en lote: ${r.entregados} entregados, ${r.noHabilitados.length} no habilitados` });
  res.json(r);
});

export default router;
