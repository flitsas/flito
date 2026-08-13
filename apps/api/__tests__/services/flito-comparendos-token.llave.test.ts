// HU #11498 · AC2 — sin llave maestra no se opera, y el bootstrap de entorno no la sustituye.
//
// Archivo aparte del resto de tests del token por la misma razón que `siigo-credenciales.llave`:
// `config/env.ts` valida con zod EN EL IMPORT, así que `env` es una foto de `process.env` tomada al
// arrancar y borrar la variable en caliente no cambiaría el comportamiento. Para ejercer la
// ausencia de `COMPARENDOS_ENC_KEY` hay que mockear el módulo de entorno antes de importar nada que
// lo lea.
//
// Se mockea con un Proxy sobre el `env` REAL y no con un objeto a mano: por el módulo pasan también
// el `authMiddleware` (JWT_SECRET), el logger y los saltos de comprobación de sesión que fija
// `setup.ts`. Sustituir el objeto entero obligaría a mantener aquí una copia de medio entorno.
//
// Lo que se demuestra:
//   1. Sin llave (o con una llave inválida, o con una de entropía ridícula) el PUT responde 503
//      `llave_maestra` y NO toca la base: no queda nada a medio cifrar ni se desactiva el token
//      bueno que ya estaba funcionando.
//   2. El GET de metadatos SÍ sigue funcionando: mirar no descifra, y es la información con la que
//      se diagnostica el problema.
//   3. Leer el token para usarlo distingue «falta la llave» (la fila está sana, no se toca) de
//      «el cipher no autentica» (la fila se apaga).
//   4. `VERIFIK_SIMIT_TOKEN` bootstrappea solo cuando NO hay fila activa, y nunca tapa una fila
//      corrupta ni la falta de llave.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

/** Overrides del entorno, mutables por test. `undefined` = variable ausente. */
const entorno: { encKey: string | undefined; bootstrapToken: string | undefined } = {
  encKey: undefined,
  bootstrapToken: undefined,
};

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'COMPARENDOS_ENC_KEY') return entorno.encKey;
        if (prop === 'VERIFIK_SIMIT_TOKEN') return entorno.bootstrapToken;
        return target[prop as string];
      },
    }),
  };
});

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { obtenerTokenSimit } =
  await import('../../src/modules/flito-comparendos/flito-comparendos.token.service.js');

const BASE = '/api/flito/comparendos';
const RUTA = `${BASE}/config/token-simit`;
const TABLA = 'flito_comparendos_token_simit';
const AHORA = new Date('2026-08-13T15:30:00Z');
const TOKEN = 'token-simit-de-prueba-para-el-caso-sin-llave';
const LLAVE_VALIDA = 'b5f4065feb4eb79cbd65cb53b4c23a6bf695b4e5b5f67e3266175637bdfb8dfd';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

/** El limitador del PUT cuenta por usuario: cada test estrena `sub` y no hereda cuota gastada. */
let siguienteSub = 100;
const auth = async () => `Bearer ${await testToken({ sub: siguienteSub++, username: 'ops@flit.io', role: 'admin' })}`;

/** Fila activa con un cipher cualquiera: en estos casos nunca se llega a descifrarlo de verdad. */
const filaCifrada = (over: Record<string, unknown> = {}) => ({
  id: 3,
  tokenCipher: Buffer.from('cipher-que-no-se-va-a-poder-verificar'),
  tokenIv: Buffer.alloc(12, 7),
  tokenAuthTag: Buffer.alloc(16, 9),
  aadNonce: '11111111-1111-1111-1111-111111111111',
  keyVersion: 1, activo: true,
  descifradoFallidoEn: null, descifradoFallidoMotivo: null,
  createdAt: AHORA, createdBy: 7, updatedAt: AHORA, updatedBy: 7,
  ...over,
});

beforeEach(() => {
  kdb.reset();
  auditMock.mockClear();
  entorno.encKey = undefined;
  entorno.bootstrapToken = undefined;
});

// ─────────────────────────── AC2 · Cifrar sin llave ─────────────────────────────────────────────

