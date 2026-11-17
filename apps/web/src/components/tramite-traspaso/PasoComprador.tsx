// Paso 4 — comprador (adquiriente): añade SIMIT bloqueante y el enlace de forzar continuar del admin.

import ParteForm from './ParteForm';
import { PasoCerradoBanner } from './TraspasoBanners';
import type { RuntConsultaPersist } from './tipos';
import type { UseTramiteTraspaso } from './useTramiteTraspaso';

type Props = Pick<UseTramiteTraspaso, 'comprador' | 'setComprador' | 'guardarComprador' | 'busy' | 'vehiculo' | 'isAdmin' | 'forzarActivo' | 'activarForzarContinuar' | 'pasoSoloLectura'>;

export default function PasoComprador({ comprador, setComprador, guardarComprador, busy, vehiculo, isAdmin, forzarActivo, activarForzarContinuar, pasoSoloLectura }: Props) {
  return (
    <>
      {pasoSoloLectura(4) && <PasoCerradoBanner />}
      {isAdmin && !forzarActivo && !pasoSoloLectura(4) && (
        <p className="mb-3 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
          Si el comprador tiene comparendos excepcionales autorizados, el admin puede{' '}
          <button type="button" onClick={() => activarForzarContinuar('SIMIT override paso 4')} disabled={busy}
            className="flit-focus font-semibold underline" style={{ color: 'var(--kit-naranja-texto)' }}>
            forzar continuar
          </button>.
        </p>
      )}
      <ParteForm
        titulo="4. Comprador (adquiriente)"
        parte={comprador}
        setParte={setComprador}
        onContinuar={guardarComprador}
        busy={busy}
        readOnly={pasoSoloLectura(4)}
        enableSimit
        enableOcr
        forzarContinuar={forzarActivo}
        runtPersistKey="_runtComprador"
        runtInicial={(vehiculo?._runtComprador as RuntConsultaPersist | undefined)}
        simitInicial={(vehiculo?._simitComprador as { documento?: string; consultado?: boolean; total?: number; totalMonto?: number } | undefined)}
      />
    </>
  );
}
