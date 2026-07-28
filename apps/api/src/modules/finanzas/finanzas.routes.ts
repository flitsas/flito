// Finanzas (HTTP). Montado en /api/finanzas. Lectura para el rol `financiera` (+ admin/auditor).

import { Router, type Request, type Response } from 'express';
import { eq, and } from 'drizzle-orm';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { db } from '../../db/client.js';
import { flitoDerechosTramite, flitoImpuestos, flitoSoat, flitoSoportes, flitoTramites } from '../../db/schema.js';
import { firmarDescargaEntidad } from '../../services/storage.js';
import {
  aCsv, facetas, filasParaExportar, reporteCostos, TOPE_EXPORTACION, type FiltrosReporte,
} from './finanzas.service.js';

const router = Router();
router.use(authMiddleware);

// `auditor` estaba documentado en la cabecera de este archivo desde el principio pero NO en el
// requireRole, así que un auditor recibía 403 en el reporte mientras sí podía ver los derechos que
// lo alimentan. Se corrige aquí.
const LECTURA = requireRole('financiera', 'admin', 'auditor');

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};
const siNo = (v: unknown): 'si' | 'no' | undefined => (v === 'si' || v === 'no' ? v : undefined);
/** Solo yyyy-mm-dd: el valor entra en un cast a `date` y no puede ser texto libre. */
const fecha = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};

function filtrosDe(q: Request['query']): FiltrosReporte {
  return {
    buscar: str(q.buscar), estados: lista(q.estados), empresas: lista(q.empresas), tipos: lista(q.tipos),
    liquidado: siNo(q.liquidado), facturado: siNo(q.facturado),
    desde: fecha(q.desde), hasta: fecha(q.hasta),
    page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 50,
  };
}

// GET /reporte-costos — listado con valores sellados o estimados, y totales del universo filtrado.
router.get('/reporte-costos', LECTURA, async (req: Request, res: Response) => {
  res.json(await reporteCostos(filtrosDe(req.query)));
});

// GET /reporte-costos/facetas — valores para los filtros (estados, empresas, tipos).
router.get('/reporte-costos/facetas', LECTURA, async (_req: Request, res: Response) => {
  res.json(await facetas());
});

// GET /reporte-costos/export — CSV de TODO el filtro, no solo de la página visible.
router.get('/reporte-costos/export', LECTURA, async (req: Request, res: Response) => {
  const filas = await filasParaExportar(filtrosDe(req.query));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reporte-costos.csv"');
  // Si se alcanzó el tope, el cliente debe saberlo: un CSV truncado en silencio se concilia mal.
  if (filas.length === TOPE_EXPORTACION) res.setHeader('X-Export-Truncado', String(TOPE_EXPORTACION));
  res.send(aCsv(filas));
});

/**
 * GET /tramites/:id/soportes — SOAT, impuesto y derecho de tránsito en una sola respuesta.
 *
 * Hasta ahora cada flujo servía los suyos por su propia ruta, así que ver los documentos de un
 * trámite obligaba a tres llamadas y a saber de antemano cuáles existían.
 */
router.get('/tramites/:id/soportes', LECTURA, async (req: Request, res: Response) => {
  const tramiteId = req.params.id;
  const [t] = await db.select({
    soatId: flitoTramites.soatId, impuestoId: flitoImpuestos.id, derechoId: flitoDerechosTramite.id,
  }).from(flitoTramites)
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(eq(flitoTramites.id, tramiteId)).limit(1);

  if (!t) { res.status(404).json({ error: 'El trámite no existe' }); return; }

  const grupos: Array<{ origen: string; cond: ReturnType<typeof eq> | undefined }> = [
    { origen: 'soat', cond: t.soatId ? eq(flitoSoportes.soatId, t.soatId) : undefined },
    { origen: 'impuesto', cond: t.impuestoId ? eq(flitoSoportes.impuestoId, t.impuestoId) : undefined },
    { origen: 'derecho', cond: t.derechoId ? eq(flitoSoportes.derechoId, t.derechoId) : undefined },
  ];

  const salida: Array<{ id: string; origen: string; tipo: string; nombreArchivo: string; url: string; subidoEn: string }> = [];
  for (const g of grupos) {
    if (!g.cond) continue;
    const filas = await db.select({
      id: flitoSoportes.id, tipo: flitoSoportes.tipo, nombreArchivo: flitoSoportes.nombreArchivo,
      storageKey: flitoSoportes.storageKey, subidoEn: flitoSoportes.subidoEn,
    }).from(flitoSoportes)
      // Los descartados en la cola de revisión no son evidencia de nada: quedan fuera.
      .where(and(g.cond, eq(flitoSoportes.descartado, false)));
    for (const f of filas) {
      salida.push({
        id: f.id, origen: g.origen, tipo: f.tipo, nombreArchivo: f.nombreArchivo,
        url: firmarDescargaEntidad(f.storageKey), subidoEn: f.subidoEn.toISOString(),
      });
    }
  }
  res.json(salida);
});

export default router;
