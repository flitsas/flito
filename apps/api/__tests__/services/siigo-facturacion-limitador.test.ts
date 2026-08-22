// HU #11299 — el limitador va ANTES de las DOS guardas en `POST /siigo/facturacion`.
//
// Tercera aparición del mismo defecto (la segunda auditoría lo encontró vivo aquí y en
// `envio-correo.routes.ts` después de cerrarlo en `terceros.routes.ts`): con `EMISION` delante, la
// guarda resolvía el 403 sin que el limitador llegara a contar la petición, y `exigirAccionSiigo`
// escribe una fila `permiso_denegado` en `siigo_operaciones` por cada intento. Esa tabla es
// append-only por disparador (HU #11251): lo que entra ahí no se borra ni se rectifica.
//
// ── Lo que esta ruta tiene de propio ─────────────────────────────────────────────────────────────
//
// Son TRES middlewares y no dos: `EMISION, exigirReactivar, envioLimiter`. Y el del medio también
// escribe cuando deniega —delega en `REACTIVACION`, que es otra guarda del mismo catálogo—, así que
// el limitador no podía quedarse en medio: `EMISION, envioLimiter, exigirReactivar` habría tapado
// una escritura y dejado la otra abierta, que es medio arreglo con aspecto de arreglo entero. Por
// eso el orden es `envioLimiter, EMISION, exigirReactivar`.
//
// Que hoy `emitir` y `reactivar` resuelvan a la misma lista de roles hace que ningún rol pueda
// llegar a la segunda guarda y ser rechazado ahí — hoy. La pregunta 16 del diseño sigue abierta y
// el propio comentario de la ruta anticipa el día en que alguien restrinja `reactivar`. Ese
// escenario se ejerce aquí restringiendo la acción en el catálogo, que es de donde sale la
// decisión, y NO tocando el mecanismo que se está probando.
//
// La cuota se lleva por usuario (`userOrIpKey`), así que cada prueba usa su propio `sub`: quien
// insiste sin permiso se frena a sí mismo y no al que factura.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import 'express-async-errors';
import express from 'express';
import { testToken, type TestRole } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

/**
 * `reactivar` se niega a todo el mundo; `emitir` conserva su fila real.
 *
 * Es la única forma de provocar hoy una denegación de la SEGUNDA guarda, que es lo que hace
 * distinta a esta ruta. Se interviene el CATÁLOGO —que es donde el diseño dice que se decide quién
 * puede qué, y donde la pregunta 16 acabará cambiando algo— y no `exigirAccionSiigo` ni el orden
 * del router, que es justo lo que se está midiendo.
 */
vi.mock('@operaciones/shared-types', async (original) => {
  const real = await original<typeof import('@operaciones/shared-types')>();
  return {
    ...real,
    puedeEjecutar: (rol: string, accion: string) => (
      accion === 'reactivar' ? false : real.puedeEjecutar(rol as never, accion as never)
    ),
  };
});

/** La bitácora WORM: aquí es donde se cuentan las filas que un denegado puede provocar. */
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: (...args: unknown[]) => registrarOperacionMock(...args),
}));

const enviarMock = vi.fn();
vi.mock('../../src/modules/siigo/facturacion.encolado.service.js', () => ({
  enviarAFacturacion: (...args: unknown[]) => enviarMock(...args),
  TOPE_TRAMITES_ENVIO: 200,
}));

vi.mock('../../src/modules/siigo/facturacion.cola.service.js', () => ({
  colaDeTramites: vi.fn().mockResolvedValue([]),
  encolar: vi.fn(),
  SiigoColaError: class SiigoColaError extends Error {
    codigo: string;

    constructor(codigo: string, mensaje: string) { super(mensaje); this.codigo = codigo; }
  },
}));

const { rateLimitBloqueadoTotal } = await import('../../src/shared/metrics.js');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/siigo/facturacion.routes.js');
  app.use('/api/siigo/facturacion', router);
  return app;
}

const auth = async (role: TestRole, sub: number) =>
  `Bearer ${await testToken({ sub, username: `${role}-${sub}@flit.io`, role })}`;

const RUTA = '/api/siigo/facturacion';
const TRAMITE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CUERPO = { conceptos: ['tramite_digital'], tramiteIds: [TRAMITE] };

/** Cuántas peticiones deja pasar `envioLimiter` por ventana (un minuto). */
const MAX_VENTANA = 20;

/** Cuánto lleva contado el freno de ESTE limitador. La métrica es acumulativa y global. */
async function frenosContados(): Promise<number> {
  const metrica = await rateLimitBloqueadoTotal.get();
  return metrica.values
    .find((v) => v.labels.limitador === 'siigo-envio-facturacion')?.value ?? 0;
}

const filasDenegadas = () => registrarOperacionMock.mock.calls
  .map((c) => c[0] as { operacion: string })
  .filter((r) => r.operacion === 'permiso_denegado');

beforeEach(() => {
  registrarOperacionMock.mockClear();
  enviarMock.mockReset();
});

