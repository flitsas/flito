// Siigo — crear en Siigo el producto que le falta a un concepto (HU #11286). Un bloque por AC.
//
// Se mockean las cuatro fronteras: el cliente HTTP, el catálogo local, el servicio de mapeo y la
// bitácora. Lo que se prueba es la ORQUESTACIÓN —qué se comprueba antes de crear, qué viaja en la
// creación, qué queda vinculado y qué se registra—, no volver a probar esas cuatro piezas.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CONCEPTOS_FACTURABLES, codigoSugeridoDeConcepto } from '@operaciones/shared-types';
import type { SiigoCatalogoElemento, SiigoTipoCatalogo } from '@operaciones/shared-types';

/** Peticiones a Siigo, controladas por test. */
const siigoRequestOrThrowMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

/** Paso directo: los reintentos con espera harían que cada caso de fallo tardara segundos. */
vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return {
    ...real,
    ejecutarConResiliencia: async (op: () => Promise<unknown>) => op(),
  };
});

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

/** El mapeo: qué fila hay y qué se le pide actualizar. */
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

/** Bitácora (AC6). */
const registrarOperacionMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.operaciones.repo.js')>();
  return { ...real, registrarOperacion: (r: unknown) => registrarOperacionMock(r) };
});

let modo: 'mock' | 'real' = 'real';
vi.mock('../../src/modules/siigo/siigo.mock.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.mock.js')>();
  return { ...real, modoSiigo: () => modo, enModoMock: () => modo === 'mock' };
});

const MAPEO_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USUARIO = 77;

function mapeo(over: Record<string, unknown> = {}) {
  return {
    id: MAPEO_ID,
    ambiente: 'pruebas',
    concepto: 'logistica',
    tipoTramite: null,
    codigoProducto: null,
    nombreProducto: null,
    clasificacionTributaria: 'gravado',
    impuestos: [{ id: 13156, nombre: 'IVA 19%', porcentaje: 19 }],
    unidadMedida: '94',
    ingresoParaTerceros: false,
    confirmadoContabilidad: false,
    activo: true,
    ...over,
  };
}

/** `GET /v1/products?code=` sin resultados: el producto no existe. */
const NO_EXISTE = { pagination: { total_results: 0 }, results: [] };

function existeActivo(code: string, name = 'Producto existente') {
  return { pagination: { total_results: 1 }, results: [{ code, name, active: true }] };
}

/** Encamina la petición según sea la búsqueda previa o la creación. */
function responder(busqueda: unknown, creacion?: unknown | (() => never)) {
  siigoRequestOrThrowMock.mockImplementation(async (req: { metodo: string }) => {
    if (req.metodo === 'GET') return busqueda;
    if (typeof creacion === 'function') return (creacion as () => never)();
    return creacion;
  });
}

