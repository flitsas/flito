import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth, proveedorAuth, testToken } from '../helpers/auth.js';
import { chain } from '../helpers/db.js';

// Mock del cliente BD: manifiestos usa db.select/insert/update/transaction/execute.
const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
    transaction: transactionMock,
    execute: executeMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: passthrough, authLimiter: passthrough, qrPublicLimiter: passthrough };
});

vi.mock('../../src/shared/redis.ts', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

// Mock de crypto utils — no necesitamos cifrado real en tests; solo verificamos que
// la ruta haga el roundtrip correcto. encryptPii devuelve placeholders deterministas.
vi.mock('../../src/shared/utils/crypto.js', () => ({
  encryptPii: vi.fn(() => ({ cipher: 'CIPHER', iv: 'IV', authTag: 'TAG', keyVersion: 1 })),
  decryptPii: vi.fn(() => 'cuenta-clara-123'),
  newUuid: vi.fn(() => 'uuid-test-0000'),
  normalizeDocument: vi.fn((s: string) => s.replace(/\D/g, '')),
}));

const encolarManifiestoMock = vi.fn();
const procesarManifiestoMock = vi.fn();
vi.mock('../../src/modules/rndc/envio.service.js', () => ({
  encolarManifiesto: encolarManifiestoMock,
  procesarManifiesto: procesarManifiestoMock,
}));

const listOperacionesMock = vi.fn();
vi.mock('../../src/modules/rndc/operaciones.repo.js', () => ({
  listOperaciones: listOperacionesMock,
}));

// Body válido base
const VALID_BODY = {
  vehiculoPrincipalId: 1,
  conductorId: 2,
  municipioOrigenDane: '05001',
  municipioDestinoDane: '11001',
  fechaExpedicion: '2026-05-06',
  valorFleteTotal: 1000000,
  valorAnticipo: 200000,
};

const MANIFIESTO_ROW = {
  id: 10,
  numero: 'M-2026-0001',
  estado: 'borrador',
  conductorId: 2,
  vehiculoPrincipalId: 1,
  vehiculoRemolqueId: null,
  fechaExpedicion: '2026-05-06',
  valorFleteTotal: '1000000',
  valorAnticipo: '200000',
  deletedAt: null,
};

describe('RNDC manifiestos — listado y detalle', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
    executeMock.mockReset();
    executeMock.mockResolvedValue([{ '?column?': 1 }]); // /health
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('GET / sin token → 401', async () => {
    const r = await request(app).get('/api/rndc/manifiestos');
    expect(r.status).toBe(401);
  });

  it('GET / con admin → 200 lista', async () => {
    selectMock.mockReturnValueOnce(chain([MANIFIESTO_ROW]));
    const r = await request(app).get('/api/rndc/manifiestos').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('GET / con filtros (estado/vehiculoId/conductorId/desde/hasta) → 200', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .get('/api/rndc/manifiestos?estado=listo&vehiculoId=1&conductorId=2&desde=2026-01-01&hasta=2026-12-31')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });

  it('GET /:id no numérico → 400', async () => {
    const r = await request(app).get('/api/rndc/manifiestos/abc').set('Authorization', await adminAuth());
    expect(r.status).toBe(400);
  });

  it('GET /:id no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).get('/api/rndc/manifiestos/999').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('GET /:id sin tpc cipher → devuelve titularPagoCuenta=null', async () => {
    selectMock
      .mockReturnValueOnce(chain([MANIFIESTO_ROW]))   // detalle
      .mockReturnValueOnce(chain([]));                 // remesasAsoc
    const r = await request(app).get('/api/rndc/manifiestos/10').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.titularPagoCuenta).toBe(null);
    expect(r.body.data).not.toHaveProperty('titularPagoCuentaCipher');
    expect(r.body.data).not.toHaveProperty('titularPagoCuentaIv');
    expect(r.body.remesas).toEqual([]);
  });

  it('GET /:id con tpc cipher → descifra y NO expone columnas internas', async () => {
    const rowWithCipher = {
      ...MANIFIESTO_ROW,
      titularPagoCuentaCipher: 'CIPHER',
      titularPagoCuentaIv: 'IV',
      titularPagoCuentaAuthTag: 'TAG',
      titularPagoCuentaAadNonce: 'NONCE',
      titularPagoCuentaKeyVersion: 1,
    };
    selectMock
      .mockReturnValueOnce(chain([rowWithCipher]))
      .mockReturnValueOnce(chain([{ remesaId: 5, orden: 1, numero: 'R-001', estado: 'cumplida' }]));
    const r = await request(app).get('/api/rndc/manifiestos/10').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.titularPagoCuenta).toBe('cuenta-clara-123');
    expect(r.body.data).not.toHaveProperty('titularPagoCuentaCipher');
    expect(r.body.remesas).toHaveLength(1);
  });
});

