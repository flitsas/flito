// Finanzas (HTTP). Montado en /api/finanzas. Lectura para el rol `financiera` (+ admin/auditor).

import { Router, type Request, type Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { facetas, reporteCostos, type FiltrosReporte } from './finanzas.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('financiera', 'admin');

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};

// GET /reporte-costos — listado de trámites con costos (SOAT/impuesto reales + conceptos fijos).
router.get('/reporte-costos', LECTURA, async (req: Request, res: Response) => {
  const q = req.query;
  const filtros: FiltrosReporte = {
    buscar: str(q.buscar), estados: lista(q.estados), empresas: lista(q.empresas),
    page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 50,
  };
  res.json(await reporteCostos(filtros));
});

// GET /reporte-costos/facetas — valores para los filtros (estados, empresas).
router.get('/reporte-costos/facetas', LECTURA, async (_req: Request, res: Response) => {
  res.json(await facetas());
});

export default router;
