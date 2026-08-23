import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { CLIENTS_COLUMNAS_PII, CLIENTS_COLUMNAS_SIN_PII } from '@operaciones/shared-types';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    transaction: transactionMock,
    execute: executeMock,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: auditMock,
}));

const deletePhotoMock = vi.fn();
vi.mock('../../src/services/storage.js', () => ({
  deletePhoto: deletePhotoMock,
}));

/**
 * Con qué direcciones se llamó a cada purga del módulo Siigo.
 *
 * Las funciones REALES siguen ejecutándose contra la transacción falsa —esto envuelve, no
 * sustituye—: lo que se añade es poder ver el argumento. Sin él, la rama «por dirección» del olvido
 * solo se puede afirmar mirando el resumen de la respuesta, que es el número que devuelve el mock
 * del UPDATE y no dice NADA sobre qué se buscó.
 */
const correosPasadosAActas: string[][] = [];
const correosPasadosALotes: string[][] = [];

vi.mock('../../src/modules/siigo/siigo.envio-correo.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.envio-correo.service.js')>();
  return {
    ...real,
    purgarDestinatariosDeClientes: (companias: number[], correos: string[] = [], ejecutor?: never) => {
      correosPasadosAActas.push([...correos]);
      return real.purgarDestinatariosDeClientes(companias, correos, ejecutor);
    },
  };
});

vi.mock('../../src/modules/siigo/facturacion.lote.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/facturacion.lote.repo.js')>();
  return {
    ...real,
    purgarDestinatariosDeLotes: (companias: number[], correos: string[] = [], ejecutor?: never) => {
      correosPasadosALotes.push([...correos]);
      return real.purgarDestinatariosDeLotes(companias, correos, ejecutor);
    },
  };
});

vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  correosPasadosAActas.length = 0;
  correosPasadosALotes.length = 0;
  selectMock.mockReset();
  transactionMock.mockReset();
  executeMock.mockReset().mockResolvedValue([{ '?column?': 1 }]);
  deletePhotoMock.mockReset().mockResolvedValue(undefined);
  auditMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/privacy/privacy.routes.js');
  app.use('/api/privacy', router);
  return app;
}

// Helper: mock tx que satisface todos los updates de la transaction (14 + 1 select + 1 execute)
function buildTxMock(opts: {
  driverHits?: number; // filas devueltas por driver_profile update (afecta también alcohol/incidents)
  perTableHits?: Record<string, number>;
} = {}) {
  const driverHits = opts.driverHits ?? 0;
  const hits = (table: string) => opts.perTableHits?.[table] ?? 1;

  return async (cb: any) => {
    const tx = {
      select: vi.fn(() => chain([{ id: 1 }])), // affectedVehicles para soat_requests
      execute: vi.fn().mockResolvedValue([{ id: 1 }]), // tramites_digitales jsonb update
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve(
              // Devuelve N filas según tabla (heurística: usa el mismo número para todas)
              Array.from({ length: hits('default') }, (_, i) => ({ id: i + 1, userId: i + 1 })),
            ),
          }),
        }),
      })),
    };
    return cb(tx);
  };
}

/**
 * Transacción falsa que sabe de TABLAS y de ORDEN (HU #11708).
 *
 * `buildTxMock` responde lo mismo a todo el mundo, y por eso la rama del olvido que busca POR
 * DIRECCIÓN nunca se ejercitaba: el `SELECT` de las direcciones del titular devolvía `{ id: 1 }`
 * —una fila sin `email` ni `contactEmail`—, así que `correosDelTitular` salía vacío y las dos purgas
 * degradaban a solo-compañía sin que ningún test lo notara.
 *
 * Esta versión añade las dos cosas que hacen falta para que el orden IMPORTE:
 *
 *   1. Enruta por nombre de tabla, de modo que el `SELECT` sobre `clients` puede devolver una ficha
 *      con direcciones de verdad.
 *   2. **Recuerda que `clients` ya se anonimizó.** En producción, el `UPDATE` del paso 1 escribe
 *      `document = docHash` (que empieza por `ANON-`), y `matchByDoc` compara contra el documento
 *      CRUDO y excluye explícitamente `NOT LIKE 'ANON-%'`. O sea: después de ese UPDATE, ese mismo
 *      `SELECT` devuelve cero filas. Sin simularlo, mover la captura de las direcciones a después
 *      del UPDATE seguía verde aquí y degradaba en silencio allá.
 */
