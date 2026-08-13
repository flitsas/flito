// FLITO comparendos — token SIMIT (HU #11498, Feature #11492 17a, ADR-0002).
//
// Lo que se demuestra aquí es que el token entra UNA vez y no vuelve a salir: el `PUT` cifra y
// responde metadatos, el `GET` responde metadatos, y en ninguno de los dos aparece el valor —ni
// entero, ni recortado, ni dentro del detalle de un error de validación—. Además, que rotar el
// token desactiva el anterior en vez de pisarlo (RN-07: el historial de «quién y cuándo» es
// justamente lo que pide CF-03) y que el descifrado que no autentica desactiva la fila (RN-10).
//
// La llave maestra real de los tests (`COMPARENDOS_ENC_KEY` de `setup.ts`) se usa de verdad: el
// cifrado NO está mockeado. Eso permite la prueba que más vale de todas —guardar y volver a leer,
// comprobando que lo que se persistió no es el plaintext y que descifra al mismo valor—. El caso
// contrario, el de la llave AUSENTE, vive en `flito-comparendos-token.llave.test.ts`, porque `env`
// es una foto tomada en el import y hay que mockear el módulo entero para quitarla.
//
// Drizzle está mockeado por NOMBRE DE TABLA (`keyed-db`), como en los catálogos, y encima se
// envuelven `values()` y `set()` para poder mirar QUÉ se escribe: sin eso, «cifra antes de guardar»
// no sería comprobable, solo declarable.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

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

const { guardarTokenSimit, obtenerTokenSimit } =
  await import('../../src/modules/flito-comparendos/flito-comparendos.token.service.js');
// El módulo real, para poder poner `NODE_ENV=production` en el caso del bootstrap: el servicio lee
// `env` en cada llamada, así que basta con mutar el objeto y restaurarlo.
const { env } = await import('../../src/config/env.js');
const { esViolacionDeUnicidad } =
  await import('../../src/modules/flito-comparendos/flito-comparendos.errors.js');

const BASE = '/api/flito/comparendos';
const RUTA = `${BASE}/config/token-simit`;
const TABLA = 'flito_comparendos_token_simit';
const AHORA = new Date('2026-08-13T15:30:00Z');

// Un token con la pinta de los de Verifik: largo, opaco y con partes separadas por punto. Se
// comprueba literalmente que esta cadena no aparece en ninguna respuesta.
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.c2ltaXQtdG9rZW4tZGUtcHJ1ZWJhLTEyMzQ1Njc4OTA.firma-de-prueba';

/** Payloads capturados de `insert(...).values(...)` y `update(...).set(...)` por tabla. */
const escrituras: { values: Record<string, unknown>[]; set: Record<string, unknown>[] } = { values: [], set: [] };

/**
 * Envuelve los chains de mutación de `keyed-db` para quedarse con lo que se les pasa.
 *
 * `keyed-db` decide QUÉ devuelve cada query pero descarta los argumentos, y aquí el argumento es la
 * prueba: que `tokenCipher` sea un Buffer que no contiene el plaintext, y que la rotación mande
 * `activo: false` a la fila anterior.
 */
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
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (role: TestRole = 'admin', sub = 7) =>
  `Bearer ${await testToken({ sub, username: 'ops@flit.io', role })}`;

/** Fila tal como la devuelve la consulta de metadatos (sin una sola columna del cipher). */
const filaMeta = (over: Record<string, unknown> = {}) => ({
  id: 3, keyVersion: 1, actualizadoEn: AHORA, autorId: 7, autorNombre: 'Operaciones FLIT', ...over,
});

beforeEach(() => {
  kdb.reset();
  espiarEscrituras();
  auditMock.mockClear();
  escrituras.values = [];
  escrituras.set = [];
});

// ─────────────────────────── Guardas de acceso ──────────────────────────────────────────────────

