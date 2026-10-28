// HU #14136 — borde HTTP de adjuntar factura / confirmar una pendiente (servicio simulado).
//   AC5  sin `confirmado: true` explícito → 400 y el servicio ni se llama
//   AC7  servicio devuelve null (otra compañía) → 404 «La solicitud no existe» en ambas rutas
//   AC8  archivo con extensión/tipo no permitido → 400 (multer) · PDF falso → el 400 del servicio
//   AC9  409 incompleta_ya_resuelta con el estado
//   AC10 usuario sin `soat.solicitud.crear` → 403
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const kdb = createKeyedDb();
const adjuntarMock = vi.hoisted(() => vi.fn());
const confirmarMock = vi.hoisted(() => vi.fn());
const piiMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), adjuntarFactura: adjuntarMock, confirmarIncompleta: confirmarMock,
}));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), contextoSoat: vi.fn().mockResolvedValue({ userId: 1, username: 'u', alcance: 'todo', companiaId: 7 }),
}));

const ID = '1c0a0000-0000-4000-8000-00000000bb01';
const PROP = {
  tipoDocumento: 'CC', numeroDocumento: '1020304050', nombres: 'ANA', apellidos: 'PEREZ',
  correo: 'ana@x.co', celular: '3001234567', direccion: 'Cra 1 # 2-3', municipio: 'Funza', departamento: 'Cundinamarca',
};
let sub = 14136_00;
async function auth(funciones: string[] = ['soat.solicitud.crear']) {
  sub += 1;
  await registrarUsuarioDePrueba(sub, {
    rol: 'rol_prueba', tipoPrincipal: 'interno', tipoEnlace: 'ninguno', excepciones: [],
    funcionesDelRol: ['pagina.flito_soat', ...funciones],
  });
  const t = await new SignJWT({ username: 'pedro@flito.co', role: 'rol_prueba' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}
async function buildApp() {
  const app = express();
  app.use(express.json());
  const router = (await import('../../src/modules/flito-soat/flito-soat-incompletas.routes.js')).default;
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}
const URL_F = `/api/flito/soat/cliente/incompletas/${ID}/factura`;
const URL_C = `/api/flito/soat/cliente/incompletas/${ID}/confirmar`;

beforeEach(() => { kdb.reset(); adjuntarMock.mockReset(); confirmarMock.mockReset(); });

describe('HU #14136 — rutas de completar una pendiente', () => {
  it('AC10: sin soat.solicitud.crear → 403 en las dos rutas', async () => {
    const app = await buildApp(); const token = await auth(['soat.solicitud.reintentar_runt']);
    expect((await request(app).post(URL_C).set('Authorization', token).send({ ...PROP, confirmado: true })).status).toBe(403);
    expect((await request(app).post(URL_F).set('Authorization', token).attach('facturaVenta', Buffer.from('%PDF-1.4'), 'f.pdf')).status).toBe(403);
    expect(confirmarMock).not.toHaveBeenCalled(); expect(adjuntarMock).not.toHaveBeenCalled();
  });

  it('AC5: sin confirmación explícita → 400 y no se llama al servicio', async () => {
    const app = await buildApp(); const token = await auth();
    for (const body of [PROP, { ...PROP, confirmado: false }, { ...PROP, confirmado: 'true' }]) {
      const r = await request(app).post(URL_C).set('Authorization', token).send(body);
      expect(r.status).toBe(400);
    }
    expect(confirmarMock).not.toHaveBeenCalled();
  });

  it('confirmar: 200 {id, estado}; campo extra → 400; id no uuid → 404; fuera de alcance (null) → 404 (AC7)', async () => {
    const app = await buildApp(); const token = await auth();
    confirmarMock.mockResolvedValueOnce({ soatId: 's1', estado: 'solicitado', vin: 'V', placa: 'P', tipoSoat: 'inicial', destino: {} });
    const ok = await request(app).post(URL_C).set('Authorization', token).send({ ...PROP, confirmado: true });
    expect(ok.status).toBe(200); expect(ok.body).toEqual({ id: 's1', estado: 'solicitado' });
    expect((await request(app).post(URL_C).set('Authorization', token).send({ ...PROP, confirmado: true, extra: 1 })).status).toBe(400);
    expect((await request(app).post('/api/flito/soat/cliente/incompletas/no-es-uuid/confirmar').set('Authorization', token).send({ ...PROP, confirmado: true })).status).toBe(404);
    confirmarMock.mockResolvedValueOnce(null);
    const r = await request(app).post(URL_C).set('Authorization', token).send({ ...PROP, confirmado: true });
    expect(r.status).toBe(404); expect(r.body).toEqual({ error: 'La solicitud no existe' });
  });

  it('AC9: el 409 de la carrera viaja con el estado', async () => {
    const app = await buildApp(); const token = await auth();
    const { IncompletaYaResueltaError } = await import('../../src/modules/flito-soat/flito-soat-incompletas-reintento.service.js');
    confirmarMock.mockRejectedValueOnce(new IncompletaYaResueltaError('completada', true, 'V', null));
    const r = await request(app).post(URL_C).set('Authorization', token).send({ ...PROP, confirmado: true });
    expect(r.status).toBe(409); expect(r.body).toMatchObject({ codigo: 'incompleta_ya_resuelta', estado: 'completada' });
  });

  it('factura: sin archivo → 400; tipo no permitido → 400 sin llegar al servicio; null → 404; VIN distinto → 422', async () => {
    const app = await buildApp(); const token = await auth();
    expect((await request(app).post(URL_F).set('Authorization', token)).status).toBe(400);
    const exe = await request(app).post(URL_F).set('Authorization', token).attach('facturaVenta', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/octet-stream' });
    expect(exe.status).toBe(400); expect(adjuntarMock).not.toHaveBeenCalled();
    adjuntarMock.mockResolvedValueOnce(null);
    expect((await request(app).post(URL_F).set('Authorization', token).attach('facturaVenta', Buffer.from('%PDF-1.4'), 'f.pdf')).status).toBe(404);
    const { VinFacturaNoCoincideError } = await import('../../src/modules/flito-soat/flito-soat-incompletas-completar.service.js');
    adjuntarMock.mockRejectedValueOnce(new VinFacturaNoCoincideError());
    const r = await request(app).post(URL_F).set('Authorization', token).attach('facturaVenta', Buffer.from('%PDF-1.4'), 'f.pdf');
    expect(r.status).toBe(422); expect(r.body.error).toBe('El VIN de la factura no coincide con el de la solicitud');
  });
});
