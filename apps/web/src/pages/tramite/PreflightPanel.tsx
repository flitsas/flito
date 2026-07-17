// EPIC TRAM-INNOV · A1 / PRE-02 — panel de pre-vuelo (semáforo de requisitos) en el paso 1.
//
// Muestra el resultado del endpoint POST /tramites/preflight: estado global
// (verde/amarillo/rojo) + cada check (SOAT, RTM, comparendos, inscripción RUNT,
// impuesto, LAFT) con su fuente, mensaje y CTA accionable. La CTA es server-driven
// (`check.action`, TRAM-INNOV-PRE-02) — la web no la deriva. Cada click reporta
// telemetría (`onCtaClick` → POST /tramites/:id/preflight/cta).
//
// Estilos: solo tokens/clases FLIT. Presentacional: fetch/estado viven en el wizard.

import toast from 'react-hot-toast';
import type { PreflightAction } from '@operaciones/shared-types';

export interface PreflightCheck {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'unknown';
  source: string;
  message: string;
  // PRE-02: CTA canónica server-driven (la web la consume tal cual).
  action?: PreflightAction | null;
}
export interface LaftScreening {
  status: 'green' | 'yellow' | 'red' | 'unknown';
  matches: number;
  topSignal: string | null;
}
export interface PreflightSnapshot {
  id?: number | null;
  overall?: 'green' | 'yellow' | 'red';
  checks?: PreflightCheck[];
  createdAt?: string;
  // B6: screening LAFT (ahora también llega como checks sintéticos laft_*).
  laftComprador?: LaftScreening | null;
  laftVendedor?: LaftScreening | null;
}

interface Props {
  snapshot: PreflightSnapshot | null;
  loading: boolean;
  onRun: () => void;
  riesgoAceptado: boolean;
  onToggleRiesgo: (v: boolean) => void;
  onGoToStep?: (step: number) => void;
  // PRE-02: telemetría de click en CTA del pre-vuelo.
  onCtaClick?: (checkKey: string, ctaId: string) => void;
}

const CTA_LINK =
  'mt-1.5 inline-block text-[11px] font-semibold underline-offset-2 hover:underline flit-focus rounded-sm border-0 bg-transparent p-0 text-left';

function PreflightCtaButton({ action, onGoToStep, onClick }: { action: PreflightAction; onGoToStep?: (step: number) => void; onClick: () => void }) {
  if (action.kind === 'link') {
    return (
      <a href={action.href} target="_blank" rel="noopener noreferrer" onClick={onClick} className={CTA_LINK} style={{ color: 'var(--flit-blue)' }}>
        {action.label} →
      </a>
    );
  }
  if (action.kind === 'step') {
    return (
      <button type="button" onClick={() => { onClick(); onGoToStep?.(action.step); }} className={CTA_LINK} style={{ color: 'var(--flit-blue)' }}>
        {action.label} →
      </button>
    );
  }
  return (
    <button type="button" onClick={() => { onClick(); toast(action.hint, { icon: 'ℹ️', duration: 5000 }); }} className={CTA_LINK} style={{ color: 'var(--flit-blue)' }}>
      {action.label} →
    </button>
  );
}

const CARD = 'bg-white rounded-[18px] border border-[color:var(--flit-border-soft)] shadow-[0_8px_24px_rgba(22,39,68,0.08)] p-5';

const STATUS_STYLE: Record<PreflightCheck['status'], { dot: string; text: string }> = {
  ok: { dot: 'var(--flit-success)', text: 'var(--flit-success)' },
  warn: { dot: 'var(--flit-warning)', text: 'var(--flit-warning)' },
  fail: { dot: 'var(--flit-danger)', text: 'var(--flit-danger)' },
  unknown: { dot: 'var(--flit-text-muted)', text: 'var(--flit-text-muted)' },
};

const OVERALL: Record<string, { label: string; bg: string; color: string }> = {
  green: { label: 'Pre-vuelo en verde', bg: 'rgba(112,207,58,0.15)', color: 'var(--flit-success)' },
  yellow: { label: 'Pre-vuelo con advertencias', bg: 'rgba(240,90,53,0.15)', color: 'var(--flit-warning)' },
  red: { label: 'Pre-vuelo con bloqueos', bg: 'rgba(228,61,48,0.15)', color: 'var(--flit-danger)' },
};

export default function PreflightPanel({ snapshot, loading, onRun, riesgoAceptado, onToggleRiesgo, onGoToStep, onCtaClick }: Props) {
  const hasResult = !!snapshot?.overall;
  const overall = snapshot?.overall;
  const checks = snapshot?.checks ?? [];
  const ov = overall ? OVERALL[overall] : null;

  return (
    <div className={`${CARD} mt-4`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Pre-vuelo de requisitos</h4>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>SOAT · RTM · comparendos · RUNT · LAFT — antes de avanzar el trámite</p>
        </div>
        <div className="flex items-center gap-2">
          {ov && (
            <span className="shrink-0 rounded-full px-3 py-1 text-xs font-bold" style={{ background: ov.bg, color: ov.color }}>{ov.label}</span>
          )}
          <button
            type="button"
            onClick={onRun}
            disabled={loading}
            className="flit-focus rounded-[999px] border px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}
          >
            {loading ? 'Consultando…' : hasResult ? 'Actualizar' : 'Ejecutar pre-vuelo'}
          </button>
        </div>
      </div>

      {!hasResult && !loading && (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Ejecuta el pre-vuelo para ver el semáforo de requisitos del vehículo y las partes.</p>
      )}

      {hasResult && (
        <ul className="space-y-1.5">
          {checks.map((c) => {
            const s = STATUS_STYLE[c.status];
            return (
              <li key={c.key} className="flex items-start gap-2.5 rounded-[10px] border p-2.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.dot }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{c.label}</span>
                    <span className="text-[10px] uppercase font-bold" style={{ color: s.text }}>{c.status}</span>
                    <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase" style={{ background: 'rgba(79,116,201,0.10)', color: 'var(--flit-blue)' }}>{c.source}</span>
                  </div>
                  <p className="mt-0.5 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{c.message}</p>
                  {c.action && (
                    <PreflightCtaButton
                      action={c.action}
                      onGoToStep={onGoToStep}
                      onClick={() => onCtaClick?.(c.key, c.action!.ctaId)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {overall === 'red' && (
        <label className="mt-3 flex items-start gap-2.5 rounded-[10px] p-3" style={{ background: 'rgba(228,61,48,0.08)', border: '1px solid rgba(228,61,48,0.30)' }}>
          <input
            type="checkbox"
            checked={riesgoAceptado}
            onChange={(e) => onToggleRiesgo(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--flit-danger)]"
          />
          <span className="text-xs font-medium" style={{ color: 'var(--flit-danger)' }}>
            Asumo el riesgo de rechazo en el organismo de tránsito y deseo continuar con el trámite.
          </span>
        </label>
      )}
    </div>
  );
}
