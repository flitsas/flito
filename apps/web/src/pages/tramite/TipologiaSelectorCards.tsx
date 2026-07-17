// TRAM-TIPO-02 UX — selector de tipología estilo SelectCard (FLIT p.14).

import { TRAMITE_TIPOLOGIAS, getJourney } from '@operaciones/shared-types';

/** Acento visual por código (FLIT — sin iconos sólidos decorativos). */
const TIPO_ACCENT: Record<string, string> = {
  traspaso_standard: 'var(--flit-blue)',
  sucesion: 'var(--flit-text-muted)',
  remate: 'var(--flit-warning)',
  flota_corporativa: 'var(--flit-cyan)',
  importacion: 'var(--flit-cyan)',
};

function TipoGlyph({ codigo }: { codigo: string }) {
  const stroke = TIPO_ACCENT[codigo] ?? 'var(--flit-blue)';
  const common = { fill: 'none', viewBox: '0 0 24 24', stroke, strokeWidth: 1.6, className: 'h-5 w-5 shrink-0' };
  switch (codigo) {
    case 'remate':
      return (
        <svg {...common} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 9.75L16.5 12m0 0l2.25 2.25M16.5 12l2.25-2.25M16.5 12l-2.25 2.25M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
        </svg>
      );
    case 'importacion':
      return (
        <svg {...common} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5a17.92 17.92 0 01-8.716-2.247m0 0A8.966 8.966 0 013 12c0-1.564.38-3.04 1.053-4.332" />
        </svg>
      );
    case 'flota_corporativa':
      return (
        <svg {...common} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15l-.75 9H5.25L4.5 3zM9 21v-4.5h6V21" />
        </svg>
      );
    case 'sucesion':
      return (
        <svg {...common} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l-.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
        </svg>
      );
    default:
      return (
        <svg {...common} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375A1.125 1.125 0 012 17.625v-9.75A1.125 1.125 0 013.375 6.75h17.25A1.125 1.125 0 0121.75 7.875v9.75A1.125 1.125 0 0120.625 18.75H17m-9 0V9.75m0 0h3.75M8.25 9.75H12m7.5 0V9.75m0 0h-3.75M15 9.75H12" />
        </svg>
      );
  }
}

interface Props {
  selected: string | null;
  readOnly?: boolean;
  onSelect: (codigo: string) => void;
}

export default function TipologiaSelectorCards({ selected, readOnly, onSelect }: Props) {
  return (
    <div role="radiogroup" aria-label="Tipo de trámite" className="grid gap-2 sm:grid-cols-2">
      {TRAMITE_TIPOLOGIAS.map((t) => {
        const isSelected = t.codigo === selected;
        const journey = getJourney(t.codigo);
        const accent = TIPO_ACCENT[t.codigo] ?? 'var(--flit-blue)';
        return (
          <button
            key={t.codigo}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={readOnly}
            onClick={() => onSelect(t.codigo)}
            className="flit-focus flex items-start gap-3 rounded-[14px] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={isSelected
              ? { borderColor: accent, background: 'rgba(79,116,201,0.08)', boxShadow: '0 0 0 1px rgba(79,116,201,0.15)' }
              : { borderColor: 'var(--flit-border-soft)', background: 'white' }}
          >
            <TipoGlyph codigo={t.codigo} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold" style={{ color: isSelected ? 'var(--flit-blue-text)' : 'var(--flit-text-primary)' }}>
                {t.nombre}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug" style={{ color: 'var(--flit-text-muted)' }}>
                {t.descripcion}
              </p>
              {journey && (
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
                  {journey.adquirente.label}
                  {!journey.vendedorRequerido ? ' · sin vendedor' : ''}
                </p>
              )}
            </div>
            {isSelected && (
              <span className="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(79,116,201,0.15)', color: 'var(--flit-blue)' }}>
                Activo
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
