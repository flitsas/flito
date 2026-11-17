// FLITO — etiqueta NEUTRA del tipo de solicitud («Inicial» / «Renovación»), HU 14019 (UX §6, delta 1).
//
// Sin ícono de estado a propósito: no compite con el chip del estado, y no es un aviso. UI Kit 2026:
// etiqueta con punta en tono neutro (`etiquetaKit('neutro')`).
// Una fila de trámite (`tipoSoat = null`) no lleva etiqueta.

import type { TipoSoat } from '@operaciones/shared-types';
import { ROTULO_TIPO } from '../../../lib/mensajesTipoSoat';
import { etiquetaKit } from '../../flit/kit/tonos';

export default function EtiquetaTipoSoat({ tipo }: { tipo: TipoSoat | null | undefined }) {
  if (!tipo) return null;
  return (
    <span data-tipo-soat={tipo} {...etiquetaKit('neutro', { className: 'shrink-0' })}>
      {ROTULO_TIPO[tipo]}
    </span>
  );
}
