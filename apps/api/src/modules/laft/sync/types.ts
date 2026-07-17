// LAFT v2 F1 — tipos compartidos del pipeline de sync.
// El flujo de cada sync es: download → parse → normalize → diff → apply → retro-match.
// Los *.sync.ts retornan un FetchResult sin tocar BD; diff/apply/retro-match son responsables
// de eso. Esto permite testear cada etapa por separado y abortar antes de aplicar si el payload
// llega corrupto (sourceHash distinto al esperado, length 0, etc).

export interface NormalizedEntry {
  /** ID estable provisto por la lista origen. Idempotency key para upsert. */
  sourceId: string;
  /** Nombre completo o razón social. Truncado a 500 chars al persistir. */
  fullName: string;
  /** Aliases (max 30 al persistir). null si no hay. */
  aliases: string[] | null;
  docType: string | null;
  /** Documento (pasaporte/cédula). Se normaliza con normalizeDoc al persistir. */
  docNumber: string | null;
  country: string | null;
  /** Fecha de nacimiento como string (formatos heterogéneos según fuente). */
  birthDate: string | null;
  remarks: string | null;
}

export interface FetchResult {
  listCode: 'OFAC' | 'UN' | 'EU';
  sourceUrl: string;
  /** sha256 hex del payload completo descargado — clave para detectar "no-op syncs". */
  sourceHash: string;
  entries: NormalizedEntry[];
}

/** Resultado del cálculo de diff antes/después en BD. Inputs: entries normalizados + listId. */
export interface DiffStats {
  added: number;
  removed: number;
  modified: number;
  total: number;
  /** sourceIds nuevos — los retro-match SOLO los considera. */
  addedSourceIds: string[];
  /** sourceIds con hash distinto — pueden re-disparar matches si el nombre cambió, pero por defecto se omiten en retro-match. */
  modifiedSourceIds: string[];
}

export interface SyncJobOutcome {
  jobId: number;
  listCode: string;
  status: 'success' | 'failed' | 'skipped';
  added: number;
  removed: number;
  modified: number;
  total: number;
  retroMatches: number;
  durationMs: number;
  errorText?: string;
}
