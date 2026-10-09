// HU #13425 (Feature #13414, Épica #13411) — Fase B: las reglas que quedaban DENTRO de los handlers de
// jornadas/, pesv/ y drivers/ deciden por función del motor, no por el nombre del rol. Mismo arnés que
// `pesv.permisos-por-item.test.ts` (motor real con el double de filas de `helpers/auth.ts`):
//
//   · Jornada de otro conductor: `jornadas.control.administrar`. Un rol LLAMADO `admin` sin ella → 403;
//     un rol cualquiera con ella → pasa la regla. La propia jornada no la exige.
//   · Vista de auditoría del diagnóstico: `pesv.diagnostico_consulta.administrar` la abre; quien consulta
//     y no administra (`pesv.diagnostico.administrar`) recibe la sugerencia `X-Redirect-To`. Un rol
//     LLAMADO `compliance` sin la función ya no la abre.
//   · Aviso de alarmas de jornada (`getAdminEmails`): los titulares de `jornadas.control.administrar`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import { chain } from '../helpers/db.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const executeMock = vi.fn();
const transactionMock = vi.fn();
const usuariosConFuncionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock, execute: executeMock, transaction: transactionMock },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));
// Solo `usuariosConFuncion` es doble: `resolverPermisos` (lo que decide `tieneFuncion`) sigue real.
vi.mock('../../src/shared/permisos-efectivos.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/permisos-efectivos.js')>()),
  usuariosConFuncion: (...a: unknown[]) => usuariosConFuncionMock(...a),
}));

let app: any;
beforeEach(async () => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset();
  deleteMock.mockReset(); executeMock.mockReset(); transactionMock.mockReset();
  usuariosConFuncionMock.mockReset();
  executeMock.mockResolvedValue([]);
  selectMock.mockImplementation(() => chain([]));
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

/** Un usuario con EXACTAMENTE estas funciones en su rol (nombre de rol a elección). */
async function usuario(sub: number, rol: string, funciones: string[]): Promise<string> {
  await registrarUsuarioDePrueba(sub, { rol, tipoEnlace: 'ninguno', funcionesDelRol: funciones, excepciones: [] });
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const jwt = await new SignJWT({ username: `u${sub}`, role: rol })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub)).setExpirationTime('1h').sign(secret);
  return `Bearer ${jwt}`;
}

describe('jornada de OTRO conductor — `jornadas.control.administrar`, no el nombre `admin`', () => {
  it('rol LLAMADO admin sin la función → 403 al leer la jornada abierta de otro, sin consultarla', async () => {
    const auth = await usuario(9301, 'admin', ['pagina.pesv_mi_jornada']);
    const r = await request(app).get('/api/jornadas/abierta?conductorId=77').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'No autorizado' });
  });

  it('rol cualquiera CON la función → pasa la regla (404 «Sin jornada abierta», no 403)', async () => {
    const auth = await usuario(9302, 'supervisor_flota', ['pagina.pesv_mi_jornada', 'jornadas.control.administrar']);
    const r = await request(app).get('/api/jornadas/abierta?conductorId=77').set('Authorization', auth);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Sin jornada abierta' });
  });

  it('la PROPIA jornada no exige la función', async () => {
    const auth = await usuario(9303, 'conductor', ['pagina.pesv_mi_jornada']);
    const r = await request(app).get('/api/jornadas/abierta').set('Authorization', auth);
    expect(r.status).toBe(404);
  });

  it('abrir en nombre de otro: sin la función → 403 aunque el rol se llame admin', async () => {
    const auth = await usuario(9304, 'admin', ['pagina.pesv_mi_jornada']);
    const r = await request(app).post('/api/jornadas/abrir').set('Authorization', auth)
      .set('Idempotency-Key', 'idem-13425-0001').send({ conductorId: 77 });
    expect(r.status).toBe(403);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('detalle de la jornada de otro: sin la función → 403 aunque el rol se llame admin; con ella → 200', async () => {
    selectMock.mockImplementation(() => chain([{ id: 5, conductorId: 77, cerrada: false }]));
    const sin = await usuario(9305, 'admin', ['pagina.pesv_jornadas']);
    expect((await request(app).get('/api/jornadas/5').set('Authorization', sin)).status).toBe(403);
    const con = await usuario(9306, 'lider_pesv', ['pagina.pesv_jornadas', 'jornadas.control.administrar']);
    expect((await request(app).get('/api/jornadas/5').set('Authorization', con)).status).toBe(200);
  });
});

describe('vista de auditoría del diagnóstico PESV — por función', () => {
  const DIAG = { id: 1, anio: 2026, estado: 'borrador' };

  it('rol LLAMADO compliance sin `pesv.diagnostico_consulta.administrar` → 403 en view=auditoria', async () => {
    selectMock.mockImplementation(() => chain([DIAG]));
    const auth = await usuario(9311, 'compliance', ['pagina.pesv_diagnostico']);
    const r = await request(app).get('/api/pesv/diagnostico/1?view=auditoria').set('Authorization', auth);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Sin permisos para vista auditoría' });
  });

  it('rol cualquiera con la función de consulta → abre la vista de auditoría (no 403)', async () => {
    selectMock.mockImplementation(() => chain([DIAG]));
    const auth = await usuario(9312, 'conductor', ['pagina.pesv_diagnostico', 'pesv.diagnostico_consulta.administrar']);
    const r = await request(app).get('/api/pesv/diagnostico/1?view=auditoria').set('Authorization', auth);
    expect(r.status).not.toBe(403);
  });

  it('consulta sin administrar → se le sugiere la vista de auditoría (X-Redirect-To)', async () => {
    selectMock.mockImplementation(() => chain([DIAG]));
    const auth = await usuario(9313, 'revisor', ['pagina.pesv_diagnostico', 'pesv.diagnostico_consulta.administrar']);
    const r = await request(app).get('/api/pesv/diagnostico/1').set('Authorization', auth);
    expect(r.headers['x-redirect-to']).toBe('/pesv/diagnostico/1/auditoria');
  });

  it('consulta Y administra → sin sugerencia; rol LLAMADO compliance sin consulta → tampoco', async () => {
    selectMock.mockImplementation(() => chain([DIAG]));
    const lider = await usuario(9314, 'lider_pesv', ['pagina.pesv_diagnostico', 'pesv.diagnostico_consulta.administrar', 'pesv.diagnostico.administrar']);
    expect((await request(app).get('/api/pesv/diagnostico/1').set('Authorization', lider)).headers['x-redirect-to']).toBeUndefined();
    const nombre = await usuario(9315, 'compliance', ['pagina.pesv_diagnostico']);
    expect((await request(app).get('/api/pesv/diagnostico/1').set('Authorization', nombre)).headers['x-redirect-to']).toBeUndefined();
  });
});

describe('aviso de alarmas de jornada — titulares de `jornadas.control.administrar`', () => {
  it('getAdminEmails pide los titulares de la función y lee SUS correos', async () => {
    usuariosConFuncionMock.mockResolvedValueOnce([4, 8]);
    selectMock.mockImplementationOnce(() => chain([{ email: 'jefe@x.com' }]));
    const { getAdminEmails } = await import('../../src/modules/jornadas/notify.js');
    expect(await getAdminEmails()).toEqual(['jefe@x.com']);
    expect(usuariosConFuncionMock).toHaveBeenCalledWith('jornadas.control.administrar');
  });

  it('nadie con la función → lista vacía, sin consultar correos', async () => {
    usuariosConFuncionMock.mockResolvedValueOnce([]);
    const { getAdminEmails } = await import('../../src/modules/jornadas/notify.js');
    expect(await getAdminEmails()).toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
