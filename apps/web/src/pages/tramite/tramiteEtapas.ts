// Debe coincidir con EMBUDO_COLUMNAS en apps/api/.../embudo.ts (mismas etapas y etiquetas).

export const TRAMITE_ETAPAS = [
  { id: 'borrador', label: 'Borrador' },
  { id: 'en_preparacion', label: 'En preparación' },
  { id: 'en_transito', label: 'En tránsito' },
  { id: 'soat_cierre', label: 'SOAT / cierre' },
  { id: 'rechazado', label: 'Rechazado' },
] as const;

export type TramiteEtapaId = (typeof TRAMITE_ETAPAS)[number]['id'];

export function etiquetaEtapa(id: string): string {
  return TRAMITE_ETAPAS.find((e) => e.id === id)?.label ?? id;
}