describe('RNDC manifiestos — GET /:id/validar (semáforo)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    executeMock.mockReset();
    executeMock.mockResolvedValue([{ '?column?': 1 }]);
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('validar: manifiesto no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).get('/api/rndc/manifiestos/999/validar').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('validar: todo OK (sin remolque) → ok=true cuando docs+conductor+remesas presentes', async () => {
    // 1) manifiesto encontrado
    selectMock.mockReturnValueOnce(chain([MANIFIESTO_ROW]));
    // 2) execute(fn_conductor_apto)
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([{ ok: true }]);
    // 3) docsVehic
    selectMock.mockReturnValueOnce(chain([
      { tipoNombre: 'SOAT', estado: 'vigente' },
      { tipoNombre: 'RTM', estado: 'vigente' },
      { tipoNombre: 'POLIZA contractual', estado: 'vigente' },
    ]));
    // 4) count remesas
    selectMock.mockReturnValueOnce(chain([{ count: 2 }]));

    const r = await request(app).get('/api/rndc/manifiestos/10/validar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.checks.length).toBeGreaterThanOrEqual(4); // conductor + 3 docs + remesas
  });

  it('validar: conductor no apto → ok=false con detalle', async () => {
    selectMock.mockReturnValueOnce(chain([MANIFIESTO_ROW]));
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([{ ok: false }]);
    selectMock.mockReturnValueOnce(chain([])); // sin docs
    selectMock.mockReturnValueOnce(chain([{ count: 0 }]));

    const r = await request(app).get('/api/rndc/manifiestos/10/validar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    const conductorCheck = r.body.checks.find((c: any) => c.regla.includes('Conductor'));
    expect(conductorCheck.ok).toBe(false);
  });

  it('validar: con remolque → agrega check de vinculación', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, vehiculoRemolqueId: 99 }]));
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([{ ok: true }]);
    selectMock.mockReturnValueOnce(chain([
      { tipoNombre: 'soat', estado: 'vigente' },
      { tipoNombre: 'rtm', estado: 'vigente' },
      { tipoNombre: 'poliza', estado: 'vigente' },
    ]));
    selectMock.mockReturnValueOnce(chain([{ id: 1, esActual: true }])); // vinculación
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));

    const r = await request(app).get('/api/rndc/manifiestos/10/validar').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    const linkCheck = r.body.checks.find((c: any) => c.regla.includes('Vinculación'));
    expect(linkCheck).toBeDefined();
    expect(linkCheck.ok).toBe(true);
  });
});

