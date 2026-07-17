import { Router, Request, Response } from 'express';
import { eq, sql, and, inArray } from 'drizzle-orm';
import { ORGANISMOS_TRANSITO, isEstadoSttTraspaso } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { tramitesDigitales, vehicles, soatRequests } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { emitEvento } from './eventos.js';
import { notifyEstado } from './notificaciones.js';
import { appendEventoSafe } from '../vehicles/vehiculo-historial.js';
import { resolveTransitoScope } from './transito-scope.js';
import { soatVigenteDeRunt } from './soat-vigencia.js';

/**
 * TRAM-13 + TRAM-MT-01 — Bandeja de tránsito multitenant por organismo.
 * - Router: roles `admin` | `transito`.
 * - Scope: usuario tránsito solo ve su organismo; admin ve todos (o ?organismo=).
 * - POST tomar/asignar/confirmar: validación de scope + recibidoPor donde aplica.
 */
const router = Router();
router.use(authMiddleware, requireRole('admin', 'transito'));

function organismoFilter(scopeCodigo: string | null) {
  if (!scopeCodigo) return undefined;
  return eq(tramitesDigitales.organismoCodigo, scopeCodigo);
}

// GET /organismos — Catálogo nacional (autenticado tránsito/admin).
router.get('/organismos', (_req: Request, res: Response) => {
  res.json(ORGANISMOS_TRANSITO);
});

