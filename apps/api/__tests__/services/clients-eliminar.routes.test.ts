// HU #13954 (Feature #13943, Épica #13671) — `DELETE /api/clients/:id` con la base mockeada.
//
// Mide la RUTA y el servicio real sobre una transacción simulada: guarda (AC7), mapeo 404/409 (AC10/AC8/AC2-AC4),
// limpieza de la caché de sesión tras el commit, auditoría con el nombre enmascarado (AC1), el orden de las
// condiciones (`motivoNoEliminable`) y el formato de pesos. Lo mismo contra PostgreSQL de verdad (baja de usuarios,
// AC9) en `__tests__/db/clientes-eliminar.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock,
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/modules/flito-sync/liberar-retenidos.js', () => ({ liberarTramitesRetenidos: vi.fn() }));

// El seguro anti-bloqueo y la bitácora de permisos se miden contra PostgreSQL; aquí, la escritura pasa tal cual.
const seguroMock = vi.fn(async (_tx: unknown, escritura: () => Promise<unknown>) => escritura());
vi.mock('../../src/shared/permisos-anti-bloqueo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/permisos-anti-bloqueo.js')>()),
  conSeguroAntiBloqueo: seguroMock,
}));
const bitacoraMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/historial/permisos-auditoria.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/historial/permisos-auditoria.js')>()),
  registrarCambiosPermisos: bitacoraMock,
}));

const invalidateMock = vi.fn();
vi.mock('../../src/shared/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/middleware/auth.js')>()),
  invalidateSessionCacheFor: invalidateMock,
}));

const { BloqueoAdministracionError } = await import('../../src/shared/permisos-anti-bloqueo.js');
const { formatoPesos, motivoNoEliminable } = await import('../../src/modules/clients/clients.service.js');

beforeEach(() => {
  transactionMock.mockReset();
  auditMock.mockClear();
  invalidateMock.mockClear();
  bitacoraMock.mockClear();
  seguroMock.mockClear();
});

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/clients/clients.routes.js');
  app.use('/api/clients', router);
  return app;
}

const adminToken = () => testToken({ sub: 1, role: 'admin', funciones: ['clients.clientes.eliminar'] });
/** Auditor: ve clientes pero no tiene la exclusiva del Administrador «Eliminar clientes». */
const sinFuncionToken = () => testToken({ sub: 2, role: 'auditor' });

interface Escenario {
  vigente?: boolean;
  /** `deleted_at` que ve el `FOR UPDATE` (otro administrador lo eliminó mientras se esperaba el bloqueo). */
  eliminadoAlBloquear?: boolean;
  activo?: boolean;
  procesos?: [number, number, number, number];
  saldo?: string | null;
  usuarios?: { id: number; role: string }[];
}

/**
 * La transacción del servicio. Orden de `tx.select`: vigente → FOR UPDATE de clients → FOR UPDATE de la bolsa → el
 * cliente del impacto → los 6 conteos del impacto (soat, impuestos, trámites, liquidaciones, bolsa, usuarios).
 */
function prepararTx(e: Escenario = {}) {
  const txSelect = vi.fn();
  const txUpdate = vi.fn();
  const [soat, imp, tra, liq] = e.procesos ?? [0, 0, 0, 0];
  const saldo = e.saldo === undefined ? '0' : e.saldo;
  const colas: unknown[][] = [
    e.vigente === false ? [] : [{ id: 5 }],
    [{ name: 'Transportes Andinos SAS', deletedAt: e.eliminadoAlBloquear ? new Date() : null }],
    saldo === null ? [] : [{ id: 'b1' }],
    [{ active: e.activo ?? false }],
    [{ total: soat }], [{ total: imp }], [{ total: tra }], [{ total: liq }],
    saldo === null ? [] : [{ saldo }],
    [{ total: (e.usuarios ?? []).length }],
  ];
  for (const c of colas) txSelect.mockReturnValueOnce(chain(c));
  txUpdate.mockReturnValueOnce(chain([])); // clients
  txUpdate.mockReturnValueOnce(chain(e.usuarios ?? [])); // users … returning
  transactionMock.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => fn({ select: txSelect, update: txUpdate }));
  return { txSelect, txUpdate };
}

const borrar = async (app: express.Express, id: string | number, token?: string) =>
  request(app).delete(`/api/clients/${id}`).set('Authorization', `Bearer ${token ?? await adminToken()}`);

