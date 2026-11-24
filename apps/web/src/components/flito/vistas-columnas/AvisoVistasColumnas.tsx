// Aviso de página cuando no cargaron las vistas de columnas (ADR-0045). Es estado persistente, así
// que va en la página y no en un toast. La tabla ya se ve con la vista del sistema.
import { claseBoton } from '../../flit/GradientButton';
import type { VistasColumnas } from './useVistasColumnas';

export default function AvisoVistasColumnas({ vc }: { vc: VistasColumnas }) {
  if (vc.estado !== 'error') return null;
  return (
    <div className="kit-alerta mb-3" data-tono="warn" data-kit="alerta">
      <img src="/kit/aviso-alerta.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
      <p role="status" className="m-0 min-w-0 flex-1 text-sm">
        No pudimos cargar sus vistas de columnas. La tabla se muestra con la vista del sistema.
      </p>
      <button type="button" className={claseBoton('secondary', 'sm')} onClick={vc.recargar}>Reintentar</button>
    </div>
  );
}