function buildTxPorTabla(opts: {
  /** Lo que `SELECT email, contact_email FROM clients WHERE <doc del titular>` devuelve. */
  fichaDelTitular?: Array<{ email: string | null; contactEmail: string | null }>;
  /** Filas que devuelve el SELECT de cada tabla. Por omisión, una. */
  filasPorTabla?: Record<string, number>;
} = {}) {
  const ficha = opts.fichaDelTitular ?? [];

  return async (cb: any) => {
    const { getTableName } = await import('drizzle-orm');
    const nombre = (t: unknown): string => {
      try { return getTableName(t as never); } catch { return '__expr__'; }
    };
    // El estado que hace que el ORDEN se note: en cuanto `clients` queda anonimizada, el documento
    // del titular ya no existe en su forma cruda y ningún `matchByDoc` vuelve a encontrarla.
    let clientsAnonimizada = false;

    /** Filas afectadas por un UPDATE. Llevan `id` porque quien llama las usa como llave. */
    const filasAfectadas = (tabla: string): unknown[] => {
      const n = opts.filasPorTabla?.[tabla] ?? 1;
      return Array.from({ length: n }, (_, i) => ({ id: i + 1, userId: i + 1 }));
    };

    /** Filas que devuelve un SELECT. Solo `clients` depende de si ya se anonimizó. */
    const filasLeidas = (tabla: string): unknown[] => {
      if (tabla === 'clients') return clientsAnonimizada ? [] : ficha;
      return filasAfectadas(tabla);
    };

    const tx = {
      select: vi.fn(() => {
        let tabla = '__sin_from__';
        const c: any = {};
        for (const m of ['where', 'leftJoin', 'innerJoin', 'limit', 'offset', 'orderBy', 'groupBy']) {
          c[m] = () => c;
        }
        c.from = (t: unknown) => { tabla = nombre(t); return c; };
        c.then = (res: any, rej: any) => Promise.resolve().then(() => filasLeidas(tabla)).then(res, rej);
        return c;
      }),
      execute: vi.fn().mockResolvedValue([{ id: 1 }]),
      update: vi.fn((t: unknown) => {
        const tabla = nombre(t);
        const c: any = {};
        c.set = () => c;
        c.where = () => c;
        c.returning = () => {
          // El UPDATE sí devuelve las filas que tocó —con su `id`, que es lo que la ruta usa como
          // lista de compañías—; lo que cambia es que a partir de aquí ningún `matchByDoc` vuelve a
          // encontrarlas. Ese matiz es el que hace que la rama por compañía siga funcionando cuando
          // la captura se mueve: por eso el resumen NO delata el fallo y hacen falta los otros casos.
          if (tabla === 'clients') clientsAnonimizada = true;
          return Promise.resolve(filasAfectadas(tabla));
        };
        return c;
      }),
    };
    return cb(tx);
  };
}

describe('privacy — auth & roles', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').send({ docNumber: '123', reason: 'derecho al olvido' });
    expect(r.status).toBe(401);
  });

  it('proveedor → 403 (requireRole admin|compliance)', async () => {
    const token = await testToken({ sub: 1, role: 'proveedor' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/123').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });

  it('compliance puede preview (200) pero NO forget (403 — segregation of duties)', async () => {
    // Preview con compliance: requiere mocks de todos los counts
    selectMock.mockImplementation(() => chain([{ c: 0 }]));
    const token = await testToken({ sub: 1, role: 'compliance' });
    const app = await buildApp();

    const rPreview = await request(app).get('/api/privacy/preview/123456').set('Authorization', `Bearer ${token}`);
    expect(rPreview.status).toBe(200);

    const rForget = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '123456', reason: 'derecho al olvido formal' });
    expect(rForget.status).toBe(403);
  });
});

