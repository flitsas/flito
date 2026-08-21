// Siigo — la forma REAL del catálogo de productos en el simulador.
//
// Estas pruebas no comprueban que el simulador «devuelva algo»: fijan la FORMA de la respuesta de
// `GET /v1/products` contra la que devolvió la cuenta real de FLIT. Hasta ahora las fixtures tenían
// una forma inventada —`unit` como cadena, `account_group` como número, `taxes: []` en todos, sin
// `type` ni `tax_classification`— y las cincuenta y nueve suites del módulo afirmaban sobre ella:
// ninguna ejercitaba el contrato que el modo real va a servir dentro de unos días.
//
// Es la lección de la HU #11297 aplicada al catálogo de productos: «un simulador más permisivo que
// el ambiente real deja pasar en desarrollo justo lo que revienta en producción». Y aquí lo
// permisivo era la UNIFORMIDAD: en Siigo los productos no tienen todos las mismas claves.
//
// Lo que más importa de este spec es el caso de la clave AUSENTE. En la respuesta real los
// productos `Excluded` —SOAT, trámites e impuestos, que es casi todo lo que FLIT factura— NO traen
// `taxes`. El parser de producción hace `(p.taxes ?? [])` y sobrevive, pero eso no lo comprobaba
// nadie: bastaba con que alguien lo «simplificara» a `p.taxes.map(...)` para que la suite entera
// siguiera en verde y el modo real reventara en el primer listado.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const envMock = {
  SIIGO_BASE_URL: 'https://api.siigo.test',
  SIIGO_PARTNER_ID: 'FlitoIntegracion',
  SIIGO_AMBIENTE: 'pruebas' as const,
  SIIGO_MODE: 'mock' as 'mock' | 'real',
  SIIGO_ENC_KEY: 'b71d3f9a20c845e6f8319ad4c7be5026a19d3f84c60be27159ad83f4c2e70b91',
  NODE_ENV: 'development',
  PII_ENC_KEY: 'test-pii',
};
vi.mock('../../src/config/env.js', () => ({ env: envMock }));

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

vi.mock('../../src/modules/siigo/credenciales.service.js', () => ({
  obtenerCredencialActiva: vi.fn(),
}));

const { respuestaSimulada, reiniciarProductosSimulados, PRODUCTOS_SIMULADOS } = await import(
  '../../src/modules/siigo/siigo.mock.js');
const { listarProductos, consultarProductoPorCodigo } = await import(
  '../../src/modules/siigo/siigo.productos.service.js');

type Producto = Record<string, unknown>;

/** Los productos que devuelve el listado simulado, sin filtro de código. */
function listado(): Producto[] {
  const d = respuestaSimulada('GET', '/v1/products?page=1&page_size=100').datos as {
    results: Producto[];
  };
  return d.results;
}

function porCodigo(codigo: string): Producto | undefined {
  const d = respuestaSimulada('GET', `/v1/products?code=${encodeURIComponent(codigo)}`).datos as {
    results: Producto[];
  };
  return d.results[0];
}

beforeEach(() => { reiniciarProductosSimulados(); });

