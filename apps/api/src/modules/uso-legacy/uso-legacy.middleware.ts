// HU #13989 (ADR-0033 §1) — una capa de conteo por prefijo legacy, montada antes de las rutas. Una
// petición ajena no ejecuta este código, y un router nuevo bajo el prefijo queda contado.
//
// Se escucha `close` y no `finish`: el SSE de `/api/validacion-identidad/sse` nunca termina por sí solo,
// y con `finish` quedaría como ruta sin uso. El prefijo sale de esta tabla y no de `req.baseUrl`, que se
// vacía cuando un handler llama `next(err)` y conserva la grafía del cliente (`/API/SOAT`).
//
// `req.originalUrl`, `req.url` y `req.params` no se leen nunca: la clave solo lleva el PATRÓN de la ruta.
import type { Express, RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { acumular, type ModuloUsoLegacy } from './uso-legacy.service.js';

export const PREFIJOS_USO_LEGACY: readonly { prefijo: string; modulo: ModuloUsoLegacy }[] = [
  { prefijo: '/api/soat', modulo: 'soat' },
  { prefijo: '/api/tramites', modulo: 'tramites' },
  { prefijo: '/api/validacion-identidad', modulo: 'tramites' },
  { prefijo: '/api/transito', modulo: 'tramites' },
  { prefijo: '/api/public/tramite-verificar', modulo: 'tramites' },
  { prefijo: '/api/tramite-portal', modulo: 'tramites' },
  { prefijo: '/api/liquidaciones', modulo: 'liquidacion' },
];

function capaDeConteo(prefijo: string, modulo: ModuloUsoLegacy): RequestHandler {
  return function contarUsoLegacy(req, res, next) {
    res.once('close', () => {
      try {
        acumular({ prefijo, modulo, patron: req.route?.path, metodo: req.method, consumidor: req.user?.role });
      } catch { /* un fallo de conteo jamás alcanza a la petición */ }
    });
    next();
  };
}

/** Va justo antes de las rutas y después de `apiLimiter`: un 429 o un JSON inválido no cuentan como uso. */
export function montarConteoUsoLegacy(app: Express): void {
  if (!env.USO_LEGACY_CONTEO_ENABLED) return;
  for (const { prefijo, modulo } of PREFIJOS_USO_LEGACY) app.use(prefijo, capaDeConteo(prefijo, modulo));
}
