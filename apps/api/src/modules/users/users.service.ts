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

import { and, eq, ilike, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { ALL_ROLES, type RoleCode, type UserRole } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoGestorOrganismos, flitoProveedoresSoat, organismosTransitoConfig, permisosRoles,
  users,
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
 * La fila del rol si es ASIGNABLE —existe en el catálogo y está `activo`—; `null` si no (HU #12169,
 * AC6 + CF-03). Es la hermana de `companiaExiste()` y `proveedorSoatExiste()`, y está aquí por el
 * mismo motivo: sin ella, un código de rol inventado sería un 23503 de la FK servido en un 500.
 *
 * Sustituye a `z.enum(ALL_ROLES)`: el catálogo es DATO y un esquema de Zod es una constante
 * compilada. Con esto, un rol que el administrador acaba de crear se puede asignar de inmediato, sin
 * publicar una versión (CF-03).
 *
 * **Sí exige `activo`**, a diferencia de `proveedorSoatExiste()` (que a propósito no lo exige). No es
 * incoherencia: allí el ámbito inactivo ya está asignado y rechazarlo rompería una edición ajena al
 * campo; aquí `activo = false` significa «no ofrecer más este rol» y su único efecto útil es impedir
 * ASIGNACIONES NUEVAS. Un usuario que ya tiene un rol desactivado sigue entrando y trabajando:
 * `activo` gobierna la asignación, no la autenticación.
 */
export async function rolAsignable(codigo: string): Promise<{ tipoEnlace: string } | null> {
  const [r] = await db.select({ tipoEnlace: permisosRoles.tipoEnlace })
    .from(permisosRoles)
    .where(and(eq(permisosRoles.codigo, codigo), eq(permisosRoles.activo, true)))
    .limit(1);
  return r ?? null;
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
  /**
   * El CÓDIGO del rol (HU #12169). Ya no es `users.$inferInsert['role']` —que era la unión cerrada
   * del enum— porque puede ser un rol que creó el administrador. Quien garantiza que existe es
   * `rolAsignable()` en la ruta, y por debajo la FK `users_role_fkey`.
   */
  role: RoleCode;
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

// ── Listado filtrado, paginado y su resumen (HU #12172) ──────────────────────────────────────────
//
// Hasta esta HU `GET /api/users` devolvía la tabla ENTERA sin filtro ni tope. Los tres filtros y la
// paginación viven AQUÍ y no en la ruta por dos motivos: los comparte la descarga de `/export` —que
// tiene que bajar exactamente lo que la pantalla está mostrando, no la tabla entera— y así el
// predicado se puede probar contra el SQL que de verdad se ejecuta.

/** Los tres filtros del listado. Todos opcionales: sin ninguno, el comportamiento es el de antes. */
export interface FiltrosUsuarios {
  /** Código de rol EXACTO. La ruta ya lo validó contra `ALL_ROLES`; aquí llega vivo o no llega. */
  rol?: UserRole;
  activo?: boolean;
  /** Texto libre sobre `username`, `name` y `email`. Sin distinguir mayúsculas ni acentos de más. */
  q?: string;
}

/**
 * Escapa los comodines de `LIKE` en lo que escribió el usuario.
 *
 * Sin esto, buscar `%` lista a TODO el mundo y buscar `a_b` casa con `axb`: el texto de una caja de
 * búsqueda no es un patrón. El carácter de escape es la barra invertida, que es el que Postgres usa
 * por defecto en `LIKE`/`ILIKE` cuando no se declara `ESCAPE`.
 */
export function escaparComodines(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * El `WHERE` del listado, o `undefined` cuando no hay ningún filtro (y entonces la consulta es
 * literalmente la de antes de esta HU).
 *
 * Se exporta para poder renderizarlo, pero eso NO basta como prueba: el test tiene que afirmar sobre
 * la condición que llegó a `.where()`, no sobre el resultado de llamar a esta función.
 */
export function condicionesUsuarios(f: FiltrosUsuarios): SQL | undefined {
  const cs: (SQL | undefined)[] = [];
  if (f.rol) cs.push(eq(users.role, f.rol));
  if (f.activo !== undefined) cs.push(eq(users.active, f.activo));
  if (f.q) {
    const patron = `%${escaparComodines(f.q)}%`;
    // Tres parámetros con el mismo valor, no uno reutilizado: drizzle no deduplica literales. En un
    // `WHERE` eso es inofensivo (a diferencia de un `GROUP BY`), y a cambio la condición se lee.
    cs.push(or(ilike(users.username, patron), ilike(users.name, patron), ilike(users.email, patron)));
  }
  const vivas = cs.filter((c): c is SQL => c !== undefined);
  return vivas.length > 0 ? and(...vivas) : undefined;
}

/** Página pedida. `porPagina` ausente = sin paginar, que es el comportamiento histórico. */
export interface PaginacionUsuarios {
  /** 1-based. Solo cuenta si viene `porPagina`. */
  pagina?: number;
  porPagina?: number;
}

export interface ListadoUsuarios {
  filas: Omit<UsuarioConAmbito, 'organismosCodigos'>[];
  /** Coincidencias TOTALES del filtro, no las de la página. Es lo que viaja en `X-Total-Count`. */
  total: number;
}

/**
 * Las filas del listado y cuántas coincidencias hay en total.
 *
 * El `count(*)` solo se ejecuta CUANDO se pagina: sin paginación el total es el largo de lo que ya
 * se trajo, y una consulta de más aquí sería gasto puro sobre el camino que usan los consumidores
 * de siempre.
 */
export async function listarUsuarios(
  f: FiltrosUsuarios, p: PaginacionUsuarios = {},
): Promise<ListadoUsuarios> {
  const cond = condicionesUsuarios(f);
  const base = db.select(userSelect).from(users).where(cond).orderBy(users.username);

  if (p.porPagina === undefined) {
    const filas = await base;
    return { filas: filas as ListadoUsuarios['filas'], total: filas.length };
  }

  const pagina = p.pagina && p.pagina > 0 ? p.pagina : 1;
  const filas = await base.limit(p.porPagina).offset((pagina - 1) * p.porPagina);
  const [conteo] = await db.select({ total: sql<number>`count(*)::int` }).from(users).where(cond);
  return { filas: filas as ListadoUsuarios['filas'], total: Number(conteo?.total ?? 0) };
}

export interface ResumenUsuarios {
  /** Un número por CADA código de rol vivo, incluidos los que hoy no tiene nadie (0). */
  porRol: Record<string, number>;
  activos: number;
  inactivos: number;
}

/**
 * El conteo por rol y por estado, en UNA sola consulta.
 *
 * Se agrupa por DOS columnas (`role`, `active`) para sacar las tres cifras del mismo barrido: una
 * consulta por rol serían doce, y `count(*) FILTER` por rol volvería a atarnos al catálogo. Ojo con
 * el `GROUP BY`: aquí se agrupa por COLUMNAS, no por literales — repetir un literal en un `GROUP BY`
 * genera dos parámetros distintos y Postgres responde 42803.
 *
 * Los roles sin usuarios salen en 0 y no ausentes: así el front pinta el catálogo completo sin
 * escribir `?? 0` en cada celda.
 */
export async function resumenUsuarios(): Promise<ResumenUsuarios> {
  const filas = await db.select({
    role: users.role,
    active: users.active,
    total: sql<number>`count(*)::int`,
  }).from(users).groupBy(users.role, users.active);

  const porRol: Record<string, number> = {};
  for (const rol of ALL_ROLES) porRol[rol] = 0;

  let activos = 0;
  let inactivos = 0;
  for (const f of filas) {
    const n = Number(f.total) || 0;
    porRol[f.role] = (porRol[f.role] ?? 0) + n;
    if (f.active) activos += n; else inactivos += n;
  }
  return { porRol, activos, inactivos };
}

/**
 * Los NOMBRES de las dos ataduras que son claves foráneas, para la descarga: `compania_id` es un
 * entero y `flito_proveedor_soat_id` un uuid, y ninguno de los dos le dice nada a quien abre el
 * Excel. Dos consultas por lote (`inArray`), no una por fila: el AC prohíbe el N+1 en el listado y
 * la descarga no es distinta.
 */
export async function nombresDeAmbito(
  companiaIds: number[], proveedorIds: string[],
): Promise<{ companias: Map<number, string>; proveedores: Map<string, string> }> {
  const companias = new Map<number, string>();
  const proveedores = new Map<string, string>();
  if (companiaIds.length > 0) {
    const filas = await db.select({ id: clients.id, name: clients.name })
      .from(clients).where(inArray(clients.id, [...new Set(companiaIds)]));
    for (const f of filas) companias.set(f.id, f.name);
  }
  if (proveedorIds.length > 0) {
    const filas = await db.select({ id: flitoProveedoresSoat.id, nombre: flitoProveedoresSoat.nombre })
      .from(flitoProveedoresSoat).where(inArray(flitoProveedoresSoat.id, [...new Set(proveedorIds)]));
    for (const f of filas) proveedores.set(f.id, f.nombre);
  }
  return { companias, proveedores };
}
