// FLITO — Viajes adicionales de logística por trámite (HU #12619, Feature #12617, Épica #12244).
//
// El primer viaje de un trámite está incluido en la tarifa de logística; cada viaje ADICIONAL se
// registra aquí con su precio: `inicial` copia la tarifa de logística vigente de la compañía en ese
// instante (snapshot inmutable), `manual` fija el precio a mano. La numeración arranca en 2 y no se
// renumera al quitar. Nada de esto sale en las actas ni en su PDF: es información de cobro.

/** Cómo se fijó el precio del viaje. */
export const MODOS_PRECIO_VIAJE = ['inicial', 'manual'] as const;
export type ModoPrecioViaje = (typeof MODOS_PRECIO_VIAJE)[number];

/** Por qué hubo que hacer otro viaje. `otro` exige `motivoDetalle`. */
export const MOTIVOS_VIAJE_LOGISTICA = ['devolucion', 'segunda_entrega', 'documento_faltante', 'otro'] as const;
export type MotivoViajeLogistica = (typeof MOTIVOS_VIAJE_LOGISTICA)[number];

export const MOTIVO_VIAJE_LOGISTICA_LABEL: Record<MotivoViajeLogistica, string> = {
  devolucion: 'Devolución',
  segunda_entrega: 'Segunda entrega',
  documento_faltante: 'Documento faltante',
  otro: 'Otro',
};

/** Un viaje adicional registrado (fila de `flito_tramite_viajes_logistica`). */
export interface ViajeLogistica {
  id: string;
  /** Ordinal del viaje en el trámite; el 1 es el incluido en la tarifa, así que aquí siempre >= 2. */
  numero: number;
  modo: ModoPrecioViaje;
  /** Lo que se cobra por este viaje. En `inicial` es igual a `tarifaVigente`. */
  valor: number;
  /** Tarifa de logística vigente al registrar; null solo en `manual` sin tarifa configurada. */
  tarifaVigente: number | null;
  motivo: MotivoViajeLogistica;
  motivoDetalle: string | null;
  registradoPorId: number | null;
  registradoPorNombre: string | null;
  /** ISO 8601. */
  registradoEn: string;
}

/** Respuesta de `GET /api/flito/logistica/tramites/:tramiteId/viajes`. */
export interface ViajesLogisticaDeTramite {
  tramiteId: string;
  idFlit: string;
  /** false cuando la compañía autogestiona la logística y el trámite no tiene excepción viva. */
  gestionaLogistica: boolean;
  /** true si hay fila en `flito_liquidaciones`: registrar y quitar están cerrados (409). */
  liquidado: boolean;
  /** Tarifa de logística vigente HOY para la compañía; null si no está configurada (nunca 0 por defecto). */
  tarifaVigente: number | null;
  /** ORDER BY numero ASC. Vacío si no gestiona logística. */
  items: ViajeLogistica[];
  /** 1 (el incluido) + adicionales; 0 si no gestiona logística. */
  totalViajes: number;
  /** Suma de `valor` de los adicionales. */
  totalAdicionales: number;
}

/** Códigos del cuerpo `{ error, codigo }` de las rutas de viajes. */
export const CODIGO_VIAJE_LOGISTICA = {
  TRAMITE_LIQUIDADO: 'TRAMITE_LIQUIDADO',
  LOGISTICA_AUTOGESTIONADA: 'LOGISTICA_AUTOGESTIONADA',
  TARIFA_LOGISTICA_NO_CONFIGURADA: 'TARIFA_LOGISTICA_NO_CONFIGURADA',
  VIAJE_NO_ENCONTRADO: 'VIAJE_NO_ENCONTRADO',
} as const;
export type CodigoViajeLogistica = (typeof CODIGO_VIAJE_LOGISTICA)[keyof typeof CODIGO_VIAJE_LOGISTICA];
