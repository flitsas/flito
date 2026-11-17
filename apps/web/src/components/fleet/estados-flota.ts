// Estados de dominio de Flota y vehículos sobre el registro ESTADO→{tono, glifo} del UI Kit 2026 (Épica #14560, S4).
// Tonos fijados por el integrador: vigente=ok, por vencer=warn, vencido=danger.
// Se usan con <EtiquetaEstado estado={ESTADO_FLOTA.…}> (components/flit/Bloques).
import { registrarEstados } from '../flit/kit/tonos';

export const ESTADO_FLOTA = {
  docVigente: 'flota-doc-vigente',
  docPorVencer: 'flota-doc-por-vencer',
  /** Faltan ≤7 días: tono de peligro sin decir «vencido». */
  docUrgente: 'flota-doc-urgente',
  docVencido: 'flota-doc-vencido',
  docArchivado: 'flota-doc-archivado',
  docSinVigencia: 'flota-doc-sin-vigencia',
  vinculoActivo: 'flota-vinculo-activo',
  vinculoCerrado: 'flota-vinculo-cerrado',
  cadenaIntegra: 'flota-cadena-integra',
  cadenaAlterada: 'flota-cadena-alterada',
} as const;

registrarEstados({
  [ESTADO_FLOTA.docVigente]: { tono: 'ok', glifo: 'check' },
  [ESTADO_FLOTA.docPorVencer]: { tono: 'warn', glifo: 'espera' },
  [ESTADO_FLOTA.docUrgente]: { tono: 'danger', glifo: 'alerta' },
  [ESTADO_FLOTA.docVencido]: { tono: 'danger', glifo: 'vencido' },
  [ESTADO_FLOTA.docArchivado]: { tono: 'neutro', glifo: 'archivo' },
  [ESTADO_FLOTA.docSinVigencia]: { tono: 'neutro', glifo: 'menos' },
  [ESTADO_FLOTA.vinculoActivo]: { tono: 'ok', glifo: 'encendido' },
  [ESTADO_FLOTA.vinculoCerrado]: { tono: 'neutro', glifo: 'menos' },
  [ESTADO_FLOTA.cadenaIntegra]: { tono: 'ok', glifo: 'check' },
  [ESTADO_FLOTA.cadenaAlterada]: { tono: 'danger', glifo: 'alerta' },
});

/** Clave de estado para un documento por días a su vencimiento (mismos cortes que la vista anterior). */
export function estadoPorDias(dias: number): string {
  if (dias <= 0) return ESTADO_FLOTA.docVencido;
  if (dias <= 7) return ESTADO_FLOTA.docUrgente;
  if (dias <= 30) return ESTADO_FLOTA.docPorVencer;
  return ESTADO_FLOTA.docVigente;
}
