// HU #12214 — los TRES limitadores del canal Cliente, mirados como contadores y no como rutas.
//
// El diagnóstico que abre la HU: los 429 intermitentes al consultar el RUNT no venían del RUNT. Y la
// razón es más simple —y más fuerte— que un mapeo de códigos: `runt.service.consultarVehiculoProxy`
// colapsa **cualquier** respuesta que no sea 200 en `{ok:false}` (`fallo()`, sin mirar el status), y
// la compuerta traduce ese `{ok:false}` a `503 runt_no_disponible`. **En este canal el status
// upstream no se ramifica en ningún punto**, así que por construcción el 429 del proveedor no puede
// llegar como 429 al cliente. Los 429 que veía el usuario los emitían siempre los limitadores
// propios, y uno de ellos —el sub-límite de la preconsulta, 8/15min— estaba elegido sin telemetría y
// por su propio docblock.
//
// (`upstreamHttpStatus` sí mapea 429→503, pero ESA vía es la del proxy CEA de trámites; el canal
// SOAT no la llama. Ver el describe del AC6 al final de este archivo.)
//
// Lo que se mide aquí y que no se puede medir ruta por ruta:
//
//   1. **Las tres llaves son distintas para el MISMO usuario** (AC5). No se leen del código: se leen
//      de `req.rateLimit.key` tal como `frenoConRastro` la escribe en el `warn` de cada 429. Un
//      prefijo repetido entre dos limitadores haría que compartieran contador y que el `max` más
//      estricto ganara para las dos rutas — el fallo exacto que esta HU viene a deshacer.
//   2. **Los tres stores llevan prefijos distintos** (AC5, la otra mitad). Con Redis presente el
//      contador vive en el store, y dos limitadores con el mismo `prefix` se pisan aunque sus
//      `keyGenerator` difieran.
//   3. **El rastro del 429 se conserva entero** (AC4): un punto en `rate_limit_bloqueado_total`
//      etiquetado por limitador —incluido el limitador NUEVO— y un `warn` con la llave, el límite y
//      los intentos, sin una sola cadena de PII.
//   4. **El techo que cada limitador declara** (`info.limit`): 20 el del canal, 15 la preconsulta
//      (AC1) y 12 la lectura. Es el número dicho por el middleware, no por una constante del test.
//   5. **El 429 upstream sigue siendo 503** (AC6). Aquí solo el unitario de la OTRA vía
//      (`upstreamHttpStatus`, trámites/CEA); el camino real de este canal —RUNT no-200 → 503— se
//      mide de punta a punta en `flito-soat.cliente-runt-por-vin.test.ts`.
//
// Las peticiones van a propósito SIN cuerpo válido: el limitador corre antes del handler, así que
// gastan su punto igual y mueren en un 400/403 sin llamar al RUNT ni al OCR. Lo que se ejercita es
// el contador, y nada más.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const warnMock = vi.fn();
vi.mock('../../src/shared/logger.js', () => {
  const falso = {
    warn: (...args: unknown[]) => warnMock(...args),
    info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
    child: () => falso,
  };
  return { logger: falso, loggerFor: () => falso };
});

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const { rateLimitBloqueadoTotal } = await import('../../src/shared/metrics.js');

const CORREO = 'cliente@empresa.co';
const SUB = 71214;

/**
 * PII **que la petición del 429 lleva de verdad en el cuerpo**, y no una lista negra de valores que
 * nadie envía. El cuerpo de `/cliente/factura/lectura` lleva `vin`, así que un `warn` que copiara un
 * campo del body los escribiría en el log. Sintéticos, pero con la forma real.
 */
const VIN_CUERPO = '9BWZZZ377VT004251';
const DOCUMENTO_CUERPO = '1032456789';

/** Las seis claves que `frenoConRastro` emite, y NINGUNA más. Ordenadas para comparar como conjunto. */
const CLAVES_DEL_RASTRO = ['intentos', 'limitador', 'limite', 'llave', 'metodo', 'ruta'];

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const auth = async (id: number) =>
  `Bearer ${await testToken({ sub: id, username: CORREO, role: 'cliente' as never })}`;

/** El valor actual del contador para una etiqueta; 0 si esa serie todavía no existe. */
async function metrica(limitador: string): Promise<number> {
  const m = await rateLimitBloqueadoTotal.get();
  return m.values.find((v) => v.labels.limitador === limitador)?.value ?? 0;
}

