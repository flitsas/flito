// TRAM-TRASPASO-F4 — organismo de tránsito para FUR/contrato (matrícula RUNT, no seleccionable).

import { useMemo } from 'react';
import { ORGANISMOS_TRANSITO } from '../../constants/tramite';
import type { OrgTransito } from './wizard/types';

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
        className="rounded-[12px] border p-4"
        style={{
          borderColor: lockedOk ? 'rgba(112,207,58,0.35)' : 'rgba(234, 88, 12, 0.35)',
          background: lockedOk ? 'rgba(112,207,58,0.06)' : 'rgba(234, 88, 12, 0.06)',
        }}
      >
        <p className="mb-1 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          Organismo de tránsito (matrícula RUNT)
        </p>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          En traspaso el organismo es donde está matriculado el vehículo según RUNT. No se puede cambiar.
        </p>

        {runtOrganismo ? (
          <div
            className="rounded-[10px] border px-3 py-2 text-[11px]"
            style={{ borderColor: 'var(--flit-border-soft)', background: 'rgba(255,255,255,0.6)' }}
          >
            <p className="font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
              {runtOrganismo}
            </p>
            {resolved ? (
              <p className="mt-1 font-semibold" style={{ color: 'var(--flit-success)' }}>
                {resolved.nombre} · {resolved.ciudad} · código {resolved.codigo}
              </p>
            ) : (
              <p className="mt-1" style={{ color: 'var(--flit-warning, #ea580c)' }}>
                No se pudo mapear a código DANE. Contacte soporte antes de generar FUR.
              </p>
            )}
          </div>
        ) : (
          <p className="text-[11px]" style={{ color: 'var(--flit-warning, #ea580c)' }}>
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
    <section aria-label="Organismo de tránsito destino" className="rounded-[12px] border p-4" style={{ borderColor: seleccionado ? 'rgba(112,207,58,0.35)' : 'var(--flit-border-soft)', background: seleccionado ? 'rgba(112,207,58,0.06)' : 'transparent' }}>
      <p className="mb-1 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>Organismo de tránsito destino</p>
      <p className="mb-3 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
        Requerido para generar FUR y contrato con datos del organismo correcto.
      </p>

      {runtOrganismo && !seleccionado && (
        <button
          type="button"
          onClick={usarRunt}
          disabled={disabled || !resolved}
          className="flit-focus mb-3 w-full rounded-[10px] border px-3 py-2 text-left text-[11px] disabled:opacity-50"
          style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}
        >
          Usar organismo registrado en RUNT
          <br />
          <span className="font-normal opacity-80">{runtOrganismo}</span>
        </button>
      )}

      <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
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
          className="flit-focus mt-1 w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm outline-none"
          aria-label="Organismo de tránsito destino"
        >
          <option value="">— Elija organismo —</option>
          {ORGANISMOS_TRANSITO.map((o) => (
            <option key={o.codigo} value={o.codigo}>{o.nombre} · {o.ciudad}</option>
          ))}
        </select>
      </label>

      {seleccionado && (
        <p className="mt-2 text-[11px] font-semibold" style={{ color: 'var(--flit-success)' }}>
          {org.nombre} · {org.ciudad} · código {org.codigo}
        </p>
      )}
    </section>
  );
}
