// HU #13945 (Feature #13939, Épica #13671) — Desactivar y activar un cliente, con vista previa de su impacto.
// Módulo LEGACY `clients` (sin prefijo `flito-`), montado en `/api/clients`.
//
// Reglas que viven aquí:
//   · RN-CLI-1 — Impacto (solo lectura): procesos ABIERTOS de la compañía en los módulos FLITO, por `compania_id`:
//       SOAT con `estado <> 'pagado'`; impuestos con `estado <> 'pagado'`; trámites con `estado = 'asignado'` (NULL no
//       cuenta); liquidaciones con `estado = 'liquidado'` de trámites de la compañía. Las tablas legacy `tramites`/`soat`,
//       comparendos, derechos y actas de logística NO cuentan. Saldo = el de la bolsa única (`flito_bolsas`,
//       `compania_id UNIQUE`; sin bolsa → 0). `usuariosAfectados` = usuarios con esa compañía y sin baja lógica.
//   · RN-CLI-2 — Cambio de estado OPTIMISTA: `UPDATE … WHERE id = :id AND active = :activoEsperado`. 0 filas → el
//       cliente no existe (404) o ya tiene otro estado (409, otro administrador se adelantó).
//   · RN-CLI-3 — Desactivar invalida, en la MISMA transacción, las sesiones de los usuarios de la compañía
//       (`session_invalidated_at = now()`); `users.active` NO se toca (un usuario inactivo por su cuenta lo sigue
//       estando al reactivar el cliente). La caché de sesión se limpia DESPUÉS del commit (la ruta).
//   · RN-CLI-4 — Activar pone `active = true` y, en la MISMA transacción, libera los trámites retenidos de la compañía
//       (HU #13946, `liberarTramitesRetenidos` de `flito-sync`): si el arranque de uno falla, la activación se revierte.
//   · RN-CLI-7 (HU #13952, Feature #13943) — NIT único por sucursal entre clientes VIGENTES (`deleted_at IS NULL`):
//       el alta y la edición comprueban antes de escribir (`buscarClienteDuplicado`, normalizado `upper(btrim())`, el
//       propio cliente excluido en la edición) y responden 409 `ClienteDuplicadoError`. Sin NIT (NULL o vacío) no
//       participa; otra sucursal sí se permite. Red de seguridad: índice único parcial `uq_clients_document_branch_vivo`
//       (0257); su 23505 en una carrera se traduce al MISMO 409 (`esDuplicadoNitSucursal`), nunca 500.
//   · RN-CLI-10 (HU #13954, Feature #13943) — Eliminar = baja LÓGICA (`deleted_at`/`deleted_by` de la 0257), nunca
//       DELETE. Condiciones EN ORDEN (el primer motivo que falla es el que se informa, también en el impacto):
//       1) inactivo; 2) sin procesos abiertos (predicado de RN-CLI-1); 3) saldo de la bolsa = 0 (negativo también
//       impide). Una sola transacción: `FOR UPDATE` sobre la fila de `clients` y luego sobre la de `flito_bolsas`
//       (mismo orden que los movimientos de bolsa, que leen el cliente antes que la bolsa), y las condiciones se
//       evalúan DESPUÉS de los bloqueos (un movimiento confirmado antes del bloqueo cuenta). Los usuarios de la
//       compañía quedan de baja permanente con el mecanismo de la HU #12089 (`deleted_at`, `deleted_by`,
//       `session_invalidated_at`, dentro de `conSeguroAntiBloqueo` y con su rastro en la bitácora de permisos) y
//       además `active = false`. Un eliminado (o inexistente) responde 404; si otro administrador lo eliminó mientras
//       esta petición esperaba el bloqueo → 409 `EstadoClienteCambiadoError`.
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients, flitoBolsas, flitoImpuestos, flitoLiquidaciones, flitoSoat, flitoTramites, users,
} from '../../db/schema.js';
import { liberarTramitesRetenidos } from '../flito-sync/liberar-retenidos.js';
import { conSeguroAntiBloqueo } from '../../shared/permisos-anti-bloqueo.js';
import { registrarCambiosPermisos, type ActorAuditoria } from '../../shared/historial/permisos-auditoria.js';
import { clienteVigente } from './cliente-operable.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** La conexión o una transacción abierta: el impacto se puede leer en cualquiera de las dos. */
export type Ejecutor = typeof db | Tx;

