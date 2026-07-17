// OPS-02b — Fixtures de escenario SOAT (keyed por tabla). Datos sintéticos.
//
// Tablas: `soat_requests` (solicitud) y `vehicles` (conteo/stage). Se consumen con
// el mock keyed: `kdb.when.select('soat_requests', soatVigente())`.

export type Rows = Record<string, unknown>[];

/** ISO (YYYY-MM-DD) a N días desde hoy (runtime del test). */
function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().split('T')[0];
}

/** Solicitud SOAT base; sobreescribir status/fechas según el escenario. */
export function soatRequest(overrides: Record<string, unknown> = {}): Rows {
  return [{
    id: 1,
    status: 'pendiente',
    assignedTo: null,
    vehicleId: 5,
    tramiteId: null,
    notes: null,
    policyNumber: null,
    expiryDate: null,
    ...overrides,
  }];
}

/** SOAT comprado y VIGENTE (póliza real, vence en 1 año). */
export function soatVigente(overrides: Record<string, unknown> = {}): Rows {
  return soatRequest({ status: 'comprado', policyNumber: 'P-001', expiryDate: isoInDays(365), ...overrides });
}

/** SOAT comprado pero VENCIDO. */
export function soatVencido(overrides: Record<string, unknown> = {}): Rows {
  return soatRequest({ status: 'comprado', policyNumber: 'P-001', expiryDate: '2020-01-01', ...overrides });
}

/** Agregado de estados para GET /soat/stats (groupBy status). */
export function soatStatusAgg(overrides: Rows = []): Rows {
  return overrides.length ? overrides : [
    { status: 'comprado', count: 10 },
    { status: 'verificado', count: 5 },
  ];
}

/** Conteo total de vehículos (segunda query de stats). */
export function vehiclesCount(n = 50): Rows {
  return [{ count: n }];
}
