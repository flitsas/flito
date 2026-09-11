import { eq, asc } from 'drizzle-orm';
import type { Request } from 'express';
import { isKnownOrganismoCodigo } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoGestorOrganismos, users } from '../../db/schema.js';

export type TransitoScope =
  | { ok: true; codigo: string | null }
  | { ok: false; status: number; error: string };

/** Primer código de la puente, ordenado; o null si no hay filas. */
async function primerOrganismoPuente(userId: number): Promise<string | null> {
  const [row] = await db
    .select({ c: flitoGestorOrganismos.organismoCodigo })
    .from(flitoGestorOrganismos)
    .where(eq(flitoGestorOrganismos.userId, userId))
    .orderBy(asc(flitoGestorOrganismos.organismoCodigo))
    .limit(1);
  return row?.c?.trim() || null;
}

/** Admin: null = todas las bandejas; query ?organismo=05001 filtra. Tránsito: scope fijo. */
export async function resolveTransitoScope(req: Request): Promise<TransitoScope> {
  const user = req.user!;
  if (user.role === 'admin') {
    const q = typeof req.query.organismo === 'string' ? req.query.organismo.trim() : '';
    if (q) {
      if (!isKnownOrganismoCodigo(q)) {
        return { ok: false, status: 400, error: 'Código de organismo inválido' };
      }
      return { ok: true, codigo: q };
    }
    return { ok: true, codigo: null };
  }

  if (user.role !== 'transito') {
    return { ok: false, status: 403, error: 'Sin permisos' };
  }

  // HU #12088: fuente = puente; fallback a la columna mientras queden filas legacy sin migrar.
  let codigo = await primerOrganismoPuente(user.sub);
  if (!codigo) {
    codigo = user.transitoCodigo?.trim() || null;
  }
  if (!codigo) {
    const [row] = await db.select({ c: users.transitoCodigo }).from(users).where(eq(users.id, user.sub)).limit(1);
    codigo = row?.c?.trim() || null;
  }

  if (!codigo || !isKnownOrganismoCodigo(codigo)) {
    return {
      ok: false,
      status: 403,
      error: 'Su cuenta no tiene organismo de tránsito asignado. Contacte al administrador FLIT.',
    };
  }
  return { ok: true, codigo };
}
