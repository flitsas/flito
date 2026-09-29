// FLITO sync — acceso de FLITO a FLIT 2 (HU #13061, Feature #13057, Épica #12736).
//
// Mismo andamiaje que `flito-comparendos-token.test.ts`: Drizzle mockeado por NOMBRE DE TABLA
// (`keyed-db`) con espías sobre `values()`/`set()` para ver QUÉ se escribe, y el cifrado REAL con la
// `FLIT2_ENC_KEY` de `setup.ts`. La ausencia de llave se ejerce en este mismo archivo con un Proxy
// sobre el `env` real (patrón de `flito-comparendos-token.llave.test.ts`): `entorno.sinLlave = true`.
//
// Mapa AC → casos: AC1 «guardar por primera vez» · AC2 «consultar» · AC3 «sin acceso» · AC4
// «reemplazar» · AC5 «datos vacíos» · AC6 «permisos» · AC8 «auditoría» · AC9 «errores y logs».
// AC7 (siembra) vive en `__tests__/db/migracion-0214.test.ts`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { Writable } from 'node:stream';
import pino from 'pino';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const entorno = { sinLlave: false };

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: new Proxy(actual.env as Record<string, unknown>, {
      get(target, prop) {
        if (prop === 'FLIT2_ENC_KEY' && entorno.sinLlave) return undefined;
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

const { guardarAcceso, leerSecretoVigente } = await import('../../src/modules/flito-sync/flit2-acceso.service.js');
const { decryptFlit2Secret } = await import('../../src/shared/utils/crypto.js');
const { REDACT_PATHS } = await import('../../src/shared/logger.js');

const BASE = '/api/flito/sync/flit2';
const RUTA = `${BASE}/acceso`;
const TABLA = 'flito_sync_flit2_acceso';
const AHORA = new Date('2026-09-29T15:30:00Z');
const CLIENT_ID = 'flito-sync';
// Contraseña con pinta de secreto de FLIT 2: se comprueba literalmente que no sale por ningún lado.
const SECRETO = 'Fl1t2-s3cr3t0-de-prueba-9c7e2a51d4b8';

const escrituras: { values: Record<string, unknown>[]; set: Record<string, unknown>[] } = { values: [], set: [] };

function espiarEscrituras(): void {
  const insertImpl = kdb.insert.getMockImplementation()!;
  kdb.insert.mockImplementation((tbl: unknown) => {
    const chain = insertImpl(tbl) as Record<string, unknown>;
    const values = chain.values as (v: unknown) => unknown;
    chain.values = (v: Record<string, unknown>) => { escrituras.values.push(v); return values(v); };
    return chain;
  });
  const updateImpl = kdb.update.getMockImplementation()!;
  kdb.update.mockImplementation((tbl: unknown) => {
    const chain = updateImpl(tbl) as Record<string, unknown>;
    const set = chain.set as (v: unknown) => unknown;
    chain.set = (v: Record<string, unknown>) => { escrituras.set.push(v); return set(v); };
    return chain;
  });
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-sync/flit2.routes.js');
  app.use(BASE, router);
  return app;
}

// El limitador del PUT cuenta por usuario (10/min, store en memoria en tests): cada petición usa un
// `sub` distinto salvo que el caso necesite fijarlo, para que los casos no se consuman la cuota.
let siguienteSub = 100;
const auth = async (role: TestRole = 'admin', sub = siguienteSub++) =>
  `Bearer ${await testToken({ sub, username: 'ops@flit.io', role })}`;

/** Fila tal como la devuelve la consulta de metadatos (sin una sola columna del cipher). */
const filaMeta = (over: Record<string, unknown> = {}) => ({
  id: 3, clientId: CLIENT_ID, actualizadoEn: AHORA, rechazadoEn: null, bloqueadoHasta: null,
  autorId: 7, autorNombre: 'Operaciones FLIT', ...over,
});

const META_ESPERADA = {
  configurado: true,
  clientId: CLIENT_ID,
  actualizadoPor: { id: 7, nombre: 'Operaciones FLIT' },
  actualizadoEn: AHORA.toISOString(),
  estado: 'vigente',
  bloqueadoHasta: null,
};

beforeEach(() => {
  kdb.reset();
  espiarEscrituras();
  auditMock.mockClear();
  escrituras.values = [];
  escrituras.set = [];
  entorno.sinLlave = false;
});

describe('AC1 · guardar por primera vez', () => {
  it('cifra la contraseña y responde usuario de servicio, quién y desde cuándo — sin la contraseña', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ clientId: CLIENT_ID, clientSecret: SECRETO });

    expect(r.status).toBe(200);
    expect(r.body).toEqual(META_ESPERADA);
    expect(JSON.stringify(r.body)).not.toContain(SECRETO);
  });

  it('lo que llega a la base es ciphertext que descifra con el AAD de la fila', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);

    await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth('admin', 7))
      .send({ clientId: CLIENT_ID, clientSecret: SECRETO });

    expect(escrituras.values).toHaveLength(1);
    const fila = escrituras.values[0]!;
    const cipher = fila.secretCipher as Buffer;
    expect(Buffer.isBuffer(cipher)).toBe(true);
    expect(cipher.toString('utf8')).not.toContain(SECRETO);
    expect(JSON.stringify(fila)).not.toContain(SECRETO);
    expect((fila.secretIv as Buffer).length).toBe(12);
    expect((fila.secretAuthTag as Buffer).length).toBe(16);
    expect(fila).toMatchObject({ clientId: CLIENT_ID, activo: true, keyVersion: 1, createdBy: 7, updatedBy: 7 });

    const claro = decryptFlit2Secret(
      { cipher, iv: fila.secretIv as Buffer, authTag: fila.secretAuthTag as Buffer, keyVersion: 1 },
      { table: TABLA, column: 'secret_cipher', empresaNit: 'flit2', aadNonce: fila.aadNonce as string },
    );
    expect(claro).toBe(SECRETO);
    // Otro aadNonce (cipher copiado a otra fila) no autentica.
    expect(() => decryptFlit2Secret(
      { cipher, iv: fila.secretIv as Buffer, authTag: fila.secretAuthTag as Buffer, keyVersion: 1 },
      { table: TABLA, column: 'secret_cipher', empresaNit: 'flit2', aadNonce: '00000000-0000-4000-8000-000000000000' },
    )).toThrow();
  });

  it('la contraseña se guarda tal cual (sin trim); el usuario de servicio sí se recorta', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);
    await guardarAcceso(CLIENT_ID, ' con espacios ', 7);
    const fila = escrituras.values[0]!;
    expect(decryptFlit2Secret(
      { cipher: fila.secretCipher as Buffer, iv: fila.secretIv as Buffer, authTag: fila.secretAuthTag as Buffer, keyVersion: 1 },
      { table: TABLA, column: 'secret_cipher', empresaNit: 'flit2', aadNonce: fila.aadNonce as string },
    )).toBe(' con espacios ');

    kdb.reset(); espiarEscrituras(); escrituras.values = [];
    kdb.when.insert(TABLA, [{ id: 4 }]).select(TABLA, [filaMeta({ id: 4 })]);
    await request(await buildApp()).put(RUTA).set('Authorization', await auth())
      .send({ clientId: `  ${CLIENT_ID}  `, clientSecret: SECRETO });
    expect(escrituras.values[0]!.clientId).toBe(CLIENT_ID);
  });
});

