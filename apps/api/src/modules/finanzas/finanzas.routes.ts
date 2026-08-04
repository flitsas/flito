// Finanzas (HTTP). Montado en /api/finanzas. Lectura para el rol `financiera` (+ admin/auditor).

import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { soportesDeTramite } from '../../shared/soportes/soportes-consulta.js';
import {
  aCsv, ETAPAS, facetas, filasParaExportar, reporteCostos, TOPE_EXPORTACION,
  type EtapaReporte, type FiltrosReporte,
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
/** Etapa del ciclo de cobro. Una desconocida se ignora: mejor el universo entero que un error. */
const etapa = (v: unknown): EtapaReporte | undefined =>
  (typeof v === 'string' && (ETAPAS as readonly string[]).includes(v) ? v as EtapaReporte : undefined);
/** Solo yyyy-mm-dd: el valor entra en un cast a `date` y no puede ser texto libre. */
const fecha = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};

function filtrosDe(q: Request['query']): FiltrosReporte {
  return {
    buscar: str(q.buscar), estados: lista(q.estados), empresas: lista(q.empresas), tipos: lista(q.tipos),
    etapa: etapa(q.etapa),
    documentacionCompleta: q.documentacionCompleta === 'si',
    desde: fecha(q.desde), hasta: fecha(q.hasta),
    aprobadoDesde: fecha(q.aprobadoDesde), aprobadoHasta: fecha(q.aprobadoHasta),
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
 * GET /tramites/:id/soportes — TODOS los documentos del trámite, en una sola respuesta.
 *
 * Cada flujo servía los suyos por su propia ruta, así que verlos obligaba a varias llamadas y a
 * saber de antemano cuáles existían. Aquí no se elige: se devuelve lo que haya, de los cuatro
 * orígenes. Lo que no exista simplemente no aparece.
 *
 * El armado vive en shared/soportes: la misma lista se sirve desde Gestión de trámites, y las de
 * un solo concepto desde el detalle de un SOAT o de un impuesto. Lo que cambia entre esas rutas es
 * el rol que entra, no cómo se arma la lista.
 */
router.get('/tramites/:id/soportes', LECTURA, async (req: Request, res: Response) => {
  const soportes = await soportesDeTramite(req.params.id);
  if (!soportes) { res.status(404).json({ error: 'El trámite no existe' }); return; }
  // Sin caché: un soporte cargado hace un minuto tiene que salir sin recargar la pantalla.
  res.set('Cache-Control', 'no-store');
  res.json(soportes);
});

export default router;
