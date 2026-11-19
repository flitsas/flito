// FLITO SOAT — «el SOAT actual de un vehículo», en UN solo sitio (Feature #14012, HU #14016, ADR-0031).
//
// Desde la migración 0267 un vehículo puede tener VARIOS `flito_soat` (los `pagado` son historial) pero
// a lo sumo UNO abierto (`estado <> 'pagado'`). Todo lector que antes hacía
// `select … where vin = ? limit 1` asumiendo una sola fila debe pasar por aquí:
//
//   · si hay un SOAT abierto, ese es el actual;
//   · si no, el más reciente (`created_at DESC, id DESC`).
//
// El censo del cron de vigencia replica esta misma regla en SQL (`DISTINCT ON`, ver
// `condicionCenso`). Terminal = SOLO `pagado` (`soatEstaAbierto` en shared-types).

import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { soatEstaAbierto, type EstadoSoat } from '@operaciones/shared-types';
import type { db } from '../../db/client.js';
import { flitoSoat } from '../../db/schema.js';

export interface SoatActualDelVin {
  id: string;
  estado: EstadoSoat;
  companiaId: number;
  /** 'YYYY-MM-DD' o null. */
  venceEl: string | null;
  createdAt: Date;
}

/** Cliente de base o transacción: solo se necesita `select`. */
type Lector = Pick<typeof db, 'select'>;

/** Orden de «actual»: primero los abiertos, luego el más reciente. */
export const ORDEN_SOAT_ACTUAL = [
  sql`(${flitoSoat.estado} <> 'pagado') DESC`,
  desc(flitoSoat.createdAt),
  desc(flitoSoat.id),
] as const;

export async function soatActualDelVin(lector: Lector, vin: string): Promise<SoatActualDelVin | null> {
  const [fila] = await lector
    .select({
      id: flitoSoat.id,
      estado: flitoSoat.estado,
      companiaId: flitoSoat.companiaId,
      venceEl: flitoSoat.venceEl,
      createdAt: flitoSoat.createdAt,
    })
    .from(flitoSoat)
    .where(eq(flitoSoat.vin, vin))
    .orderBy(...ORDEN_SOAT_ACTUAL)
    .limit(1);
  if (!fila) return null;
  return fila as SoatActualDelVin;
}

/** ¿El SOAT actual del VIN está abierto (en proceso)? */
export function actualEstaAbierto(a: Pick<SoatActualDelVin, 'estado'> | null): boolean {
  return a !== null && soatEstaAbierto(a.estado);
}

/**
 * Guard de `reversar` (AC8): mover un SOAT a un estado ABIERTO mientras el mismo vehículo ya tiene
 * OTRO abierto violaría `uq_flito_soat_vehiculo_abierto`. `true` = hay otro abierto (el servicio
 * responde 409 en vez de dejar escapar un 23505 crudo). Hacia `pagado` nunca hay conflicto.
 */
export async function hayOtroAbiertoAlReabrir(
  lector: Lector, soatId: string, estadoDestino: EstadoSoat,
): Promise<boolean> {
  if (!soatEstaAbierto(estadoDestino)) return false;
  // Una sola consulta: otro SOAT abierto del MISMO vehículo que el de `soatId`.
  const [otro] = await lector.select({ id: flitoSoat.id }).from(flitoSoat)
    .where(and(
      ne(flitoSoat.id, soatId),
      sql`${flitoSoat.estado} <> 'pagado'`,
      sql`${flitoSoat.vehiculoId} = (SELECT s.vehiculo_id FROM flito_soat s WHERE s.id = ${soatId})`,
    ))
    .limit(1);
  // `otro.id !== soatId` es redundante con el `ne` (defensa en profundidad).
  return otro !== undefined && otro.id !== soatId;
}
