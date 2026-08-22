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
import { frenoConRastro, makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
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
  // El 429 deja rastro (HU #11299). Con el limitador delante de la guarda, quien insiste sin
  // permiso deja de escribir en la bitácora a partir del tope — que es lo que se buscaba — pero
  // también dejaba de aparecer en ningún sitio. `frenoConRastro` cuenta el freno y anota la llave.
  handler: frenoConRastro('siigo-envio-correo'),
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

/**
 * AC1, AC3–AC6 — pide el envío (o el reenvío) y devuelve el acta que quedó.
 *
 * **El limitador va ANTES de la guarda**, igual que en `terceros.routes.ts` y por lo mismo (deuda
 * de seguridad del PR #194, cerrada aquí en la segunda tanda de la HU #11299). Con `ESCRITURA`
 * delante, cada intento sin permiso se resolvía en 403 sin que el limitador llegara a contarlo, y
 * `exigirAccionSiigo` escribe una fila `permiso_denegado` en `siigo_operaciones` por cada uno. Esa
 * tabla es append-only por disparador (HU #11251): lo que entra ahí no se borra ni se rectifica,
 * así que un autenticado cualquiera —con rol de consulta, sin `reenviar_correo`— podía meterle las
 * ~500 filas que le permitiera `apiLimiter` cada quince minutos en una bitácora que nadie puede
 * podar. El techo de este router es más bajo que el de terceros —30 por ventana— pero el ataque no
 * pasaba por aquí: pasaba por saltarse el limitador entero.
 *
 * Contándolo primero, el mismo usuario agota sus 30 y a partir de ahí recibe 429 sin tocar la
 * bitácora. El precio es que un denegado gasta cuota de SU llave —`userOrIpKey` la calcula por
 * usuario—, que es lo que se quiere: quien insiste sin permiso se frena a sí mismo y no al que
 * reenvía facturas de verdad.
 *
 * No debilita nada: el 403 lo sigue dando la misma guarda sobre el mismo rol del JWT, y el
 * limitador no mira el cuerpo ni ejecuta el handler.
 */
router.post('/factura/:facturaId', envioLimiter, ESCRITURA, async (req: Request, res: Response) => {
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