/** El payload del último `warn` emitido por `frenoConRastro` para ese limitador. */
function ultimoRastro(limitador: string): Record<string, unknown> | undefined {
  const payloads = warnMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
  return payloads.filter((p) => p?.limitador === limitador).at(-1);
}

/**
 * Agota los tres contadores CON EL MISMO USUARIO y devuelve el rastro de cada 429.
 *
 * El orden importa y es el único que produce un 429 de cada limitador con una sola cuenta:
 *
 *   · 15 preconsultas pasan el sub-límite (y gastan 15 de los 20 del canal); la 16.ª la frena el
 *     sub-límite, que es el más estricto de los dos que lleva esa ruta.
 *   · con 16 puntos del canal gastados, cuatro altas más lo dejan en 20 y la quinta cae por el
 *     limitador COMPARTIDO.
 *   · y solo entonces se ejercita la lectura: sus doce pasan igualmente, que es la prueba por
 *     comportamiento de que su contador no es ninguno de los otros dos (AC2 y AC5).
 */
async function agotarLosTres() {
  const app = await buildApp();
  const token = await auth(SUB);
  const preconsulta = () => request(app).post('/api/flito/soat/cliente/preconsulta').set('Authorization', token).send({});
  const alta = () => request(app).post('/api/flito/soat/cliente').set('Authorization', token);
  // Con PII EN EL CUERPO: el limitador corre después de `express.json()`, así que `req.body` está
  // poblado cuando `frenoConRastro` escribe su `warn`. Es lo que convierte el aserto de «ni una
  // cadena de PII» en una medida y no en una declaración.
  const lectura = () => request(app).post('/api/flito/soat/cliente/factura/lectura')
    .set('Authorization', token)
    .send({ vin: VIN_CUERPO, documento: DOCUMENTO_CUERPO });

  const preconsultas: number[] = [];
  for (let i = 0; i < 16; i++) preconsultas.push((await preconsulta()).status);

  const altas: number[] = [];
  for (let i = 0; i < 5; i++) altas.push((await alta()).status);

  const lecturas: number[] = [];
  for (let i = 0; i < 13; i++) lecturas.push((await lectura()).status);

  return { preconsultas, altas, lecturas };
}

let ejecucion: Awaited<ReturnType<typeof agotarLosTres>>;
let antes: Record<string, number>;

beforeAll(async () => {
  antes = {
    'soat-cliente': await metrica('soat-cliente'),
    'soat-preconsulta': await metrica('soat-preconsulta'),
    'soat-lectura': await metrica('soat-lectura'),
  };
  ejecucion = await agotarLosTres();
});

