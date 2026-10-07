// HU #13409 AC8 — `GET /api/flito/soat/cliente/incompletas/:id` informa `archivosPurgadosEn`
// (ISO de la purga por retención, o null).
//
// El mock `chain` devuelve la fila ENTERA aunque el select pida menos, así que además del valor en el
// body se aserta que la proyección del select PIDE la columna (espía sobre `db.select`): sin eso,
// quitar `archivosPurgadosEn` del select dejaría el test verde contra el mock y null en producción.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { getTableColumns } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));

const ID = '13409000-0000-4000-8000-0000000000d1';
const T0 = new Date('2026-08-01T15:00:00Z');
const T_DESC = new Date('2026-09-01T10:00:00Z');
const T_PURGA = new Date('2026-10-07T08:00:12Z');

let sub = 13409;
async function operaciones() {
  sub += 1;
  const rol = 'rol_prueba';
  await registrarUsuarioDePrueba(sub, {
    rol, tipoPrincipal: 'interno', tipoEnlace: 'ninguno', excepciones: [],
    funcionesDelRol: ['pagina.flito_soat', 'soat.incompletas.buscar', 'soat.incompleta.ver'],
  });
  const t = await new SignJWT({ username: 'op@flit.co', role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-incompletas.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

const filaDescartada = (archivosPurgadosEn: Date | null) => ({
  id: ID, estado: 'descartada', vin: '9BWZZZ377VT004251', companiaId: 7, companiaNombre: 'Motos SAS',
  titular: 'ANA PÉREZ', solicitadoPorNombre: 'ana@motos.co', solicitadoEn: T0, intentos: 1,
  ultimoIntentoEn: T0, motivoDescarte: 'soat_vigente', resueltaEn: T_DESC, resueltaPorId: 50,
  resueltaPorNombre: 'Pedro Operaciones', soatId: null,
  facturaNombreArchivo: 'factura.pdf', facturaContentType: 'application/pdf', facturaTamanoBytes: 1234,
  archivosPurgadosEn,
});

/** ¿Algún `db.select` pidió la columna `archivos_purgados_en` en su proyección? */
function proyeccionPidePurga(spy: { mock: { calls: unknown[][] } }): boolean {
  return spy.mock.calls.some((args) => {
    const p = args[0] as Record<string, unknown> | undefined;
    const col = p?.archivosPurgadosEn as { name?: string } | undefined;
    return col?.name === 'archivos_purgados_en';
  });
}

beforeEach(() => { kdb.reset(); });

describe('AC8 — archivosPurgadosEn en el detalle', () => {
  it('TC8.1 purgada: 200 con la fecha ISO de la purga, y el select pide la columna', async () => {
    const spy = vi.spyOn(kdb.db as unknown as { select: (...a: unknown[]) => unknown }, 'select');
    kdb.when
      .selectOnce('flito_soat_incompletas', [filaDescartada(T_PURGA)])
      .selectOnce('flito_compradores', []);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID}`)
      .set('Authorization', await operaciones());
    expect(r.status).toBe(200);
    expect(r.body.archivosPurgadosEn).toBe(T_PURGA.toISOString());
    // El descarte se conserva junto a la marca.
    expect(r.body.descarte).toEqual({ motivo: 'soat_vigente', en: T_DESC.toISOString(), porNombre: 'Pedro Operaciones' });
    expect(proyeccionPidePurga(spy)).toBe(true);
    spy.mockRestore();
  });

  it('TC8.2 no purgada: la clave está presente y vale null', async () => {
    kdb.when
      .selectOnce('flito_soat_incompletas', [filaDescartada(null)])
      .selectOnce('flito_compradores', []);
    const r = await request(await buildApp()).get(`/api/flito/soat/cliente/incompletas/${ID}`)
      .set('Authorization', await operaciones());
    expect(r.status).toBe(200);
    expect('archivosPurgadosEn' in r.body).toBe(true);
    expect(r.body.archivosPurgadosEn).toBeNull();
  });

  it('la columna está declarada en el esquema Drizzle de la tabla', async () => {
    const { flitoSoatIncompletas } = await import('../../src/db/schema.js');
    expect(getTableColumns(flitoSoatIncompletas).archivosPurgadosEn.name).toBe('archivos_purgados_en');
  });
});