export class ClienteNoEncontradoError extends Error {
  constructor() { super('Cliente no encontrado'); this.name = 'ClienteNoEncontradoError'; }
}

/** 409: el cliente existe pero su estado ya no es el que el administrador vio (RN-CLI-2). */
export class EstadoClienteCambiadoError extends Error {
  constructor() { super('Otro administrador ya cambió su estado'); this.name = 'EstadoClienteCambiadoError'; }
}

/** RN-CLI-10: 409 — el cliente no cumple una condición para eliminarlo. `message` es el texto del AC. */
export class ClienteNoEliminableError extends Error {
  constructor(message: string) { super(message); this.name = 'ClienteNoEliminableError'; }
}

/** RN-CLI-7: 409 — ya hay un cliente vigente con ese NIT en esa sucursal. */
export class ClienteDuplicadoError extends Error {
  constructor(readonly document: string, readonly branchOffice: number) {
    super(`Ya existe un cliente con el NIT ${document} y sucursal ${branchOffice}.`);
    this.name = 'ClienteDuplicadoError';
  }
}

/** Nombre del índice único parcial de la 0257 (RN-CLI-7). */
export const INDICE_NIT_SUCURSAL_VIVO = 'uq_clients_document_branch_vivo';

/** ¿El NIT cuenta para la unicidad? Sin NIT (NULL, vacío o solo espacios) no participa (AC7). */
export const tieneNit = (document: string | null | undefined): document is string =>
  typeof document === 'string' && document.trim() !== '';

/**
 * RN-CLI-7. Lanza `ClienteDuplicadoError` si otro cliente VIGENTE tiene el mismo NIT (normalizado) y sucursal.
 * `excluirId`: el propio cliente en una edición (AC4). Sin NIT no consulta nada.
 */
export async function exigirNitSucursalLibre(
  document: string | null | undefined, branchOffice: number, excluirId?: number,
): Promise<void> {
  if (!tieneNit(document)) return;
  const [fila] = await db.select({ id: clients.id }).from(clients).where(and(
    sql`upper(btrim(${clients.document})) = ${document.trim().toUpperCase()}`,
    eq(clients.branchOffice, branchOffice),
    isNull(clients.deletedAt),
    excluirId === undefined ? undefined : ne(clients.id, excluirId),
  )).limit(1);
  if (fila) throw new ClienteDuplicadoError(document.trim(), branchOffice);
}

/** RN-CLI-7 (AC6): ¿el error de escritura es la violación del índice único NIT + sucursal (carrera)? */
export function esDuplicadoNitSucursal(e: unknown): boolean {
  // Drizzle puede envolver el error de postgres-js en `cause`.
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const pg = x as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (pg.code === '23505' && (pg.constraint_name ?? pg.constraint) === INDICE_NIT_SUCURSAL_VIVO) return true;
  }
  return false;
}

export interface ImpactoCliente {
  activo: boolean;
  procesosAbiertos: { soat: number; impuestos: number; tramites: number; liquidaciones: number };
  /** Saldo de la bolsa única de la compañía, en pesos; 0 si no tiene bolsa. */
  saldoBolsa: number;
  usuariosAfectados: number;
  /** RN-CLI-10 (HU #13954): `true` solo si cumple las tres condiciones; si no, el PRIMER motivo que falla. */
  puedeEliminar: boolean;
  motivoNoEliminable: string | null;
}

