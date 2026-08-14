// FLITO comparendos — registro de acceso a datos personales (HU #11511, AC3).
//
// Ley 1581 art. 17: el titular puede preguntar quién consultó sus datos y para qué. Hasta esta HU,
// leer comparendos o corridas —que llevan NITs, y un NIT de persona natural es un documento de
// identidad— no dejaba ni una línea en `pii_access_log`.
//
// Lo que se demuestra:
//
//   1. **Leer dispara el registro de acceso**, con quién, qué recurso y qué campos.
//   2. **El motivo no filtra el dato que protege**: un filtro por NIT o por placa va enmascarado.
//      Escribir el NIT dentro del rastro de quién lo miró sería publicar el dato en el registro que
//      existe para protegerlo.
//   3. **Un 404 no registra acceso**: nadie miró los datos de nadie, y registrarlo llenaría el log
//      de accesos que no ocurrieron.
//   4. **El contrato que la HU #11502 va a usar** en `GET /registros` existe y está probado aquí,
//      con `RECURSO_REGISTROS` y los campos del registro consolidado.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

/**
 * `logPiiAccess` se mockea en vez de mirar el INSERT sobre `pii_access_log`.
 *
 * Es el contrato que hay que fijar: lo que el módulo tiene que garantizar es QUÉ le pasa al helper
 * compartido —recurso, acción, campos, motivo—, no cómo ese helper escribe su fila. Que la fila se
 * escriba (y que sea append-only por trigger) es asunto de `shared/pii-audit.ts`.
 */
const logPiiAccessMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({
  logPiiAccess: (...args: unknown[]) => logPiiAccessMock(...args),
}));

const {
  CAMPOS_PII_PAYLOAD,
  CAMPOS_PII_REGISTRO,
  CAMPOS_PII_SYNC_RUN,
  RECURSO_REGISTROS,
  RECURSO_SYNC_RUN,
  registrarAccesoComparendos,
} = await import('../../src/modules/flito-comparendos/flito-comparendos.pii.js');

const BASE = '/api/flito/comparendos';
const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-comparendos/flito-comparendos.routes.js');
  app.use(BASE, router);
  return app;
}

const auth = async (sub = 7) => `Bearer ${await testToken({ sub, username: 'ops@flit.io', role: 'admin' })}`;

/** Lo que el helper recibió en su última llamada. */
const ultimoAcceso = () => logPiiAccessMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;

/** Petición fingida, para ejercer el contrato sin pasar por un endpoint. */
const reqFalso = () => ({ headers: {}, ip: '10.0.0.1', user: { sub: 7, role: 'admin' } }) as never;

beforeEach(() => {
  kdb.reset();
  logPiiAccessMock.mockClear();
});

// ─────────────────────────── El contrato para la HU #11502 ──────────────────────────────────────

