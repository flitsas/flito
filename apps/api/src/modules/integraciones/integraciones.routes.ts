// TRAM-TRASPASO-F3 — rutas de integraciones externas (SIMIT, Fasecolda, ML)
// proxiadas a CEA. Auth de operador; CEA valida x-internal-key internamente.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { consultarSimit, buscarFasecolda, precioMercadoLibre } from './integraciones.service.js';

// Montado en `/api` (junto a otros routers): el auth se aplica POR RUTA, no con
// router.use, para no interceptar rutas públicas de otros módulos (p.ej. rndc/qr).
const router = Router();

const simitSchema = z.object({ filtro: z.string().min(3).max(20) });

router.post('/simit/consulta', authMiddleware, async (req: Request, res: Response) => {
  const parsed = simitSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, message: 'Documento o placa requerido' }); return; }
  const filtro = parsed.data.filtro.trim();
  const result = await Promise.race([
    consultarSimit(filtro, { skipCeaFallback: true }),
    new Promise<Awaited<ReturnType<typeof consultarSimit>>>((resolve) => {
      setTimeout(() => resolve({
        ok: false, total: 0, totalMonto: 0, comparendos: [], message: 'La consulta SIMIT superó el tiempo de espera. Use los comparendos de RUNT si ya consultó la persona.',
      }), 25_000);
    }),
  ]);
  await audit(req, { action: 'update', resource: 'simit', detail: `SIMIT ${filtro.slice(0, 4)}*** → ${result.ok ? result.total + ' comparendos' : 'FAIL'}` }).catch(() => {});
  res.json(result);
});

router.get('/fasecolda/buscar', authMiddleware, async (req: Request, res: Response) => {
  const marca = String(req.query.marca || '').trim();
  const anio = String(req.query.anio || '').trim();
  if (!marca || !anio) { res.status(400).json({ ok: false, message: 'marca y anio requeridos' }); return; }
  const result = await buscarFasecolda({
    marca, anio,
    linea: String(req.query.linea || '').trim() || undefined,
    cilindraje: String(req.query.cilindraje || '').trim() || undefined,
    combustible: String(req.query.combustible || '').trim() || undefined,
    puertas: String(req.query.puertas || '').trim() || undefined,
    clase: String(req.query.clase || '').trim() || undefined,
  });
  await audit(req, { action: 'view', resource: 'fasecolda', detail: `Fasecolda ${marca} ${anio} → ${result.ok ? 'OK' : 'FAIL'}` }).catch(() => {});
  res.json(result);
});

router.get('/mercadolibre/precio', authMiddleware, async (req: Request, res: Response) => {
  const marca = String(req.query.marca || '').trim();
  if (!marca) { res.status(400).json({ ok: false, message: 'marca requerida' }); return; }
  const result = await precioMercadoLibre(
    marca,
    String(req.query.linea || '').trim() || undefined,
    String(req.query.anio || '').trim() || undefined,
  );
  await audit(req, { action: 'view', resource: 'mercadolibre', detail: `ML ${marca} → ${result.ok ? 'OK' : 'FAIL'}` }).catch(() => {});
  res.json(result);
});

export default router;
