// HU #12373 — tarifas como VIGENCIAS con historial (Feature #12365; antes HU #10963).
//
// El núcleo sigue siendo `tarifaDe()`: qué valor gana y, sobre todo, que un concepto sin configurar
// NO devuelva cero. Lo nuevo es `cambiarOCerrar`: cerrar la abierta y abrir la nueva tienen que ir
// por la MISMA transacción y con el MISMO instante (RN-01). Para verlo, el double de `transaction`
// ejecuta el callback contra un `txMock` DISTINTO de `dbMock`: una escritura que se salga de la
// transacción cae en `dbMock` y el test la nombra (mutante M1).
//
// TZ=UTC a propósito: el mutante del reloj del proceso sobrevive en -05 si se comparan instantes.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { chain, chainReject } from '../helpers/db.js';
import { renderizar } from '../helpers/sql-ligado.js';
import { tipoTramiteTarifaDe, valorTarifaValido } from '@operaciones/shared-types';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const transactionMock = vi.fn();

const txSelect = vi.fn();
const txInsert = vi.fn();
const txUpdate = vi.fn();
const txMock = { select: txSelect, insert: txInsert, update: txUpdate };

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  tarifaDe, fijarTarifa, cambiarOCerrar, historial,
  TarifaError, TarifaCeroSinConfirmarError, TarifaConflictoError, TarifaNoEncontradaError,
} = await import('../../src/modules/flito-parametrizacion/flito-tarifas.service.js');

/** Un chain que además GRABA lo que recibió `values()` / `set()`: el mock del repo los descarta. */
function grabando(rows: unknown[], sobre: { values?: unknown; set?: unknown }) {
  const c = chain(rows) as unknown as Record<string, (a: unknown) => unknown>;
  c.values = (a: unknown) => { sobre.values = a; return c; };
  c.set = (a: unknown) => { sobre.set = a; return c; };
  return c;
}

/**
 * Un chain que GRABA los argumentos de `where()` y `orderBy()`. El mock del repo es passthrough en
 * los dos (memoria: «el mock ignora orderBy»), así que el orden y el rango solo se prueban leyendo
 * el SQL renderizado de lo que el servicio le pasó.
 */
function espiando(rows: unknown[], sobre: { where?: SQL; orderBy?: SQL[] }) {
  const c = chain(rows) as unknown as Record<string, (...a: unknown[]) => unknown>;
  c.where = (a: unknown) => { sobre.where = a as SQL; return c; };
  c.orderBy = (...a: unknown[]) => { sobre.orderBy = a as SQL[]; return c; };
  return c;
}

const AHORA = new Date('2026-09-10T15:00:00.000Z');
const ABIERTA = { id: 'v-1', companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'MATRICULA', valor: '270000.00', vigenteHasta: null };
const FILA_TARIFA = (over: Record<string, unknown> = {}) => ({
  id: 'v-2', companiaId: 7, companiaNombre: 'ACME', concepto: 'tramite_digital', tipoTramite: 'MATRICULA',
  valor: '300000.00', vigenteDesde: AHORA, vigenteHasta: null, fijadoEn: AHORA, ...over,
});
const COMPANIA = { id: 7, name: 'ACME', logisticaAutogestionable: false };

beforeEach(() => {
  selectMock.mockReset(); insertMock.mockReset(); updateMock.mockReset(); transactionMock.mockReset();
  txSelect.mockReset(); txInsert.mockReset(); txUpdate.mockReset();
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock));
  vi.useFakeTimers();
  vi.setSystemTime(AHORA);
});
afterEach(() => { vi.useRealTimers(); });

