// FLITO sync — el alta del impuesto respeta que el impuesto es del vehículo, no del trámite.
//
// `resolverImpuesto` no se exporta (es un paso interno de la sincronización), así que se ejercita
// por donde entra de verdad: `sincronizar` con un puerto FLIT de mentira y el mock keyed de drizzle.
// Eso además obliga a que el corte quede DONDE toca dentro del orden real —después de la
// autogestión, antes del INSERT— y no solo en una función suelta que nadie llama.
//
// OPS-02b: mock KEYED por tabla; el orden de los SELECT deja de importar.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

// La parametrización se consulta contra BD; aquí solo interesa QUÉ decide el sync con esas
// respuestas, así que se fijan las tres lecturas y se deja el resto del módulo real.
const companiaPorNitMock = vi.fn();
const organismoPorCodigoMock = vi.fn();
const modalidadVigenteMock = vi.fn();
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return {
    ...real,
    companiaPorNit: companiaPorNitMock,
    organismoPorCodigo: organismoPorCodigoMock,
    modalidadVigente: modalidadVigenteMock,
  };
});

const { sincronizar } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { anioGravableEnCurso } = await import('../../src/modules/flito-impuestos/impuesto-por-vehiculo.js');
const { flitoImpuestos, auditLogs } = await import('../../src/db/schema.js');

const RANGO = { initialDate: '20260701', finalDate: '20260730' };
const VEHICULO = 42;
const TRAMITE_NUEVO = 'cccc0000-0000-0000-0000-00000000000c';
const TRAMITE_VIEJO = 'dddd0000-0000-0000-0000-00000000000d';
// El año en curso EN BOGOTÁ, igual que lo calcula el sync: usar el del servidor haría que la suite
// fallara sola la noche del 31 de diciembre, que es justo cuando nadie va a estar mirando.
const ANIO = anioGravableEnCurso();

/** Trámite recién llegado de FLIT: Asignado, con compañía y secretaría reconocibles. */
const tramiteFlit = {
  idFlit: 'FLIT-044456', estadoFlit: 'Asignado', vin: '9FKRG2222T2042405', placa: 'JNH38H',
  ciudad: 'FUNZA', tipoTramite: 'Otros', facturaVentaFlitId: 'F-1', companiaNit: '901789698',
  transitoNombre: 'STRIA TTOyTTE MCPAL FUNZA', organismoCodigo: '25286',
  fechaAprobacion: null, fechaCreacionFlit: null, tipoPropiedad: 'unico_propietario',
  compradores: [{ nombreCompleto: 'Ana', numeroDocumento: '1', correo: null, celular: null, direccion: null }],
  valorImpuestoLiquidado: 250000, raw: {},
};

/** Puerto FLIT de mentira: devuelve el reporte y nada más (la integración es de solo lectura). */
const flitPort = {
  obtenerTramites: async () => [tramiteFlit],
  obtenerUrlFactura: async () => null,
  marcarEntregado: async () => undefined,
} as never;

/**
 * El helper keyed enruta por tabla pero descarta los argumentos de `values()`. Aquí interesa QUÉ se
 * insertó —el detalle de la auditoría, y sobre todo que no aparezca una fila de impuesto—, así que
 * se envuelve la implementación por defecto para conservarlos.
 */
function espiarInserts() {
  const vistos: { tabla: string; values: Record<string, unknown> }[] = [];
  const base = kdb.insert.getMockImplementation()!;
  kdb.insert.mockImplementation((tabla: unknown) => {
    const c = base(tabla) as Record<string, unknown>;
    const values = c.values as (v: unknown) => unknown;
    c.values = (v: unknown) => {
      vistos.push({ tabla: getTableName(tabla as never), values: v as Record<string, unknown> });
      return values(v);
    };
    return c;
  });
  return vistos;
}

/**
 * Respuestas sucesivas de `flito_impuestos` CONTANDO las consultas: el sync la mira dos veces (la
 * del propio trámite y la de la regla por vehículo) y saber cuántas veces se preguntó es la única
 * forma de comprobar que la regla ni siquiera se evalúa cuando no toca.
 */
