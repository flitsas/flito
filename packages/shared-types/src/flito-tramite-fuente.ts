// FLITO — Gestión Trámites: DE QUÉ SISTEMA llegó cada trámite (HU #13070, Feature #13058, Épica #12736).
//
// Desde la Épica #12736 FLITO recibe trámites de dos fuentes: FLIT (FLIT 1, el sync histórico) y
// FLIT 2. La columna `flito_tramites.fuente` lo guarda y la base rechaza cualquier otro valor
// (CHECK de la migración 0213). Vive aquí porque el API filtra por estos valores y la web los pinta:
// con las cadenas escritas a mano en cada lado, un renombre dejaría el filtro mudo sin romper el build.

/** Las dos fuentes posibles. Deben coincidir con el CHECK `flito_tramites_fuente_chk`. */
export const FUENTES_TRAMITE = ['flit', 'flit2'] as const;
export type FuenteTramite = (typeof FUENTES_TRAMITE)[number];

/** Etiqueta visible de cada fuente. */
export const ETIQUETA_FUENTE_TRAMITE: Record<FuenteTramite, string> = {
  flit: 'FLIT',
  flit2: 'FLIT 2',
};

/** Guarda de tipo: un valor desconocido no es una fuente (el listado lo ignora en vez de fallar). */
export const esFuenteTramite = (v: unknown): v is FuenteTramite =>
  typeof v === 'string' && (FUENTES_TRAMITE as readonly string[]).includes(v);
