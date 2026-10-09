import type { Request } from 'express';
import { isKnownOrganismoCodigo } from '@operaciones/shared-types';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';

// HU #13426 (Feature #12871, AC6/AC8/AC9): el alcance de la bandeja de Tránsito sale del ENLACE del
// usuario (`alcanceDe`), nunca del nombre de su rol. El permiso de cada ruta lo pone `exigirFuncion`.
//   · `ninguno` → todas las bandejas; `?organismo=` opcional acota a una (un código no es PII).
//   · `organismos_transito` → TODAS sus secretarías (S1 y S2), no solo la primera.
//   · Cualquier otro enlace → 403 (la frontera ya lo corta antes; aquí falla cerrado).
export type TransitoScope =
  | { ok: true; codigos: string[] | null }
  | { ok: false; status: number; error: string };

export async function resolveTransitoScope(req: Request): Promise<TransitoScope> {
  const a = await alcanceDe(req);
  if (a.enlace === 'ninguno') {
    const q = typeof req.query.organismo === 'string' ? req.query.organismo.trim() : '';
    if (q) {
      if (!isKnownOrganismoCodigo(q)) {
        return { ok: false, status: 400, error: 'Código de organismo inválido' };
      }
      return { ok: true, codigos: [q] };
    }
    return { ok: true, codigos: null };
  }

  if (a.enlace !== 'organismos_transito') {
    return { ok: false, status: 403, error: 'Sin permisos' };
  }

  const codigos = a.organismos.map((c) => c.trim()).filter((c) => c && isKnownOrganismoCodigo(c));
  if (codigos.length === 0) {
    return {
      ok: false,
      status: 403,
      error: 'Su cuenta no tiene organismo de tránsito asignado. Contacte al administrador FLIT.',
    };
  }
  return { ok: true, codigos };
}

/** ¿Está el organismo dentro del alcance? `null` = sin acotar (enlace `ninguno` sin `?organismo=`). */
export function organismoEnAlcance(codigos: string[] | null, organismo: string | null | undefined): boolean {
  if (codigos === null) return true;
  return organismo != null && codigos.includes(organismo);
}
