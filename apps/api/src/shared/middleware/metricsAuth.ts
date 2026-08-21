import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env.js';

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
function tokenValido(recibido: string, esperado: string): boolean {
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  // timingSafeEqual exige longitudes iguales — comparar antes evita que lance.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function metricsAuth(req: Request, res: Response, next: NextFunction) {
  const esperado = env.METRICS_TOKEN;

  // Sin token configurado la ruta no existe: 404 no delata que el endpoint está ahí
  // esperando credenciales, y no da pie a buscarle el token.
  if (!esperado) {
    res.status(404).json({ error: 'Not Found' });
    return;
  }

  const recibido = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
  if (!recibido || !tokenValido(recibido, esperado)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
    res.status(401).json({ error: 'No autorizado' });
    return;
  }

  next();
}
