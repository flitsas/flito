import {
  fechaHoyColombia, restarDias, normalizarRango, type RangoFechas,
} from '../../lib/dateColombia';

interface Props {
  rango: RangoFechas | null;
  onChange: (rango: RangoFechas | null) => void;
  loading?: boolean;
  /** Texto bajo el título. */
  descripcion?: string;
}

export default function RangoFechaFilter({ rango, onChange, loading, descripcion }: Props) {
  const hoy = fechaHoyColombia();

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border bg-white p-4" style={{ borderColor: 'var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Rango de ingreso</p>
          <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
            {descripcion ?? 'Filtra por fecha de registro en el sistema (hora Colombia).'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {([
            { key: 'hoy', label: 'Hoy', active: rango?.desde === hoy && rango?.hasta === hoy, onClick: () => onChange({ desde: hoy, hasta: hoy }) },
            { key: '7d', label: '7 días', active: rango?.desde === restarDias(hoy, 6) && rango?.hasta === hoy, onClick: () => onChange({ desde: restarDias(hoy, 6), hasta: hoy }) },
            { key: 'todos', label: 'Todos', active: !rango, onClick: () => onChange(null) },
          ]).map(({ key, label, active, onClick }) => (
            <button
              key={key}
              type="button"
              onClick={onClick}
              className="flit-focus h-8 rounded-[999px] border px-3 text-xs font-semibold"
              style={{
                borderColor: active ? 'var(--flit-blue)' : 'var(--flit-border-input)',
                background: active ? 'var(--flit-blue-soft)' : 'white',
                color: active ? 'var(--flit-blue)' : 'var(--flit-text-secondary)',
              }}
            >
              {label}
            </button>
          ))}
          {loading && <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</span>}
        </div>
      </div>
      {rango && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>
            Desde
            <input
              type="date"
              value={rango.desde}
              max={rango.hasta}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                onChange(normalizarRango(v, rango.hasta));
              }}
              className="flit-focus h-8 rounded-[10px] border px-2 text-xs"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
            />
          </label>
          <span className="hidden pb-1 text-xs sm:inline" style={{ color: 'var(--flit-text-muted)' }}>→</span>
          <label className="flex flex-col gap-1 text-xs font-medium" style={{ color: 'var(--flit-text-secondary)' }}>
            Hasta
            <input
              type="date"
              value={rango.hasta}
              min={rango.desde}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                onChange(normalizarRango(rango.desde, v));
              }}
              className="flit-focus h-8 rounded-[10px] border px-2 text-xs"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
