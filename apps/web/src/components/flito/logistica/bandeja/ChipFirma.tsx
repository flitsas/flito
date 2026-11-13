import StatusChip from '../../../flit/StatusChip';
import { ETIQUETA_PUNTO_CLS } from '../../../flit/kit/tonos';

/** Chip de firma (HU #14149): «Firmada» éxito + punto lleno; «Sin firma» advertencia + punto de contorno. El texto repite el estado. */
export function PuntoFirma({ firmada }: { firmada: boolean }) {
  return (
    <span aria-hidden="true" className={`${ETIQUETA_PUNTO_CLS}${firmada ? '' : ' !bg-transparent border-[1.5px] border-current'}`} />
  );
}

export default function ChipFirma({ firmada }: { firmada: boolean }) {
  return <StatusChip tone={firmada ? 'success' : 'warning'} icono={<PuntoFirma firmada={firmada} />}>{firmada ? 'Firmada' : 'Sin firma'}</StatusChip>;
}
