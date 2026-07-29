// HU #10959 — fecha real de creación, fechas de gestión y orden cronológico.
//
// Lo que se puede probar con drizzle mockeado es el MAPEO (qué fecha gana, qué se expone) y las
// funciones puras. La forma del SQL (que el listado ya no excluye estados, que el ORDER BY usa el
// COALESCE correcto) NO se puede probar aquí: el helper `chain()` devuelve el mismo objeto en cada
// método y descarta los argumentos. Eso se verifica contra Postgres real — es exactamente la clase
// de fallo que los mocks dejaron pasar en el Feature anterior (`<> ALL(array)`).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: vi.fn() }));

const { listar, esOrdenListado } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');
const { fechaValida } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { aTramite } = await import('../../src/modules/flito-sync/flit-http.adapter.js');

/** Fila cruda de la proyección, con lo mínimo que `aFila` necesita. */
function filaCruda(over: Record<string, unknown> = {}) {
  return {
    tramiteId: 't1', idFlit: 'FLIT-1', estadoTramite: null, placa: 'QTQ100', companiaNombre: 'ACME',
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    logisticaDocEstado: null,
    soatEstado: null, soatValorPagado: null, soatExtraccion: null,
    impuestoEstado: null, impuestoValorPagado: null, impuestoMarcadoPorDiferencia: false, impuestoExtraccion: null,
    flitEstado: 'Borrador', tipoTramite: 'Traspaso', ciudad: 'FUNZA', companiaId: 7, companiaNit: '900',
    transitoNombreFlit: 'STRIA FUNZA', facturaVentaFlitId: null, fechaAprobacion: null,
    fechaCreacionFlit: null, creadoEn: new Date('2026-07-01T00:00:00Z'),
    sincronizadoEn: new Date('2026-07-20T00:00:00Z'), organismoAlias: 'Funza', organismoCodigo: '25286',
    vin: 'VIN123', marca: 'Renault', linea: 'Logan', tipoVehiculo: 'automovil',
    soatId: null, soatProveedorId: null, soatProveedorNombre: null, soatSlaHoras: null,
    soatEnviadoEn: null, soatPagadoEn: null, soatMotivoRechazo: null,
    impuestoId: null, impuestoExtraccionFacturaVenta: null, impuestoValorLiquidado: null,
    impuestoEnviadoEn: null, impuestoPagadoEn: null, impuestoSlaHoras: null, impuestoMotivoRechazo: null,
    ...over,
  };
}

/** listar() consume cuatro selects en orden: count, página, compradores y excepciones (HU #10980). */
function montarListado(fila: Record<string, unknown>) {
  selectMock
    .mockReturnValueOnce(chain([{ total: 1 }]))
    .mockReturnValueOnce(chain([fila]))
    .mockReturnValueOnce(chain([]))
    .mockReturnValueOnce(chain([]));
}

beforeEach(() => { selectMock.mockReset(); });

describe('fechaCreacion — qué fecha se muestra', () => {
  it('prefiere la fecha de FLIT sobre la de ingesta de FLITO', async () => {
    montarListado(filaCruda({
      fechaCreacionFlit: new Date('2026-06-20T10:00:00Z'),
      creadoEn: new Date('2026-07-01T00:00:00Z'),
    }));
    const { items: [f] } = await listar();
    expect(f.fechaCreacion).toBe('2026-06-20T10:00:00.000Z');
  });

  it('cae a created_at cuando FLIT no reportó la fecha (trámites anteriores al campo)', async () => {
    montarListado(filaCruda({ fechaCreacionFlit: null, creadoEn: new Date('2026-07-01T00:00:00Z') }));
    const { items: [f] } = await listar();
    expect(f.fechaCreacion).toBe('2026-07-01T00:00:00.000Z');
  });

  it('sin ninguna fecha devuelve null en vez de reventar el listado entero', async () => {
    // Una sola fila incompleta no puede tumbar la página: el contrato admite null y la UI lo pinta
    // como guión.
    montarListado(filaCruda({ fechaCreacionFlit: null, creadoEn: null }));
    const { items: [f] } = await listar();
    expect(f.fechaCreacion).toBeNull();
  });

  it('un trámite en Borrador (estado interno NULL) sí llega al listado', async () => {
    montarListado(filaCruda({ flitEstado: 'Borrador', estadoTramite: null }));
    const { items, total } = await listar();
    expect(total).toBe(1);
    expect(items[0].estado).toBe('Borrador');
  });
});

