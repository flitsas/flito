// Comparendos/multas desde consulta persona RUNT — fuente primaria antes de SIMIT directo.

export interface RuntComparendosSummary {
  resolved: boolean;
  total: number;
  totalMonto: number;
}

/** Resume multas/comparendos del payload RUNT persona (array u objeto resumen). */
export function summarizeRuntMultasComparendos(multas: unknown): RuntComparendosSummary | null {
  if (multas == null) return null;
  if (Array.isArray(multas)) {
    if (multas.length === 0) return { resolved: true, total: 0, totalMonto: 0 };
    let totalMonto = 0;
    for (const item of multas) {
      const m = item as Record<string, unknown>;
      totalMonto += Number(m.monto ?? m.valor ?? m.valorComparendo ?? 0) || 0;
    }
    return { resolved: true, total: multas.length, totalMonto };
  }
  if (typeof multas === 'object') {
    const m = multas as Record<string, unknown>;
    const flag = String(m.tieneMultas ?? '').toLowerCase();
    if (flag === 'si' || flag === 'sí' || flag === 'true') {
      return {
        resolved: true,
        total: Number(m.totalMultas ?? 1) || 1,
        totalMonto: Number(m.valorTotal ?? 0) || 0,
      };
    }
    if (flag === 'no' || flag === 'false') {
      return { resolved: true, total: 0, totalMonto: 0 };
    }
    const total = Number(m.totalMultas ?? 0) || 0;
    const totalMonto = Number(m.valorTotal ?? 0) || 0;
    if (total > 0 || totalMonto > 0) return { resolved: true, total, totalMonto };
    if (m.tieneMultas !== undefined || m.totalMultas !== undefined || m.valorTotal !== undefined) {
      return { resolved: true, total: 0, totalMonto: 0 };
    }
  }
  return null;
}