describe('POST /forget — validación zod', () => {
  it('docNumber < 3 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: 'AB', reason: 'derecho al olvido' });
    expect(r.status).toBe(400);
  });

  it('reason < 10 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '123456', reason: 'corto' });
    expect(r.status).toBe(400);
  });

  it('docNumber > 20 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1'.repeat(25), reason: 'derecho al olvido formal' });
    expect(r.status).toBe(400);
  });
});

describe('POST /forget — flujo principal', () => {
  it('sin driverProfile match → driver/alcohol/incidents = 0; el resto se anonimiza', async () => {
    selectMock.mockReturnValueOnce(chain([])); // driver_profile match: ninguno
    selectMock.mockReturnValueOnce(chain([])); // tramitesPhotos
    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '900123456', reason: 'titular ejerce derecho al olvido' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.docHash).toMatch(/^ANON-[a-f0-9]{16}$/);
    expect(r.body.summary).toBeDefined();
    // driver_profile/alcohol_tests/road_incidents = 0 cuando no hay driver match
    expect(r.body.summary.driver_profile).toBe(0);
    expect(r.body.summary.alcohol_tests).toBe(0);
    expect(r.body.summary.road_incidents).toBe(0);
    expect(r.body.note).toMatch(/anonimizados.*no eliminados/i);
  });

  it('driverProfile match → captura keys S3 y borra fotos via deletePhoto', async () => {
    // driverRows con foto S3
    selectMock.mockReturnValueOnce(chain([
      { userId: 7, fotoStorageKey: 'drivers/7/foto.jpg' },
    ]));
    // tramitesPhotos
    selectMock.mockReturnValueOnce(chain([
      { rostro: 'validaciones/1/rostro.jpg', frontal: null, reverso: 'validaciones/1/reverso.jpg' },
    ]));
    // alcohol keys
    selectMock.mockReturnValueOnce(chain([{ keys: ['alcohol/7/k1.jpg', 'alcohol/7/k2.jpg'] }]));
    // road incident keys
    selectMock.mockReturnValueOnce(chain([{ keys: ['incidents/7/inc.jpg'] }]));

    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036640908', reason: 'derecho al olvido formal' });
    expect(r.status).toBe(200);
    // 1 foto driver + 2 tramites válidas (rostro + reverso, frontal=null) + 2 alcohol + 1 incident = 6
    expect(r.body.s3Total).toBe(6);
    expect(r.body.s3Deleted).toBe(6);
    expect(r.body.s3Failed).toBe(0);
    expect(deletePhotoMock).toHaveBeenCalledTimes(6);
    expect(deletePhotoMock).toHaveBeenCalledWith('drivers/7/foto.jpg');
    expect(deletePhotoMock).toHaveBeenCalledWith('validaciones/1/rostro.jpg');
    expect(deletePhotoMock).toHaveBeenCalledWith('alcohol/7/k1.jpg');
  });

  it('keys legacy (con ":") NO se intentan borrar de S3', async () => {
    selectMock.mockReturnValueOnce(chain([{ userId: 7, fotoStorageKey: 'iv:tag:b64payload' }]));
    selectMock.mockReturnValueOnce(chain([
      { rostro: 'iv:tag:base64data', frontal: null, reverso: null },
    ]));
    selectMock.mockReturnValueOnce(chain([{ keys: [] }]));
    selectMock.mockReturnValueOnce(chain([{ keys: [] }]));

    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '900123', reason: 'derecho al olvido formal' });
    expect(r.status).toBe(200);
    expect(deletePhotoMock).not.toHaveBeenCalled();
    expect(r.body.s3Total).toBe(2); // capturadas pero no borradas
    expect(r.body.s3Deleted).toBe(0);
  });

  it('deletePhoto throws → continúa, s3Failed cuenta', async () => {
    selectMock.mockReturnValueOnce(chain([{ userId: 1, fotoStorageKey: 'drivers/1/a.jpg' }]));
    selectMock.mockReturnValueOnce(chain([
      { rostro: 'validaciones/1/r.jpg', frontal: null, reverso: null },
    ]));
    selectMock.mockReturnValueOnce(chain([{ keys: [] }]));
    selectMock.mockReturnValueOnce(chain([{ keys: [] }]));

    deletePhotoMock.mockRejectedValueOnce(new Error('S3 down'));
    deletePhotoMock.mockResolvedValueOnce(undefined);

    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '900', reason: 'derecho al olvido formal' });
    expect(r.status).toBe(200);
    expect(r.body.s3Failed).toBe(1);
    expect(r.body.s3Deleted).toBe(1);
  });

  it('audit con resource=pii_erasure + docHash + detail enmascarado', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([]));
    transactionMock.mockImplementationOnce(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1234567890', reason: 'derecho al olvido del titular' });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditEntry = auditMock.mock.calls[0][1];
    expect(auditEntry.action).toBe('delete');
    expect(auditEntry.resource).toBe('pii_erasure');
    expect(auditEntry.resourceId).toMatch(/^ANON-[a-f0-9]{16}$/);
    // doc enmascarado: "12***90" → docNumber.slice(0,2) + "***" + slice(-2)
    expect(auditEntry.detail).toContain('12***90');
    expect(auditEntry.detail).not.toContain('1234567890');
    expect(auditEntry.detail).toMatch(/Ley 1581/);
    expect(auditEntry.detail).toMatch(/afectados:/);
    expect(auditEntry.detail).toMatch(/s3_deleted:/);
  });

  // HU #11292 — los datos fiscales de Siigo añadieron columnas de PII a `clients`.
  //
  // Un borrado que deja el correo y el teléfono del contacto en columnas nuevas mientras anonimiza
  // el resto de la ficha no es un borrado: es un borrado aparente, que es justo lo que la Ley 1581
  // castiga. Esta prueba existe para que la próxima columna de PII que alguien añada a `clients` no
  // se cuele sin pasar por aquí.
  it('el derecho al olvido también limpia el contacto fiscal de Siigo', async () => {
    let anonimizacionClients: Record<string, unknown> | undefined;
    selectMock.mockImplementation(() => chain([]));
    transactionMock.mockImplementationOnce(async (cb: any) => {
      let primeraTabla = true;
      const tx = {
        select: vi.fn(() => chain([{ id: 1 }])),
        execute: vi.fn().mockResolvedValue([{ id: 1 }]),
        update: vi.fn(() => ({
          set: (payload: Record<string, unknown>) => {
            // `clients` es la primera tabla que anonimiza el handler.
            if (primeraTabla) { anonimizacionClients = payload; primeraTabla = false; }
            return { where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) };
          },
        })),
      };
      return cb(tx);
    });

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '900123456', reason: 'titular ejerce derecho al olvido' });
    expect(r.status).toBe(200);

    // Cada columna declarada como PII tiene que aparecer en el borrado. `name` y `document` no van
    // a null —se sustituyen por el marcador y por el hash— así que basta con que estén.
    for (const campo of CLIENTS_COLUMNAS_PII) {
      expect(Object.keys(anonimizacionClients ?? {})).toContain(campo);
    }
    // Los códigos fiscales NO se tocan: no identifican a nadie y borrarlos rompería la
    // trazabilidad contable de las facturas ya emitidas.
    for (const campo of ['personType', 'idType', 'branchOffice', 'fiscalResponsibilities']) {
      expect(anonimizacionClients).not.toHaveProperty(campo);
    }
  });

  // El canario de verdad: que las dos listas cubran la tabla ENTERA.
  //
  // Sin esto, la prueba de arriba solo verifica las columnas que alguien se acordó de listar, y una
  // columna de PII añadida mañana pasaría en verde sin borrarse nunca. Contrastarlas contra el
  // esquema real obliga a clasificar cada columna nueva: o es dato personal y se borra, o se
  // declara que no lo es. Por omisión no se puede quedar.
  it('toda columna de clients está clasificada como PII o como no-PII', async () => {
    const { getTableColumns } = await import('drizzle-orm');
    const { clients } = await import('../../src/db/schema.js');
    const clasificadas = new Set<string>([...CLIENTS_COLUMNAS_PII, ...CLIENTS_COLUMNAS_SIN_PII]);
    const sinClasificar = Object.keys(getTableColumns(clients)).filter((col) => !clasificadas.has(col));
    expect(sinClasificar).toEqual([]);
  });

  it('docHash es determinístico (mismo doc → mismo hash)', async () => {
    selectMock.mockImplementation(() => chain([]));
    transactionMock.mockImplementation(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r1 = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036640908', reason: 'derecho al olvido formal' });
    const r2 = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036640908', reason: 'derecho al olvido formal' });
    expect(r1.body.docHash).toBe(r2.body.docHash);
  });

  it('docHash es case-insensitive (1036A vs 1036a → mismo hash)', async () => {
    selectMock.mockImplementation(() => chain([]));
    transactionMock.mockImplementation(buildTxMock());

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r1 = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036A', reason: 'derecho al olvido formal' });
    const r2 = await request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '1036a', reason: 'derecho al olvido formal' });
    expect(r1.body.docHash).toBe(r2.body.docHash);
  });
});