// GET /pendientes — Trámites enviados a tránsito (sin tomar), filtrados por organismo.
router.get('/pendientes', async (req: Request, res: Response) => {
  try {
    const scope = await resolveTransitoScope(req);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }

    const conditions = [eq(tramitesDigitales.estado, 'enviado_transito')];
    const orgFilter = organismoFilter(scope.codigo);
    if (orgFilter) conditions.push(orgFilter);

    const result = await db.select().from(tramitesDigitales)
      .where(and(...conditions))
      .orderBy(sql`${tramitesDigitales.updatedAt} DESC`);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /mis-tramites — Trámites tomados por este usuario de tránsito (scope organismo).
router.get('/mis-tramites', async (req: Request, res: Response) => {
  try {
    const scope = await resolveTransitoScope(req);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }

    const conditions = [
      eq(tramitesDigitales.recibidoPor, req.user!.sub),
      sql`${tramitesDigitales.estado} IN ('recibido_transito', 'placa_preasignada')`,
    ];
    const orgFilter = organismoFilter(scope.codigo);
    if (orgFilter) conditions.push(orgFilter);

    const result = await db.select().from(tramitesDigitales)
      .where(and(...conditions))
      .orderBy(sql`${tramitesDigitales.updatedAt} DESC`);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /traspasos — Bandeja STT de traspasos (modalidad traspaso + estados STT activos).
router.get('/traspasos', async (req: Request, res: Response) => {
  try {
    const scope = await resolveTransitoScope(req);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }

    const estadoQ = typeof req.query.estado === 'string' ? req.query.estado.trim() : '';
    const conditions = [
      eq(tramitesDigitales.modalidadEntrada, 'traspaso'),
      sql`${tramitesDigitales.estado} NOT IN ('entregado', 'anulado', 'rechazado')`,
    ];
    const orgFilter = organismoFilter(scope.codigo);
    if (orgFilter) conditions.push(orgFilter);
    if (estadoQ && isEstadoSttTraspaso(estadoQ)) {
      conditions.push(eq(tramitesDigitales.estado, estadoQ));
    }

    const result = await db.select({
      id: tramitesDigitales.id,
      vin: tramitesDigitales.vin,
      placa: tramitesDigitales.placa,
      estado: tramitesDigitales.estado,
      organismoCodigo: tramitesDigitales.organismoCodigo,
      numeroRadicado: tramitesDigitales.numeroRadicado,
      vehiculo: tramitesDigitales.vehiculo,
      comprador: tramitesDigitales.comprador,
      createdAt: tramitesDigitales.createdAt,
      updatedAt: tramitesDigitales.updatedAt,
    }).from(tramitesDigitales)
      .where(and(...conditions))
      .orderBy(sql`${tramitesDigitales.updatedAt} DESC`);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /traspasos/:id — Detalle STT de un traspaso (scope organismo + modalidad traspaso).
router.get('/traspasos/:id', async (req: Request, res: Response) => {
  try {
    const scope = await resolveTransitoScope(req);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

    const [row] = await db.select({
      id: tramitesDigitales.id,
      vin: tramitesDigitales.vin,
      placa: tramitesDigitales.placa,
      estado: tramitesDigitales.estado,
      paso: tramitesDigitales.paso,
      organismoCodigo: tramitesDigitales.organismoCodigo,
      numeroRadicado: tramitesDigitales.numeroRadicado,
      modalidadEntrada: tramitesDigitales.modalidadEntrada,
      vehiculo: tramitesDigitales.vehiculo,
      comprador: tramitesDigitales.comprador,
      checklistEstado: tramitesDigitales.checklistEstado,
      tipologiaCodigo: tramitesDigitales.tipologiaCodigo,
      furGenerado: tramitesDigitales.furGenerado,
      workflow: tramitesDigitales.workflow,
      notas: tramitesDigitales.notas,
      createdAt: tramitesDigitales.createdAt,
      updatedAt: tramitesDigitales.updatedAt,
    }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
    if (!row || row.modalidadEntrada !== 'traspaso') {
      res.status(404).json({ error: 'Traspaso no encontrado' });
      return;
    }
    if (scope.codigo && row.organismoCodigo && row.organismoCodigo !== scope.codigo) {
      res.status(403).json({ error: 'Este traspaso pertenece a otro organismo de tránsito' });
      return;
    }
    res.json(row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /tomar/:id — Tránsito toma un trámite de su organismo.
router.post('/tomar/:id', async (req: Request, res: Response) => {
  try {
    const scope = await resolveTransitoScope(req);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }

    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const [existing] = await db.select({
      estado: tramitesDigitales.estado,
      organismoCodigo: tramitesDigitales.organismoCodigo,
    }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);

    if (!existing || existing.estado !== 'enviado_transito') {
      res.status(404).json({ error: 'Trámite no encontrado o ya fue tomado' });
      return;
    }
    if (scope.codigo && existing.organismoCodigo !== scope.codigo) {
      res.status(403).json({ error: 'Este trámite pertenece a otro organismo de tránsito' });
      return;
    }

    const [updated] = await db.update(tramitesDigitales).set({
      estado: 'recibido_transito',
      recibidoPor: req.user!.sub,
      recibidoAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(tramitesDigitales.id, id),
      eq(tramitesDigitales.estado, 'enviado_transito'),
      scope.codigo ? eq(tramitesDigitales.organismoCodigo, scope.codigo) : sql`true`,
    )).returning();

    if (!updated) { res.status(404).json({ error: 'Trámite no encontrado o ya fue tomado' }); return; }
    await audit(req, { action: 'update', resource: 'tramite', resourceId: String(id), detail: 'Recibido por tránsito' });
    emitEvento({ tramiteId: id, tipo: 'recibido_transito', actorUserId: req.user!.sub, actorRole: req.user!.role });
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /asignar-placa/:id — Tránsito asigna placa
router.post('/asignar-placa/:id', async (req: Request, res: Response) => {
  try {
    const scope = await resolveTransitoScope(req);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }

    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const { placa } = req.body;
    if (!placa || typeof placa !== 'string' || placa.length < 4 || placa.length > 10) {
      res.status(400).json({ error: 'Placa inválida (4-10 caracteres)' }); return;
    }
    const placaClean = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');

    const where = [
      eq(tramitesDigitales.id, id),
      eq(tramitesDigitales.recibidoPor, req.user!.sub),
      eq(tramitesDigitales.estado, 'recibido_transito'),
    ];
    if (scope.codigo) where.push(eq(tramitesDigitales.organismoCodigo, scope.codigo));

    const [updated] = await db.update(tramitesDigitales).set({
      estado: 'placa_preasignada',
      placa: placaClean,
      // Mantener el JSONB vehiculo.placa en sincronía con la columna: la lista lee
      // la columna y el detalle/expediente lee el JSONB; si divergen, muestran
      // placas distintas (bug: columna KLM123 vs vehiculo.placa QYQ132).
      vehiculo: sql`jsonb_set(coalesce(${tramitesDigitales.vehiculo}, '{}'::jsonb), '{placa}', to_jsonb(${placaClean}::text), true)`,
      placaAsignadaAt: new Date(),
      updatedAt: new Date(),
    }).where(and(...where)).returning();

    if (!updated) { res.status(404).json({ error: 'Trámite no encontrado o no asignado a usted' }); return; }
    await audit(req, { action: 'update', resource: 'tramite', resourceId: String(id), detail: `Placa preasignada: ${placaClean}` });
    emitEvento({ tramiteId: id, tipo: 'placa_asignada', actorUserId: req.user!.sub, actorRole: req.user!.role, payload: { placa: placaClean } });
    notifyEstado(id, 'placa_asignada').catch(() => {});
    if (updated.vin) await appendEventoSafe({ vin: updated.vin, eventoTipo: 'tramite_placa_asignada', payload: { placa: placaClean }, referenciaTramiteId: id });
    res.json(updated);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /confirmar-placa/:id — Tránsito confirma placa → crea vehículo + (si falta
// SOAT vigente) solicitud SOAT → solicitud_soat; si ya hay SOAT vigente → soat_verificado.
router.post('/confirmar-placa/:id', async (req: Request, res: Response) => {
  try {
    const scope = await resolveTransitoScope(req);
    if (!scope.ok) { res.status(scope.status).json({ error: scope.error }); return; }

    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const result = await db.transaction(async (tx) => {
      const confirmWhere = [
        eq(tramitesDigitales.id, id),
        eq(tramitesDigitales.recibidoPor, req.user!.sub),
        eq(tramitesDigitales.estado, 'placa_preasignada'),
      ];
      if (scope.codigo) confirmWhere.push(eq(tramitesDigitales.organismoCodigo, scope.codigo));

      // Decidir según SOAT vigente del RUNT (antes de fijar el estado).
      const [pre] = await tx.select({ vehiculo: tramitesDigitales.vehiculo })
        .from(tramitesDigitales).where(and(...confirmWhere)).limit(1);
      if (!pre) return null;
      const vPre = (pre.vehiculo || {}) as any;
      const vigente = soatVigenteDeRunt(vPre);
      const estadoFinal = vigente ? 'soat_verificado' : 'solicitud_soat';
      const stageFinal = vigente ? 'soat_verificado' : 'soat_pendiente';

      const [updated] = await tx.update(tramitesDigitales).set({
        estado: estadoFinal,
        placaAsignadaAt: new Date(),
        updatedAt: new Date(),
      }).where(and(...confirmWhere)).returning();

      if (!updated) return null;

      const v = (updated.vehiculo || {}) as any;
      const c = (updated.comprador || {}) as any;
      const soat = Array.isArray(v.soat) ? v.soat[0] : v.soat;
      const vinClean = (updated.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

      const [veh] = await tx.insert(vehicles).values({
        vin: vinClean, plate: updated.placa, ownerName: c.nombre, ownerDocument: c.documento,
        brand: v.marca, model: v.linea, year: v.modelo ? parseInt(v.modelo) : null,
        vehicleClass: v.claseVehiculo || v.clase, stage: stageFinal,
      }).onConflictDoUpdate({
        target: vehicles.vin,
        set: {
          plate: updated.placa, ownerName: c.nombre, ownerDocument: c.documento,
          brand: v.marca, model: v.linea, year: v.modelo ? parseInt(v.modelo) : null,
          vehicleClass: v.claseVehiculo || v.clase, stage: stageFinal, updatedAt: new Date(),
        },
      }).returning();

      const [existingSoat] = await tx.select({ id: soatRequests.id })
        .from(soatRequests)
        .where(and(eq(soatRequests.vehicleId, veh.id), inArray(soatRequests.status, ['pendiente', 'comprado', 'verificado'])))
        .limit(1);

      if (!existingSoat) {
        if (vigente) {
          // SOAT vigente en RUNT: registrar como verificado (no se pide nada).
          await tx.insert(soatRequests).values({
            vehicleId: veh.id, tramiteId: id, status: 'verificado', runtVerified: true, runtVerifiedAt: new Date(),
            policyNumber: soat?.numSoat || soat?.noPoliza || null,
            insurer: soat?.razonSocialAsegur || soat?.aseguradora || null,
            expiryDate: soat?.fechaVencimSoat ? String(soat.fechaVencimSoat).split('T')[0] : null,
            requestedBy: req.user!.sub,
            notes: `Matrícula inicial MI-${String(id).padStart(4, '0')} — SOAT vigente detectado en RUNT (placa ${updated.placa})`,
          });
        } else {
          await tx.insert(soatRequests).values({
            vehicleId: veh.id, tramiteId: id, status: 'pendiente', requestedBy: req.user!.sub,
            notes: `Matrícula inicial trámite MI-${String(id).padStart(4, '0')} — Placa ${updated.placa}`,
          });
        }
      }

      return { ...updated, vehicleId: veh.id, soatVigente: vigente };
    });

    if (!result) { res.status(404).json({ error: 'Trámite no encontrado' }); return; }
    await audit(req, { action: 'update', resource: 'tramite', resourceId: String(id), detail: `Placa confirmada: ${result.placa}, vehículo ${result.vehicleId}, solicitud SOAT` });
    emitEvento({ tramiteId: id, tipo: 'placa_asignada', actorUserId: req.user!.sub, actorRole: req.user!.role, payload: { placa: result.placa, confirmada: true } });
    if (result.vin) await appendEventoSafe({ vin: result.vin, eventoTipo: 'tramite_placa_asignada', payload: { placa: result.placa, confirmada: true }, referenciaTramiteId: id });
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
