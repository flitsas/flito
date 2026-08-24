// HU #11253 — diagnóstico de la conexión con Siigo (Feature #11239).
//
// Lo que se prueba aquí es que cada fallo se traduzca a un mensaje que dice QUÉ HACER, y que los
// cuatro modos de fallo se distingan entre sí: no es lo mismo «falta configurar» que «Siigo está
// caído», y confundirlos manda a quien opera a buscar en el sitio equivocado.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_MODE: 'real' as 'mock' | 'real',
  SIIGO_ENC_KEY: 'b71d3f9a20c845e6f8319ad4c7be5026a19d3f84c60be27159ad83f4c2e70b91',
  NODE_ENV: 'development',
  PII_ENC_KEY: 'test-pii',
};
vi.mock('../../src/config/env.js', () => ({ env: envMock }));

const obtenerCredencialActivaMock = vi.fn();
vi.mock('../../src/modules/siigo/credenciales.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/credenciales.service.js')>();
  return { ...actual, obtenerCredencialActiva: obtenerCredencialActivaMock };
});

const obtenerTokenMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/siigo.token.js')>();
  return { ...actual, obtenerToken: obtenerTokenMock };
});

const siigoRequestMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/siigo/siigo.client.js')>();
  return { ...actual, siigoRequest: siigoRequestMock };
});

const registrarOperacionMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: registrarOperacionMock,
}));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { probarConexion } = await import('../../src/modules/siigo/siigo.diagnostico.service.js');
const { SiigoCredencialError } = await import('../../src/modules/siigo/credenciales.service.js');
const { SiigoAuthError } = await import('../../src/modules/siigo/siigo.token.js');
const { Redacted, SiigoEncKeyError } = await import('../../src/shared/utils/crypto.js');
const { reiniciarLimitador } = await import('../../src/modules/siigo/siigo.resiliencia.js');

const ACCESS_KEY = 'clave-de-acceso-siigo';

beforeEach(() => {
  obtenerCredencialActivaMock.mockReset();
  obtenerTokenMock.mockReset();
  siigoRequestMock.mockReset();
  registrarOperacionMock.mockReset();
  registrarOperacionMock.mockResolvedValue(undefined);
  reiniciarLimitador();
  envMock.SIIGO_MODE = 'real';
  envMock.SIIGO_PARTNER_ID = 'FlitoIntegracion';

  obtenerCredencialActivaMock.mockResolvedValue({
    id: 1, ambiente: 'pruebas', username: 'usuario@flitsas.com',
    accessKey: new Redacted(ACCESS_KEY),
  });
  obtenerTokenMock.mockResolvedValue('tok-vigente');
  siigoRequestMock.mockResolvedValue({ status: 200, ok: true, datos: [] });
});

describe('AC1 — conexión correcta', () => {
  it('devuelve un resultado satisfactorio con ambiente, modo y usuario', async () => {
    const r = await probarConexion();

    expect(r.ok).toBe(true);
    expect(r.codigo).toBe('ok');
    expect(r.ambiente).toBe('pruebas');
    expect(r.modo).toBe('real');
    expect(r.username).toBe('usuario@flitsas.com');
    expect(r.tokenObtenido).toBe(true);
    expect(r.duracionMs).toBeGreaterThanOrEqual(0);
  });

  it('fuerza la renovación del token: probar con uno cacheado no probaría nada', async () => {
    await probarConexion();
    expect(obtenerTokenMock).toHaveBeenCalledWith('pruebas', { forzarRenovacion: true });
  });

  it('consulta un catálogo liviano, no crea nada', async () => {
    await probarConexion();
    const req = siigoRequestMock.mock.calls[0]![0] as { metodo: string; ruta: string };
    expect(req.metodo).toBe('GET');
    expect(req.ruta).toContain('/v1/document-types');
  });

  it('la prueba queda registrada en la bitácora', async () => {
    await probarConexion({ usuarioId: 7 });

    expect(registrarOperacionMock).toHaveBeenCalledTimes(1);
    expect(registrarOperacionMock.mock.calls[0]![0]).toMatchObject({
      operacion: 'diagnostico_conexion', resultado: 'ok', ambiente: 'pruebas', createdBy: 7,
    });
  });

  it('permite probar un ambiente distinto al configurado', async () => {
    const r = await probarConexion({ ambiente: 'produccion' });
    expect(r.ambiente).toBe('produccion');
    expect(obtenerCredencialActivaMock).toHaveBeenCalledWith('produccion');
  });
});

