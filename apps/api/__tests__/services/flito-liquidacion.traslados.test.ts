// HU #14118 — tercer sumando de la logística: precio congelado de las líneas de traslado que cobran.
//
// Los adicionales (HU #12619) siguen en `viajes` / `totalViajes`. Estas líneas no. El mock de
// `select` devuelve la mezcla cruda: el WHERE de Postgres no corre aquí, así que el predicado de
// `trasladosDe` es el que tiene que dejar fuera lo que no cobra.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { LineaTrasladoLogistica } from '@operaciones/shared-types';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const tarifaDeMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({ tarifaDe: tarifaDeMock }));

const cubiertoPorCorteMock = vi.fn();
vi.mock('../../src/modules/flito-bolsas/flito-bolsas.descuento.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cubiertoPorCorte: cubiertoPorCorteMock,
}));

const { calcular, liquidacionDe, liquidar, reversar, salidasDe, LiquidacionError } =
  await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

const T0 = new Date('2026-10-01T15:00:00Z');
const T1 = new Date('2026-10-02T15:00:00Z');
const SIN_BOLSA = {
  companiaId: null, soatId: null, soatOrganismo: null, impuestoId: null, impuestoOrganismo: null,
  derechoId: null, derechoOrganismo: null,
};

function filaCompleta(over: Record<string, unknown> = {}) {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', tipoTramite: 'Traspaso', companiaId: 7, fechaAprobacion: null,
    logisticaAutogestionable: false, soatAutogestionable: false, impuestosAutogestionable: false,
    modalidadOrganismo: 'requiere_gestion',
    soatExcepcion: false, impuestoExcepcion: false, logisticaExcepcion: false,
    soatId: 's1', soatEstado: 'pagado', soatValorPagado: '450000',
    impuestoId: 'i1', impuestoEstado: 'pagado', impuestoValorPagado: '120000',
    derechoValor: '80000',
    ...over,
  };
}

function viaje(over: Record<string, unknown> = {}) {
  return {
    id: 'v-2', numero: 2, modo: 'manual', valor: '10000', tarifaVigente: '35000',
    motivo: 'devolucion', motivoDetalle: null, registradoPorId: 4, registradoPorNombre: 'Luis',
    registradoEn: new Date('2026-09-10T14:00:00Z'),
    ...over,
  };
}

/** Fila cruda del join de `trasladosDe`. `precio` es texto, como `numeric`. */
function linea(over: Record<string, unknown> = {}) {
  return {
    id: 'lt-1', documentoId: 'doc-1', trasladoId: 'tr-1', destino: 'flit', estado: 'entregado',
    conceptoPrecio: 'logistica_flit', precio: '10000', tarifaVigenciaId: 'vig-1',
    createdAt: T0, tramiteId: 't1', legado: false,
    ...over,
  };
}

function dto(over: Partial<LineaTrasladoLogistica> = {}): LineaTrasladoLogistica {
  return {
    id: 'lt-1', documentoId: 'doc-1', trasladoId: 'tr-1', destino: 'flit',
    conceptoPrecio: 'logistica_flit', precio: 10000, tarifaVigenciaId: 'vig-1',
    ...over,
  };
}

function tarifas() {
  tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
    concepto === 'tramite_digital'
      ? { valor: 200000, origen: 'especifica' }
      : { valor: 35000, origen: 'generica' });
}

function encolar(traslados: unknown[], viajes: unknown[] = [], fila: Record<string, unknown> = {}) {
  selectMock
    .mockReturnValueOnce(chain([filaCompleta(fila)]))
    .mockReturnValueOnce(chain([]))
    .mockReturnValueOnce(chain(viajes))
    .mockReturnValueOnce(chain(traslados));
}

beforeEach(() => {
  selectMock.mockReset();
  transactionMock.mockReset();
  tarifaDeMock.mockReset();
  tarifas();
  cubiertoPorCorteMock.mockReset();
  cubiertoPorCorteMock.mockResolvedValue(false);
  selectMock.mockReturnValue(chain([]));
});

