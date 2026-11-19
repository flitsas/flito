// Vistas de columnas persistidas (ADR-0045). Servicio GENÉRICO: no sabe de Gestión Trámites; el
// catálogo de la tabla (`TablaVistas`) llega como argumento desde la ruta.
//
// Reglas de negocio (RN-VC):
//   RN-VC1  Resolución de la vista activa: puntero personal → general → sistema (ver `reglas.ts`).
//   RN-VC2  Lectura: columnas efectivas = vista ∩ permitidas. El cliente no decide qué ve.
//   RN-VC3  Guardar una clave no permitida → COLUMNA_NO_PERMITIDA (403), nunca descarte silencioso.
//   RN-VC5  Propiedad: vista personal solo la edita y borra su dueño; compartida solo un admin.
//           Una vista personal ajena responde 404 (no revela que existe).
//   RN-VC6  Punteros: personal → solo vistas personales del MISMO usuario; general → solo compartidas.
//           Lo valida este servicio (la base no puede expresarlo con un CHECK entre tablas).
//   RN-VC7  Borrar una vista cascadea sus punteros (FK ON DELETE CASCADE): quien la tenía como
//           predeterminada cae a la general, o al sistema si la general no existe.
//   RN-VC8  Borrar un usuario (físico) cascadea sus vistas personales y su puntero; las compartidas
//           se conservan (creado_por pasa a NULL). Lo hace la base, no este servicio.
//   RN-VC9  Límites: 30 claves por vista, 20 vistas personales por usuario y tabla, nombre 1–60.
//   RN-VC10 Auditoría: las mutaciones van por `audit()` en la ruta, con CLAVES de columna; nunca el
//           nombre de la vista ni valores de datos del titular.
import { and, count, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoVistasColumnas, flitoVistasColumnasPreferencias } from '../../db/schema.js';
import type { RespuestaVistasColumnas } from '@operaciones/shared-types';
import { LIMITES_VISTAS_COLUMNAS } from '@operaciones/shared-types';
import type { TablaVistas } from './flito-vistas-columnas.catalogo.js';
import {
  clavesRechazadas, columnasEfectivas, MAX_VISTAS_PERSONALES, resolverVistaActiva,
} from './flito-vistas-columnas.reglas.js';

