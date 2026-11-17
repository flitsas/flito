// TRAM-OPS-SCALE — filtros alineados con etapas del embudo (misma fuente de verdad).

import { TRAMITE_ETAPAS } from './tramiteEtapas';
import { claseBoton } from '../../components/flit/GradientButton';
import { flitInp } from '../../components/flit/flitPageKit';
import { CHIP_ACTIVO } from './wizard/flitStepKit';

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
    <div className="flex flex-col gap-3 rounded-[9px] border bg-[var(--color-surface-elevated)] p-4" style={{ borderColor: 'var(--color-border)' }}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Buscar por VIN o placa</span>
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar VIN o placa…"
            className={`${flitInp} h-10`}
          />
        </label>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className={claseBoton('secondary', 'md', 'shrink-0')}
            data-variante="secundario"
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
              className="chip chip--sm"
              style={modalidadEntrada === id ? CHIP_ACTIVO : undefined}
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
          className="chip chip--sm"
          style={!etapa ? CHIP_ACTIVO : undefined}
        >
          Todos
        </button>
        {TRAMITE_ETAPAS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => onEtapaChange(etapa === id ? '' : id)}
            className="chip chip--sm"
            style={etapa === id ? CHIP_ACTIVO : undefined}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