describe('calcular — solo suma líneas entregadas, no legado, de este trámite (AC1, AC2, AC3)', () => {
  it('flit y cliente del mismo documento suman; el precio 0 entra; el orden es created_at, id', async () => {
    encolar([
      linea({ id: 'lt-cli', destino: 'cliente', conceptoPrecio: 'logistica_cliente', precio: '8000', createdAt: T1 }),
      linea({ id: 'lt-flit', precio: '10000', createdAt: T0 }),
      linea({ id: 'lt-cero', documentoId: 'doc-2', precio: '0.00', createdAt: T0 }),
    ]);
    const c = await calcular('t1');

    expect(c.logistica.traslados).toEqual([
      dto({ id: 'lt-cero', documentoId: 'doc-2', precio: 0 }),
      dto({ id: 'lt-flit', precio: 10000 }),
      dto({ id: 'lt-cli', destino: 'cliente', conceptoPrecio: 'logistica_cliente', precio: 8000 }),
    ]);
    // 35.000 + 0 + 10.000 + 8.000. Ni el viaje 1 dos veces ni solo las líneas.
    expect(c.logistica.valor).toBe(53000);
    expect(c.logistica.tarifa).toBe(35000);
    expect(c.logistica.viajes).toEqual([]);
    expect(c.logistica.totalViajes).toBe(1);
    expect(c.logistica.origen).toBe('Tarifa genérica');
    expect(tarifaDeMock).toHaveBeenCalledTimes(2);
    // 450.000 + 120.000 + 80.000 + 200.000 + 53.000.
    expect(c.baseGmf).toBe(903000);
    expect(c.valorGmf).toBe(3612);
    const logistica = salidasDe(c, {
      companiaId: 7, soatId: 's1', soatOrganismo: 'ORG', impuestoId: 'i1', impuestoOrganismo: 'ORG',
      derechoId: 'd1', derechoOrganismo: 'ORG',
    }).filter((s) => s.concepto === 'logistica');
    expect(logistica).toEqual([{ concepto: 'logistica', valor: 53000, organismoCodigo: null, llave: 'tramite:t1:logistica' }]);
  });

  it('entrega parcial: la línea en ruta del mismo traslado no entra', async () => {
    encolar([
      linea({ id: 'lt-ok', precio: '10000' }),
      linea({ id: 'lt-ruta', documentoId: 'doc-2', estado: 'en_ruta', precio: '99999', createdAt: T1 }),
    ]);
    const c = await calcular('t1');
    expect(c.logistica.traslados).toEqual([dto({ id: 'lt-ok', precio: 10000 })]);
    expect(c.logistica.valor).toBe(45000);
  });

  it('legado, concepto legado, estados que no cobran, sin trámite y otro trámite suman 0', async () => {
    encolar([
      linea({ id: 'leg', legado: true, precio: '40000' }),
      linea({ id: 'conc', conceptoPrecio: 'legado', precio: null, createdAt: T1 }),
      linea({ id: 'reg', estado: 'registrado', precio: '40000' }),
      linea({ id: 'ruta', estado: 'en_ruta', precio: '40000' }),
      linea({ id: 'dev', estado: 'devuelto', precio: '40000' }),
      linea({ id: 'anu', estado: 'anulado', precio: '40000' }),
      linea({ id: 'sin-precio', precio: null }),
      linea({ id: 'sin-tramite', tramiteId: null, precio: '40000' }),
      linea({ id: 'otro', tramiteId: 'otro-tramite', trasladoId: 'tr-1', precio: '40000' }),
    ]);
    const c = await calcular('t1');
    expect(c.logistica.traslados).toEqual([]);
    expect(c.logistica.valor).toBe(35000);
    expect(c.baseGmf).toBe(885000);
  });
});

