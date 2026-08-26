// Siigo API — estado de la compuerta de emisión (HU #11285). Montado en /api/siigo/compuerta.
//
// AC5 — un solo endpoint de consulta: ¿se puede emitir contra el ambiente real, y si no, por qué?
// Lo consume la pantalla de parametrización.
//
// Es de LECTURA para `admin`, `auditor` y `financiera`. No escribe nada y no expone secretos: lo que
// devuelve son nombres de concepto, etiquetas de campo y motivos. Que contabilidad y auditoría vean
// por qué está cerrada la compuerta es justamente el punto — son quienes tienen que destrabarla.
//
// El enganche de la compuerta en el flujo de emisión NO está aquí: ese código no existe todavía y lo
// hará la Feature de emisión llamando a `exigirCompuertaAbierta`.
//
// OJO CON EL NOMBRE: existe otra «compuerta» en el repo, `modules/flito-compuerta` montada en
// `/api/flito/compuerta`, que es la entrega de trámites portada del sistema legado. No tienen
// ninguna relación: distinto dominio, distinta ruta y distinto servicio. No unificar.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { env } from '../../config/env.js';
import type { SiigoAmbiente } from './credenciales.service.js';
import { estadoCompuerta } from './siigo.compuerta.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');

const ambienteSchema = z.enum(['pruebas', 'produccion']);
const consultaSchema = z.object({ ambiente: ambienteSchema.optional() });

/**
 * Ambiente de la petición. Un valor mal escrito se rechaza, no se ignora: caer al ambiente por
 * defecto respondería sobre otra parametrización y diría «se puede emitir» del ambiente equivocado.
 */
function ambienteDe(req: Request): SiigoAmbiente | null {
  const parsed = consultaSchema.safeParse(req.query);
  if (!parsed.success) return null;
  return parsed.data.ambiente ?? env.SIIGO_AMBIENTE;
}

// GET / — estado de la compuerta (AC5). Evalúa sobre los seis conceptos facturables.
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const ambiente = ambienteDe(req);
  if (ambiente === null) {
    res.status(400).json({ error: 'El ambiente debe ser «pruebas» o «produccion».' });
    return;
  }
  // AC7 — se evalúa de nuevo en cada consulta y sobre el ambiente pedido: no hay caché ni estado
  // compartido entre ambientes, así que nunca hereda confirmaciones del otro.
  res.json(await estadoCompuerta(ambiente));
});

export default router;
