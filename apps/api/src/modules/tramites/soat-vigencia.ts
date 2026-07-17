// Regla de negocio: matrícula inicial NO debe pedir SOAT si el RUNT ya muestra
// uno vigente; solo lo pide si no hay SOAT activo. Helper puro (sin db/red) para
// poder testearlo de forma aislada.

interface RuntSoat {
  numSoat?: string | null;
  noPoliza?: string | null;
  fechaVencimSoat?: string | null;
  estado?: string | null;
}

/**
 * ¿El vehículo ya tiene un SOAT VIGENTE según la consulta RUNT (vehiculo.soat)?
 * Vigente = tiene número de póliza y, o bien la fecha de vencimiento es futura,
 * o (si no hay fecha parseable) el RUNT reporta estado 'VIGENTE'.
 * `now` es inyectable para pruebas deterministas.
 */
export function soatVigenteDeRunt(vehiculo: unknown, now: number = Date.now()): boolean {
  const v = (vehiculo || {}) as { soat?: RuntSoat | RuntSoat[] | null };
  const soat = Array.isArray(v.soat) ? v.soat[0] : v.soat;
  if (!soat) return false;
  const poliza = soat.numSoat || soat.noPoliza;
  if (!poliza) return false;
  const venc = soat.fechaVencimSoat ? new Date(String(soat.fechaVencimSoat)) : null;
  if (venc && !Number.isNaN(venc.getTime())) return venc.getTime() > now;
  // Sin fecha parseable: confiar en el estado explícito del RUNT.
  return String(soat.estado || '').toUpperCase() === 'VIGENTE';
}