describe('AC2 · consultar', () => {
  it('responde usuario, quién y desde cuándo; ningún fragmento de la contraseña', async () => {
    kdb.when.select(TABLA, [filaMeta()]);

    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(r.body).toEqual(META_ESPERADA);
    expect(Object.keys(r.body).some((k) => /secret|cipher|password/i.test(k))).toBe(false);
  });

  it('la consulta de metadatos no selecciona columnas del cipher (exclusión a nivel de query)', async () => {
    kdb.when.select(TABLA, [filaMeta()]);
    await request(await buildApp()).get(RUTA).set('Authorization', await auth());

    const proyeccion = kdb.select.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(proyeccion).toBeDefined();
    expect(Object.keys(proyeccion!).sort()).toEqual(
      ['actualizadoEn', 'autorId', 'autorNombre', 'bloqueadoHasta', 'clientId', 'id', 'rechazadoEn'],
    );
  });

  it('refleja las marcas del pase: rechazado, y bloqueado solo mientras el bloqueo no vence', async () => {
    const futuro = new Date(Date.now() + 10 * 60_000);
    kdb.when.select(TABLA, [filaMeta({ bloqueadoHasta: futuro })]);
    const b = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(b.body).toMatchObject({ estado: 'bloqueado', bloqueadoHasta: futuro.toISOString() });

    kdb.reset(); espiarEscrituras();
    kdb.when.select(TABLA, [filaMeta({ bloqueadoHasta: new Date(Date.now() - 60_000) })]);
    const v = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(v.body).toMatchObject({ estado: 'vigente', bloqueadoHasta: null });

    kdb.reset(); espiarEscrituras();
    kdb.when.select(TABLA, [filaMeta({ rechazadoEn: AHORA })]);
    const rz = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(rz.body).toMatchObject({ estado: 'rechazado' });
  });

  it('funciona sin FLIT2_ENC_KEY: mirar no descifra', async () => {
    entorno.sinLlave = true;
    kdb.when.select(TABLA, [filaMeta()]);
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual(META_ESPERADA);
  });
});

