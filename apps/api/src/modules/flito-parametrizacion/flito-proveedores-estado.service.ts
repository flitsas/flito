// HU #13958 (Feature #13940, Épica #13671) — Desactivar y activar un proveedor SOAT, con vista previa de su impacto.
// Módulo FLITO `flito-parametrizacion`, montado en `/api/flito/parametrizacion` (gemelo de `clients.service.ts`,
// HU #13945).
//
// Reglas que viven aquí:
//   · RN-PROV-1 — Impacto (solo lectura): `soatEnCurso` = filas de `flito_soat` con `proveedor_soat_id` = P y
//       `estado <> 'pagado'`; `companiasGestorPorDefecto` = clientes VIGENTES (`clienteVigente()`) cuyo gestor por
//       defecto de «SOAT sin trámite» es P (`clients.flito_proveedor_soat_sin_tramite_id`); `usuariosAfectados` =
//       usuarios con `flito_proveedor_soat_id` = P y sin baja lógica. `puedeEliminar`/`motivoNoEliminable` = RN-PROV-6
//       (HU #13960, `motivoNoEliminableProveedor`).
//   · RN-PROV-2 y RN-PROV-3 — RETIRADAS con `PATCH /proveedores-soat/:id/estado` (HU #14334). El cambio de estado es
//       `cambiarEstadoProveedor` (RN-PEST-1, RN-PEST-2): conserva `FOR UPDATE`, invalidar sesiones sin tocar `users.active`, y
//       limpiar la caché tras el commit.
//   · RN-PROV-4 — Login: un usuario de un proveedor inactivo o eliminado no ingresa (403, `proveedorSoatInactivo`).
//
// HU #14334 (Feature #14324, ADR-0039 §4.2) — Estado unificado de un proveedor con cualquier servicio:
//   · RN-PEST-1 (R5) — Un proveedor con compañías de Logística no se inactiva (409, RN-PLOGC-3). El que solo presta SOAT
//       sí, y uno con ambos servicios sigue la regla de Logística.
//   · RN-PEST-2 — `versionEsperada` obligatoria (edición simultánea). Inactivar invalida las sesiones de sus usuarios; la
//       ruta limpia la caché de sesión y de permisos tras el commit. Se audita dentro de la transacción.
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  SERVICIO_PROVEEDOR_LABEL, type ImpactoProveedorDto, type ProveedorListaItemDto, type ServicioProveedor,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoProveedores, flitoProveedoresLogistica, flitoProveedoresSoat, flitoSoat, users } from '../../db/schema.js';
import type { ActorAuditoria } from '../../shared/historial/permisos-auditoria.js';
import { clienteVigente } from '../clients/cliente-operable.js';
import { ProveedorLogisticaAsignadoError, companiasConProveedorLogistica } from './flito-logistica-proveedor-compania.service.js';
import { registrarAuditoriaProveedor } from './flito-proveedores-auditoria.js';
import { bloqueosDeServicio, textoDeBloqueos } from './flito-proveedores-servicios.service.js';
import {
  ProveedorNoEncontradoError, bloquearProveedorVigente, exigirVersion, itemDeProveedor, serviciosDeProveedor, type EjecutorProveedor,
} from './flito-proveedores.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** La conexión o una transacción abierta: el impacto se puede leer en cualquiera de las dos. */
export type Ejecutor = typeof db | Tx;

export class ProveedorSoatNoEncontradoError extends Error {
  constructor() { super('Proveedor SOAT no encontrado'); this.name = 'ProveedorSoatNoEncontradoError'; }
}

/** 409: otro administrador lo eliminó mientras se esperaba el bloqueo. */
export class EstadoProveedorCambiadoError extends Error {
  constructor() { super('Otro administrador ya cambió su estado'); this.name = 'EstadoProveedorCambiadoError'; }
}

export interface ImpactoProveedorSoat {
  activo: boolean;
  soatEnCurso: number;
  companiasGestorPorDefecto: { cantidad: number; nombres: string[] };
  usuariosAfectados: number;
  /** RN-PROV-6 (HU #13960): `true` solo si cumple las tres condiciones; si no, el PRIMER motivo que falla. */
  puedeEliminar: boolean;
  motivoNoEliminable: string | null;
}

export const MENSAJE_PROVEEDOR_ACTIVO = 'Primero debe desactivarlo.';

/**
 * RN-PROV-6 (HU #13960): condiciones EN ORDEN para eliminar un proveedor SOAT; el primer motivo que falla, o `null`.
 * 1) inactivo; 2) sin SOAT en curso (mismo conteo que el impacto); 3) no es el proveedor de SOAT sin trámite de
 * compañías VIGENTES (una compañía eliminada no cuenta).
 */