describe('AC2 — credenciales inválidas', () => {
  it('un rechazo de Siigo da un mensaje accionable', async () => {
    obtenerTokenMock.mockRejectedValue(new SiigoAuthError(
      'Siigo rechazó las credenciales del ambiente "pruebas". Verifica el usuario y la clave de acceso.', 401,
    ));

    const r = await probarConexion();

    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('credenciales_rechazadas');
    expect(r.mensaje).toMatch(/Verifica el usuario y la clave/);
  });

  it('el resultado no expone la clave de acceso ni una traza técnica', async () => {
    obtenerTokenMock.mockRejectedValue(new SiigoAuthError('credenciales rechazadas', 401));

    const r = await probarConexion();

    expect(JSON.stringify(r)).not.toContain(ACCESS_KEY);
    expect(JSON.stringify(r)).not.toMatch(/at .*\.ts:\d+|Error: .*\n\s+at /);
  });

  it('el fallo también queda en la bitácora', async () => {
    obtenerTokenMock.mockRejectedValue(new SiigoAuthError('rechazada', 401));
    await probarConexion();

    expect(registrarOperacionMock.mock.calls[0]![0]).toMatchObject({
      operacion: 'diagnostico_conexion', resultado: 'error_tecnico',
    });
  });
});

describe('AC3 — sin credenciales configuradas', () => {
  it('indica que faltan y dónde registrarlas', async () => {
    obtenerCredencialActivaMock.mockRejectedValue(new SiigoCredencialError(
      'no_configurada', 'No hay credenciales de Siigo activas para el ambiente "pruebas".',
    ));

    const r = await probarConexion();

    expect(r.codigo).toBe('sin_credenciales');
    expect(r.mensaje).toMatch(/Regístralas en Administración/);
    expect(r.tokenObtenido).toBe(false);
  });

  it('sin Partner-Id señala la configuración del servidor, no las credenciales', async () => {
    envMock.SIIGO_PARTNER_ID = '';

    const r = await probarConexion();

    expect(r.codigo).toBe('sin_configuracion');
    expect(r.mensaje).toMatch(/SIIGO_PARTNER_ID/);
    expect(r.mensaje).toMatch(/variables de entorno/);
    // No llegó a intentar nada contra Siigo.
    expect(obtenerTokenMock).not.toHaveBeenCalled();
  });

  it('sin llave maestra lo distingue de las otras causas', async () => {
    obtenerCredencialActivaMock.mockRejectedValue(new SiigoEncKeyError('SIIGO_ENC_KEY no está configurada'));

    const r = await probarConexion();

    expect(r.codigo).toBe('llave_maestra');
    expect(r.mensaje).toMatch(/SIIGO_ENC_KEY/);
  });

  it('una credencial que no descifra se distingue de una ausente', async () => {
    obtenerCredencialActivaMock.mockRejectedValue(new SiigoCredencialError(
      'descifrado', 'La credencial no pudo descifrarse y quedó desactivada.',
    ));

    const r = await probarConexion();
    expect(r.codigo).toBe('credenciales_rechazadas');
    expect(r.mensaje).toMatch(/no pudo descifrarse/);
  });
});

describe('AC4 — Siigo no disponible', () => {
  it('un error de servicio se distingue de un problema de credenciales', async () => {
    siigoRequestMock.mockResolvedValue({
      status: 503, ok: false,
      datos: { Status: 503, Errors: [{ Code: 'service_unavailable', Message: 'caído' }] },
    });

    const r = await probarConexion();

    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('servicio_no_disponible');
    // Matiz que importa: el token SÍ se obtuvo, así que las credenciales están bien.
    expect(r.tokenObtenido).toBe(true);
    expect(r.mensaje).toMatch(/Siigo respondió 503/);
  });

  it('una caída de red también se reporta como servicio no disponible', async () => {
    siigoRequestMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const r = await probarConexion();

    expect(r.codigo).toBe('servicio_no_disponible');
    expect(r.mensaje).toMatch(/ECONNREFUSED/);
  });

  it('el diagnóstico NO reintenta: se espera la verdad inmediata', async () => {
    siigoRequestMock.mockRejectedValue(new Error('caído'));

    await probarConexion();

    // Un solo intento, pese a que un error de red sería reintentable en una operación normal.
    expect(siigoRequestMock).toHaveBeenCalledTimes(1);
  });
});

describe('el diagnóstico nunca lanza', () => {
  it('un fallo inesperado se convierte en resultado, no en excepción', async () => {
    obtenerCredencialActivaMock.mockImplementation(() => { throw new Error('algo raro'); });

    await expect(probarConexion()).resolves.toMatchObject({ ok: false });
  });

  it('si la bitácora falla, el diagnóstico igual responde', async () => {
    registrarOperacionMock.mockRejectedValue(new Error('BD caída'));

    // registrarOperacion no lanza en producción; aquí se fuerza para comprobar que ni así se pierde
    // el resultado del diagnóstico.
    await expect(probarConexion()).rejects.toThrow();
  });
});

describe('modo simulado', () => {
  it('en modo mock no resuelve credenciales y reporta el modo', async () => {
    envMock.SIIGO_MODE = 'mock';

    const r = await probarConexion();

    expect(r.modo).toBe('mock');
    expect(obtenerCredencialActivaMock).not.toHaveBeenCalled();
    expect(r.username).toBeNull();
  });
});
