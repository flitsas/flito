// Dr. Flit IA — cupo diario de mensajes por usuario (HU #13854, Feature #13696, IA-2). Tabla 0247
// `flito_drflit_cupo_ia`. Diseño: docs/diseno/feature-13696-dr-flit-ia.md («Cupo diario») · ADR-0027.
//
// RN-DRF-C1  El día es el calendario de America/Bogota calculado aquí desde un reloj INYECTABLE, nunca
//            desde la zona del servidor ni de PostgreSQL (`now()` no decide el día).
// RN-DRF-C2  Reservar es UN solo UPSERT condicionado: `INSERT … SELECT … WHERE tope >= 1 ON CONFLICT …
//            DO UPDATE … WHERE usados < tope RETURNING usados`. Sin fila devuelta = tope alcanzado, y el
//            contador no se toca. Atómico frente a pestañas concurrentes (el segundo espera el bloqueo
//            de la fila y re-evalúa el WHERE). Con tope 0 nunca concede (ni crea la fila).
// RN-DRF-C3  Devolver opera sobre el MISMO `dia` de la reserva (no se recalcula: la medianoche puede caer
//            entre la reserva y el fallo) y nunca baja de 0 (`WHERE usados > 0`).
// RN-DRF-C4  La tabla solo guarda usuario, día, usados y fecha de actualización (minimización, Ley 1581).
// Todo con `sql` parametrizado.
import { sql, type SQL } from 'drizzle-orm';
import type { CupoIaDrFlit } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { topeDiarioIa } from './dr-flit.config.js';

export const ZONA_CUPO_IA = 'America/Bogota';

/** Conexión mínima: lo que hace falta para ejecutar SQL crudo (el `db` real o una transacción). */
export interface ConexionCupo { execute: (q: SQL) => Promise<unknown> }

export interface OpcionesCupo {
  ahora?: Date;
  tope?: number;
  conexion?: ConexionCupo;
}

const FORMATO_DIA = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_CUPO_IA, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Día calendario de America/Bogota (`YYYY-MM-DD`) del instante dado, sin importar la zona del proceso. */
export function diaCupoIa(ahora: Date): string {
  return FORMATO_DIA.format(ahora);
}

function filas(r: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
  const rows = (r as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function cupo(usados: number, tope: number): CupoIaDrFlit {
  return { usados, tope, restantes: Math.max(0, tope - usados) };
}

export type ReservaCupoIa =
  | ({ concedida: true; dia: string } & CupoIaDrFlit)
  | ({ concedida: false; dia: string; motivo: 'tope-alcanzado' } & CupoIaDrFlit);

/** Usados del usuario en `dia` (0 si no hay fila). */
async function usadosEn(conexion: ConexionCupo, usuarioId: number, dia: string): Promise<number> {
  const r = await conexion.execute(sql`SELECT usados FROM flito_drflit_cupo_ia
    WHERE usuario_id = ${usuarioId} AND dia = ${dia}::date`);
  const f = filas(r)[0];
  return f ? Number(f.usados) : 0;
}

/** Reserva un mensaje del cupo de hoy (America/Bogota). Ver RN-DRF-C2. */
export async function reservarCupoIa(usuarioId: number, opts: OpcionesCupo = {}): Promise<ReservaCupoIa> {
  const conexion = opts.conexion ?? db;
  const tope = opts.tope ?? topeDiarioIa();
  const dia = diaCupoIa(opts.ahora ?? new Date());
  const r = await conexion.execute(sql`INSERT INTO flito_drflit_cupo_ia AS t (usuario_id, dia, usados)
    SELECT ${usuarioId}, ${dia}::date, 1 WHERE ${tope}::int >= 1
    ON CONFLICT (usuario_id, dia) DO UPDATE SET usados = t.usados + 1, actualizado_en = now()
      WHERE t.usados < ${tope}::int
    RETURNING usados`);
  const f = filas(r)[0];
  if (f) return { concedida: true, dia, ...cupo(Number(f.usados), tope) };
  return { concedida: false, dia, motivo: 'tope-alcanzado', ...cupo(await usadosEn(conexion, usuarioId, dia), tope) };
}

/**
 * Devuelve un mensaje al cupo del `dia` de la reserva (fallo de red, timeout o error del proveedor).
 * `true` si bajó el contador; `false` si no había nada que devolver (fila inexistente o ya en 0).
 */
export async function devolverCupoIa(
  usuarioId: number, dia: string, opts: Pick<OpcionesCupo, 'conexion'> = {},
): Promise<boolean> {
  const conexion = opts.conexion ?? db;
  const r = await conexion.execute(sql`UPDATE flito_drflit_cupo_ia
    SET usados = usados - 1, actualizado_en = now()
    WHERE usuario_id = ${usuarioId} AND dia = ${dia}::date AND usados > 0
    RETURNING usados`);
  return filas(r).length > 0;
}

/** Cupo de hoy (America/Bogota) del usuario, para el GET de autorización. No escribe. */
export async function consultarCupoIa(usuarioId: number, opts: OpcionesCupo = {}): Promise<CupoIaDrFlit> {
  const conexion = opts.conexion ?? db;
  const tope = opts.tope ?? topeDiarioIa();
  const dia = diaCupoIa(opts.ahora ?? new Date());
  return cupo(await usadosEn(conexion, usuarioId, dia), tope);
}
