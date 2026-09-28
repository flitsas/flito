// Chip de estado del SOAT (HU #12819). Tono + icono por estado (§11 de la spec): el estado deja de
// depender solo del color. El icono es decorativo (`aria-hidden`): el texto del chip ya dice el
// estado, así que el nombre accesible no cambia. 14 px porque el texto del chip es de 12.

import type { ReactNode } from 'react';
import { CircleCheck, CircleDashed, CircleSlash, Hourglass, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { ESTADO_SOAT_LABEL, EstadoSoat, type EstadoSolicitudIncompletaSoat } from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { ESTADO_INCOMPLETA_LABEL } from './tipos';

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

/**
 * Chip de la solicitud aparcada porque el RUNT no respondió (HU #12997, UX §3.1). Tono `warning` +
 * `ShieldQuestion` para «Por validar» (la única con trabajo pendiente) y `draft` —el neutro del kit—
 * + `CircleSlash` para «Descartada», que es un cierre. La marca no depende del color: texto e icono.
 */
const TONO_INCOMPLETA: Record<EstadoSolicitudIncompletaSoat, ChipTone> = {
  incompleta: 'warning', descartada: 'draft', completada: 'success',
};

export function ChipIncompletaSoat({ estado }: { estado: EstadoSolicitudIncompletaSoat }) {
  const props = { size: 14, 'aria-hidden': true, className: 'shrink-0' } as const;
  const ic = estado === 'incompleta' ? <ShieldQuestion {...props} />
    : estado === 'descartada' ? <CircleSlash {...props} /> : <CircleCheck {...props} />;
  return <StatusChip tone={TONO_INCOMPLETA[estado]} icono={ic}>{ESTADO_INCOMPLETA_LABEL[estado]}</StatusChip>;
}