describe('PUT del token sin llave maestra', () => {
  it('responde 503 con código llave_maestra y nombra la variable que falta', async () => {
    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    // 503 y no 500: el servicio está bien construido, es el entorno el que no está configurado.
    // El mensaje dice qué provisionar; el `codigo` es lo que la pantalla compara.
    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('llave_maestra');
    expect(r.body.error).toMatch(/COMPARENDOS_ENC_KEY no está configurada/);
  });

  it('NO toca la base de datos: nada queda a medio cifrar ni se desactiva el token anterior', async () => {
    await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    // Se cifra ANTES de abrir la transacción justo para esto: desactivar primero y fallar al cifrar
    // dejaría la integración sin token por un fallo de configuración del entorno.
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('no deja auditoría de un cambio que no ocurrió', async () => {
    await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    expect(auditMock).not.toHaveBeenCalled();
  });

  it('la respuesta de error no devuelve el token que se intentó guardar', async () => {
    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it('una llave que no es de 32 bytes se rechaza igual que la ausencia', async () => {
    entorno.encKey = 'demasiado-corta';

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('llave_maestra');
    expect(r.body.error).toMatch(/64 hex chars/);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('una llave de bytes uniformes se rechaza por entropía insuficiente', async () => {
    // Pasa el regex de 64 hex y cifraría sin quejarse: por eso el filtro de entropía compartido
    // (`assertSufficientEntropy`, el mismo que usan RNDC y Siigo) va también en este keyspace.
    entorno.encKey = '0'.repeat(64);

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('llave_maestra');
    expect(r.body.error).toMatch(/entropía|uniformes/i);
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── AC2 · Mirar no descifra ────────────────────────────────────────────

describe('GET de metadatos sin llave maestra', () => {
  it('sigue respondiendo: es la información con la que se diagnostica el problema', async () => {
    kdb.when.select(TABLA, [{ id: 3, keyVersion: 1, actualizadoEn: AHORA, autorId: 7, autorNombre: 'Operaciones FLIT' }]);

    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());

    // Fallar aquí dejaría a quien administra sin poder ver siquiera que hay un token guardado y de
    // cuándo es. Lo que falla sin llave es USAR el token, no mirar su ficha.
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configurado: true, keyVersion: 1 });
  });
});

// ─────────────────────────── AC2 · Descifrar para uso ───────────────────────────────────────────

describe('leer el token para usarlo, sin llave maestra', () => {
  it('devuelve llave_maestra, distinguible de un token ausente o corrupto', async () => {
    kdb.when.select(TABLA, [filaCifrada()]);

    await expect(obtenerTokenSimit()).rejects.toMatchObject({ codigo: 'llave_maestra', status: 503 });
  });

  it('NO desactiva la fila: está sana, lo que está mal es el entorno', async () => {
    kdb.when.select(TABLA, [filaCifrada()]);

    await expect(obtenerTokenSimit()).rejects.toThrow();

    // Apagarla aquí tiraría un token bueno por una variable que falta, y obligaría a volver a
    // pedírselo al proveedor en cuanto se arreglara el despliegue.
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── Bootstrap de entorno (opcional, dev) ───────────────────────────────

describe('VERIFIK_SIMIT_TOKEN como bootstrap', () => {
  it('se usa cuando NO hay fila activa', async () => {
    entorno.bootstrapToken = 'token-de-bootstrap-solo-dev';
    kdb.when.select(TABLA, []);

    const token = await obtenerTokenSimit();

    expect(token.unwrap()).toBe('token-de-bootstrap-solo-dev');
    // Envuelto igual que el de la base: el camino de bootstrap no puede ser el que filtre el valor.
    expect(JSON.stringify({ token })).toBe('{"token":"[REDACTED]"}');
  });

  it('no tapa una fila corrupta: la fila cifrada es la fuente de verdad', async () => {
    entorno.encKey = LLAVE_VALIDA;
    entorno.bootstrapToken = 'token-de-bootstrap-solo-dev';
    kdb.when.select(TABLA, [filaCifrada()]);

    // Con fila activa el entorno no participa. Si el bootstrap se aplicara como respaldo del
    // descifrado, una fila manipulada dejaría de notarse y el sync seguiría corriendo con un token
    // que nadie registró — exactamente lo que ADR-0002 no quiere en producción.
    await expect(obtenerTokenSimit()).rejects.toMatchObject({ codigo: 'token_descifrado' });
  });

  it('no sustituye a la llave maestra cuando hay fila activa', async () => {
    entorno.bootstrapToken = 'token-de-bootstrap-solo-dev';
    kdb.when.select(TABLA, [filaCifrada()]);

    await expect(obtenerTokenSimit()).rejects.toMatchObject({ codigo: 'llave_maestra' });
  });
});