export function motivoNoEliminableProveedor(
  { activo, soatEnCurso, companiasGestorPorDefecto: c }:
    Pick<ImpactoProveedorSoat, 'activo' | 'soatEnCurso' | 'companiasGestorPorDefecto'>,
): string | null {
  if (activo) return MENSAJE_PROVEEDOR_ACTIVO;
  if (soatEnCurso > 0) return `Tiene ${soatEnCurso} SOAT en curso.`;
  if (c.cantidad > 0) {
    return `Es el proveedor de SOAT sin trámite de ${c.cantidad} ${c.cantidad === 1 ? 'compañía' : 'compañías'}`
      + ` (${c.nombres.join(', ')}).`;
  }
  return null;
}

const proveedorVigente = (id: string) => and(eq(flitoProveedoresSoat.id, id), isNull(flitoProveedoresSoat.deletedAt));

/** RN-PROV-1. `null` si el proveedor no existe o está eliminado. No modifica nada. */
export async function impactoProveedorSoat(tx: Ejecutor, id: string): Promise<ImpactoProveedorSoat | null> {
  const [proveedor] = await tx.select({ activo: flitoProveedoresSoat.activo }).from(flitoProveedoresSoat)
    .where(proveedorVigente(id)).limit(1);
  if (!proveedor) return null;

  const [soat, companias, usuarios] = await Promise.all([
    tx.select({ total: count() }).from(flitoSoat)
      .where(and(eq(flitoSoat.proveedorSoatId, id), ne(flitoSoat.estado, 'pagado'))),
    tx.select({ name: clients.name }).from(clients)
      .where(and(eq(clients.flitoProveedorSoatSinTramiteId, id), clienteVigente()))
      .orderBy(asc(clients.name)),
    tx.select({ total: count() }).from(users)
      .where(and(eq(users.flitoProveedorSoatId, id), isNull(users.deletedAt))),
  ]);

  const base = {
    activo: proveedor.activo,
    soatEnCurso: Number(soat[0]?.total ?? 0),
    companiasGestorPorDefecto: { cantidad: companias.length, nombres: companias.map((c) => c.name) },
    usuariosAfectados: Number(usuarios[0]?.total ?? 0),
  };
  const motivo = motivoNoEliminableProveedor(base);
  return { ...base, puedeEliminar: motivo === null, motivoNoEliminable: motivo };
}

/**
 * ADR-0039 §4.4: el primer motivo para no eliminar, o `null`. Conserva el orden y los textos de RN-PROV-6 y añade los
 * bloqueos de cualquier servicio, incluidos los de un perfil ya retirado. Lee lo confirmado: llámese tras el bloqueo.
 */
export async function motivoNoEliminableDeProveedor(exec: Ejecutor, id: string, activo: boolean): Promise<string | null> {
  if (activo) return MENSAJE_PROVEEDOR_ACTIVO;
  const soat = await impactoProveedorSoat(exec, id);
  if (soat?.motivoNoEliminable) return soat.motivoNoEliminable;
  const partes: string[] = [];
  for (const servicio of ['soat', 'logistica'] as const satisfies readonly ServicioProveedor[]) {
    const lista = await bloqueosDeServicio(exec as EjecutorProveedor, id, servicio);
    if (lista.length > 0) partes.push(`${SERVICIO_PROVEEDOR_LABEL[servicio]}: ${textoDeBloqueos(lista)}`);
  }
  return partes.length === 0 ? null : `No se puede eliminar. ${partes.join('; ')}.`;
}

/** HU #14334 AC5. Lanza 404 si no existe o está eliminado. No modifica nada. */
export async function impactoProveedor(id: string): Promise<ImpactoProveedorDto> {
  const [p] = await db.select({ activo: flitoProveedores.activo, version: flitoProveedores.version }).from(flitoProveedores)
    .where(and(eq(flitoProveedores.id, id), isNull(flitoProveedores.deletedAt))).limit(1);
  if (p === undefined) throw new ProveedorNoEncontradoError();
  const servicios = await serviciosDeProveedor(db, id);
  const bloqueosPorServicio: ImpactoProveedorDto['bloqueosPorServicio'] = {};
  for (const s of servicios) bloqueosPorServicio[s] = await bloqueosDeServicio(db, id, s);
  const [usuarios] = await db.select({ total: count() }).from(users)
    .where(and(eq(users.flitoProveedorId, id), isNull(users.deletedAt), eq(users.active, true)));
  const companias = servicios.includes('logistica') ? await companiasConProveedorLogistica(db, id) : [];
  const motivoNoInactivable = companias.length > 0 ? new ProveedorLogisticaAsignadoError(companias).message : null;
  const motivoNoEliminable = await motivoNoEliminableDeProveedor(db, id, p.activo);
  return {
    activo: p.activo,
    version: p.version,
    bloqueosPorServicio,
    sesionesAfectadas: Number(usuarios?.total ?? 0),
    puedeInactivar: motivoNoInactivable === null,
    motivoNoInactivable,
    puedeEliminar: motivoNoEliminable === null,
    motivoNoEliminable,
  };
}

