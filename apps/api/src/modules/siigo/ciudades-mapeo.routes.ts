// Siigo API — equivalencia de la ciudad en texto libre (HU #11294).
// Montado en /api/siigo/clientes-ciudades.
//
// Permisos (AC7): lectura para quien lee clientes; **confirmar es escritura sobre el cliente**, así
// que va con el mismo rol que edita clientes (`admin`) y no con el de solo lectura. Confirmar fija
// el municipio que va a salir impreso en una factura ante la DIAN: no es un gesto de consulta.
//
// Ninguna ruta llama a Siigo: todo sale del catálogo local.
//
// ── Registro de acceso a datos personales (HU #11299) ────────────────────────────────────────────
//
// `/propuestas` y `/obsoletas` devuelven el NOMBRE de cada cliente pendiente, y las dos listas van
// completas: sin paginar y sin tope. Son, en volumen, la lectura de identidades más grande del
// módulo, y la pantalla de Terceros las pide al abrirse. Desde esta HU dejan rastro en
// `pii_access_log` (Ley 1581 art. 17, AGENTS.md §16) con `registrarAccesoCliente`, el mismo contrato
// que usa el informe de facturabilidad — que es lo que permite responder «¿quién ha leído nombres de
// clientes?» con UNA consulta en vez de tres.
//
// `/estado` no registra: devuelve seis conteos y ni un identificador.
//
// `/:id/propuesta` tampoco, y la razón NO es la que decía la primera versión de este comentario.
// Decía que «entrega el nombre de un cliente», y es falso: `propuestaDeCliente` proyecta solo
// `clients.city`. Lo que sí devuelve es esa ciudad, dentro de `textoOrigen` — o sea que tampoco es
// una ruta sin datos personales, solo que los que entrega son otros. Queda fuera porque esta
// pantalla no la llama (es de la ficha fiscal, HU #11298) y su rastro va con la HU de seguimiento,
// no porque no le haga falta. Un inventario que describe mal la deuda hace que la HU que la recoja
// se dimensione sobre un dato que no existe.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  CAMPOS_PII_EQUIVALENCIA_OBSOLETA, CAMPOS_PII_PROPUESTA_CIUDAD, registrarAccesoCliente,
} from './siigo.pii.js';
import {
  SiigoCiudadMapeoError, confirmarCiudad, equivalenciasObsoletas,
  estadoMapeoCiudades, proponerEquivalencias, propuestaDeCliente,
} from './siigo.ciudades-mapeo.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');
const ESCRITURA = requireRole('admin');

const paisSchema = z.object({ pais: z.string().regex(/^[A-Za-z]{2}$/).optional() });

const confirmarSchema = z.object({
  countryCode: z.string().regex(/^[A-Za-z]{2}$/),
  stateCode: z.string().regex(/^[0-9]{1,5}$/),
  cityCode: z.string().regex(/^[0-9]{1,10}$/),
});

/** Traduce los fallos del servicio a un status. El mensaje es nuestro: no lleva nada de Siigo. */
function responderError(res: Response, e: unknown): boolean {
  if (!(e instanceof SiigoCiudadMapeoError)) return false;
  const status = e.codigo === 'cliente_no_encontrado' ? 404 : e.codigo === 'catalogo_vacio' ? 409 : 400;
  res.status(status).json({ error: e.message, codigo: e.codigo });
  return true;
}

// GET /estado — cuánto falta y de qué tipo (AC6).
router.get('/estado', LECTURA, async (req: Request, res: Response) => {
  const parsed = paisSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'País inválido' }); return; }
  try {
    res.json(await estadoMapeoCiudades(parsed.data.pais));
  } catch (e) {
    if (!responderError(res, e)) throw e;
  }
});

// GET /propuestas — la equivalencia propuesta de cada cliente pendiente (AC1, AC2, AC3).
router.get('/propuestas', LECTURA, async (req: Request, res: Response) => {
  const parsed = paisSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'País inválido' }); return; }
  try {
    const data = await proponerEquivalencias(parsed.data.pais);
    // `filas` es lo único que distingue aquí una consulta de un volcado, porque la ruta no acepta
    // `limit`: quien la llama se lleva SIEMPRE todos los clientes pendientes que haya.
    await registrarAccesoCliente(req, {
      accion: 'search',
      // Nombre Y ciudad: la respuesta trae `ciudadTexto`, que es `clients.city` del titular.
      campos: CAMPOS_PII_PROPUESTA_CIUDAD,
      filas: data.length,
      filtros: { pais: parsed.data.pais },
    });
    res.json({ total: data.length, data });
  } catch (e) {
    if (!responderError(res, e)) throw e;
  }
});

// GET /obsoletas — equivalencias cuyo texto de origen cambió después de confirmarse.
router.get('/obsoletas', LECTURA, async (req: Request, res: Response) => {
  const data = await equivalenciasObsoletas();
  await registrarAccesoCliente(req, {
    accion: 'search',
    // Una ubicación más que `/propuestas`: esta lista compara la ciudad de hoy con la confirmada.
    campos: CAMPOS_PII_EQUIVALENCIA_OBSOLETA,
    filas: data.length,
  });
  res.json({ total: data.length, data });
});

// GET /:id/propuesta — la equivalencia de UN cliente, para su ficha fiscal (HU #11298).
router.get('/:id/propuesta', LECTURA, async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = paisSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'País inválido' }); return; }
  try {
    res.json(await propuestaDeCliente(id, parsed.data.pais));
  } catch (e) {
    if (!responderError(res, e)) throw e;
  }
});

// POST /:id/confirmar — fija los códigos de un cliente (AC4).
router.post('/:id/confirmar', ESCRITURA, async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  const parsed = confirmarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  try {
    const r = await confirmarCiudad({ ...parsed.data, clienteId: id, usuarioId: req.user?.sub as number });
    await audit(req, {
      action: 'update',
      resource: 'client',
      resourceId: String(id),
      // Sin PII: el municipio y su código no identifican a nadie.
      detail: `Ciudad confirmada: ${r.cityName} (${parsed.data.countryCode}/${parsed.data.stateCode}/${r.cityCode})`,
    });
    res.json(r);
  } catch (e) {
    if (!responderError(res, e)) throw e;
  }
});

export default router;
