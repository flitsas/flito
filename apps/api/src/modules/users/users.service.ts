// Usuarios — datos y transacciones (HU #12053, Feature #12052).
//
// El módulo `users` nunca tuvo el par `.routes`/`.service` que pide AGENTS.md: todo vivía en
// `users.routes.ts`. Las dos ataduras de ámbito de esta HU —el proveedor SOAT del rol `proveedor`
// (CA-09) y los organismos del `gestor_impuestos` (CA-10)— obligan a escribir en DOS tablas dentro
// de UNA transacción, y ese trozo no es HTTP: es dominio. Aquí vive.
//
// La atadura del gestor es una TABLA, no una columna (`flito_gestor_organismos`, migración 0173).
// Consecuencias que se pagan aquí y no en la ruta:
//   · `.returning()` de drizzle no admite `join`, así que `organismosCodigos` NUNCA sale de
//     `userSelect`: se COMPONE (el conjunto recién escrito en POST/PATCH, una lectura en GET/toggle).
//   · AC4 — el `UPDATE` de `users` (con `session_invalidated_at`), el `DELETE` y el `INSERT` van en
//     la MISMA transacción. Partirlos deja al gestor con organismos nuevos y su sesión vieja viva.
//   · El conjunto se REEMPLAZA, no se une: `DELETE` de lo que sobra + `INSERT ... ON CONFLICT DO
//     NOTHING` de lo que falta, que además preserva el `created_at` de lo que no cambió.

import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoGestorOrganismos, flitoProveedoresSoat, organismosTransitoConfig, users,
} from '../../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Proyección del usuario que sale por HTTP. `flitoProveedorSoatId` SÍ está (es una columna y el
 * listado la necesita para decir a qué proveedor pertenece un `proveedor`); los organismos NO pueden
 * estar (son otra tabla y `.returning()` no hace join) y se componen aparte.
 */
export const userSelect = {
  id: users.id,
  username: users.username,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
  allowedPages: users.allowedPages,
  transitoCodigo: users.transitoCodigo,
  // La lista de usuarios la necesita para decir a qué compañía pertenece un `cliente`: sin ella, el
  // dato que el AC2 de la HU #11913 vuelve obligatorio solo se vería abriendo «Editar».
  companiaId: users.companiaId,
  // Ídem para el proveedor SOAT del rol `proveedor` (AC5 de la #12053): la celda «Ámbito» de la
  // tabla lo pinta sin abrir el formulario.
  flitoProveedorSoatId: users.flitoProveedorSoatId,
  createdAt: users.createdAt,
};

/** El usuario tal como lo sirve la API. `organismosCodigos` es SIEMPRE un array, nunca null. */
export interface UsuarioConAmbito {
  id: number;
  username: string;
  name: string;
  email: string | null;
  role: string;
  active: boolean;
  allowedPages: string[];
  transitoCodigo: string | null;
  companiaId: number | null;
  flitoProveedorSoatId: string | null;
  createdAt: Date;
  /** CA-10: los organismos del `gestor_impuestos`. `[]` para los otros once roles. */
  organismosCodigos: string[];
}

// ── Existencia de las dos ataduras ───────────────────────────────────────────────────────────────
// Sin estas dos comprobaciones, un id inventado sale como un 23503 servido en un 500 sin mensaje
// útil. Es el mismo motivo por el que `companiaExiste()` vive en la ruta desde la HU #11913.

/**
 * ¿Existe ese proveedor SOAT? **No se exige `activo`**, y es deliberado (UX decisión 9): el front
 * filtra por activo al OFRECER, el backend acepta lo que existe. Si aquí se rechazara un proveedor
 * desactivado, editarle el nombre a un usuario atado a él fallaría con un mensaje sobre un campo que
 * el admin no tocó, y guardar le desharía la atadura.
 */
export async function proveedorSoatExiste(id: string): Promise<boolean> {
  const [p] = await db.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat)
    .where(eq(flitoProveedoresSoat.id, id)).limit(1);
  return !!p;
}

/**
 * Los códigos que NO están en el catálogo PARAMETRIZADO (`organismos_transito_config`), para poder
 * nombrarlos. El `isKnownOrganismoCodigo` de Zod no basta: el catálogo nacional de `shared-types`
 * tiene todos los municipios y el parametrizado es el subconjunto que la operación configuró.
 */
export async function organismosInexistentes(codigos: string[]): Promise<string[]> {
  if (codigos.length === 0) return [];
  const filas = await db.select({ codigo: organismosTransitoConfig.codigo })
    .from(organismosTransitoConfig)
    .where(inArray(organismosTransitoConfig.codigo, codigos));
  const existen = new Set(filas.map((f) => f.codigo));
  return codigos.filter((c) => !existen.has(c));
}

// ── Lectura de la atadura del gestor ─────────────────────────────────────────────────────────────

/** Los organismos de UN usuario. Orden estable por código: la respuesta no depende del `INSERT`. */
export async function organismosDe(userId: number, ejecutor: Tx | typeof db = db): Promise<string[]> {
  const filas = await ejecutor.select({ codigo: flitoGestorOrganismos.organismoCodigo })
    .from(flitoGestorOrganismos).where(eq(flitoGestorOrganismos.userId, userId));
  return filas.map((f) => f.codigo).sort();
}

/**
 * Los organismos de VARIOS usuarios, en UNA consulta (AC5): el listado los pinta en la celda
 * «Ámbito» y una consulta por fila sería N+1 sobre una página entera de usuarios.
 */