describe('calcular — los adicionales siguen en viajes; autogestión y tarifa faltante no cobran las líneas', () => {
  it('el adicional queda en `viajes` y no alarga el sufijo ni `totalViajes` por las líneas (AC5)', async () => {
    encolar([linea({ precio: '5000' })], [viaje()]);
    const c = await calcular('t1');
    expect(c.logistica.valor).toBe(50000);
    expect(c.logistica.totalViajes).toBe(2);
    expect(c.logistica.viajes).toHaveLength(1);
    expect(c.logistica.viajes![0]!.valor).toBe(10000);
    expect(c.logistica.origen).toBe('Tarifa genérica + 1 viaje adicional');
    expect(c.logistica.traslados).toEqual([dto({ precio: 5000 })]);
  });

  it('autogestión: ignora las líneas, valor null y el GMF no las lleva', async () => {
    encolar([linea({ precio: '80000' })], [], { logisticaAutogestionable: true });
    const c = await calcular('t1');
    expect(c.logistica).toMatchObject({
      valor: null, bloquea: false, tarifa: null, viajes: [], totalViajes: 0, traslados: [],
    });
    expect(c.baseGmf).toBe(850000);
    expect(c.faltantes).toEqual([]);
    expect(selectMock).toHaveBeenCalledTimes(4);
  });

  it('sin tarifa: sigue bloqueando, el desglose se ve y no entra al total ni al GMF', async () => {
    tarifaDeMock.mockImplementation(async (_c: unknown, concepto: string) =>
      concepto === 'tramite_digital'
        ? { valor: 200000, origen: 'especifica' }
        : { valor: null, origen: 'no_configurada' });
    encolar([linea({ precio: '10000' })]);
    const c = await calcular('t1');
    expect(c.logistica.valor).toBeNull();
    expect(c.logistica.bloquea).toBe(true);
    expect(c.logistica.traslados).toEqual([dto({ precio: 10000 })]);
    expect(c.faltantes).toEqual(['Tarifa de logística no configurada para la compañía']);
    expect(c.baseGmf).toBe(850000);
    expect(c.valorGmf).toBe(3400);
  });
});

