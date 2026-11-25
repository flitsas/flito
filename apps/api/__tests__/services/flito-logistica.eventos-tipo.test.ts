// HU #14117 — bitácora de eventos tipificada por LT (AC1–AC4).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EventoDocumentoLogisticaTipo, tipoEventoEfectivo,
} from '@operaciones/shared-types';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { insertarEvento, transicionar } = await import('../../src/modules/flito-logistica/flito-logistica.base.js');
const { flitoLogisticaEventos } = await import('../../src/db/schema.js');

const DOC = '11111111-1111-4111-8111-111111111111';
const TR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ctx = { userId: 1, username: 'op.secreto', role: 'admin', operaAjenas: true };
const PII = /nombre|cedula|documento|firma/i;

type Insercion = { tabla: unknown; valores: Record<string, unknown> };
let inserciones: Insercion[];

const exec = {
  insert: (tabla: unknown) => ({
    values: (valores: Record<string, unknown>) => {
      inserciones.push({ tabla, valores });
      return Promise.resolve([]);
    },
  }),
  update: () => ({
    set: () => ({ where: () => Promise.resolve([]) }),
  }),
};

beforeEach(() => {
  inserciones = [];
  insertMock.mockReset();
  updateMock.mockReset();
  selectMock.mockReset();
});

function ultimoEvento() {
  return inserciones.filter((i) => i.tabla === flitoLogisticaEventos).at(-1)!.valores;
}

describe('AC1 — catálogo canónico (la acción, no el estado)', () => {
  it('expone los tipos de AC1 más tramite_resuelto, llegada y acta_flit (HU #14122)', () => {
    expect(Object.values(EventoDocumentoLogisticaTipo)).toEqual([
      'recogida', 'acta_organismo', 'destino_registrado', 'salida', 'entrega',
      'acta_cliente', 'acta_flit', 'llegada', 'devolucion', 'anulacion', 'novedad', 'reversa', 'tramite_resuelto',
    ]);
  });
});

describe('AC2 — tipoEventoEfectivo: nulo se interpreta por estadoNuevo; aliases; sin adivinar', () => {
  it('tipo nulo: recogido/novedad/despachado/entregado/devuelto/anulado', () => {
    expect(tipoEventoEfectivo(null, 'recogido')).toBe('recogida');
    expect(tipoEventoEfectivo(null, 'novedad')).toBe('novedad');
    expect(tipoEventoEfectivo(undefined, 'despachado')).toBe('salida');
    expect(tipoEventoEfectivo(null, 'entregado')).toBe('entrega');
    expect(tipoEventoEfectivo(null, 'devuelto')).toBe('devolucion');
    expect(tipoEventoEfectivo(null, 'anulado')).toBe('anulacion');
  });

  it('no adivina clasificado / en_flit / generado / en_acta', () => {
    expect(tipoEventoEfectivo(null, 'clasificado')).toBeNull();
    expect(tipoEventoEfectivo(null, 'en_flit')).toBeNull();
    expect(tipoEventoEfectivo('llegada_flit', 'en_flit')).toBe('llegada');
    expect(tipoEventoEfectivo('acta_flit_firmada', 'en_flit')).toBe('acta_flit');
    expect(tipoEventoEfectivo(null, 'generado')).toBeNull();
    expect(tipoEventoEfectivo(null, 'en_acta')).toBeNull();
  });

  it('aliases históricos y canónicos se conservan', () => {
    expect(tipoEventoEfectivo('recogida_organismo')).toBe('recogida');
    expect(tipoEventoEfectivo('despachado')).toBe('salida');
    expect(tipoEventoEfectivo('entregado')).toBe('entrega');
    expect(tipoEventoEfectivo('devuelto')).toBe('devolucion');
    expect(tipoEventoEfectivo('anulado')).toBe('anulacion');
    expect(tipoEventoEfectivo('anulacion')).toBe('anulacion');
    expect(tipoEventoEfectivo('tramite_resuelto')).toBe('tramite_resuelto');
    expect(tipoEventoEfectivo('salida')).toBe('salida');
  });
});

describe('AC4 — transicionar acepta tipo/traslado/acta/destino/payload opcionales', () => {
  it('llamada vieja sin tipo: novedad auto-fill; clasificado queda nulo', async () => {
    await transicionar(exec as never, { id: DOC, estado: 'recogido' }, 'novedad', ctx, { motivo: 'rota' });
    expect(ultimoEvento()).toMatchObject({ tipo: 'novedad', motivo: 'rota', payload: null, trasladoId: null, actaId: null });
    await transicionar(exec as never, { id: DOC, estado: 'recogido' }, 'clasificado', ctx, { origen: 'api' });
    expect(ultimoEvento()).toMatchObject({ tipo: null, origen: 'api' });
  });

  it('auto-fill 1:1 despachado→salida si no viene tipo; alias escrito se canoniza', async () => {
    await transicionar(exec as never, { id: DOC, estado: 'en_acta' }, 'despachado', ctx);
    expect(ultimoEvento().tipo).toBe('salida');
    await transicionar(exec as never, { id: DOC, estado: 'despachado' }, 'entregado', ctx, { tipo: 'entregado' });
    expect(ultimoEvento().tipo).toBe('entrega');
  });

  it('con tipo/traslado/acta/destino/payload explícitos no rompe', async () => {
    await transicionar(exec as never, { id: DOC, estado: 'clasificado' }, 'en_acta', ctx, {
      tipo: 'destino_registrado', trasladoId: TR, actaId: ACTA, destino: 'cliente',
      payload: { trasladoId: TR, actaId: ACTA, destino: 'cliente' },
    });
    expect(ultimoEvento()).toMatchObject({
      tipo: 'destino_registrado', trasladoId: TR, actaId: ACTA, destino: 'cliente',
      payload: { trasladoId: TR, actaId: ACTA, destino: 'cliente' },
    });
  });
});

describe('insertarEvento — acta_cliente sin cambio de estado y AC3 payload', () => {
  it('escribe acta_cliente con el mismo estado anterior/nuevo', async () => {
    await insertarEvento(exec as never, { id: DOC, estado: 'en_acta' }, 'en_acta', ctx, {
      tipo: 'acta_cliente', trasladoId: TR, actaId: ACTA, destino: 'cliente',
      payload: { actaId: ACTA, trasladoId: TR, destino: 'cliente' },
    });
    expect(ultimoEvento()).toMatchObject({
      tipo: 'acta_cliente', estadoAnterior: 'en_acta', estadoNuevo: 'en_acta',
      payload: { actaId: ACTA, trasladoId: TR, destino: 'cliente' },
    });
  });

  it('AC3: JSON.stringify(payload) no matchea nombre|cedula|documento|firma; ctx.username no entra', async () => {
    const payloads: Array<Record<string, unknown> | null> = [
      { trasladoId: TR, actaId: ACTA, destino: 'cliente' },
      { actaId: ACTA, trasladoId: TR, destino: 'cliente' },
      { pendienteTramite: true },
      { origen: 'manual' },
      { trasladoId: TR, actaId: ACTA, linea: 'devuelto' },
      { trasladoId: TR, lineaId: 'lin-1' },
      { organismoCodigo: '05001' },
      null,
    ];
    for (const payload of payloads) {
      await insertarEvento(exec as never, { id: DOC, estado: null }, 'recogido', ctx, {
        tipo: 'recogida', payload,
      });
      const ev = ultimoEvento();
      expect(JSON.stringify(ev.payload)).not.toMatch(PII);
      expect(JSON.stringify(ev)).not.toContain(ctx.username);
      expect(ev).not.toHaveProperty('actorNombre');
    }
  });
});
