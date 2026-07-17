import { Router, Request, Response } from 'express';
import { sql, eq, and, ilike } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  rndcMunicipios, rndcProductosTransportar, rndcEmpaques,
  rndcUnidadesMedida, rndcModosPago,
} from '../../db/schema.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { requirePage } from '../../shared/permissions.js';

const router = Router();
router.use(authMiddleware, requirePage('rndc'));

// GET /api/rndc/catalogos/municipios?q=&depto=
router.get('/municipios', async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim();
  const depto = (req.query.depto as string | undefined)?.trim();
  const conds: any[] = [eq(rndcMunicipios.vigente, true)];
  if (depto) conds.push(eq(rndcMunicipios.departamentoCodigo, depto));
  if (q && q.length >= 2) conds.push(ilike(rndcMunicipios.nombre, `%${q}%`));

  const rows = await db.select({
    codigoDane: rndcMunicipios.codigoDane,
    nombre: rndcMunicipios.nombre,
    departamentoCodigo: rndcMunicipios.departamentoCodigo,
    departamentoNombre: rndcMunicipios.departamentoNombre,
  })
    .from(rndcMunicipios)
    .where(and(...conds))
    .orderBy(rndcMunicipios.nombre)
    .limit(200);
  res.json({ data: rows });
});

// GET /api/rndc/catalogos/departamentos
router.get('/departamentos', async (_req, res: Response) => {
  const rows = await db.execute(sql`
    SELECT DISTINCT departamento_codigo AS codigo, departamento_nombre AS nombre
      FROM rndc_municipios
     WHERE vigente = true
     ORDER BY departamento_nombre
  `);
  res.json({ data: rows });
});

// GET /api/rndc/catalogos/productos?q=
router.get('/productos', async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim();
  const conds: any[] = [eq(rndcProductosTransportar.vigente, true)];
  if (q && q.length >= 2) conds.push(ilike(rndcProductosTransportar.nombre, `%${q}%`));
  const rows = await db.select().from(rndcProductosTransportar)
    .where(and(...conds))
    .orderBy(rndcProductosTransportar.nombre)
    .limit(200);
  res.json({ data: rows });
});

// GET /api/rndc/catalogos/empaques
router.get('/empaques', async (_req, res: Response) => {
  const rows = await db.select().from(rndcEmpaques)
    .where(eq(rndcEmpaques.vigente, true))
    .orderBy(rndcEmpaques.nombre);
  res.json({ data: rows });
});

// GET /api/rndc/catalogos/unidades
router.get('/unidades', async (_req, res: Response) => {
  const rows = await db.select().from(rndcUnidadesMedida)
    .where(eq(rndcUnidadesMedida.vigente, true))
    .orderBy(rndcUnidadesMedida.nombre);
  res.json({ data: rows });
});

// GET /api/rndc/catalogos/modos-pago
router.get('/modos-pago', async (_req, res: Response) => {
  const rows = await db.select().from(rndcModosPago)
    .where(eq(rndcModosPago.vigente, true))
    .orderBy(rndcModosPago.nombre);
  res.json({ data: rows });
});

export default router;