/** Pesos sin decimales y con punto de miles: `-$20.000`, `$1.500.000` (texto de los AC de la HU #13954). */
export const formatoPesos = (valor: number): string => {
  const entero = Math.round(Math.abs(valor)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${valor < 0 ? '-' : ''}$${entero}`;
};

export const MENSAJE_CLIENTE_ACTIVO = 'Primero debe desactivarlo.';

/** RN-CLI-10: el primer motivo por el que el cliente no se puede eliminar, o `null` si sí se puede. */
export function motivoNoEliminable(
  { activo, procesosAbiertos: p, saldoBolsa }: Pick<ImpactoCliente, 'activo' | 'procesosAbiertos' | 'saldoBolsa'>,
): string | null {
  if (activo) return MENSAJE_CLIENTE_ACTIVO;
  const total = p.soat + p.impuestos + p.tramites + p.liquidaciones;
  if (total > 0) {
    const detalle = `SOAT: ${p.soat}, impuestos: ${p.impuestos}, trámites: ${p.tramites}, liquidaciones: ${p.liquidaciones}`;
    return `Tiene ${total} ${total === 1 ? 'proceso abierto' : 'procesos abiertos'} (${detalle}).`;
  }
  if (saldoBolsa !== 0) return `Su bolsa tiene saldo de ${formatoPesos(saldoBolsa)}; debe quedar en cero.`;
  return null;
}

const n = (filas: { total: number }[]): number => Number(filas[0]?.total ?? 0);

/** RN-CLI-1. `null` si el cliente no existe o está eliminado (RN-CLI-9). No modifica nada. */
export async function impactoCliente(tx: Ejecutor, id: number): Promise<ImpactoCliente | null> {
  const [cliente] = await tx.select({ active: clients.active }).from(clients)
    .where(and(eq(clients.id, id), clienteVigente())).limit(1);
  if (!cliente) return null;

  const [soat, impuestos, tramites, liquidaciones, bolsa, usuarios] = await Promise.all([
    tx.select({ total: count() }).from(flitoSoat)
      .where(and(eq(flitoSoat.companiaId, id), ne(flitoSoat.estado, 'pagado'))),
    tx.select({ total: count() }).from(flitoImpuestos)
      .where(and(eq(flitoImpuestos.companiaId, id), ne(flitoImpuestos.estado, 'pagado'))),
    tx.select({ total: count() }).from(flitoTramites)
      .where(and(eq(flitoTramites.companiaId, id), eq(flitoTramites.estado, 'asignado'))),
    tx.select({ total: count() }).from(flitoLiquidaciones)
      .innerJoin(flitoTramites, eq(flitoTramites.id, flitoLiquidaciones.tramiteId))
      .where(and(eq(flitoTramites.companiaId, id), eq(flitoLiquidaciones.estado, 'liquidado'))),
    tx.select({ saldo: flitoBolsas.saldo }).from(flitoBolsas).where(eq(flitoBolsas.companiaId, id)).limit(1),
    tx.select({ total: count() }).from(users).where(and(eq(users.companiaId, id), isNull(users.deletedAt))),
  ]);

  const base = {
    activo: cliente.active,
    procesosAbiertos: { soat: n(soat), impuestos: n(impuestos), tramites: n(tramites), liquidaciones: n(liquidaciones) },
    saldoBolsa: bolsa[0] ? Number(bolsa[0].saldo) : 0,
    usuariosAfectados: n(usuarios),
  };
  const motivo = motivoNoEliminable(base);
  return { ...base, puedeEliminar: motivo === null, motivoNoEliminable: motivo };
}

export interface CambioDeEstado {
  id: number;
  name: string;
  active: boolean;
  /** Usuarios cuya sesión se invalidó (solo al desactivar): la ruta limpia su caché tras el commit. */
  usuariosInvalidados: number[];
}

/** HU #13946 (RN-CLI-4): libera, en la transacción de la activación, los trámites retenidos mientras estuvo inactivo. */
async function alActivarCliente(tx: Tx, id: number): Promise<void> {
  await liberarTramitesRetenidos(tx, id);
}

/** RN-CLI-2/3/4. Lanza `ClienteNoEncontradoError` (404) o `EstadoClienteCambiadoError` (409). */
export async function cambiarEstadoCliente(
  id: number, { activo, activoEsperado }: { activo: boolean; activoEsperado: boolean },
): Promise<CambioDeEstado> {
  return db.transaction(async (tx) => {
    const [fila] = await tx.update(clients).set({ active: activo })
      .where(and(eq(clients.id, id), eq(clients.active, activoEsperado)))
      .returning({ id: clients.id, name: clients.name, active: clients.active });
    if (!fila) {
      const [existe] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, id)).limit(1);
      throw existe ? new EstadoClienteCambiadoError() : new ClienteNoEncontradoError();
    }

    let usuariosInvalidados: number[] = [];
    if (!activo) {
      const invalidados = await tx.update(users).set({ sessionInvalidatedAt: sql`now()` })
        .where(eq(users.companiaId, id)).returning({ id: users.id });
      usuariosInvalidados = invalidados.map((u) => u.id);
    } else {
      await alActivarCliente(tx, id);
    }
    return { ...fila, usuariosInvalidados };
  });
}

/** Login (HU #13945 AC3): ¿la compañía del usuario está inactiva? `false` si no tiene compañía o no existe. */
export async function companiaInactiva(companiaId: number | null | undefined): Promise<boolean> {
  if (companiaId == null) return false;
  const [fila] = await db.select({ active: clients.active }).from(clients).where(eq(clients.id, companiaId)).limit(1);
  return fila !== undefined && !fila.active;
}

/** Para la auditoría: los 3 primeros caracteres y `***` (mismo criterio que el `login_failed`). */
export const nombreEnmascarado = (name: string): string => `${name.trim().slice(0, 3)}***`;

export interface ClienteEliminado {
  id: number;
  name: string;
  /** Usuarios dados de baja: la ruta limpia su caché de sesión tras el commit. */
  usuariosDadosDeBaja: number[];
}

/**
 * RN-CLI-10. Lanza `ClienteNoEncontradoError` (404), `EstadoClienteCambiadoError` (409, otro administrador lo
 * eliminó mientras se esperaba el bloqueo), `ClienteNoEliminableError` (409) o `BloqueoAdministracionError` (409).
 * NUNCA hace `DELETE FROM clients` ni `DELETE FROM users`.
 */
export async function eliminarCliente(id: number, actor: ActorAuditoria): Promise<ClienteEliminado> {
  return db.transaction(async (tx) => {
    // Lectura SIN bloqueo: lo ya eliminado (confirmado) antes de esta petición es 404, como lo inexistente.
    const [vigente] = await tx.select({ id: clients.id }).from(clients)
      .where(and(eq(clients.id, id), clienteVigente())).limit(1);
    if (!vigente) throw new ClienteNoEncontradoError();

    // Bloqueo de la fila SIN filtrar por `deleted_at`: si otro administrador la eliminó mientras esperábamos, la fila
    // vuelve con su `deleted_at` y eso es la carrera (409), no un 404.
    const [cliente] = await tx.select({ name: clients.name, deletedAt: clients.deletedAt }).from(clients)
      .where(eq(clients.id, id)).limit(1).for('update');
    if (!cliente) throw new ClienteNoEncontradoError();
    if (cliente.deletedAt != null) throw new EstadoClienteCambiadoError();
    await tx.select({ id: flitoBolsas.id }).from(flitoBolsas).where(eq(flitoBolsas.companiaId, id)).for('update');

    // Las condiciones, DESPUÉS de los bloqueos: ven lo confirmado hasta aquí (AC9).
    const impacto = await impactoCliente(tx, id);
    if (!impacto) throw new ClienteNoEncontradoError();
    if (impacto.motivoNoEliminable !== null) throw new ClienteNoEliminableError(impacto.motivoNoEliminable);

    const ahora = new Date();
    const bajas = await conSeguroAntiBloqueo(tx, async () => {
      await tx.update(clients).set({ deletedAt: ahora, deletedBy: actor.userId }).where(eq(clients.id, id));
      return tx.update(users)
        .set({ deletedAt: ahora, deletedBy: actor.userId, active: false, sessionInvalidatedAt: ahora })
        .where(and(eq(users.companiaId, id), isNull(users.deletedAt)))
        .returning({ id: users.id, role: users.role });
    });
    // Mismo rastro que la baja individual de la HU #12089, uno por usuario.
    await registrarCambiosPermisos(tx, actor, bajas.map((u) => ({
      entidad: 'usuario' as const, accion: 'baja' as const, campo: 'deleted_at' as const,
      valorAntes: null, valorDespues: ahora.toISOString(), usuarioAfectado: { id: u.id, rol: u.role },
    })));
    return { id, name: cliente.name, usuariosDadosDeBaja: bajas.map((u) => u.id) };
  });
}