describe('la primera guarda: el intento denegado se cuenta antes de escribirse', () => {
  it('el 403 de `emitir` sale con las cabeceras del límite', async () => {
    // Con `EMISION` delante, la respuesta se resolvía sin pasar por el limitador y estas cabeceras
    // no existían. Son la huella externa del orden.
    const app = await buildApp();

    const r = await request(app).post(RUTA)
      .set('Authorization', await auth('auditor', 301)).send(CUERPO);

    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ accion: 'emitir' });
    expect(r.headers['x-ratelimit-limit']).toBe(String(MAX_VENTANA));
    expect(r.headers['x-ratelimit-remaining']).toBe(String(MAX_VENTANA - 1));
  });

  it('agotada la ventana, el siguiente intento es 429 y no deja fila en la bitácora WORM', async () => {
    // La garantía de fondo, y la única que se mide en escrituras: `siigo_operaciones` no acepta
    // UPDATE ni DELETE, así que el techo del ataque es literalmente el techo de la tabla.
    const app = await buildApp();
    const token = await auth('auditor', 302);

    for (let i = 0; i < MAX_VENTANA; i += 1) {
      const r = await request(app).post(RUTA).set('Authorization', token).send(CUERPO);
      expect(r.status).toBe(403);
    }
    expect(filasDenegadas()).toHaveLength(MAX_VENTANA);

    const frenado = await request(app).post(RUTA).set('Authorization', token).send(CUERPO);

    expect(frenado.status).toBe(429);
    // Ni una más: el 429 se resuelve en el limitador, antes de la guarda que escribe.
    expect(filasDenegadas()).toHaveLength(MAX_VENTANA);
  });
});

describe('la segunda guarda: `exigirReactivar` también escribe, y también queda detrás', () => {
  it('la denegación de `reactivar` deja su propia fila en la bitácora WORM', async () => {
    // La premisa del hallazgo, comprobada y no supuesta: `exigirReactivar` no es un `if` inocuo —
    // cuando dispara delega en otro `exigirAccionSiigo`, que escribe igual que el primero. Si esto
    // dejara de ser cierto, el orden de esta ruta se podría simplificar; mientras lo sea, no.
    const app = await buildApp();

    const r = await request(app).post(RUTA)
      .set('Authorization', await auth('admin', 303)).send({ ...CUERPO, reactivar: true });

    expect(r.status).toBe(403);
    // Viene de la SEGUNDA guarda: la primera habría dicho `emitir`, y `admin` sí puede emitir.
    expect(r.body).toMatchObject({ accion: 'reactivar' });
    expect(filasDenegadas()).toHaveLength(1);
    expect(registrarOperacionMock.mock.calls[0][0]).toMatchObject({
      operacion: 'permiso_denegado', statusHttp: 403, codigo: 'PERMISO_DENEGADO',
    });
  });

  it('ese 403 también llega con las cabeceras del límite: el limitador va delante de las DOS', async () => {
    // Es lo que descarta el arreglo a medias `EMISION, envioLimiter, exigirReactivar`: con ese
    // orden, la primera guarda seguiría escribiendo sin freno.
    const app = await buildApp();

    const r = await request(app).post(RUTA)
      .set('Authorization', await auth('admin', 304)).send({ ...CUERPO, reactivar: true });

    expect(r.status).toBe(403);
    expect(r.headers['x-ratelimit-limit']).toBe(String(MAX_VENTANA));
    expect(r.headers['x-ratelimit-remaining']).toBe(String(MAX_VENTANA - 1));
  });

  it('y tiene tope: agotada la ventana deja de escribir', async () => {
    const app = await buildApp();
    const token = await auth('admin', 305);
    const cuerpo = { ...CUERPO, reactivar: true };

    for (let i = 0; i < MAX_VENTANA; i += 1) {
      const r = await request(app).post(RUTA).set('Authorization', token).send(cuerpo);
      expect(r.status).toBe(403);
    }
    expect(filasDenegadas()).toHaveLength(MAX_VENTANA);

    const frenado = await request(app).post(RUTA).set('Authorization', token).send(cuerpo);

    expect(frenado.status).toBe(429);
    expect(filasDenegadas()).toHaveLength(MAX_VENTANA);
  });
});

describe('el orden no debilita ninguna de las dos guardas', () => {
  it('el rol sin permiso sigue recibiendo 403 y el servicio no se ejecuta', async () => {
    const app = await buildApp();

    const r = await request(app).post(RUTA)
      .set('Authorization', await auth('auditor', 306)).send(CUERPO);

    expect(r.status).toBe(403);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('sin token sigue siendo 401: el limitador no autentica a nadie', async () => {
    const app = await buildApp();

    const r = await request(app).post(RUTA).send(CUERPO);

    expect(r.status).toBe(401);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('un envío normal —sin `reactivar`— no pide el permiso que no ejerce y pasa', async () => {
    // La guarda del medio sigue siendo condicional: si se hubiera vuelto incondicional al mover el
    // limitador, este caso sería un 403 con el catálogo de esta prueba.
    enviarMock.mockResolvedValue({
      ambiente: 'pruebas', items: [], resumen: { total: 0, encolados: 0, yaEstaban: 0, rechazados: 0 },
    });
    const app = await buildApp();

    const r = await request(app).post(RUTA)
      .set('Authorization', await auth('admin', 307)).send(CUERPO);

    expect(r.status).toBe(202);
    expect(enviarMock).toHaveBeenCalledTimes(1);
  });

  it('el cuerpo inválido sigue dando 400: el limitador no valida nada', async () => {
    const app = await buildApp();

    const r = await request(app).post(RUTA)
      .set('Authorization', await auth('admin', 308)).send({ tramiteIds: [], conceptos: [] });

    expect(r.status).toBe(400);
    expect(enviarMock).not.toHaveBeenCalled();
  });
});

describe('el 429 no es un punto ciego', () => {
  it('el freno cuenta un punto en `rate_limit_bloqueado_total` con SU limitador', async () => {
    // La etiqueta prueba además que el `handler` está cableado en ESTE limitador y no en otro.
    const app = await buildApp();
    const token = await auth('auditor', 309);
    const antes = await frenosContados();

    for (let i = 0; i < MAX_VENTANA + 1; i += 1) {
      await request(app).post(RUTA).set('Authorization', token).send(CUERPO);
    }

    expect(await frenosContados()).toBe(antes + 1);
  });
});
