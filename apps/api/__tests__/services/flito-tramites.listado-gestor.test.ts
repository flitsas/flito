// GET /api/flito/tramites — el listado expone el gestor (nombreGestor/correoGestor) y deja rastro PII
// (regla 16) solo cuando hay filas. `listar` se sustituye; `aFila` es el real, así que la fila sale de la
// misma proyección que usa el listado. Router REAL montado como en `app.ts` (`conAlcance`).
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';

vi.mock('../../src/db/client.js', () => ({ db: { select: vi.fn(), execute: vi.fn() }, getPoolStats: vi.fn() }));
const pii = vi.hoisted(() => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/pii-audit.js', () => pii);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: vi.fn() }));
const listarMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/flito-tramites/flito-tramites.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), listar: listarMock,
}));

const { aFila } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');

const fila = {
  tramiteId: '00000000-0000-0000-0000-0000000000c1', idFlit: 'FLIT-DEMO-102', fuente: 'flit', estadoTramite: 'activo', flitEstado: 'Asignado',
  placa: 'QTQ101', vin: '9BWZZZ377VT004252', marca: 'MAZDA', linea: 'CX-30', tipoVehiculo: 'AUTOMOVIL',
  companiaId: 42, companiaNombre: 'Gestora Uno', companiaNit: '900123456',
  soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
  tipoTramite: 'Matrícula inicial', ciudad: 'Bogotá', transitoNombreFlit: 'STT Bogotá', organismoCodigo: '11001',
  fechaCreacionFlit: new Date('2026-10-01T10:00:00Z'), creadoEn: new Date('2026-10-02T10:00:00Z'),
  fechaAprobacion: null, derechoValor: null, tipoTitularFlit: 'cc', sincronizadoEn: new Date('2026-10-03T10:00:00Z'),
  facturaVentaFlitId: null, nombreGestor: 'Marta Gómez', correoGestor: 'marta@gestora.co',
  soatId: null, impuestoId: null,
};

async function app() {
  const a = express();
  a.use(express.json());
  const { default: router } = await import('../../src/modules/flito-tramites/flito-tramites.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/tramites', conAlcance('tramites', router));
  a.use(errorHandler);
  return a;
}
let sub = 320_000;
const admin = async () => `Bearer ${await testToken({ sub: ++sub, role: 'admin' })}`;

beforeEach(() => { listarMock.mockReset(); pii.logPiiAccess.mockClear(); });

describe('GET /api/flito/tramites — gestor y rastro PII', () => {
  it('con filas: la fila trae el gestor y se registra la lectura con los campos del titular y del gestor', async () => {
    listarMock.mockResolvedValue({ items: [aFila(fila as never, [])], total: 1 });
    const r = await request(await app()).get('/api/flito/tramites').set('Authorization', await admin());
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ nombreGestor: 'Marta Gómez', correoGestor: 'marta@gestora.co' });
    expect(pii.logPiiAccess).toHaveBeenCalledTimes(1);
    const opts = pii.logPiiAccess.mock.calls[0]![1];
    expect(opts).toMatchObject({
      resourceTipo: 'flito_tramites', accion: 'read',
      camposAccedidos: ['nombre_completo', 'correo', 'nombre_gestor', 'correo_gestor'],
    });
    expect(JSON.stringify(opts)).not.toContain('Marta');
  });

  it('lista vacía: no hay datos del titular que registrar', async () => {
    listarMock.mockResolvedValue({ items: [], total: 0 });
    const r = await request(await app()).get('/api/flito/tramites').set('Authorization', await admin());
    expect(r.status).toBe(200);
    expect(pii.logPiiAccess).not.toHaveBeenCalled();
  });
});
