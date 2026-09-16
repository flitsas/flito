// FLITO — Impuestos: la fila de la cola y lo que comparten la tabla, el detalle y el recibo de caja
// (HU #12592). Vive fuera de la página porque `DetalleImpuesto` y `ModalReciboCaja` la necesitan y
// la página está al borde de `max-lines`.

import type { DocumentosImpuesto, EstadoImpuesto } from '@operaciones/shared-types';
import type { CertificacionCola } from '../flit/CertificacionRunt';
import StatusChip, { type ChipTone } from '../flit/StatusChip';

export interface ImpuestoItem {
  id: string; tramiteId: string; idFlit: string; placa: string | null; vin: string;
  marca: string | null; linea: string | null;
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
  estado: EstadoImpuesto; compradorNombre: string | null; compradorDocumento: string | null;
  /**
   * CÓDIGO de tipo de documento ya resuelto por el API (`'CC' | 'NIT' | 'PP' | 'CE'`) o null. NO es
   * el `tipo` crudo de FLIT: la tabla de mapeo es del backend y el front no la duplica (HU #11947).
   */
  compradorTipoDocumento: string | null;
  companiaNombre: string; organismoCodigo: string; organismoNombre: string | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  tieneFacturaVenta: boolean; enviadoPorNombre: string | null; enviadoEn: string | null; pagadoEn: string | null;
  estancado: boolean; motivoRechazo: string | null; creadoEn: string;
  /** true = lo gestiona Operaciones por contingencia, en vez del gestor del organismo. El impuesto
   *  se sigue pagando ante el mismo organismo: lo que cambia es quién lo tramita. */
  gestionOperaciones: boolean;
  /** Certificación vigente contra el RUNT, o null si el registro no está certificado (HU #11168). */
  certificacion: CertificacionCola | null;
  /** Cuándo se cargó la liquidación (fase Liquidación de la carga masiva); null si no se ha cargado (HU #12590). */
  liquidadoEn: string | null;
  /** Qué documentos de la hacienda tiene: liquidación, pago, ambos o ninguno (HU #12591). */
  documentos: DocumentosImpuesto | null;
}

export const TONO_IMPUESTO: Record<EstadoImpuesto, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
};
export const pesos = (v: number | string | null) => v === null ? '—'
  : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(v));
export const fecha = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const CHIP_DOCUMENTOS: Record<DocumentosImpuesto, { texto: string; tono: ChipTone }> = {
  // El único azul de la pila: es el que dice «falta pagar».
  liquidacion: { texto: 'Liquidación', tono: 'active' },
  pago: { texto: 'Pago', tono: 'success' },
  ambos: { texto: 'Ambos', tono: 'success' },
};

/**
 * Qué documentos de la hacienda tiene el impuesto. Va en la pila de Estado, no en columna propia:
 * la tabla ya tiene 13. La fecha de liquidación se calla en la tabla y va al `title` (y como dato
 * del detalle). Con `documentos === null` no pinta nada.
 */
export function ChipDocumentos({ imp }: { imp: Pick<ImpuestoItem, 'documentos' | 'liquidadoEn'> }) {
  if (!imp.documentos) return null;
  const { texto, tono } = CHIP_DOCUMENTOS[imp.documentos];
  // El `title` va en un envoltorio y no en el chip: `StatusChip` no lo admite y el kit no se toca
  // por una pantalla. Sin `liquidadoEn` no hay `title` (no se promete una fecha que no existe).
  return (
    <span title={imp.liquidadoEn ? `Liquidado el ${fecha(imp.liquidadoEn)}` : undefined}>
      <StatusChip tone={tono}>{texto}</StatusChip>
    </span>
  );
}