describe('la forma del listado es la del API real', () => {
  it('cada producto trae los campos que Siigo devuelve siempre', () => {
    const productos = listado();
    expect(productos.length).toBe(PRODUCTOS_SIMULADOS.length);

    for (const p of productos) {
      for (const campo of [
        'id', 'code', 'name', 'account_group', 'type', 'stock_control', 'active',
        'tax_classification', 'tax_included', 'additional_fields', 'available_quantity',
        'warehouses', 'metadata',
      ]) {
        expect(p, `${String(p.code)} no trae ${campo}`).toHaveProperty(campo);
      }
    }
  });

  it('`unit` es un OBJETO { code, name }, no la cadena que devolvía el simulador', () => {
    // Era `unit: '94'`. Cualquier código que leyera `producto.unit.code` pasaba las pruebas con una
    // cadena —`'94'.code` es `undefined`, no un error— y en el ambiente real habría leído otra cosa.
    const conUnidad = listado().filter((p) => p.unit !== undefined);
    expect(conUnidad.length).toBeGreaterThan(0);
    for (const p of conUnidad) {
      expect(p.unit).toEqual({ code: '94', name: 'unidad' });
      expect(typeof p.unit).toBe('object');
    }
  });

  it('hay productos SIN `unit` ni `unit_label`, como en la respuesta real', () => {
    // La cuenta real tiene productos sin esas claves. Si todas las fixtures la trajeran, el
    // simulador sería más uniforme que Siigo y nadie ensayaría la ausencia.
    expect(listado().some((p) => !('unit' in p))).toBe(true);
  });

  it('`account_group` es un OBJETO { id, name }, no el id suelto', () => {
    for (const p of listado()) {
      expect(p.account_group).toMatchObject({
        id: expect.any(Number),
        name: expect.any(String),
      });
    }
  });

  it('`type` y `stock_control` existen, y hay producto y servicio', () => {
    const tipos = listado().map((p) => p.type);
    expect(new Set(tipos)).toEqual(new Set(['Product', 'Service']));
    for (const p of listado()) expect(typeof p.stock_control).toBe('boolean');
  });

  it('`tax_classification` está en los tres valores reales', () => {
    const clasificaciones = new Set(listado().map((p) => p.tax_classification));
    expect(clasificaciones).toEqual(new Set(['Taxed', 'Exempt', 'Excluded']));
  });

  it('el listado viene por fecha de creación, más recientes primero, como el real', () => {
    // Es lo que documenta Siigo de `GET /v1/products`. El simulador los devolvía en el orden en
    // que estaban escritos, y con eso el orden alfabético que aplica `listarProductos` no se
    // ejercitaba nunca: en modo simulado la lista ya salía «bien» por casualidad.
    const fechas = listado().map((p) => (p.metadata as { created: string }).created);
    expect(fechas).toEqual([...fechas].sort().reverse());
  });

  it('hay un producto con `tax_included: true`', () => {
    // Existe en la cuenta real («002 Servicio FLIT»). Hoy es inocuo porque va con IVA 0 %, pero es
    // una forma que el simulador NUNCA producía: nadie había ensayado un precio con impuesto
    // incluido, y el día que lleve una tarifa distinta el total no es el mismo.
    expect(listado().filter((p) => p.tax_included === true).length).toBeGreaterThan(0);
  });
});

describe('la clave `taxes` FALTA en los excluidos, no viene vacía', () => {
  it('ningún producto `Excluded` trae la clave', () => {
    const excluidos = listado().filter((p) => p.tax_classification === 'Excluded');
    expect(excluidos.length).toBeGreaterThan(0);
    for (const p of excluidos) {
      // `toHaveProperty` no vale aquí: hay que distinguir «la clave no está» de «está en `[]`».
      expect('taxes' in p, `${String(p.code)} trae taxes y en Siigo no la trae`).toBe(false);
    }
  });

  it('los gravados y los exentos SÍ la traen, con el impuesto completo', () => {
    const gravado = listado().find((p) => p.tax_classification === 'Taxed')!;
    expect(gravado.taxes).toEqual([
      { id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19 },
    ]);

    const exento = listado().find((p) => p.tax_classification === 'Exempt')!;
    expect(exento.taxes).toEqual([{ id: 13161, name: 'IVA 0%', type: 'IVA', percentage: 0 }]);
  });

  it('el impuesto de un producto simulado existe en el catálogo simulado de impuestos', async () => {
    // Si no, quien parametrizara en modo simulado copiando ese id se encontraría un
    // `impuesto_desconocido` que el ambiente real no daría.
    const { CATALOGOS_SIMULADOS } = await import('../../src/modules/siigo/siigo.mock.js');
    const idsCatalogo = new Set((CATALOGOS_SIMULADOS.taxes as Array<{ id: number }>).map((t) => t.id));

    for (const p of listado()) {
      for (const t of (p.taxes ?? []) as Array<{ id: number }>) {
        expect(idsCatalogo.has(t.id), `el impuesto ${t.id} no está en /v1/taxes`).toBe(true);
      }
    }
  });

  it('el código de producción sobrevive a la ausencia de la clave', async () => {
    // Esto es lo que la forma inventada impedía ejercitar: `aProducto` hace `(p.taxes ?? [])`, y
    // hasta ahora ninguna prueba le pasaba un producto SIN la clave.
    const r = await listarProductos('pruebas');

    const soat = r.items.find((p) => p.codigo === 'SOAT-2024')!;
    expect(soat.impuestos).toEqual([]);
    const tramite = r.items.find((p) => p.codigo === 'TRAMITE-DIGITAL')!;
    expect(tramite.impuestos).toEqual([{ id: 13156, nombre: 'IVA 19%', porcentaje: 19 }]);
  });
});

