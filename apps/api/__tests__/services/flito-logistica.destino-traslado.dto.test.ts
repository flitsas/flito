// HU #14123 — proyección de punto/destino y trasladoId en listado, mi ruta y detalle.
// No filtra por firmar_flit. Null no se omite. Sin cédula ni trazo en estos campos.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, selectDistinct: vi.fn(), insert: vi.fn(),
    update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn(),
  },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/modules/flito-logistica/flito-logistica-precios.js', () => ({
  precioTrasladoDe: vi.fn(),
}));

const { listarActas, miRuta, actaDetalle } = await import('../../src/modules/flito-logistica/flito-logistica.consulta.js');

const ACTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTA2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRASLADO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CREADO = new Date('2026-10-29T15:00:00Z');
const CTX = { userId: 7, username: 'mensajero', role: 'mensajero', operaAjenas: true };

beforeEach(() => {
  selectMock.mockReset();
});

function clavesDeSelect(n = 0): string[] {
  return Object.keys(selectMock.mock.calls[n]![0] as Record<string, unknown>);
}

describe('GET /actas — ActaFila gana punto y trasladoId', () => {
  it('trae punto y trasladoId (incluido null) y el mismo receptorNombre, sin cédula ni firma', async () => {
    selectMock.mockReturnValueOnce(chain([
      {
        id: ACTA, companiaId: 5, companiaNombre: 'ACME', estado: 'despachada',
        mensajeroId: 9, mensajeroNombre: 'Msj', documentos: 1,
        receptorNombre: 'Ana Ruiz', entregadoEn: null, creadoEn: CREADO,
        punto: 'flit', trasladoId: TRASLADO,
      },
      {
        id: ACTA2, companiaId: 7, companiaNombre: 'Beta', estado: 'despachada',
        mensajeroId: 9, mensajeroNombre: 'Msj', documentos: 1,
        receptorNombre: 'Ana Ruiz', entregadoEn: null, creadoEn: CREADO,
        punto: 'cliente', trasladoId: null,
      },
    ]));

    const filas = await listarActas();
    expect(clavesDeSelect()).toEqual(expect.arrayContaining(['punto', 'trasladoId', 'receptorNombre']));
    expect(clavesDeSelect()).not.toEqual(expect.arrayContaining(['receptorDocumento', 'contactoDocumento', 'firmaEntregaKey', 'firmaRecibeKey']));
    expect(filas[0]).toMatchObject({ punto: 'flit', trasladoId: TRASLADO, receptorNombre: 'Ana Ruiz' });
    expect(filas[1]).toMatchObject({ punto: 'cliente', trasladoId: null, receptorNombre: 'Ana Ruiz' });
    expect(JSON.stringify(filas[1])).toContain('"trasladoId":null');
    expect(filas[1]).not.toHaveProperty('destino');
  });
});

describe('GET /mi-ruta — destino y trasladoId', () => {
  it('expone el punto como destino y trasladoId (incluido null); no trae punto ni cédula', async () => {
    selectMock
      .mockReturnValueOnce(chain([
        {
          actaId: ACTA, companiaNombre: 'ACME', direccionEntrega: 'Calle 1', contactoNombre: 'Luis',
          punto: 'flit', trasladoId: TRASLADO,
        },
        {
          actaId: ACTA2, companiaNombre: 'Beta', direccionEntrega: null, contactoNombre: null,
          punto: 'cliente', trasladoId: null,
        },
      ]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]));

    const ruta = await miRuta(CTX);
    expect(clavesDeSelect()).toEqual(expect.arrayContaining(['punto', 'trasladoId']));
    expect(clavesDeSelect()).not.toEqual(expect.arrayContaining(['receptorDocumento', 'contactoDocumento', 'receptorNombre']));
    expect(ruta.entregas[0]).toMatchObject({ actaId: ACTA, destino: 'flit', trasladoId: TRASLADO });
    expect(ruta.entregas[0]).not.toHaveProperty('punto');
    expect(ruta.entregas[1]).toMatchObject({ actaId: ACTA2, destino: 'cliente', trasladoId: null });
    expect(JSON.stringify(ruta.entregas[1])).toContain('"trasladoId":null');
    expect(JSON.stringify(ruta.entregas)).not.toMatch(/cedula|cédula|receptorDocumento|punto/);
  });
});

describe('GET /actas/:id — acta es ActaFila', () => {
  it('acta.trasladoId (null no se omite) y acta.punto; no añade firmante ni trazo', async () => {
    selectMock
      .mockReturnValueOnce(chain([{
        id: ACTA, companiaId: 5, companiaNombre: 'ACME', estado: 'despachada',
        mensajeroId: 9, mensajeroNombre: 'Msj',
        receptorNombre: 'Ana Ruiz', entregadoEn: null, creadoEn: CREADO,
        pdfStorageKey: null, firmaEntregaKey: null, entregaNombre: null, firmaRecibeKey: null,
        punto: 'cliente', trasladoId: null,
      }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]));

    const r = await actaDetalle(ACTA);
    expect(r.acta).toMatchObject({ punto: 'cliente', trasladoId: null, receptorNombre: 'Ana Ruiz' });
    expect(JSON.stringify(r.acta)).toContain('"trasladoId":null');
    expect(r.acta).not.toHaveProperty('firmante');
    expect(r.acta).not.toHaveProperty('trazo');
    expect(r.acta).not.toHaveProperty('receptorDocumento');
    expect(r.punto).toBe('cliente');
    expect(clavesDeSelect()).toEqual(expect.arrayContaining(['punto', 'trasladoId', 'receptorNombre']));
    expect(clavesDeSelect()).not.toEqual(expect.arrayContaining(['receptorDocumento', 'contactoDocumento']));
  });
});
