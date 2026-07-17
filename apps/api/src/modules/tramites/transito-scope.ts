import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { isKnownOrganismoCodigo } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';

export type TransitoScope =
  | { ok: true; codigo: string | null }
  | { ok: false; status: number; error: string };

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

  let codigo = user.transitoCodigo?.trim();
  if (!codigo) {
    const [row] = await db.select({ c: users.transitoCodigo }).from(users).where(eq(users.id, user.sub)).limit(1);
    codigo = row?.c?.trim() ?? undefined;
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
