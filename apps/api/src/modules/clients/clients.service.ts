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
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients, flitoBolsas, flitoImpuestos, flitoLiquidaciones, flitoSoat, flitoTramites, users,
} from '../../db/schema.js';
import { liberarTramitesRetenidos } from '../flito-sync/liberar-retenidos.js';

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

export interface ImpactoCliente {
  activo: boolean;
  procesosAbiertos: { soat: number; impuestos: number; tramites: number; liquidaciones: number };
  /** Saldo de la bolsa única de la compañía, en pesos; 0 si no tiene bolsa. */
  saldoBolsa: number;
  usuariosAfectados: number;
  /**
   * Valor NEUTRO hasta la HU #13954 (eliminar cliente), que decide cuándo se puede eliminar y por qué no:
   * hoy siempre `false` / `null` (esta HU no ofrece eliminar).
   */
  puedeEliminar: false;
  motivoNoEliminable: null;
}

const n = (filas: { total: number }[]): number => Number(filas[0]?.total ?? 0);

/** RN-CLI-1. `null` si el cliente no existe. No modifica nada. */
export async function impactoCliente(tx: Ejecutor, id: number): Promise<ImpactoCliente | null> {
  const [cliente] = await tx.select({ active: clients.active }).from(clients).where(eq(clients.id, id)).limit(1);
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

  return {
    activo: cliente.active,
    procesosAbiertos: { soat: n(soat), impuestos: n(impuestos), tramites: n(tramites), liquidaciones: n(liquidaciones) },
    saldoBolsa: bolsa[0] ? Number(bolsa[0].saldo) : 0,
    usuariosAfectados: n(usuarios),
    puedeEliminar: false,
    motivoNoEliminable: null,
  };
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