describe('token SIMIT — quién puede tocarlo', () => {
  it('GET sin Authorization → 401', async () => {
    const r = await request(await buildApp()).get(RUTA);
    expect(r.status).toBe(401);
  });

  it('PUT sin Authorization → 401 y no cifra ni escribe nada', async () => {
    const r = await request(await buildApp()).put(RUTA).send({ token: TOKEN });
    expect(r.status).toBe(401);
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it.each<TestRole>(['auditor', 'compliance', 'gestor_impuestos'])(
    'PUT con rol %s → 403: el token es de administración', async (rol) => {
      const r = await request(await buildApp()).put(RUTA)
        .set('Authorization', await auth(rol))
        .send({ token: TOKEN });

      expect(r.status).toBe(403);
      expect(kdb.insert).not.toHaveBeenCalled();
    },
  );
});

// ─────────────────────────── AC1 · PUT cifra y no devuelve el token ─────────────────────────────

describe('token SIMIT — PUT (AC1)', () => {
  it('cifra el token y responde SOLO metadatos', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    expect(r.status).toBe(200);
    // La respuesta es exactamente el contrato `ComparendosTokenSimitMeta`: cuatro claves, ninguna
    // de ellas el token. Comparar el objeto completo —y no campo a campo— es lo que detecta el día
    // que alguien añada un `token` «solo para depurar».
    expect(r.body).toEqual({
      configurado: true,
      actualizadoEn: AHORA.toISOString(),
      actualizadoPor: { id: 7, nombre: 'Operaciones FLIT' },
      keyVersion: 1,
    });
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it('lo que llega a la base es ciphertext: ni el token ni un fragmento suyo', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);

    await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    expect(escrituras.values).toHaveLength(1);
    const fila = escrituras.values[0] as Record<string, Buffer | number | boolean | string | null>;
    const cipher = fila.tokenCipher as Buffer;

    expect(Buffer.isBuffer(cipher)).toBe(true);
    expect(cipher.toString('utf8')).not.toContain(TOKEN);
    // Ni siquiera el principio: AES-GCM es un cifrado de flujo, así que un cipher que empezara por
    // el mismo prefijo delataría que se guardó en claro por algún camino.
    expect(cipher.toString('utf8').slice(0, 16)).not.toBe(TOKEN.slice(0, 16));
    // IV de 12 bytes y auth tag de 16: los tamaños que exige AES-256-GCM. Si alguno viniera vacío,
    // el descifrado fallaría más tarde y en otro sitio.
    expect((fila.tokenIv as Buffer).length).toBe(12);
    expect((fila.tokenAuthTag as Buffer).length).toBe(16);
    expect(fila.aadNonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(fila.keyVersion).toBe(1);
    expect(fila.activo).toBe(true);
    // Trazabilidad de la actualización (AC3): quién la hizo queda en la propia fila.
    expect(fila.createdBy).toBe(7);
    expect(fila.updatedBy).toBe(7);
  });

  it('rotar desactiva la fila anterior en vez de pisarla (RN-07: una sola activa)', async () => {
    kdb.when.insert(TABLA, [{ id: 4 }]).select(TABLA, [filaMeta({ id: 4 })]);

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: 'otro-token-rotado' });

    expect(r.status).toBe(200);
    // Un UPDATE del cipher habría dejado «quién y cuándo» solo del último cambio. El flujo correcto
    // son dos escrituras: desactivar la activa e insertar la nueva, ambas en la misma transacción.
    expect(kdb.transaction).toHaveBeenCalledTimes(1);
    expect(escrituras.set).toHaveLength(1);
    expect(escrituras.set[0]).toMatchObject({ activo: false, updatedBy: 7 });
    expect(escrituras.values).toHaveLength(1);
    expect(escrituras.values[0]).toMatchObject({ activo: true });
  });

  it('deja auditoría con el recurso del AC y sin material de la credencial en el detalle', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);

    await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0][1] as { resource: string; action: string; detail: string; resourceId: string };
    expect(entrada).toMatchObject({ action: 'update', resource: 'flito_comparendos_token', resourceId: '3' });
    // `audit_logs` se consulta y se exporta: un prefijo del token ahí sería una filtración con
    // retención larga.
    expect(entrada.detail).not.toContain(TOKEN);
    expect(entrada.detail).not.toContain(TOKEN.slice(0, 8));
  });

  it('dos rotaciones simultáneas → 409, no un 500', async () => {
    // La segunda petición desactiva una fila que la otra transacción ya apagó, inserta y choca
    // contra `uq_flito_comparendos_token_activo`. El índice está justamente para ganar esa carrera:
    // lo que no puede es salir como error interno.
    kdb.when.insert(TABLA, () => {
      const e = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      e.code = '23505';
      throw e;
    });

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: TOKEN });

    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('token_rotacion_concurrente');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('el detector de unicidad reconoce el 23505 ENVUELTO, que es como llega de verdad', () => {
    // El test de arriba lanza el error de PostgreSQL en crudo, y justo por eso no detectaba nada:
    // desde la 0.44 drizzle envuelve toda excepción de query en `DrizzleQueryError` y deja la
    // original en `cause` (verificado sobre la 0.45.2 instalada, `pg-core/session.cjs` líneas 66 y
    // siguientes). Mirando solo el nivel superior, `code` es undefined y el 409 salía como 500 en
    // producción mientras el mock pasaba en verde.
    const original = new Error('duplicate key value violates unique constraint') as Error & { code: string };
    original.code = '23505';

    expect(esViolacionDeUnicidad(original)).toBe(true);
    expect(esViolacionDeUnicidad(new Error('Failed query: insert into ...', { cause: original }))).toBe(true);
    expect(esViolacionDeUnicidad(new Error('otra cosa'))).toBe(false);
    // Una cadena cíclica no debe colgar el proceso.
    const ciclo = new Error('a') as Error & { cause?: unknown };
    ciclo.cause = ciclo;
    expect(esViolacionDeUnicidad(ciclo)).toBe(false);
  });

  it.each([
    ['cuerpo vacío', {}],
    ['token vacío', { token: '' }],
    ['token que no es cadena', { token: 12345 }],
    ['token de más de 2048 caracteres', { token: 'a'.repeat(2049) }],
  ])('PUT con %s → 400 y sin tocar la base', async (_caso, body) => {
    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send(body);

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Datos inválidos');
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(kdb.transaction).not.toHaveBeenCalled();
  });

  it('el 400 de validación no devuelve el valor rechazado', async () => {
    const largo = `${TOKEN}${'x'.repeat(2048)}`;

    const r = await request(await buildApp()).put(RUTA)
      .set('Authorization', await auth())
      .send({ token: largo });

    // `flatten()` trae los mensajes de las reglas, no el input. Si algún día alguien cambiara el
    // handler por uno que eche el cuerpo entero al detalle, el token viajaría de vuelta al cliente
    // y quedaría en cualquier log de acceso que registre respuestas.
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN.slice(0, 20));
  });
});

