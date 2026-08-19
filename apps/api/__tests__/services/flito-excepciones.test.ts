// HU #10980 — desbloqueo excepcional de la autogestión, por trámite.
//
// Se prueba aquí lo que es verificable sin base de datos: las guardas de entrada y la FORMA de lo
// que se persiste. El comportamiento real —que el registro creado entra en la cola y que revocarlo
// lo saca— se verificó contra Postgres, porque el helper `chain()` descarta los argumentos de
// `where()` y no distingue una frontera abierta de una cerrada.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: transactionMock, execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const {
  desbloquear, esConceptoExcepcion, ExcepcionError, MOTIVO_MINIMO, CONCEPTO_EXCEPCION,
} = await import('../../src/modules/flito-excepciones/flito-excepciones.service.js');
const { anioGravableEnCurso } = await import('../../src/modules/flito-impuestos/impuesto-por-vehiculo.js');
const { auditLogs, flitoExcepcionesAutogestion, flitoImpuestos } = await import('../../src/db/schema.js');

const TRAMITE = 'aaaa0000-0000-0000-0000-000000000001';
const ctx = { userId: 7, username: 'ops@flit' };

/** Fila del trámite tal como la devuelve `cargarTramite`. */
function fila(over: Record<string, unknown> = {}) {
  return {
    tramiteId: TRAMITE, idFlit: 'FLIT-1', vin: 'VIN00000000000001', vehiculoId: 3,
    companiaId: 1, organismoCodigo: '05001', soatId: null,
    soatAutogestionable: true, impuestosAutogestionable: true, logisticaAutogestionable: true,
    valorImpuestoLiquidado: null, ...over,
  };
}

beforeEach(() => { selectMock.mockReset(); transactionMock.mockReset(); });

describe('esConceptoExcepcion — guarda de entrada', () => {
  it('acepta los tres conceptos', () => {
    for (const c of ['soat', 'impuesto', 'logistica']) expect(esConceptoExcepcion(c)).toBe(true);
  });

  it('rechaza cualquier otro valor en vez de dejarlo llegar al SQL', () => {
    for (const v of ['', 'SOAT', 'derecho', "'; DROP TABLE", null, undefined, 7, {}]) {
      expect(esConceptoExcepcion(v)).toBe(false);
    }
  });
});

describe('desbloquear — qué se rechaza antes de tocar la base', () => {
  it('un motivo corto no pasa: queda en la auditoría y «ok» no explica nada', async () => {
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.SOAT, 'no', ctx))
      .rejects.toThrow(new RegExp(`mínimo ${MOTIVO_MINIMO}`));
    // Ni siquiera se consultó el trámite.
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('un motivo de solo espacios cuenta como vacío', async () => {
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.SOAT, '        ', ctx))
      .rejects.toThrow(ExcepcionError);
  });

  it('un trámite inexistente falla con 404', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.SOAT, 'motivo suficiente', ctx))
      .rejects.toMatchObject({ status: 404 });
  });

  it('si la compañía NO autogestiona ese concepto, no hay nada que desbloquear', async () => {
    // Crear una excepción aquí sería basura: FLITO ya lo gestiona y nadie sabría después por qué está.
    selectMock.mockReturnValueOnce(chain([fila({ soatAutogestionable: false })]));
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.SOAT, 'motivo suficiente', ctx))
      .rejects.toMatchObject({ status: 400 });
  });

  it('un trámite sin compañía no se puede desbloquear', async () => {
    selectMock.mockReturnValueOnce(chain([fila({ companiaId: null })]));
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.IMPUESTO, 'motivo suficiente', ctx))
      .rejects.toMatchObject({ status: 400 });
  });

  it('el mismo concepto dos veces → 409, no una segunda excepción', async () => {
    selectMock
      .mockReturnValueOnce(chain([fila()]))                    // cargarTramite
      .mockReturnValueOnce(chain([{ id: 'excepcion-vigente' }])); // ya hay una viva
    await expect(desbloquear(TRAMITE, CONCEPTO_EXCEPCION.IMPUESTO, 'motivo suficiente', ctx))
      .rejects.toMatchObject({ status: 409 });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

// ── El impuesto es del VEHÍCULO y del año, no del trámite ────────────────────────────────────
//
// Desbloquear la autogestión CREA el registro que el sync no creó. Sin más, eso reabría por la
// puerta manual el mismo agujero que el sync ya cierra: si otro trámite del mismo vehículo ya pidió
// o pagó el impuesto del año, crear otro es un segundo desembolso. Es el mismo criterio con el que
// `crearSoatExcepcional` reutiliza el SOAT del VIN en vez de duplicarlo.

// Año en curso EN BOGOTÁ, igual que lo calcula el servicio: con el del servidor, la suite se caería
// sola la noche del 31 de diciembre.
const ANIO = anioGravableEnCurso();

/** Impuesto pagado este año en otro trámite (vivo) del mismo vehículo: fila del join por vehículo. */
const impuestoPagadoDelVehiculo = {
  id: 'imp-viejo', tramiteId: 'otro-tramite', estado: 'pagado',
  extraccion: { anioGravable: { valor: String(ANIO), confianza: 0.99, confiable: true } },
  pagadoEn: null, estadoTramite: 'entregado',
};

/**
 * Transacción de mentira. `chain()` descarta los argumentos de `values()`, y aquí interesa
 * justamente QUÉ se insertó —el mensaje que queda en la auditoría y, sobre todo, que no haya fila
 * de impuesto—, así que se envuelve para conservarlos.
 */
function txConSelects(...respuestas: unknown[][]) {
  const inserts: { tabla: string; values: Record<string, unknown> }[] = [];
  const select = vi.fn();
  for (const r of respuestas) select.mockReturnValueOnce(chain(r));
  select.mockReturnValue(chain([]));

  const insert = vi.fn((tabla: unknown) => {
    const c = chain([{ id: 'exc-1', createdAt: new Date('2026-07-30T10:00:00Z') }]) as Record<string, unknown>;
    const values = c.values as () => unknown;
    c.values = (v: Record<string, unknown>) => {
      inserts.push({ tabla: getTableName(tabla as never), values: v });
      return values();
    };
    return c;
  });

  const tx = { select, insert, update: vi.fn(() => chain([])) };
  transactionMock.mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx));
  return { tx, inserts };
}

