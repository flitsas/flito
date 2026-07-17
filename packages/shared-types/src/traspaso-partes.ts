/** Vendedor y comprador en traspaso deben ser personas distintas (doc + email). */

export interface TraspasoParteMin {
  documento?: string | null;
  email?: string | null;
}

export function normalizarDocumentoTraspaso(doc?: string | null): string {
  return (doc || '').trim().replace(/[\s.\-]/g, '');
}

export function normalizarEmailTraspaso(email?: string | null): string {
  return (email || '').trim().toLowerCase();
}

export function partesTraspasoDuplicadas(v: TraspasoParteMin, c: TraspasoParteMin): { mismoDocumento: boolean; mismoEmail: boolean } {
  const vd = normalizarDocumentoTraspaso(v.documento);
  const cd = normalizarDocumentoTraspaso(c.documento);
  const ve = normalizarEmailTraspaso(v.email);
  const ce = normalizarEmailTraspaso(c.email);
  return {
    mismoDocumento: Boolean(vd && cd && vd === cd),
    mismoEmail: Boolean(ve && ce && ve === ce),
  };
}

export function mensajePartesTraspasoDuplicadas(dup: { mismoDocumento: boolean; mismoEmail: boolean }): string | null {
  if (dup.mismoDocumento && dup.mismoEmail) {
    return 'El vendedor y el comprador no pueden tener el mismo documento ni el mismo correo electrónico.';
  }
  if (dup.mismoDocumento) {
    return 'El vendedor y el comprador no pueden tener el mismo número de documento.';
  }
  if (dup.mismoEmail) {
    return 'El vendedor y el comprador no pueden usar el mismo correo electrónico.';
  }
  return null;
}

/** Fila mínima de validación biométrica (histórico por reintentos). */
export interface ValidacionTraspasoRow {
  id: number;
  documento?: string | null;
  parte?: string | null;
  email?: string | null;
  estado: string;
  score?: number | null;
}

const ESTADO_VALIDACION_RANK: Record<string, number> = {
  aprobado: 50,
  en_proceso: 40,
  enviado: 30,
  rechazado: 20,
  expirado: 10,
};

/** Indica si una parte necesita (re)envío de enlace biométrico (no tocar aprobado/en curso/enviado). */
export function parteTraspasoRequiereReenvio(val: ValidacionTraspasoRow | undefined): boolean {
  if (!val) return true;
  if (val.estado === 'aprobado') return false;
  if (val.estado === 'en_proceso' || val.estado === 'enviado') return false;
  return true;
}

export interface TraspasoParteCompleta extends TraspasoParteMin {
  parte: 'vendedor' | 'comprador';
  nombre?: string;
  tipoDoc?: string;
}

/** Extrae vendedor/comprador efectivos desde vehiculo + comprador del trámite. */
export function extractPartesTraspasoFromTramite(tramite: {
  vehiculo?: unknown;
  comprador?: unknown;
}): { vendedor: TraspasoParteCompleta; comprador: TraspasoParteCompleta } {
  const veh = (tramite.vehiculo || {}) as Record<string, unknown>;
  const ven = (veh._vendedor || {}) as Record<string, string>;
  const comCol = (tramite.comprador || {}) as Record<string, string>;
  const comVeh = (veh._comprador || {}) as Record<string, string>;
  return {
    vendedor: {
      parte: 'vendedor',
      nombre: ven.nombre || '',
      documento: ven.documento || '',
      tipoDoc: ven.tipoDoc || 'CC',
      email: ven.email || '',
    },
    comprador: {
      parte: 'comprador',
      nombre: comCol.nombre || comVeh.nombre || '',
      documento: comCol.documento || comVeh.documento || '',
      tipoDoc: comCol.tipoDoc || comVeh.tipoDoc || 'CC',
      email: comCol.email || comVeh.email || '',
    },
  };
}

