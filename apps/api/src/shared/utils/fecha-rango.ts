import { sql, and, type SQL, type Column } from 'drizzle-orm';

export const TZ_COLOMBIA = 'America/Bogota';

export interface FechaRango {
  desde: string | null;
  hasta: string | null;
}

/** YYYY-MM-DD — día calendario válido. */
export function parseFechaQuery(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return raw;
}

/** `desde`+`hasta`, o `fecha` legacy (un solo día). Intercambia si hasta < desde. */
export function parseFechaRangoQuery(query: Record<string, unknown>): FechaRango {
  const legacy = parseFechaQuery(query.fecha);
  let desde = parseFechaQuery(query.desde ?? query.fechaDesde) ?? legacy;
  let hasta = parseFechaQuery(query.hasta ?? query.fechaHasta) ?? legacy;
  if (desde && hasta && hasta < desde) [desde, hasta] = [hasta, desde];
  return { desde, hasta };
}

export function tieneFiltroFecha(rango: FechaRango): boolean {
  return Boolean(rango.desde || rango.hasta);
}

export function createdInRangeCondition(column: Column, rango: FechaRango): SQL | null {
  if (!tieneFiltroFecha(rango)) return null;
  const parts: SQL[] = [];
  if (rango.desde) parts.push(sql`${column} >= (${rango.desde}::date AT TIME ZONE ${TZ_COLOMBIA})`);
  if (rango.hasta) parts.push(sql`${column} < ((${rango.hasta}::date + interval '1 day') AT TIME ZONE ${TZ_COLOMBIA})`);
  if (parts.length === 1) return parts[0]!;
  return and(...parts)!;
}
