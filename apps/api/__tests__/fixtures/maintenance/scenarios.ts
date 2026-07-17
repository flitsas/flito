// OPS-02b — Fixtures de escenario MANTENIMIENTO (keyed por tabla). Datos sintéticos.
//
// Tablas típicas: `maintenance_schedule`, `maintenance_routines`, `routine_jobs`.
// Se consumen con el mock keyed: `kdb.when.select('maintenance_schedule', maintenanceOverdue())`.

export type Rows = Record<string, unknown>[];

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().split('T')[0];
}

/** Programación VENCIDA (dueDate en el pasado / km excedido). */
export function maintenanceOverdue(overrides: Record<string, unknown> = {}): Rows {
  return [{
    id: 1,
    vehicleId: 5,
    routineId: 2,
    dueDate: '2020-01-01',
    dueKm: 10_000,
    currentKm: 25_000,
    status: 'pending',
    ...overrides,
  }];
}

/** Programación AL DÍA (dueDate futuro, km dentro de rango). */
export function maintenanceOk(overrides: Record<string, unknown> = {}): Rows {
  return [{
    id: 1,
    vehicleId: 5,
    routineId: 2,
    dueDate: isoInDays(90),
    dueKm: 30_000,
    currentKm: 12_000,
    status: 'pending',
    ...overrides,
  }];
}

/** Rutina de mantenimiento base. */
export function maintenanceRoutine(overrides: Record<string, unknown> = {}): Rows {
  return [{ id: 2, nombre: 'Cambio de aceite', periodicidadKm: 10_000, periodicidadDias: 180, activo: true, ...overrides }];
}
