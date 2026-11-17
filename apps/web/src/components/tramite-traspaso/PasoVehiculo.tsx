// Paso 1 — vehículo y propietario.

import GradientButton from '../flit/GradientButton';
import { Vehiculo } from '../flit/Placa';
import Field from './TraspasoField';
import { PasoCerradoBanner } from './TraspasoBanners';
import type { UseTramiteTraspaso } from './useTramiteTraspaso';

type Props = Pick<UseTramiteTraspaso, 'tramiteId' | 'placa' | 'setPlaca' | 'docPropietario' | 'setDocPropietario' | 'vehiculo' | 'busy' | 'pasoSoloLectura' | 'consultar' | 'radicar'>;

export default function PasoVehiculo({ tramiteId, placa, setPlaca, docPropietario, setDocPropietario, vehiculo, busy, pasoSoloLectura, consultar, radicar }: Props) {
  return (
    <>
      {tramiteId && pasoSoloLectura(1) && <PasoCerradoBanner />}
      <form onSubmit={consultar}>
        <p className="m-0 mb-3 text-base font-bold" style={{ color: 'var(--color-action)' }}>1. Vehículo y propietario</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Placa" value={placa} onChange={setPlaca} maxLength={10} placeholder="ABC123" aria-label="Placa" />
          <Field label="Documento del propietario" value={docPropietario} onChange={setDocPropietario} maxLength={20} placeholder="CC / NIT" aria-label="Documento propietario" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <GradientButton type="submit" disabled={busy || Boolean(tramiteId && pasoSoloLectura(1))}>{busy ? 'Consultando…' : 'Consultar RUNT'}</GradientButton>
        </div>
        {vehiculo && !tramiteId && (
          <div className="mt-5 rounded-[9px] border p-4" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}>
            <Vehiculo antetitulo="Vehículo (RUNT)" placa={placa} nombre={[vehiculo.marca, vehiculo.linea, vehiculo.modelo].filter(Boolean).join(' ') || '—'} />
            <GradientButton type="button" onClick={radicar} disabled={busy} className="mt-3">{busy ? 'Radicando…' : 'Radicar y continuar'}</GradientButton>
          </div>
        )}
      </form>
    </>
  );
}
