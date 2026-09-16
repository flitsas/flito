// El sitio de la gráfica de evolución diaria (HU #12625). Alto fijo para que, cuando llegue, no
// mueva el layout de las tarjetas. Esa HU retira este componente.

import { FlitCard } from '../../flit/flitPageKit';

export default function HuecoGrafica() {
  return (
    <FlitCard>
      <p className="flex items-center justify-center text-sm" style={{ height: 160, color: 'var(--flit-text-muted)' }}>
        Evolución diaria: próximamente
      </p>
    </FlitCard>
  );
}
