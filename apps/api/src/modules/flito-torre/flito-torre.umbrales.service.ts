// Torre de Control Gerencial (Épica #14590) — umbrales configurables (`flito_torre_umbrales`, 0303).
//
// RN-TOR-U1: el catálogo de claves es CERRADO (`UMBRALES_TORRE`); la API no crea ni borra umbrales, solo cambia
//   el valor de uno que ya existe. Una clave fuera del catálogo es 400 en la ruta; una del catálogo sin fila en
//   la base (semilla no aplicada) es 404.
// RN-TOR-U2: la unidad es del catálogo y no se edita. Un porcentaje va de 0 a 100; el resto, ≥ 0 (también lo
//   exige el CHECK de la tabla).
// RN-TOR-U3: solo `admin` escribe (función `torre.umbrales.editar`); la ruta deja rastro con `audit()`.
// Sin datos del titular: ni `logPiiAccess` ni enmascarado. El nombre del usuario que cambió es interno.
import { asc, eq } from 'drizzle-orm';
import { UMBRALES_TORRE, type ClaveUmbralTorre, type UmbralTorre, type UnidadUmbralTorre } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoTorreUmbrales, users } from '../../db/schema.js';

export class UmbralTorreNoEncontradoError extends Error {
  readonly code = 'UMBRAL_NO_ENCONTRADO';
  constructor(clave: string) { super(`El umbral «${clave}» no existe.`); }
}

export class UmbralTorreFueraDeRangoError extends Error {
  readonly code = 'UMBRAL_FUERA_DE_RANGO';
  constructor(mensaje: string) { super(mensaje); }
}

/** Unidad del catálogo para una clave. */
export const unidadDeUmbral = (clave: ClaveUmbralTorre): UnidadUmbralTorre =>
  UMBRALES_TORRE.find((u) => u.clave === clave)!.unidad;

/** RN-TOR-U2. `null` si el valor cabe; si no, el mensaje del 400. */
export function errorDeRangoUmbral(unidad: UnidadUmbralTorre, valor: number): string | null {
  if (valor < 0) return 'El valor no puede ser negativo.';
  if (unidad === 'porcentaje' && valor > 100) return 'Un porcentaje va de 0 a 100.';
  return null;
}

const ORDEN = new Map(UMBRALES_TORRE.map((u, i) => [u.clave as string, i]));

const seleccion = {
  clave: flitoTorreUmbrales.clave, valor: flitoTorreUmbrales.valor, unidad: flitoTorreUmbrales.unidad,
  descripcion: flitoTorreUmbrales.descripcion, actualizadoPorId: flitoTorreUmbrales.actualizadoPor,
  actualizadoPorNombre: users.name, actualizadoEn: flitoTorreUmbrales.actualizadoEn,
};
type Fila = {
  clave: string; valor: string; unidad: string; descripcion: string; actualizadoPorId: number | null;
  actualizadoPorNombre: string | null; actualizadoEn: Date | null;
};

const aDto = (f: Fila): UmbralTorre => ({
  clave: f.clave,
  valor: Number(f.valor),
  unidad: f.unidad as UnidadUmbralTorre,
  descripcion: f.descripcion,
  actualizadoPor: f.actualizadoPorId === null ? null : { id: f.actualizadoPorId, nombre: f.actualizadoPorNombre },
  actualizadoEn: f.actualizadoEn ? f.actualizadoEn.toISOString() : null,
});

/** Todos los umbrales, en el orden del catálogo. */
export async function listarUmbrales(): Promise<UmbralTorre[]> {
  const filas: Fila[] = await db.select(seleccion).from(flitoTorreUmbrales)
    .leftJoin(users, eq(users.id, flitoTorreUmbrales.actualizadoPor))
    .orderBy(asc(flitoTorreUmbrales.clave));
  return filas.map(aDto).sort((a, b) => (ORDEN.get(a.clave) ?? 999) - (ORDEN.get(b.clave) ?? 999));
}

/** Cambia el valor de un umbral. Devuelve el anterior y el nuevo para el `audit()` de la ruta. */
export async function actualizarUmbral(
  clave: ClaveUmbralTorre, valor: number, actorId: number | null,
): Promise<{ anterior: number; umbral: UmbralTorre }> {
  const unidad = unidadDeUmbral(clave);
  const fuera = errorDeRangoUmbral(unidad, valor);
  if (fuera) throw new UmbralTorreFueraDeRangoError(fuera);
  const [previo] = await db.select({ valor: flitoTorreUmbrales.valor }).from(flitoTorreUmbrales)
    .where(eq(flitoTorreUmbrales.clave, clave)).limit(1);
  if (!previo) throw new UmbralTorreNoEncontradoError(clave);
  await db.update(flitoTorreUmbrales)
    .set({ valor: valor.toFixed(2), actualizadoPor: actorId, actualizadoEn: new Date() })
    .where(eq(flitoTorreUmbrales.clave, clave));
  const [fila] = await db.select(seleccion).from(flitoTorreUmbrales)
    .leftJoin(users, eq(users.id, flitoTorreUmbrales.actualizadoPor))
    .where(eq(flitoTorreUmbrales.clave, clave)).limit(1);
  return { anterior: Number(previo.valor), umbral: aDto(fila as Fila) };
}

/**
 * Valor vigente de cada umbral para los tableros. Una clave sin fila (semilla no aplicada) cae en su
 * `valorPorDefecto` del catálogo, para que un tablero nunca se quede sin umbral.
 */
export async function valoresUmbrales(): Promise<Record<ClaveUmbralTorre, number>> {
  const filas = await db.select({ clave: flitoTorreUmbrales.clave, valor: flitoTorreUmbrales.valor }).from(flitoTorreUmbrales);
  const enBase = new Map(filas.map((f) => [f.clave, Number(f.valor)]));
  return Object.fromEntries(UMBRALES_TORRE.map((u) => [u.clave, enBase.get(u.clave) ?? u.valorPorDefecto])) as Record<ClaveUmbralTorre, number>;
}
