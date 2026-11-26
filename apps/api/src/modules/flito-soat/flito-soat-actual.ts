// FLITO SOAT — «el SOAT actual de un vehículo», en UN solo sitio (Feature #14012, HU #14016, ADR-0031).
//
// Desde la migración 0267 un vehículo puede tener VARIOS `flito_soat` (los `pagado` son historial) pero
// a lo sumo UNO abierto (`SOAT_ABIERTO`: ni `pagado` ni `descartado`, 0318). Todo lector que antes hacía
// `select … where vin = ? limit 1` asumiendo una sola fila debe pasar por aquí:
//
//   · si hay un SOAT abierto, ese es el actual;
//   · si no, el más reciente (`created_at DESC, id DESC`).
//
// El censo del cron de vigencia replica esta misma regla en SQL (`DISTINCT ON`, ver
// `condicionCenso`). Terminal = `pagado` y `descartado` (`soatEstaAbierto` en shared-types).
//
// Épica #14707 (ADR-0049 §2): un SOAT `descartado` (su trámite murió en FLIT) NO es el actual de nadie: no se
// vincula ni bloquea el alta de uno nuevo. `SOAT_ABIERTO` es el ÚNICO fragmento «abierto» del SQL; reemplaza los
// literales `<> 'pagado'` que había repartidos.

import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
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

/** Épica #14707: SOAT abierto (en proceso). Con `columna` sirve para alias de SQL crudo (`s.estado`). */
export const SOAT_ABIERTO = (columna: SQL | typeof flitoSoat.estado = flitoSoat.estado): SQL =>
  sql`${columna} NOT IN ('pagado', 'descartado')`;

/** Orden de «actual»: primero los abiertos, luego los no descartados (Épica #14707), luego el más reciente. */
export const ORDEN_SOAT_ACTUAL = [
  sql`(${SOAT_ABIERTO()}) DESC`,
  sql`(${flitoSoat.estado} = 'descartado') ASC`,
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
  // Épica #14707: el orden deja los descartados al final; si el primero lo es, el VIN no tiene SOAT actual.
  if (!fila || fila.estado === 'descartado') return null;
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
      SOAT_ABIERTO(),
      sql`${flitoSoat.vehiculoId} = (SELECT s.vehiculo_id FROM flito_soat s WHERE s.id = ${soatId})`,
    ))
    .limit(1);
  // `otro.id !== soatId` es redundante con el `ne` (defensa en profundidad).
  return otro !== undefined && otro.id !== soatId;
}
