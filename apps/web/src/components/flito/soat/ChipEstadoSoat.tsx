// Chip de estado del SOAT (HU #12819). Fase 0: solo el `TONO`, movido tal cual desde la página.

import { ESTADO_SOAT_LABEL, EstadoSoat } from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';

// Cuatro estados y cuatro tonos. Aquí hubo dos entradas más —`pendiente_revision` y `rechazada`, del
// canal Cliente— que la HU #12079 dejó sin escritor y que la #12080 retira del enum y del tipo de
// Postgres (migración 0176, que aborta si queda alguna fila en ellos). No hace falta conservarles un
// tono «por si llega una fila antigua»: no puede llegar ninguna.
export const TONO: Record<EstadoSoat, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
};

export default function ChipEstadoSoat({ estado }: { estado: EstadoSoat }) {
  return <StatusChip tone={TONO[estado]}>{ESTADO_SOAT_LABEL[estado]}</StatusChip>;
}
