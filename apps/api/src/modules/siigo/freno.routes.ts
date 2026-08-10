// Siigo API — freno por proporción de errores (HU #11341). Montado en /api/siigo/freno.
//
// Dos endpoints: consultar el estado (AC6) y levantarlo a mano (AC4).
//
// Permisos, con la guarda ANTES del handler para que el rechazo ocurra sin que el servicio llegue a
// consultar nada:
//   · LECTURA  → `admin`, `auditor` y `financiera`. Mismos roles que la compuerta de emisión: no
//     expone secretos y son quienes tienen que enterarse de que la facturación está detenida.
//   · ESCRITURA (reactivar) → solo `admin`. Reactivar vuelve a poner tráfico contra Siigo con la
//     causa quizá sin corregir, y quien se equivoque acerca el bloqueo del usuario API.
//
// LA VENTANA Y EL UMBRAL NO SE ACEPTAN POR HTTP. Son configuración del despliegue y se leen del
// entorno; admitirlos por query permitiría apagar el freno con `?umbral=1` a cualquiera que pueda
// leer. Lo único que viaja desde el cliente es el ambiente, y se valida.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { env } from '../../config/env.js';
import type { SiigoAmbiente } from './credenciales.service.js';
import { estadoFreno, reactivarIntegracion } from './siigo.freno.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');
const ESCRITURA = requireRole('admin');

const ambienteSchema = z.enum(['pruebas', 'produccion']);
const consultaSchema = z.object({ ambiente: ambienteSchema.optional() });
const reactivarSchema = z.object({
  ambiente: ambienteSchema.optional(),
  // Queda en la bitácora, que es inalterable: se acota la longitud para que una nota enorme no
  // termine escrita para siempre en una fila que nadie puede corregir.
  nota: z.string().trim().max(300).optional(),
});

/**
 * Ambiente de la petición. Un valor mal escrito se rechaza, no se ignora: caer al ambiente por
 * defecto mediría la salud de OTRA empresa de Siigo y respondería sobre el usuario API equivocado.
 */
function ambienteDe(valor: string | undefined): SiigoAmbiente {
  return (valor as SiigoAmbiente | undefined) ?? env.SIIGO_AMBIENTE;
}

// GET / — estado del freno (AC6): si está frenada, la proporción, la ventana, el umbral y desde
// cuándo. Se recalcula en cada consulta: un veredicto cacheado sería una foto vieja de la salud.
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const query = consultaSchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'El ambiente debe ser «pruebas» o «produccion».' });
    return;
  }

  res.json(await estadoFreno({ ambiente: ambienteDe(query.data.ambiente) }));
});

// POST /reactivar — levanta el freno a mano (AC4).
//
// Es idempotente y se acepta aunque no esté frenada: reactivar es «da por revisado lo medido hasta
// ahora», y obligar a que esté frenada convertiría una carrera entre dos administradores en un 409
// que no aporta nada. La auditoría registra quién y cuándo en los dos casos.
router.post('/reactivar', ESCRITURA, async (req: Request, res: Response) => {
  const parsed = reactivarSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  const estado = await reactivarIntegracion({
    usuarioId: (req.user?.sub as number | undefined) ?? null,
    ambiente: ambienteDe(parsed.data.ambiente),
    nota: parsed.data.nota,
  });

  // Doble rastro a propósito: la bitácora de Siigo es lo que consulta el freno para saber desde
  // cuándo medir, y `audit_logs` es lo que consulta el auditor. Ni una sustituye a la otra.
  await audit(req, {
    action: 'update',
    resource: 'siigo_freno',
    resourceId: estado.ambiente,
    detail: `reactivacion ambiente=${estado.ambiente} modo=${estado.modo} `
      + `frenada_despues=${estado.frenada} proporcion=${estado.proporcion.toFixed(3)} `
      + `ventana_horas=${estado.ventanaHoras} umbral=${estado.umbral}`,
  });

  res.json(estado);
});

export default router;