describe('sello — entregar después no reescribe; el reverso recalcula; facturado no absorbe (AC4)', () => {
  const lineaA: LineaTrasladoLogistica = {
    id: 'lt-a', documentoId: 'doc-1', trasladoId: 'tr-1', destino: 'flit',
    conceptoPrecio: 'logistica_flit', precio: 15000, tarifaVigenciaId: null,
  };
  const logisticaSellada = {
    valor: 50000, origen: 'Tarifa genérica', bloquea: false, tarifa: 35000,
    viajes: [], totalViajes: 1, traslados: [lineaA], origenValor: 'tarifa', diferencia: null,
  };
  const filaSellada = {
    id: 'l1', tramiteId: 't1', estado: 'liquidado', detalle: { logistica: logisticaSellada },
    valorSoat: '450000', valorImpuesto: '120000', valorDerecho: '80000', valorTramiteDigital: '200000',
    valorLogistica: '50000', valorServiciosAdicionales: null, baseGmf: '885000', tasaGmf: '0.004',
    valorGmf: '3540', total: '888540', liquidadoEn: new Date('2026-10-01T12:00:00Z'), facturadoEn: null,
  };

  it('liquidado: el GET lee el snapshot y no la tabla viva, aunque después se entregue otra línea', async () => {
    selectMock
      .mockReturnValueOnce(chain([filaSellada]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const dtoLeido = await liquidacionDe('t1');
    expect(dtoLeido!.logistica.valor).toBe(50000);
    expect(dtoLeido!.logistica.traslados).toEqual([lineaA]);
    expect(dtoLeido!.total).toBe(888540);
    // Liquidación + idFlit. Una tercera sería la tabla de líneas.
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('con fila, liquidar sigue rechazando y no abre transacción', async () => {
    selectMock
      .mockReturnValueOnce(chain([filaSellada]))
      .mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    await expect(liquidar('t1', 9)).rejects.toThrow(
      'El trámite ya está liquidado. Reversa la liquidación antes de volver a liquidar.',
    );
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('reverso no facturado y un liquidar nuevo recalcula tarifa + adicional vivo + líneas que cobran ahora', async () => {
    selectMock.mockReturnValueOnce(chain([filaSellada]));
    const eventos: Array<Record<string, unknown>> = [];
    const txInsert = vi.fn(() => {
      const c = chain([]) as unknown as Record<string, unknown>;
      c.values = (datos: unknown) => { eventos.push(datos as Record<string, unknown>); return c; };
      return c;
    });
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
      insert: txInsert,
      select: () => chain([]),
      update: () => chain([]),
      delete: () => chain([]),
    }));
    await reversar('t1', 'entrega posterior al sello', 9);
    expect(eventos[0]!.snapshot).toMatchObject({ logistica: { valor: 50000, traslados: [lineaA] }, total: 888540 });

    selectMock.mockReset();
    selectMock.mockReturnValue(chain([]));
    selectMock
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([filaCompleta()]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([linea({ id: 'lt-a', precio: '15000' })]))
      .mockReturnValueOnce(chain([SIN_BOLSA]));
    const escritas: Array<{ tabla: string; datos: Record<string, unknown> }> = [];
    const orden: string[] = [];
    const devuelta = {
      id: 'l2', tramiteId: 't1', estado: 'liquidado', detalle: {}, valorSoat: null, valorImpuesto: null,
      valorDerecho: null, valorTramiteDigital: null, valorLogistica: null, valorServiciosAdicionales: null,
      baseGmf: '1', tasaGmf: '0.004', valorGmf: '0', total: '1', liquidadoEn: new Date(), facturadoEn: null,
    };
    const insert = vi.fn((tabla: unknown) => {
      const c = chain(escritas.length === 0 ? [devuelta] : []) as unknown as Record<string, (a: unknown) => unknown>;
      c.values = (datos: unknown) => {
        escritas.push({ tabla: getTableName(tabla as never), datos: datos as Record<string, unknown> });
        return c;
      };
      return c;
    });
    const respuestas: unknown[][] = [
      [{ id: 't1', idFlit: 'FLIT-1' }],
      [],
      [],
      [viaje()],
      [
        linea({ id: 'lt-a', estado: 'devuelto', precio: '15000', createdAt: T0 }),
        linea({ id: 'lt-b', documentoId: 'doc-2', precio: '20000', createdAt: T1, tarifaVigenciaId: null }),
      ],
    ];
    const nombres = ['bloqueo', 'documental', 'servicios', 'viajes', 'traslados'];
    let n = 0;
    const select = vi.fn(() => {
      const nombre = nombres[n] ?? 'otro';
      const filas = respuestas[n] ?? [];
      n += 1;
      const c = chain(filas) as unknown as Record<string, unknown>;
      c.for = (modo: unknown) => { orden.push(`${nombre}:for:${String(modo)}`); return c; };
      if (nombre !== 'bloqueo') orden.push(nombre);
      return c;
    });
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({ insert, select }));

    await liquidar('t1', 9);

    expect(orden.slice(0, 5)).toEqual(['bloqueo:for:update', 'documental', 'servicios', 'viajes', 'traslados']);
    const liquidacion = escritas.find((e) => e.tabla === 'flito_liquidaciones')!;
    // 35.000 + adicional 10.000 + línea nueva 20.000. La línea vieja está devuelta y no cobra.
    // Un delta «50.000 + 20.000» daría 70.000 y seguiría trayendo lt-a.
    expect(liquidacion.datos.valorLogistica).toBe('65000');
    expect(liquidacion.datos.detalle).toMatchObject({
      logistica: {
        valor: 65000, tarifa: 35000, totalViajes: 2, traslados: [dto({ id: 'lt-b', documentoId: 'doc-2', precio: 20000, tarifaVigenciaId: null })],
      },
    });
    const sellada = (liquidacion.datos.detalle as { logistica: { traslados: LineaTrasladoLogistica[] } }).logistica;
    expect(sellada.traslados.map((t) => t.id)).not.toContain('lt-a');
  });

  it('facturado: reversar sigue prohibido, liquidar no reabre el sello y el total no reparte la línea nueva', async () => {
    const facturada = { ...filaSellada, estado: 'facturado', facturadoEn: new Date('2026-10-03T12:00:00Z') };
    selectMock.mockReturnValueOnce(chain([facturada]));
    const e = await reversar('t1', 'entrega posterior al sello', 9).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(LiquidacionError);
    expect((e as Error).message).toBe('El trámite ya está facturado: su liquidación no puede reversarse');
    expect(transactionMock).not.toHaveBeenCalled();

    selectMock.mockReset();
    selectMock.mockReturnValue(chain([]));
    selectMock.mockReturnValueOnce(chain([facturada])).mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    await expect(liquidar('t1', 9)).rejects.toThrow(
      'El trámite ya está liquidado. Reversa la liquidación antes de volver a liquidar.',
    );
    expect(transactionMock).not.toHaveBeenCalled();

    selectMock.mockReset();
    selectMock.mockReturnValue(chain([]));
    selectMock.mockReturnValueOnce(chain([facturada])).mockReturnValueOnce(chain([{ idFlit: 'FLIT-1' }]));
    const dtoLeido = await liquidacionDe('t1');
    expect(dtoLeido!.logistica.valor).toBe(50000);
    expect(dtoLeido!.logistica.traslados).toEqual([lineaA]);
    expect(dtoLeido!.total).toBe(888540);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});