describe('POST /forget — el olvido alcanza las direcciones del módulo Siigo (HU #11708)', () => {
  /** La ficha del titular. Las mayúsculas son deliberadas: es como la teclea quien la registra. */
  const FICHA = [{ email: 'Contabilidad@Empresa.com', contactEmail: 'cartera@empresa.com' }];

  async function olvidar(tx: (cb: any) => Promise<any>) {
    selectMock.mockImplementation(() => chain([]));
    transactionMock.mockImplementationOnce(tx);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    return request(app).post('/api/privacy/forget').set('Authorization', `Bearer ${token}`)
      .send({ docNumber: '900123456', reason: 'titular ejerce derecho al olvido' });
  }

  it('purga también las direcciones ELEGIDAS al enviar, no solo las de las actas', async () => {
    // Desde la HU #11708 el lote de facturación guarda las direcciones que alguien escribió en el
    // envío, porque la emisión ocurre después y en otro proceso. Es el segundo sitio del módulo con
    // datos personales: si el olvido no lo alcanzara, al titular se le respondería que se le olvidó
    // mientras una copia sigue viva en una tabla que nadie mira.
    const r = await olvidar(buildTxPorTabla({ fichaDelTitular: FICHA }));

    expect(r.status).toBe(200);
    expect(r.body.summary.siigo_lotes_facturacion).toBeGreaterThan(0);
    // Y las actas se siguen redactando: esta historia añadió una tabla, no sustituyó a la otra.
    expect(r.body.summary.siigo_factura_envios).toBeGreaterThan(0);
  });

  it('la rama POR DIRECCIÓN se ejercita de verdad: las dos purgas reciben las direcciones del titular', async () => {
    // El caso que faltaba. Buscar solo por la compañía de la factura deja fuera las actas cuyo
    // trámite no tiene empresa resuelta (`compania_id` es NULLABLE) y las direcciones del titular
    // escritas a mano en la factura de OTRA empresa — que es justo cuando el titular del dato no es
    // el cliente al que se factura. Si esta lista llega vacía, las dos purgas degradan a
    // solo-compañía y el resumen sigue diciendo que se purgó algo.
    await olvidar(buildTxPorTabla({ fichaDelTitular: FICHA }));

    expect(correosPasadosAActas).toEqual([['Contabilidad@Empresa.com', 'cartera@empresa.com']]);
    expect(correosPasadosALotes).toEqual([['Contabilidad@Empresa.com', 'cartera@empresa.com']]);
  });

  it('las direcciones se capturan ANTES de anonimizar la ficha, o no se capturan nunca', async () => {
    // El orden de dos líneas, y es todo lo que separa esto de una purga que miente. `matchByDoc`
    // compara contra el documento CRUDO y excluye `NOT LIKE 'ANON-%'`; el paso 1 de la transacción
    // escribe `document = docHash`, que empieza por `ANON-`. Capturar después es capturar cero
    // filas: la rama por dirección se apagaría en silencio y el resumen no cambiaría ni una cifra,
    // porque la rama por compañía sigue devolviendo lo suyo.
    //
    // La transacción falsa lo reproduce: en cuanto `clients` recibe su UPDATE, ese mismo SELECT
    // devuelve vacío. Mover `const correosDelTitular = …` debajo del `tx.update(clients)` pone rojo
    // este caso — y solo este.
    const tx = buildTxPorTabla({ fichaDelTitular: FICHA });
    const r = await olvidar(tx);

    expect(r.status).toBe(200);
    expect(correosPasadosAActas[0]).toHaveLength(2);
    expect(correosPasadosAActas[0]).toContain('Contabilidad@Empresa.com');
    expect(correosPasadosALotes[0]).toHaveLength(2);
  });

  it('una ficha sin direcciones no convierte el olvido en una purga sin criterio', async () => {
    // El control del caso anterior: cuando de verdad no hay direcciones que buscar, la lista llega
    // vacía y las purgas se quedan con la compañía. Sin este caso, «llega vacío» y «no se capturó»
    // serían el mismo resultado y el test de arriba no distinguiría nada.
    await olvidar(buildTxPorTabla({
      fichaDelTitular: [{ email: null, contactEmail: '   ' }],
    }));

    expect(correosPasadosAActas).toEqual([[]]);
    expect(correosPasadosALotes).toEqual([[]]);
  });
});

