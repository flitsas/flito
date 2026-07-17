// EPIC TRAM-INNOV · A5 — selector de tipología + checklist dinámico.
//
// El catálogo y el cómputo vienen de `@operaciones/shared-types` (misma fuente que
// el backend) → sin fetch y sin riesgo de desincronización. El servidor revalida
// el gate al enviar a tránsito; este componente es la cara visible (UX + progreso).
//
// Estilos: solo tokens/clases FLIT (cero utilidades Aura).

import { useEffect, useState } from 'react';
import {
  computeChecklistWithOverride,
  type ChecklistOverride,
  type ChecklistResultado,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import toast from 'react-hot-toast';
import TipologiaSelectorCards from './TipologiaSelectorCards';
import TipologiaContextBanner from './TipologiaContextBanner';

interface Props {
  tipologiaCodigo: string | null;
  checklistEstado: Record<string, boolean>;
  /** Tipos de documento ya subidos (auto-marcan ítems con docTipo). */
  docTipos: string[];
  onChangeTipologia: (codigo: string) => void;
  onToggleItem: (itemId: string, checked: boolean) => void;
  /** Solo lectura (p.ej. cuando el trámite ya salió a tránsito). */
  readOnly?: boolean;
  /** B2: id del trámite para pedir sugerencias IA (copiloto HITL). */
  tramiteId?: number | null;
  /** TRAM-MT-02 F2: código DIVIPOLA del STT destino (si ya elegido). */
  organismoCodigo?: string | null;
}

interface Sugerencia { itemId: string; mensaje: string; confianza: number }

const CARD = 'bg-white rounded-[18px] border border-[color:var(--flit-border-soft)] shadow-[0_8px_24px_rgba(22,39,68,0.08)] p-5';

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="h-2 w-full rounded-full" style={{ background: 'rgba(22,39,68,0.08)' }}>
      <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, background: 'var(--flit-gradient-success)' }} />
    </div>
  );
}

