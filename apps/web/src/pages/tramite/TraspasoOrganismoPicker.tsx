// TRAM-TRASPASO-F4 — organismo de tránsito para FUR/contrato (matrícula RUNT, no seleccionable).

import { useMemo } from 'react';
import { ORGANISMOS_TRANSITO } from '../../constants/tramite';
import type { OrgTransito } from './wizard/types';
import { flitInp } from '../../components/flit/flitPageKit';

const EMPTY: OrgTransito = { nombre: '', ciudad: '', codigo: '' };

interface Props {
  org: OrgTransito;
  onChange: (org: OrgTransito) => void;
  runtOrganismo?: string | null;
  disabled?: boolean;
  /** En traspaso el organismo es el de matrícula RUNT; no se permite elegir otro. */
  lockToRunt?: boolean;
}

/** Intenta resolver código DANE desde el nombre RUNT del vehículo. */
export function resolveOrgFromRuntName(name: string | null | undefined): OrgTransito | null {
  if (!name?.trim()) return null;
  const norm = name.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const sorted = [...ORGANISMOS_TRANSITO].sort((a, b) => b.nombre.length - a.nombre.length);
  for (const o of sorted) {
    const key = o.nombre.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const city = o.ciudad.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (key.length >= 4 && norm.includes(key.slice(-Math.min(key.length, 12)))) {
      return { nombre: o.nombre, ciudad: o.ciudad, codigo: o.codigo };
    }
    if (city.length >= 3 && norm.includes(city)) {
      return { nombre: o.nombre, ciudad: o.ciudad, codigo: o.codigo };
    }
  }
  return null;
}

export default function TraspasoOrganismoPicker({
  org,
  onChange,
  runtOrganismo,
  disabled,
  lockToRunt = true,
}: Props) {
  const resolved = useMemo(() => resolveOrgFromRuntName(runtOrganismo), [runtOrganismo]);
  const seleccionado = Boolean(org.codigo);
  const lockedOk = lockToRunt && Boolean(resolved?.codigo);

  if (lockToRunt) {
    return (
      <section
        aria-label="Organismo de tránsito matrícula RUNT"
        className="rounded-[9px] border p-4"
        style={{
          borderColor: lockedOk ? 'color-mix(in srgb, var(--kit-verde) 35%, transparent)' : 'color-mix(in srgb, var(--kit-naranja) 35%, transparent)',
          background: lockedOk ? 'color-mix(in srgb, var(--kit-verde) 6%, transparent)' : 'color-mix(in srgb, var(--kit-naranja) 6%, transparent)',
        }}
      >
        <p className="mb-1 text-xs font-bold" style={{ color: 'var(--color-action)' }}>
          Organismo de tránsito (matrícula RUNT)
        </p>
        <p className="mb-3 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
          En traspaso el organismo es donde está matriculado el vehículo según RUNT. No se puede cambiar.
        </p>

        {runtOrganismo ? (
          <div
            className="rounded-[9px] border px-3 py-2 text-xs"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-elevated)' }}
          >
            <p className="font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
              {runtOrganismo}
            </p>
            {resolved ? (
              <p className="mt-1 font-semibold" style={{ color: 'var(--kit-verde-texto)' }}>
                {resolved.nombre} · {resolved.ciudad} · código {resolved.codigo}
              </p>
            ) : (
              <p className="mt-1" style={{ color: 'var(--kit-naranja-texto)' }}>
                No se pudo mapear a código DANE. Contacte soporte antes de generar FUR.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--kit-naranja-texto)' }}>
            Consulte el vehículo en RUNT (paso 1) para obtener el organismo de matrícula.
          </p>
        )}
      </section>
    );
  }

  const usarRunt = () => {
    if (resolved) onChange(resolved);
  };

  return (
    <section aria-label="Organismo de tránsito destino" className="rounded-[9px] border p-4" style={{ borderColor: seleccionado ? 'color-mix(in srgb, var(--kit-verde) 35%, transparent)' : 'var(--color-border)', background: seleccionado ? 'color-mix(in srgb, var(--kit-verde) 6%, transparent)' : 'transparent' }}>
      <p className="mb-1 text-xs font-bold" style={{ color: 'var(--color-action)' }}>Organismo de tránsito destino</p>
      <p className="mb-3 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
        Requerido para generar FUR y contrato con datos del organismo correcto.
      </p>

      {runtOrganismo && !seleccionado && (
        <button
          type="button"
          onClick={usarRunt}
          disabled={disabled || !resolved}
          className="flit-focus mb-3 w-full rounded-[9px] border bg-[var(--color-surface-elevated)] px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--kit-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          style={{ borderColor: 'var(--kit-azul)', color: 'var(--color-action)' }}
        >
          Usar organismo registrado en RUNT
          <br />
          <span className="font-normal opacity-80">{runtOrganismo}</span>
        </button>
      )}

      <label className="block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Seleccionar organismo
        <select
          value={org.codigo || ''}
          disabled={disabled}
          onChange={(e) => {
            const codigo = e.target.value;
            if (!codigo) { onChange(EMPTY); return; }
            const o = ORGANISMOS_TRANSITO.find((x) => x.codigo === codigo);
            onChange(o ? { nombre: o.nombre, ciudad: o.ciudad, codigo: o.codigo } : EMPTY);
          }}
          className={`mt-1 ${flitInp}`}
          aria-label="Organismo de tránsito destino"
        >
          <option value="">— Elija organismo —</option>
          {ORGANISMOS_TRANSITO.map((o) => (
            <option key={o.codigo} value={o.codigo}>{o.nombre} · {o.ciudad}</option>
          ))}
        </select>
      </label>

      {seleccionado && (
        <p className="mt-2 text-xs font-semibold" style={{ color: 'var(--kit-verde-texto)' }}>
          {org.nombre} · {org.ciudad} · código {org.codigo}
        </p>
      )}
    </section>
  );
}