describe('fechas de gestión de SOAT e impuestos', () => {
  it('expone la fecha de pago del SOAT', async () => {
    montarListado(filaCruda({
      soatId: 's1', soatEstado: 'pagado', soatPagadoEn: new Date('2026-07-10T15:00:00Z'),
      soatEnviadoEn: new Date('2026-07-05T15:00:00Z'),
    }));
    const { items: [f] } = await listar();
    expect(f.soat?.pagadoEn).toBe('2026-07-10T15:00:00.000Z');
    expect(f.soat?.enviadoEn).toBe('2026-07-05T15:00:00.000Z');
  });

  it('expone la fecha de pago del impuesto', async () => {
    montarListado(filaCruda({
      impuestoId: 'i1', impuestoEstado: 'pagado', impuestoPagadoEn: new Date('2026-07-11T15:00:00Z'),
    }));
    const { items: [f] } = await listar();
    expect(f.impuesto?.pagadoEn).toBe('2026-07-11T15:00:00.000Z');
  });

  it('marca el impuesto como estancado cuando venció el SLA del organismo', async () => {
    // Antes este campo estaba quemado a `false` en el listado: solo el tablero lo calculaba.
    const hace10Dias = new Date(Date.now() - 10 * 24 * 3_600_000);
    montarListado(filaCruda({
      impuestoId: 'i1', impuestoEstado: 'solicitado', impuestoEnviadoEn: hace10Dias, impuestoSlaHoras: 24,
    }));
    const { items: [f] } = await listar();
    expect(f.impuesto?.estancado).toBe(true);
  });

  it('no marca estancado un impuesto recién solicitado', async () => {
    const haceUnaHora = new Date(Date.now() - 3_600_000);
    montarListado(filaCruda({
      impuestoId: 'i1', impuestoEstado: 'solicitado', impuestoEnviadoEn: haceUnaHora, impuestoSlaHoras: 24,
    }));
    const { items: [f] } = await listar();
    expect(f.impuesto?.estancado).toBe(false);
  });

  it('sin ANS pactado con el organismo también se marca: el ANS es único (HU #11024)', async () => {
    // Antes esto devolvía false, y era el agujero: los organismos sin ANS configurado —los que
    // menos vigilados están— nunca aparecían marcados por muchos días que llevaran parados.
    const hace100Dias = new Date(Date.now() - 100 * 24 * 3_600_000);
    montarListado(filaCruda({
      impuestoId: 'i1', impuestoEstado: 'solicitado', impuestoEnviadoEn: hace100Dias, impuestoSlaHoras: null,
    }));
    const { items: [f] } = await listar();
    expect(f.impuesto?.estancado).toBe(true);
  });
});

describe('esOrdenListado — un orden desconocido no debe llegar al SQL', () => {
  it('acepta los dos órdenes soportados', () => {
    expect(esOrdenListado('recientes')).toBe(true);
    expect(esOrdenListado('antiguos')).toBe(true);
  });

  it('rechaza cualquier otra cosa', () => {
    for (const v of ['DROP TABLE', '', 'ANTIGUOS', undefined, null, 3, {}]) {
      expect(esOrdenListado(v)).toBe(false);
    }
  });
});

describe('fechaValida — FLIT manda texto libre', () => {
  it('convierte una fecha ISO', () => {
    expect(fechaValida('2026-07-24T22:22:06.307Z')?.toISOString()).toBe('2026-07-24T22:22:06.307Z');
  });

  it('devuelve null ante basura en vez de un Invalid Date que revienta al insertar', () => {
    // `new Date('no-es-fecha')` no lanza: construye un Invalid Date que solo falla después, al
    // llegar a Postgres, tumbando la sincronización completa por una sola fila mal formada.
    expect(fechaValida('no-es-fecha')).toBeNull();
    expect(fechaValida('')).toBeNull();
    expect(fechaValida(null)).toBeNull();
  });
});

describe('aTramite — el adaptador de FLIT lee la fecha de creación', () => {
  it('mapea fechaCreacion del reporte', () => {
    const t = aTramite({ Id: 'FLIT-1', fechaCreacion: '2026-07-24T22:22:06.307Z' });
    expect(t.fechaCreacionFlit).toBe('2026-07-24T22:22:06.307Z');
  });

  it('deja null si el reporte no la trae (es un campo reciente)', () => {
    expect(aTramite({ Id: 'FLIT-1' }).fechaCreacionFlit).toBeNull();
    expect(aTramite({ Id: 'FLIT-1', fechaCreacion: '   ' }).fechaCreacionFlit).toBeNull();
  });
});
