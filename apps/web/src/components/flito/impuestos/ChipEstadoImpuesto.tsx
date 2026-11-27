// Chip de estado del impuesto con su glifo (Épica #14560, ronda 2): el MISMO estilo que `ChipEstadoSoat`
// —estado por texto e ícono, no solo por color—. Los glifos se registran aquí con el prefijo del
// módulo para no pisar las claves del kit; el embudo de la cola usa las mismas claves.
import { ESTADO_IMPUESTO_LABEL, type EstadoImpuesto } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';
import { registrarEstados } from '../../flit/kit/tonos';
import { IconoEstado } from '../soat/ChipEstadoSoat';
import { TONO_IMPUESTO } from '../ImpuestoCola';

registrarEstados({
  'impuesto-pendiente': { tono: 'neutro', glifo: 'pausa' },
  'impuesto-solicitado': { tono: 'info', glifo: 'reloj' },
  'impuesto-con_novedad': { tono: 'danger', glifo: 'alerta' },
  'impuesto-pagado': { tono: 'ok', glifo: 'doble-check' },
  'impuesto-descartado': { tono: 'neutro', glifo: 'menos' }, // Épica #14707: su trámite murió en FLIT
});

export default function ChipEstadoImpuesto({ estado }: { estado: EstadoImpuesto }) {
  return (
    <StatusChip tone={TONO_IMPUESTO[estado]} icono={<IconoEstado clave={`impuesto-${estado}`} />}>
      {ESTADO_IMPUESTO_LABEL[estado]}
    </StatusChip>
  );
}
