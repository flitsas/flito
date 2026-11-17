import { BarraAccion } from '../../../flit/Bloques';
import { claseBoton } from '../../../flit/GradientButton';

/**
 * Aviso «N LT esperan su trámite» para la pestaña Entregas (otra HU lo cablea). Contrato:
 *   - el padre lo monta SOLO con `hasFuncion('logistica.documento.resolver_tramite')`; con N = 0 no pinta nada;
 *   - `onVer` es `() => setTab('pendientes')`.
 * Pieza del kit: `BarraAccion` (azul al 10 % con borde azul; ya trae `role="status"`).
 */
export default function AvisoLtPendientes({ cantidad, onVer }: { cantidad: number; onVer: () => void }) {
  if (cantidad <= 0) return null;
  return (
    <BarraAccion accion={<button type="button" onClick={onVer} data-variante="primario" className={claseBoton('primary', 'sm')}>Ver LT pendientes</button>}>
      <strong>{cantidad.toLocaleString('es-CO')} LT esperan su trámite.</strong>{' '}
      <span style={{ color: 'var(--color-text-secondary)' }}>Elige el trámite de cada una para que sigan su camino.</span>
    </BarraAccion>
  );
}
