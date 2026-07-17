/** Códigos RUNT — consulta ciudadano (persona). */
export const RUNT_TIPOS_PERSONA = ['C', 'T', 'E', 'Y', 'P'] as const;

/** Códigos RUNT — consulta vehículo (propietario). */
export const RUNT_TIPOS_VEHICULO = ['C', 'E', 'T', 'P', 'N', 'D', 'R', 'PT'] as const;

const UI_TO_RUNT: Record<string, string> = {
  CC: 'C',
  CE: 'E',
  TI: 'T',
  PAS: 'P',
  PA: 'P',
  PPT: 'Y',
  NIT: 'N',
  RC: 'R',
  PT: 'PT',
};

/** Mapea tipo documento UI (CC, CE, TI…) al código RUNT (C, E, T…). */
export function mapTipoDocUiToRunt(tipo?: string | null): string | null {
  if (!tipo) return null;
  const k = tipo.trim().toUpperCase();
  if (UI_TO_RUNT[k]) return UI_TO_RUNT[k];
  if ((RUNT_TIPOS_PERSONA as readonly string[]).includes(k)) return k;
  if ((RUNT_TIPOS_VEHICULO as readonly string[]).includes(k)) return k;
  return null;
}

/** Orden de tipos RUNT a intentar para consulta persona. */
export function tiposPersonaAIntentar(tipoUi?: string | null): string[] {
  const mapped = mapTipoDocUiToRunt(tipoUi);
  if (mapped && (RUNT_TIPOS_PERSONA as readonly string[]).includes(mapped)) {
    return [mapped, ...RUNT_TIPOS_PERSONA.filter((t) => t !== mapped)];
  }
  return [...RUNT_TIPOS_PERSONA];
}

/** Orden de tipos RUNT a intentar para consulta vehículo (por placa). */
export function tiposVehiculoAIntentar(tipoUi?: string | null): string[] {
  const mapped = mapTipoDocUiToRunt(tipoUi);
  if (mapped && (RUNT_TIPOS_VEHICULO as readonly string[]).includes(mapped)) {
    return [mapped, ...RUNT_TIPOS_VEHICULO.filter((t) => t !== mapped)];
  }
  return [...RUNT_TIPOS_VEHICULO];
}