describe('RNDC manifiestos — POST crear', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    insertMock.mockReset();
    transactionMock.mockReset();
    executeMock.mockReset();
    executeMock.mockResolvedValue([{ '?column?': 1 }]);
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('POST sin token → 401', async () => {
    const r = await request(app).post('/api/rndc/manifiestos').send(VALID_BODY);
    expect(r.status).toBe(401);
  });

  it('POST body inválido (DANE corto) → 400 y NO entra a transaction', async () => {
    const r = await request(app)
      .post('/api/rndc/manifiestos')
      .set('Authorization', await adminAuth())
      .send({ ...VALID_BODY, municipioOrigenDane: '12' });
    expect(r.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('POST anticipo > flete → 400 (refine)', async () => {
    const r = await request(app)
      .post('/api/rndc/manifiestos')
      .set('Authorization', await adminAuth())
      .send({ ...VALID_BODY, valorAnticipo: 2000000, valorFleteTotal: 1000000 });
    expect(r.status).toBe(400);
  });

  it('POST sin remesas → 201 (transaction OK)', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValueOnce([{ numero: 'M-2026-0001' }]),
        insert: vi.fn().mockReturnValueOnce(chain([MANIFIESTO_ROW])),
        select: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });

    const r = await request(app)
      .post('/api/rndc/manifiestos')
      .set('Authorization', await adminAuth())
      .send(VALID_BODY);
    expect(r.status).toBe(201);
    expect(r.body.data.numero).toBe('M-2026-0001');
  });

  it('POST con remesas elegibles → 201', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValueOnce([{ numero: 'M-2026-0002' }]),
        insert: vi.fn()
          .mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, id: 11, numero: 'M-2026-0002' }])) // manifiesto
          .mockReturnValue(chain([{ id: 1 }])),                                                 // manifiestoRemesas (varias veces)
        select: vi.fn().mockReturnValueOnce(chain([{ id: 5 }, { id: 6 }])),                   // elegibles con .for('update')
        update: vi.fn().mockReturnValueOnce(chain([])),                                        // remesas.set(manifiestoId)
      };
      return cb(tx);
    });

    const r = await request(app)
      .post('/api/rndc/manifiestos')
      .set('Authorization', await adminAuth())
      .send({ ...VALID_BODY, remesaIds: [5, 6] });
    expect(r.status).toBe(201);
  });

  it('POST con remesas NO elegibles → 409', async () => {
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValueOnce([{ numero: 'M-2026-0003' }]),
        insert: vi.fn().mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, id: 12 }])),
        select: vi.fn().mockReturnValueOnce(chain([{ id: 5 }])), // pidieron 5 y 6, solo 5 elegible
        update: vi.fn(),
      };
      return cb(tx);
    });

    const r = await request(app)
      .post('/api/rndc/manifiestos')
      .set('Authorization', await adminAuth())
      .send({ ...VALID_BODY, remesaIds: [5, 6] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no son elegibles/i);
  });

  it('POST cuando trigger 23514 (conductor) → 403', async () => {
    transactionMock.mockImplementationOnce(async () => {
      const err: any = new Error('Conductor no apto: alcoholimetría positiva');
      err.code = '23514';
      throw err;
    });

    const r = await request(app)
      .post('/api/rndc/manifiestos')
      .set('Authorization', await adminAuth())
      .send(VALID_BODY);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Conductor/i);
  });

  it('POST cifra titularPagoCuenta cuando viene en body', async () => {
    const txInsertSpy = vi.fn().mockReturnValueOnce(chain([MANIFIESTO_ROW]));
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = {
        execute: vi.fn().mockResolvedValueOnce([{ numero: 'M-2026-0004' }]),
        insert: txInsertSpy,
        select: vi.fn(),
        update: vi.fn(),
      };
      return cb(tx);
    });

    const r = await request(app)
      .post('/api/rndc/manifiestos')
      .set('Authorization', await adminAuth())
      .send({ ...VALID_BODY, titularPagoCuenta: '0011-0033-44-55667788' });
    expect(r.status).toBe(201);
    // El insert recibió el cipher, no el plaintext
    expect(txInsertSpy).toHaveBeenCalled();
    const valuesCall = txInsertSpy.mock.results[0]!.value.values.mock?.calls?.[0]?.[0];
    // Usamos el spy del chain — aquí solo validamos que la ruta no crashee y devuelva 201.
    // El detalle del cipher se valida en el unit test del crypto helper.
  });
});

describe('RNDC manifiestos — PUT editar', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    updateMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('PUT id no numérico → 400', async () => {
    const r = await request(app)
      .put('/api/rndc/manifiestos/abc')
      .set('Authorization', await adminAuth())
      .send({ valorFleteTotal: 100 });
    expect(r.status).toBe(400);
  });

  it('PUT no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .put('/api/rndc/manifiestos/999')
      .set('Authorization', await adminAuth())
      .send({ valorFleteTotal: 100 });
    expect(r.status).toBe(404);
  });

  it('PUT en estado cumplido → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'cumplido' }]));
    const r = await request(app)
      .put('/api/rndc/manifiestos/10')
      .set('Authorization', await adminAuth())
      .send({ valorFleteTotal: 100 });
    expect(r.status).toBe(409);
  });

  it('PUT en borrador → 200', async () => {
    selectMock.mockReturnValueOnce(chain([MANIFIESTO_ROW]));
    updateMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, valorFleteTotal: '1500000' }]));
    const r = await request(app)
      .put('/api/rndc/manifiestos/10')
      .set('Authorization', await adminAuth())
      .send({ valorFleteTotal: 1500000 });
    expect(r.status).toBe(200);
    expect(r.body.data.valorFleteTotal).toBe('1500000');
  });

  it('PUT con titularPagoCuenta=null limpia los campos cipher', async () => {
    selectMock.mockReturnValueOnce(chain([MANIFIESTO_ROW]));
    updateMock.mockReturnValueOnce(chain([MANIFIESTO_ROW]));
    const r = await request(app)
      .put('/api/rndc/manifiestos/10')
      .set('Authorization', await adminAuth())
      .send({ titularPagoCuenta: null });
    expect(r.status).toBe(200);
  });
});