describe('tipoTramiteTarifaDe — catálogo CERRADO de tres tipos (RN-02, AC11)', () => {
  it('acepta tilde, minúsculas y espacios y devuelve la forma canónica', () => {
    expect(tipoTramiteTarifaDe('matrícula')).toBe('MATRICULA');
    expect(tipoTramiteTarifaDe('  Traspaso ')).toBe('TRASPASO');
    expect(tipoTramiteTarifaDe('OTROS')).toBe('OTROS');
  });

  it('un tipo fuera del catálogo o vacío es null: nunca adivina «OTROS»', () => {
    expect(tipoTramiteTarifaDe('Cancelacion')).toBeNull();
    expect(tipoTramiteTarifaDe('')).toBeNull();
    expect(tipoTramiteTarifaDe(null)).toBeNull();
    expect(tipoTramiteTarifaDe(undefined)).toBeNull();
  });
});

describe('valorTarifaValido — la regla del valor (AC9)', () => {
  it('finito, no negativo, dos decimales como máximo', () => {
    expect(valorTarifaValido(0)).toBe(true);
    expect(valorTarifaValido(320000)).toBe(true);
    expect(valorTarifaValido(12.5)).toBe(true);
    expect(valorTarifaValido(-1)).toBe(false);
    expect(valorTarifaValido(1.005)).toBe(false);
    expect(valorTarifaValido('100')).toBe(false);
    expect(valorTarifaValido(Number.NaN)).toBe(false);
    expect(valorTarifaValido(1e13)).toBe(false);
  });
});