/** Elige la validación vigente cuando hay reintentos (prioriza aprobado > en curso > enviado). */
export function resolverValidacionTraspasoParte(
  validaciones: ValidacionTraspasoRow[],
  parte: { documento?: string | null; parte?: string | null },
): ValidacionTraspasoRow | undefined {
  const doc = normalizarDocumentoTraspaso(parte.documento);
  const rol = parte.parte || '';
  const matches = validaciones.filter((v) => {
    const vDoc = normalizarDocumentoTraspaso(v.documento);
    // Con documento conocido, exigirlo como condición necesaria: evita matchear
    // filas stale de un comprador anterior (mismo rol, documento distinto) que
    // se corrigió al volver atrás en el wizard. Filas sin documento (legacy)
    // caen al match por rol.
    if (doc) {
      if (vDoc) return vDoc === doc && (!rol || !v.parte || v.parte === rol);
      return Boolean(rol && v.parte === rol);
    }
    if (rol) return v.parte === rol;
    return false;
  });
  if (!matches.length) return undefined;
  return matches.reduce((best, cur) => {
    const br = ESTADO_VALIDACION_RANK[best.estado] ?? 0;
    const cr = ESTADO_VALIDACION_RANK[cur.estado] ?? 0;
    if (cr !== br) return cr > br ? cur : best;
    return cur.id > best.id ? cur : best;
  });
}

// ---------------------------------------------------------------------------
// Resolución de "validación vigente" por documento (matrícula inicial = 1 parte).
// FUENTE ÚNICA reutilizada por el wizard y el visor de expediente. Centraliza el
// bug recurrente "elegir la fila por índice/recencia" que apareció en 5+
// consumidores: SIEMPRE se elige por documento del titular + ranking de estado
// (aprobado > en_proceso > enviado > rechazado > expirado), desempate por id.
// ---------------------------------------------------------------------------

export interface ValidacionVigenteRow {
  id?: number | null;
  estado?: string | null;
  documento?: string | null;
}

/**
 * Devuelve la validación VIGENTE del titular (por `documento`): la de mayor
 * estado, desempate por id. Con documento conocido devuelve SOLO una fila de ese
 * documento (o `undefined` si no hay ninguna — nunca la de otra persona). Sin
 * documento conocido, devuelve la de mayor estado del conjunto.
 */
export function resolverValidacionVigentePorDocumento<T extends ValidacionVigenteRow>(
  rows: T[] | null | undefined,
  documento?: string | null,
): T | undefined {
  if (!rows || rows.length === 0) return undefined;
  const doc = normalizarDocumentoTraspaso(documento);
  const candidatas = doc ? rows.filter((r) => normalizarDocumentoTraspaso(r.documento) === doc) : rows;
  if (candidatas.length === 0) return undefined;
  return candidatas.reduce((best, cur) => {
    const br = ESTADO_VALIDACION_RANK[best.estado ?? ''] ?? 0;
    const cr = ESTADO_VALIDACION_RANK[cur.estado ?? ''] ?? 0;
    if (cr > br) return cur;
    if (cr < br) return best;
    return (cur.id ?? 0) > (best.id ?? 0) ? cur : best;
  });
}

/**
 * Colapsa el histórico a UNA validación vigente por documento (la de mayor
 * estado, desempate id), ordenadas por id desc. Con `soloDocumento` + `documento`
 * limita al titular indicado (matrícula = solo el comprador actual). Evita
 * mostrar reenvíos invalidados/vacíos junto a la aprobada.
 */
export function validacionesVigentesPorDocumento<T extends ValidacionVigenteRow>(
  rows: T[] | null | undefined,
  opts?: { documento?: string | null; soloDocumento?: boolean },
): T[] {
  if (!rows || rows.length === 0) return [];
  const porDoc = new Map<string, T>();
  for (const r of rows) {
    const k = normalizarDocumentoTraspaso(r.documento);
    const prev = porDoc.get(k);
    if (!prev) { porDoc.set(k, r); continue; }
    const pr = ESTADO_VALIDACION_RANK[prev.estado ?? ''] ?? 0;
    const cr = ESTADO_VALIDACION_RANK[r.estado ?? ''] ?? 0;
    if (cr > pr || (cr === pr && (r.id ?? 0) > (prev.id ?? 0))) porDoc.set(k, r);
  }
  let out = [...porDoc.values()];
  const doc = normalizarDocumentoTraspaso(opts?.documento);
  if (opts?.soloDocumento && doc) out = out.filter((r) => normalizarDocumentoTraspaso(r.documento) === doc);
  return out.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
}
