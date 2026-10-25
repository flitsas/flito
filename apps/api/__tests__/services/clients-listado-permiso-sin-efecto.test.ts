// HU #13967 (AC7) — `GET /clients` entrega `permisoSinTramiteSinEfecto`: la compañía NO tiene proveedor
// de SOAT sin trámite y algún usuario suyo ya tiene `soat.solicitud.crear` (un permiso que no surte
// efecto). Solo el booleano: ningún dato de usuario. `companiasConUsuarioConFuncion` se consulta SOLO
// con los ids de la página que no tienen proveedor; si no hay ninguno, no se consulta.
//
// La semántica de la función (cadena, revocar gana, enlace) la compara con el resolutor
// `permisos.companias-con-funcion.test.ts`; aquí se mide el cableado de la ruta.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const { selectMock, companiasMock } = vi.hoisted(() => ({ selectMock: vi.fn(), companiasMock: vi.fn() }));

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/permisos-efectivos.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/permisos-efectivos.js')>()),
  companiasConUsuarioConFuncion: companiasMock,
}));

const GESTOR = '55555555-5555-4555-8555-555555555555';

/** Fila del listado unido: `soatSinTramite` llega CALCULADO (proveedor no nulo). */
const fila = (id: number, conProveedor: boolean) => ({
  id, name: `Compania ${id}`, document: `90000000${id}`, soatSinTramite: conProveedor,
  gestorSinTramiteId: conProveedor ? GESTOR : null,
  gestorSinTramiteNombre: conProveedor ? 'SEGUROS DEL ESTADO' : null,
  gestorSinTramiteActivo: conProveedor ? true : null,
});

async function listar(filas: unknown[]) {
  selectMock.mockReturnValueOnce(chain(filas));
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return request(app).get('/api/clients').set('Authorization', `Bearer ${await testToken({ sub: 7, role: 'admin' })}`);
}

beforeEach(() => {
  selectMock.mockReset();
  companiasMock.mockReset();
});

describe('AC7 — `permisoSinTramiteSinEfecto` en el listado de clientes', () => {
  it('**true solo si NO hay proveedor y algún usuario de la compañía tiene la función**', async () => {
    companiasMock.mockResolvedValueOnce(new Set([2]));
    const r = await listar([fila(1, true), fila(2, false), fila(3, false)]);

    expect(r.status).toBe(200);
    const porId = Object.fromEntries(r.body.map((c: { id: number; permisoSinTramiteSinEfecto: boolean }) => [c.id, c.permisoSinTramiteSinEfecto]));
    expect(porId).toEqual({ 1: false, 2: true, 3: false });
  });

  it('**se consulta solo con los ids de la página SIN proveedor**, y por la función del canal', async () => {
    companiasMock.mockResolvedValueOnce(new Set());
    await listar([fila(1, true), fila(2, false), fila(3, false)]);

    expect(companiasMock).toHaveBeenCalledTimes(1);
    expect(companiasMock).toHaveBeenCalledWith('soat.solicitud.crear', [2, 3]);
  });

  it('**todas con proveedor → todas en false y NO se consulta**', async () => {
    const r = await listar([fila(1, true), fila(4, true)]);

    expect(companiasMock).not.toHaveBeenCalled();
    expect(r.body.map((c: { permisoSinTramiteSinEfecto: boolean }) => c.permisoSinTramiteSinEfecto)).toEqual([false, false]);
  });

  it('una compañía CON proveedor nunca sale en true, aunque la función la devolviera', async () => {
    companiasMock.mockResolvedValueOnce(new Set([1, 2]));
    const r = await listar([fila(1, true), fila(2, false)]);

    expect(r.body[0].permisoSinTramiteSinEfecto).toBe(false);
    expect(r.body[1].permisoSinTramiteSinEfecto).toBe(true);
  });

  it('**sin datos de usuarios**: solo el booleano se añade a la fila', async () => {
    companiasMock.mockResolvedValueOnce(new Set([2]));
    const r = await listar([fila(2, false)]);

    expect(Object.keys(r.body[0]).sort()).toEqual(
      ['document', 'gestorSoatSinTramite', 'id', 'name', 'permisoSinTramiteSinEfecto', 'soatSinTramite'],
    );
    expect(JSON.stringify(r.body)).not.toMatch(/user|usuario|username|email/i);
  });
});
