// HU #14018 (Feature #14012) — AC6: la búsqueda y el detalle de incompletas devuelven tipoSoat, modalidadConsulta,
// placa y motivoPendiente; `vin` y `factura` pueden venir null (renovación por placa sin factura).
// Los filtros con PII viajan en el BODY (rutas POST …/buscar); la lectura anota la placa como token HMAC.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { registrarUsuarioDePrueba, soloEstas } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const kdb = createKeyedDb();
const piiMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));

const COMPANIA = 7;
const ID = '1c0a0000-0000-4000-8000-00000000aa01';
const VIN = '9BWZZZ377VT004251';
const T0 = new Date('2026-09-27T15:00:00Z');
const T1 = new Date('2026-09-28T10:00:00Z');

let sub = 14018_80;

async function auth(opts: { tipoEnlace: string; funciones: string[]; rol?: string }) {
  sub += 1;
  const rol = opts.rol ?? 'rol_prueba';
  // HU #13429: «tiene EXACTAMENTE estas operaciones» (su acción con su cadena, y las hermanas revocadas).
  await registrarUsuarioDePrueba(sub, { rol, tipoEnlace: opts.tipoEnlace, ...soloEstas(['pagina.flito_soat', ...opts.funciones]) });
  const t = await new SignJWT({ username: 'u@x.co', role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

const LECTURA = ['soat.incompletas.buscar', 'soat.incompleta.ver'];
const clienteCompania = () => auth({ tipoEnlace: 'compania', funciones: LECTURA });

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-incompletas.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}

const filaIncompleta = {
  id: ID, estado: 'incompleta', vin: VIN, companiaId: COMPANIA, companiaNombre: 'Motos SAS',
  placa: null, tipoSoat: 'inicial', modalidadConsulta: 'vin', motivoPendiente: 'runt_sin_respuesta',
  titular: 'ANA PÉREZ', solicitadoPorNombre: 'ana@motos.co', solicitadoEn: T0, intentos: 2,
  ultimoIntentoEn: T1, motivoDescarte: null, resueltaEn: null, resueltaPorId: null,
  resueltaPorNombre: null, soatId: null,
  facturaNombreArchivo: 'factura.pdf', facturaContentType: 'application/pdf', facturaTamanoBytes: 1234,
};
const propietario = {
  tipoDocumento: 'CC', nombres: 'ANA', apellidos: 'PÉREZ', razonSocial: null, numeroDocumento: '1020304050',
  correo: 'ana@x.co', celular: '3001234567', direccion: 'Cra 1 # 2-3', municipio: 'Bogotá', departamento: 'Cundinamarca',
  // Columna que el select NO pide: el mock la devuelve igual; el DTO no debe publicarla.
  procedencia: { nombres: 'runt' },
};

const URL_BUSCAR = '/api/flito/soat/cliente/incompletas/buscar';

beforeEach(() => { kdb.reset(); piiMock.mockClear(); });
const PLACA = 'JNH38H';
const filaRenovacion = {
  ...filaIncompleta, vin: null, placa: PLACA, tipoSoat: 'renovacion', modalidadConsulta: 'placa',
  motivoPendiente: 'runt_sin_respuesta',
};

describe('AC6 — búsqueda y detalle de una incompleta de renovación', () => {
  it('la búsqueda devuelve tipoSoat, modalidadConsulta, placa y motivoPendiente, con vin null', async () => {
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [{ estado: 'incompleta', n: 1 }])
      .selectOnce('flito_soat_incompletas', [filaRenovacion]);
    const r = await request(await buildApp()).post(URL_BUSCAR)
      .set('Authorization', await clienteCompania())
      .send({ estados: ['incompleta'], texto: PLACA });
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({
      vin: null, placa: PLACA, tipoSoat: 'RENOVACION', modalidadConsulta: 'placa', motivoPendiente: 'runt_sin_respuesta',
    });
    // El filtro con PII (placa) va en el body: la ruta no lee query.
    expect(URL_BUSCAR).not.toContain('?');
    expect(piiMock).toHaveBeenCalledTimes(1);
  });

  it('el detalle sin factura: factura null; la lectura se anota con la placa como token HMAC, nunca en claro', async () => {
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [{
        ...filaRenovacion, facturaNombreArchivo: null, facturaContentType: null, facturaTamanoBytes: null,
      }])
      .selectOnce('flito_compradores', [propietario]);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID}`)
      .set('Authorization', await clienteCompania());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ vin: null, placa: PLACA, tipoSoat: 'RENOVACION', modalidadConsulta: 'placa' });
    expect(r.body.factura).toBeNull();
    const [, acceso] = piiMock.mock.calls[0];
    expect(acceso.motivo).toMatch(/placa=v1:/);
    expect(acceso.motivo).not.toContain(PLACA);
    expect(acceso.camposAccedidos).toContain('placa');
  });

  it('una incompleta Inicial sigue devolviendo vin y factura como hoy', async () => {
    kdb.when
      .selectOnce('users', [{ c: COMPANIA, p: null }])
      .selectOnce('flito_soat_incompletas', [{ estado: 'incompleta', n: 1 }])
      .selectOnce('flito_soat_incompletas', [filaIncompleta]);
    const r = await request(await buildApp()).post(URL_BUSCAR)
      .set('Authorization', await clienteCompania()).send({ estados: ['incompleta'] });
    expect(r.body.items[0]).toMatchObject({ vin: VIN, placa: null, tipoSoat: 'INICIAL', modalidadConsulta: 'vin' });
  });
});
