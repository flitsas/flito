// Finanzas — Gastos diarios (HU #12623, Feature #12621, Épica #12248).
//
// Contrato del `GET /api/finanzas/gastos-diarios`: cuánto se gastó cada día y cuánto en total por
// categoría, contado el día en que cada gasto se EJECUTÓ (el evento de cada fuente, no la aprobación
// del trámite) en calendario de Colombia. Los valores monetarios viajan como string decimal con 2
// decimales, igual que el reporte de costos: nada de float entre la base y la pantalla.

export const GASTOS_DIARIOS_CATEGORIAS = ['soat', 'impuesto', 'derecho', 'logistica', 'serviciosAdicionales'] as const;
export type GastosDiariosCategoria = (typeof GASTOS_DIARIOS_CATEGORIAS)[number];

/** Una celda de la serie: cuántos eventos hubo y cuánto sumaron (`'0.00'` si ninguno). */
export interface GastosDiariosCelda { cantidad: number; valor: string }

export interface GastosDiariosDia {
  /** `YYYY-MM-DD` en America/Bogota. */
  dia: string;
  soat: GastosDiariosCelda;
  impuesto: GastosDiariosCelda;
  derecho: GastosDiariosCelda;
  logistica: GastosDiariosCelda;
  serviciosAdicionales: GastosDiariosCelda;
}

export interface GastosDiariosTotales {
  soat: GastosDiariosCelda;
  impuesto: GastosDiariosCelda;
  derecho: GastosDiariosCelda;
  logistica: GastosDiariosCelda;
  serviciosAdicionales: GastosDiariosCelda;
  /** Σ de las cinco categorías. */
  base: string;
  /** `ROUND(base × TASA_GMF, 2)`: el 4×1000 que el periodo habría causado (RN-05). */
  gmfEstimado: string;
  /** `base + gmfEstimado`. */
  total: string;
}

export interface GastosDiariosRespuesta {
  desde: string;
  hasta: string;
  /** Un elemento por día del rango, ascendente, con celdas en cero donde no hubo gasto. */
  serie: GastosDiariosDia[];
  totales: GastosDiariosTotales;
}

/** Sin `desde`/`hasta`: los últimos 30 días, hoy incluido (RN-09). */
export const GASTOS_DIARIOS_RANGO_DEFAULT_DIAS = 30;
/** Un rango mayor es 400: la serie no se pagina y un año y un día es el techo (RN-09). */
export const GASTOS_DIARIOS_RANGO_MAX_DIAS = 366;
