// FLITO — vigencia de un trámite (Épica #14707, ADR-0049 §1). Módulo PURO: lo consumen API y web.
//
// Regla madre: un trámite que FLIT anuló, abortó o revocó NO EXISTE en FLITO. El predicado único es
// `flito_tramites.estado = 'anulado'` (FLIT 1 mapea `Abortado`/`Revocado` a `anulado` desde la 0318; FLIT 2
// ya lo hacía). La sub-vigencia (anulado | abortado | revocado) se lee de `flit_estado`, sin un valor de enum
// propio: solo sirve para el chip (D7, D8) y para decidir si se liberan comprobantes y bolsa (D11).
// `rechazado` NO es muerte (D1): por eso esto no reutiliza `ESTADOS_TRAMITE_FLITO_TERMINADOS`.

/** Motivos de un descarte: la sub-vigencia de un trámite muerto. */
export const MOTIVOS_DESCARTE = ['anulado', 'abortado', 'revocado'] as const;
export type MotivoDescarte = (typeof MOTIVOS_DESCARTE)[number];

/** `vigente` = vivo; el resto = muerto, con su causa en FLIT. */
export type VigenciaTramite = 'vigente' | MotivoDescarte;

/** Código de error HTTP 409 de toda acción de avance sobre un trámite (o SOAT/impuesto) que ya no existe. */
export const CODIGO_TRAMITE_NO_VIGENTE = 'TRAMITE_NO_VIGENTE' as const;

/** ¿El trámite está muerto? Mismo predicado que el SQL `TRAMITE_MUERTO` del API. */
export function tramiteMuerto(estado: string | null | undefined): boolean {
  return estado === 'anulado';
}

/**
 * Vigencia del trámite a partir de su estado FLITO y del estado crudo de FLIT. Un `NULL` (borrador,
 * preparado…) es vigente. Muerto sin `flit_estado` reconocible → `anulado`.
 */
export function vigenciaTramite(estado: string | null | undefined, flitEstado: string | null | undefined): VigenciaTramite {
  if (!tramiteMuerto(estado)) return 'vigente';
  const crudo = (flitEstado ?? '').trim().toLowerCase();
  if (crudo === 'abortado') return 'abortado';
  if (crudo === 'revocado') return 'revocado';
  return 'anulado';
}

/** D11: solo anulado y abortado liberan comprobantes y bolsa; un revocado ya cobrado conserva lo aplicado (D8). */
export function vigenciaLiberaPagos(v: VigenciaTramite): boolean {
  return v === 'anulado' || v === 'abortado';
}