// ─────────────────────────── AC1 · GET solo metadatos ───────────────────────────────────────────

describe('token SIMIT — GET (AC1)', () => {
  it('con token configurado devuelve quién y cuándo, nunca el valor', async () => {
    kdb.when.select(TABLA, [filaMeta()]);

    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['actualizadoEn', 'actualizadoPor', 'configurado', 'keyVersion']);
    expect(r.body).toEqual({
      configurado: true,
      actualizadoEn: AHORA.toISOString(),
      actualizadoPor: { id: 7, nombre: 'Operaciones FLIT' },
      keyVersion: 1,
    });
  });

  it('sin fila activa responde «no configurado», no un 404', async () => {
    kdb.when.select(TABLA, []);

    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());

    // No haber configurado el token todavía es un estado normal de la pantalla de configuración,
    // no un recurso ausente: un 404 obligaría a la UI a tratar el caso corriente como un error.
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      configurado: false, actualizadoEn: null, actualizadoPor: null, keyVersion: null,
    });
  });

  it('con token sin autor conocido sigue diciendo que está configurado', async () => {
    kdb.when.select(TABLA, [filaMeta({ autorId: null, autorNombre: null })]);

    const r = await request(await buildApp()).get(RUTA).set('Authorization', await auth());

    // El `leftJoin` es lo que sostiene esto: con un join interno la fila desaparecería y el API
    // respondería «no configurado» teniendo token, que es el peor de los dos errores posibles.
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configurado: true, actualizadoPor: null });
  });
});

// ─────────────────────────── AC3 · Redaction y uso interno ──────────────────────────────────────