// ── Errores de dominio ───────────────────────────────────────────────────────────────────────────
export class VistasColumnasError extends Error {
  constructor(message: string, readonly status: number, readonly codigo: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class VistaNoEncontradaError extends VistasColumnasError {
  constructor() { super('La vista no existe', 404, 'VISTA_NO_ENCONTRADA'); }
}
export class ColumnaNoPermitidaError extends VistasColumnasError {
  constructor(readonly claves: string[]) { super('Hay columnas que no puede ver', 403, 'COLUMNA_NO_PERMITIDA'); }
}
export class ClaveDesconocidaError extends VistasColumnasError {
  constructor(readonly claves: string[]) { super('Hay columnas que no existen en la tabla', 422, 'CLAVE_DESCONOCIDA'); }
}
export class AlcanceNoPermitidoError extends VistasColumnasError {
  constructor() { super('Solo un administrador gestiona vistas compartidas', 403, 'ALCANCE_NO_PERMITIDO'); }
}
export class NombreDuplicadoError extends VistasColumnasError {
  constructor() { super('Ya existe una vista con ese nombre', 409, 'NOMBRE_DUPLICADO'); }
}
export class LimiteVistasError extends VistasColumnasError {
  constructor() { super(`Ya tiene el máximo de ${MAX_VISTAS_PERSONALES} vistas en esta tabla`, 409, 'LIMITE_VISTAS'); }
}
export class VersionConflictoError extends VistasColumnasError {
  constructor() { super('La vista cambió mientras la editaba. Recargue e intente de nuevo', 409, 'VERSION_CONFLICTO'); }
}
export class VistaNoCompartidaError extends VistasColumnasError {
  constructor() { super('La predeterminada general debe ser una vista compartida', 422, 'VISTA_NO_COMPARTIDA'); }
}

// ── Tipos ────────────────────────────────────────────────────────────────────────────────────────
/**
 * Quién actúa. `puedeAdministrar` = tiene `tramites.vistas_columnas.administrar` (la consulta la ruta con
 * `tieneFuncion`; ADR-0045: solo `admin` la recibe por defecto). Nunca el nombre del rol (HU #13425 AC6).
 */
export interface ActorVistas {
  userId: number;
  puedeAdministrar: boolean;
}

type FilaVista = typeof flitoVistasColumnas.$inferSelect;

// ── Helpers internos ─────────────────────────────────────────────────────────────────────────────
/** Unique violation de Postgres (23505), venga envuelta por Drizzle o no. */
function esViolacionUnica(e: unknown): boolean {
  const directo = (e as { code?: unknown })?.code;
  const envuelto = (e as { cause?: { code?: unknown } })?.cause?.code;
  return directo === '23505' || envuelto === '23505';
}

/** RN-VC3 y RN-VC4 de `reglas.ts`: valida las claves contra el catálogo y los permisos. */
function validarClaves(tabla: TablaVistas, permitidas: ReadonlySet<string>, claves: string[]): void {
  const { desconocidas, noPermitidas } = clavesRechazadas(claves, tabla.columnas, permitidas);
  if (desconocidas.length > 0) throw new ClaveDesconocidaError(desconocidas);
  if (noPermitidas.length > 0) throw new ColumnaNoPermitidaError(noPermitidas);
}

/** Vista que el actor puede EDITAR/BORRAR (RN-VC5). Ajena o inexistente → 404. */
async function cargarEditable(tabla: TablaVistas, actor: ActorVistas, vistaId: number): Promise<FilaVista> {
  const [fila] = await db.select().from(flitoVistasColumnas)
    .where(and(eq(flitoVistasColumnas.id, vistaId), eq(flitoVistasColumnas.tablaId, tabla.tablaId)))
    .limit(1);
  if (!fila) throw new VistaNoEncontradaError();
  if (fila.alcance === 'personal') {
    if (fila.ownerUserId !== actor.userId) throw new VistaNoEncontradaError();
    return fila;
  }
  if (!actor.puedeAdministrar) throw new AlcanceNoPermitidoError();
  return fila;
}

// ── Lectura ──────────────────────────────────────────────────────────────────────────────────────
export async function listarVistas(
  tabla: TablaVistas,
  actor: ActorVistas,
  permitidas: ReadonlySet<string>,
): Promise<RespuestaVistasColumnas> {
  const [vistas, punteros] = await Promise.all([
    db.select().from(flitoVistasColumnas)
      .where(and(
        eq(flitoVistasColumnas.tablaId, tabla.tablaId),
        or(eq(flitoVistasColumnas.alcance, 'compartida'), eq(flitoVistasColumnas.ownerUserId, actor.userId)),
      ))
      .orderBy(flitoVistasColumnas.nombre),
    db.select().from(flitoVistasColumnasPreferencias)
      .where(and(
        eq(flitoVistasColumnasPreferencias.tablaId, tabla.tablaId),
        or(eq(flitoVistasColumnasPreferencias.userId, actor.userId), isNull(flitoVistasColumnasPreferencias.userId)),
      )),
  ]);

  const personal = punteros.find((p) => p.userId === actor.userId);
  const general = punteros.find((p) => p.userId === null);
  const idsPersonales = new Set(vistas.filter((v) => v.alcance === 'personal').map((v) => v.id));
  const idsCompartidas = new Set(vistas.filter((v) => v.alcance === 'compartida').map((v) => v.id));
  const activa = resolverVistaActiva(personal, general, idsPersonales, idsCompartidas);
  const sistema = columnasEfectivas(tabla.columnasSistema, tabla.columnas, permitidas);
  const vistaActiva = activa.vistaId === null ? undefined : vistas.find((v) => v.id === activa.vistaId);

  return {
    tablaId: tabla.tablaId,
    columnasDisponibles: tabla.columnas
      .filter((c) => !c.funcion || permitidas.has(c.funcion))
      .map(({ clave, etiqueta, fija }) => ({ clave, etiqueta, fija })),
    vistaActiva: {
      id: activa.vistaId,
      origen: activa.origen,
      columnas: vistaActiva
        ? columnasEfectivas(vistaActiva.columnas, tabla.columnas, permitidas)
        : sistema,
    },
    sistema: { columnas: sistema },
    vistas: vistas.map((v) => ({
      id: v.id,
      nombre: v.nombre,
      alcance: v.alcance as 'personal' | 'compartida',
      esPredeterminada: v.alcance === 'personal'
        ? Boolean(personal && personal.vistaId === v.id)
        : Boolean(general && general.vistaId === v.id),
      puedeEditar: v.alcance === 'personal' ? v.ownerUserId === actor.userId : actor.puedeAdministrar,
      version: v.version,
      columnas: columnasEfectivas(v.columnas, tabla.columnas, permitidas),
    })),
    limites: LIMITES_VISTAS_COLUMNAS,
  };
}

// ── Escritura de vistas ──────────────────────────────────────────────────────────────────────────
export async function crearVista(
  tabla: TablaVistas,
  actor: ActorVistas,
  permitidas: ReadonlySet<string>,
  entrada: { nombre: string; alcance: 'personal' | 'compartida'; columnas: string[] },
): Promise<{ id: number; version: number }> {
  if (entrada.alcance === 'compartida' && !actor.puedeAdministrar) throw new AlcanceNoPermitidoError();
  validarClaves(tabla, permitidas, entrada.columnas);
  const ownerUserId = entrada.alcance === 'personal' ? actor.userId : null;

  return db.transaction(async (tx) => {
    if (ownerUserId !== null) {
      // Serializa la cuenta de vistas personales de este usuario y tabla (RN-VC9) sin índice extra.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vistas:${tabla.tablaId}:${actor.userId}`}))`);
      const [{ n }] = await tx.select({ n: count() }).from(flitoVistasColumnas)
        .where(and(
          eq(flitoVistasColumnas.tablaId, tabla.tablaId),
          eq(flitoVistasColumnas.alcance, 'personal'),
          eq(flitoVistasColumnas.ownerUserId, actor.userId),
        ));
      if (Number(n) >= MAX_VISTAS_PERSONALES) throw new LimiteVistasError();
    }
    try {
      const [fila] = await tx.insert(flitoVistasColumnas).values({
        tablaId: tabla.tablaId,
        alcance: entrada.alcance,
        ownerUserId,
        nombre: entrada.nombre,
        columnas: entrada.columnas,
        creadoPorUserId: actor.userId,
      }).returning({ id: flitoVistasColumnas.id, version: flitoVistasColumnas.version });
      return fila;
    } catch (e) {
      if (esViolacionUnica(e)) throw new NombreDuplicadoError();
      throw e;
    }
  });
}

export async function actualizarVista(
  tabla: TablaVistas,
  actor: ActorVistas,
  permitidas: ReadonlySet<string>,
  vistaId: number,
  entrada: { nombre?: string; columnas?: string[]; version: number },
): Promise<{ version: number }> {
  await cargarEditable(tabla, actor, vistaId);
  if (entrada.columnas) validarClaves(tabla, permitidas, entrada.columnas);

  const cambios = {
    updatedAt: new Date(),
    version: sql`${flitoVistasColumnas.version} + 1`,
    ...(entrada.nombre !== undefined ? { nombre: entrada.nombre } : {}),
    ...(entrada.columnas !== undefined ? { columnas: entrada.columnas } : {}),
  };

  try {
    const [fila] = await db.update(flitoVistasColumnas)
      .set(cambios)
      .where(and(eq(flitoVistasColumnas.id, vistaId), eq(flitoVistasColumnas.version, entrada.version)))
      .returning({ version: flitoVistasColumnas.version });
    if (!fila) throw new VersionConflictoError(); // la fila existe (cargarEditable) pero la versión no coincide
    return { version: fila.version };
  } catch (e) {
    if (esViolacionUnica(e)) throw new NombreDuplicadoError();
    throw e;
  }
}

/** Borra la vista. Sus punteros caen por CASCADE (RN-VC7). */
export async function borrarVista(tabla: TablaVistas, actor: ActorVistas, vistaId: number): Promise<void> {
  await cargarEditable(tabla, actor, vistaId);
  await db.delete(flitoVistasColumnas).where(eq(flitoVistasColumnas.id, vistaId));
}

// ── Punteros predeterminados ─────────────────────────────────────────────────────────────────────
/**
 * Predeterminada PERSONAL. `null` = restablecer: puntero a sistema explícito, que gana sobre la general.
 * No borra vistas (el restablecer es solo un puntero).
 */
export async function fijarPredeterminadaPersonal(
  tabla: TablaVistas,
  actor: ActorVistas,
  vistaId: number | null,
): Promise<void> {
  if (vistaId !== null) {
    const [fila] = await db.select({ alcance: flitoVistasColumnas.alcance, owner: flitoVistasColumnas.ownerUserId })
      .from(flitoVistasColumnas)
      .where(and(eq(flitoVistasColumnas.id, vistaId), eq(flitoVistasColumnas.tablaId, tabla.tablaId)))
      .limit(1);
    // RN-VC6: solo una vista personal del propio usuario.
    if (!fila || fila.alcance !== 'personal' || fila.owner !== actor.userId) throw new VistaNoEncontradaError();
  }
  await db.insert(flitoVistasColumnasPreferencias)
    .values({ tablaId: tabla.tablaId, userId: actor.userId, vistaId })
    .onConflictDoUpdate({
      target: [flitoVistasColumnasPreferencias.tablaId, flitoVistasColumnasPreferencias.userId],
      targetWhere: sql`user_id IS NOT NULL`,
      set: { vistaId, updatedAt: new Date() },
    });
}

/** Predeterminada GENERAL (solo admin). `null` = quitar la general: vuelve el sistema. */
export async function fijarPredeterminadaGeneral(
  tabla: TablaVistas,
  actor: ActorVistas,
  vistaId: number | null,
): Promise<void> {
  if (!actor.puedeAdministrar) throw new AlcanceNoPermitidoError();
  if (vistaId !== null) {
    const [fila] = await db.select({ alcance: flitoVistasColumnas.alcance })
      .from(flitoVistasColumnas)
      .where(and(eq(flitoVistasColumnas.id, vistaId), eq(flitoVistasColumnas.tablaId, tabla.tablaId)))
      .limit(1);
    if (!fila) throw new VistaNoEncontradaError();
    // RN-VC6: el puntero general solo admite vistas compartidas.
    if (fila.alcance !== 'compartida') throw new VistaNoCompartidaError();
  }
  await db.insert(flitoVistasColumnasPreferencias)
    .values({ tablaId: tabla.tablaId, userId: null, vistaId })
    .onConflictDoUpdate({
      target: [flitoVistasColumnasPreferencias.tablaId],
      targetWhere: sql`user_id IS NULL`,
      set: { vistaId, updatedAt: new Date() },
    });
}
