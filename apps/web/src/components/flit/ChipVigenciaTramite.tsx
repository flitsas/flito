// Chip de un trámite que ya no existe en FLITO (Épica #14707, ADR-0049): «Anulado» (también el abortado, cuyo
// estado literal queda en el historial) o «Revocado», con el tono y el ícono del kit. El texto lleva el
// significado; el ícono es decorativo. Lo comparten Gestión Trámites, Siigo y Logística.
import type { VigenciaTramite } from '@operaciones/shared-types';
import StatusChip from './StatusChip';
import { ETIQUETA_ICONO_CLS, ICONO_ESTADO_KIT } from './kit/tonos';

export default function ChipVigenciaTramite({ vigencia }: { vigencia: Exclude<VigenciaTramite, 'vigente'> }) {
  const revocado = vigencia === 'revocado';
  return (
    <StatusChip tono={revocado ? 'revocado' : 'anulado'}
      icono={<img src={ICONO_ESTADO_KIT[revocado ? 'revocado' : 'anulado']} alt="" aria-hidden="true" className={ETIQUETA_ICONO_CLS} />}>
      {revocado ? 'Revocado' : 'Anulado'}
    </StatusChip>
  );
}
