// Paso 1 — vehículo y propietario.

import GradientButton from '../flit/GradientButton';
import Field from './TraspasoField';
import { PasoCerradoBanner } from './TraspasoBanners';
import type { UseTramiteTraspaso } from './useTramiteTraspaso';

type Props = Pick<UseTramiteTraspaso, 'tramiteId' | 'placa' | 'setPlaca' | 'docPropietario' | 'setDocPropietario' | 'vehiculo' | 'busy' | 'pasoSoloLectura' | 'consultar' | 'radicar'>;

export default function PasoVehiculo({ tramiteId, placa, setPlaca, docPropietario, setDocPropietario, vehiculo, busy, pasoSoloLectura, consultar, radicar }: Props) {
  return (
    <>
      {tramiteId && pasoSoloLectura(1) && <PasoCerradoBanner />}
      <form onSubmit={consultar}>
        <p className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>1. Vehículo y propietario</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Placa" value={placa} onChange={setPlaca} maxLength={10} placeholder="ABC123" aria-label="Placa" />
          <Field label="Documento del propietario" value={docPropietario} onChange={setDocPropietario} maxLength={20} placeholder="CC / NIT" aria-label="Documento propietario" />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <GradientButton type="submit" disabled={busy || Boolean(tramiteId && pasoSoloLectura(1))}>{busy ? 'Consultando…' : 'Consultar RUNT'}</GradientButton>
        </div>
        {vehiculo && !tramiteId && (
          <div className="mt-5 rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
            <p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Vehículo (RUNT)</p>
            <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{[vehiculo.marca, vehiculo.linea, vehiculo.modelo].filter(Boolean).join(' ') || '—'}</p>
            <GradientButton type="button" onClick={radicar} disabled={busy} className="mt-3">{busy ? 'Radicando…' : 'Radicar y continuar'}</GradientButton>
          </div>
        )}
      </form>
    </>
  );
}