beforeEach(() => {
  modo = 'real';
  siigoRequestOrThrowMock.mockReset();
  actualizarMapeoMock.mockReset().mockResolvedValue({ mapeo: {}, anterior: {}, confirmacionRevertidaPor: [] });
  registrarOperacionMock.mockClear();
  for (const k of Object.keys(catalogos)) delete catalogos[k as SiigoTipoCatalogo];
  catalogos.account_group = [
    { codigo: '1253', nombre: 'Servicios de trámites', descripcion: null, activo: true, atributos: null, sincronizadoEn: '2026-08-06T09:00:00Z' },
    { codigo: '1256', nombre: 'Clasificación en desuso', descripcion: null, activo: false, atributos: null, sincronizadoEn: '2026-08-06T09:00:00Z' },
  ];
  filaMapeo = mapeo();
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC1 — el código se construye válido y legible', () => {
  it.each([...CONCEPTOS_FACTURABLES])('el sugerido de %s cumple el formato de Siigo', (concepto) => {
    const codigo = codigoSugeridoDeConcepto(concepto);

    expect(codigo).toMatch(/^[A-Za-z0-9._-]{1,30}$/);
    expect(codigo.length).toBeLessThanOrEqual(30);
    // Legible: quien abra el catálogo en Siigo tiene que reconocer de qué concepto salió.
    expect(codigo).toContain(concepto.split('_')[0]!.toUpperCase());
  });

  it('el sugerido lleva prefijo de FLIT para no chocar con el catálogo de otras áreas', async () => {
    const { PREFIJO_CODIGO_PRODUCTO_FLIT } = await import('@operaciones/shared-types');
    expect(codigoSugeridoDeConcepto('logistica')).toBe(`${PREFIJO_CODIGO_PRODUCTO_FLIT}LOGISTICA`);
  });

  it('un código editado se valida IGUAL que el sugerido, y sin salir a la red', async () => {
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(
      MAPEO_ID, { codigo: 'CON ESPACIOS', grupoInventarioCodigo: '1253' }, USUARIO,
    ).catch((x) => x);

    expect(e.codigo).toBe('datos');
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('sin código explícito se usa el sugerido del concepto', async () => {
    responder(NO_EXISTE, { id: 'p-1', code: codigoSugeridoDeConcepto('logistica'), name: 'Servicio de logística' });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const r = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    expect(r.codigo).toBe('FLIT-LOGISTICA');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC2 — se busca antes de crear', () => {
  it('si el código ya existe en Siigo, se VINCULA y no se crea nada', async () => {
    responder(existeActivo('FLIT-LOGISTICA', 'Logística de otra área'));
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const r = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    expect(r.desenlace).toBe('vinculado_existente');
    expect(r.nombre).toBe('Logística de otra área');
    // Ni un POST: el catálogo de la empresa lo comparten otras áreas y duplicar es peor que vincular.
    expect(siigoRequestOrThrowMock.mock.calls.every((c) => c[0].metodo === 'GET')).toBe(true);
    // Y aun así se vincula al concepto.
    expect(actualizarMapeoMock).toHaveBeenCalled();
  });

  it('un producto existente pero INACTIVO no se vincula: se avisa', async () => {
    responder({ pagination: { total_results: 1 }, results: [{ code: 'FLIT-LOGISTICA', name: 'Viejo', active: false }] });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO)
      .catch((x) => x);

    // Vincularlo dejaría el mapeo marcado como inválido en la siguiente lectura de la HU #11283.
    expect(e.codigo).toBe('validacion');
    expect(e.message).toMatch(/INACTIVO/);
    expect(actualizarMapeoMock).not.toHaveBeenCalled();
  });

  it('si no se puede comprobar si existe, NO se crea', async () => {
    siigoRequestOrThrowMock.mockRejectedValue(new Error('ETIMEDOUT'));
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO)
      .catch((x) => x);

    // Crear a ciegas sobre una búsqueda fallida es justo cómo se duplica un producto.
    expect(e.codigo).toBe('no_verificable');
    expect(e.message).toMatch(/No se creó nada/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC3 — el producto nace con el tratamiento tributario del mapeo', () => {
  it('la clasificación, los impuestos y la unidad viajan en la creación', async () => {
    responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA', name: 'Servicio de logística' });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    const post = siigoRequestOrThrowMock.mock.calls.find((c) => c[0].metodo === 'POST')![0];
    expect(post.ruta).toBe('/v1/products');
    expect(post.cuerpo).toMatchObject({
      code: 'FLIT-LOGISTICA',
      account_group: 1253,
      tax_classification: 'Taxed',
      taxes: [{ id: 13156 }],
      unit: '94',
      type: 'Service',
      stock_control: false,
      active: true,
    });
  });

  it('lo que FLITO factura son servicios: nunca inventario con control de existencias', async () => {
    responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA' });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    const post = siigoRequestOrThrowMock.mock.calls.find((c) => c[0].metodo === 'POST')![0];
    // Un producto con control de existencias exigiría movimientos de bodega que aquí no existen.
    expect(post.cuerpo.type).toBe('Service');
    expect(post.cuerpo.stock_control).toBe(false);
  });

  it('el grupo de inventario tiene que estar en el catálogo sincronizado', async () => {
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '9999' }, USUARIO)
      .catch((x) => x);

    expect(e.codigo).toBe('datos');
    expect(e.message).toMatch(/no está en el catálogo/i);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('un grupo de inventario INACTIVO se rechaza, porque después no se puede cambiar', async () => {
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1256' }, USUARIO)
      .catch((x) => x);

    expect(e.codigo).toBe('datos');
    // `account_group` es inmutable una vez que el producto tiene movimiento.
    expect(e.message).toMatch(/inactivo/i);
    expect(e.message).toMatch(/movimiento/i);
  });

  it('sin clasificación tributaria declarada no se crea el producto', async () => {
    filaMapeo = mapeo({ clasificacionTributaria: null });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO)
      .catch((x) => x);

    // Corregir la clasificación después obliga a crear otro producto: mejor no crearlo mal.
    expect(e.codigo).toBe('datos');
    expect(e.message).toMatch(/clasificación tributaria/i);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('las tres clasificaciones se traducen al valor que espera Siigo', async () => {
    const esperado = { gravado: 'Taxed', exento: 'Exempt', excluido: 'Excluded' } as const;

    for (const [nuestra, suya] of Object.entries(esperado)) {
      siigoRequestOrThrowMock.mockReset();
      filaMapeo = mapeo({ clasificacionTributaria: nuestra });
      responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA' });

      const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');
      await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

      const post = siigoRequestOrThrowMock.mock.calls.find((c) => c[0].metodo === 'POST')![0];
      expect(post.cuerpo.tax_classification).toBe(suya);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC4 — crear y vincular en un solo paso', () => {
  it('el mapeo queda con el código del producto creado', async () => {
    responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA', name: 'Servicio de logística' });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const r = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    expect(r.desenlace).toBe('creado');
    expect(actualizarMapeoMock).toHaveBeenCalledWith(
      MAPEO_ID,
      { codigoProducto: 'FLIT-LOGISTICA', nombreProducto: 'Servicio de logística' },
      USUARIO,
    );
  });

  it('la confirmación de contabilidad NO se marca automáticamente', async () => {
    responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA' });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    // Crear el producto es un acto técnico; firmar su tratamiento tributario es un acto contable.
    const cambios = actualizarMapeoMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(cambios).not.toHaveProperty('confirmadoContabilidad');
  });

  it('si la vinculación falla tras crear, se dice que el producto SÍ se creó', async () => {
    responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA' });
    actualizarMapeoMock.mockRejectedValue(new Error('la base no respondió'));
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO)
      .catch((x) => x);

    // Decir «no se pudo crear» mandaría a crear otro. Reintentar es seguro: la búsqueda lo encuentra.
    expect(e.message).toMatch(/SÍ se creó/);
    expect(e.message).toMatch(/no se duplicará/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC5 — un rechazo de Siigo se explica', () => {
  it('el error se traduce a lenguaje operativo con el campo señalado', async () => {
    const { SiigoApiError } = await import('../../src/modules/siigo/siigo.errors.js');
    responder(NO_EXISTE, () => {
      throw new SiigoApiError({
        status: 400,
        code: 'already_exists',
        message: 'Product code already exists',
        params: ['code'],
        reintentable: false,
      });
    });

    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');
    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO)
      .catch((x) => x);

    expect(e.codigo).toBe('validacion');
    expect(e.message).toMatch(/ya existe en Siigo Nube/i);
    expect(e.message).toContain('Campo: code');
    // Y NO el texto crudo en inglés.
    expect(e.message).not.toContain('Product code already exists');
  });

  it('el mapeo no queda a medio configurar', async () => {
    const { SiigoApiError } = await import('../../src/modules/siigo/siigo.errors.js');
    responder(NO_EXISTE, () => {
      throw new SiigoApiError({
        status: 400, code: 'invalid_code', message: 'bad', reintentable: false,
      });
    });

    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');
    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO).catch(() => undefined);

    expect(actualizarMapeoMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC6 — todo queda en bitácora', () => {
  it('un intento EXITOSO se registra con su ambiente y su modo', async () => {
    responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA' });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    const r = registrarOperacionMock.mock.calls.at(-1)![0];
    expect(r).toMatchObject({
      operacion: 'siigo.producto.crear',
      metodo: 'POST',
      ruta: '/v1/products',
      entidadTipo: 'siigo_mapeo_concepto',
      entidadId: MAPEO_ID,
      ambiente: 'pruebas',
      modo: 'real',
      resultado: 'ok',
      createdBy: USUARIO,
    });
  });

  it('un intento FALLIDO también se registra', async () => {
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '9999' }, USUARIO)
      .catch(() => undefined);

    const r = registrarOperacionMock.mock.calls.at(-1)![0];
    expect(r.resultado).toBe('error_negocio');
    expect(r.ambiente).toBe('pruebas');
    expect(r.modo).toBe('real');
  });

  it('hasta un código mal escrito deja rastro, aunque no se haya salido a la red', async () => {
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { codigo: 'MAL CODIGO', grupoInventarioCodigo: '1253' }, USUARIO)
      .catch(() => undefined);

    expect(registrarOperacionMock).toHaveBeenCalled();
    expect(registrarOperacionMock.mock.calls.at(-1)![0].resultado).toBe('error_negocio');
  });

  it('el modo simulado queda registrado como tal', async () => {
    modo = 'mock';
    responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA' });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    // Sin esto, una bitácora de pruebas parecería una de producción.
    expect(registrarOperacionMock.mock.calls.at(-1)![0].modo).toBe('mock');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Regresión de la auditoría de seguridad de esta HU.
describe('Regresión — hallazgos de la auditoría de seguridad', () => {
  beforeEach(async () => {
    const { reiniciarCreacionesEnCurso } =
      await import('../../src/modules/siigo/crear-producto.service.js');
    reiniciarCreacionesEnCurso();
  });

  it('un concepto YA vinculado a otro producto no crea uno nuevo', async () => {
    filaMapeo = mapeo({ codigoProducto: 'FLIT-ANTERIOR' });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(
      MAPEO_ID, { codigo: 'FLIT-NUEVO', grupoInventarioCodigo: '1253' }, USUARIO,
    ).catch((x) => x);

    // Crear otro dejaría el anterior HUÉRFANO en el catálogo, donde no se puede borrar.
    expect(e.codigo).toBe('no_editable');
    expect(e.message).toContain('FLIT-ANTERIOR');
    expect(e.message).toMatch(/huérfano/i);
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('reintentar con el MISMO código sí se permite: es el camino de recuperación', async () => {
    filaMapeo = mapeo({ codigoProducto: 'FLIT-LOGISTICA' });
    responder(existeActivo('FLIT-LOGISTICA', 'Servicio de logística'));
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const r = await crearProductoDeConcepto(
      MAPEO_ID, { codigo: 'FLIT-LOGISTICA', grupoInventarioCodigo: '1253' }, USUARIO,
    );

    // Si la creación funcionó pero la vinculación falló, reintentar tiene que terminar el trabajo.
    expect(r.desenlace).toBe('vinculado_existente');
  });

  it('una configuración desactivada no genera productos reales', async () => {
    filaMapeo = mapeo({ activo: false });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO)
      .catch((x) => x);

    // Sería un residuo permanente en Siigo para una fila que ningún flujo va a usar.
    expect(e.codigo).toBe('no_editable');
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('el fallo al vincular NO devuelve el mensaje crudo del motor de base de datos', async () => {
    responder(NO_EXISTE, { id: 'p-1', code: 'FLIT-LOGISTICA' });
    // Como lo relanza `actualizarMapeo` desde drizzle 0.45: sentencia y parámetros dentro.
    actualizarMapeoMock.mockRejectedValue(new Error(
      'Failed query: update "siigo_mapeo_conceptos" set "codigo_producto" = $1\nparams: FLIT-LOGISTICA',
    ));
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const e = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO)
      .catch((x) => x);

    // Este texto viaja al cliente: reintroducirlo sería repetir la fuga que la HU #11281 remedió.
    expect(e.message).not.toContain('Failed query');
    expect(e.message).not.toContain('params:');
    expect(e.message).not.toContain('siigo_mapeo_conceptos');
    // Y sigue diciendo lo importante: el producto SÍ se creó.
    expect(e.message).toMatch(/SÍ se creó/);
  });

  it('el nombre que viene de Siigo se acota antes de guardarlo', async () => {
    const largo = 'X'.repeat(400);
    responder(existeActivo('FLIT-LOGISTICA', largo));
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);

    // La columna es varchar(200): sin recorte, un producto del catálogo compartido con nombre largo
    // produciría un 22001 crudo del motor, que es justo el error que no puede salir de aquí.
    const cambios = actualizarMapeoMock.mock.calls[0]![1] as { nombreProducto: string };
    expect([...cambios.nombreProducto].length).toBe(200);
  });

  it('dos creaciones simultáneas sobre el mismo concepto: la segunda se rechaza', async () => {
    let liberar: ((v: unknown) => void) | null = null;
    const enVuelo = new Promise<void>((avisar) => {
      // Solo la PRIMERA llamada queda en vuelo; las siguientes responden normal, o al liberar la
      // búsqueda la creación volvería a colgarse y la primera ejecución no terminaría nunca.
      siigoRequestOrThrowMock
        .mockImplementationOnce(() => new Promise((r) => { liberar = r; avisar(); }))
        .mockImplementation(async () => ({ id: 'p-1', code: 'FLIT-LOGISTICA' }));
    });
    const { crearProductoDeConcepto } = await import('../../src/modules/siigo/crear-producto.service.js');

    const primera = crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO);
    await enVuelo;
    const segunda = await crearProductoDeConcepto(MAPEO_ID, { grupoInventarioCodigo: '1253' }, USUARIO)
      .catch((x) => x);

    // Con códigos distintos, dos a la vez materializan DOS productos reales en el catálogo.
    expect(segunda.codigo).toBe('en_curso');

    liberar!(NO_EXISTE);
    await primera.catch(() => undefined);
  });
});
