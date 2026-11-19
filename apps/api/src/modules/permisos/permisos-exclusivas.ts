// HU #13944 (Feature #13939) — Funciones exclusivas del Administrador: la regla de escritura.
//
// Una función con `permisos_funciones.exclusiva_admin = true` (copia de `FUNCIONES_EXCLUSIVAS_ADMIN`, comprobada al
// arrancar) la tiene SOLO el rol `admin`:
//   · el cuadro de un rol distinto de `admin` (y un rol nuevo) no puede incluirla → 409 «no se puede asignar…»;
//   · el cuadro de `admin` no puede omitirla → 409 «no se puede quitar» (antes que el seguro antibloqueo);
//   · un usuario no puede tener excepción sobre ella: `conceder` → «asignar», `revocar` → «quitar».
// «Rol admin» es el literal `admin` de `USER_ROLES`, no `es_sistema` (que significa «no se borra»).
// Se comprueba ANTES de abrir la transacción, en la misma lectura que la existencia de los códigos
// (patrón `funcionesInexistentes` / `FuncionesInexistentesError`): un 409 no escribe nada.
import { eq, inArray, or } from 'drizzle-orm';
import type { UserRole } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { permisosFunciones } from '../../db/schema.js';

export const ROL_ADMIN = 'admin' as const satisfies UserRole;

export type MotivoExclusiva = 'asignar' | 'quitar';

/** 409: la escritura daría una exclusiva a quien no es `admin`, o se la quitaría a `admin`. */
export class FuncionExclusivaAdminError extends Error {
  constructor(public readonly funcion: string, public readonly nombre: string, public readonly motivo: MotivoExclusiva) {
    super(motivo === 'asignar'
      ? `La función ${nombre} es exclusiva del Administrador y no se puede asignar a otro rol.`
      : `La función ${nombre} es exclusiva del Administrador y no se puede quitar.`);
    this.name = 'FuncionExclusivaAdminError';
  }
}

export interface FuncionExclusiva { codigo: string; nombre: string }

export interface LecturaDeFunciones {
  /** Los códigos pedidos que no existen en `permisos_funciones`. */
  inexistentes: string[];
  /** TODAS las exclusivas de la base (pedidas o no): el cuadro de `admin` necesita ver las que faltan. */
  exclusivas: FuncionExclusiva[];
}

/** Una sola lectura, fuera de toda tx: existencia de lo pedido y el conjunto de exclusivas. */
export async function leerFunciones(codigos: string[]): Promise<LecturaDeFunciones> {
  const esExclusiva = eq(permisosFunciones.exclusivaAdmin, true);
  const filas = await db.select({
    codigo: permisosFunciones.codigo,
    nombreNegocio: permisosFunciones.nombreNegocio,
    exclusivaAdmin: permisosFunciones.exclusivaAdmin,
  }).from(permisosFunciones)
    .where(codigos.length ? or(inArray(permisosFunciones.codigo, codigos), esExclusiva) : esExclusiva);
  const existen = new Set(filas.map((f) => f.codigo));
  return {
    inexistentes: codigos.filter((c) => !existen.has(c)),
    exclusivas: filas.filter((f) => f.exclusivaAdmin === true).map((f) => ({ codigo: f.codigo, nombre: f.nombreNegocio })),
  };
}

/**
 * El cuadro completo `funciones` de `rol`: si no es `admin`, ninguna exclusiva; si es `admin`, todas.
 * Lanza con la primera que incumple (orden por código: el mensaje no depende del orden de la consulta).
 */
export function comprobarCuadroExclusivas(rol: string, funciones: readonly string[], exclusivas: FuncionExclusiva[]): void {
  if (rol !== ROL_ADMIN) { comprobarSinExclusivas(funciones, exclusivas); return; }
  const pedidas = new Set(funciones);
  const falta = porCodigo(exclusivas).find((e) => !pedidas.has(e.codigo));
  if (falta) throw new FuncionExclusivaAdminError(falta.codigo, falta.nombre, 'quitar');
}

/** El cuadro de un rol que NO es `admin` (también el de un rol nuevo): ninguna exclusiva. */
export function comprobarSinExclusivas(funciones: readonly string[], exclusivas: FuncionExclusiva[]): void {
  const pedidas = new Set(funciones);
  const sobra = porCodigo(exclusivas).find((e) => pedidas.has(e.codigo));
  if (sobra) throw new FuncionExclusivaAdminError(sobra.codigo, sobra.nombre, 'asignar');
}

const porCodigo = (xs: FuncionExclusiva[]): FuncionExclusiva[] => [...xs].sort((a, b) => a.codigo.localeCompare(b.codigo));

/** Excepciones por usuario: ninguna sobre una exclusiva. `conceder` → «asignar»; `revocar` → «quitar». */
export function comprobarExcepcionesExclusivas(
  excepciones: readonly { codigo: string; efecto: string }[], exclusivas: FuncionExclusiva[],
): void {
  const indice = new Map(exclusivas.map((e) => [e.codigo, e]));
  const mal = [...excepciones].sort((a, b) => a.codigo.localeCompare(b.codigo)).find((x) => indice.has(x.codigo));
  if (mal) {
    const e = indice.get(mal.codigo)!;
    throw new FuncionExclusivaAdminError(e.codigo, e.nombre, mal.efecto === 'revocar' ? 'quitar' : 'asignar');
  }
}
