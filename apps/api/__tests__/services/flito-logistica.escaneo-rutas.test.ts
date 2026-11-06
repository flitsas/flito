// HU #14348 (Feature #14326, ADR-0039 §7.3, §8.5, §8.7) — lo que el escaneo decide en la ruta: la función de dejar pendiente
// antes de consultar datos, la idempotencia por usuario y el limitador de validar-lt. La decisión contra datos reales
// se prueba en `db/flito-logistica.escaneo-resolver.pg.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
const guardadas = new Map<string, { status: number; body: unknown }>();
const buscadas: string[] = [];
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({ uploadEntityDocument: vi.fn().mockResolvedValue('k'), presignedGetEntityDocument: vi.fn(), getEntityDocumentStream: vi.fn() }));
vi.mock('../../src/modules/flito-logistica/flito-logistica.idempotencia.js', () => ({
  buscarIdempotencia: async (k: string) => { buscadas.push(k); return guardadas.get(k) ?? null; },
  guardarIdempotencia: async (k: string, status: number, body: unknown) => { guardadas.set(k, { status, body }); },
}));

const { audit } = await import('../../src/shared/middleware/audit.js');
const { default: rutas } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

const MANUAL = { placa: 'QOX858', numeroLicencia: '10038156339', numeroLt: 'LT0012345' };
const DOC = '11111111-1111-4111-8111-111111111111';
const ACTA = '22222222-2222-4222-8222-222222222222';
const app = express();
app.use(express.json());
app.use('/api/flito/logistica', rutas);

const post = async (ruta: string, cuerpo: object, token: string, cabeceras: Record<string, string> = {}) => {
  let r = request(app).post(`/api/flito/logistica${ruta}`).set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(cabeceras)) r = r.set(k, v);
  return r.send(cuerpo);
};

beforeEach(() => {
  guardadas.clear(); buscadas.length = 0; vi.mocked(audit).mockClear();
  selectMock.mockReset().mockImplementation(() => chain([]));
  transactionMock.mockReset().mockImplementation(async (fn: (t: unknown) => unknown) => fn({ select: selectMock, execute: vi.fn(), update: vi.fn().mockReturnValue(chain([])), insert: vi.fn().mockReturnValue(chain([])) }));
});

describe('AC4 y AC5 — dejar pendiente', () => {
  it('AC4: sin la función → 403 antes de consultar datos, sin escribir', async () => {
    const token = await testToken({ role: 'mensajero', sub: 9 });
    const r = await post('/escanear', { ...MANUAL, dejarPendiente: true }, token);
    expect(r.status).toBe(403);
    expect(selectMock.mock.calls.length).toBe(0);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('AC4: el mismo usuario, sin pedir dejar pendiente, sí escanea', async () => {
    const r = await post('/escanear', MANUAL, await testToken({ role: 'mensajero', sub: 9 }));
    expect(r.status).toBe(200);
  });

  it('AC5: admin la tiene sembrada; un mensajero de FLITO, solo si se le concede', async () => {
    expect((await post('/escanear', { ...MANUAL, dejarPendiente: true }, await testToken({ role: 'admin', sub: 1 }))).status).toBe(200);
    const concedida = await testToken({ role: 'mensajero', sub: 10, funciones: ['logistica.documento.dejar_pendiente'] });
    expect((await post('/escanear', { ...MANUAL, dejarPendiente: true }, concedida)).status).toBe(200);
  });
});

describe('AC1 — el motivo real va a auditoría, no a la respuesta', () => {
  it('sin trámite: respuesta con el mensaje único y `inexistente` solo en la auditoría', async () => {
    const r = await post('/escanear', MANUAL, await testToken({ role: 'admin', sub: 1 }));
    expect(r.body).toStrictEqual({
      resultado: 'sin_match', motivo: 'No se encontró un trámite para esta licencia',
      placa: 'QOX858', vin: '', numeroLicencia: '10038156339', propietarioNombre: null,
    });
    expect(vi.mocked(audit).mock.calls[0]![1].detail).toBe('Escaneo LT: sin_match (inexistente) (manual)');
    expect(vi.mocked(audit).mock.calls[0]![1].detail).not.toMatch(/QOX/);
  });
});

describe('AC8 — idempotencia por usuario', () => {
  const CUERPOS: Array<[string, string, object]> = [
    ['/escanear', 'escanear', MANUAL],
    [`/documentos/${DOC}/novedad`, 'documentos-novedad', { motivo: 'Dañada' }],
    [`/actas/${ACTA}/entregar`, 'actas-entregar', { receptorNombre: 'R', receptorDocumento: '1', firma: 'iVBORw0KGgo=' }],
    [`/actas/${ACTA}/devolucion`, 'actas-devolucion', { motivo: 'Ausente' }],
  ];

  it.each(CUERPOS)('%s: otro usuario con la misma cabecera no recibe la respuesta guardada del primero', async (ruta, clave, cuerpo) => {
    const GUARDADA = { compania: 'ACME', propietario: 'Datos del primero' };
    guardadas.set(`1:${clave}:K`, { status: 200, body: GUARDADA });

    const primero = await post(ruta, cuerpo, await testToken({ role: 'admin', sub: 1 }), { 'Idempotency-Key': 'K' });
    expect(primero.body).toEqual(GUARDADA);

    const otro = await post(ruta, cuerpo, await testToken({ role: 'admin', sub: 2 }), { 'Idempotency-Key': 'K' });
    expect(buscadas).toContain(`2:${clave}:K`);
    expect(JSON.stringify(otro.body)).not.toMatch(/Datos del primero/);
  });

  it('una clave guardada antes del despliegue, sin usuario, ya no se reconoce (efecto declarado en §8.7)', async () => {
    guardadas.set('K-vieja', { status: 200, body: { vieja: true } });
    const r = await post('/escanear', MANUAL, await testToken({ role: 'admin', sub: 1 }), { 'Idempotency-Key': 'K-vieja' });
    expect(r.body.vieja).toBeUndefined();
    expect(r.body.resultado).toBe('sin_match');
  });
});

describe('AC9 — validar-lt tiene limitador por usuario; consultar-vehiculo responde igual', () => {
  it('la petición 301 en la ventana → 429, sin eco de la placa, y a otro usuario no lo frena', async () => {
    const token = await testToken({ role: 'mensajero', sub: 301 });
    let ultimo = 0; let cuerpo = '';
    for (let i = 0; i < 301; i++) {
      const r = await post('/validar-lt', MANUAL, token);
      ultimo = r.status; cuerpo = JSON.stringify(r.body);
    }
    expect(ultimo).toBe(429);
    expect(cuerpo).not.toMatch(/QOX/);
    expect((await post('/validar-lt', MANUAL, await testToken({ role: 'mensajero', sub: 302 }))).status).toBe(200);
  }, 60_000);

  it('validar-lt usa el mismo constructor: sin trámite, el mismo cuerpo que el escaneo', async () => {
    const token = await testToken({ role: 'admin', sub: 1 });
    expect((await post('/validar-lt', MANUAL, token)).body).toStrictEqual((await post('/escanear', MANUAL, token)).body);
  });
});
