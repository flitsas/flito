// HU #13362 (AC8/AC9) — `GET /api/flito/soat/:id/documentos-adicionales`.
//
//   TC-15 con la función y acceso → 200 con { id, etiqueta, tipoContenido, tamanoBytes, subidoEn,
//         subidoPorNombre, url } — la URL firmada con la CLAVE de storage, que nunca viaja.
//   TC-16 proveedor con la función pero sin la solicitud asignada → 404 (frontera del detalle).
//   TC-17 sin documentos → 200 [].
//   TC-18 sin la función (incluido el cliente que la creó) → 403; id que no es uuid → 404.
//
// Montaje: router real con `authMiddleware` y `exigirFuncion` reales (usuario de prueba con sus
// funciones); `buscarConAcceso`/`contextoSoat` dobles: su frontera ya tiene sus propios tests.

import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import type { SQL } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadoA, renderizar } from '../helpers/sql-ligado.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
const accesoMock = vi.hoisted(() => vi.fn());
const piiMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const firmarMock = vi.hoisted(() => vi.fn((k: string) => `/api/files?key=${encodeURIComponent(k)}&sig=x`));

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/services/storage.js', () => ({
  firmarDescargaEntidad: firmarMock, uploadEntityDocument: vi.fn(), deleteEntityDocument: vi.fn(),
}));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  contextoSoat: vi.fn(async (u: { id: number; username: string; role: string }) => ({
    userId: u.id, username: u.username, role: u.role, proyeccionCliente: false, alcance: 'todo',
  })),
  buscarConAcceso: accesoMock,
}));

const ID = '0d0c0000-0000-4000-8000-000000013362';
const T0 = new Date('2026-10-07T15:00:00Z');
const T1 = new Date('2026-10-07T15:00:05Z');
const VER = 'soat.documentos_adicionales.ver';

let sub = 13362500;
async function auth(funciones: string[], tipoEnlace = 'ninguno') {
  sub += 1;
  await registrarUsuarioDePrueba(sub, {
    rol: 'rol_prueba', tipoEnlace, excepciones: [], funcionesDelRol: ['pagina.flito_soat', ...funciones],
  });
  const t = await new SignJWT({ username: 'u@x.co', role: 'rol_prueba' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-documentos.routes.js');
  app.use('/api/flito/soat', conAlcance('soat', router));
  return app;
}

const get = async (token: string, id = ID) =>
  request(await buildApp()).get(`/api/flito/soat/${id}/documentos-adicionales`).set('Authorization', token);

const lecturaDeSoportes = () => espia.condicionesLeidas()
  .map((c) => renderizar(c as SQL)).find((q) => q.sql.includes('"flito_soportes"."soat_id"'));

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  accesoMock.mockReset().mockResolvedValue({ id: ID });
  firmarMock.mockClear();
  piiMock.mockClear();
});

