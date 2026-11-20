// HU #13960 (Feature #13940, Épica #13671) — Eliminar un proveedor SOAT inactivo, sin SOAT en curso ni compañías
// asignadas. Módulo FLITO `flito-parametrizacion`, montado en `/api/flito/parametrizacion` (gemelo de `eliminarCliente`,
// HU #13954).
//
// Reglas que viven aquí:
//   · RN-PROV-6 — Eliminar = baja LÓGICA (`deleted_at`/`deleted_by` de la 0259), nunca DELETE. Condiciones EN ORDEN
//       (`motivoNoEliminableProveedor`, la misma que alimenta el impacto): 1) inactivo; 2) sin SOAT en curso; 3) no es
//       el proveedor de SOAT sin trámite de compañías VIGENTES. Una sola transacción con `SELECT … FOR UPDATE` sobre la
//       fila del proveedor; las condiciones se evalúan DESPUÉS del bloqueo. Inexistente o ya eliminado (confirmado antes
//       de la petición) → 404; eliminado por otro administrador mientras se esperaba el bloqueo → 409
//       `EstadoProveedorCambiadoError` («Otro administrador ya cambió su estado»).
//   · RN-PROV-7 — Sus usuarios (sin baja lógica) quedan `active = false` con `session_invalidated_at`, dentro de
//       `conSeguroAntiBloqueo` y con su rastro en la bitácora de permisos (uno por usuario que estaba activo). NO se les
//       da de baja: el administrador puede reasignarlos a otro proveedor y reactivarlos (RN-PROV-8, `users.service.ts`).
//       La caché de sesión se limpia DESPUÉS del commit (la ruta). `flito_reglas_proveedor_soat` no se toca.
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoProveedoresSoat, users } from '../../db/schema.js';
import { conSeguroAntiBloqueo } from '../../shared/permisos-anti-bloqueo.js';
import { registrarCambiosPermisos, type ActorAuditoria } from '../../shared/historial/permisos-auditoria.js';
import {
  EstadoProveedorCambiadoError, ProveedorSoatNoEncontradoError, impactoProveedorSoat,
} from './flito-proveedores-estado.service.js';

/** RN-PROV-6: 409 — el proveedor no cumple una condición para eliminarlo. `message` es el texto del AC. */
export class ProveedorSoatNoEliminableError extends Error {
  constructor(message: string) { super(message); this.name = 'ProveedorSoatNoEliminableError'; }
}

export interface ProveedorSoatEliminado {
  id: string;
  nombre: string;
  /** Usuarios desactivados con la sesión invalidada: la ruta limpia su caché tras el commit. */
  usuariosDesactivados: number[];
}

/**
 * RN-PROV-6/7. Lanza `ProveedorSoatNoEncontradoError` (404), `EstadoProveedorCambiadoError` (409),
 * `ProveedorSoatNoEliminableError` (409) o `BloqueoAdministracionError` (409).
 */
export async function eliminarProveedorSoat(id: string, actor: ActorAuditoria): Promise<ProveedorSoatEliminado> {
  return db.transaction(async (tx) => {
    // Lectura SIN bloqueo: lo ya eliminado (confirmado) antes de esta petición es 404, como lo inexistente.
    const [vigente] = await tx.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat)
      .where(and(eq(flitoProveedoresSoat.id, id), isNull(flitoProveedoresSoat.deletedAt))).limit(1);
    if (!vigente) throw new ProveedorSoatNoEncontradoError();

    // Bloqueo SIN filtrar por `deleted_at`: si otro administrador lo eliminó mientras esperábamos, la fila vuelve con
    // su `deleted_at` y eso es la carrera (409), no un 404 (AC9).
    const [proveedor] = await tx.select({ nombre: flitoProveedoresSoat.nombre, deletedAt: flitoProveedoresSoat.deletedAt })
      .from(flitoProveedoresSoat).where(eq(flitoProveedoresSoat.id, id)).limit(1).for('update');
    if (!proveedor) throw new ProveedorSoatNoEncontradoError();
    if (proveedor.deletedAt != null) throw new EstadoProveedorCambiadoError();

    // Las condiciones, DESPUÉS del bloqueo: ven lo confirmado hasta aquí.
    const impacto = await impactoProveedorSoat(tx, id);
    if (!impacto) throw new ProveedorSoatNoEncontradoError();
    if (impacto.motivoNoEliminable !== null) throw new ProveedorSoatNoEliminableError(impacto.motivoNoEliminable);

    const ahora = new Date();
    const delProveedor = and(eq(users.flitoProveedorSoatId, id), isNull(users.deletedAt));
    const antes = await tx.select({ id: users.id, role: users.role, active: users.active }).from(users)
      .where(delProveedor);
    const desactivados = await conSeguroAntiBloqueo(tx, async () => {
      await tx.update(flitoProveedoresSoat).set({ deletedAt: ahora, deletedBy: actor.userId })
        .where(eq(flitoProveedoresSoat.id, id));
      return tx.update(users).set({ active: false, sessionInvalidatedAt: ahora }).where(delProveedor)
        .returning({ id: users.id });
    });
    // Mismo rastro que la desactivación individual (`cambiarActivo`), solo para quien estaba activo.
    await registrarCambiosPermisos(tx, actor, antes.filter((u) => u.active).map((u) => ({
      entidad: 'usuario' as const, accion: 'desactivar' as const, campo: 'active' as const,
      valorAntes: true, valorDespues: false, usuarioAfectado: { id: u.id, rol: u.role },
    })));
    return { id, nombre: proveedor.nombre, usuariosDesactivados: desactivados.map((u) => u.id) };
  });
}