describe('AC5 — los tres contadores son independientes y no comparten prefijo', () => {
  it('**cada limitador frena en SU número y ninguno se lleva por delante a los otros**', async () => {
    // Por comportamiento y en una sola cuenta: quince preconsultas, cinco altas y trece lecturas.
    // Si dos limitadores compartieran contador, este reparto sería imposible — el más estricto
    // frenaría al otro antes de llegar a su propio techo.
    expect(ejecucion.preconsultas.slice(0, 15).every((s) => s !== 429), 'las 15 primeras preconsultas pasan el freno').toBe(true);
    expect(ejecucion.preconsultas[15], 'la 16.ª preconsulta la frena su sub-límite').toBe(429);

    expect(ejecucion.altas.slice(0, 4).every((s) => s !== 429), 'quedan 4 peticiones del canal para el alta').toBe(true);
    expect(ejecucion.altas[4], 'la 21.ª petición del canal cae por el limitador compartido').toBe(429);

    // Y lo que la HU estrena: con el canal YA agotado, la lectura sigue teniendo sus doce enteras.
    expect(ejecucion.lecturas.slice(0, 12).every((s) => s !== 429), 'la lectura no depende del contador del canal').toBe(true);
    expect(ejecucion.lecturas[12], 'la 13.ª lectura la frena su propio limitador').toBe(429);
  });

  it('**las tres llaves son distintas para el mismo usuario, y sus prefijos también**', () => {
    // Leídas de `req.rateLimit.key`, que es la llave REAL con la que cada middleware indexa su
    // contador, no de una constante del módulo. Un `soat-lectura:` copiado de `soat-cliente:` daría
    // aquí dos llaves idénticas.
    const llaves = ['soat-cliente', 'soat-preconsulta', 'soat-lectura']
      .map((l) => String(ultimoRastro(l)?.llave ?? ''));

    for (const llave of llaves) {
      expect(llave, 'cada 429 tiene que dejar su llave escrita').not.toBe('');
      // Mismo usuario en los tres: lo que separa los contadores es el prefijo y nada más.
      expect(llave.endsWith(`-${SUB}`)).toBe(true);
    }

    expect(new Set(llaves).size, `llaves repetidas: ${llaves.join(' | ')}`).toBe(3);

    const prefijos = llaves.map((k) => k.slice(0, k.indexOf(':') + 1));
    expect(prefijos).toEqual(['soat-cliente:', 'soat-preconsulta:', 'soat-lectura:']);
    expect(new Set(prefijos).size).toBe(3);
  });

  it('**el techo que declara cada limitador es 20 / 15 / 12** (AC1 y el número nuevo)', () => {
    // `info.limit` lo pone `express-rate-limit` a partir de su `max`, así que esto afirma el número
    // configurado sin introspección: la v8 no publica sus `options` en el middleware devuelto.
    expect(ultimoRastro('soat-cliente')?.limite, 'el contador del canal sigue en 20').toBe(20);
    expect(ultimoRastro('soat-preconsulta')?.limite, 'la preconsulta sube a 15 (AC1)').toBe(15);
    expect(ultimoRastro('soat-lectura')?.limite, 'la lectura estrena su techo propio').toBe(12);
  });

  it('**los tres stores llevan prefijos distintos, y ninguno repetido en todo el módulo**', async () => {
    // La otra mitad del AC5: con Redis presente el contador vive en el store, y dos limitadores con
    // el mismo `prefix` se pisarían aunque sus `keyGenerator` fueran distintos. Se mide capturando
    // la construcción del `RedisStore` con un Redis falso —la suite corre sin Redis y `makeStore`
    // devolvería `undefined`—, con el módulo reimportado en un registro limpio.
    const prefijos: string[] = [];
    vi.resetModules();
    vi.doMock('rate-limit-redis', () => ({
      RedisStore: class {
        prefix: string;
        constructor(opciones: { prefix: string }) { this.prefix = opciones.prefix; prefijos.push(opciones.prefix); }
        init() { /* el middleware no llega a usarlo: aquí solo se mira cómo se construyó */ }
        async increment() { return { totalHits: 1, resetTime: new Date() }; }
        async decrement() { /* no usado */ }
        async resetKey() { /* no usado */ }
      },
    }));
    vi.doMock('../../src/shared/redis.js', () => ({
      getRedis: () => ({ call: vi.fn() }), closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(true),
    }));

    try {
      await import('../../src/shared/middleware/rateLimiter.js');

      expect(prefijos, 'los tres del canal Cliente tienen que estar').toEqual(
        expect.arrayContaining(['rl:soat-cliente:', 'rl:soat-preconsulta:', 'rl:soat-lectura:']),
      );
      // Y ninguno repetido en TODO el módulo: dos limitadores cualesquiera compartiendo `prefix`
      // comparten contador en Redis, que es el mismo fallo con otro nombre.
      expect(new Set(prefijos).size, `prefijos repetidos: ${prefijos.join(' | ')}`).toBe(prefijos.length);
    } finally {
      vi.doUnmock('rate-limit-redis');
      vi.doUnmock('../../src/shared/redis.js');
      vi.resetModules();
    }
  });
});

