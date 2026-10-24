// Chip «Docs completos» / «Docs pendientes» de la tabla de Compañías (HU #13893, Feature #13888).
// Spec `docs/ux/flito-bolsas-expediente-documental.md` (Pantalla 2). No es interactivo: es un dato,
// como «Nivel»; para actuar está «Ver detalle» en la misma fila. El estado llega ya resuelto del lote
// (`useEstadoExpedientes`): este componente nunca pide nada.

import StatusChip from '../flit/StatusChip';
import { CHIP_EXPEDIENTE } from '../../lib/bolsasDocumentos';
import type { EstadoLoteExpedientes } from './useEstadoExpedientes';

export default function ChipExpediente({ companiaId, lote }: { companiaId: number; lote: EstadoLoteExpedientes }) {
  if (lote.fase === 'cargando') {
    return (
      <span aria-hidden="true" data-testid={`chip-expediente-cargando-${companiaId}`}
        className="block h-5 w-28 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: 'var(--flit-bg-app)' }} />
    );
  }
  const fila = lote.fase === 'listo' ? lote.porCompania.get(companiaId) : undefined;
  if (!fila) {
    // Error del lote o compañía que no vino en la respuesta: «—», sin chip.
    return (
      <span aria-label="Sin dato" data-testid={`chip-expediente-sin-dato-${companiaId}`}
        className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>
        —
      </span>
    );
  }
  const chip = CHIP_EXPEDIENTE[fila.completo ? 'completo' : 'pendiente'];
  return (
    <span className="whitespace-nowrap" title={chip.title} data-testid={`chip-expediente-${companiaId}`}>
      <StatusChip tone={chip.tono}>{chip.texto}</StatusChip>
    </span>
  );
}