describe('GET /preview/:docNumber', () => {
  it('docNumber < 3 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/AB').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('docNumber > 20 chars → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get(`/api/privacy/preview/${'1'.repeat(25)}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('sin matches en ninguna tabla → counts en 0', async () => {
    // 12 SELECT (drizzle) + 2 raw db.execute (soat + tramites_digitales)
    selectMock.mockImplementation(() => chain([{ c: 0 }]));
    executeMock.mockResolvedValue([{ c: 0 }]);

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/900123').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.docNumber).toBe('900123');
    expect(r.body.affected.clients).toBe(0);
    expect(r.body.affected.driver_profile).toBe(0);
    expect(r.body.affected.alcohol_tests).toBe(0); // sin driver match → no llama
    expect(r.body.affected.road_incidents).toBe(0);
  });

  it('con driver match → cuenta alcohol_tests + road_incidents adicionales', async () => {
    // El handler hace 10 db.select() en paralelo (clients/vehicles/cp/bo/drv/trv/man/ten/prop/dest)
    // + 2 db.execute() (soat/tramites_digitales). Solo 10 selects entran a selectMock.
    // Orden: clients(1), vehicles(2), cp(3), bo(4), drv(5), trv(6), man(7), ten(8), prop(9), dest(10).
    // Si drv>0 → 11° SELECT userId, 12° count alcohol, 13° count incidents.
    let selectCallCount = 0;
    selectMock.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 5) return chain([{ c: 1 }]); // drv > 0
      if (selectCallCount === 11) return chain([{ userId: 7 }]); // SELECT userId
      if (selectCallCount === 12) return chain([{ c: 5 }]); // alcohol count
      if (selectCallCount === 13) return chain([{ c: 2 }]); // incidents count
      return chain([{ c: 0 }]);
    });
    executeMock.mockResolvedValue([{ c: 0 }]);

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/1036640908').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.affected.driver_profile).toBe(1);
    expect(r.body.affected.alcohol_tests).toBe(5);
    expect(r.body.affected.road_incidents).toBe(2);
  });

  it('responde con todos los 14 campos esperados en affected', async () => {
    selectMock.mockImplementation(() => chain([{ c: 3 }]));
    executeMock.mockResolvedValue([{ c: 7 }]);

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/privacy/preview/900123').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const expectedKeys = [
      'clients', 'vehicles', 'soat_requests', 'tramites_digitales',
      'laft_counterparties', 'laft_beneficial_owners', 'driver_profile',
      'tramites_validaciones', 'alcohol_tests', 'road_incidents',
      'manifiestos', 'tenedores', 'propietarios_carga', 'destinatarios_carga',
    ];
    for (const k of expectedKeys) {
      expect(r.body.affected).toHaveProperty(k);
    }
  });

  it('NO modifica BD (read-only)', async () => {
    selectMock.mockImplementation(() => chain([{ c: 0 }]));
    executeMock.mockResolvedValue([{ c: 0 }]);

    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    await request(app).get('/api/privacy/preview/900123').set('Authorization', `Bearer ${token}`);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(deletePhotoMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
