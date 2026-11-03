// HU #13989 (ADR-0033 §4) — consulta del uso de rutas legacy, sin procesar logs a mano. Los filtros son
// fechas y un enumerado (no PII), así que el GET con query es válido y no aplica `logPiiAccess`.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { hoyColombia, parseFechaQuery } from '../../shared/utils/fecha-rango.js';
import { consultarUso, MODULOS_USO_LEGACY } from './uso-legacy.service.js';

const router = Router();
router.use(authMiddleware);

const RANGO_MAXIMO_DIAS = 92;
const RANGO_POR_DEFECTO_DIAS = 28;
const MS_POR_DIA = 86_400_000;

const msDe = (dia: string) => Date.parse(`${dia}T00:00:00Z`);
const restarDias = (dia: string, n: number) => new Date(msDe(dia) - n * MS_POR_DIA).toISOString().slice(0, 10);

const fecha = z.string().refine((v) => parseFechaQuery(v) !== null, 'Fecha inválida: se espera YYYY-MM-DD');

const consultaSchema = z.object({
  desde: fecha.optional(),
  hasta: fecha.optional(),
  modulo: z.enum(MODULOS_USO_LEGACY).optional(),
}).transform(({ desde, hasta, modulo }) => {
  const fin = hasta ?? hoyColombia();
  return { desde: desde ?? restarDias(fin, RANGO_POR_DEFECTO_DIAS - 1), hasta: fin, modulo };
}).superRefine(({ desde, hasta }, ctx) => {
  if (desde > hasta) {
    ctx.addIssue({ code: 'custom', message: '`desde` no puede ser posterior a `hasta`' });
  } else if ((msDe(hasta) - msDe(desde)) / MS_POR_DIA + 1 > RANGO_MAXIMO_DIAS) {
    ctx.addIssue({ code: 'custom', message: `El rango no puede pasar de ${RANGO_MAXIMO_DIAS} días` });
  }
});

router.get('/', exigirFuncion('permisos.catalogo.ver'), async (req: Request, res: Response) => {
  const parsed = consultaSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]!.message }); return; }
  const { desde, hasta, modulo } = parsed.data;
  const { filas, truncado } = await consultarUso({ desde, hasta, modulo });
  res.json({ desde, hasta, filas, truncado });
});

export default router;
