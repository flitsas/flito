import { useState, FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import FlitModal from './flit/FlitModal';
import toast from 'react-hot-toast';

type MultasEstado = 'no_consultado' | 'sin_multas' | 'con_multas' | 'acuerdo_pago';

interface Vehicle {
  id: number; vin: string; plate: string | null; ownerName: string | null;
  brand: string | null; model: string | null; stage: string;
  soatStatus: string | null; policyNumber: string | null;
  multasEstado?: MultasEstado;
  multasTotal?: string | null;
  multasCount?: number | null;
  multasConsultadoAt?: string | null;
}

interface Props {
  vehicles: Vehicle[];
  onRefresh: () => void;
  /** Etiqueta del rango activo (p. ej. "hoy", "1 may – 30 may 2026"). */
  rangoLabel?: string;
  /** Abrir pasaporte / detalle del vehículo (click en fila). */
  onOpenVehicle?: (vehicle: Vehicle) => void;
}

interface Stage { key: string; label: string; tone: 'accent' | 'warning' | 'danger' | 'success' | 'info' | 'success-dark'; }
const stages: Stage[] = [
  { key: 'ingreso', label: 'Ingreso', tone: 'accent' },
  { key: 'impuesto', label: 'Impuesto', tone: 'warning' },
  { key: 'soat_pendiente', label: 'SOAT pendiente', tone: 'danger' },
  { key: 'soat_comprado', label: 'SOAT comprado', tone: 'success' },
  { key: 'soat_verificado', label: 'Verificado RUNT', tone: 'info' },
  { key: 'listo', label: 'Listo', tone: 'success-dark' },
];

const TONE_DOT = 'inline-block rounded-full flex-shrink-0';
const TONE_STYLE: Record<Stage['tone'], { background: string }> = {
  accent: { background: 'var(--flit-blue)' },
  warning: { background: 'var(--flit-warning)' },
  danger: { background: 'var(--flit-danger)' },
  success: { background: 'var(--flit-success)' },
  info: { background: 'var(--flit-blue)' },
  'success-dark': { background: 'var(--flit-success)' },
};
const TONE_LABEL: Record<Stage['tone'], string> = {
  accent: 'var(--flit-blue)',
  warning: 'var(--flit-warning)',
  danger: 'var(--flit-danger)',
  success: 'var(--flit-success)',
  info: 'var(--flit-blue)',
  'success-dark': 'var(--flit-success)',
};

const inputCls =
  'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export default function Pipeline({ vehicles, onRefresh, rangoLabel, onOpenVehicle }: Props) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkMoving, setBulkMoving] = useState(false);
  const [multasTarget, setMultasTarget] = useState<Vehicle | null>(null);
  const [detailTarget, setDetailTarget] = useState<Vehicle | null>(null);

  const safe = vehicles.map((v) => ({ ...v, stage: v.stage || 'ingreso' }));
  const filtered = filter ? safe.filter((v) => v.stage === filter) : safe;
  const total = safe.length;
  const stageIdx = (key: string) => { const i = stages.findIndex((s) => s.key === key); return i >= 0 ? i : 0; };

  const moveStage = async (id: number, stage: string) => {
    try { await api.patch(`/vehicles/${id}/stage`, { stage }); onRefresh(); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  const moveBulk = async (stage: string) => {
    if (selected.size === 0) { toast.error('Selecciona vehículos primero'); return; }
    if (bulkMoving) return;
    setBulkMoving(true);
    const ids = [...selected];
    const label = stages.find((s) => s.key === stage)?.label ?? stage;
    // Promise.allSettled: no abortamos el lote por un fallo individual, pero SÍ
    // reportamos los fallos con veracidad (antes se tragaban con un toast de éxito).
    const results = await Promise.allSettled(
      ids.map((id) => api.patch(`/vehicles/${id}/stage`, { stage })),
    );
    const failedIds = ids.filter((_, i) => results[i].status === 'rejected');
    const moved = ids.length - failedIds.length;
    if (failedIds.length === 0) {
      toast.success(`${moved} vehículo${moved === 1 ? '' : 's'} movido${moved === 1 ? '' : 's'} a ${label}`);
      setSelected(new Set());
    } else {
      // Conservar seleccionados SOLO los que fallaron, para reintentar de inmediato.
      setSelected(new Set(failedIds));
      toast.error(`${moved} movido${moved === 1 ? '' : 's'} · ${failedIds.length} no se pudo mover. Reintenta con los seleccionados.`);
    }
    setBulkMoving(false);
    onRefresh();
  };

  const toggleSelect = (id: number) => {
    setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const selectAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((v) => v.id)));
  };

  return (
    <div>
      <p className="mb-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>
        {total} vehículo{total === 1 ? '' : 's'} en pipeline
        {rangoLabel ? ` · ingresos: ${rangoLabel}` : ' · histórico completo'}
      </p>
      <div className="mb-4 bg-white p-4" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-[var(--flit-shadow-card)])' }}>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-blue-text)' }}>Progreso global</p>
        {/* Barra decorativa: los conteos ya se exponen como texto en la leyenda (abajo),
            por eso la ocultamos del lector de pantalla para no duplicar/confundir. */}
        <div className="flex items-center gap-1 h-3 rounded-full overflow-hidden bg-[color:var(--flit-bg-app)]" aria-hidden="true">
          {stages.map((s) => {
            const count = safe.filter((v) => v.stage === s.key).length;
            const pct = total > 0 ? (count / total) * 100 : 0;
            if (pct === 0) return null;
            return <div key={s.key} className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, ...TONE_STYLE[s.tone] }} title={`${s.label}: ${count}`} />;
          })}
        </div>
        <div className="flex gap-4 mt-3 flex-wrap" role="group" aria-label="Filtrar la tabla por etapa">
          {stages.map((s) => {
            const count = safe.filter((v) => v.stage === s.key).length;
            const dim = filter && filter !== s.key;
            return (
              <button key={s.key} type="button" onClick={() => setFilter(filter === s.key ? '' : s.key)}
                aria-pressed={filter === s.key}
                aria-label={`${s.label}: ${count} vehículo${count === 1 ? '' : 's'}${filter === s.key ? ' (filtro activo)' : ''}`}
                className={`flit-focus flex items-center gap-1.5 text-xs transition-all ${filter === s.key ? 'font-bold flit-tone-primary' : 'flit-tone-muted hover:flit-tone-primary'}`}>
                <span className={`w-2.5 h-2.5 ${TONE_DOT} ${dim ? 'opacity-30' : ''}`} style={TONE_STYLE[s.tone]} />
                <span style={{ color: 'var(--flit-text-muted)' }}>{s.label}</span>
                <span className="font-semibold" style={{ color: TONE_LABEL[s.tone] }}>{count}</span>
              </button>
            );
          })}
          {filter && (
            <button onClick={() => setFilter('')} className="text-[10px] flit-tone-muted hover:flit-tone-primary ml-auto transition-colors">
              Limpiar filtro
            </button>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[12px] border p-3" style={{ borderColor: 'var(--flit-border-soft)', background: 'rgba(0,102,255,0.06)' }} aria-busy={bulkMoving}>
          <span className="text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>{selected.size} seleccionados</span>
          <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            {bulkMoving ? `Moviendo ${selected.size}…` : 'Mover a:'}
          </span>
          {stages.map((s) => (
            <button key={s.key} type="button" onClick={() => moveBulk(s.key)} disabled={bulkMoving}
              className="rounded-[999px] px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed" style={TONE_STYLE[s.tone]}>
              {s.label}
            </button>
          ))}
          <button type="button" onClick={() => setSelected(new Set())} disabled={bulkMoving} className="ml-auto text-[11px] transition-colors disabled:opacity-50" style={{ color: 'var(--flit-text-muted)' }}>Cancelar</button>
        </div>
      )}

      <div className="overflow-hidden bg-white" style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-[var(--flit-shadow-card)])' }}>
        <div className="grid grid-cols-12 items-center gap-2 border-b px-4 py-3" style={{ background: 'var(--flit-bg-table-header)', borderColor: 'var(--flit-border-soft)' }}>
          <div className="col-span-1">
            <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={selectAll}
              aria-label="Seleccionar todos los vehículos visibles"
              className="rounded border-[color:var(--flit-border-soft)]" />
          </div>
          <div className="col-span-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Placa</div>
          <div className="col-span-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Propietario</div>
          <div className="col-span-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Vehículo</div>
          <div className="col-span-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Multas</div>
          <div className="col-span-3 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Progreso</div>
          <div className="col-span-2 text-right text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Acción</div>
        </div>

        <div className="max-h-[60vh] overflow-auto">
          {filtered.length === 0 && (
            <p className="px-4 py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>
              {rangoLabel
                ? `Sin vehículos ingresados (${rangoLabel})`
                : 'Sin vehículos en esta etapa'}
            </p>
          )}
          {filtered.map((v) => {
            const idx = stageIdx(v.stage);
            const currentStage = stages[idx];
            const nextStage = idx < stages.length - 1 ? stages[idx + 1] : null;
            return (
              <div key={v.id} className="group grid grid-cols-12 items-center gap-2 border-t px-4 py-3 transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <div className="col-span-1">
                  <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggleSelect(v.id)}
                    aria-label={`Seleccionar ${v.plate || v.vin}`}
                    className="rounded border-[color:var(--flit-border-soft)]" />
                </div>
                <button
                  type="button"
                  onClick={() => setDetailTarget(v)}
                  className="col-span-3 flit-focus grid grid-cols-3 items-center gap-2 text-left hover:opacity-90"
                  title="Ver etapa del propietario"
                >
                  <span className="col-span-1 text-sm font-semibold flit-tone-primary">{v.plate || '—'}</span>
                  <span className="col-span-2 min-w-0">
                    <span className="block truncate text-xs flit-tone-secondary underline decoration-transparent hover:decoration-[color:var(--flit-blue)]">{v.ownerName || '—'}</span>
                    <span className="block truncate text-[10px] flit-tone-muted">{v.vin}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setDetailTarget(v)}
                  className="col-span-2 flit-focus text-left text-xs flit-tone-secondary hover:opacity-90"
                  title="Ver etapa del vehículo"
                >
                  {[v.brand, v.model].filter(Boolean).join(' ') || '—'}
                </button>
                <div className="col-span-1">
                  <button onClick={() => setMultasTarget(v)} className="block w-full text-left">
                    <MultasBadge v={v} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailTarget(v)}
                  className="col-span-3 flit-focus text-left hover:opacity-90"
                  title="Ver etapa en el pipeline"
                  aria-label={`Ver etapa de ${v.plate || v.vin}: ${currentStage.label}, paso ${idx + 1} de ${stages.length}`}
                >
                  <div className="flex items-center gap-1">
                    {stages.map((s, si) => (
                      <div key={s.key} className="flex items-center gap-1 flex-1">
                        <div className="h-1.5 flex-1 rounded-full" style={si <= idx ? TONE_STYLE[s.tone] : { background: 'var(--flit-border-soft)' }} />
                      </div>
                    ))}
                  </div>
                  <p className="mt-0.5 text-[10px] font-medium" style={{ color: TONE_LABEL[currentStage.tone] }}>{currentStage.label}</p>
                </button>
                <div className="col-span-2 text-right">
                  {nextStage && (
                    <button type="button" onClick={() => moveStage(v.id, nextStage.key)}
                      aria-label={`Avanzar ${v.plate || v.vin} a ${nextStage.label}`}
                      className="flit-focus rounded-[999px] px-3 py-1.5 text-[10px] font-semibold text-white opacity-80 transition-opacity hover:opacity-100 group-hover:opacity-100 focus-visible:opacity-100" style={TONE_STYLE[nextStage.tone]}>
                      {nextStage.label} →
                    </button>
                  )}
                  {!nextStage && (
                    <span className="text-[10px] font-medium text-[color:var(--flit-success)]">Completado</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {detailTarget && (
        <VehicleStageModal
          vehicle={detailTarget}
          onClose={() => setDetailTarget(null)}
          onOpenPasaporte={onOpenVehicle ? (v) => { setDetailTarget(null); onOpenVehicle(v); } : undefined}
        />
      )}

      {multasTarget && (
        <MultasModal vehicle={multasTarget} onClose={() => setMultasTarget(null)} onSaved={() => { setMultasTarget(null); onRefresh(); }} />
      )}
    </div>
  );
}

function VehicleStageModal({ vehicle, onClose, onOpenPasaporte }: {
  vehicle: Vehicle; onClose: () => void; onOpenPasaporte?: (vehicle: Vehicle) => void;
}) {
  const idx = stages.findIndex((s) => s.key === (vehicle.stage || 'ingreso'));
  const current = stages[idx >= 0 ? idx : 0];
  const next = idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : null;

  return (
    <FlitModal title={vehicle.ownerName || vehicle.plate || 'Vehículo en pipeline'} onClose={onClose}>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Propietario</dt>
          <dd className="mt-0.5 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{vehicle.ownerName || '—'}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Placa</dt>
          <dd className="mt-0.5 font-bold" style={{ color: 'var(--flit-text-primary)' }}>{vehicle.plate || '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>VIN</dt>
          <dd className="mt-0.5 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{vehicle.vin}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Vehículo</dt>
          <dd className="mt-0.5" style={{ color: 'var(--flit-text-secondary)' }}>{[vehicle.brand, vehicle.model].filter(Boolean).join(' ') || '—'}</dd>
        </div>
      </dl>

      <div className="mt-5 rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
        <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Etapa actual</p>
        <p className="mt-1 text-lg font-bold" style={{ color: TONE_LABEL[current.tone] }}>{current.label}</p>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Paso {idx + 1} de {stages.length}{next ? ` · siguiente: ${next.label}` : ' · pipeline completado'}
        </p>
        <div className="mt-3 flex items-center gap-1">
          {stages.map((s, si) => (
            <div key={s.key} className="h-2 flex-1 rounded-full" style={si <= idx ? TONE_STYLE[s.tone] : { background: 'var(--flit-border-soft)' }} title={s.label} />
          ))}
        </div>
      </div>

      {vehicle.soatStatus && (
        <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          SOAT: <span className="font-semibold">{vehicle.soatStatus}</span>
          {vehicle.policyNumber ? <span className="ml-1 font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>· {vehicle.policyNumber}</span> : null}
        </p>
      )}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {onOpenPasaporte && (
          <button type="button" onClick={() => onOpenPasaporte(vehicle)} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}>
            Pasaporte vehicular
          </button>
        )}
        <button type="button" onClick={onClose} className="flit-focus inline-flex h-10 items-center rounded-[999px] px-4 text-sm font-semibold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>
          Cerrar
        </button>
      </div>
    </FlitModal>
  );
}

function MultasBadge({ v }: { v: Vehicle }) {
  const estado = v.multasEstado ?? 'no_consultado';
  if (estado === 'no_consultado') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-[10px] font-medium flit-tone-muted hover:flit-tone-primary bg-[color:var(--flit-bg-app)] hover:bg-divider transition-colors">Sin consultar</span>;
  }
  if (estado === 'sin_multas') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-[10px] font-medium flit-success-bg text-[color:var(--flit-success)] hover:opacity-80 transition-opacity">Sin multas</span>;
  }
  if (estado === 'acuerdo_pago') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-pill text-[10px] font-medium flit-warning-bg text-[color:var(--flit-warning)] hover:opacity-80 transition-opacity">Acuerdo</span>;
  }
  const total = Number(v.multasTotal || 0);
  const count = v.multasCount ?? 0;
  return (
    <span className="inline-flex flex-col items-start px-2 py-0.5 rounded-pill text-[10px] font-medium flit-danger-bg text-[color:var(--flit-danger)] hover:opacity-80 leading-tight transition-opacity">
      <span>${total.toLocaleString('es-CO')}</span>
      <span className="text-[9px] font-medium opacity-80">{count} comparendo{count === 1 ? '' : 's'}</span>
    </span>
  );
}