describe('registrarAccesoComparendos — el contrato (AC3)', () => {
  it('traduce un listado de registros a un acceso `search` con sus campos y su conteo', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'search',
      campos: [...CAMPOS_PII_REGISTRO],
      filas: 42,
    });

    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: 'flito_comparendos_registro',
      accion: 'search',
      camposAccedidos: ['nit_monitoreado', 'placa'],
    });
    expect(ultimoAcceso().motivo).toContain('filas=42');
  });

  it('**los filtros personales van enmascarados en el motivo**', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'search',
      campos: [...CAMPOS_PII_REGISTRO],
      filtros: { nit: '900123456', placa: 'ABC123', estado: 'activo' },
    });

    const motivo = String(ultimoAcceso().motivo);
    // El NIT y la placa no pueden aparecer en claro: sería escribir el dato protegido dentro del
    // rastro que existe para protegerlo.
    expect(motivo).not.toContain('900123456');
    expect(motivo).not.toContain('ABC123');
    // Pero la CLAVE sí: saber que alguien buscó «por placa» es justo lo que hace útil el registro.
    expect(motivo).toContain('nit=');
    expect(motivo).toContain('placa=');
    expect(motivo).toContain('estado=activo');
  });

  it('no vuelca arrays ni objetos en el motivo: deja constancia de que el filtro se usó', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'export',
      campos: [...CAMPOS_PII_REGISTRO, ...CAMPOS_PII_PAYLOAD],
      filtros: { nits: ['900123456', '800999888'] },
    });

    const motivo = String(ultimoAcceso().motivo);
    expect(motivo).not.toContain('900123456');
    expect(motivo).toContain('nits=');
    // Y los payloads se listan aparte de las columnas del canónico: es lo que permite responder
    // «¿alguien ha mirado los payloads?» sin leer el código de cada endpoint.
    expect(ultimoAcceso().camposAccedidos)
      .toEqual(['nit_monitoreado', 'placa', 'payload_simit', 'payload_municipal']);
  });

  it('el motivo nunca desborda el `varchar(200)` de la columna', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'search',
      campos: [...CAMPOS_PII_REGISTRO],
      filtros: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`campo${i}`, `valor-${i}`])),
    });

    // Pasarse sería un 22001 de PostgreSQL: el rastro se perdería justo en la lectura más ruidosa.
    expect(String(ultimoAcceso().motivo).length).toBeLessThanOrEqual(200);
  });

  it('el UUID viaja en el motivo porque `resource_id` es `integer` y no le cabe', async () => {
    await registrarAccesoComparendos(reqFalso(), {
      recurso: RECURSO_REGISTROS,
      accion: 'read',
      campos: [...CAMPOS_PII_REGISTRO],
      referencia: RUN_ID,
    });

    // Inventarse un número sería peor que no poner nada: apuntaría a otro recurso.
    expect(ultimoAcceso().resourceId).toBeNull();
    expect(String(ultimoAcceso().motivo)).toContain(RUN_ID);
  });
});

// ─────────────────────────── Las lecturas que existen hoy ───────────────────────────────────────

describe('GET /sync/runs — la lectura deja rastro (AC3)', () => {
  it('el listado registra un acceso `search` con cuántas corridas se entregaron', async () => {
    kdb.when.select('flito_comparendos_sync_runs', [
      { id: RUN_ID, estado: 'completed', scopeNits: ['900123456'], resumen: null,
        iniciadoPor: 7, iniciadoEn: new Date(), finalizadoEn: new Date() },
    ]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs`).set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(logPiiAccessMock).toHaveBeenCalledTimes(1);
    expect(ultimoAcceso()).toMatchObject({
      resourceTipo: RECURSO_SYNC_RUN,
      accion: 'search',
      camposAccedidos: [...CAMPOS_PII_SYNC_RUN],
    });
    expect(String(ultimoAcceso().motivo)).toContain('filas=1');
  });

  it('el detalle registra un acceso `read` con el id de la corrida', async () => {
    kdb.when
      .select('flito_comparendos_sync_runs', [
        { id: RUN_ID, estado: 'completed', scopeNits: ['900123456'], resumen: null,
          iniciadoPor: 7, iniciadoEn: new Date(), finalizadoEn: new Date() },
      ])
      .select('flito_comparendos_sync_steps', [
        { nit: '900123456', fuente: 'simit', ok: true, httpStatus: 200, errorCode: null,
          mensaje: null, itemsLeidos: 3, duracionMs: 120 },
      ]);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs/${RUN_ID}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(200);
    expect(ultimoAcceso()).toMatchObject({ resourceTipo: RECURSO_SYNC_RUN, accion: 'read' });
    expect(String(ultimoAcceso().motivo)).toContain(RUN_ID);
    // El NIT del paso viaja en la respuesta, así que el acceso lo declara entre sus campos.
    expect(ultimoAcceso().camposAccedidos).toContain('nit');
  });

  it('**una corrida que no existe NO registra acceso**', async () => {
    kdb.when.select('flito_comparendos_sync_runs', []);

    const r = await request(await buildApp()).get(`${BASE}/sync/runs/${RUN_ID}`)
      .set('Authorization', await auth());

    expect(r.status).toBe(404);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });

  it('sin autenticar tampoco: el guard corre antes que la lectura', async () => {
    const r = await request(await buildApp()).get(`${BASE}/sync/runs`);

    expect(r.status).toBe(401);
    expect(logPiiAccessMock).not.toHaveBeenCalled();
  });
});
