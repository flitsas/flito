// Conceptos de costo de un trámite (Épica #12245, ADR-0018).
//
// Son los seis rubros que un comprobante puede documentar: los tres con columna de destino (SOAT,
// impuesto, derecho) y los tres honorarios de FLIT (trámite digital, logística, servicios
// adicionales). `ConceptoBolsa` (flito-bolsas.ts) se construye SOBRE este catálogo añadiendo `gmf`,
// que es un movimiento de la bolsa y no un costo del trámite: los literales son los mismos y no
// hay que mantener dos listas a mano.

export const ConceptoCosto = {
  // Mismo orden que tenía `ConceptoBolsa`: `Object.values` de la bolsa no cambia de secuencia.
  DERECHO: 'derecho',
  SOAT: 'soat',
  IMPUESTO: 'impuesto',
  TRAMITE_DIGITAL: 'tramite_digital',
  LOGISTICA: 'logistica',
  SERVICIOS_ADICIONALES: 'servicios_adicionales',
} as const;

export type ConceptoCosto = (typeof ConceptoCosto)[keyof typeof ConceptoCosto];

export const CONCEPTOS_COSTO: readonly ConceptoCosto[] = Object.values(ConceptoCosto);

/** Mismos textos que `CONCEPTO_BOLSA_LABEL` para los seis que comparten. */
export const CONCEPTO_COSTO_LABEL: Record<ConceptoCosto, string> = {
  derecho: 'Derecho de tránsito',
  soat: 'SOAT',
  impuesto: 'Impuesto',
  tramite_digital: 'Trámite digital',
  logistica: 'Logística',
  servicios_adicionales: 'Servicios adicionales',
};