export default function ChecklistTipologia({
  tipologiaCodigo, checklistEstado, docTipos, onChangeTipologia, onToggleItem, readOnly, tramiteId, organismoCodigo,
}: Props) {
  const [override, setOverride] = useState<ChecklistOverride | null>(null);

  useEffect(() => {
    if (!organismoCodigo || !tipologiaCodigo) {
      setOverride(null);
      return;
    }
    let cancelled = false;
    api.get<{ override: ChecklistOverride }>(`/transito/organismos-config/${organismoCodigo}/checklist/${tipologiaCodigo}`)
      .then((d) => { if (!cancelled) setOverride(d.override ?? null); })
      .catch(() => { if (!cancelled) setOverride(null); });
    return () => { cancelled = true; };
  }, [organismoCodigo, tipologiaCodigo]);

  const res: ChecklistResultado | null = computeChecklistWithOverride(
    tipologiaCodigo, checklistEstado, docTipos, override,
  );
  const [sugerencias, setSugerencias] = useState<Sugerencia[] | null>(null);
  const [disclaimer, setDisclaimer] = useState('');
  const [loadingIa, setLoadingIa] = useState(false);

  const pedirSugerencias = async () => {
    if (!tramiteId) return;
    setLoadingIa(true);
    try {
      const r = await api.post<{ sugerencias: Sugerencia[]; disclaimer: string }>(`/tramites/${tramiteId}/checklist/sugerir`, {});
      setSugerencias(r.sugerencias);
      setDisclaimer(r.disclaimer);
      if (r.sugerencias.length === 0) toast('Sin sugerencias: el checklist ya está completo o no hay pendientes claros.');
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setLoadingIa(false); }
  };

  const labelDe = (itemId: string) => res?.items.find((i) => i.id === itemId)?.label ?? itemId;
  const pendiente = (itemId: string) => !res?.items.find((i) => i.id === itemId)?.satisfecho;

  return (
    <div className={`${CARD} mt-4`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Tipología y checklist</h4>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Selecciona el tipo de trámite para ver los anexos requeridos</p>
        </div>
        <div className="flex items-center gap-2">
          {res && tramiteId && !readOnly && (
            <button type="button" onClick={pedirSugerencias} disabled={loadingIa}
              className="flit-focus rounded-[999px] border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60"
              style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}>
              {loadingIa ? 'Consultando…' : 'Sugerencias IA'}
            </button>
          )}
          {res && (
            <span className="shrink-0 rounded-full px-3 py-1 text-xs font-bold" style={res.completo ? { background: 'rgba(112,207,58,0.15)', color: 'var(--flit-success)' } : { background: 'rgba(240,90,53,0.15)', color: 'var(--flit-warning)' }}>
              {res.satisfechos}/{res.total}
            </span>
          )}
        </div>
      </div>

      {/* B2: copiloto IA — HITL. Cada sugerencia exige clic humano para marcar. */}
      {res && sugerencias && (
        <div className="mb-4 rounded-[12px] p-3" style={{ background: 'rgba(79,116,201,0.06)', border: '1px solid rgba(79,116,201,0.25)' }}>
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(79,116,201,0.15)', color: 'var(--flit-blue)' }}>IA · revisión humana</span>
            <span className="text-[11px] font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>{disclaimer}</span>
          </div>
          {sugerencias.length === 0 ? (
            <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Sin sugerencias pendientes.</p>
          ) : (
            <ul className="space-y-1.5">
              {sugerencias.map((s, i) => (
                <li key={i} className="flex items-start justify-between gap-2 rounded-[10px] bg-white p-2.5" style={{ border: '1px solid var(--flit-border-soft)' }}>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{labelDe(s.itemId)}</p>
                    <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{s.mensaje} · confianza {Math.round(s.confianza * 100)}%</p>
                  </div>
                  {!readOnly && pendiente(s.itemId) && (
                    <button type="button" onClick={() => onToggleItem(s.itemId, true)}
                      className="flit-focus shrink-0 rounded-[999px] px-3 py-1 text-[11px] font-bold text-white" style={{ background: 'var(--flit-gradient-primary)' }}>
                      Marcar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <TipologiaSelectorCards
        selected={tipologiaCodigo}
        readOnly={readOnly}
        onSelect={onChangeTipologia}
      />

      {tipologiaCodigo && (
        <TipologiaContextBanner codigo={tipologiaCodigo} paso={1} className="mt-3" />
      )}

      {/* Checklist de la tipología elegida */}
      {res && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
              Obligatorios: {res.obligatoriosSatisfechos}/{res.obligatoriosTotal}
            </p>
            {res.completo
              ? <span className="text-xs font-semibold" style={{ color: 'var(--flit-success)' }}>Listo para enviar a tránsito</span>
              : <span className="text-xs font-semibold" style={{ color: 'var(--flit-warning)' }}>Faltan obligatorios</span>}
          </div>
          <ProgressBar value={res.obligatoriosSatisfechos} total={res.obligatoriosTotal} />

          <ul className="mt-3 space-y-1.5">
            {res.items.map((it) => {
              const porDoc = it.via === 'documento';
              // Los ítems satisfechos por documento subido se muestran bloqueados
              // (el documento ya los respalda); el resto son toggles manuales.
              const lockedByDoc = porDoc;
              return (
                <li key={it.id} className="flex items-start gap-2.5 rounded-[10px] border p-2.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={it.satisfecho}
                    aria-label={it.label}
                    disabled={readOnly || lockedByDoc}
                    onClick={() => onToggleItem(it.id, !it.satisfecho)}
                    className="flit-focus mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border transition-colors disabled:cursor-not-allowed"
                    style={it.satisfecho
                      ? { background: 'var(--flit-success)', borderColor: 'var(--flit-success)' }
                      : { borderColor: 'var(--flit-border-input)', background: 'white' }}
                  >
                    {it.satisfecho && (
                      <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium" style={{ color: 'var(--flit-text-primary)' }}>{it.label}</span>
                      {it.obligatorio
                        ? <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(240,90,53,0.12)', color: 'var(--flit-warning)' }}>Obligatorio</span>
                        : <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(125,135,152,0.12)', color: 'var(--flit-text-muted)' }}>Opcional</span>}
                      {porDoc && <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>Vía documento</span>}
                    </div>
                    {it.ayuda && (
                      <details className="mt-1 group">
                        <summary className="flit-focus cursor-pointer list-none text-[11px] font-semibold" style={{ color: 'var(--flit-blue)' }}>
                          <span className="group-open:hidden">Ver ayuda normativa</span>
                          <span className="hidden group-open:inline">Ocultar ayuda</span>
                        </summary>
                        <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--flit-text-muted)' }}>{it.ayuda}</p>
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