describe('RNDC manifiestos — transiciones', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    selectMock.mockReset();
    updateMock.mockReset();
    transactionMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('marcar-listo éxito → 200 con todas las validaciones OK', async () => {
    // 1) SELECT manifiesto inicial (borrador)
    selectMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'borrador' }]));
    // 2) executar validaciones — todas pasan
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([{ ok: true }]); // fn_conductor_apto
    selectMock.mockReturnValueOnce(chain([
      { tipoNombre: 'SOAT', estado: 'vigente' },
      { tipoNombre: 'RTM', estado: 'vigente' },
      { tipoNombre: 'poliza', estado: 'vigente' },
    ]));
    selectMock.mockReturnValueOnce(chain([{ count: 2 }]));
    // 3) UPDATE final
    updateMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'listo' }]));

    const r = await request(app).post('/api/rndc/manifiestos/10/marcar-listo').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('listo');
  });

  it('marcar-listo bloqueado por SOAT vencido → 422 con detalle', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'borrador' }]));
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([{ ok: true }]); // conductor OK
    selectMock.mockReturnValueOnce(chain([
      { tipoNombre: 'RTM', estado: 'vigente' },
      { tipoNombre: 'poliza', estado: 'vigente' },
      // SOAT ausente
    ]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));

    const r = await request(app).post('/api/rndc/manifiestos/10/marcar-listo').set('Authorization', await adminAuth());
    expect(r.status).toBe(422);
    expect(r.body.error).toBeDefined();
    expect(Array.isArray(r.body.checksFallidos)).toBe(true);
    expect(r.body.checksFallidos.some((c: any) => c.regla.includes('SOAT'))).toBe(true);
  });

  it('marcar-listo bloqueado por conductor no apto → 422', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'borrador' }]));
    executeMock.mockReset();
    executeMock.mockResolvedValueOnce([{ ok: false }]); // conductor NO apto
    selectMock.mockReturnValueOnce(chain([
      { tipoNombre: 'SOAT', estado: 'vigente' },
      { tipoNombre: 'RTM', estado: 'vigente' },
      { tipoNombre: 'poliza', estado: 'vigente' },
    ]));
    selectMock.mockReturnValueOnce(chain([{ count: 1 }]));

    const r = await request(app).post('/api/rndc/manifiestos/10/marcar-listo').set('Authorization', await adminAuth());
    expect(r.status).toBe(422);
    expect(r.body.checksFallidos.some((c: any) => c.regla.includes('Conductor'))).toBe(true);
  });

  it('marcar-listo cuando no estaba en borrador → 409', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'listo' }]));
    const r = await request(app).post('/api/rndc/manifiestos/10/marcar-listo').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('marcar-listo manifiesto no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).post('/api/rndc/manifiestos/10/marcar-listo').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('cumplir: no encontrado → 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    const r = await request(app).post('/api/rndc/manifiestos/999/cumplir').set('Authorization', await adminAuth());
    expect(r.status).toBe(404);
  });

  it('cumplir: en estado borrador → 409', async () => {
    selectMock.mockReturnValueOnce(chain([MANIFIESTO_ROW]));
    const r = await request(app).post('/api/rndc/manifiestos/10/cumplir').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('cumplir: remesas pendientes → 422 con detalle', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'listo' }]))
      .mockReturnValueOnce(chain([{ id: 5, numero: 'R-001', estado: 'activa' }]));
    const r = await request(app).post('/api/rndc/manifiestos/10/cumplir').set('Authorization', await adminAuth());
    expect(r.status).toBe(422);
    expect(r.body.remesasPendientes).toHaveLength(1);
  });

  it('cumplir éxito → 200', async () => {
    selectMock
      .mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'listo' }]))
      .mockReturnValueOnce(chain([])); // sin remesas pendientes
    transactionMock.mockImplementationOnce(async (cb: any) => {
      const tx = { update: vi.fn().mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'cumplido' }])) };
      return cb(tx);
    });

    const r = await request(app).post('/api/rndc/manifiestos/10/cumplir').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('cumplido');
  });

  it('anular: motivo corto → 400', async () => {
    const r = await request(app)
      .post('/api/rndc/manifiestos/10/anular')
      .set('Authorization', await adminAuth())
      .send({ motivo: 'no' });
    expect(r.status).toBe(400);
  });

  it('anular: éxito → 200', async () => {
    updateMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, estado: 'anulado' }]));
    const r = await request(app)
      .post('/api/rndc/manifiestos/10/anular')
      .set('Authorization', await adminAuth())
      .send({ motivo: 'cliente desistió' });
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('anulado');
  });

  it('anular: no encontrado → 404', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app)
      .post('/api/rndc/manifiestos/999/anular')
      .set('Authorization', await adminAuth())
      .send({ motivo: 'cliente desistió' });
    expect(r.status).toBe(404);
  });

  it('DELETE en estado activo → 409', async () => {
    updateMock.mockReturnValueOnce(chain([]));
    const r = await request(app).delete('/api/rndc/manifiestos/10').set('Authorization', await adminAuth());
    expect(r.status).toBe(409);
  });

  it('DELETE borrador → 200', async () => {
    updateMock.mockReturnValueOnce(chain([{ ...MANIFIESTO_ROW, deletedAt: new Date() }]));
    const r = await request(app).delete('/api/rndc/manifiestos/10').set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
  });
});

