// Siigo — AC7 de la HU #11286: el modo simulado permite ensayar la creación completa.
//
// Spec aparte del principal a propósito: aquí NO se mockea ni el cliente HTTP ni el simulador. Se
// usan los reales, con `SIIGO_MODE=mock`, que es como corre el entorno de desarrollo. Lo que se
// prueba es que el simulador basta para ensayar el flujo de punta a punta — que es literalmente lo
// que pide el criterio— y no que nuestro mock de test devuelva lo que le dijimos.
//
// Solo se sustituyen las dos fronteras que necesitan base de datos: el catálogo local y el mapeo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SiigoCatalogoElemento, SiigoTipoCatalogo } from '@operaciones/shared-types';

/**
 * Entorno del simulador, con la misma forma que usan los otros specs del módulo.
 *
 * `SIIGO_PARTNER_ID` hace falta aunque no se envíe a nadie: `siigoRequest` resuelve la
 * configuración ANTES de cortar al simulador, y `siigo-catalogos.test.ts` fija a propósito que la
 * falta de Partner-Id se reporte incluso en modo simulado. Es decir, no es un descuido que se pueda
 * «arreglar» moviendo el corte: es una garantía que otra HU decidió. Se declara aquí, como en los
 * cinco specs que ya ejercitan el cliente.
 */
const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_MODE: 'mock' as 'mock' | 'real',
  SIIGO_MOCK_ERROR_RATE: 0,
  SIIGO_MOCK_TIMEOUT_RATE: 0,
  SIIGO_ENC_KEY: 'b71d3f9a20c845e6f8319ad4c7be5026a19d3f84c60be27159ad83f4c2e70b91',
  NODE_ENV: 'development',
  PII_ENC_KEY: 'test-pii',
};
vi.mock('../../src/config/env.js', () => ({ env: envMock }));

const catalogos: Partial<Record<SiigoTipoCatalogo, SiigoCatalogoElemento[]>> = {};
vi.mock('../../src/modules/siigo/siigo.catalogos.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.catalogos.service.js')>();
  return {
    ...real,
    leerCatalogo: vi.fn(async (tipo: SiigoTipoCatalogo) => ({
      tipo, etiqueta: tipo, ambiente: 'pruebas', sincronizadoEn: '2026-08-06T09:00:00Z',
      elementos: catalogos[tipo] ?? [],
    })),
  };
});

let filaMapeo: Record<string, unknown>;
const actualizarMapeoMock = vi.fn();
vi.mock('../../src/modules/siigo/mapeo-conceptos.service.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/mapeo-conceptos.service.js')>();
  return {
    ...real,
    obtenerMapeo: vi.fn(async () => filaMapeo),
    actualizarMapeo: (...args: unknown[]) => actualizarMapeoMock(...args),
  };
});

vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: vi.fn().mockResolvedValue(undefined) };
});

const MAPEO_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USUARIO = 77;

beforeEach(async () => {
  actualizarMapeoMock.mockReset()
    .mockResolvedValue({ mapeo: {}, anterior: {}, confirmacionRevertidaPor: [] });
  for (const k of Object.keys(catalogos)) delete catalogos[k as SiigoTipoCatalogo];
  catalogos.account_group = [{
    codigo: '1253', nombre: 'Servicios de trámites', descripcion: null, activo: true,
    atributos: null, sincronizadoEn: '2026-08-06T09:00:00Z',
  }];
  filaMapeo = {
    id: MAPEO_ID,
    ambiente: 'pruebas',
    concepto: 'logistica',
    codigoProducto: null,
    clasificacionTributaria: 'gravado',
    impuestos: [{ id: 13156, nombre: 'IVA 19%', porcentaje: 19 }],
    unidadMedida: '94',
    confirmadoContabilidad: false,
    activo: true,
  };
  // El simulador recuerda lo creado durante el proceso: hay que limpiarlo entre tests.
  const { reiniciarProductosSimulados } = await import('../../src/modules/siigo/siigo.mock.js');
  reiniciarProductosSimulados();
});

describe('AC7 — el simulador permite ensayar la creación completa', () => {
  it('el modo por defecto de los tests es simulado: no se sale a la red', async () => {
    const { enModoMock } = await import('../../src/modules/siigo/siigo.mock.js');
    expect(enModoMock()).toBe(true);
  });

  it('crear un producto devuelve la forma documentada de ProductOut', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');

    const r = respuestaSimulada('POST', '/v1/products', {
      cuerpo: { code: 'FLIT-ENSAYO', name: 'Ensayo', account_group: 1253, tax_classification: 'Taxed' },
    });

    expect(r.status).toBe(201);
    const d = r.datos as Record<string, unknown>;
    // Antes esta ruta caía en la rama de éxito vacío y devolvía un objeto sin identificador ni
    // código, con lo que la vinculación no se podía probar.
    expect(d.id).toBeTruthy();
    expect(d.code).toBe('FLIT-ENSAYO');
    expect(d.name).toBe('Ensayo');
    expect(d.active).toBe(true);
    expect(d).toHaveProperty('account_group');
    expect(d).toHaveProperty('tax_classification', 'Taxed');
    expect(d).toHaveProperty('metadata');
  });

  it('el flujo completo funciona sin ambiente real: crear → vincular', async () => {
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const r = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    expect(r.desenlace).toBe('creado');
    expect(r.codigo).toBe('FLIT-LOGISTICA');
    expect(r.modo).toBe('mock');
    expect(actualizarMapeoMock).toHaveBeenCalledWith(
      MAPEO_ID, expect.objectContaining({ codigoProducto: 'FLIT-LOGISTICA' }), USUARIO,
    );
  });

  it('lo creado en la simulación aparece en la siguiente consulta', async () => {
    // Es la pieza que hace posible el AC7: `actualizarMapeo` REVALIDA el código contra Siigo. Si el
    // simulador olvidara lo que acaba de crear, la vinculación fallaría con «no existe» y el flujo
    // no se podría ensayar — que es justo lo que el criterio pide poder hacer.
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');
    const { consultarProductoPorCodigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    const consultado = await consultarProductoPorCodigo('FLIT-LOGISTICA', 'pruebas');
    expect(consultado).toMatchObject({ existe: true, activo: true });
  });

  it('crear dos veces el mismo código NO duplica: la segunda vincula el existente', async () => {
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const primera = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);
    const segunda = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    expect(primera.desenlace).toBe('creado');
    // El reintento humano es seguro porque se busca antes de crear (AC2).
    expect(segunda.desenlace).toBe('vinculado_existente');
  });

  it('el simulador replica el rechazo de Siigo por código duplicado', async () => {
    const { respuestaSimulada } = await import('../../src/modules/siigo/siigo.mock.js');

    // `LOGISTICA` es una de las fixtures del simulador.
    const r = respuestaSimulada('POST', '/v1/products', { cuerpo: { code: 'LOGISTICA' } });

    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    // Misma estructura que un error real de Siigo: así se ejerce de verdad el traductor de errores.
    const d = r.datos as { Errors: Array<{ Code: string; Params: string[] }> };
    expect(d.Errors[0]!.Code).toBe('already_exists');
    expect(d.Errors[0]!.Params).toContain('code');
  });
});