function respuestasImpuestos(...respuestas: unknown[][]) {
  const contador = { n: 0 };
  kdb.when.select('flito_impuestos', () => respuestas[contador.n++] ?? []);
  return contador;
}

/** Impuesto ya pagado este año en OTRO trámite del mismo vehículo, que sigue vivo. */
const impuestoPagadoDelVehiculo = {
  id: 'imp-viejo', tramiteId: TRAMITE_VIEJO, estado: 'pagado',
  extraccion: { anioGravable: { valor: String(ANIO), confianza: 0.99, confiable: true } },
  pagadoEn: null, estadoTramite: 'entregado',
};

beforeEach(() => {
  kdb.reset();
  companiaPorNitMock.mockReset();
  organismoPorCodigoMock.mockReset().mockResolvedValue({ codigo: '25286' });
  modalidadVigenteMock.mockReset().mockResolvedValue('requiere_gestion');

  // Alta limpia del trámite: vehículo y trámite nuevos. Lo que se prueba viene después.
  kdb.when
    .select('vehicles', [])
    .select('flito_tramites', [])
    .insert('vehicles', [{ id: VEHICULO }])
    .insert('flito_tramites', [{ id: TRAMITE_NUEVO, soatId: null }])
    .insert('flito_impuestos', [{ id: 'imp-nuevo' }]);
});

/** Compañía que NO autogestiona nada: FLITO le gestiona SOAT e impuesto. */
function compania(over: Record<string, unknown> = {}) {
  companiaPorNitMock.mockResolvedValue({
    id: 7, document: '901789698', soatAutogestionable: true, impuestosAutogestionable: false, ...over,
  });
}

describe('sincronizar — alta del impuesto bloqueada porque el vehículo ya lo tiene', () => {
  it('otro trámite del mismo vehículo ya pagó el impuesto del año → no se crea el registro', async () => {
    // Este es el bug: `flito_impuestos.tramite_id` es UNIQUE, así que el trámite nuevo pasaba el
    // control de duplicados y nacía un impuesto `pendiente` listo para pagarse por segunda vez.
    compania();
    respuestasImpuestos([], [impuestoPagadoDelVehiculo]);
    const inserts = espiarInserts();

    const r = await sincronizar(RANGO, flitPort);

    expect(r.impuestosBloqueadosPorVehiculo).toBe(1);
    expect(r.impuestosCreados).toBe(0);
    expect(inserts.map((i) => i.tabla)).not.toContain(getTableName(flitoImpuestos));
  });

  it('el bloqueo deja auditoría diciendo qué vehículo, qué año y en qué trámite estaba', async () => {
    // Sin ese rastro, Operaciones ve un trámite sin impuesto y no tiene forma de saber si es un
    // bloqueo deliberado o un fallo del sync: acabaría creándolo a mano, que es el mismo doble pago.
    compania();
    respuestasImpuestos([], [impuestoPagadoDelVehiculo]);
    const inserts = espiarInserts();

    await sincronizar(RANGO, flitPort);

    const auditoria = inserts.filter((i) => i.tabla === getTableName(auditLogs));
    const detalle = auditoria.map((a) => String(a.values.detail)).join(' | ');
    expect(detalle).toContain('Alta bloqueada');
    expect(detalle).toContain(tramiteFlit.idFlit);
    expect(detalle).toContain(String(ANIO));
    expect(detalle).toContain(TRAMITE_VIEJO);
  });

  it('el solicitado que quedó en el trámite ANULADO no frena al trámite que lo reemplaza', async () => {
    // El escenario real completo: se anula el trámite y FLIT manda el sustituto. Si el impuesto
    // muerto bloqueara, el vehículo no volvería a tener impuesto nunca y nadie se enteraría.
    compania();
    respuestasImpuestos([], [{
      id: 'imp-muerto', tramiteId: TRAMITE_VIEJO, estado: 'solicitado',
      extraccion: null, pagadoEn: null, estadoTramite: 'anulado',
    }]);

    const r = await sincronizar(RANGO, flitPort);

    expect(r.impuestosBloqueadosPorVehiculo).toBe(0);
    expect(r.impuestosCreados).toBe(1);
  });

  it('el PAGADO del trámite anulado sí frena al trámite que lo reemplaza', async () => {
    // Anular no devuelve el dinero: el impuesto del año ya está pagado en la secretaría.
    compania();
    respuestasImpuestos([], [{ ...impuestoPagadoDelVehiculo, estadoTramite: 'anulado' }]);

    const r = await sincronizar(RANGO, flitPort);

    expect(r.impuestosBloqueadosPorVehiculo).toBe(1);
    expect(r.impuestosCreados).toBe(0);
  });

  it('un impuesto pagado de OTRO año no frena el alta del año en curso', async () => {
    // El impuesto se paga cada año: el del año pasado no dice nada sobre el de este.
    compania();
    respuestasImpuestos([], [{
      ...impuestoPagadoDelVehiculo,
      extraccion: { anioGravable: { valor: String(ANIO - 1), confianza: 0.99, confiable: true } },
    }]);

    const r = await sincronizar(RANGO, flitPort);

    expect(r.impuestosBloqueadosPorVehiculo).toBe(0);
    expect(r.impuestosCreados).toBe(1);
  });
});