describe('AC4 — el rastro del 429 se conserva entero, y el limitador nuevo también lo deja', () => {
  it('**cada 429 suma su punto en `rate_limit_bloqueado_total`, etiquetado por limitador**', async () => {
    // El delta y no el valor absoluto: el contador es un singleton del registro de Prometheus.
    for (const limitador of ['soat-cliente', 'soat-preconsulta', 'soat-lectura']) {
      expect(await metrica(limitador) - antes[limitador]!, limitador).toBeGreaterThanOrEqual(1);
    }
  });

  it('**el `warn` lleva llave, método, ruta, límite e intentos — y ni una cadena de PII**', () => {
    const rastro = ultimoRastro('soat-lectura')!;

    expect(rastro.llave).toBe(`soat-lectura:-${SUB}`);
    expect(rastro.metodo).toBe('POST');
    expect(rastro.ruta).toBe('/api/flito/soat/cliente/factura/lectura');
    expect(rastro.intentos).toBe(13);

    // ── El aserto que manda: el CONJUNTO EXACTO de claves ──────────────────────────────────────
    //
    // No `toMatchObject` y no una lista negra de valores: cualquier campo NUEVO en el rastro pone
    // este test en rojo, se llame como se llame y valga lo que valga. Es la única forma de que un
    // `vehiculo: req.body.vin` añadido al `warn` no pase inadvertido — un `toMatchObject` lo
    // dejaría verde, y una lista negra solo atrapa los valores que se acordó de enumerar.
    expect(Object.keys(rastro).sort(), `claves inesperadas en el rastro: ${Object.keys(rastro).join(', ')}`)
      .toEqual(CLAVES_DEL_RASTRO);

    // Y además, por valor: la PII que ESTA petición sí mandó en el cuerpo no aparece serializada.
    // Probar la forma y probar que no se filtró son dos cosas distintas, y hacen falta las dos.
    const serializado = JSON.stringify(rastro);
    expect(serializado, 'el VIN viajaba en el cuerpo de la petición frenada').not.toContain(VIN_CUERPO);
    expect(serializado, 'el documento del titular también').not.toContain(DOCUMENTO_CUERPO);
    // `logger` no redacta lo que no reconoce: el correo del usuario está en el token y no puede
    // acabar aquí, y la ruta va sin query string porque ahí es donde viajan documento y placa.
    expect(serializado).not.toContain(CORREO);
    expect(serializado).not.toContain('?');

    // ── El SEGUNDO sumidero de la misma llamada: el mensaje ────────────────────────────────────
    //
    // `logFreno.warn(payload, mensaje)`. Todo lo de arriba mira el payload y descarta `c[1]`, así
    // que una PII interpolada en el mensaje —`...con 429 (vin ${req.body.vin})`, que es la forma
    // MÁS común de que un dato acabe en los logs, con `req` en el ámbito— pasaba verde. En pino ese
    // argumento se renderiza entero como `msg` en la línea de log.
    //
    // Se fija al LITERAL exacto y no a la ausencia del VIN: así muere cualquier interpolación,
    // no solo la que se nos ocurrió enumerar.
    const todas = warnMock.mock.calls
      .filter((c) => (c[0] as Record<string, unknown>)?.limitador === 'soat-lectura');
    // Un 429 emite UN warn. Sin fijar el número, `.at(-1)` deja pasar una llamada sucia anterior:
    // bastaría con emitir el `warn` con PII antes del limpio para que ni este aserto ni
    // `ultimoRastro` la vieran. El conteo es lo que convierte «el último está limpio» en
    // «no hay ninguno sucio».
    expect(todas.length, 'un 429 deja UN solo warn: si hay más, alguno se está escapando del .at(-1)').toBe(1);
    const llamada = todas.at(-1)!;
    expect(String(llamada[1]), 'el mensaje del warn tampoco puede llevar datos de la petición')
      .toBe('Limitador activado: peticion rechazada con 429');
  });
});

describe('AC6 (la OTRA vía) — `upstreamHttpStatus` mapea el 429 a 503 en el proxy CEA, no en el canal SOAT', () => {
  it('**`upstreamHttpStatus` mapea 429→503 — pero esta función la usa `tramites.service`, NO el canal SOAT**', async () => {
    // ATENCIÓN a lo que este caso NO acredita. `upstreamHttpStatus` tiene exactamente dos usos en
    // `apps/api/src`: su definición (`shared/upstream.ts`) y el proxy CEA de trámites. **El canal
    // Cliente del SOAT no la llama nunca.** El 503 que ve el usuario del SOAT sale de otro sitio
    // —`runt.service.fallo()` colapsando cualquier no-200— y eso se mide en la suite hermana
    // `flito-soat.cliente-runt-por-vin.test.ts`, sobre la ruta real.
    //
    // Se conserva aquí porque la afirmación del AC6 («un 429 upstream nunca sale como 429») también
    // tiene que valer en la vía de trámites, y porque es la vía que la nota técnica de la HU citaba.
    const { upstreamHttpStatus } = await import('../../src/shared/upstream.js');

    expect(upstreamHttpStatus({ statusCode: 429 })).toBe(503);
    expect(upstreamHttpStatus({ statusCode: 429 })).not.toBe(429);
    // Los vecinos, para que el 503 sea del 429 y no de una rama que se lo trague todo.
    expect(upstreamHttpStatus({ kind: 'timeout' })).toBe(504);
    expect(upstreamHttpStatus({ kind: 'network' })).toBe(502);
    expect(upstreamHttpStatus({ statusCode: 500 })).toBe(502);
  });
});
