// HU #11299 — un 429 tiene que dejar rastro: `frenoConRastro`.
//
// El punto ciego que abrió la propia corrección de seguridad de esta HU. Poner los limitadores
// DELANTE de las guardas de permiso era lo correcto —una denegación escribe en `siigo_operaciones`,
// que es append-only, así que también hay que poder frenarla—, pero a partir del tope el mismo
// actor recibe 429 y ya NO deja la fila `permiso_denegado`. Y el 429 no era observable por ningún
// lado: `metrics.ts` no exponía estados HTTP y el handler por defecto de `express-rate-limit` no
// escribe nada. Quien insistía se volvía invisible exactamente cuando empezaba a ser interesante.
//
// Lo que se demuestra:
//
//   1. **El freno se cuenta** (`rate_limit_bloqueado_total{limitador}`), que es lo que se grafica y
//      lo que dispara una alerta.
//   2. **Y se escribe QUIÉN**, con la llave del limitador: para un autenticado es `<prefijo>-<sub>`,
//      y ese `sub` es el identificador interno que permite cruzarlo con `audit_logs`.
//   3. **Sin datos personales.** Ni el correo del usuario ni la query, que es donde viajan el
//      documento y la placa. `logger` no redacta lo que no reconoce, así que esto no se puede dejar
//      al azar del pino.
//   4. **La respuesta no cambia**: mismo estado y mismo cuerpo que el handler por defecto. Añadir
//      rastro no puede alterar lo que recibe quien llama.
//   5. **Lo que pasa no deja nada**: un log que anotara también las peticiones normales sería ruido
//      y volvería inservible la consulta «¿quién está siendo frenado?».

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';

const warnMock = vi.fn();
vi.mock('../../src/shared/logger.js', () => {
  const falso = {
    warn: (...args: unknown[]) => warnMock(...args),
    info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
    child: () => falso,
  };
  return { logger: falso, loggerFor: () => falso };
});

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { frenoConRastro, userOrIpKey } = await import('../../src/shared/middleware/rateLimiter.js');
const { rateLimitBloqueadoTotal } = await import('../../src/shared/metrics.js');

const MAX = 2;
const CUERPO = { error: 'Demasiadas solicitudes de prueba' };

/**
 * Un limitador de juguete con el mismo cableado que los tres del módulo `siigo/`: llave por usuario
 * y `handler` con rastro. Cada llamada estrena limitador para que el almacén en memoria no se
 * comparta entre pruebas.
 */
function appConLimitador(nombre: string) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      sub: 4242, role: 'auditor', username: 'ana.perez@flit.io',
    };
    next();
  });
  app.use(rateLimit({
    windowMs: 60_000,
    max: MAX,
    keyGenerator: userOrIpKey(nombre),
    message: CUERPO,
    handler: frenoConRastro(nombre),
  }));
  app.get('/api/clientes/41', (_req: Request, res: Response) => { res.json({ ok: true }); });
  return app;
}

/** Cuánto lleva contado el freno de un limitador. La métrica es acumulativa y global. */
async function frenosContados(nombre: string): Promise<number> {
  const metrica = await rateLimitBloqueadoTotal.get();
  return metrica.values.find((v) => v.labels.limitador === nombre)?.value ?? 0;
}

/** Lo que el logger recibió en su último `warn`: el objeto de campos y el mensaje. */
const ultimoWarn = () => ({
  campos: warnMock.mock.calls.at(-1)?.[0] as Record<string, unknown>,
  mensaje: String(warnMock.mock.calls.at(-1)?.[1] ?? ''),
});

beforeEach(() => {
  warnMock.mockClear();
});

describe('el 429 deja rastro', () => {
  it('cuenta un punto por freno, etiquetado con el limitador', async () => {
    const app = appConLimitador('prueba-conteo');
    const antes = await frenosContados('prueba-conteo');

    for (let i = 0; i < MAX + 2; i += 1) await request(app).get('/api/clientes/41');

    // Dos pasaron y dos se frenaron: el contador cuenta frenos, no peticiones.
    expect(await frenosContados('prueba-conteo')).toBe(antes + 2);
  });

  it('escribe la llave del limitador, que lleva el `sub` del que insiste', async () => {
    // Es lo único que responde «¿quién?» ahora que el 429 ya no deja fila en la bitácora. El `sub`
    // es la llave foránea a `users`, así que se puede cruzar con `audit_logs` sin sacar el correo
    // de nadie a un log.
    const app = appConLimitador('prueba-llave');

    for (let i = 0; i < MAX + 1; i += 1) await request(app).get('/api/clientes/41');

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(ultimoWarn().campos).toMatchObject({
      limitador: 'prueba-llave',
      llave: 'prueba-llave-4242',
      metodo: 'GET',
      ruta: '/api/clientes/41',
      limite: MAX,
      intentos: MAX + 1,
    });
  });

  it('la ruta va SIN query string: ahí es donde viajan el documento y la placa', async () => {
    // `logger` redacta por nombre de campo y no reconocería `?documento=`. Un log de frenos que
    // copiara la consulta sería una copia sin control de lo que el resto de esta HU acota.
    const app = appConLimitador('prueba-query');

    for (let i = 0; i < MAX + 1; i += 1) {
      await request(app).get('/api/clientes/41?documento=79345612&placa=WGY123');
    }

    const { campos } = ultimoWarn();
    expect(campos.ruta).toBe('/api/clientes/41');
    expect(JSON.stringify(campos)).not.toContain('79345612');
    expect(JSON.stringify(campos)).not.toContain('WGY123');
  });

  it('tampoco escribe el correo ni el rol del usuario, solo su llave', async () => {
    const app = appConLimitador('prueba-pii');

    for (let i = 0; i < MAX + 1; i += 1) await request(app).get('/api/clientes/41');

    expect(JSON.stringify(ultimoWarn().campos)).not.toContain('ana.perez@flit.io');
  });

  it('lo que NO se frena no escribe nada', async () => {
    // Un warn por petición normal ahogaría la señal: el valor de este log es que solo aparece
    // cuando alguien ya pasó del tope.
    const app = appConLimitador('prueba-silencio');

    for (let i = 0; i < MAX; i += 1) {
      const r = await request(app).get('/api/clientes/41');
      expect(r.status).toBe(200);
    }

    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('el rastro no cambia la respuesta', () => {
  it('sigue siendo 429 con el mismo cuerpo que el handler por defecto', async () => {
    // El handler propio sustituye al de la librería, así que tiene que responder lo mismo: estado y
    // `message` salen de `options`, no de un literal copiado que se pueda desincronizar.
    const app = appConLimitador('prueba-respuesta');

    for (let i = 0; i < MAX; i += 1) await request(app).get('/api/clientes/41');
    const frenado = await request(app).get('/api/clientes/41');

    expect(frenado.status).toBe(429);
    expect(frenado.body).toEqual(CUERPO);
  });

  it('y las peticiones dentro del tope siguen llegando al handler', async () => {
    const app = appConLimitador('prueba-paso');

    const r = await request(app).get('/api/clientes/41');

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});
