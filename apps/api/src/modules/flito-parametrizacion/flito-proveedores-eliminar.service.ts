// HU #13960 (Feature #13940, Épica #13671) — Eliminar un proveedor. Módulo FLITO `flito-parametrizacion`.
//
// Reglas que viven aquí:
//   · RN-PROV-6 — Eliminar = baja LÓGICA, nunca DELETE. Condiciones EN ORDEN (`motivoNoEliminableDeProveedor`). Una sola
//       transacción con `SELECT … FOR UPDATE`, y las condiciones se evalúan DESPUÉS del bloqueo. Inexistente o ya eliminado
//       (confirmado antes de la petición) → 404; eliminado por otro administrador mientras se esperaba → 409.
//   · RN-PROV-7 — Sus usuarios (sin baja lógica) quedan `active = false` con `session_invalidated_at`, dentro de
//       `conSeguroAntiBloqueo` y con su rastro en la bitácora de permisos (uno por usuario que estaba activo). NO se les
//       da de baja: el administrador puede reasignarlos a otro proveedor y reactivarlos (RN-PROV-8, `users.service.ts`).
//       La caché de sesión se limpia DESPUÉS del commit (la ruta).
//
// HU #14334 (Feature #14324, ADR-0039 §3 y §4.4) — Eliminar unificado para cualquier servicio, y único camino de baja:
//   · RN-PELIM-1 — Unifica RN-PROV-6/7 y retira el DELETE físico de Logística (RN-PROVU-3): inactivo, sin bloqueos de ningún
//       servicio y sin compañías. Las reglas de enrutamiento ahora sí impiden eliminar (R4).
//   · RN-PELIM-2 — Padre y perfiles en UNA transacción, PRIMERO el padre y bloqueándolo con `FOR UPDATE` antes de comprobar
//       nada: dos bajas simultáneas no pueden dejarlo vigente y sin perfiles. Se vacían NIT, teléfono, correo, dirección y
//       contacto del padre, y su trigger vacía los del perfil de Logística vigente (ADR-0039 §16.8b). Nombre y NIT quedan libres.
//   · RN-PELIM-3 — Se audita dentro de la transacción. `flito_reglas_proveedor_soat` no se toca: si tiene reglas no llega aquí.
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoProveedores, flitoProveedoresLogistica, flitoProveedoresSoat, users } from '../../db/schema.js';
import { conSeguroAntiBloqueo } from '../../shared/permisos-anti-bloqueo.js';
import { registrarCambiosPermisos, type ActorAuditoria } from '../../shared/historial/permisos-auditoria.js';
import { registrarAuditoriaProveedor } from './flito-proveedores-auditoria.js';
import {
  EstadoProveedorCambiadoError, motivoNoEliminableDeProveedor,
} from './flito-proveedores-estado.service.js';
import { ProveedorNoEncontradoError } from './flito-proveedores.service.js';

/** RN-PROV-6: 409 — el proveedor no cumple una condición para eliminarlo. `message` es el texto del AC. */
export class ProveedorNoEliminableError extends Error {
  constructor(message: string) { super(message); this.name = 'ProveedorNoEliminableError'; }
}

export interface ProveedorEliminado {
  id: string;
  nombre: string;
  /** Usuarios desactivados con la sesión invalidada: la ruta limpia su caché tras el commit. */
  usuariosDesactivados: number[];
}

/**
 * RN-PELIM-1 a RN-PELIM-3. Lanza `ProveedorNoEncontradoError` (404), `EstadoProveedorCambiadoError` (409),
 * `ProveedorNoEliminableError` (409) o `BloqueoAdministracionError` (409).
 */
export async function eliminarProveedor(id: string, actor: ActorAuditoria): Promise<ProveedorEliminado> {
  return db.transaction(async (tx) => {
    // Lectura SIN bloqueo: lo ya eliminado (confirmado) antes de esta petición es 404, como lo inexistente.
    const [vigente] = await tx.select({ id: flitoProveedores.id }).from(flitoProveedores)
      .where(and(eq(flitoProveedores.id, id), isNull(flitoProveedores.deletedAt))).limit(1);
    if (!vigente) throw new ProveedorNoEncontradoError();

    // Bloqueo SIN filtrar por `deleted_at`: si otro administrador lo eliminó mientras esperábamos, la fila vuelve con
    // su `deleted_at` y eso es la carrera (409), no un 404.
    const [proveedor] = await tx.select({ nombre: flitoProveedores.nombre, activo: flitoProveedores.activo, deletedAt: flitoProveedores.deletedAt, version: flitoProveedores.version })
      .from(flitoProveedores).where(eq(flitoProveedores.id, id)).limit(1).for('update');
    if (!proveedor) throw new ProveedorNoEncontradoError();
    if (proveedor.deletedAt != null) throw new EstadoProveedorCambiadoError();

    // Las condiciones, DESPUÉS del bloqueo: ven lo confirmado hasta aquí.
    const motivo = await motivoNoEliminableDeProveedor(tx, id, proveedor.activo);
    if (motivo !== null) throw new ProveedorNoEliminableError(motivo);

    const ahora = new Date();
    const delProveedor = and(eq(users.flitoProveedorId, id), isNull(users.deletedAt));
    const antes = await tx.select({ id: users.id, role: users.role, active: users.active }).from(users).where(delProveedor);
    const desactivados = await conSeguroAntiBloqueo(tx, async () => {
      await tx.update(flitoProveedores).set({
        deletedAt: ahora, deletedBy: actor.userId, nit: null, telefono: null, correo: null, direccion: null, contacto: null,
        updatedAt: ahora, version: proveedor.version + 1,
      }).where(eq(flitoProveedores.id, id));
      await tx.update(flitoProveedoresSoat).set({ deletedAt: ahora, deletedBy: actor.userId })
        .where(and(eq(flitoProveedoresSoat.id, id), isNull(flitoProveedoresSoat.deletedAt)));
      await tx.update(flitoProveedoresLogistica).set({ deletedAt: ahora, deletedBy: actor.userId })
        .where(and(eq(flitoProveedoresLogistica.id, id), isNull(flitoProveedoresLogistica.deletedAt)));
      return tx.update(users).set({ active: false, sessionInvalidatedAt: ahora }).where(delProveedor)
        .returning({ id: users.id });
    });
    await registrarAuditoriaProveedor(tx, id, actor.userId, [{ accion: 'eliminar' }]);
    // Mismo rastro que la desactivación individual (`cambiarActivo`), solo para quien estaba activo.
    await registrarCambiosPermisos(tx, actor, antes.filter((u) => u.active).map((u) => ({
      entidad: 'usuario' as const, accion: 'desactivar' as const, campo: 'active' as const,
      valorAntes: true, valorDespues: false, usuarioAfectado: { id: u.id, rol: u.role },
    })));
    return { id, nombre: proveedor.nombre, usuariosDesactivados: desactivados.map((u) => u.id) };
  });
}
