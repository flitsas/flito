// Siigo — validación del mapeo en vivo contra Siigo (HU #11283). Un bloque por criterio.
//
// La distinción que este spec existe para proteger es la del AC6: **no existe** y **no se pudo
// verificar** son cosas distintas. La primera manda a corregir el código; la segunda dice que Siigo
// está caído y el código puede estar perfecto. Un test que solo comprobara «se rechazó» las daría
// por equivalentes, que es exactamente el fallo que el AC prohíbe.
//
// `ejecutarConResiliencia` se sustituye por un paso directo, con dos motivos: los reintentos con
// espera creciente harían que cada caso de fallo tardara siete segundos, y lo que se prueba aquí es
// la POLÍTICA de validación, no el limitador —que tiene su propio spec—. A cambio, un test aparte
// afirma sobre las CLAVES que se le pasan, que es donde vive la decisión de diseño.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { respuestaSimulada } from '../../src/modules/siigo/siigo.mock.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

/** Lo que el servicio de productos pide a Siigo. Controlado caso a caso. */
const siigoRequestOrThrowMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));

/** Paso directo, pero registrando las opciones: las claves son una decisión, no un detalle. */
const opcionesResiliencia: unknown[] = [];
vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return {
    ...real,
    ejecutarConResiliencia: async (op: () => Promise<unknown>, opts: unknown) => {
      opcionesResiliencia.push(opts);
      return op();
    },
  };
});

const TABLA = 'siigo_mapeo_conceptos';
const CATALOGOS = 'siigo_catalogos';
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USUARIO = 77;

/** Elemento del catálogo local tal como lo devuelve `leerCatalogo`. */
function impuestoLocal(codigo: string, activo = true) {
  return {
    codigo,
    nombre: `Impuesto ${codigo}`,
    descripcion: null,
    activo,
    atributos: null,
    sincronizadoEn: new Date('2026-08-06T09:00:00Z'),
  };
}

/** Respuesta de `GET /v1/products?code=` con los productos que Siigo devolvería. */
function listado(productos: Array<{ code: string; name: string; active: boolean }>) {
  return {
    pagination: { page: 1, page_size: 25, total_results: productos.length },
    results: productos,
  };
}

function filaMapeo(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    ambiente: 'pruebas',
    concepto: 'logistica',
    tipoTramite: null,
    codigoProducto: 'LOGISTICA',
    nombreProducto: null,
    clasificacionTributaria: 'gravado',
    impuestos: [],
    unidadMedida: '94',
    ingresoParaTerceros: false,
    facturaLineaPropia: true,
    lineaPropiaPendiente: false,
    confirmadoContabilidad: false,
    confirmadoPorId: null,
    confirmadoEn: null,
    confirmacionRevertidaEn: null,
    confirmacionRevertidaPor: null,
    activo: true,
    notas: null,
    validacionEstado: 'sin_validar',
    validacionMensaje: null,
    validadoEn: null,
    createdAt: new Date('2026-08-05T10:00:00Z'),
    createdBy: null,
    updatedAt: new Date('2026-08-05T10:00:00Z'),
    updatedBy: null,
    ...over,
  };
}

