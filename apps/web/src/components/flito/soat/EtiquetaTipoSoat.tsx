// FLITO — pastilla NEUTRA del tipo de solicitud («Inicial» / «Renovación»), HU #14019 (UX §6, delta 1).
//
// Sin ícono y sin tono de estado a propósito: no compite con el chip del estado, y no es un aviso.
// Una fila de trámite (`tipoSoat = null`) no lleva pastilla.

import type { TipoSoat } from '@operaciones/shared-types';
import { ROTULO_TIPO } from '../../../lib/mensajesTipoSoat';

export default function EtiquetaTipoSoat({ tipo }: { tipo: TipoSoat | null | undefined }) {
  if (!tipo) return null;
  return (
    <span
      data-tipo-soat={tipo}
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: 'var(--flit-bg-hover)', color: 'var(--flit-text-secondary)', border: '1px solid var(--flit-border-soft)' }}
    >
      {ROTULO_TIPO[tipo]}
    </span>
  );
}
