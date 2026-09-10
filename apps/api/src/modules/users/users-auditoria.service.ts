// HU #12171 — El LECTOR del historial de cambios de usuarios, roles y permisos (CF-19, AC2).
//
// La consulta y los DTO viven aquí y no en la ruta por dos motivos: el predicado se puede probar
// contra el SQL que de verdad se ejecuta, y el fichero de rutas no crece (max-lines). No es un
// fichero de rutas: no entra en ningún inventario de guardas.
//
// ── RN-A10 en la lectura ────────────────────────────────────────────────────────────────────────
// El nombre del titular se resuelve por JOIN con `users` y el `SELECT` pide SOLO `users.username`
// (lo que el listado de usuarios ya enseña). Ni correo, ni nombre, ni documento del titular salen de
// aquí: la tabla no los guarda y la proyección no los pide. Del actor sí sale el correo: es el autor.

import { and, desc, eq, gte, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import type {
  AccionAuditable, CampoAuditable, EntidadAuditable, ItemAuditoriaPermisos, OrigenAuditoria,
  RespuestaAuditoriaPermisos, TitularAuditoria, ValorAuditable,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { permisosAuditoria, users } from '../../db/schema.js';

/** Los filtros del AC2: por usuario (titular), por recurso (entidad / rol) y por rango de fechas. */
export interface FiltrosAuditoria {
  titularUserId?: number;
  entidad?: EntidadAuditable;
  rolCodigo?: string;
  /** Rango sobre `created_at`, medio abierto `[desde, hasta)`. Ya son fechas: la ruta las validó. */
  desde?: Date;
  hasta?: Date;
}

export interface PaginacionAuditoria {
  limite: number;
  offset: number;
}

/**
 * El `WHERE` del historial, o `undefined` sin filtros. Se exporta para poder renderizarlo, pero eso
 * NO basta como prueba: el test tiene que afirmar sobre la condición que llegó a `.where()`.
 */
export function condicionesAuditoria(f: FiltrosAuditoria): SQL | undefined {
  const cs: SQL[] = [];
  const t = permisosAuditoria;
  if (f.titularUserId !== undefined) cs.push(eq(t.usuarioAfectadoId, f.titularUserId));
  if (f.entidad !== undefined) cs.push(eq(t.entidad, f.entidad));
  if (f.rolCodigo !== undefined) cs.push(eq(t.rolAfectadoCodigo, f.rolCodigo));
  if (f.desde !== undefined) cs.push(gte(t.createdAt, f.desde));
  if (f.hasta !== undefined) cs.push(lt(t.createdAt, f.hasta));
  return cs.length > 0 ? and(...cs) : undefined;
}

/** La proyección de una fila. Del titular: id, rol y el `username` del JOIN. Nada más. */
const proyeccion = {
  id: permisosAuditoria.id,
  loteId: permisosAuditoria.loteId,
  entidad: permisosAuditoria.entidad,
  accion: permisosAuditoria.accion,
  campo: permisosAuditoria.campo,
  valorAntes: permisosAuditoria.valorAntes,
  valorDespues: permisosAuditoria.valorDespues,
  usuarioAfectadoId: permisosAuditoria.usuarioAfectadoId,
  usuarioAfectadoRol: permisosAuditoria.usuarioAfectadoRol,
  titularUsername: users.username,
  rolAfectadoCodigo: permisosAuditoria.rolAfectadoCodigo,
  actorUserId: permisosAuditoria.actorUserId,
  actorEmail: permisosAuditoria.actorEmail,
  actorRol: permisosAuditoria.actorRol,
  origen: permisosAuditoria.origen,
  motivo: permisosAuditoria.motivo,
  createdAt: permisosAuditoria.createdAt,
};

type Fila = {
  id: number; loteId: string; entidad: string; accion: string; campo: string | null;
  valorAntes: unknown; valorDespues: unknown;
  usuarioAfectadoId: number | null; usuarioAfectadoRol: string | null; titularUsername: string | null;
  rolAfectadoCodigo: string | null;
  actorUserId: number | null; actorEmail: string | null; actorRol: string | null;
  origen: string; motivo: string | null; createdAt: Date;
};

/** De la fila al DTO. El titular y el rol afectado son excluyentes (CHECK `sujeto`). */
export function aItem(f: Fila): ItemAuditoriaPermisos {
  return {
    id: f.id,
    loteId: f.loteId,
    entidad: f.entidad as EntidadAuditable,
    accion: f.accion as AccionAuditable,
    campo: f.campo as CampoAuditable | null,
    valorAntes: (f.valorAntes ?? null) as ValorAuditable | null,
    valorDespues: (f.valorDespues ?? null) as ValorAuditable | null,
    titular: f.usuarioAfectadoId !== null
      ? { userId: f.usuarioAfectadoId, username: f.titularUsername, rol: f.usuarioAfectadoRol ?? '' }
      : null,
    rolAfectado: f.rolAfectadoCodigo,
    actor: { userId: f.actorUserId, email: f.actorEmail, rol: f.actorRol },
    origen: f.origen as OrigenAuditoria,
    motivo: f.motivo,
    creadoEn: f.createdAt.toISOString(),
  };
}

/**
 * El historial, del cambio más reciente al más antiguo, con `total` para paginar y `desdeCuando`
 * (la primera fila que existe, sin filtro) para que la pantalla diga dónde empieza el registro.
 *
 * Tres consultas: la página, el conteo del filtro y el mínimo global. Keyset no hace falta: la
 * tabla la escriben actos de administración, no tráfico de producto.
 */
export async function listarAuditoria(
  f: FiltrosAuditoria, p: PaginacionAuditoria,
): Promise<RespuestaAuditoriaPermisos> {
  const cond = condicionesAuditoria(f);
  const filas = await db.select(proyeccion).from(permisosAuditoria)
    .leftJoin(users, eq(permisosAuditoria.usuarioAfectadoId, users.id))
    .where(cond)
    .orderBy(desc(permisosAuditoria.createdAt), desc(permisosAuditoria.id))
    .limit(p.limite).offset(p.offset);
  const [conteo] = await db.select({ total: sql<number>`count(*)::int` }).from(permisosAuditoria).where(cond);
  const [primera] = await db.select({ desde: sql<Date | null>`min(${permisosAuditoria.createdAt})` }).from(permisosAuditoria);
  const desde = primera?.desde ?? null;
  return {
    items: (filas as Fila[]).map(aItem),
    total: Number(conteo?.total ?? 0),
    limite: p.limite,
    offset: p.offset,
    desdeCuando: desde === null ? null : new Date(desde).toISOString(),
  };
}

/**
 * La fuente del filtro «Usuario» (ficha UX §5-2): los usuarios que tienen al menos una fila como
 * TITULAR, con su `username` y nada más. Una fuente para admin y auditor, acotada a lo filtrable:
 * el auditor no puede pedir `GET /users` (censo entero, PII) y no lo necesita para esto.
 *
 * Sin paginación: la cardinalidad es «usuarios alguna vez editados», acotada por el censo.
 */
export async function titularesAuditoria(): Promise<TitularAuditoria[]> {
  // `GROUP BY` por COLUMNAS (no por literales: drizzle no deduplica literales y Postgres respondería
  // 42803). Es el DISTINCT que la consulta necesita, servido por `idx_permisos_auditoria_titular`.
  const filas = await db.select({ userId: permisosAuditoria.usuarioAfectadoId, username: users.username })
    .from(permisosAuditoria)
    .leftJoin(users, eq(permisosAuditoria.usuarioAfectadoId, users.id))
    .where(isNotNull(permisosAuditoria.usuarioAfectadoId))
    .groupBy(permisosAuditoria.usuarioAfectadoId, users.username)
    .orderBy(sql`${users.username} NULLS LAST`);
  return (filas as { userId: number | null; username: string | null }[])
    .filter((f): f is { userId: number; username: string | null } => f.userId !== null)
    .map((f) => ({ userId: f.userId, username: f.username }));
}
