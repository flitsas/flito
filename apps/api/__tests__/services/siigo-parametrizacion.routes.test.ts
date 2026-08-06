// HU #11281 — endpoints de parametrización contable de Siigo (AC7, Feature #11239).
//
// AC7 tiene dos mitades y la segunda es la que suele olvidarse: no basta con devolver 403, hay que
// demostrar que la petición NO llegó a salir hacia Siigo. Un handler que llama al servicio y luego
// comprueba el rol ya habría gastado cuota de las 100 peticiones por minuto antes de rechazar.
//
// Por eso cada prueba de permiso afirma también que el servicio de catálogos no se invocó: es la
// frontera exacta detrás de la cual vive la única llamada a Siigo de este módulo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { adminAuth, proveedorAuth, testToken } from '../helpers/auth.js';

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

vi.mock('../../src/shared/middleware/rateLimiter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/middleware/rateLimiter.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, apiLimiter: passthrough, authLimiter: passthrough, qrPublicLimiter: passthrough };
});

vi.mock('../../src/shared/redis.ts', () => ({
  getRedis: () => null,
  closeRedis: vi.fn().mockResolvedValue(undefined),
  redisHealthy: vi.fn().mockResolvedValue(false),
}));

const auditMock = vi.fn();
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const sincronizarCatalogosMock = vi.fn();
const leerCatalogoMock = vi.fn();
const resumenCatalogosMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.catalogos.service.js', () => ({
  sincronizarCatalogos: sincronizarCatalogosMock,
  leerCatalogo: leerCatalogoMock,
  resumenCatalogos: resumenCatalogosMock,
}));

const financieraAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'financiera' })}`;
const auditorAuth = async (): Promise<string> => `Bearer ${await testToken({ role: 'auditor' })}`;

const RESULTADO_OK = {
  ok: true, parcial: false, vaciadoMasivo: false,
  ambiente: 'pruebas', modo: 'mock', duracionMs: 12,
  catalogos: [{
    tipo: 'tax', etiqueta: 'Impuestos', ok: true, total: 5, inactivados: 0, vaciadoMasivo: false,
    sincronizadoEn: '2026-08-05T10:00:00.000Z', error: null, duracionMs: 3,
  }],
};

/** Ninguna llamada a Siigo pudo ocurrir si ninguna de estas funciones se invocó. */
function nadieLlamoASiigo(): void {
  expect(sincronizarCatalogosMock).not.toHaveBeenCalled();
}

let app: ReturnType<typeof import('../../src/app.js').createApp>;

beforeEach(async () => {
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
  sincronizarCatalogosMock.mockReset();
  leerCatalogoMock.mockReset();
  resumenCatalogosMock.mockReset();

  sincronizarCatalogosMock.mockResolvedValue(RESULTADO_OK);
  resumenCatalogosMock.mockResolvedValue([]);
  leerCatalogoMock.mockResolvedValue({
    tipo: 'tax', etiqueta: 'Impuestos', sincronizadoEn: null, elementos: [],
  });

  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

describe('AC7 — solo quien administra la parametrización sincroniza', () => {
  it('sin token la sincronización se rechaza y no llega a Siigo', async () => {
    const r = await request(app).post('/api/siigo/parametrizacion/catalogos/sincronizar').send({});

    expect(r.status).toBe(401);
    nadieLlamoASiigo();
  });

  it('un rol sin permiso sobre la parametrización recibe 403 y no dispara nada', async () => {
    const r = await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await proveedorAuth())
      .send({});

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Sin permisos');
    nadieLlamoASiigo();
  });

  it('financiera puede leer pero NO sincronizar', async () => {
    const r = await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await financieraAuth())
      .send({});

    expect(r.status).toBe(403);
    nadieLlamoASiigo();
  });

  it('auditor tampoco: leer la parametrización no es su función aquí', async () => {
    const r = await request(app)
      .get('/api/siigo/parametrizacion/catalogos')
      .set('Authorization', await auditorAuth());

    expect(r.status).toBe(403);
    expect(resumenCatalogosMock).not.toHaveBeenCalled();
  });

  it('admin sí sincroniza', async () => {
    const r = await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await adminAuth())
      .send({});

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ambiente: 'pruebas' });
    expect(sincronizarCatalogosMock).toHaveBeenCalledTimes(1);
    expect(sincronizarCatalogosMock.mock.calls[0]![0]).toMatchObject({ usuarioId: 1 });
  });

  it('la sincronización queda auditada con el ambiente y los catálogos fallidos', async () => {
    await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await adminAuth())
      .send({});

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({
      action: 'update', resource: 'siigo_catalogos', resourceId: 'pruebas',
    });
    expect(auditMock.mock.calls[0]![1].detail).toMatch(/fallidos=ninguno/);
  });
});

describe('lectura de la copia local', () => {
  it('sin token responde 401', async () => {
    const r = await request(app).get('/api/siigo/parametrizacion/catalogos');
    expect(r.status).toBe(401);
  });

  it('admin obtiene el resumen de los catálogos', async () => {
    resumenCatalogosMock.mockResolvedValue([
      { tipo: 'tax', etiqueta: 'Impuestos', total: 4, activos: 3, sincronizadoEn: null },
    ]);

    const r = await request(app)
      .get('/api/siigo/parametrizacion/catalogos')
      .set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
  });

  it('financiera también lee: es quien parametriza contra qué se factura', async () => {
    const r = await request(app)
      .get('/api/siigo/parametrizacion/catalogos/payment_type')
      .set('Authorization', await financieraAuth());

    expect(r.status).toBe(200);
    expect(leerCatalogoMock).toHaveBeenCalledWith('payment_type', {
      incluirInactivos: false, ambiente: undefined,
    });
    nadieLlamoASiigo();
  });

  it('permite pedir también los inactivos, para explicar una parametrización antigua', async () => {
    const r = await request(app)
      .get('/api/siigo/parametrizacion/catalogos/cost_center?incluirInactivos=true')
      .set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(leerCatalogoMock).toHaveBeenCalledWith('cost_center', {
      incluirInactivos: true, ambiente: undefined,
    });
  });

  // `pruebas` y `produccion` son empresas distintas de Siigo: la pantalla tiene que poder mirar la
  // copia de una sin cambiar la configuración del servidor, y no puede acabar mezclándolas.
  it('la lectura acepta el ambiente y lo propaga', async () => {
    const r = await request(app)
      .get('/api/siigo/parametrizacion/catalogos/tax?ambiente=produccion')
      .set('Authorization', await adminAuth());

    expect(r.status).toBe(200);
    expect(leerCatalogoMock).toHaveBeenCalledWith('tax', {
      incluirInactivos: false, ambiente: 'produccion',
    });
  });

  it('el resumen también acepta el ambiente', async () => {
    await request(app)
      .get('/api/siigo/parametrizacion/catalogos?ambiente=produccion')
      .set('Authorization', await adminAuth());

    expect(resumenCatalogosMock).toHaveBeenCalledWith({ ambiente: 'produccion' });
  });

  it('un ambiente inventado se rechaza en vez de leerse como el configurado', async () => {
    const r = await request(app)
      .get('/api/siigo/parametrizacion/catalogos/tax?ambiente=staging')
      .set('Authorization', await adminAuth());

    expect(r.status).toBe(400);
    expect(leerCatalogoMock).not.toHaveBeenCalled();
  });

  it('un catálogo desconocido responde 400 sin tocar la base', async () => {
    const r = await request(app)
      .get('/api/siigo/parametrizacion/catalogos/vendedores')
      .set('Authorization', await adminAuth());

    expect(r.status).toBe(400);
    expect(r.body.catalogosValidos).toContain('cost_center');
    expect(leerCatalogoMock).not.toHaveBeenCalled();
  });

  it('un valor no booleano en incluirInactivos se rechaza en vez de interpretarse', async () => {
    const r = await request(app)
      .get('/api/siigo/parametrizacion/catalogos/tax?incluirInactivos=1')
      .set('Authorization', await adminAuth());

    expect(r.status).toBe(400);
    expect(leerCatalogoMock).not.toHaveBeenCalled();
  });
});

describe('contrato de la sincronización', () => {
  it('acepta un subconjunto de catálogos y lo propaga al servicio', async () => {
    await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await adminAuth())
      .send({ tipos: ['tax', 'user'], ambiente: 'produccion' });

    expect(sincronizarCatalogosMock.mock.calls[0]![0]).toMatchObject({
      tipos: ['tax', 'user'], ambiente: 'produccion',
    });
  });

  it('un catálogo inexistente en el cuerpo se rechaza sin gastar cuota', async () => {
    const r = await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await adminAuth())
      .send({ tipos: ['warehouses'] });

    expect(r.status).toBe(400);
    nadieLlamoASiigo();
  });

  it('una sincronización parcial responde 200 con el detalle del fallo, no un error opaco', async () => {
    sincronizarCatalogosMock.mockResolvedValue({
      ...RESULTADO_OK,
      ok: false,
      parcial: true,
      catalogos: [
        RESULTADO_OK.catalogos[0],
        {
          tipo: 'user', etiqueta: 'Vendedores', ok: false, total: 0, inactivados: 0,
          vaciadoMasivo: false, sincronizadoEn: null, duracionMs: 5,
          error: { codigo: 'service_unavailable', mensaje: 'Siigo no está disponible en este momento. Se puede reintentar.' },
        },
      ],
    });

    const r = await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await adminAuth())
      .send({});

    expect(r.status).toBe(200);
    expect(r.body.parcial).toBe(true);
    expect(r.body.catalogos[1].error.codigo).toBe('service_unavailable');
    expect(auditMock.mock.calls[0]![1].detail).toMatch(/fallidos=user/);
  });

  // BUG-C: sin esto, una sincronización que dejó la parametrización desierta se responde con el
  // mismo 200 verde que una normal y no queda rastro de quién la disparó.
  it('un vaciado masivo viaja en la respuesta aunque la sincronización sea exitosa', async () => {
    sincronizarCatalogosMock.mockResolvedValue({
      ...RESULTADO_OK,
      vaciadoMasivo: true,
      catalogos: [{
        ...RESULTADO_OK.catalogos[0], total: 0, inactivados: 24, vaciadoMasivo: true,
      }],
    });

    const r = await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await adminAuth())
      .send({});

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.vaciadoMasivo).toBe(true);
    expect(r.body.catalogos[0].vaciadoMasivo).toBe(true);
    expect(auditMock.mock.calls[0]![1].detail).toMatch(/vaciados=tax/);
  });

  it('una sincronización normal deja constancia de que no hubo vaciados', async () => {
    await request(app)
      .post('/api/siigo/parametrizacion/catalogos/sincronizar')
      .set('Authorization', await adminAuth())
      .send({});

    expect(auditMock.mock.calls[0]![1].detail).toMatch(/vaciados=ninguno/);
  });
});
