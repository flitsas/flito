import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env.js';
import { loggerFor } from '../logger.js';

// Bug #11599 — GET /metrics respondía 200 sin autenticación en DEV, QA y PDN.
//
// La protección vivía en una suposición sobre nginx ("solo proxya /api/"), escrita como
// comentario en app.ts y en shared/metrics.ts. En el vhost del subdominio de API esa
// suposición es falsa: la raíz sí se enruta al servicio, así que el registro Prometheus
// —contadores de negocio pesv_*/tram_*, versión de Node, memoria, uptime— quedaba público.
//
// El guard vive aquí, en el código, y no en la configuración del proxy, para que la ruta
// siga cerrada la próxima vez que alguien toque nginx. Es el punto del Bug: la garantía la
// tiene que dar quien sirve la ruta, no quien la enruta.
//
// Falla cerrado a propósito: sin METRICS_TOKEN definido la ruta responde 404 en vez de
// abrirse. Cuando se radicó el Bug no había ningún Prometheus desplegado (no aparece en
// docker-compose*.yml, docs/ ni scripts/), así que cerrarla no deja ciego a ningún scraper;
// para volver a exponerla basta definir la variable y configurar `bearer_token` en el scrape.
//
// Sobre los logs: el token NO llega a la traza porque en `apps/api/src` NADA loguea cabeceras
// —no hay `pino-http` ni `morgan`— y el rechazo de abajo se registra sin tocar `Authorization`.
// NO lo salva la redacción de `shared/logger.ts`: sus rutas (`*.token`, `*.secret`, …) no casan
// con `headers.authorization`. El día que se añada un request logger hay que redactar esa
// cabecera ahí mismo, o el token del scrape aparecerá en claro en los agregadores.
const log = loggerFor('metrics-auth');

function tokenValido(recibido: string, esperado: string): boolean {
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  // timingSafeEqual exige longitudes iguales — comparar antes evita que lance.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// RFC 7235 §2.1: el nombre del esquema es case-insensitive ("bearer" vale tanto como
// "Bearer"). Exigir la mayúscula fallaba cerrado —401, nunca fuga— pero rechazaba clientes
// correctos; la bandera `i` recupera interoperabilidad sin aflojar la comparación del token,
// que sigue siendo byte a byte y en tiempo constante.
const ESQUEMA_BEARER = /^Bearer\s+(.+)$/i;

export function metricsAuth(req: Request, res: Response, next: NextFunction) {
  const esperado = env.METRICS_TOKEN;

  // Sin token configurado la ruta se comporta como inexistente. Ojo: este 404 SÍ es
  // distinguible de uno real —responde `application/json` con `{"error":"Not Found"}`
  // (21 bytes), mientras que una ruta que no existe cae al finalhandler por defecto de
  // Express y devuelve `text/html` con «Cannot GET /x» (164 bytes; medido en DEV)—, así
  // que no oculta la existencia del endpoint. Tampoco hace falta: /metrics es la ruta
  // canónica de Prometheus y cualquiera la asume presente. Lo que protege el registro es
  // el token, no el desconocimiento de dónde vive.
  if (!esperado) {
    res.status(404).json({ error: 'Not Found' });
    return;
  }

  const recibido = ESQUEMA_BEARER.exec(req.get('authorization') ?? '')?.[1];
  if (!recibido || !tokenValido(recibido, esperado)) {
    // ISO 27001 A.8.15 — sin esta línea un barrido contra el token es invisible: el guard
    // rechaza antes de `registry.metrics()`, así que no deja ni coste ni rastro. Se registra
    // QUIÉN y POR QUÉ, NUNCA el token ni la cabecera `Authorization` (ver la nota de arriba).
    log.warn(
      {
        ip: req.ip,
        requestId: req.headers['x-request-id'],
        motivo: recibido ? 'token_invalido' : 'credencial_ausente',
      },
      'GET /metrics rechazado: credencial ausente o inválida',
    );
    res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  next();
}