describe('desbloquear impuesto — no crea el impuesto que el vehículo ya tiene', () => {
  it('el vehículo ya lo pagó este año en otro trámite → no inserta y lo explica en la auditoría', async () => {
    selectMock
      .mockReturnValueOnce(chain([fila()]))  // cargarTramite
      .mockReturnValueOnce(chain([]));       // no hay excepción vigente
    // Dentro de la transacción: el trámite aún no tiene impuesto propio, pero el vehículo sí.
    const { inserts } = txConSelects([], [impuestoPagadoDelVehiculo]);

    const dto = await desbloquear(TRAMITE, CONCEPTO_EXCEPCION.IMPUESTO, 'lo pide el cliente', ctx);

    // La excepción SÍ se crea: el desbloqueo es real y queda registrado. Lo que no se crea es la
    // segunda fila de impuesto — si no, alguien la ve en la cola y la manda a pagar.
    expect(dto.concepto).toBe('impuesto');
    const tablas = inserts.map((i) => i.tabla);
    expect(tablas).not.toContain(getTableName(flitoImpuestos));
    expect(tablas).toContain(getTableName(flitoExcepcionesAutogestion));

    const detalle = inserts.filter((i) => i.tabla === getTableName(auditLogs))
      .map((a) => String(a.values.detail)).join(' | ');
    expect(detalle).toContain('bloqueada');
    expect(detalle).toContain(String(ANIO));
    expect(detalle).toContain('pagado');
  });

  it('un pagado de otro año no impide el desbloqueo: el impuesto se paga cada año', async () => {
    selectMock
      .mockReturnValueOnce(chain([fila()]))
      .mockReturnValueOnce(chain([]))
      // modalidadVigente, ya dentro del alta (consulta la conexión, no la transacción).
      .mockReturnValueOnce(chain([{ modalidad: 'requiere_gestion' }]));
    const { inserts } = txConSelects([], [{
      ...impuestoPagadoDelVehiculo,
      extraccion: { anioGravable: { valor: String(ANIO - 1), confianza: 0.99, confiable: true } },
    }]);

    await desbloquear(TRAMITE, CONCEPTO_EXCEPCION.IMPUESTO, 'lo pide el cliente', ctx);

    const impuesto = inserts.find((i) => i.tabla === getTableName(flitoImpuestos));
    expect(impuesto?.values).toMatchObject({ estado: 'pendiente', excepcionAutogestion: true });
  });

  it('un solicitado colgado de un trámite anulado no impide el desbloqueo', async () => {
    // Desbloquear a mano es justo lo que haría alguien al ver el vehículo atascado. Si la regla
    // bloqueara también por aquí, no quedaría ninguna salida que no fuera tocar la base.
    selectMock
      .mockReturnValueOnce(chain([fila()]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ modalidad: 'requiere_gestion' }]));
    const { inserts } = txConSelects([], [{
      ...impuestoPagadoDelVehiculo, id: 'imp-muerto', estado: 'solicitado',
      extraccion: null, estadoTramite: 'anulado',
    }]);

    await desbloquear(TRAMITE, CONCEPTO_EXCEPCION.IMPUESTO, 'lo pide el cliente', ctx);

    expect(inserts.map((i) => i.tabla)).toContain(getTableName(flitoImpuestos));
  });

  it('un trámite sin vehículo resuelto no se queda sin impuesto por no poder comprobar la regla', async () => {
    // Sin `vehiculo_id` no hay con qué buscar. Bloquear «por si acaso» dejaría el desbloqueo sin
    // efecto y en silencio: se crea, que es el fallo por el lado seguro.
    selectMock
      .mockReturnValueOnce(chain([fila({ vehiculoId: null })]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ modalidad: 'requiere_gestion' }]));
    const { tx, inserts } = txConSelects([]);

    await desbloquear(TRAMITE, CONCEPTO_EXCEPCION.IMPUESTO, 'lo pide el cliente', ctx);

    expect(tx.select).toHaveBeenCalledTimes(1); // solo el impuesto del trámite; la regla ni se intenta
    expect(inserts.map((i) => i.tabla)).toContain(getTableName(flitoImpuestos));
  });
});