describe('tarifaDe — resuelve la vigencia ABIERTA de la llave exacta', () => {
  it('trámite digital: la abierta del tipo pedido, comparado normalizado', async () => {
    selectMock.mockReturnValueOnce(chain([{ valor: '250000' }]));
    const r = await tarifaDe(7, 'tramite_digital', '  traspaso ');
    expect(r).toEqual({ valor: 250000, origen: 'especifica' });
  });

  it('un tipo desconocido es «no configurada», no «OTROS» ni una genérica, y ni siquiera consulta', async () => {
    const r = await tarifaDe(7, 'tramite_digital', 'Cancelacion');
    expect(r).toEqual({ valor: null, origen: 'no_configurada' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('sin vigencia abierta devuelve «no configurada», nunca cero', async () => {
    // Un cero aquí sumaría un total falso en el reporte y nadie lo notaría.
    selectMock.mockReturnValueOnce(chain([]));
    const r = await tarifaDe(7, 'tramite_digital', 'Matricula');
    expect(r).toEqual({ valor: null, origen: 'no_configurada' });
    expect(r.valor).not.toBe(0);
  });

  it('logística ignora el tipo y se rotula «generica» (RN-03)', async () => {
    selectMock.mockReturnValueOnce(chain([{ valor: '45000' }]));
    const r = await tarifaDe(7, 'logistica', 'Traspaso');
    expect(r).toEqual({ valor: 45000, origen: 'generica' });
  });

  it('un trámite sin compañía emparejada no tiene tarifa', async () => {
    const r = await tarifaDe(null, 'tramite_digital', 'Traspaso');
    expect(r.origen).toBe('no_configurada');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('un valor de cero configurado a propósito sí se respeta (AC10)', async () => {
    selectMock.mockReturnValueOnce(chain([{ valor: '0' }]));
    const r = await tarifaDe(7, 'logistica', null);
    expect(r).toEqual({ valor: 0, origen: 'generica' });
  });
});

describe('fijarTarifa — abre la PRIMERA vigencia de una llave (AC4, AC9, AC10, AC11)', () => {
  it('rechaza valor negativo, tres decimales y no numérico sin tocar la base', async () => {
    for (const valor of [-1, 1.005, Number.NaN, '100' as unknown as number]) {
      await expect(fijarTarifa({ companiaId: 7, concepto: 'logistica', valor }, 1)).rejects.toBeInstanceOf(TarifaError);
    }
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('trámite digital con tipo vacío o fuera del catálogo → error que nombra los tres tipos', async () => {
    for (const tipoTramite of ['', null, 'Cancelacion']) {
      await expect(fijarTarifa({ companiaId: 7, concepto: 'tramite_digital', tipoTramite, valor: 1000 }, 1))
        .rejects.toThrow(/Matricula, Traspaso u Otros/);
    }
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('logística con tipo → error: un solo valor por compañía', async () => {
    await expect(fijarTarifa({ companiaId: 7, concepto: 'logistica', tipoTramite: 'Traspaso', valor: 1000 }, 1))
      .rejects.toThrow(/no lleva tipo/);
  });

  it('cero sin confirmación → error específico; con confirmación se guarda 0', async () => {
    await expect(fijarTarifa({ companiaId: 7, concepto: 'logistica', valor: 0 }, 1))
      .rejects.toBeInstanceOf(TarifaCeroSinConfirmarError);
    expect(insertMock).not.toHaveBeenCalled();

    const grabado: { values?: { valor?: string } } = {};
    selectMock.mockReturnValueOnce(chain([COMPANIA])).mockReturnValueOnce(chain([FILA_TARIFA({ valor: '0.00' })]));
    insertMock.mockReturnValueOnce(grabando([{ id: 'v-2' }], grabado));
    const t = await fijarTarifa({ companiaId: 7, concepto: 'logistica', valor: 0, confirmarCero: true }, 1);
    expect(grabado.values?.valor).toBe('0');
    expect(t.valor).toBe(0);
  });

  it('rechaza una compañía inexistente', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(fijarTarifa({ companiaId: 999, concepto: 'logistica', valor: 1000 }, 1)).rejects.toThrow(/no existe/i);
  });

  it('guarda el tipo normalizado, el instante del servidor como vigente_desde = fijado_en, y quién fija', async () => {
    const grabado: { values?: Record<string, unknown> } = {};
    selectMock.mockReturnValueOnce(chain([COMPANIA])).mockReturnValueOnce(chain([FILA_TARIFA()]));
    insertMock.mockReturnValueOnce(grabando([{ id: 'v-2' }], grabado));
    const t = await fijarTarifa({ companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'matrícula', valor: 320000 }, 9);
    expect(grabado.values).toMatchObject({ companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'MATRICULA', valor: '320000', fijadoPorId: 9 });
    expect(grabado.values?.vigenteDesde).toBe(grabado.values?.fijadoEn);
    expect((grabado.values?.vigenteDesde as Date).toISOString()).toBe(AHORA.toISOString());
    expect(t.activo).toBe(true);
    expect(t.vigenteDesde).toBe(AHORA.toISOString());
  });

  it('si la llave ya tiene vigencia abierta (23505 del índice parcial) → conflicto con el id de la abierta', async () => {
    selectMock.mockReturnValueOnce(chain([COMPANIA])).mockReturnValueOnce(chain([{ id: 'v-abierta' }]));
    insertMock.mockReturnValueOnce(chainReject(Object.assign(new Error('dup'), { code: '23505' })));
    const e = await fijarTarifa({ companiaId: 7, concepto: 'logistica', valor: 1000 }, 1).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TarifaConflictoError);
    expect((e as InstanceType<typeof TarifaConflictoError>).vigenciaId).toBe('v-abierta');
    expect((e as Error).message).toMatch(/Editar/);
  });
});

describe('cambiarOCerrar — cerrar y abrir en UNA transacción con UN instante (AC5, AC6, AC7, RN-01)', () => {
  it('cambiar: el UPDATE que cierra y el INSERT que abre van por tx, con el mismo `ahora`, tras el FOR UPDATE (mutante M1)', async () => {
    const orden: string[] = [];
    const cierre: { set?: Record<string, unknown> } = {};
    const apertura: { values?: Record<string, unknown> } = {};
    txSelect.mockImplementation(() => { orden.push('select'); return chain([ABIERTA]); });
    txUpdate.mockImplementation(() => { orden.push('update'); return grabando([], cierre); });
    txInsert.mockImplementation(() => { orden.push('insert'); return grabando([{ id: 'v-2' }], apertura); });
    selectMock.mockReturnValueOnce(chain([FILA_TARIFA()]));

    const r = await cambiarOCerrar('v-1', { valor: 300000, activo: true }, 9);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(orden).toEqual(['select', 'update', 'insert']);
    // Ninguna escritura fuera de la transacción.
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    // El cierre y la apertura comparten el MISMO objeto Date: [a, ahora) y [ahora, ∞), sin hueco ni solape.
    expect(cierre.set?.vigenteHasta).toBeInstanceOf(Date);
    expect(apertura.values?.vigenteDesde).toBe(cierre.set?.vigenteHasta);
    expect(cierre.set?.cerradoEn).toBe(cierre.set?.vigenteHasta);
    expect(apertura.values?.fijadoEn).toBe(apertura.values?.vigenteDesde);
    expect((cierre.set?.vigenteHasta as Date).toISOString()).toBe(AHORA.toISOString());
    expect(cierre.set).toMatchObject({ cerradoPorId: 9 });
    expect(apertura.values).toMatchObject({
      companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'MATRICULA', valor: '300000', fijadoPorId: 9,
    });
    expect(r.accion).toBe('cambiada');
    expect(r.valorAnterior).toBe(270000);
    expect(r.valorNuevo).toBe(300000);
    expect(r.tarifa.id).toBe('v-2');
  });

  it('el valor anterior es el de la base leído en la transacción, no el que el cliente creyó ver (AC6)', async () => {
    // B guarda 120000 «sobre 100000», pero A ya cambió a 110000: la base manda.
    txSelect.mockReturnValueOnce(chain([{ ...ABIERTA, valor: '110000.00' }]));
    txUpdate.mockReturnValueOnce(chain([]));
    txInsert.mockReturnValueOnce(chain([{ id: 'v-3' }]));
    selectMock.mockReturnValueOnce(chain([FILA_TARIFA({ id: 'v-3', valor: '120000.00' })]));
    const r = await cambiarOCerrar('v-1', { valor: 120000 }, 5);
    expect(r.valorAnterior).toBe(110000);
    expect(r.valorNuevo).toBe(120000);
  });

  it('dejar de cobrar (`activo:false`) cierra con cerrado_por y NO abre otra (AC7)', async () => {
    const cierre: { set?: Record<string, unknown> } = {};
    txSelect.mockReturnValueOnce(chain([{ ...ABIERTA, concepto: 'logistica', tipoTramite: null, valor: '45000.00' }]));
    txUpdate.mockReturnValueOnce(grabando([], cierre));
    selectMock.mockReturnValueOnce(chain([FILA_TARIFA({ id: 'v-1', concepto: 'logistica', tipoTramite: null, valor: '45000.00', vigenteHasta: AHORA })]));

    const r = await cambiarOCerrar('v-1', { valor: 45000, activo: false }, 9);

    expect(txInsert).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(cierre.set).toMatchObject({ cerradoPorId: 9 });
    expect((cierre.set?.vigenteHasta as Date).toISOString()).toBe(AHORA.toISOString());
    expect(r.accion).toBe('cerrada');
    expect(r.valorAnterior).toBe(45000);
    expect(r.valorNuevo).toBeNull();
    expect(r.tarifa.activo).toBe(false);
  });

  it('`cerrar:true` es alias de `activo:false`', async () => {
    txSelect.mockReturnValueOnce(chain([ABIERTA]));
    txUpdate.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([FILA_TARIFA({ id: 'v-1', vigenteHasta: AHORA })]));
    const r = await cambiarOCerrar('v-1', { cerrar: true }, 9);
    expect(r.accion).toBe('cerrada');
    expect(txInsert).not.toHaveBeenCalled();
  });

  it('el mismo valor es un no-op: ni cierra ni abre', async () => {
    txSelect.mockReturnValueOnce(chain([ABIERTA]));
    selectMock.mockReturnValueOnce(chain([FILA_TARIFA({ id: 'v-1', valor: '270000.00' })]));
    const r = await cambiarOCerrar('v-1', { valor: 270000, activo: true }, 9);
    expect(r.accion).toBe('sin_cambio');
    expect(txUpdate).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
    expect(r.valorAnterior).toBe(270000);
    expect(r.valorNuevo).toBe(270000);
  });

  it('cero sin confirmar → error y ninguna escritura; con confirmar abre la vigencia en 0 (AC10)', async () => {
    txSelect.mockReturnValueOnce(chain([ABIERTA]));
    await expect(cambiarOCerrar('v-1', { valor: 0 }, 9)).rejects.toBeInstanceOf(TarifaCeroSinConfirmarError);
    expect(txUpdate).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();

    const apertura: { values?: Record<string, unknown> } = {};
    txSelect.mockReturnValueOnce(chain([ABIERTA]));
    txUpdate.mockReturnValueOnce(chain([]));
    txInsert.mockReturnValueOnce(grabando([{ id: 'v-2' }], apertura));
    selectMock.mockReturnValueOnce(chain([FILA_TARIFA({ valor: '0.00' })]));
    const r = await cambiarOCerrar('v-1', { valor: 0, confirmarCero: true }, 9);
    expect(apertura.values?.valor).toBe('0');
    expect(r.valorNuevo).toBe(0);
  });

  it('una vigencia inexistente → no encontrada (404)', async () => {
    txSelect.mockReturnValueOnce(chain([]));
    await expect(cambiarOCerrar('nada', { valor: 10 }, 9)).rejects.toBeInstanceOf(TarifaNoEncontradaError);
  });

  it('una vigencia ya cerrada → conflicto con el id de la abierta de su llave (409)', async () => {
    txSelect
      .mockReturnValueOnce(chain([{ ...ABIERTA, vigenteHasta: new Date('2026-09-01T00:00:00Z') }]))
      .mockReturnValueOnce(chain([{ id: 'v-viva' }]));
    const e = await cambiarOCerrar('v-1', { valor: 10 }, 9).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TarifaConflictoError);
    expect((e as InstanceType<typeof TarifaConflictoError>).vigenciaId).toBe('v-viva');
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('un valor inválido se rechaza antes de abrir la transacción', async () => {
    await expect(cambiarOCerrar('v-1', { valor: -5 }, 9)).rejects.toBeInstanceOf(TarifaError);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('un 23P01 de la EXCLUDE (carrera de dos aperturas) se traduce a conflicto', async () => {
    txSelect.mockReturnValueOnce(chain([ABIERTA]));
    txUpdate.mockReturnValueOnce(chain([]));
    txInsert.mockReturnValueOnce(chainReject(Object.assign(new Error('solape'), { code: '23P01' })));
    await expect(cambiarOCerrar('v-1', { valor: 10 }, 9)).rejects.toBeInstanceOf(TarifaConflictoError);
  });
});

describe('historial — filtros por llave y por rango de días (AC13, AC14)', () => {
  it('consulta la compañía y devuelve las vigencias con fijado_por y cerrado_por', async () => {
    selectMock
      .mockReturnValueOnce(chain([COMPANIA]))
      .mockReturnValueOnce(chain([{
        id: 'v-1', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: '250000.00',
        vigenteDesde: new Date('2026-08-15T10:00:00Z'), vigenteHasta: new Date('2026-09-01T10:00:00Z'),
        fijadoPorId: 2, fijadoPorNombre: 'Ana', fijadoEn: new Date('2026-08-15T10:00:00Z'),
        cerradoPorId: 3, cerradoPorNombre: 'Luis', cerradoEn: new Date('2026-09-01T10:00:00Z'),
      }]));
    const h = await historial(7, { concepto: 'tramite_digital', tipoTramite: 'TRASPASO', rango: { desde: '2026-08-01', hasta: '2026-08-31' } });
    expect(h).toEqual([{
      id: 'v-1', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 250000,
      vigenteDesde: '2026-08-15T10:00:00.000Z', vigenteHasta: '2026-09-01T10:00:00.000Z',
      fijadoPor: { id: 2, nombre: 'Ana' }, fijadoEn: '2026-08-15T10:00:00.000Z',
      cerradoPor: { id: 3, nombre: 'Luis' }, cerradoEn: '2026-09-01T10:00:00.000Z',
    }]);
  });

  it('compañía inexistente → no encontrada', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(historial(999)).rejects.toBeInstanceOf(TarifaNoEncontradaError);
  });

  const VD = '"flito_tarifas_vigencias"."vigente_desde"';

  it('ordena del más reciente al más antiguo dentro de cada llave: el último criterio es `vigente_desde desc` (AC13)', async () => {
    const q: { where?: SQL; orderBy?: SQL[] } = {};
    selectMock.mockReturnValueOnce(chain([COMPANIA])).mockReturnValueOnce(espiando([], q));
    await historial(7);
    const criterios = q.orderBy!.map((o) => renderizar(o).sql);
    expect(criterios).toEqual([
      '"flito_tarifas_vigencias"."concepto" asc',
      '"flito_tarifas_vigencias"."tipo_tramite" asc',
      `${VD} desc`,
    ]);
    expect(criterios[criterios.length - 1]).toBe(`${VD} desc`);
  });

  it('con rango, el WHERE acota `vigente_desde` a los días de Colombia [desde, hasta + 1 día) y con llave filtra concepto y tipo (AC14)', async () => {
    const q: { where?: SQL; orderBy?: SQL[] } = {};
    selectMock.mockReturnValueOnce(chain([COMPANIA])).mockReturnValueOnce(espiando([], q));
    await historial(7, { concepto: 'tramite_digital', tipoTramite: 'TRASPASO', rango: { desde: '2026-08-01', hasta: '2026-08-31' } });
    const { sql, params } = renderizar(q.where!);
    // La forma exacta de createdInRangeCondition: día calendario de Colombia, límite superior exclusivo.
    const desde = new RegExp(`${VD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} >= \\(\\$(\\d+)::date AT TIME ZONE \\$(\\d+)\\)`).exec(sql);
    const hasta = new RegExp(`${VD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} < \\(\\(\\$(\\d+)::date \\+ interval '1 day'\\) AT TIME ZONE \\$(\\d+)\\)`).exec(sql);
    expect(desde, sql).not.toBeNull();
    expect(hasta, sql).not.toBeNull();
    expect([params[Number(desde![1]) - 1], params[Number(desde![2]) - 1]]).toEqual(['2026-08-01', 'America/Bogota']);
    expect([params[Number(hasta![1]) - 1], params[Number(hasta![2]) - 1]]).toEqual(['2026-08-31', 'America/Bogota']);
    // Y la llave: compañía, concepto y tipo, cada uno ligado a su valor.
    const ligado = (col: string) => params[Number(new RegExp(`"${col}" = \\$(\\d+)`).exec(sql)![1]) - 1];
    expect(ligado('compania_id')).toBe(7);
    expect(ligado('concepto')).toBe('tramite_digital');
    expect(ligado('tipo_tramite')).toBe('TRASPASO');
  });

  it('sin rango ni llave, el WHERE solo acota la compañía: nada de fechas ni de concepto', async () => {
    const q: { where?: SQL; orderBy?: SQL[] } = {};
    selectMock.mockReturnValueOnce(chain([COMPANIA])).mockReturnValueOnce(espiando([], q));
    await historial(7);
    const { sql, params } = renderizar(q.where!);
    expect(sql).toBe('"flito_tarifas_vigencias"."compania_id" = $1');
    expect(params).toEqual([7]);
    expect(sql).not.toMatch(/vigente_desde|AT TIME ZONE|concepto|tipo_tramite/);
  });

  it('logística ignora el tipo: filtra solo por concepto', async () => {
    const q: { where?: SQL; orderBy?: SQL[] } = {};
    selectMock.mockReturnValueOnce(chain([COMPANIA])).mockReturnValueOnce(espiando([], q));
    await historial(7, { concepto: 'logistica', tipoTramite: 'TRASPASO' });
    const { sql, params } = renderizar(q.where!);
    expect(sql).toMatch(/"concepto" = \$2/);
    expect(params).toEqual([7, 'logistica']);
    expect(sql).not.toMatch(/tipo_tramite/);
  });
});
