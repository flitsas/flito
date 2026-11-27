// Épica #14548 (ADR-0051) — `/api/ia-consumo`: visor de solo lectura de los registros de consumo de IA (bloque A).
// Montado en `app.ts` SIN `conAlcance` (cerrado a todo enlace). Cadena por ruta: `exigirFuncion` → limitador → handler
// (`exigirFuncion` va primero: es la guarda que lee `inventario-guardas`).
//   · GET  /catalogos            · `ia_consumo.registros.ver`
//   · POST /registros/buscar     · `ia_consumo.registros.ver` (filtros en el cuerpo, AGENTS §14)
//   · GET  /registros/:id        · `ia_consumo.registros.ver` (auditoría de lectura, vía abierta)
// Cache-Control `no-store` en todas las respuestas, también las 401 y las 429. Ninguna ruta admite query string.
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { frenoConRastro, makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { IaConsumoError, MENSAJES_IA } from './ia-consumo.errors.js';
import { buscarIaSchema, idRegistroSchema, sinQuery } from './ia-consumo.esquemas.js';
import { auditarBusqueda, auditarDetalle, clavesPiiDe } from './ia-consumo.pii.js';
import { buscarRegistros, catalogosVisor, detalleRegistro } from './ia-consumo.service.js';

/** Consultas del visor (catálogos, búsqueda y detalle): 60 por minuto y usuario, como el listado de comparendos. */
const iaConsultasLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('ia-consumo-consultas'),
  message: { error: 'Demasiadas consultas seguidas. Espera un minuto.' },
  store: makeStore('rl:ia-consumo-consultas:'),
  handler: frenoConRastro('ia-consumo-consultas'),
});

const router = Router();

/** `no-store` va antes de la autenticación: las 401 y las 429 también salen sin caché (A-19). */
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use(authMiddleware);

/** 400 `datos_invalidos`. Nunca devuelve el valor recibido: el mensaje es genérico. */
function datosInvalidos(res: Response): void {
  res.status(400).json({ error: MENSAJES_IA.datos_invalidos, codigo: 'datos_invalidos' });
}

/** Traduce un `IaConsumoError` a su estado y su código. Cualquier otro error va al manejador general (500). */
function responderError(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof IaConsumoError) {
    res.status(e.status).json({ error: e.message, codigo: e.codigo });
    return;
  }
  next(e);
}

/** Devuelve `false` (y responde 400) si la URL trae query string: un dato personal en la URL acaba en los logs de acceso. */
function sinParametrosEnUrl(req: Request, res: Response): boolean {
  if (sinQuery.safeParse(req.query).success) return true;
  datosInvalidos(res);
  return false;
}

router.get('/catalogos', exigirFuncion('ia_consumo.registros.ver'), iaConsultasLimiter, (req: Request, res: Response, next: NextFunction) => {
  if (!sinParametrosEnUrl(req, res)) return;
  try {
    res.json(catalogosVisor());
  } catch (e) {
    responderError(e, res, next);
  }
});

router.post('/registros/buscar', exigirFuncion('ia_consumo.registros.ver'), iaConsultasLimiter, async (req: Request, res: Response, next: NextFunction) => {
  if (!sinParametrosEnUrl(req, res)) return;
  const cuerpo = buscarIaSchema.safeParse(req.body);
  if (!cuerpo.success) {
    datosInvalidos(res);
    return;
  }
  try {
    const resultado = await buscarRegistros(cuerpo.data);
    // La auditoría va antes de responder: con o sin filas, una búsqueda que proyecta datos personales queda registrada.
    await auditarBusqueda(req, resultado.items.length, clavesPiiDe(cuerpo.data.filtros));
    res.json(resultado);
  } catch (e) {
    responderError(e, res, next);
  }
});

router.get('/registros/:id', exigirFuncion('ia_consumo.registros.ver'), iaConsultasLimiter, async (req: Request, res: Response, next: NextFunction) => {
  if (!sinParametrosEnUrl(req, res)) return;
  const id = idRegistroSchema.safeParse(req.params.id);
  if (!id.success) {
    datosInvalidos(res);
    return;
  }
  try {
    const registro = await detalleRegistro(id.data);
    // Solo se audita lo que se devuelve: un 404 no proyecta datos del titular.
    await auditarDetalle(req, id.data, registro.metadatos !== null);
    res.json(registro);
  } catch (e) {
    responderError(e, res, next);
  }
});

export default router;
