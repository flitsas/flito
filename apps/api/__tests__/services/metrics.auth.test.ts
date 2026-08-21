// Bug #11599 — GET /metrics respondía 200 sin autenticación en DEV, QA y PDN.
//
// Se prueba contra la ruta REAL de `createApp`, no contra el middleware montado aparte:
// lo que falló no fue la lógica del guard (no existía), sino que la ruta estuviera servida
// sin él. Un test del middleware suelto pasaría aunque nadie lo cablease en app.ts.
//
// `env` es una foto tomada en el import (ver __tests__/setup.ts), así que tocar
// process.env.METRICS_TOKEN en caliente no cambiaría nada: se redefine la propiedad sobre
// el objeto `env` real con un getter, dejando el resto del entorno intacto para que
// createApp arranque de verdad.
//
// La app se construye UNA vez y fuera de todo hook. Antes se armaba en un `beforeEach`:
// `createApp()` monta el grafo entero de rutas (150+ módulos) y bajo contención de CPU eso
// excedía el `hookTimeout` de 10s — 5 fallos de 8 con 4 instancias en paralelo (medición de
// security-agent), 0 de 12 en secuencial. Peor que la lentitud era el modo de fallo: si el
// `importOriginal` del mock no alcanzaba a completar, el getter no quedaba instalado y
// `env.METRICS_TOKEN` se leía `undefined` para siempre → 4 de 5 pruebas rojas con mensajes
// engañosos («404 donde se esperaba 401»), que apuntan al guard en vez de al reloj.
//
// Subir el timeout NO es la cura: con `beforeAll(…, 30000)` y la caché de Vite fría siguió
// fallando 4 de 4 en paralelo. Lo que lo cierra es sacar la construcción del hook, porque la
// carga del módulo no corre contra ese reloj. Construir una vez no rompe el aislamiento: el
// guard lee `env.METRICS_TOKEN` en CADA petición, así que mutar `envMock` entre casos sigue
// surtiendo efecto sobre la misma instancia —lo demuestra el test «mutar el token entre casos
// sobre la MISMA app cambia la respuesta»— y el `beforeEach` lo devuelve a `undefined` para
// que el orden de los tests no cuente.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { envMock } = vi.hoisted(() => ({ envMock: { METRICS_TOKEN: undefined as string | undefined } }));

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  Object.defineProperty(actual.env, 'METRICS_TOKEN', {
    get: () => envMock.METRICS_TOKEN,
    configurable: true,
  });
  return actual;
});

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

// `express-rate-limit` va SIN mockear a propósito: el punto de `metricsLimiter` es que
// exista sobre esta ruta, y un passthrough lo borraría del test junto con el defecto.
// Sin Redis (mockeado arriba) cae al store in-memory; el archivo hace ~10 peticiones,
// muy por debajo del techo de 120/15min.

/** Todo lo que la aplicación logueó, con el componente que lo emitió. */
const registroLog: Array<{ componente: string; metodo: string; args: unknown[] }> = [];
vi.mock('../../src/shared/logger.js', () => {
  const fake = (componente: string): unknown => new Proxy({}, {
    get: (_t, metodo: string) => (metodo === 'child'
      ? () => fake(componente)
      : (...args: unknown[]) => { registroLog.push({ componente, metodo, args }); }),
  });
  return { logger: fake('root'), loggerFor: (c: string) => fake(c) };
});

const TOKEN = 'metrics-token-de-prueba-32-chars-min';

// Top level, no `beforeAll`: la carga del módulo no corre contra `hookTimeout` (ver cabecera).
const { createApp } = await import('../../src/app.js');
const app = createApp();

beforeEach(() => {
  envMock.METRICS_TOKEN = undefined;
  registroLog.length = 0;
});