export async function organismosDeVarios(userIds: number[]): Promise<Map<number, string[]>> {
  const mapa = new Map<number, string[]>();
  if (userIds.length === 0) return mapa; // `inArray` con lista vacía no produce SQL válido
  const filas = await db
    .select({ userId: flitoGestorOrganismos.userId, codigo: flitoGestorOrganismos.organismoCodigo })
    .from(flitoGestorOrganismos).where(inArray(flitoGestorOrganismos.userId, userIds));
  for (const f of filas) {
    const ya = mapa.get(f.userId);
    if (ya) ya.push(f.codigo); else mapa.set(f.userId, [f.codigo]);
  }
  for (const lista of mapa.values()) lista.sort();
  return mapa;
}

// ── Escritura ────────────────────────────────────────────────────────────────────────────────────

/**
 * Deja el conjunto de organismos del usuario EXACTAMENTE en `destino`. Reemplaza, no une: lo que no
 * está en `destino` se borra. El `DELETE` acotado (en vez de borrar todo y reinsertar) preserva el
 * `created_at` de las filas que siguen.
 */
export async function escribirOrganismos(tx: Tx, userId: number, destino: string[]): Promise<void> {
  if (destino.length === 0) {
    await tx.delete(flitoGestorOrganismos).where(eq(flitoGestorOrganismos.userId, userId));
    return;
  }
  await tx.delete(flitoGestorOrganismos).where(and(
    eq(flitoGestorOrganismos.userId, userId),
    notInArray(flitoGestorOrganismos.organismoCodigo, destino),
  ));
  await tx.insert(flitoGestorOrganismos)
    .values(destino.map((organismoCodigo) => ({ userId, organismoCodigo })))
    .onConflictDoNothing();
}

export interface CrearUsuarioInput {
  username: string;
  name: string;
  email: string | null;
  passwordHash: string;
  role: typeof users.$inferInsert['role'];
  allowedPages: string[];
  transitoCodigo: string | null;
  companiaId: number | null;
  flitoProveedorSoatId: string | null;
  /** El conjunto del gestor; `[]` para el resto de roles (AC3 ya lo validó antes de llegar aquí). */
  organismosCodigos: string[];
}

/** Alta (AC1/AC2): el usuario y sus organismos, o ninguna de las dos cosas (AC3). */
export async function crearUsuario(input: CrearUsuarioInput): Promise<UsuarioConAmbito> {
  const { organismosCodigos, ...fila } = input;
  return db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values(fila).returning(userSelect);
    if (organismosCodigos.length > 0) await escribirOrganismos(tx, user.id, organismosCodigos);
    // El conjunto recién escrito, sin releer: es el mismo que acaba de entrar.
    return { ...user, organismosCodigos: [...organismosCodigos].sort() } as UsuarioConAmbito;
  });
}

export interface ActualizarUsuarioInput {
  /** Columnas de `users` a cambiar, ya resueltas por la ruta. */
  updates: Record<string, unknown>;
  /** Conjunto destino de organismos, o `null` para no tocarlo. `[]` = quitárselos todos. */
  organismosDestino: string[] | null;
  /** ¿Hay que invalidar sesiones por lo que cambia en `users` (rol, páginas, ámbitos)? */
  invalidarPorCampos: boolean;
}

export type ResultadoActualizar =
  | { estado: 'sin_cambios' }
  | { estado: 'no_encontrado' }
  | { estado: 'ok'; usuario: UsuarioConAmbito; invalidada: boolean; camposCambiados: string[] };

/**
 * Edición (AC4). Todo en UNA transacción: leer el conjunto anterior, decidir si cambió, escribir
 * `users` —con `sessionInvalidatedAt` si procede— y reemplazar los organismos.
 *
 * `invalidateSessionCacheFor()` NO se llama aquí: va DESPUÉS del commit, en la ruta, como ya se hacía.
 */
export async function actualizarUsuario(
  id: number, { updates, organismosDestino, invalidarPorCampos }: ActualizarUsuarioInput,
): Promise<ResultadoActualizar> {
  return db.transaction(async (tx): Promise<ResultadoActualizar> => {
    const anteriores = await organismosDe(id, tx);
    // Conjuntos, no arrays: el orden no es un cambio.
    const organismosCambiaron = organismosDestino !== null && !mismoConjunto(anteriores, organismosDestino);

    const set = { ...updates };
    if (Object.keys(set).length === 0 && !organismosCambiaron) return { estado: 'sin_cambios' };

    const invalidada = invalidarPorCampos || organismosCambiaron;
    // Cuando lo ÚNICO que cambia son los organismos, es esta marca la que mantiene el UPDATE no
    // vacío: por eso `db.update(...).set(set)` no necesita ninguna rama especial.
    if (invalidada) set.sessionInvalidatedAt = new Date();

    const [updated] = await tx.update(users).set(set).where(eq(users.id, id)).returning(userSelect);
    if (!updated) return { estado: 'no_encontrado' };

    if (organismosCambiaron) await escribirOrganismos(tx, id, organismosDestino!);

    const finales = organismosDestino !== null ? [...organismosDestino].sort() : anteriores;
    return {
      estado: 'ok',
      usuario: { ...updated, organismosCodigos: finales } as UsuarioConAmbito,
      invalidada,
      camposCambiados: [...Object.keys(updates), ...(organismosCambiaron ? ['organismosCodigos'] : [])],
    };
  });
}

function mismoConjunto(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}