describe('TC-15 — con la función y acceso a la solicitud', () => {
  it('200 con los campos del contrato; la URL firmada con la clave, que no viaja', async () => {
    kdb.when.select('flito_soportes', [
      { id: 's-1', etiqueta: 'Cédula', contentType: 'application/pdf', tamanoBytes: 1234, subidoEn: T0, subidoPorNombre: 'cliente@acme.co', storageKey: 'clientes/acme/soat/documentos-adicionales/k1.pdf' },
      { id: 's-2', etiqueta: 'Foto', contentType: 'image/heic', tamanoBytes: '99', subidoEn: T1, subidoPorNombre: 'cliente@acme.co', storageKey: 'clientes/acme/soat/documentos-adicionales/k2.heic' },
    ]);
    const r = await get(await auth([VER]));
    expect(r.status).toBe(200);
    expect(r.body.documentos).toEqual([
      { id: 's-1', etiqueta: 'Cédula', tipoContenido: 'application/pdf', tamanoBytes: 1234, subidoEn: T0.toISOString(), subidoPorNombre: 'cliente@acme.co', url: firmarMock.mock.results[0].value },
      { id: 's-2', etiqueta: 'Foto', tipoContenido: 'image/heic', tamanoBytes: 99, subidoEn: T1.toISOString(), subidoPorNombre: 'cliente@acme.co', url: firmarMock.mock.results[1].value },
    ]);
    expect(firmarMock.mock.calls.map((c) => c[0])).toEqual([
      'clientes/acme/soat/documentos-adicionales/k1.pdf', 'clientes/acme/soat/documentos-adicionales/k2.heic',
    ]);
    expect(JSON.stringify(r.body)).not.toContain('storageKey');
  });

  it('security: la entrega queda en pii_access_log (Ley 1581 art. 17) con el SOAT, las filas y el campo', async () => {
    kdb.when.select('flito_soportes', [
      { id: 's-1', etiqueta: 'Cédula', contentType: 'application/pdf', tamanoBytes: 1, subidoEn: T0, subidoPorNombre: 'c', storageKey: 'k1' },
      { id: 's-2', etiqueta: 'Foto', contentType: 'image/png', tamanoBytes: 1, subidoEn: T1, subidoPorNombre: 'c', storageKey: 'k2' },
    ]);
    const r = await get(await auth([VER]));
    expect(r.status).toBe(200);
    expect(piiMock).toHaveBeenCalledTimes(1);
    const [, entrada] = piiMock.mock.calls[0];
    expect(entrada).toEqual({
      resourceTipo: expect.any(String), resourceId: null, accion: 'read',
      camposAccedidos: ['documentos_adicionales'],
      motivo: `Lectura de SOAT — soat ${ID} · filas=2`,
    });
    expect(String(entrada.motivo)).not.toMatch(/k1|k2|Cédula/);
  });

  it('la consulta lee SOLO los adicionales vivos de ESA solicitud (SQL leído, no filas del mock)', async () => {
    kdb.when.select('flito_soportes', []);
    await get(await auth([VER]));
    const q = lecturaDeSoportes()!;
    expect(ligadoA(q, '"flito_soportes"."soat_id"')).toBe(ID);
    expect(ligadoA(q, '"flito_soportes"."tipo"')).toBe('documento_adicional_soat');
    expect(ligadoA(q, '"flito_soportes"."descartado"')).toBe(false);
    expect(accesoMock).toHaveBeenCalledWith(ID, expect.anything());
  });
});

describe('TC-16 — sin acceso a la solicitud → 404, como el detalle', () => {
  it('proveedor con la función pero sin la solicitud asignada', async () => {
    accesoMock.mockResolvedValue(null);
    const r = await get(await auth([VER], 'proveedor'));
    expect(r.status).toBe(404);
    expect(lecturaDeSoportes(), 'ni se leen los soportes').toBeUndefined();
    expect(piiMock, 'un 404 no accedió a nada').not.toHaveBeenCalled();
  });
});

describe('TC-17 — sin documentos', () => {
  it('200 con lista vacía', async () => {
    kdb.when.select('flito_soportes', []);
    const r = await get(await auth([VER]));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ documentos: [] });
    expect(piiMock, 'lista vacía: no se entregó nada').not.toHaveBeenCalled();
  });
});

describe('TC-18 — sin la función → 403', () => {
  it.each([
    ['rol interno sin la función', () => auth(['soat.solicitud.ver'])],
    ['cliente que creó la solicitud', () => auth(['soat.solicitud.crear', 'soat.solicitud.ver'], 'compania')],
  ])('%s', async (_n, token) => {
    const r = await get(await token());
    expect(r.status).toBe(403);
    expect(accesoMock).not.toHaveBeenCalled();
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('id que no es uuid → 404 sin consultar', async () => {
    const r = await get(await auth([VER]), 'no-es-uuid');
    expect(r.status).toBe(404);
    expect(accesoMock).not.toHaveBeenCalled();
  });
});
