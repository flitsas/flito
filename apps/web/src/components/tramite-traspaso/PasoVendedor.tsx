// Paso 3 — vendedor (titular saliente).

import ParteForm from './ParteForm';
import { PasoCerradoBanner } from './TraspasoBanners';
import type { RuntConsultaPersist } from './tipos';
import type { UseTramiteTraspaso } from './useTramiteTraspaso';

type Props = Pick<UseTramiteTraspaso, 'vendedor' | 'setVendedor' | 'guardarVendedor' | 'busy' | 'vehiculo' | 'pasoSoloLectura'>;

export default function PasoVendedor({ vendedor, setVendedor, guardarVendedor, busy, vehiculo, pasoSoloLectura }: Props) {
  return (
    <>
      {pasoSoloLectura(3) && <PasoCerradoBanner />}
      <ParteForm
        titulo="3. Vendedor (titular saliente)"
        parte={vendedor}
        setParte={setVendedor}
        onContinuar={guardarVendedor}
        busy={busy}
        readOnly={pasoSoloLectura(3)}
        enableOcr
        runtPersistKey="_runtVendedor"
        runtInicial={(vehiculo?._runtVendedor as RuntConsultaPersist | undefined)}
      />
    </>
  );
}