describe('token SIMIT — lectura para uso (HUs #11499/#11500)', () => {
  it('guardar y volver a leer devuelve el mismo token, envuelto en Redacted', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);
    await guardarTokenSimit(TOKEN, 7);

    // La fila que se acaba de escribir se le devuelve al lector tal cual: mismo cipher, mismo IV,
    // mismo `aadNonce`. Si el AAD del cifrado y el del descifrado no coincidieran, GCM lo rechazaría
    // y esto fallaría — que es precisamente lo que se quiere vigilar.
    const escrita = escrituras.values[0] as Record<string, unknown>;
    kdb.reset();
    espiarEscrituras();
    kdb.when.select(TABLA, [{
      id: 3, tokenCipher: escrita.tokenCipher, tokenIv: escrita.tokenIv,
      tokenAuthTag: escrita.tokenAuthTag, aadNonce: escrita.aadNonce, keyVersion: escrita.keyVersion,
      activo: true, descifradoFallidoEn: null, descifradoFallidoMotivo: null,
      createdAt: AHORA, createdBy: 7, updatedAt: AHORA, updatedBy: 7,
    }]);

    const token = await obtenerTokenSimit();

    expect(token.unwrap()).toBe(TOKEN);
    // Lo que protege de la filtración accidental: serializar o imprimir el envoltorio no revela nada.
    expect(JSON.stringify({ token })).toBe('{"token":"[REDACTED]"}');
    expect(String(token)).toBe('[REDACTED]');
  });

  it('sin fila activa ni bootstrap de entorno → token_no_configurado (503)', async () => {
    kdb.when.select(TABLA, []);

    await expect(obtenerTokenSimit()).rejects.toMatchObject({
      codigo: 'token_no_configurado', status: 503,
    });
  });

  it('en producción el bootstrap de entorno NO aplica, aunque la variable esté puesta', async () => {
    // Llamarlo «de desarrollo» no lo impedía. Y el escenario lo abre la propia RN-10: si un
    // descifrado falla la fila se apaga, y desde ese momento no hay fila activa. Con la variable
    // puesta en PDN, el sync seguiría operando con un token sin autor ni fecha mientras el GET
    // responde `configurado: false` — runtime y pantalla divergiendo en lo que CF-03 vigila.
    kdb.when.select(TABLA, []);
    const previo = env.NODE_ENV;
    const previoToken = env.VERIFIK_SIMIT_TOKEN;
    (env as { NODE_ENV: string }).NODE_ENV = 'production';
    (env as { VERIFIK_SIMIT_TOKEN?: string }).VERIFIK_SIMIT_TOKEN = 'token-de-entorno-en-pdn';

    try {
      await expect(obtenerTokenSimit()).rejects.toMatchObject({
        codigo: 'token_no_configurado', status: 503,
      });
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = previo;
      (env as { VERIFIK_SIMIT_TOKEN?: string }).VERIFIK_SIMIT_TOKEN = previoToken;
    }
  });

  it('un cipher que no autentica desactiva la fila y deja el motivo escrito (RN-10)', async () => {
    kdb.when.select(TABLA, [{
      id: 3,
      tokenCipher: Buffer.from('basura-que-no-descifra'),
      tokenIv: Buffer.alloc(12, 1),
      tokenAuthTag: Buffer.alloc(16, 2),
      aadNonce: '11111111-1111-1111-1111-111111111111',
      keyVersion: 1, activo: true,
      descifradoFallidoEn: null, descifradoFallidoMotivo: null,
      createdAt: AHORA, createdBy: 7, updatedAt: AHORA, updatedBy: 7,
    }]);

    await expect(obtenerTokenSimit()).rejects.toMatchObject({
      codigo: 'token_descifrado', status: 503,
    });

    // Reintentar en cada corrida del sync un ciphertext que no autentica solo produce ruido: la
    // fila se apaga y el motivo queda en la propia tabla, no solo en un log que se rota.
    expect(escrituras.set).toHaveLength(1);
    const marca = escrituras.set[0] as { activo: boolean; descifradoFallidoMotivo: string };
    expect(marca.activo).toBe(false);
    expect(marca.descifradoFallidoMotivo).toBeTruthy();
    expect(marca.descifradoFallidoMotivo.length).toBeLessThanOrEqual(200);
  });
});

// ─────────────────────────── AC1 · Limitador del PUT ────────────────────────────────────────────

describe('token SIMIT — rateLimiter del PUT', () => {
  it('corta la ráfaga con 429 en vez de seguir cifrando y escribiendo', async () => {
    kdb.when.insert(TABLA, [{ id: 3 }]).select(TABLA, [filaMeta()]);
    const app = await buildApp();
    // Usuario propio: el limitador cuenta por `sub`, así que este caso no le gasta cuota a los
    // demás tests del archivo ni depende de en qué orden corran.
    const cabecera = await auth('admin', 4242);

    let ultimo = 0;
    for (let i = 0; i < 11; i++) {
      const r = await request(app).put(RUTA).set('Authorization', cabecera).send({ token: TOKEN });
      ultimo = r.status;
    }

    // Solo se afirma sobre la última: si Vitest reintenta el test (retry: 1), el contador ya viene
    // gastado y las primeras responderían 429 también. Lo que importa es que el corte exista.
    expect(ultimo).toBe(429);
  });
});
