// Chip de estado del SOAT (HU #12819). Tono + icono por estado (§11 de la spec): el estado deja de
// depender solo del color. El icono es decorativo (`aria-hidden`): el texto del chip ya dice el
// estado, así que el nombre accesible no cambia. 14 px porque el texto del chip es de 12.

import type { ReactNode } from 'react';
import { CircleCheck, CircleDashed, Hourglass, TriangleAlert } from 'lucide-react';
import { ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';

// Cuatro estados y cuatro tonos. Aquí hubo dos entradas más —`pendiente_revision` y `rechazada`, del
// canal Cliente— que la HU #12079 dejó sin escritor y que la #12080 retira del enum y del tipo de
// Postgres (migración 0176, que aborta si queda alguna fila en ellos). No hace falta conservarles un
// tono «por si llega una fila antigua»: no puede llegar ninguna.
export const TONO: Record<EstadoSoat, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
};

function icono(estado: EstadoSoat): ReactNode {
  const props = { size: 14, 'aria-hidden': true, className: 'shrink-0' } as const;
  switch (estado) {
    case EstadoSoat.PENDIENTE: return <CircleDashed {...props} />;
    case EstadoSoat.SOLICITADO: return <Hourglass {...props} />;
    case EstadoSoat.CON_NOVEDAD: return <TriangleAlert {...props} />;
    case EstadoSoat.PAGADO: return <CircleCheck {...props} />;
    default: return null;
  }
}

export default function ChipEstadoSoat({ estado }: { estado: EstadoSoat }) {
  return <StatusChip tone={TONO[estado]} icono={icono(estado)}>{ESTADO_SOAT_LABEL[estado]}</StatusChip>;
}