describe('AC3 · sin acceso configurado', () => {
  it('200 con configurado:false y el resto en null — no es un error', async () => {
    kdb.when.select(TABLA, []);
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      configurado: false, clientId: null, actualizadoPor: null, actualizadoEn: null, estado: null, bloqueadoHasta: null,
    });
  });
});

describe('AC4 · reemplazar', () => {
  it('desactiva la vigente e inserta la nueva en UNA transacción (el anterior queda como rastro)', async () => {
    kdb.when.insert(TABLA, [{ id: 4 }]).select(TABLA, [filaMeta({ id: 4, clientId: 'flito-sync-2' })]);

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth('admin', 7))
      .send({ clientId: 'flito-sync-2', clientSecret: 'otra-contrasena' });

    expect(r.status).toBe(200);
    expect(r.body.clientId).toBe('flito-sync-2');
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    // Un UPDATE que desactiva (no borra ni pisa el cipher) + un INSERT activo.
    expect(escrituras.set).toEqual([expect.objectContaining({ activo: false, updatedBy: 7 })]);
    expect(Object.keys(escrituras.set[0]!).some((k) => /secret/i.test(k))).toBe(false);
    expect(kdb.delete).not.toHaveBeenCalled();
    expect(escrituras.values).toHaveLength(1);
    expect(escrituras.values[0]).toMatchObject({ activo: true, clientId: 'flito-sync-2' });
  });

  it('dos reemplazos simultáneos → 409 (23505 envuelto por Drizzle), sin auditoría', async () => {
    kdb.when.insert(TABLA, () => {
      const original = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      original.code = '23505';
      throw new Error('Failed query: insert into …', { cause: original });
    });

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ clientId: CLIENT_ID, clientSecret: SECRETO });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('acceso_rotacion_concurrente');
    expect(JSON.stringify(r.body)).not.toContain(SECRETO);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('AC5 · datos vacíos', () => {
  it.each([
    ['cuerpo vacío', {}, ['Falta el usuario de servicio (clientId).', 'Falta la contraseña del usuario de servicio (clientSecret).']],
    ['sin contraseña', { clientId: CLIENT_ID }, ['Falta la contraseña del usuario de servicio (clientSecret).']],
    ['contraseña en blanco', { clientId: CLIENT_ID, clientSecret: '   ' }, ['Falta la contraseña del usuario de servicio (clientSecret).']],
    ['usuario vacío', { clientId: '', clientSecret: SECRETO }, ['Falta el usuario de servicio (clientId).']],
    ['usuario en blanco', { clientId: '   ', clientSecret: SECRETO }, ['Falta el usuario de servicio (clientId).']],
    ['contraseña que no es cadena', { clientId: CLIENT_ID, clientSecret: 12345 }, ['Falta la contraseña del usuario de servicio (clientSecret).']],
  ])('%s → 400 que dice qué falta, sin tocar la base', async (_caso, body, faltantes) => {
    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send(body);

    expect(r.status).toBe(400);
    expect(r.body.faltantes).toEqual(faltantes);
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('el 400 no repite lo enviado (ni la contraseña larga ni un campo de más)', async () => {
    const largo = `${SECRETO}${'x'.repeat(600)}`;
    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ clientId: CLIENT_ID, clientSecret: largo, otro: 'valor-eco-123' });

    expect(r.status).toBe(400);
    const cuerpo = JSON.stringify(r.body);
    expect(cuerpo).not.toContain(SECRETO);
    expect(cuerpo).not.toContain('valor-eco-123');
    expect(cuerpo).not.toContain(CLIENT_ID);
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

describe('AC6 · permisos', () => {
  it('GET y PUT sin Authorization → 401, sin escribir', async () => {
    const app = await buildApp();
    expect((await request(app).get(RUTA)).status).toBe(401);
    expect((await request(app).put(RUTA).send({ clientId: CLIENT_ID, clientSecret: SECRETO })).status).toBe(401);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['auditor', 'compliance', 'gestor_impuestos'])('rol %s sin «ver» → 403 al consultar', async (rol) => {
    kdb.when.select(TABLA, [filaMeta()]);
    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth(rol));
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain(CLIENT_ID);
  });

  it.each<TestRole>(['auditor', 'compliance', 'gestor_impuestos'])('rol %s sin «guardar» → 403 y nada cambia', async (rol) => {
    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth(rol))
      .send({ clientId: CLIENT_ID, clientSecret: SECRETO });
    expect(r.status).toBe(403);
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('limitador del PUT', () => {
  it('11.ª actualización del mismo usuario en un minuto → 429, sin escribir', async () => {
    const app = await buildApp();
    const token = await auth('admin', 999);
    for (let i = 0; i < 10; i++) {
      kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);
      const ok = await request(app).put(RUTA).set('Authorization', token).send({ clientId: CLIENT_ID, clientSecret: SECRETO });
      expect(ok.status).toBe(200);
    }
    kdb.insert.mockClear();
    const r = await request(app).put(RUTA).set('Authorization', token).send({ clientId: CLIENT_ID, clientSecret: SECRETO });
    expect(r.status).toBe(429);
    expect(JSON.stringify(r.body)).not.toContain(SECRETO);
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

describe('AC8 · auditoría', () => {
  it('queda quién (req) y qué fila, con el usuario de servicio y sin la contraseña', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);

    await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth('admin', 7))
      .send({ clientId: CLIENT_ID, clientSecret: SECRETO });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [req, entrada] = auditMock.mock.calls[0] as [{ user?: { sub: number } }, Record<string, string>];
    expect(req.user?.sub).toBe(7);
    expect(entrada).toMatchObject({ action: 'update', resource: 'flit2_acceso', resourceId: '3' });
    expect(entrada.detail).toContain('flit2.acceso.guardar');
    expect(entrada.detail).toContain(CLIENT_ID);
    expect(JSON.stringify(entrada)).not.toContain(SECRETO);
    expect(JSON.stringify(entrada)).not.toContain(SECRETO.slice(0, 8));
  });
});

describe('AC9 · errores y logs', () => {
  it('sin FLIT2_ENC_KEY el PUT → 503 llave_maestra ANTES de tocar la base; el vigente no cambia', async () => {
    entorno.sinLlave = true;
    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ clientId: CLIENT_ID, clientSecret: SECRETO });

    expect(r.status).toBe(503);
    expect(r.body.codigo).toBe('llave_maestra');
    expect(JSON.stringify(r.body)).not.toContain(SECRETO);
    expect(kdb.transaction).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('leer el secreto sin llave → llave_maestra y NO desactiva la fila (está sana)', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);
    await guardarAcceso(CLIENT_ID, SECRETO, 7);
    const fila = { id: 3, ...escrituras.values[0]! };
    kdb.reset(); espiarEscrituras(); escrituras.set = [];
    kdb.when.select(TABLA, [fila]);

    entorno.sinLlave = true;
    await expect(leerSecretoVigente()).rejects.toMatchObject({ codigo: 'llave_maestra' });
    expect(escrituras.set).toEqual([]);

    entorno.sinLlave = false;
    const leido = await leerSecretoVigente();
    expect(leido.clientId).toBe(CLIENT_ID);
    expect(String(leido.secreto)).not.toContain(SECRETO);
    expect(JSON.stringify(leido)).not.toContain(SECRETO);
    expect(leido.secreto.unwrap()).toBe(SECRETO);
  });

  it('cipher que no autentica → acceso_descifrado y la fila se desactiva con el motivo', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);
    await guardarAcceso(CLIENT_ID, SECRETO, 7);
    const buena = escrituras.values[0]!;
    kdb.reset(); espiarEscrituras(); escrituras.set = [];
    kdb.when.select(TABLA, [{ id: 3, ...buena, aadNonce: '00000000-0000-4000-8000-000000000000' }]);

    await expect(leerSecretoVigente()).rejects.toMatchObject({ codigo: 'acceso_descifrado' });
    expect(escrituras.set).toEqual([expect.objectContaining({ activo: false, descifradoFallidoEn: expect.any(Date) })]);
  });

  it('sin fila vigente → sin_acceso', async () => {
    kdb.when.select(TABLA, []);
    await expect(leerSecretoVigente()).rejects.toMatchObject({ codigo: 'sin_acceso' });
  });

  it('la redacción del logger cubre clientSecret, secret y authorization (raíz y anidados)', () => {
    expect(REDACT_PATHS).toEqual(expect.arrayContaining([
      'clientSecret', 'secret', 'authorization', '*.clientSecret', '*.secret', '*.authorization', '*.headers.authorization',
    ]));
    const lineas: string[] = [];
    const destino = new Writable({ write(chunk, _enc, cb) { lineas.push(String(chunk)); cb(); } });
    const log = pino({ redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } }, destino);

    log.info({ clientSecret: SECRETO, secret: SECRETO, authorization: `Bearer ${SECRETO}` }, 'raíz');
    log.info({ body: { clientSecret: SECRETO }, req: { headers: { authorization: `Bearer ${SECRETO}` } }, x: { secret: SECRETO } }, 'anidado');

    expect(lineas).toHaveLength(2);
    for (const l of lineas) {
      expect(l).not.toContain(SECRETO);
      expect(l).toContain('[REDACTED]');
    }
  });
});
