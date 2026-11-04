// Normalización de VIN con corte a 17 caracteres, compartida entre `vehicles` y `tramites/lote`
// (HU #14291, R3).
//
// Las normalizaciones de `tramites/transito.routes.ts` y `flito-tramites` no pasan por aquí: no cortan
// a 17 y dan otro resultado.

export function normalizeVin(vin: string): string {
  return (vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 17);
}
