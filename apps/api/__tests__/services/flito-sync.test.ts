import { describe, it, expect, vi } from 'vitest';

// El grafo de la sincronización importa db/client (crea el pool). Mock mínimo: estos tests
// cubren lógica pura (decisiones y mapeos), no tocan BD. El flujo completo se verifica contra
// PostgreSQL real (smoke E2E de sincronización).
vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));

const { decidirEstadoImpuesto } = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { estadoDesdeProcessStatus, PROCESS_STATUS } = await import('../../src/modules/flito-sync/flit-mock.adapter.js');
const { mapearCompradores } = await import('../../src/modules/flito-sync/mapeo-compradores.js');
const { intervalMsFromCron } = await import('../../src/modules/flito-sync/flito-sync.cron.js');

// ───────────── RN-01 Impuestos / CA-03: la modalidad decide, sin default silencioso ─────────

describe('decidirEstadoImpuesto', () => {
  it('organismo SIN_CLASIFICAR → RETENIDO (CA-03: retiene, no asume modalidad)', () => {
    expect(decidirEstadoImpuesto(false, 'sin_clasificar')).toBe('retenido');
  });
  it('organismo AUTOGESTIONADO → NO_APLICA', () => {
    expect(decidirEstadoImpuesto(false, 'autogestionado')).toBe('no_aplica');
  });
  it('organismo REQUIERE_GESTION → SIN_FACTURA (espera factura de venta)', () => {
    expect(decidirEstadoImpuesto(false, 'requiere_gestion')).toBe('sin_factura');
  });
  it('compañía autogestiona impuestos → NO_APLICA aunque el organismo requiera gestión', () => {
    expect(decidirEstadoImpuesto(true, 'requiere_gestion')).toBe('no_aplica');
  });
});

// ───────────── processStatus desconocido NO cae en Asignado (§6.1) ──────────────────────────

describe('estadoDesdeProcessStatus', () => {
  it('5 → asignado', () => {
    expect(estadoDesdeProcessStatus(PROCESS_STATUS.ASIGNADO)).toBe('asignado');
  });
  it('desconocido → lanza (no asume asignado)', () => {
    expect(() => estadoDesdeProcessStatus(999)).toThrow(/FLITO no conoce/);
  });
});

// ───────────── Mapeo de compradores por tipo de propiedad (§9.6 SOAT) ───────────────────────

const comprador = (n: string) => ({ nombreCompleto: n, numeroDocumento: '1', correo: null, celular: null, direccion: null });
const tramiteBase = { idFlit: 'T1', processStatus: 5, plateComplete: 'ABC123', vin: 'V', placa: 'ABC123', marca: 'X', linea: 'Y', cilindraje: 0, capacidad: 0, tipoVehiculo: 'auto', companiaNit: '900', organismoCodigo: '11001', valorImpuestoLiquidado: null };

describe('mapearCompradores', () => {
  it('único propietario → un comprador con 100%', () => {
    const r = mapearCompradores({ ...tramiteBase, tipoPropiedad: 'unico_propietario', compradores: [comprador('Ana')] } as never);
    expect(r).toHaveLength(1);
    expect(r[0].orden).toBe(0);
    expect(r[0].porcentajeParticipacion).toBe(100);
  });
  it('único propietario con 2 compradores → lanza (datos contradictorios, no elige en silencio)', () => {
    expect(() => mapearCompradores({ ...tramiteBase, tipoPropiedad: 'unico_propietario', compradores: [comprador('Ana'), comprador('Beto')] } as never)).toThrow(/único propietario/);
  });
  it('múltiple propietario → conserva orden de FLIT', () => {
    const r = mapearCompradores({ ...tramiteBase, tipoPropiedad: 'multiple_propietario', compradores: [comprador('Ana'), comprador('Beto')] } as never);
    expect(r.map((c) => [c.orden, c.nombreCompleto])).toEqual([[0, 'Ana'], [1, 'Beto']]);
  });
  it('múltiple propietario con 1 comprador → lanza', () => {
    expect(() => mapearCompradores({ ...tramiteBase, tipoPropiedad: 'multiple_propietario', compradores: [comprador('Ana')] } as never)).toThrow(/múltiple propietario/);
  });
  it('tipo de propiedad desconocido → lanza', () => {
    expect(() => mapearCompradores({ ...tramiteBase, tipoPropiedad: 'otro', compradores: [comprador('Ana')] } as never)).toThrow(/tipo de propiedad desconocido/);
  });
});

// ───────────── Cron: intervalo derivado de SYNC_CRON ─────────────────────────────────────────

describe('intervalMsFromCron', () => {
  it('"0 */5 * * * *" → 5 min', () => { expect(intervalMsFromCron('0 */5 * * * *')).toBe(5 * 60000); });
  it('"0 */10 * * * *" → 10 min', () => { expect(intervalMsFromCron('0 */10 * * * *')).toBe(10 * 60000); });
  it('expresión no soportada → 5 min por defecto', () => { expect(intervalMsFromCron('0 30 8 * * 1')).toBe(5 * 60000); });
});
