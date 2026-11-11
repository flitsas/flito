// ADR-0041 §13.6 (Enmienda 1, Épica #13763) — `liquidar()` congela el costo de proveedor en `detalle.costosProveedor`.
//
// Matriz regla → casos (el SQL de `costosProveedorParaSellar` se prueba contra PostgreSQL en
// `__tests__/db/finanzas-costos-proveedor.pg.test.ts`; aquí, lo que hace `liquidar()` con su resultado):
//   C6 / RN-CP-06  se congela con el MISMO `tx` y con las banderas «gestiona» del cálculo; la bitácora lo hereda
//   H-2            un concepto abierto (`null`) se guarda `null`, no `sin_proveedor`
//   C7 / RN-CP-07  `sin_configurar` NO bloquea el sellado
//   C1 / RN-CP-01  total, base, GMF, columnas `valor_*` y salidas de bolsa idénticos con y sin costo
//   C8 / RN-CP-08  `LiquidacionDto` no expone la clave
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { CostosProveedorSellados } from '@operaciones/shared-types';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: vi.fn(async (_c: unknown, concepto: string) => (concepto === 'tramite_digital'
    ? { valor: 200000, origen: 'especifica' } : { valor: 15000, origen: 'generica' })),
}));
vi.mock('../../src/modules/flito-bolsas/flito-bolsas.descuento.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), cubiertoPorCorte: vi.fn().mockResolvedValue(false),
}));
const costosMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/finanzas/finanzas.costos-proveedor.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), costosProveedorParaSellar: costosMock,
}));

const { liquidar } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

const concepto = (estado: string, valor: number | null) => ({
  estado, proveedorId: 'p1', proveedor: 'Proveedor Uno', vigenciaId: valor === null ? null : 'v1', valor,
  fechaReferencia: '2026-11-01T10:00:00.000Z', contadoEnTramiteId: null, contadoEnIdFlit: null,
});
const CON_COSTO = { version: 1, soat: concepto('costo', 12000), logistica: concepto('costo', 8000) } as CostosProveedorSellados;

function filaCompleta(over: Record<string, unknown> = {}) {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', tipoTramite: 'Traspaso', companiaId: 7, fechaAprobacion: null,
    logisticaAutogestionable: false, soatAutogestionable: false, impuestosAutogestionable: false,
    modalidadOrganismo: 'requiere_gestion', soatExcepcion: false, impuestoExcepcion: false, logisticaExcepcion: false,
    soatId: 's1', soatEstado: 'pagado', soatValorPagado: '450000',
    impuestoId: 'i1', impuestoEstado: 'pagado', impuestoValorPagado: '120000', derechoValor: '80000',
    ...over,
  };
}

/** Sella `t1` y devuelve lo escrito DENTRO de la transacción, el `tx` usado y el DTO. Con bolsa (compañía 7). */
async function sellar(costos: CostosProveedorSellados, fila = filaCompleta()) {
  costosMock.mockResolvedValue(costos);
  selectMock
    .mockReturnValueOnce(chain([]))           // liquidacionDe
    .mockReturnValueOnce(chain([fila]))       // calcular
    .mockReturnValueOnce(chain([]))           // serviciosAsignadosDe
    .mockReturnValueOnce(chain([]))           // viajesDe
    .mockReturnValueOnce(chain([]))           // trasladosDe
    .mockReturnValueOnce(chain([{ companiaId: 7, soatId: 's1', soatOrganismo: '05001', impuestoId: 'i1', impuestoOrganismo: '05001', derechoId: null, derechoOrganismo: null }]));
  const escritas: Array<{ tabla: string; datos: Record<string, unknown> }> = [];
  const insert = vi.fn((tabla: unknown) => ({
    values: (datos: Record<string, unknown>) => {
      escritas.push({ tabla: getTableName(tabla as never), datos });
      // El sellado devuelve lo que se escribió: así el DTO sale del `detalle` REAL, con la clave dentro.
      return chain([{ id: 'l1', estado: 'liquidado', liquidadoEn: new Date('2026-11-02T00:00:00Z'), facturadoEn: null, ...datos }]);
    },
  }));
  const tx = {
    insert,
    select: vi.fn().mockReturnValueOnce(chain([{ id: 't1', idFlit: 'FLIT-1' }])).mockReturnValue(chain([])),
    update: vi.fn(() => chain([])), execute: vi.fn(async () => []),
  };
  transactionMock.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  const dto = await liquidar('t1', 1);
  return { escritas, tx, dto, liquidacion: escritas.find((e) => e.tabla === 'flito_liquidaciones')!.datos };
}