describe('la consulta por código devuelve lo mismo que el listado', () => {
  it('el producto es el MISMO objeto, no una versión recortada', () => {
    expect(porCodigo('SOAT-2024')).toEqual(listado().find((p) => p.code === 'SOAT-2024'));
  });

  it('el inactivo se distingue por `active`, con la forma completa', async () => {
    const p = porCodigo('PRODUCTO-INACTIVO')!;
    expect(p.active).toBe(false);
    expect(p).toHaveProperty('tax_classification');

    // Y la validación de producción lo sigue leyendo como existente e inactivo (HU #11283, AC2).
    expect(await consultarProductoPorCodigo('PRODUCTO-INACTIVO', 'pruebas'))
      .toMatchObject({ existe: true, activo: false });
  });
});

describe('lo creado en la simulación tiene la misma forma que el catálogo', () => {
  const cuerpo = {
    code: 'FLIT-ENSAYO', name: 'Ensayo', account_group: 1253, type: 'Service' as const,
    stock_control: false, active: true, tax_classification: 'Taxed' as const,
    taxes: [{ id: 13156 }], unit: '94',
  };

  it('la respuesta del POST trae `unit` y `account_group` como objetos', () => {
    const d = respuestaSimulada('POST', '/v1/products', { cuerpo }).datos as Producto;

    expect(d.unit).toEqual({ code: '94', name: 'unidad' });
    expect(d.account_group).toEqual({ id: 1253, name: 'Servicios de trámites' });
    // Siigo devuelve el impuesto completo, no el `{ id }` que se le envió.
    expect(d.taxes).toEqual([{ id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19 }]);
  });

  it('un producto creado como `Excluded` tampoco trae la clave `taxes`', () => {
    const d = respuestaSimulada('POST', '/v1/products', {
      cuerpo: { ...cuerpo, code: 'FLIT-EXCLUIDO', tax_classification: 'Excluded' as const },
    }).datos as Producto;

    expect('taxes' in d).toBe(false);
  });

  it('lo creado aparece en el listado con la forma del catálogo y sin claves internas', () => {
    respuestaSimulada('POST', '/v1/products', { cuerpo });

    const creado = listado().find((p) => p.code === 'FLIT-ENSAYO')!;
    expect(creado).toBeDefined();
    // `ambiente` es del simulador, no de Siigo: cuando se guardaba DENTRO del producto, lo creado
    // salía del listado con cinco campos y una clave que el API real no devuelve nunca.
    expect(creado).not.toHaveProperty('ambiente');
    for (const campo of ['account_group', 'type', 'tax_classification', 'metadata']) {
      expect(creado).toHaveProperty(campo);
    }
  });

  it('lo creado en otro ambiente no se cuela en este', () => {
    respuestaSimulada('POST', '/v1/products', { cuerpo, ambiente: 'produccion' });
    expect(listado().some((p) => p.code === 'FLIT-ENSAYO')).toBe(false);
  });
});
