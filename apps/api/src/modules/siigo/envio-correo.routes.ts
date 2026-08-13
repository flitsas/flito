// Siigo — envío y reenvío de la factura por correo (HU #11334). Montado en /api/siigo/envios.
//
// Las guardas salen del catálogo de acciones de la HU #11342 y no de un `requireRole` propio:
// `reenviar_correo` ya está en `ACCIONES_SIIGO` con su fila de roles, así que quién puede reenviar
// se cambia editando esa fila y el intento denegado queda en la bitácora como el de cualquier otra
// acción. Van como middleware ANTES del handler, nunca dentro: así una ruta nueva que se olvide de
// la guarda se nota leyendo el `router.<verbo>`.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { SIIGO_ENVIO_MAX_DESTINATARIOS, type SiigoDestinatario } from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { audit } from '../../shared/middleware/audit.js';
import { exigirAccionSiigo } from './siigo.permisos.js';
import { enviarFacturaPorCorreo, resumenEnvios, SiigoEnvioError } from './siigo.envio-correo.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = exigirAccionSiigo('consultar');
const ESCRITURA = exigirAccionSiigo('reenviar_correo');

/**
 * Limitador propio, como en las demás rutas del módulo que salen a la red.
 *
 * Cada POST gasta una petición de la ventana de 100 por minuto que la EMPRESA comparte con la
 * emisión, y `esperarTurno` no rechaza cuando la ventana está llena: **duerme**. Sin este freno,
 * el `apiLimiter` global (500 por IP) permitiría encolar cientos de envíos que retienen conexiones
 * hasta 30 s cada uno, dejar sin cuota a la emisión y, de paso, mandarle al cliente la misma
 * factura quinientas veces. Treinta por cuarto de hora y por USUARIO cubre de sobra el reenvío
 * manual, que es una acción que una persona hace mirando la pantalla.
 */
const envioLimiter = rateLimit({
  windowMs: 900_000,
  max: 30,
  keyGenerator: userOrIpKey('siigo-envio-correo'),
  message: { error: 'Demasiados envíos de factura seguidos. Espera unos minutos antes de reintentar.' },
  store: makeStore('rl:siigo-envio-correo:'),
});

const idSchema = z.string().uuid();

/**
 * Destinatarios explícitos, opcionales.
 *
 * Cuando no vienen, los calcula la función resolutora a partir de la ficha del cliente, que es el
 * camino normal y el que exige el AC2. El campo existe para el caso en que alguien de cartera sabe
 * que la factura debe ir además a otra dirección concreta de ese cliente, y se marca con origen
 * `manual` para que el acta distinga después lo que salió de la ficha de lo que escribió una
 * persona. El tope se valida aquí Y en el servicio: esta ruta no es el único camino al envío.
 */
const cuerpoSchema = z.object({
  destinatarios: z.array(z.string().trim().email().max(150))
    .min(1)
    .max(SIIGO_ENVIO_MAX_DESTINATARIOS)
    .optional(),
});

/**
 * Traduce el fallo del servicio a HTTP. El servicio no sabe de códigos de estado, y así queda.
 *
 * `ambiente_no_productivo` (A6) cae en el 409 general y es lo correcto: no es que falten permisos
 * —un 403 diría eso y mandaría a alguien a revisar roles—, es que la petición choca con el estado
 * del sistema. El `codigo` del cuerpo es lo que la interfaz mira para explicar cuál de los dos.
 */
function estadoDe(codigo: SiigoEnvioError['codigo']): number {
  return codigo === 'no_existe' ? 404 : 409;
}

/** AC4 — el historial de envíos de una factura, con cuántas veces y cuándo la última. */
router.get('/factura/:facturaId', LECTURA, async (req: Request, res: Response) => {
  const id = idSchema.safeParse(req.params.facturaId);
  if (!id.success) {
    res.status(400).json({ error: 'Identificador de factura inválido' });
    return;
  }
  res.json(await resumenEnvios(id.data));
});

/** AC1, AC3–AC6 — pide el envío (o el reenvío) y devuelve el acta que quedó. */
router.post('/factura/:facturaId', ESCRITURA, envioLimiter, async (req: Request, res: Response) => {
    const id = idSchema.safeParse(req.params.facturaId);
    if (!id.success) {
      res.status(400).json({ error: 'Identificador de factura inválido' });
      return;
    }
    const cuerpo = cuerpoSchema.safeParse(req.body ?? {});
    if (!cuerpo.success) {
      res.status(400).json({
        error: `Destinatarios inválidos. Siigo admite como máximo ${SIIGO_ENVIO_MAX_DESTINATARIOS} direcciones.`,
      });
      return;
    }

    const explicitos: SiigoDestinatario[] | undefined = cuerpo.data.destinatarios
      ?.map((correo) => ({ correo, origen: 'manual' as const }));

    try {
      const acta = await enviarFacturaPorCorreo(id.data, {
        solicitadoPor: (req.user?.sub as number | undefined) ?? null,
        destinatarios: explicitos,
      });
      // La auditoría anota CUÁNTAS direcciones, no cuáles: el acta es el registro autorizado para
      // guardar las direcciones —y el único que se puede purgar por un derecho de supresión—, así
      // que duplicarlas en el log de auditoría abriría una copia que nadie limpiaría después.
      await audit(req, {
        action: 'create', resource: 'siigo_factura_envios', resourceId: acta.id,
        detail: `Envío por correo de la factura ${id.data} · ${acta.resultado} · ${acta.destinatarios.length} destinatario(s)`,
      });
      // 200 aunque el acta diga `fallido` o `no_realizado`: la operación de REGISTRAR sí ocurrió, y
      // el cuerpo dice exactamente qué pasó. Un 5xx aquí haría creer que no quedó rastro, que es lo
      // contrario de lo que esta historia garantiza.
      res.json(acta);
    } catch (e) {
      if (e instanceof SiigoEnvioError) {
        res.status(estadoDe(e.codigo)).json({ error: e.message, codigo: e.codigo });
        return;
      }
      throw e;
    }
  });

export default router;
