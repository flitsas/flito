// OPS-02b — Fixtures de escenario LAFT (keyed por tabla). Datos sintéticos.
//
// Se consumen con el mock keyed: `kdb.when.scenario(laftDashboardScenario())` o
// `kdb.when.select('laft_list_entries', laftListHit())`. El orden de los SELECT
// del handler deja de importar (cada agregado se enruta por su tabla).

export type Rows = Record<string, unknown>[];

/** KPIs del dashboard LAFT por tabla (8 agregados, uno por tabla). */
export function laftDashboardScenario(overrides: Record<string, Rows> = {}): Record<string, Rows> {
  return {
    laft_compliance_officers: [{ rol: 'principal', iso: true }],
    laft_manual_versions: [{ version: 3, publicadoAt: new Date('2026-01-15T00:00:00Z'), sha256: 'h' }],
    laft_counterparties: [{ total: 25, alto: 3, pendientes: 5, bloqueadas: 1 }],
    laft_employees_kyc: [{ n: 2 }],
    laft_ros_drafts: [{ abiertos: 1, breach: 0 }],
    laft_audit_plans: [{ planeadas: 2, cerradas: 1, canceladas: 0 }],
    laft_trainings: [{ n: 4 }],
    laft_training_attendees: [{ total: 80, attended: 64 }],
    ...overrides,
  };
}

/** Variante "todo en cero" (oficial no configurado, sin actividad). */
export function laftDashboardVacio(): Record<string, Rows> {
  return {
    laft_compliance_officers: [],
    laft_manual_versions: [],
    laft_counterparties: [{ total: 0, alto: 0, pendientes: 0, bloqueadas: 0 }],
    laft_employees_kyc: [{ n: 0 }],
    laft_ros_drafts: [{ abiertos: 0, breach: 0 }],
    laft_audit_plans: [{ planeadas: 0, cerradas: 0, canceladas: 0 }],
    laft_trainings: [{ n: 0 }],
    laft_training_attendees: [{ total: 0, attended: 0 }],
  };
}

// --- Listas restrictivas: hit vs miss ---
export function laftListHit(overrides: Record<string, unknown> = {}): Rows {
  return [{ id: 1, listType: 'OFAC', nombre: 'PERSONA SANCIONADA', score: 95, ...overrides }];
}

export function laftListMiss(): Rows {
  return [];
}

// --- Entidades reutilizables (keyed por tabla) ---

/** Contraparte (laft_counterparties). */
export function laftCounterparty(overrides: Record<string, unknown> = {}): Rows {
  return [{
    id: 42, kind: 'natural', docType: 'CC', docNumber: '900', fullName: 'Juan',
    country: 'CO', city: 'Bogota', isPep: true, pepRole: 'X', fundOrigin: 'sal',
    riskLevel: 'alto', status: 'pendiente', ...overrides,
  }];
}

/** Borrador ROS (laft_ros_drafts). */
export function laftRosDraft(overrides: Record<string, unknown> = {}): Rows {
  return [{
    id: 7, operationId: 100,
    generatedAt: new Date('2026-05-08T12:00:00Z'),
    clasificadoAt: new Date('2026-05-08T13:00:00Z'),
    slaDueAt: new Date('2026-05-09T13:00:00Z'),
    notes: '',
    sirelPayload: {
      encabezado: { tipo_reporte: 'ROS', entidad_reportante: { name: 'Kyverum', nit: '900' }, empleado_cumplimiento: 'cump' },
      operacion: { fecha_deteccion: '2026-05-07', origen: 'manual', monto: 1000, moneda: 'COP', descripcion: 'x', senales_alerta: ['s1'], analisis: 'a' },
    },
    ...overrides,
  }];
}

/** Operación inusual (laft_unusual_operations). */
export function laftUnusualOp(overrides: Record<string, unknown> = {}): Rows {
  return [{ id: 100, counterpartyId: 42, ...overrides }];
}
