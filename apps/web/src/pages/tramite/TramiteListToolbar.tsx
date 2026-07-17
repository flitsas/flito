// TRAM-OPS-SCALE — filtros alineados con etapas del embudo (misma fuente de verdad).

import { TRAMITE_ETAPAS } from './tramiteEtapas';

interface Props {
  search: string;
  onSearchChange: (v: string) => void;
  etapa: string;
  onEtapaChange: (v: string) => void;
  modalidadEntrada?: string;
  onModalidadChange?: (v: '' | 'matricula_inicial' | 'traspaso') => void;
  onRefresh?: () => void;
  loading?: boolean;
}

export default function TramiteListToolbar({ search, onSearchChange, etapa, onEtapaChange, modalidadEntrada = '', onModalidadChange, onRefresh, loading }: Props) {
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border bg-white p-4" style={{ borderColor: 'var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Buscar por VIN o placa</span>
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar VIN o placa…"
            className="flit-focus h-10 w-full rounded-[12px] border px-3 text-sm outline-none"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          />
        </label>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flit-focus h-10 shrink-0 rounded-[999px] border px-4 text-sm font-medium disabled:opacity-60"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
          >
            {loading ? 'Cargando…' : 'Actualizar'}
          </button>
        )}
      </div>
      {onModalidadChange && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por tipo de trámite">
          {([
            { id: '' as const, label: 'Todos los tipos' },
            { id: 'matricula_inicial' as const, label: 'Matrícula inicial' },
            { id: 'traspaso' as const, label: 'Traspasos STT' },
          ]).map(({ id, label }) => (
            <button
              key={id || 'all'}
              type="button"
              onClick={() => onModalidadChange(id)}
              className="flit-focus h-8 rounded-[999px] border px-3 text-xs font-semibold"
              style={{
                borderColor: modalidadEntrada === id ? 'var(--flit-blue)' : 'var(--flit-border-input)',
                background: modalidadEntrada === id ? 'var(--flit-blue-soft)' : 'white',
                color: modalidadEntrada === id ? 'var(--flit-blue)' : 'var(--flit-text-secondary)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar por etapa (igual que embudo)">
        <button
          type="button"
          onClick={() => onEtapaChange('')}
          className="flit-focus h-8 rounded-[999px] border px-3 text-xs font-semibold"
          style={{
            borderColor: !etapa ? 'var(--flit-blue)' : 'var(--flit-border-input)',
            background: !etapa ? 'var(--flit-blue-soft)' : 'white',
            color: !etapa ? 'var(--flit-blue)' : 'var(--flit-text-secondary)',
          }}
        >
          Todos
        </button>
        {TRAMITE_ETAPAS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onEtapaChange(etapa === id ? '' : id)}
            className="flit-focus h-8 rounded-[999px] border px-3 text-xs font-semibold"
            style={{
              borderColor: etapa === id ? 'var(--flit-blue)' : 'var(--flit-border-input)',
              background: etapa === id ? 'var(--flit-blue-soft)' : 'white',
              color: etapa === id ? 'var(--flit-blue)' : 'var(--flit-text-secondary)',
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