function MultasModal({ vehicle, onClose, onSaved }: { vehicle: Vehicle; onClose: () => void; onSaved: () => void }) {
  const initialEstado: MultasEstado = vehicle.multasEstado === 'no_consultado' ? 'sin_multas' : (vehicle.multasEstado ?? 'sin_multas');
  const [estado, setEstado] = useState<MultasEstado>(initialEstado);
  const [total, setTotal] = useState(vehicle.multasTotal ?? '');
  const [count, setCount] = useState(vehicle.multasCount?.toString() ?? '');
  const [notas, setNotas] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { estado };
      if (estado === 'con_multas') {
        body.total = Number(total) || 0;
        body.count = parseInt(count, 10) || 0;
      }
      if (notas.trim()) body.notas = notas.trim();
      await api.patch(`/vehicles/${vehicle.id}/multas`, body);
      toast.success('Multas registradas');
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally { setSubmitting(false); }
  };

  // FLIT-CLEANUP-08 PR2: modal unificado vía FlitModal (elimina el overlay Aura
  // residual y el header hand-rolled; backdrop/cierre/Esc los aporta FlitModal).
  return (
    <FlitModal title={`Multas SIMIT — ${vehicle.plate ?? ''}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Registre el resultado de la consulta en consultas.simit.org.co</p>
        {vehicle.multasConsultadoAt && (
          <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Última consulta: {new Date(vehicle.multasConsultadoAt).toLocaleString('es-CO')}</p>
        )}

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="block text-xs font-medium flit-tone-secondary mb-1.5">Estado</span>
            <select value={estado} onChange={(e) => setEstado(e.target.value as MultasEstado)} className={inputCls}>
              <option value="sin_multas">Sin multas</option>
              <option value="con_multas">Con multas pendientes</option>
              <option value="acuerdo_pago">Con acuerdo de pago</option>
            </select>
          </label>

          {estado === 'con_multas' && (
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs font-medium flit-tone-secondary mb-1.5">Cantidad</span>
                <input type="number" min={1} max={999} value={count} onChange={(e) => setCount(e.target.value)} required className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-xs font-medium flit-tone-secondary mb-1.5">Total ($ COP)</span>
                <input type="number" min={1} step="100" value={total} onChange={(e) => setTotal(e.target.value)} required className={inputCls} />
              </label>
            </div>
          )}

          <label className="block">
            <span className="block text-xs font-medium flit-tone-secondary mb-1.5">Notas (opcional)</span>
            <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} maxLength={500}
              placeholder="Ej: 2 comparendos por velocidad — Bogotá"
              className={`${inputCls} resize-none`} />
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm disabled:opacity-50" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <button type="submit" disabled={submitting} className="flit-focus inline-flex h-10 items-center rounded-[999px] px-4 text-sm font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)' }}>
            {submitting ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
