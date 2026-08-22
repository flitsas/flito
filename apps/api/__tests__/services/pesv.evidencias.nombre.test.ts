// PESV · autodiagnóstico — el nombre de la evidencia sigue saliendo en la lista.
//
// Este archivo existe por la EXCEPCIÓN del Bug #11694. El resto del monorepo pasó a claves opacas
// (`<ts>_<uuid>.<ext>`) para que el nombre que escribe el cliente no viaje en el query string del
// enlace firmado. Esta ruta no pudo: `pesv_diagnostico_items.evidencia_keys` es un `text[]` de
// claves y no hay columna donde guardar el nombre, así que la pantalla lo recupera PARSEANDO la
// clave (`decodeFilename`). Por eso conserva el formato legado — y por eso hace falta un test que
// lo note si alguien «limpia» la excepción: el síntoma sería un UUID en la lista de evidencias, no
// un error, y sin esto no lo vería nadie hasta que un auditor abriera la pantalla.
//
// MinIO está mockeado pero `uploadEntityDocument` es el REAL: la clave que se afirma es la que
// produce el helper hoy, no una que fabrique el test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { chain } from '../helpers/db.js';
import { adminAuth } from '../helpers/auth.js';

const PDF = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');

const putObjectMock = vi.fn();
const clavesSubidas: string[] = [];

class MockClient {
  bucketExists = vi.fn().mockResolvedValue(true);
  makeBucket = vi.fn();
  putObject = putObjectMock;
  getObject = vi.fn();
  statObject = vi.fn();
  removeObject = vi.fn().mockResolvedValue(undefined);
}
vi.mock('minio', () => ({ Client: MockClient }));

const selectMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: executeMock,
    transaction: transactionMock,
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
}));

const ITEM = {
  diagnostico_id: 3, estandar_id: 7, score_pct: '75', nivel_rubrica: 'implementado',
  evidencia_keys: [] as string[], comentarios: null, updated_at: new Date('2026-08-21T12:00:00Z'),
  codigo: 'E-07', paso: 2, fase: 'planear', nombre: 'Política', descripcion: 'desc', peso: '3', orden: 7,
};

let app: any;

beforeEach(async () => {
  selectMock.mockReset();
  executeMock.mockReset().mockResolvedValue([{ '?column?': 1 }]);
  transactionMock.mockReset();
  putObjectMock.mockReset().mockImplementation(async (_bucket: string, key: string) => {
    clavesSubidas.push(key);
  });
  clavesSubidas.length = 0;

  // El diagnóstico existe y está abierto.
  selectMock.mockReturnValue(chain([{ id: 3, estado: 'abierto', createdBy: 1 }]));

  // La tx: lock → append → relectura. La relectura devuelve la clave que el handler acaba de subir
  // (la captura `putObjectMock`), que es como se comporta el `array_append` real.
  transactionMock.mockImplementation(async (cb: any) => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [ITEM] })
      .mockResolvedValueOnce({ rows: [] })
      .mockImplementation(async () => ({ rows: [{ ...ITEM, evidencia_keys: [...clavesSubidas] }] }));
    return cb({ execute });
  });

  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('PESV evidencias — el nombre del archivo sobrevive a la clave (excepción Bug #11694)', () => {
  it('la lista devuelta tras subir enseña el nombre real, no un UUID', async () => {
    const r = await request(app)
      .post('/api/pesv/diagnostico/3/items/7/evidencias')
      .set('Authorization', await adminAuth())
      .attach('archivo', PDF, { filename: 'politica-alcohol-v2.pdf', contentType: 'application/pdf' });

    expect(r.status).toBe(201);
    expect(r.body.item.evidencias).toHaveLength(1);
    // Lo que ve el usuario en la pantalla del estándar.
    expect(r.body.item.evidencias[0].filename).toBe('politica-alcohol-v2.pdf');
    // El keyHash —lo único que el frontend recibe de la clave (ADR-PESV-001)— sigue emitiéndose.
    expect(r.body.item.evidencias[0].keyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('la clave guardada conserva el formato legado <ts>_<hash>_<nombre> que PESV sabe parsear', async () => {
    await request(app)
      .post('/api/pesv/diagnostico/3/items/7/evidencias')
      .set('Authorization', await adminAuth())
      .attach('archivo', PDF, { filename: 'politica-alcohol-v2.pdf', contentType: 'application/pdf' });

    expect(clavesSubidas).toHaveLength(1);
    expect(clavesSubidas[0]).toMatch(
      /^pesv\/diagnostico-evidencia\/3\/\d+_[0-9a-f]{12}_politica-alcohol-v2\.pdf$/,
    );
  });
});