describe('GET /metrics — Bug #11599', () => {
  it('sin METRICS_TOKEN configurado → 404 y NO entrega el registro', async () => {
    const r = await request(app).get('/metrics');

    expect(r.status).toBe(404);
    // El defecto era servir el registro: comprobar el 404 sin comprobar el cuerpo dejaría
    // pasar una respuesta que devolviese las métricas con el código cambiado.
    expect(r.text).not.toMatch(/operaciones_|pesv_|# TYPE/);
  });

  it('con METRICS_TOKEN y sin Authorization → 401 con WWW-Authenticate', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    const r = await request(app).get('/metrics');

    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(r.text).not.toMatch(/operaciones_|pesv_|# TYPE/);
  });

  it('con Bearer incorrecto de la misma longitud → 401', async () => {
    envMock.METRICS_TOKEN = TOKEN;
    const falso = 'x'.repeat(TOKEN.length);

    const r = await request(app).get('/metrics').set('Authorization', `Bearer ${falso}`);

    expect(r.status).toBe(401);
    expect(r.text).not.toMatch(/operaciones_|pesv_|# TYPE/);
  });

  it('con Bearer de longitud distinta → 401 (timingSafeEqual no lanza)', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    // timingSafeEqual tira TypeError si los buffers difieren en longitud: sin el chequeo
    // previo esto sería un 500, no un 401.
    const r = await request(app).get('/metrics').set('Authorization', 'Bearer corto');

    expect(r.status).toBe(401);
  });

  it('con el Bearer correcto → 200 y entrega el registro Prometheus', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    const r = await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);

    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    // Cerrar la ruta rompiéndola no es cerrarla: el scrape autenticado debe seguir
    // recibiendo el registro.
    expect(r.text).toMatch(/operaciones_/);
  });

  // RFC 7235 §2.1: el nombre del esquema es case-insensitive. Fallaba cerrado (401), así que
  // era interoperabilidad, no fuga — pero un cliente que mande `bearer` es un cliente válido.
  it('con el esquema en minúsculas (`bearer`) → 200: RFC 7235 lo define case-insensitive', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    const r = await request(app).get('/metrics').set('Authorization', `bearer ${TOKEN}`);

    expect(r.status).toBe(200);
    expect(r.text).toMatch(/operaciones_/);
  });

  // El aislamiento del `beforeAll` depende de esto: si `createApp` hubiese congelado el valor
  // de METRICS_TOKEN al construirse, los casos de arriba estarían probando siempre el mismo
  // estado y el archivo mentiría en verde. Dos respuestas distintas de la MISMA instancia lo
  // descartan.
  it('mutar el token entre casos sobre la MISMA app cambia la respuesta', async () => {
    const sinToken = await request(app).get('/metrics');
    envMock.METRICS_TOKEN = TOKEN;
    const conToken = await request(app).get('/metrics');

    expect(sinToken.status).toBe(404);
    expect(conToken.status).toBe(401);
  });
});

describe('GET /metrics — endurecimiento (retrabajo security-agent)', () => {
  // `apiLimiter` se monta en `/api` y /metrics vive fuera: hasta este cambio la ruta no
  // tenía freno pese a portar autenticación (regla 18 de AGENTS.md). Se comprueba sobre la
  // respuesta real, no sobre el módulo, porque el defecto sería no cablearlo en app.ts.
  it('la ruta va detrás de un rate limiter (cabeceras RateLimit con la cuota propia)', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    const r = await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);

    const cabecerasRateLimit = Object.keys(r.headers).filter((h) => h.startsWith('ratelimit'));
    expect(cabecerasRateLimit.length).toBeGreaterThan(0);
    // 120 es la cuota de `metricsLimiter`; 500 delataría a `apiLimiter` cubriendo por
    // accidente (no lo hace: se monta en `/api`), y otra cifra, un limiter ajeno.
    expect(r.headers['ratelimit-limit']).toBe('120');
    expect(Number(r.headers['ratelimit-remaining'])).toBeLessThan(120);
  });

  // Sin este log, un barrido contra el token es completamente invisible: el guard rechaza
  // antes de `registry.metrics()`, así que no deja ni coste ni rastro.
  it('cada 401 deja traza con ip y motivo — y JAMÁS el token ni la cabecera Authorization', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    await request(app).get('/metrics');
    await request(app).get('/metrics').set('Authorization', `Bearer ${'x'.repeat(TOKEN.length)}`);

    const avisos = registroLog.filter((l) => l.componente === 'metrics-auth' && l.metodo === 'warn');
    expect(avisos).toHaveLength(2);
    expect(avisos[0].args[0]).toMatchObject({ motivo: 'credencial_ausente', ip: expect.any(String) });
    expect(avisos[1].args[0]).toMatchObject({ motivo: 'token_invalido' });

    // La redacción de pino (`*.token`, `*.secret`…) NO cubre `headers.authorization`: lo que
    // mantiene el token fuera de los logs es que nadie loguee la cabecera. Se verifica aquí
    // para que se note el día que alguien la meta.
    const traza = JSON.stringify(registroLog);
    expect(traza).not.toMatch(/xxxx/i);
    expect(traza.toLowerCase()).not.toContain('authorization');
    expect(traza).not.toContain(TOKEN);
  });

  it('el 200 autenticado NO genera aviso: el log es de rechazos, no de tráfico', async () => {
    envMock.METRICS_TOKEN = TOKEN;

    await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);

    expect(registroLog.filter((l) => l.componente === 'metrics-auth')).toHaveLength(0);
  });
});
