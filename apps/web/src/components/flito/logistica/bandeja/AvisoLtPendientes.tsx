import { FlitCard } from '../../../flit/flitPageKit';

/**
 * Aviso «N LT esperan su trámite» para la pestaña Entregas (otra HU lo cablea). Contrato:
 *   - el padre lo monta SOLO con `hasFuncion('logistica.documento.resolver_tramite')`; con N = 0 no pinta nada;
 *   - `onVer` es `() => setTab('pendientes')`.
 */
export default function AvisoLtPendientes({ cantidad, onVer }: { cantidad: number; onVer: () => void }) {
  if (cantidad <= 0) return null;
  return (
    <FlitCard>
      <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p><strong>{cantidad.toLocaleString('es-CO')} LT esperan su trámite.</strong>{' '}
          <span style={{ color: 'var(--flit-text-secondary)' }}>Elige el trámite de cada una para que sigan su camino.</span></p>
        <button type="button" onClick={onVer}
          className="flit-focus rounded px-2 py-1 text-xs font-semibold transition-colors hover:bg-[var(--flit-bg-hover)] hover:underline"
          style={{ color: 'var(--flit-blue-text)' }}>Ver LT pendientes</button>
      </div>
    </FlitCard>
  );
}