describe('DELETE /api/clients/:id', () => {
  it('AC1: inactivo, sin procesos, bolsa en $0 y 2 usuarios → 200, baja de los 2, caché limpia y auditoría enmascarada', async () => {
    const { txUpdate } = prepararTx({ usuarios: [{ id: 11, role: 'cliente' }, { id: 12, role: 'cliente' }] });
    const r = await borrar(await buildApp(), 5);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 5, eliminado: true });
    expect(txUpdate).toHaveBeenCalledTimes(2); // clients (baja lógica) + users; nunca delete
    expect(seguroMock).toHaveBeenCalledTimes(1);
    expect(bitacoraMock.mock.calls[0]![2]).toHaveLength(2);
    expect(bitacoraMock.mock.calls[0]![2][0]).toMatchObject({ entidad: 'usuario', accion: 'baja', campo: 'deleted_at' });
    expect(invalidateMock.mock.calls.map((c) => c[0])).toEqual([11, 12]);
    const entrada = auditMock.mock.calls[0]![1];
    expect(entrada).toMatchObject({ action: 'delete', resource: 'client', resourceId: '5' });
    expect(entrada.detail).toBe('Cliente eliminado: Tra*** · usuarios dados de baja: 2');
    expect(entrada.detail).not.toContain('Transportes');
  });

  it('AC2: activo → 409 «Primero debe desactivarlo.» sin escribir ni auditar', async () => {
    const { txUpdate } = prepararTx({ activo: true, saldo: '50000' });
    const r = await borrar(await buildApp(), 5);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Primero debe desactivarlo.');
    expect(txUpdate).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('AC3: 1 SOAT y 1 liquidación abiertos → 409 con el desglose', async () => {
    const { txUpdate } = prepararTx({ procesos: [1, 0, 0, 1] });
    const r = await borrar(await buildApp(), 5);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Tiene 2 procesos abiertos (SOAT: 1, impuestos: 0, trámites: 0, liquidaciones: 1).');
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC4/AC9: saldo ≠ 0 leído tras el bloqueo → 409 con el saldo en pesos', async () => {
    const { txUpdate } = prepararTx({ saldo: '-20000.00' });
    const r = await borrar(await buildApp(), 5);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Su bolsa tiene saldo de -$20.000; debe quedar en cero.');
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('AC8: otro administrador lo eliminó mientras se esperaba el bloqueo → 409 «Otro administrador ya cambió su estado»', async () => {
    const { txUpdate } = prepararTx({ eliminadoAlBloquear: true });
    const r = await borrar(await buildApp(), 5);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Otro administrador ya cambió su estado');
    expect(txUpdate).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC10: inexistente o ya eliminado → 404 «Cliente no encontrado»', async () => {
    prepararTx({ vigente: false });
    const r = await borrar(await buildApp(), 999);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Cliente no encontrado');
  });

  // Como en `/estado` (HU #13945): el 403 es el canónico de `exigirFuncion` (texto según el motivo de la denegación),
  // no el literal «Sin permisos» de las guardas en línea del módulo. Se mide la regla: 403 y nada cambia.
  it('AC7: sin `clients.clientes.eliminar` → 403 y no se abre la transacción', async () => {
    const r = await borrar(await buildApp(), 5, await sinFuncionToken());
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: expect.any(String), funcion: 'clients.clientes.eliminar' });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('el seguro anti-bloqueo rechaza (dejaría sin administrador) → 409 y no se audita la eliminación', async () => {
    prepararTx({ usuarios: [{ id: 11, role: 'admin' }] });
    seguroMock.mockImplementationOnce(async () => { throw new BloqueoAdministracionError('usuarios.usuarios.gestionar'); });
    const r = await borrar(await buildApp(), 5);
    expect(r.status).toBe(409);
    expect(r.body.funcion).toBe('usuarios.usuarios.gestionar');
    expect(auditMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('id inválido → 400 sin tocar la base', async () => {
    const r = await borrar(await buildApp(), 'abc');
    expect(r.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('motivoNoEliminable / formatoPesos (RN-CLI-10)', () => {
  const base = { activo: false, procesosAbiertos: { soat: 0, impuestos: 0, tramites: 0, liquidaciones: 0 }, saldoBolsa: 0 };

  it('el orden manda: activo antes que procesos, procesos antes que saldo', () => {
    const todo = { activo: true, procesosAbiertos: { soat: 1, impuestos: 0, tramites: 0, liquidaciones: 0 }, saldoBolsa: 5 };
    expect(motivoNoEliminable(todo)).toBe('Primero debe desactivarlo.');
    expect(motivoNoEliminable({ ...todo, activo: false })).toBe('Tiene 1 proceso abierto (SOAT: 1, impuestos: 0, trámites: 0, liquidaciones: 0).');
    expect(motivoNoEliminable({ ...base, saldoBolsa: 5 })).toBe('Su bolsa tiene saldo de $5; debe quedar en cero.');
    expect(motivoNoEliminable(base)).toBeNull();
  });

  it('pesos sin decimales y con punto de miles', () => {
    expect(formatoPesos(-20000)).toBe('-$20.000');
    expect(formatoPesos(1500000)).toBe('$1.500.000');
    expect(formatoPesos(999)).toBe('$999');
    expect(formatoPesos(250000.75)).toBe('$250.001');
  });
});
