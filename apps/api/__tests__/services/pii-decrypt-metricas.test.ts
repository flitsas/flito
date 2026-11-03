// Feature #13978, decisión del humano (ADR-0034, hallazgo 2) — los `catch` de descifrado incrementan
// `pii_decrypt_failures_total` y la respuesta no cambia: `null` con 200.
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const executeMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, execute: executeMock, insert: vi.fn(), update: vi.fn(), transaction: vi.fn(), delete: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { piiDecryptFailuresTotal } = await import('../../src/shared/metrics.js');

async function serie(table: string, column: string): Promise<number | undefined> {
  const { values } = await piiDecryptFailuresTotal.get();
  return values.find((v) => v.labels.table === table && v.labels.column === column)?.value;
}

/** Bytes con la forma de un paquete, que GCM rechaza: es lo que deja una llave ausente o equivocada. */
const bundleIlegible = (prefijo: string) => ({
  [`${prefijo}Cipher`]: crypto.randomBytes(8),
  [`${prefijo}Iv`]: crypto.randomBytes(12),
  [`${prefijo}AuthTag`]: crypto.randomBytes(16),
  [`${prefijo}AadNonce`]: '11111111-2222-4333-8444-555555555555',
  [`${prefijo}KeyVersion`]: 1,
});

const token = () => testToken({ sub: 1, role: 'admin' });

beforeEach(() => {
  selectMock.mockReset();
  executeMock.mockReset().mockResolvedValue({ rows: [{ count: 0 }] });
});

describe('series inicializadas en 0', () => {
  it.each([
    ['driver_profile', 'cedula'], ['driver_profile', 'licencia_numero'], ['driver_profile', 'runt_payload'],
    ['manifiestos', 'titular_pago_cuenta'],
    ['laft_counterparties', 'doc_number'], ['laft_counterparties', 'email'], ['laft_counterparties', 'phone'],
    ['flito_logistica_acta_firmas', 'documento_cifrado'], ['flito_logistica_recogida_firmantes', 'documento_cifrado'],
    ['tramites_validaciones', 'foto_rostro'],
  ])('%s.%s existe antes del primer fallo', async (table, column) => {
    expect(await serie(table, column)).toBeTypeOf('number');
  });
});

describe('drivers', () => {
  it('GET /:id: la cédula ilegible sale `null` con 200 y cuenta en la serie', async () => {
    const antes = await serie('driver_profile', 'cedula') as number;
    selectMock.mockReturnValueOnce(chain([{ id: 5, name: 'Juan', username: 'juan', email: 'j@x.com', esConductor: true }]));
    selectMock.mockReturnValueOnce(chain([{ userId: 5, ...bundleIlegible('cedula'), categorias: [] }]));
    const { default: router } = await import('../../src/modules/drivers/drivers.routes.js');
    const app = express().use(express.json()).use('/api/drivers', router);
    const r = await request(app).get('/api/drivers/5').set('Authorization', `Bearer ${await token()}`);
    expect(r.status).toBe(200);
    expect(r.body.profile.cedula).toBeNull();
    expect(await serie('driver_profile', 'cedula')).toBe(antes + 1);
  });
});

describe('manifiestos', () => {
  it('GET /:id: la cuenta ilegible sale `null` con 200 y cuenta en la serie', async () => {
    const antes = await serie('manifiestos', 'titular_pago_cuenta') as number;
    selectMock.mockReturnValueOnce(chain([{ id: 3, numero: 'M-1', deletedAt: null, ...bundleIlegible('titularPagoCuenta') }]));
    selectMock.mockReturnValueOnce(chain([]));
    const { default: router } = await import('../../src/modules/rndc/manifiestos.routes.js');
    const app = express().use(express.json()).use('/api/rndc/manifiestos', router);
    const r = await request(app).get('/api/rndc/manifiestos/3').set('Authorization', `Bearer ${await token()}`);
    expect(r.status).toBe(200);
    expect(r.body.data.titularPagoCuenta).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain('titularPagoCuentaCipher');
    expect(await serie('manifiestos', 'titular_pago_cuenta')).toBe(antes + 1);
  });
});

describe('LAFT', () => {
  it('`decryptCounterpartyField`: `null` y cuenta por columna', async () => {
    const { decryptCounterpartyField, encryptCounterpartyField } = await import('../../src/modules/laft/employees/counterparty-pii.js');
    const enc = encryptCounterpartyField('900123456', 'email', 4);
    const antes = await serie('laft_counterparties', 'email') as number;
    expect(decryptCounterpartyField(enc, 'email', 4)).toBe('900123456');
    expect(await serie('laft_counterparties', 'email')).toBe(antes);
    expect(decryptCounterpartyField(enc, 'email', 5)).toBeNull();
    expect(await serie('laft_counterparties', 'email')).toBe(antes + 1);
  });

  it('sin valor no es fallo: sigue `null` y no cuenta', async () => {
    const { decryptCounterpartyField } = await import('../../src/modules/laft/employees/counterparty-pii.js');
    const antes = await serie('laft_counterparties', 'phone') as number;
    expect(decryptCounterpartyField(null, 'phone', 4)).toBeNull();
    expect(await serie('laft_counterparties', 'phone')).toBe(antes);
  });
});

describe('acta PDF', () => {
  it('`revelarONulo`: `null` y cuenta en la tabla real de la fila, sin el valor en las labels', async () => {
    const { revelarONulo } = await import('../../src/modules/flito-logistica/flito-logistica.acta-pdf.js');
    const { protegerDocumento } = await import('../../src/modules/flito-logistica/flito-logistica.cifrado.js');
    const { cifrado } = protegerDocumento('1036640908', 'firma-a');
    const firmas = await serie('flito_logistica_acta_firmas', 'documento_cifrado') as number;
    const firmantes = await serie('flito_logistica_recogida_firmantes', 'documento_cifrado') as number;

    expect(revelarONulo(cifrado, 'firma-a', 'flito_logistica_acta_firmas')).toBe('1036640908');
    expect(revelarONulo(cifrado, 'firma-b', 'flito_logistica_acta_firmas')).toBeNull();
    expect(revelarONulo(cifrado, 'firma-b', 'flito_logistica_recogida_firmantes')).toBeNull();

    expect(await serie('flito_logistica_acta_firmas', 'documento_cifrado')).toBe(firmas + 1);
    expect(await serie('flito_logistica_recogida_firmantes', 'documento_cifrado')).toBe(firmantes + 1);
    expect(JSON.stringify(await piiDecryptFailuresTotal.get())).not.toContain('1036640908');
  });
});