describe('sincronizar — el camino normal sigue intacto', () => {
  it('vehículo sin impuesto previo → se crea en pendiente, como siempre', async () => {
    compania();
    const consultas = respuestasImpuestos([], []);
    const inserts = espiarInserts();

    const r = await sincronizar(RANGO, flitPort);

    expect(r.impuestosCreados).toBe(1);
    expect(r.impuestosBloqueadosPorVehiculo).toBe(0);
    expect(consultas.n).toBe(2); // el impuesto del trámite y la regla por vehículo
    const impuesto = inserts.find((i) => i.tabla === getTableName(flitoImpuestos));
    expect(impuesto?.values).toMatchObject({ tramiteId: TRAMITE_NUEVO, estado: 'pendiente' });
  });

  it('la compañía autogestiona el impuesto → sin registro y sin evaluar la regla', async () => {
    // El corte por autogestión va ANTES: si el registro no debe existir, preguntar por el vehículo
    // sería una consulta inútil por cada trámite de cada compañía autogestionada, en cada sync.
    compania({ impuestosAutogestionable: true });
    const consultas = respuestasImpuestos([], [impuestoPagadoDelVehiculo]);
    const inserts = espiarInserts();

    const r = await sincronizar(RANGO, flitPort);

    expect(r.impuestosCreados).toBe(0);
    expect(r.impuestosBloqueadosPorVehiculo).toBe(0);
    expect(consultas.n).toBe(1); // solo la del propio trámite; la regla no se llega a consultar
    expect(inserts.map((i) => i.tabla)).not.toContain(getTableName(flitoImpuestos));
  });

  it('el organismo autogestionado tampoco evalúa la regla', async () => {
    // Mismo criterio por el otro lado de RN-01: si el organismo no requiere gestión, no hay alta
    // que bloquear.
    compania();
    modalidadVigenteMock.mockResolvedValue('autogestionado');
    const consultas = respuestasImpuestos([], [impuestoPagadoDelVehiculo]);

    const r = await sincronizar(RANGO, flitPort);

    expect(r.impuestosCreados).toBe(0);
    expect(r.impuestosBloqueadosPorVehiculo).toBe(0);
    expect(consultas.n).toBe(1);
  });

  it('el trámite ya tenía su impuesto → ni se crea ni cuenta como bloqueado', async () => {
    // Reingerir el mismo trámite es lo normal (el sync es idempotente): el estado es del módulo de
    // impuestos, no del sync, y contarlo como bloqueo inflaría el indicador en cada corrida.
    compania();
    const consultas = respuestasImpuestos([{ id: 'imp-propio', valorLiquidado: '250000.00' }]);

    const r = await sincronizar(RANGO, flitPort);

    expect(r.impuestosCreados).toBe(0);
    expect(r.impuestosBloqueadosPorVehiculo).toBe(0);
    expect(consultas.n).toBe(1);
  });
});
