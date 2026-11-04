// Paso 5 — datos comerciales.

import TraspasoStepComercial, { type ComercialData } from '../../pages/tramite/TraspasoStepComercial';
import { PasoCerradoBanner } from './TraspasoBanners';
import type { UseTramiteTraspaso } from './useTramiteTraspaso';

type Props = Pick<UseTramiteTraspaso, 'vehiculo' | 'valorVenta' | 'causal' | 'observaciones' | 'busy' | 'pasoSoloLectura' | 'guardarComercial'>;

export default function PasoComercial({ vehiculo, valorVenta, causal, observaciones, busy, pasoSoloLectura, guardarComercial }: Props) {
  return (
    <>
      {pasoSoloLectura(5) && <PasoCerradoBanner />}
      <TraspasoStepComercial
        vehiculo={vehiculo ?? {}}
        inicial={(vehiculo?._comercial as Partial<ComercialData>) || { valorVenta: Number(valorVenta) || 0, causal, observaciones }}
        busy={busy}
        readOnly={pasoSoloLectura(5)}
        onGuardar={guardarComercial}
      />
    </>
  );
}