beforeEach(() => {
  selectMock.mockReset();
  transactionMock.mockReset();
  costosMock.mockReset();
  selectMock.mockReturnValue(chain([]));
});

describe('C6 / RN-CP-06 — liquidar() congela el costo de proveedor', () => {
  it('escribe detalle.costosProveedor con el MISMO tx y las banderas «gestiona» del cálculo; la bitácora lo hereda', async () => {
    const { liquidacion, tx, escritas } = await sellar(CON_COSTO);
    expect(costosMock).toHaveBeenCalledWith(tx, 't1', { gestionaSoat: true, gestionaLogistica: true });
    expect((liquidacion.detalle as Record<string, unknown>).costosProveedor).toEqual(CON_COSTO);
    const evento = escritas.find((e) => e.tabla === 'flito_liquidacion_eventos')!;
    expect((evento.datos.snapshot as Record<string, unknown>).costosProveedor).toEqual(CON_COSTO);
  });

  it('la compañía que autogestiona SOAT y logística pasa gestiona=false (H-4: sin_proveedor definitivo)', async () => {
    await sellar(CON_COSTO, filaCompleta({ soatAutogestionable: true, logisticaAutogestionable: true }));
    expect(costosMock).toHaveBeenCalledWith(expect.anything(), 't1', { gestionaSoat: false, gestionaLogistica: false });
  });

  it('H-2 — un concepto abierto (logística sin entrega al sellar) se guarda null, no sin_proveedor', async () => {
    const abierto = { version: 1, soat: concepto('costo', 12000), logistica: null } as CostosProveedorSellados;
    const { liquidacion } = await sellar(abierto);
    const guardado = (liquidacion.detalle as { costosProveedor: CostosProveedorSellados }).costosProveedor;
    expect(guardado.logistica).toBeNull();
    expect(guardado.soat).toMatchObject({ estado: 'costo', valor: 12000 });
  });
});

describe('C7 / RN-CP-07 — sin_configurar NO bloquea el sellado', () => {
  it('con los dos conceptos sin configurar, liquidar() sella igual', async () => {
    const sinConf = { version: 1, soat: concepto('sin_configurar', null), logistica: concepto('sin_configurar', null) } as CostosProveedorSellados;
    const { liquidacion } = await sellar(sinConf);
    expect(liquidacion.estado).toBe('liquidado');
    expect((liquidacion.detalle as { costosProveedor: CostosProveedorSellados }).costosProveedor.soat?.estado).toBe('sin_configurar');
  });
});

describe('C1 / RN-CP-01 — el costo no toca el cobro sellado', () => {
  it('total, base, GMF, valor_* y salidas de bolsa idénticos con y sin costo de proveedor', async () => {
    const sin = await sellar({ version: 1, soat: null, logistica: null });
    const con = await sellar(CON_COSTO);
    const sinDetalle = (d: Record<string, unknown>) => {
      const { detalle, ...resto } = d;
      const { costosProveedor: _c, ...det } = detalle as Record<string, unknown>;
      return { ...resto, detalle: det };
    };
    expect(sinDetalle(con.liquidacion)).toEqual(sinDetalle(sin.liquidacion));
    expect(con.liquidacion.total).toBe(sin.liquidacion.total);
    const otras = (e: typeof sin.escritas) => e.filter((x) => !['flito_liquidaciones', 'flito_liquidacion_eventos'].includes(x.tabla));
    expect(otras(con.escritas)).toEqual(otras(sin.escritas));
    expect(con.dto.total).toBe(sin.dto.total);
    expect(con.dto.faltantes).toEqual(sin.dto.faltantes);
  });
});

describe('C8 / RN-CP-08 — LiquidacionDto no expone el costo', () => {
  it('el DTO devuelto por liquidar() no lleva costosProveedor ni el nombre del proveedor', async () => {
    const { dto, liquidacion } = await sellar(CON_COSTO);
    expect((liquidacion.detalle as Record<string, unknown>).costosProveedor).toBeDefined();
    const texto = JSON.stringify(dto);
    expect(texto).not.toContain('costosProveedor');
    expect(texto).not.toContain('Proveedor Uno');
  });
});
