// Siigo — la guarda de acciones en la frontera HTTP (HU #11342, AC3, AC4 y AC6).
//
// Las rutas de operación todavía no existen: las implementa otra Feature. Para probar la guarda sin
// esperarlas se monta aquí un router SONDA con dos endpoints, que es exactamente lo que hará esa
// Feature — pedir `exigirAccionSiigo('<accion>')` y no decidir nada por su cuenta—. Si un día ese
// enganche deja de bastar, este test lo dice antes de que se escriba la primera ruta real.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { Router, type Request, type Response } from 'express';
import { testToken, type TestRole } from '../helpers/auth.js';
import type { RegistroOperacion } from '../../src/modules/siigo/siigo.operaciones.repo.js';

/** La bitácora se mockea: aquí importa QUÉ se registra, no que llegue a Postgres. */
const registrarMock = vi.fn<(r: RegistroOperacion) => Promise<void>>();
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: RegistroOperacion) => registrarMock(r) };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

async function buildApp() {
  const { authMiddleware } = await import('../../src/shared/middleware/auth.js');
  const { exigirAccionSiigo, registrarAccionSiigo } = await import('../../src/modules/siigo/siigo.permisos.js');

  const router = Router();
  router.use(authMiddleware);

  // Lectura: la bandeja que ve también auditoría.
  router.get('/facturas', exigirAccionSiigo('consultar'), (_req: Request, res: Response) => {
    res.json({ facturas: [] });
  });

  // Operación: mueve una factura. La ruta no nombra ningún rol — esa decisión no es suya.
  router.post('/facturas/:id/reintentar', exigirAccionSiigo('reintentar'), async (req: Request, res: Response) => {
    await registrarAccionSiigo(req, 'reintentar', { entidadTipo: 'factura', entidadId: req.params.id });
    res.json({ ok: true });
  });

  const app = express();
  app.use(express.json());
  app.use('/api/siigo/operacion', router);
  return app;
}

const auth = async (role: TestRole, sub = 77) =>
  `Bearer ${await testToken({ sub, username: `${role}@flit.io`, role })}`;

const ROLES_AJENOS: TestRole[] = [
  'proveedor', 'transito', 'compliance', 'lider_pesv',
  'supervisor_flota', 'conductor', 'gestor_impuestos', 'mensajero',
];

beforeEach(() => {
  registrarMock.mockReset();
  registrarMock.mockResolvedValue(undefined);
});

describe('AC3 — la decisión vive en el servidor', () => {
  it('sin token → 401 antes de mirar la tabla', async () => {
    const app = await buildApp();
    expect((await request(app).get('/api/siigo/operacion/facturas')).status).toBe(401);
  });

  it.each(ROLES_AJENOS)('%s llamando directo al endpoint → 403 igual', async (role) => {
    // El cliente se salta la interfaz: no hay nada decidido en el navegador que le sirva.
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/operacion/facturas/F-1/reintentar')
      .set('Authorization', await auth(role));
    expect(r.status).toBe(403);
  });

  it('financiera y admin sí reintentan', async () => {
    const app = await buildApp();
    for (const role of ['admin', 'financiera'] as TestRole[]) {
      const r = await request(app).post('/api/siigo/operacion/facturas/F-1/reintentar')
        .set('Authorization', await auth(role));
      expect(r.status).toBe(200);
    }
  });
});

describe('AC4 — ver y operar no son el mismo permiso', () => {
  it('auditor consulta la bandeja → 200', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/siigo/operacion/facturas')
      .set('Authorization', await auth('auditor'));
    expect(r.status).toBe(200);
  });

  it('auditor reintentando → 403 que explica que es una acción de operación', async () => {
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/operacion/facturas/F-1/reintentar')
      .set('Authorization', await auth('auditor'));

    expect(r.status).toBe(403);
    expect(r.body.error).toContain('acción de operación');
    // La acción viaja en la respuesta: la pantalla puede decir cuál se negó sin adivinarla.
    expect(r.body.accion).toBe('reintentar');
  });
});

describe('AC6 — toda acción queda atribuida, y el rechazo también', () => {
  it('la acción ejecutada guarda el usuario que la ejecutó y la entidad tocada', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/operacion/facturas/F-42/reintentar')
      .set('Authorization', await auth('financiera', 501));

    expect(registrarMock).toHaveBeenCalledTimes(1);
    const r = registrarMock.mock.calls[0]![0];
    expect(r.operacion).toBe('reintentar');
    expect(r.resultado).toBe('ok');
    expect(r.createdBy).toBe(501);
    expect(r.entidadTipo).toBe('factura');
    expect(r.entidadId).toBe('F-42');
  });

  it('el intento rechazado por permisos también queda registrado', async () => {
    const app = await buildApp();
    await request(app).post('/api/siigo/operacion/facturas/F-9/reintentar')
      .set('Authorization', await auth('auditor', 33));

    expect(registrarMock).toHaveBeenCalledTimes(1);
    const r = registrarMock.mock.calls[0]![0];
    expect(r.operacion).toBe('permiso_denegado');
    expect(r.codigo).toBe('PERMISO_DENEGADO');
    expect(r.statusHttp).toBe(403);
    expect(r.entidadId).toBe('reintentar');
    expect(r.createdBy).toBe(33);
    expect(r.mensaje).toContain('auditor');
  });

  it('el registro del rechazo NO escribe el correo del usuario', async () => {
    // La bitácora prohíbe UPDATE y DELETE por disparador: un dato personal escrito ahí ya no se
    // podría rectificar ni suprimir (Ley 1581, art. 8). Va el id numérico y el rol, nada más.
    const app = await buildApp();
    await request(app).post('/api/siigo/operacion/facturas/F-9/reintentar')
      .set('Authorization', await auth('proveedor', 12));

    const r = registrarMock.mock.calls[0]![0];
    expect(JSON.stringify(r)).not.toContain('@flit.io');
  });

  it('la consulta no ensucia la bitácora: solo se registra lo que mueve o lo que se niega', async () => {
    const app = await buildApp();
    await request(app).get('/api/siigo/operacion/facturas')
      .set('Authorization', await auth('auditor'));
    expect(registrarMock).not.toHaveBeenCalled();
  });

  it('un fallo de la bitácora no convierte el 403 en un 500', async () => {
    registrarMock.mockRejectedValue(new Error('bitácora caída'));
    const app = await buildApp();
    const r = await request(app).post('/api/siigo/operacion/facturas/F-1/reintentar')
      .set('Authorization', await auth('auditor'));
    expect(r.status).toBe(403);
  });
});
