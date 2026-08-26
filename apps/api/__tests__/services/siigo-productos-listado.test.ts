// Siigo — el listado de productos para elegir uno (A3).
//
// Lo que estas pruebas vigilan no es el camino feliz: es que el listado NO MIENTA. Siigo no tiene
// filtro por nombre, así que el filtro se aplica sobre lo que se trajo — y un listado que se corta
// en silencio se lee como completo, con lo que quien no encuentre su producto va a concluir que no
// está en Siigo cuando sí está.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const siigoRequestOrThrowMock = vi.fn();
vi.mock('../../src/modules/siigo/siigo.client.js', () => ({
  siigoRequestOrThrow: (req: unknown) => siigoRequestOrThrowMock(req),
  siigoRequest: vi.fn(),
  SiigoRequestError: class extends Error {},
}));
vi.mock('../../src/modules/siigo/siigo.resiliencia.js', async (original) => {
  const real = await original<typeof import('../../src/modules/siigo/siigo.resiliencia.js')>();
  return { ...real, ejecutarConResiliencia: async (op: () => Promise<unknown>) => op() };
});

const { listarProductos, MAX_PAGINAS_PRODUCTOS, TAM_PAGINA_PRODUCTOS } = await import(
  '../../src/modules/siigo/siigo.productos.service.js');

function producto(over: Record<string, unknown> = {}) {
  return { id: 'p', code: 'P-1', name: 'Producto', active: true, taxes: [], ...over };
}

/** Una página llena, para que el recorrido siga pidiendo la siguiente. */
function paginaLlena(n: number) {
  return {
    pagination: { page: n, page_size: TAM_PAGINA_PRODUCTOS, total_results: 999 },
    results: Array.from({ length: TAM_PAGINA_PRODUCTOS }, (_, i) => producto({
      code: `P-${n}-${i}`, name: `Producto ${n}-${i}`,
    })),
  };
}

beforeEach(() => { siigoRequestOrThrowMock.mockReset(); });

describe('lo que se trae', () => {
  it('devuelve código, nombre, actividad e impuestos de Siigo', async () => {
    siigoRequestOrThrowMock.mockResolvedValueOnce({
      pagination: { page: 1, page_size: 100, total_results: 1 },
      results: [producto({
        code: 'SERV-NUBE', name: 'Servicio en la Nube',
        taxes: [{ id: 13156, name: 'IVA 19%', percentage: 19 }],
      })],
    });

    const r = await listarProductos('pruebas');

    expect(r.items).toEqual([{
      codigo: 'SERV-NUBE',
      nombre: 'Servicio en la Nube',
      activo: true,
      // Desde A7 los impuestos son de Siigo: FLITO no guarda copia, los enseña.
      impuestos: [{ id: 13156, nombre: 'IVA 19%', porcentaje: 19 }],
    }]);
    expect(r.truncado).toBe(false);
  });

  it('`active` ausente se trata como INACTIVO', async () => {
    // Mismo sesgo que la consulta por código: ante una respuesta incompleta, no dar por bueno un
    // producto con el que se va a facturar ante la DIAN.
    siigoRequestOrThrowMock.mockResolvedValueOnce({ results: [producto({ active: undefined })] });
    expect((await listarProductos('pruebas')).items[0]!.activo).toBe(false);
  });

  it('para de pedir páginas en cuanto una viene incompleta', async () => {
    // Sin fiarse del total, que Siigo no siempre reporta.
    siigoRequestOrThrowMock.mockResolvedValueOnce({ results: [producto()] });
    await listarProductos('pruebas');
    expect(siigoRequestOrThrowMock).toHaveBeenCalledTimes(1);
  });
});

describe('el listado no miente sobre lo que no miró', () => {
  it('al llegar al tope lo DICE, en vez de parecer completo', async () => {
    for (let i = 1; i <= MAX_PAGINAS_PRODUCTOS; i += 1) {
      siigoRequestOrThrowMock.mockResolvedValueOnce(paginaLlena(i));
    }

    const r = await listarProductos('pruebas');

    expect(siigoRequestOrThrowMock).toHaveBeenCalledTimes(MAX_PAGINAS_PRODUCTOS);
    expect(r.truncado).toBe(true);
    expect(r.total).toBe(999);
  });

  it('el tope acota de verdad: no se recorre el catálogo entero', async () => {
    // La cuota de Siigo se comparte con la emisión. Un selector no puede vaciarla.
    siigoRequestOrThrowMock.mockResolvedValue(paginaLlena(1));
    await listarProductos('pruebas');
    expect(siigoRequestOrThrowMock.mock.calls.length).toBeLessThanOrEqual(MAX_PAGINAS_PRODUCTOS);
  });
});

describe('la búsqueda, que Siigo no ofrece', () => {
  beforeEach(() => {
    siigoRequestOrThrowMock.mockResolvedValueOnce({
      results: [
        producto({ code: 'SERV-NUBE', name: 'Servicio en la Nube' }),
        producto({ code: 'SOAT-2024', name: 'SOAT — Seguro Obligatorio' }),
        producto({ code: 'DER-TRANSITO', name: 'Derecho de tránsito' }),
      ],
    });
  });

  it('busca por nombre, que es lo que la gente escribe', async () => {
    const r = await listarProductos('pruebas', { busqueda: 'nube' });
    expect(r.items.map((p) => p.codigo)).toEqual(['SERV-NUBE']);
  });

  it('y también por código', async () => {
    const r = await listarProductos('pruebas', { busqueda: 'soat' });
    expect(r.items.map((p) => p.codigo)).toEqual(['SOAT-2024']);
  });

  it('el filtro NO viaja a Siigo: sus filtros documentados no incluyen el nombre', async () => {
    await listarProductos('pruebas', { busqueda: 'nube' });
    const ruta = (siigoRequestOrThrowMock.mock.calls[0]![0] as { ruta: string }).ruta;
    expect(ruta).not.toContain('nube');
    expect(ruta).toContain('page=1');
  });

  it('ordena por nombre y no por fecha de creación, que es como los devuelve Siigo', async () => {
    // Alfabético de verdad y no por bytes: `localeCompare('es')` pone «Servicio» antes que «SOAT»
    // porque compara Se < So sin que la mayúscula mande. Es lo que espera quien lee un desplegable;
    // el orden ASCII metería todo lo que empieza por mayúscula delante de lo que no.
    const r = await listarProductos('pruebas');
    expect(r.items.map((p) => p.nombre))
      .toEqual(['Derecho de tránsito', 'Servicio en la Nube', 'SOAT — Seguro Obligatorio']);
  });
});
