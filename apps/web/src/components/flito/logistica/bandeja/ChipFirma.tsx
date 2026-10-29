import StatusChip from '../../../flit/StatusChip';

/** Chip de firma (HU #14149): «Firmada» éxito + punto lleno; «Sin firma» advertencia + punto de contorno. El texto repite el estado. */
export function PuntoFirma({ firmada }: { firmada: boolean }) {
  return (
    <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={firmada
        ? { background: 'var(--flit-success-ink)' }
        : { border: '1.5px solid var(--flit-warning-ink)', boxSizing: 'content-box', width: 3, height: 3 }} />
  );
}

export default function ChipFirma({ firmada }: { firmada: boolean }) {
  return <StatusChip tone={firmada ? 'success' : 'warning'} icono={<PuntoFirma firmada={firmada} />}>{firmada ? 'Firmada' : 'Sin firma'}</StatusChip>;
}