beforeEach(async () => {
  kdb.reset();
  siigoRequestOrThrowMock.mockReset();
  opcionesResiliencia.length = 0;
  // La guarda de concurrencia es estado de módulo y el módulo se cachea entre tests: sin este
  // reinicio, un caso que la dejara puesta haría fallar a todos los siguientes con un error que no
  // tiene nada que ver con lo que prueban.
  const { reiniciarRevalidaciones } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
  reiniciarRevalidaciones();
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC4 — el formato se valida antes de salir a la red', () => {
  it.each([
    ['con espacios', 'CODIGO CON ESPACIOS'],
    ['más de 30 caracteres', 'X'.repeat(31)],
    ['caracteres no permitidos', 'CÓDIGO/CON#SIGNOS'],
  ])('un código %s se rechaza SIN consultar a Siigo', async (_n, codigo) => {
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: codigo }, 'pruebas');

    expect(v.valido).toBe(false);
    expect(v.motivo).toBe('formato');
    // Lo que de verdad prueba el AC: no se gastó una petición de las 100 por minuto.
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('el mensaje explica la regla incumplida, no solo que está mal', async () => {
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');
    const v = await validarMapeoContraSiigo({ codigoProducto: 'MAL CÓDIGO' }, 'pruebas');

    expect(v.mensaje).toMatch(/alfanum/i);
    expect(v.mensaje).toMatch(/30/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC1 y AC2 — un producto inexistente o inactivo no se guarda', () => {
  it('código que no existe en Siigo → no_existe', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(listado([]));
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: 'NO-EXISTE' }, 'pruebas');

    expect(v.motivo).toBe('no_existe');
    expect(v.mensaje).toMatch(/no existe/i);
    // Se llegó a preguntar: por eso la validación lleva fecha.
    expect(v.verificadoEn).not.toBeNull();
  });

  it('código que existe pero está inactivo → inactivo, e indica activarlo en Siigo', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(
      listado([{ code: 'APAGADO', name: 'Producto apagado', active: false }]),
    );
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: 'APAGADO' }, 'pruebas');

    expect(v.motivo).toBe('inactivo');
    expect(v.mensaje).toMatch(/INACTIVO/);
    expect(v.mensaje).toMatch(/Siigo Nube/);
  });

  it('la coincidencia se exige EXACTA: un filtro parcial de Siigo no cuela otro producto', async () => {
    // Siigo no documenta `?code=` como búsqueda exacta. Si devolviera coincidencias parciales,
    // aceptar la primera guardaría un producto que no es el que se escribió — y la factura saldría
    // con otro artículo.
    siigoRequestOrThrowMock.mockResolvedValue(
      listado([{ code: 'SOAT-2024-EXTRA', name: 'Otro producto', active: true }]),
    );
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: 'SOAT-2024' }, 'pruebas');
    expect(v.motivo).toBe('no_existe');
  });

  it('un producto sin `active` en la respuesta se trata como inactivo, no como bueno', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(
      listado([{ code: 'RARO', name: 'Respuesta incompleta' } as never]),
    );
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: 'RARO' }, 'pruebas');
    expect(v.motivo).toBe('inactivo');
  });

  it('el caso feliz devuelve el nombre de Siigo, para que la pantalla confirme cuál es', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(
      listado([{ code: 'LOGISTICA', name: 'Servicio de logística', active: true }]),
    );
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: 'LOGISTICA' }, 'pruebas');
    expect(v.valido).toBe(true);
    expect(v.nombreProductoSiigo).toBe('Servicio de logística');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC3 — los impuestos se validan contra la copia local', () => {
  it('un impuesto que no está en el catálogo sincronizado se rechaza', async () => {
    kdb.when.select(CATALOGOS, [impuestoLocal('13156'), impuestoLocal('13157')]);
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ impuestos: [{ id: 99999 }] }, 'pruebas');

    expect(v.motivo).toBe('impuesto_desconocido');
    expect(v.mensaje).toMatch(/sincroniza/i);
    // Sin red: la copia local basta para saberlo.
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('un impuesto que existe pero está INACTIVO se rechaza con un mensaje distinto', async () => {
    kdb.when.select(CATALOGOS, [impuestoLocal('13160', false)]);
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ impuestos: [{ id: 13160 }] }, 'pruebas');

    expect(v.motivo).toBe('impuesto_desconocido');
    expect(v.mensaje).toMatch(/inactivo/i);
    // El mensaje NO manda a sincronizar: el catálogo está bien, el impuesto es el que está apagado.
    expect(v.mensaje).not.toMatch(/sincroniza el catálogo/i);
  });

  it('la copia VACÍA se distingue del id desconocido', async () => {
    // Con el catálogo sin traer, todo id parecería inválido. Decir «tu impuesto no existe» mandaría
    // a quien parametriza a buscar el problema donde no está.
    kdb.when.select(CATALOGOS, []);
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ impuestos: [{ id: 13156 }] }, 'pruebas');

    expect(v.motivo).toBe('catalogo_sin_sincronizar');
    expect(v.mensaje).toMatch(/no está sincronizado/i);
  });

  it('los impuestos se comprueban ANTES que el producto: lo barato primero', async () => {
    kdb.when.select(CATALOGOS, [impuestoLocal('13156')]);
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    await validarMapeoContraSiigo(
      { codigoProducto: 'LOGISTICA', impuestos: [{ id: 77777 }] }, 'pruebas',
    );

    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC5 — el simulador ejerce la misma validación que el modo real', () => {
  beforeEach(() => {
    // El cliente delega en el SIMULADOR REAL. Así el test no describe lo que creemos que hace el
    // simulador: lo ejerce, y si el simulador cambia el test se entera.
    siigoRequestOrThrowMock.mockImplementation(async (req: { metodo: string; ruta: string }) => {
      const r = respuestaSimulada(req.metodo as 'GET', req.ruta);
      if (!r.ok) throw new Error(`simulado ${r.status}`);
      return r.datos;
    });
  });

  it('un código que el simulador conoce se acepta', async () => {
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');
    const v = await validarMapeoContraSiigo({ codigoProducto: 'LOGISTICA' }, 'pruebas');

    expect(v.valido).toBe(true);
    expect(v.nombreProductoSiigo).toBe('Servicio de logística');
  });

  it('un código que el simulador NO conoce se rechaza', async () => {
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');
    const v = await validarMapeoContraSiigo({ codigoProducto: 'INVENTADO' }, 'pruebas');

    expect(v.valido).toBe(false);
    expect(v.motivo).toBe('no_existe');
  });

  it('el simulador conoce los TRES casos que exige el AC5', async () => {
    const { PRODUCTOS_SIMULADOS } = await import('../../src/modules/siigo/siigo.mock.js');

    expect(PRODUCTOS_SIMULADOS.some((p) => p.active)).toBe(true);
    expect(PRODUCTOS_SIMULADOS.some((p) => !p.active)).toBe(true);
    // El tercero —inexistente— no necesita fixture: es cualquier código fuera de la lista.
    expect(PRODUCTOS_SIMULADOS.some((p) => p.code === 'INVENTADO')).toBe(false);
  });

  it('el producto inactivo del simulador se rechaza como inactivo, no como inexistente', async () => {
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');
    const v = await validarMapeoContraSiigo({ codigoProducto: 'PRODUCTO-INACTIVO' }, 'pruebas');

    expect(v.motivo).toBe('inactivo');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC6 — no se guarda lo que no se pudo verificar', () => {
  it('un fallo de Siigo produce no_verificable, NUNCA no_existe', async () => {
    siigoRequestOrThrowMock.mockRejectedValue(new Error('ECONNRESET'));
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: 'LOGISTICA' }, 'pruebas');

    expect(v.motivo).toBe('no_verificable');
    expect(v.motivo).not.toBe('no_existe');
    // Sin fecha: no se verificó nada. Poner fecha afirmaría una comprobación que no ocurrió.
    expect(v.verificadoEn).toBeNull();
  });

  it('el mensaje distingue «no se pudo verificar» de «no existe», en palabras', async () => {
    siigoRequestOrThrowMock.mockRejectedValue(new Error('timeout'));
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: 'LOGISTICA' }, 'pruebas');

    expect(v.mensaje).toMatch(/no se pudo verificar/i);
    expect(v.mensaje).toMatch(/puede estar bien/i);
    expect(v.mensaje).not.toMatch(/no existe/i);
  });

  it('el detalle técnico va saneado: nunca arrastra una sentencia SQL', async () => {
    siigoRequestOrThrowMock.mockRejectedValue(
      new Error('Failed query: select * from "siigo_catalogos"\nparams: pruebas'),
    );
    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: 'LOGISTICA' }, 'pruebas');

    expect(v.mensaje).not.toContain('Failed query');
    expect(v.mensaje).not.toContain('params:');
  });

  it('una fila SIN código de producto no se marca como validada', async () => {
    const { validarMapeoContraSiigo, estadoDeValidacion } =
      await import('../../src/modules/siigo/siigo.productos.service.js');

    const v = await validarMapeoContraSiigo({ codigoProducto: null }, 'pruebas');

    expect(v.valido).toBe(true);
    expect(v.verificadoEn).toBeNull();
    // No es un aprobado: es que no había nada que aprobar.
    expect(estadoDeValidacion(v)).toBe('sin_validar');
    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('El guardado se corta antes de tocar la tabla', () => {
  it('un producto inexistente impide el INSERT y sale como 422, no como 400', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(listado([]));
    kdb.when.select(TABLA, []);
    const { crearMapeoEspecifico, SiigoMapeoError } =
      await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    const e = await crearMapeoEspecifico(
      { ambiente: 'pruebas', concepto: 'logistica', tipoTramite: 'TRASPASO', codigoProducto: 'NO-EXISTE' },
      USUARIO,
    ).catch((x) => x);

    expect(e).toBeInstanceOf(SiigoMapeoError);
    expect(e.codigo).toBe('validacion');
    // AC1 — el mapeo conserva su valor anterior: no se llegó a insertar.
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('Siigo caído impide la edición y sale como no_verificable, sin tocar la fila', async () => {
    siigoRequestOrThrowMock.mockRejectedValue(new Error('ETIMEDOUT'));
    kdb.when.select(TABLA, [filaMapeo({ tipoTramite: 'TRASPASO' })]);
    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    const e = await actualizarMapeo(ID, { codigoProducto: 'LOGISTICA' }, USUARIO).catch((x) => x);

    expect(e.codigo).toBe('no_verificable');
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('editar algo que Siigo no puede desmentir NO gasta una petición', async () => {
    kdb.when.select(TABLA, [filaMapeo({ tipoTramite: 'TRASPASO' })]);
    kdb.when.update(TABLA, [filaMapeo({ tipoTramite: 'TRASPASO', notas: 'Revisado con contabilidad' })]);
    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    await actualizarMapeo(ID, { notas: 'Revisado con contabilidad' }, USUARIO);

    expect(siigoRequestOrThrowMock).not.toHaveBeenCalled();
  });

  it('un guardado válido deja el veredicto escrito en la fila', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(
      listado([{ code: 'LOGISTICA', name: 'Servicio de logística', active: true }]),
    );
    kdb.when.select(TABLA, [filaMapeo({ tipoTramite: 'TRASPASO' })]);

    const capturado: { set?: Record<string, unknown> } = {};
    kdb.update.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.resolve([filaMapeo({ tipoTramite: 'TRASPASO' })]);
      chain.set = (v: Record<string, unknown>) => { capturado.set = v; return chain; };
      for (const m of ['where', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });

    const { actualizarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await actualizarMapeo(ID, { codigoProducto: 'LOGISTICA' }, USUARIO);

    expect(capturado.set?.validacionEstado).toBe('valido');
    expect(capturado.set?.validadoEn).toBeInstanceOf(Date);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('AC7 — revalidación de lo ya configurado', () => {
  it('devuelve los conceptos cuyo producto dejó de existir y los marca en la tabla', async () => {
    kdb.when.select(TABLA, [
      filaMapeo({ id: 'f-1', concepto: 'logistica', codigoProducto: 'BORRADO' }),
    ]);
    siigoRequestOrThrowMock.mockResolvedValue(listado([]));

    const capturas: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.resolve([]);
      chain.set = (v: Record<string, unknown>) => { capturas.push(v); return chain; };
      for (const m of ['where', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });

    const { revalidarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await revalidarMapeo('pruebas', USUARIO);

    expect(r.revisados).toBe(1);
    expect(r.conNovedad).toHaveLength(1);
    expect(r.conNovedad[0]!.estado).toBe('no_existe');
    // «Señalados en la parametrización» = escrito en la fila, no solo devuelto en la respuesta.
    expect(capturas[0]!.validacionEstado).toBe('no_existe');
  });

  it('lo no verificable va en su propia lista, no mezclado con las novedades', async () => {
    kdb.when.select(TABLA, [filaMapeo({ id: 'f-1', codigoProducto: 'LOGISTICA' })]);
    siigoRequestOrThrowMock.mockRejectedValue(new Error('503'));
    kdb.when.update(TABLA, []);

    const { revalidarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await revalidarMapeo('pruebas', USUARIO);

    expect(r.conNovedad).toHaveLength(0);
    expect(r.noVerificados).toHaveLength(1);
  });

  it('un mismo código se consulta UNA vez aunque lo usen varios conceptos', async () => {
    kdb.when.select(TABLA, [
      filaMapeo({ id: 'f-1', concepto: 'logistica', codigoProducto: 'COMPARTIDO' }),
      filaMapeo({ id: 'f-2', concepto: 'soat', codigoProducto: 'COMPARTIDO' }),
      filaMapeo({ id: 'f-3', concepto: 'gmf', codigoProducto: 'COMPARTIDO' }),
    ]);
    siigoRequestOrThrowMock.mockResolvedValue(
      listado([{ code: 'COMPARTIDO', name: 'Producto compartido', active: true }]),
    );
    kdb.when.update(TABLA, []);

    const { revalidarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await revalidarMapeo('pruebas', USUARIO);

    expect(r.revisados).toBe(3);
    // Tres filas, una sola petición: la cuota de Siigo es de 100 por minuto y por empresa.
    expect(siigoRequestOrThrowMock).toHaveBeenCalledTimes(1);
  });

  it('la revalidación NO toca la confirmación de contabilidad', async () => {
    kdb.when.select(TABLA, [
      filaMapeo({ id: 'f-1', codigoProducto: 'BORRADO', confirmadoContabilidad: true }),
    ]);
    siigoRequestOrThrowMock.mockResolvedValue(listado([]));

    const capturas: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.resolve([]);
      chain.set = (v: Record<string, unknown>) => { capturas.push(v); return chain; };
      for (const m of ['where', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });

    const { revalidarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await revalidarMapeo('pruebas', USUARIO);

    // Que un producto desaparezca de Siigo no invalida el criterio tributario que se firmó.
    expect(capturas[0]).not.toHaveProperty('confirmadoContabilidad');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('Decisión de diseño — cuota compartida, salud por endpoint', () => {
  it('el limitador comparte clave con los catálogos y el cortacircuitos NO', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(listado([]));
    const { consultarProductoPorCodigo } = await import('../../src/modules/siigo/siigo.productos.service.js');
    const { claveResiliencia } = await import('../../src/modules/siigo/siigo.catalogos.service.js');

    await consultarProductoPorCodigo('LOGISTICA', 'pruebas');

    const opts = opcionesResiliencia[0] as { clave: string; claveCortacircuitos: string };
    // La CUOTA es de la empresa: si productos y catálogos llevaran contadores distintos, entre los
    // dos podrían superar las 100 peticiones por minuto creyendo cada uno que se contiene.
    expect(opts.clave).toBe(claveResiliencia('pruebas'));
    // La SALUD es del endpoint: que /v1/products esté caído no puede frenar la sincronización de
    // /v1/taxes. Es el mismo error que la HU #11281 corrigió entre catálogos.
    expect(opts.claveCortacircuitos).not.toBe(opts.clave);
    expect(opts.claveCortacircuitos).toContain('productos');
  });

  it('la consulta de producto no usa el timeout de 120 s pensado para emitir', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(listado([]));
    const { consultarProductoPorCodigo, TIMEOUT_CONSULTA_PRODUCTO_MS } =
      await import('../../src/modules/siigo/siigo.productos.service.js');

    await consultarProductoPorCodigo('LOGISTICA', 'pruebas');

    const req = siigoRequestOrThrowMock.mock.calls[0]![0] as { timeoutMs: number; ruta: string };
    expect(req.timeoutMs).toBe(TIMEOUT_CONSULTA_PRODUCTO_MS);
    expect(TIMEOUT_CONSULTA_PRODUCTO_MS).toBeLessThan(120_000);
    // Y el código viaja escapado: un código con `&` no puede inyectar otro parámetro.
    expect(req.ruta).toContain('/v1/products?code=');
  });

  it('el código se escapa antes de entrar en la URL', async () => {
    siigoRequestOrThrowMock.mockResolvedValue(listado([]));
    const { consultarProductoPorCodigo } = await import('../../src/modules/siigo/siigo.productos.service.js');

    // No pasa el regex de formato, pero `consultarProductoPorCodigo` es una función pública del
    // servicio: tiene que ser segura por sí misma, no por quién la llame.
    await consultarProductoPorCodigo('A&page_size=100', 'pruebas');

    const req = siigoRequestOrThrowMock.mock.calls[0]![0] as { ruta: string };
    expect(req.ruta).toContain('A%26page_size%3D100');
    expect(req.ruta).not.toContain('&page_size=100');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Regresión de la auditoría de seguridad de esta misma HU.
describe('Regresión — hallazgos de la auditoría de seguridad', () => {
  /** Mock de UPDATE que no captura nada: para los casos donde solo importa el flujo. */
  function updateVacio() {
    kdb.update.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.resolve([]);
      for (const m of ['set', 'where', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });
  }

  it('dos revalidaciones a la vez sobre el mismo ambiente: la segunda se rechaza con 409', async () => {
    kdb.when.select(TABLA, [filaMapeo({ codigoProducto: 'LENTO' })]);
    updateVacio();
    // La consulta se queda colgada para que las dos ejecuciones se solapen de verdad.
    let liberar: ((v: unknown) => void) | null = null;
    const enVuelo = new Promise<void>((avisar) => {
      siigoRequestOrThrowMock.mockImplementation(() => new Promise((r) => {
        liberar = r;
        avisar();
      }));
    });

    const { revalidarMapeo, SiigoMapeoError } =
      await import('../../src/modules/siigo/mapeo-conceptos.service.js');

    const primera = revalidarMapeo('pruebas', USUARIO);
    await enVuelo; // La primera ya está bloqueada dentro de la consulta a Siigo.

    const segunda = await revalidarMapeo('pruebas', USUARIO).catch((x) => x);
    expect(segunda).toBeInstanceOf(SiigoMapeoError);
    expect(segunda.codigo).toBe('en_curso');

    liberar!(listado([{ code: 'LENTO', name: 'ok', active: true }]));
    await primera;
  });

  it('la marca de «en curso» se suelta aunque la revalidación falle', async () => {
    kdb.select.mockImplementation(() => { throw new Error('base caída'); });

    const { revalidarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await revalidarMapeo('pruebas', USUARIO).catch(() => undefined);

    // Si la marca se quedara puesta, el ambiente quedaría bloqueado hasta reiniciar el proceso.
    kdb.reset();
    kdb.when.select(TABLA, []);
    const r = await revalidarMapeo('pruebas', USUARIO);
    expect(r.revisados).toBe(0);
  });

  it('el tope de códigos por ejecución acota la cuota gastada y SE INFORMA', async () => {
    const { MAX_CODIGOS_POR_REVALIDACION } = await import('@operaciones/shared-types');
    const muchas = Array.from({ length: MAX_CODIGOS_POR_REVALIDACION + 25 }, (_, i) =>
      filaMapeo({ id: `f-${i}`, codigoProducto: `COD-${i}` }));
    kdb.when.select(TABLA, muchas);
    updateVacio();
    siigoRequestOrThrowMock.mockImplementation(async (req: { ruta: string }) => {
      const code = new URLSearchParams(req.ruta.split('?')[1]).get('code')!;
      return listado([{ code, name: 'Producto', active: true }]);
    });

    const { revalidarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await revalidarMapeo('pruebas', USUARIO);

    // Una ejecución no monopoliza más de una ventana de cuota de Siigo.
    expect(siigoRequestOrThrowMock).toHaveBeenCalledTimes(MAX_CODIGOS_POR_REVALIDACION);
    // Y no se recorta en silencio: un informe de «0 novedades» tras mirar la mitad daría confianza
    // falsa, que es peor que no haber ejecutado nada.
    expect(r.truncado).toBe(true);
    expect(r.codigosPendientes).toBe(25);
    expect(r.revisados).toBe(MAX_CODIGOS_POR_REVALIDACION);
  });

  it('sin exceder el tope, no se marca como truncado', async () => {
    kdb.when.select(TABLA, [filaMapeo({ codigoProducto: 'UNO' })]);
    updateVacio();
    siigoRequestOrThrowMock.mockResolvedValue(listado([{ code: 'UNO', name: 'x', active: true }]));

    const { revalidarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    const r = await revalidarMapeo('pruebas', USUARIO);

    expect(r.truncado).toBe(false);
    expect(r.codigosPendientes).toBe(0);
  });

  it('el mensaje al cliente NO expone la clave interna del cortacircuitos', async () => {
    const { CircuitoAbiertoError } = await import('../../src/services/circuitBreaker.js');
    siigoRequestOrThrowMock.mockRejectedValue(new CircuitoAbiertoError('siigo:productos:produccion'));

    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');
    const v = await validarMapeoContraSiigo({ codigoProducto: 'LOGISTICA' }, 'produccion');

    // `sanearMensaje` solo corta SQL; la topología interna se filtraba por aquí.
    expect(v.mensaje).not.toContain('siigo:productos');
    expect(v.mensaje).not.toContain('produccion temporalmente');
    expect(v.mensaje).toMatch(/suspendida/i);
  });

  it('el mensaje al cliente NO expone el texto crudo de Siigo en inglés', async () => {
    const { SiigoApiError } = await import('../../src/modules/siigo/siigo.errors.js');
    siigoRequestOrThrowMock.mockRejectedValue(new SiigoApiError({
      status: 429,
      code: 'requests_limit',
      message: 'Too many requests, please slow down',
      reintentable: true,
    }));

    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');
    const v = await validarMapeoContraSiigo({ codigoProducto: 'LOGISTICA' }, 'pruebas');

    expect(v.mensaje).not.toContain('Too many requests');
    expect(v.mensaje).not.toContain('slow down');
    // En su lugar, la descripción operativa que el traductor de errores existe para dar.
    expect(v.mensaje).toMatch(/100 peticiones por minuto/);
  });

  it('el mensaje al cliente NO expone la ruta interna de la API de Siigo', async () => {
    const { SiigoAuthError } = await import('../../src/modules/siigo/siigo.token.js');
    siigoRequestOrThrowMock.mockRejectedValue(
      new SiigoAuthError('Siigo rechazó la petición GET /v1/products?code=SECRETO', 401),
    );

    const { validarMapeoContraSiigo } = await import('../../src/modules/siigo/siigo.productos.service.js');
    const v = await validarMapeoContraSiigo({ codigoProducto: 'LOGISTICA' }, 'pruebas');

    expect(v.mensaje).not.toContain('/v1/products');
    expect(v.mensaje).toMatch(/credenciales/i);
  });

  it('el mensaje persistido se recorta por puntos de código, sin partir pares suplentes', async () => {
    // Un nombre de producto con emoji justo en el límite de 300: `slice` dejaría medio par
    // suplente y Postgres rechazaría el UPDATE con un error que este bucle no captura.
    const nombre = `${'a'.repeat(280)}${'🧾'.repeat(20)}`;
    kdb.when.select(TABLA, [filaMapeo({ codigoProducto: 'EMOJI' })]);
    siigoRequestOrThrowMock.mockResolvedValue(listado([{ code: 'EMOJI', name: nombre, active: true }]));

    const capturas: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      const run = () => Promise.resolve([]);
      chain.set = (v: Record<string, unknown>) => { capturas.push(v); return chain; };
      for (const m of ['where', 'returning']) chain[m] = () => chain;
      chain.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) => run().then(r, j);
      chain.catch = (j: (e: unknown) => unknown) => run().catch(j);
      chain.finally = (cb: () => void) => run().finally(cb);
      return chain;
    });

    const { revalidarMapeo } = await import('../../src/modules/siigo/mapeo-conceptos.service.js');
    await revalidarMapeo('pruebas', USUARIO);

    const guardado = capturas[0]!.validacionMensaje as string;
    expect([...guardado].length).toBeLessThanOrEqual(300);
    // Ningún sustituto suelto: recorrer la cadena por puntos de código y volver a unirla es idéntico.
    expect([...guardado].join('')).toBe(guardado);
    expect(/[\uD800-\uDFFF]/.test(guardado.slice(-1))).toBe(false);
  });
});
