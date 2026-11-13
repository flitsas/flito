import { useState, FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import FlitModal from './flit/FlitModal';
import GradientButton from './flit/GradientButton';
import { flitInp } from './flit/flitPageKit';
import { Icono } from './flit/kit/Icono';
import { etiquetaKit, ETIQUETA_PUNTO_CLS, type TonoKit } from './flit/kit/tonos';
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

// UI Kit 2026: cada etapa usa un rol del manual (relleno para puntos/barras, texto AA para cifras) y su tono de
// etiqueta con punta (`etiquetaKit`). Sin HEX: los pares claro/oscuro los dan los tokens `--kit-*`.
const TONE_DOT = 'inline-block rounded-full flex-shrink-0';
const TONE_STYLE: Record<Stage['tone'], { background: string }> = {
  accent: { background: 'var(--kit-azul)' },
  warning: { background: 'var(--kit-naranja)' },
  danger: { background: 'var(--kit-rojo)' },
  success: { background: 'var(--kit-verde)' },
  info: { background: 'var(--kit-turquesa)' },
  'success-dark': { background: 'var(--kit-verde)' },
};
const TONE_LABEL: Record<Stage['tone'], string> = {
  accent: 'var(--color-action)',
  warning: 'var(--kit-naranja-texto)',
  danger: 'var(--kit-rojo-texto)',
  success: 'var(--kit-verde-texto)',
  info: 'var(--kit-turquesa-texto)',
  'success-dark': 'var(--kit-verde-texto)',
};
const TONE_KIT: Record<Stage['tone'], TonoKit> = {
  accent: 'info', warning: 'warn', danger: 'danger', success: 'ok', info: 'info', 'success-dark': 'ok',
};

const inputCls = flitInp;
const TH = 'hidden md:block text-xs font-semibold text-[color:var(--color-text-secondary)]';

/**
 * Avance de la etapa con el lenguaje `.pasos` del kit (PasosHorizontal): la línea pasa por debajo y por el centro
 * de los círculos; hecho = disco verde con check, actual = blanco con borde azul y aro de 4 px. Decorativo: el
 * texto «Paso N de M» que lo acompaña ya lo dice (por eso `aria-hidden`).
 */
function PasosEtapa({ actual }: { actual: number }) {
  return (
    <ol className="kit-pasos !px-0" data-kit="pasos" aria-hidden="true">
      {stages.map((s, si) => {
        const estado = si < actual ? 'hecho' : si === actual ? 'actual' : 'pendiente';
        return (
          <li key={s.key} className="kit-paso" data-estado={estado}>
            <span className="kit-paso__boton">
              <span className="kit-paso__num">{estado === 'hecho' ? <Icono nombre="check" size={18} /> : si + 1}</span>
              <span className="kit-paso__etiqueta text-xs">{s.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

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
      <p className="mb-2 text-xs tabular-nums text-[color:var(--color-text-tertiary)]">
        {total} vehículo{total === 1 ? '' : 's'} en pipeline
        {rangoLabel ? ` · ingresos: ${rangoLabel}` : ' · histórico completo'}
      </p>
      <div className="mb-4 rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)] p-4">
        <p className="mb-3 text-sm font-semibold text-[color:var(--color-text-primary)]">Progreso global</p>
        {/* Barra decorativa: los conteos ya se exponen como texto en la leyenda (abajo),
            por eso la ocultamos del lector de pantalla para no duplicar/confundir. */}
        <div className="flex items-center gap-1 h-3 rounded-full overflow-hidden bg-[color:var(--kit-hover)]" aria-hidden="true">
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
                className={`flit-focus flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors hover:bg-[color:var(--kit-hover)] ${filter === s.key ? 'border-[color:var(--kit-azul)] font-bold text-[color:var(--color-text-primary)]' : 'border-[color:var(--color-border)] text-[color:var(--color-text-secondary)]'}`}>
                <span className={`w-2.5 h-2.5 ${TONE_DOT} ${dim ? 'opacity-30' : ''}`} style={TONE_STYLE[s.tone]} />
                <span className="text-[color:var(--color-text-secondary)]">{s.label}</span>
                <span className="font-semibold" style={{ color: TONE_LABEL[s.tone] }}>{count}</span>
              </button>
            );
          })}
          {filter && (
            <button onClick={() => setFilter('')} className="flit-focus ml-auto rounded-[9px] px-2 text-xs text-[color:var(--color-action)] underline-offset-2 transition-colors hover:underline">
              Limpiar filtro
            </button>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[9px] border border-[color:var(--kit-azul)] bg-[color:color-mix(in_srgb,var(--kit-azul)_10%,var(--color-surface-elevated))] p-3" aria-busy={bulkMoving}>
          <span className="text-xs font-semibold text-[color:var(--color-action)]">{selected.size} seleccionados</span>
          <span className="text-xs text-[color:var(--color-text-secondary)]">
            {bulkMoving ? `Moviendo ${selected.size}…` : 'Mover a:'}
          </span>
          {stages.map((s) => (
            <GradientButton key={s.key} type="button" variant="secondary" size="sm" onClick={() => moveBulk(s.key)} disabled={bulkMoving}>
              <span className={`w-2 h-2 ${TONE_DOT}`} style={TONE_STYLE[s.tone]} aria-hidden="true" />
              {s.label}
            </GradientButton>
          ))}
          <GradientButton type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={bulkMoving} className="ml-auto">Cancelar</GradientButton>
        </div>
      )}

      <div className="overflow-hidden rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)]">
        <div className="grid grid-cols-12 items-center gap-2 border-b border-[color:var(--kit-linea)] bg-[color:var(--kit-hover)] px-4 py-3">
          <div className="col-span-1">
            <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={selectAll}
              aria-label="Seleccionar todos los vehículos visibles"
              className="rounded border-[color:var(--color-border-control)] accent-[color:var(--kit-azul)]" />
          </div>
          <div className={`col-span-1 ${TH}`}>Placa</div>
          <div className={`col-span-2 ${TH}`}>Propietario</div>
          <div className={`col-span-2 ${TH}`}>Vehículo</div>
          <div className={`col-span-1 ${TH}`}>Multas</div>
          <div className={`col-span-3 ${TH}`}>Progreso</div>
          <div className={`col-span-2 text-right ${TH}`}>Acción</div>
        </div>

        <div className="max-h-[60vh] overflow-auto">
          {filtered.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-[color:var(--color-text-tertiary)]">
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
              <div key={v.id} className="group grid grid-cols-[auto_1fr] md:grid-cols-12 items-center gap-2 border-t px-4 py-3 border-[color:var(--color-divider)] transition-colors hover:bg-[color:var(--kit-hover)]">
                <div className="md:col-span-1">
                  <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggleSelect(v.id)}
                    aria-label={`Seleccionar ${v.plate || v.vin}`}
                    className="rounded border-[color:var(--color-border-control)] accent-[color:var(--kit-azul)]" />
                </div>
                <button
                  type="button"
                  onClick={() => setDetailTarget(v)}
                  className="md:col-span-3 flit-focus grid grid-cols-1 sm:grid-cols-3 items-center gap-2 rounded-[9px] text-left transition-colors hover:bg-[color:var(--kit-hover)]"
                  title="Ver etapa del propietario"
                >
                  <span className="col-span-1 text-sm font-semibold text-[color:var(--color-text-primary)]">{v.plate || '—'}</span>
                  <span className="col-span-2 min-w-0">
                    <span className="block truncate text-xs text-[color:var(--color-text-secondary)] underline decoration-transparent transition-colors hover:decoration-[color:var(--kit-azul)]">{v.ownerName || '—'}</span>
                    <span className="block truncate text-[11px] text-[color:var(--color-text-tertiary)]">{v.vin}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setDetailTarget(v)}
                  className="col-span-2 md:col-span-2 flit-focus text-left text-xs text-[color:var(--color-text-secondary)] transition-colors hover:text-[color:var(--color-action)]"
                  title="Ver etapa del vehículo"
                >
                  {[v.brand, v.model].filter(Boolean).join(' ') || '—'}
                </button>
                <div className="col-span-2 md:col-span-1">
                  <button onClick={() => setMultasTarget(v)} className="flit-focus block w-full rounded-[9px] text-left">
                    <MultasBadge v={v} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailTarget(v)}
                  className="col-span-2 md:col-span-3 flit-focus rounded-[9px] text-left transition-colors hover:bg-[color:var(--kit-hover)]"
                  title="Ver etapa en el pipeline"
                  aria-label={`Ver etapa de ${v.plate || v.vin}: ${currentStage.label}, paso ${idx + 1} de ${stages.length}`}
                >
                  <div className="flex items-center gap-1">
                    {stages.map((s, si) => (
                      <div key={s.key} className="flex items-center gap-1 flex-1">
                        <div className="h-1.5 flex-1 rounded-full" style={{ background: si < idx ? 'var(--kit-verde)' : si === idx ? 'var(--kit-azul)' : 'var(--kit-linea)' }} />
                      </div>
                    ))}
                  </div>
                  <span {...etiquetaKit(TONE_KIT[currentStage.tone], { className: 'mt-1' })}><span className={ETIQUETA_PUNTO_CLS} aria-hidden="true" />{currentStage.label}</span>
                </button>
                <div className="col-span-2 text-left md:text-right">
                  {nextStage && (
                    <GradientButton type="button" size="sm" onClick={() => moveStage(v.id, nextStage.key)}
                      aria-label={`Avanzar ${v.plate || v.vin} a ${nextStage.label}`}>
                      {nextStage.label} →
                    </GradientButton>
                  )}
                  {!nextStage && (
                    <span {...etiquetaKit('ok')}><span className={ETIQUETA_PUNTO_CLS} aria-hidden="true" />Completado</span>
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
          <dt className="text-xs font-semibold text-[color:var(--color-text-tertiary)]">Propietario</dt>
          <dd className="mt-0.5 font-medium text-[color:var(--color-text-primary)]">{vehicle.ownerName || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold text-[color:var(--color-text-tertiary)]">Placa</dt>
          <dd className="mt-0.5 font-bold text-[color:var(--color-text-primary)]">{vehicle.plate || '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold text-[color:var(--color-text-tertiary)]">VIN</dt>
          <dd className="mono mt-0.5 text-xs text-[color:var(--color-text-secondary)]">{vehicle.vin}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold text-[color:var(--color-text-tertiary)]">Vehículo</dt>
          <dd className="mt-0.5 text-[color:var(--color-text-secondary)]">{[vehicle.brand, vehicle.model].filter(Boolean).join(' ') || '—'}</dd>
        </div>
      </dl>

      <div className="mt-5 rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
        <p className="text-xs font-semibold text-[color:var(--color-text-tertiary)]">Etapa actual</p>
        <p className="mt-1 text-lg font-bold" style={{ color: TONE_LABEL[current.tone] }}>{current.label}</p>
        <p className="mt-0.5 text-xs text-[color:var(--color-text-tertiary)]">
          Paso {idx + 1} de {stages.length}{next ? ` · siguiente: ${next.label}` : ' · pipeline completado'}
        </p>
        <div className="mt-3">
          <PasosEtapa actual={idx >= 0 ? idx : 0} />
        </div>
      </div>

      {vehicle.soatStatus && (
        <p className="mt-3 text-xs text-[color:var(--color-text-secondary)]">
          SOAT: <span className="font-semibold">{vehicle.soatStatus}</span>
          {vehicle.policyNumber ? <span className="mono ml-1 text-[11px] text-[color:var(--color-text-tertiary)]">· {vehicle.policyNumber}</span> : null}
        </p>
      )}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {onOpenPasaporte && (
          <GradientButton type="button" variant="secondary" onClick={() => onOpenPasaporte(vehicle)}>
            Pasaporte vehicular
          </GradientButton>
        )}
        <GradientButton type="button" onClick={onClose}>
          Cerrar
        </GradientButton>
      </div>
    </FlitModal>
  );
}

function MultasBadge({ v }: { v: Vehicle }) {
  const estado = v.multasEstado ?? 'no_consultado';
  if (estado === 'no_consultado') {
    return <span {...etiquetaKit('neutro')}><span className={ETIQUETA_PUNTO_CLS} aria-hidden="true" />Sin consultar</span>;
  }
  if (estado === 'sin_multas') {
    return <span {...etiquetaKit('ok')}><span className={ETIQUETA_PUNTO_CLS} aria-hidden="true" />Sin multas</span>;
  }
  if (estado === 'acuerdo_pago') {
    return <span {...etiquetaKit('warn')}><span className={ETIQUETA_PUNTO_CLS} aria-hidden="true" />Acuerdo</span>;
  }
  const total = Number(v.multasTotal || 0);
  const count = v.multasCount ?? 0;
  return (
    <span {...etiquetaKit('danger', { className: '!h-auto flex-col !items-start py-0.5 leading-tight' })}>
      <span>${total.toLocaleString('es-CO')}</span>
      <span className="text-[11px] font-medium">{count} comparendo{count === 1 ? '' : 's'}</span>
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
        <p className="text-xs text-[color:var(--color-text-tertiary)]">Registre el resultado de la consulta en consultas.simit.org.co</p>
        {vehicle.multasConsultadoAt && (
          <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">Última consulta: {new Date(vehicle.multasConsultadoAt).toLocaleString('es-CO')}</p>
        )}

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-[color:var(--color-text-secondary)] mb-1.5">Estado</span>
            <select value={estado} onChange={(e) => setEstado(e.target.value as MultasEstado)} className={inputCls}>
              <option value="sin_multas">Sin multas</option>
              <option value="con_multas">Con multas pendientes</option>
              <option value="acuerdo_pago">Con acuerdo de pago</option>
            </select>
          </label>

          {estado === 'con_multas' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="block text-xs font-medium text-[color:var(--color-text-secondary)] mb-1.5">Cantidad</span>
                <input type="number" min={1} max={999} value={count} onChange={(e) => setCount(e.target.value)} required className={inputCls} />
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-[color:var(--color-text-secondary)] mb-1.5">Total ($ COP)</span>
                <input type="number" min={1} step="100" value={total} onChange={(e) => setTotal(e.target.value)} required className={inputCls} />
              </label>
            </div>
          )}

          <label className="block">
            <span className="block text-xs font-medium text-[color:var(--color-text-secondary)] mb-1.5">Notas (opcional)</span>
            <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} maxLength={500}
              placeholder="Ej: 2 comparendos por velocidad — Bogotá"
              className={`${inputCls} resize-none`} />
          </label>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" variant="secondary" onClick={onClose} disabled={submitting}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>
            {submitting ? 'Guardando...' : 'Guardar'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