export interface CambioDeEstadoUnificado { item: ProveedorListaItemDto; usuariosInvalidados: number[] }

/** RN-PEST-1, RN-PEST-2. Pedir el estado que ya tiene no escribe nada y conserva la versión. */
export async function cambiarEstadoProveedor(
  id: string, { activo, versionEsperada }: { activo: boolean; versionEsperada: number }, actor: ActorAuditoria,
): Promise<CambioDeEstadoUnificado> {
  return db.transaction(async (tx) => {
    const actual = await bloquearProveedorVigente(tx, id);
    exigirVersion(actual, versionEsperada);
    if (actual.activo === activo) return { item: await itemDeProveedor(tx, actual), usuariosInvalidados: [] };
    if (!activo) {
      // RN-PLOGC-3: la asignación toma `FOR SHARE` sobre el perfil, no sobre el padre. Sin este bloqueo, una asignación en
      // curso no se vería aquí y quedaría un proveedor inactivo con compañías.
      await tx.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
        .where(eq(flitoProveedoresLogistica.id, id)).for('update');
      const companias = await companiasConProveedorLogistica(tx, id);
      if (companias.length > 0) throw new ProveedorLogisticaAsignadoError(companias);
    }

    const [padre] = await tx.update(flitoProveedores)
      .set({ activo, updatedAt: new Date(), version: actual.version + 1 }).where(eq(flitoProveedores.id, id)).returning();
    let usuariosInvalidados: number[] = [];
    if (!activo) {
      const invalidados = await tx.update(users).set({ sessionInvalidatedAt: sql`now()` })
        .where(eq(users.flitoProveedorId, id)).returning({ id: users.id });
      usuariosInvalidados = invalidados.map((u) => u.id);
    }
    await registrarAuditoriaProveedor(tx, id, actor.userId, [{
      accion: activo ? 'activar' : 'desactivar', campo: 'activo', antes: String(actual.activo), despues: String(activo),
    }]);
    return { item: await itemDeProveedor(tx, padre!), usuariosInvalidados };
  });
}

/** Login (HU #13958 AC3): ¿el proveedor SOAT del usuario está inactivo o eliminado? `false` si no tiene proveedor. */
export async function proveedorSoatInactivo(proveedorId: string | null | undefined): Promise<boolean> {
  if (proveedorId == null) return false;
  const [fila] = await db.select({ activo: flitoProveedoresSoat.activo, deletedAt: flitoProveedoresSoat.deletedAt })
    .from(flitoProveedoresSoat).where(eq(flitoProveedoresSoat.id, proveedorId)).limit(1);
  return fila !== undefined && (!fila.activo || fila.deletedAt !== null);
}

// ── HU #13959 — Un proveedor inactivo o eliminado no se puede elegir como destino ─────────────────────────────────
//   · RN-PROV-5 — Envío de SOAT (`POST /flito/soat/enviar`, 409) y gestor por defecto de la compañía
//       (`PATCH /flito/parametrizacion/companias/:id`, 400) comprueban el proveedor DENTRO de su transacción con
//       `SELECT … FOR SHARE`: el cambio de estado (RN-PROV-2) toma `FOR UPDATE` sobre la misma fila, así que una
//       desactivación en curso hace esperar a la asignación, y esta relee el estado ya confirmado (AC6). Leerlo sin
//       bloqueo (READ COMMITTED) vería aún `activo = true` y dejaría aplicados los dos cambios.

export const MENSAJE_PROVEEDOR_NO_EXISTE = 'El gestor seleccionado no existe o fue eliminado.';
export const mensajeProveedorInactivo = (nombre: string): string => `El gestor ${nombre} está inactivo: elige otro gestor.`;

/** El proveedor elegido como destino no se puede usar. La ruta decide el status (409 envío, 400 compañía). */
export class ProveedorSoatNoUsableError extends Error {
  constructor(message: string, readonly motivo: 'inactivo' | 'no_existe') {
    super(message); this.name = 'ProveedorSoatNoUsableError';
  }
}

/** RN-PROV-5. Debe llamarse con la transacción que escribe: el `FOR SHARE` dura hasta su commit. */
export async function exigirProveedorSoatUsable(tx: Tx, id: string): Promise<void> {
  const [p] = await tx.select({
    nombre: flitoProveedoresSoat.nombre, activo: flitoProveedoresSoat.activo, deletedAt: flitoProveedoresSoat.deletedAt,
  }).from(flitoProveedoresSoat).where(eq(flitoProveedoresSoat.id, id)).for('share').limit(1);
  if (!p || p.deletedAt != null) throw new ProveedorSoatNoUsableError(MENSAJE_PROVEEDOR_NO_EXISTE, 'no_existe');
  if (!p.activo) throw new ProveedorSoatNoUsableError(mensajeProveedorInactivo(p.nombre), 'inactivo');
}
