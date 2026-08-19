// Historial de cambios de estado de SOAT e impuestos.
//
// Lo que se fija aquí es el contrato de escritura y el orden de lectura. La reconstrucción del
// pasado NO se prueba con drizzle mockeado: vive en la migración 0115 como SQL y se verificó contra
// Postgres real (el helper `chain()` descarta los argumentos de `where()`, así que un test con la
// base mockeada no distingue un SQL correcto de uno inválido).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: insertMock, update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const { registrarCambio, registrarCambios, historialDe } = await import('../../src/shared/historial/estado-historial.js');

beforeEach(() => {
  vi.clearAllMocks();
});

/** Captura lo que se pasó a `.values()` de un ejecutor falso. */
function ejecutorEspia() {
  const values = vi.fn().mockResolvedValue(undefined);
  return { ex: { insert: vi.fn(() => ({ values })) } as never, values };
}

describe('registrarCambio', () => {
  it('guarda la transición completa, con quién y por qué', async () => {
    const { ex, values } = ejecutorEspia();
    await registrarCambio(ex, {
      concepto: 'soat', registroId: 'soat-1',
      estadoAnterior: 'solicitado', estadoNuevo: 'con_novedad',
      motivo: 'Rechazo: el proveedor no cubre ese municipio',
      usuarioId: 9, usuarioEmail: 'operaciones',
    });
    expect(values).toHaveBeenCalledWith({
      concepto: 'soat', registroId: 'soat-1',
      estadoAnterior: 'solicitado', estadoNuevo: 'con_novedad',
      motivo: 'Rechazo: el proveedor no cubre ese municipio',
      usuarioId: 9, usuarioEmail: 'operaciones', origen: 'usuario',
    });
  });

  it('el alta no lleva estado anterior, y eso NO es un dato que falte', async () => {
    const { ex, values } = ejecutorEspia();
    await registrarCambio(ex, {
      concepto: 'impuesto', registroId: 'imp-1',
      estadoAnterior: null, estadoNuevo: 'pendiente',
      motivo: 'Alta desde FLIT', origen: 'sistema',
    });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      estadoAnterior: null, estadoNuevo: 'pendiente', origen: 'sistema',
    }));
  });

  it('sin usuario queda `sistema` como origen explícito, no un hueco', async () => {
    const { ex, values } = ejecutorEspia();
    await registrarCambio(ex, {
      concepto: 'soat', registroId: 's', estadoAnterior: null, estadoNuevo: 'pendiente',
      origen: 'sistema',
    });
    // Un cambio automático sin marcar parecería un descuido de alguien.
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      usuarioId: null, usuarioEmail: null, origen: 'sistema',
    }));
  });

  it('NO se traga los errores: si el historial no entra, el cambio de estado tampoco', async () => {
    const values = vi.fn().mockRejectedValue(new Error('constraint'));
    const ex = { insert: vi.fn(() => ({ values })) } as never;
    // Al contrario que `audit()`, que sí los absorbe. Aquí la fila y el estado tienen que entrar o
    // quedarse fuera juntos: un estado sin historial es el agujero que esto viene a tapar.
    await expect(registrarCambio(ex, {
      concepto: 'soat', registroId: 's', estadoAnterior: 'pendiente', estadoNuevo: 'solicitado',
    })).rejects.toThrow('constraint');
  });
});

describe('registrarCambios (lote)', () => {
  it('un solo INSERT para todo el lote, no uno por registro', async () => {
    const { ex, values } = ejecutorEspia();
    await registrarCambios(ex, ['a', 'b', 'c'].map((id) => ({
      concepto: 'impuesto' as const, registroId: id,
      estadoAnterior: 'pendiente', estadoNuevo: 'solicitado', usuarioId: 1, usuarioEmail: 'ops',
    })));
    // Enviar cincuenta impuestos al gestor no debe costar cincuenta viajes a la base.
    expect(ex.insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ registroId: 'a' }),
      expect.objectContaining({ registroId: 'c' }),
    ]));
  });

  it('un lote vacío no escribe nada', async () => {
    const { ex } = ejecutorEspia();
    await registrarCambios(ex, []);
    expect(ex.insert).not.toHaveBeenCalled();
  });
});

describe('historialDe', () => {
  it('devuelve el nombre del usuario, y si ya no existe, el correo que se copió entonces', async () => {
    selectMock.mockReturnValueOnce(chain([
      {
        id: 2, estadoAnterior: 'pendiente', estadoNuevo: 'solicitado', motivo: 'Envío al gestor',
        origen: 'usuario', usuarioNombre: 'Operaciones FLIT', usuarioEmail: 'ops@flit',
        creadoEn: new Date('2026-07-23T10:00:00Z'),
      },
      {
        id: 1, estadoAnterior: null, estadoNuevo: 'pendiente', motivo: 'Alta desde FLIT',
        origen: 'sistema', usuarioNombre: null, usuarioEmail: 'sistema',
        creadoEn: new Date('2026-07-22T08:00:00Z'),
      },
    ]));

    const h = await historialDe('soat', 'soat-1');
    expect(h[0].usuario).toBe('Operaciones FLIT');
    // El usuario borrado no deja el historial mudo: queda el correo copiado en su momento.
    expect(h[1].usuario).toBe('sistema');
    expect(h[1].estadoAnterior).toBeNull();
    expect(h[0].creadoEn).toBe('2026-07-23T10:00:00.000Z');
  });

  it('un registro sin movimientos devuelve lista vacía, no un error', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    expect(await historialDe('impuesto', 'no-existe')).toEqual([]);
  });
});
