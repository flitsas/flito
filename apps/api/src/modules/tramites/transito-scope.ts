import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { isKnownOrganismoCodigo, ORGANISMOS_TRANSITO, type OrganismoTransitoAsignado } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { alcanceDe } from '../../shared/middleware/frontera-enlace.js';

// HU #13426 (Feature #12871, AC6/AC8/AC9): el alcance de la bandeja de Tránsito sale del ENLACE del
// usuario (`alcanceDe`), nunca del nombre de su rol. El permiso de cada ruta lo pone `exigirFuncion`.
//   · `ninguno` → todas las bandejas; `?organismo=` opcional acota a una (un código no es PII).
//   · `organismos_transito` → TODAS sus secretarías (S1 y S2), no solo la primera.
//   · Cualquier otro enlace → 403 (la frontera ya lo corta antes; aquí falla cerrado).
// Selector de secretaría (corrección de #13426 en la sesión de evidencias, decisión de David): las
// LISTAS de la bandeja (pendientes, propios, traspasos) muestran UNA secretaría a la vez.
//   · `?organismo=` (patrón vigente del módulo; un código no es PII) elige una de las ASIGNADAS por el
//     enlace. Una no asignada —o un código que ni existe— → el mismo 403, sin consultar trámites (sin oráculo).
//   · Sin `?organismo=`: `users.transito_codigo` si está entre las asignadas; si no, la primera en orden
//     estable (código ascendente, el mismo orden de `alcanceDeUsuario`).
//   · Detalle y escrituras (tomar, asignar/confirmar placa) sin `?organismo=` validan contra TODAS las
//     asignadas: el trámite debe ser de una secretaría del enlace.
export type TransitoScope =
  | { ok: true; codigos: string[] | null }
  | { ok: false; status: number; error: string };

const SIN_ORGANISMO = 'Su cuenta no tiene organismo de tránsito asignado. Contacte al administrador FLIT.';
const NO_ASIGNADA = 'La secretaría pedida no está asignada a su cuenta';

/** `?organismo=` de la petición: `''` si no viene; `null` si viene mal formado (repetido, objeto). */
function organismoPedido(req: Request): string | null {
  const raw = req.query.organismo;
  if (raw === undefined) return '';
  return typeof raw === 'string' ? raw.trim() : null;
}

/** Las secretarías válidas del enlace `organismos_transito`, en orden estable. */
function codigosDelEnlace(organismos: string[]): string[] {
  return [...new Set(organismos.map((c) => c.trim()).filter((c) => c && isKnownOrganismoCodigo(c)))].sort();
}

/** La secretaría por defecto: la columna `users.transito_codigo` si está asignada; si no, la primera. */
async function secretariaPorDefecto(userId: number, codigos: string[]): Promise<string> {
  if (codigos.length === 1) return codigos[0]!;
  const [u] = await db.select({ t: users.transitoCodigo }).from(users).where(eq(users.id, userId)).limit(1);
  const legado = u?.t?.trim() ?? '';
  return codigos.includes(legado) ? legado : codigos[0]!;
}

export interface OpcionesScope {
  /** Listas de la bandeja: una sola secretaría (la pedida o la por defecto). */
  unaSecretaria?: boolean;
}

export async function resolveTransitoScope(req: Request, opciones: OpcionesScope = {}): Promise<TransitoScope> {
  const a = await alcanceDe(req);
  const pedido = organismoPedido(req);
  if (a.enlace === 'ninguno') {
    const q = pedido ?? '';
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

  const codigos = codigosDelEnlace(a.organismos);
  if (codigos.length === 0) return { ok: false, status: 403, error: SIN_ORGANISMO };
  if (pedido === null || (pedido && !codigos.includes(pedido))) {
    return { ok: false, status: 403, error: NO_ASIGNADA };
  }
  if (pedido) return { ok: true, codigos: [pedido] };
  if (!opciones.unaSecretaria) return { ok: true, codigos };
  return { ok: true, codigos: [await secretariaPorDefecto(req.user!.sub, codigos)] };
}

/**
 * `GET /api/transito/organismos` (selector de la bandeja). Sin enlace → el catálogo nacional, como antes
 * (sin `porDefecto`: el operador no tiene selector de enlace). `organismos_transito` → sus secretarías
 * del catálogo, por código, con `porDefecto: true` en la que muestran las listas sin `?organismo=`.
 * Sin ninguna asignada → lista vacía (como antes de la corrección; las listas responden su 403).
 */
export async function secretariasAsignadas(req: Request): Promise<OrganismoTransitoAsignado[]> {
  const a = await alcanceDe(req);
  if (a.enlace === 'ninguno') return [...ORGANISMOS_TRANSITO];
  if (a.enlace !== 'organismos_transito') return [];
  const codigos = codigosDelEnlace(a.organismos);
  if (codigos.length === 0) return [];
  const porDefecto = await secretariaPorDefecto(req.user!.sub, codigos);
  const porCodigo = new Map(ORGANISMOS_TRANSITO.map((o) => [o.codigo, o]));
  return codigos.map((codigo) => {
    const o = porCodigo.get(codigo)!;
    return { nombre: o.nombre, ciudad: o.ciudad, codigo, ...(codigo === porDefecto ? { porDefecto: true as const } : {}) };
  });
}

/** ¿Está el organismo dentro del alcance? `null` = sin acotar (enlace `ninguno` sin `?organismo=`). */
export function organismoEnAlcance(codigos: string[] | null, organismo: string | null | undefined): boolean {
  if (codigos === null) return true;
  return organismo != null && codigos.includes(organismo);
}