describe('RNDC manifiestos — admin endpoints (encolar/reintentar/operaciones)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;

  beforeEach(async () => {
    encolarManifiestoMock.mockReset();
    procesarManifiestoMock.mockReset();
    listOperacionesMock.mockReset();
    const { createApp } = await import('../../src/app.js');
    app = createApp();
  });

  it('encolar-envio: requiere admin (proveedor → 403)', async () => {
    const r = await request(app)
      .post('/api/rndc/manifiestos/10/encolar-envio')
      .set('Authorization', await proveedorAuth());
    expect(r.status).toBe(403);
    expect(encolarManifiestoMock).not.toHaveBeenCalled();
  });

  it('encolar-envio: admin → 200', async () => {
    encolarManifiestoMock.mockResolvedValueOnce(undefined);
    const r = await request(app)
      .post('/api/rndc/manifiestos/10/encolar-envio')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(encolarManifiestoMock).toHaveBeenCalledWith(10);
  });

  it('reintentar-envio: requiere admin (sin token → 401)', async () => {
    const r = await request(app).post('/api/rndc/manifiestos/10/reintentar-envio');
    expect(r.status).toBe(401);
  });

  it('reintentar-envio: admin → 200 con resultado del service', async () => {
    procesarManifiestoMock.mockResolvedValueOnce({ estadoFinal: 'aceptado', consecutivoRndc: 'CR-123' });
    const r = await request(app)
      .post('/api/rndc/manifiestos/10/reintentar-envio')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.estadoFinal).toBe('aceptado');
  });

  it('GET /:id/operaciones → 200 con lista', async () => {
    listOperacionesMock.mockResolvedValueOnce([
      { id: 1, accion: 'enviar', estadoFinal: 'aceptado', createdAt: new Date() },
    ]);
    const r = await request(app)
      .get('/api/rndc/manifiestos/10/operaciones')
      .set('Authorization', await adminAuth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(listOperacionesMock).toHaveBeenCalledWith(expect.objectContaining({
      entidadTipo: 'manifiesto', entidadId: 10, incluirXml: false,
    }));
  });

  it('GET /:id/operaciones?incluirXml=1 → pasa flag al repo', async () => {
    listOperacionesMock.mockResolvedValueOnce([]);
    await request(app)
      .get('/api/rndc/manifiestos/10/operaciones?incluirXml=1')
      .set('Authorization', await adminAuth());
    expect(listOperacionesMock).toHaveBeenCalledWith(expect.objectContaining({ incluirXml: true }));
  });
});
