// HU #13958 (Feature #13940, Épica #13671) — Desactivar y activar un proveedor SOAT, con vista previa de su impacto.
// Módulo FLITO `flito-parametrizacion`, montado en `/api/flito/parametrizacion` (gemelo de `clients.service.ts`,
// HU #13945).
//
// Reglas que viven aquí:
//   · RN-PROV-1 — Impacto (solo lectura): `soatEnCurso` = filas de `flito_soat` con `proveedor_soat_id` = P y
//       `estado <> 'pagado'`; `companiasGestorPorDefecto` = clientes VIGENTES (`clienteVigente()`) cuyo gestor por
//       defecto de «SOAT sin trámite» es P (`clients.flito_proveedor_soat_sin_tramite_id`); `usuariosAfectados` =
//       usuarios con `flito_proveedor_soat_id` = P y sin baja lógica. `puedeEliminar`/`motivoNoEliminable` van neutros
//       (`false`/`null`): las condiciones de la baja las define otra HU.
//   · RN-PROV-2 — Cambio de estado en UNA transacción con `SELECT … FOR UPDATE` sobre la fila del proveedor: inexistente
//       o eliminado (`deleted_at`, 0259) → 404; `activo` distinto de `activoEsperado` → 409 (otro administrador se
//       adelantó; la segunda petición espera el bloqueo y lee el estado ya cambiado).
//   · RN-PROV-3 — Desactivar invalida, en la MISMA transacción, las sesiones de los usuarios del proveedor
//       (`session_invalidated_at = now()`); `users.active` NO se toca (un usuario inactivo por su cuenta lo sigue estando
//       al reactivar). La caché de sesión se limpia DESPUÉS del commit (la ruta). Activar solo pone `activo = true`.
//   · RN-PROV-4 — Login: un usuario de un proveedor inactivo o eliminado no ingresa (403, `proveedorSoatInactivo`).
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoProveedoresSoat, flitoSoat, users } from '../../db/schema.js';
import { clienteVigente } from '../clients/cliente-operable.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** La conexión o una transacción abierta: el impacto se puede leer en cualquiera de las dos. */
export type Ejecutor = typeof db | Tx;

export class ProveedorSoatNoEncontradoError extends Error {
  constructor() { super('Proveedor SOAT no encontrado'); this.name = 'ProveedorSoatNoEncontradoError'; }
}

/** 409: el proveedor existe pero su estado ya no es el que el administrador vio (RN-PROV-2). */
export class EstadoProveedorCambiadoError extends Error {
  constructor() { super('Otro administrador ya cambió su estado'); this.name = 'EstadoProveedorCambiadoError'; }
}

/** El PATCH general rechaza `activo` (HU #13958 AC5): el estado solo se cambia con `PATCH /:id/estado`. */
export const MENSAJE_ESTADO_POR_ACCION = 'El estado del proveedor se cambia con Activar o Desactivar.';

export interface ImpactoProveedorSoat {
  activo: boolean;
  soatEnCurso: number;
  companiasGestorPorDefecto: { cantidad: number; nombres: string[] };
  usuariosAfectados: number;
  /** Neutros en esta HU: las condiciones de la baja las completa otra HU. */
  puedeEliminar: boolean;
  motivoNoEliminable: string | null;
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

  return {
    activo: proveedor.activo,
    soatEnCurso: Number(soat[0]?.total ?? 0),
    companiasGestorPorDefecto: { cantidad: companias.length, nombres: companias.map((c) => c.name) },
    usuariosAfectados: Number(usuarios[0]?.total ?? 0),
    puedeEliminar: false,
    motivoNoEliminable: null,
  };
}

export interface CambioDeEstadoProveedor {
  id: string;
  nombre: string;
  activo: boolean;
  /** Usuarios cuya sesión se invalidó (solo al desactivar): la ruta limpia su caché tras el commit. */
  usuariosInvalidados: number[];
}

/** RN-PROV-2/3. Lanza `ProveedorSoatNoEncontradoError` (404) o `EstadoProveedorCambiadoError` (409). */
export async function cambiarEstadoProveedorSoat(
  id: string, { activo, activoEsperado }: { activo: boolean; activoEsperado: boolean },
): Promise<CambioDeEstadoProveedor> {
  return db.transaction(async (tx) => {
    const [actual] = await tx.select({ activo: flitoProveedoresSoat.activo }).from(flitoProveedoresSoat)
      .where(proveedorVigente(id)).for('update').limit(1);
    if (!actual) throw new ProveedorSoatNoEncontradoError();
    if (actual.activo !== activoEsperado) throw new EstadoProveedorCambiadoError();

    const [fila] = await tx.update(flitoProveedoresSoat).set({ activo }).where(eq(flitoProveedoresSoat.id, id))
      .returning({ id: flitoProveedoresSoat.id, nombre: flitoProveedoresSoat.nombre, activo: flitoProveedoresSoat.activo });

    let usuariosInvalidados: number[] = [];
    if (!activo) {
      const invalidados = await tx.update(users).set({ sessionInvalidatedAt: sql`now()` })
        .where(eq(users.flitoProveedorSoatId, id)).returning({ id: users.id });
      usuariosInvalidados = invalidados.map((u) => u.id);
    }
    return { ...fila, usuariosInvalidados };
  });
}

/** Login (HU #13958 AC3): ¿el proveedor SOAT del usuario está inactivo o eliminado? `false` si no tiene proveedor. */
export async function proveedorSoatInactivo(proveedorId: string | null | undefined): Promise<boolean> {
  if (proveedorId == null) return false;
  const [fila] = await db.select({ activo: flitoProveedoresSoat.activo, deletedAt: flitoProveedoresSoat.deletedAt })
    .from(flitoProveedoresSoat).where(eq(flitoProveedoresSoat.id, proveedorId)).limit(1);
  return fila !== undefined && (!fila.activo || fila.deletedAt !== null);
}
