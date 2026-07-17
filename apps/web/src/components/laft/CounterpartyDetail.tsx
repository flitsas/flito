import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { useEscape, useBackdropClose } from '../../lib/hooks';
import { IconClose } from '../flit/icons';
import StatusChip, { type ChipTone } from '../flit/StatusChip';

interface MatchResult {
  listId: number;
  listCode: string;
  listName: string;
  binding: boolean;
  score: number;
  kind: 'doc_exact' | 'name_strong' | 'name_partial' | 'no_match';
  entryId: number | null;
  entryName: string | null;
  entryDoc: string | null;
}

interface Decision {
  shouldBlock: boolean;
  reason: string | null;
  needsReview: boolean;
  bindingMatches: MatchResult[];
}

interface ListCheck {
  id: number;
  listCode: string;
  listName: string;
  binding: boolean;
  matchScore: number;
  matchKind: string;
  matchEntryId: number | null;
  evidence: { listCode: string; entryName: string | null; entryDoc: string | null; binding: boolean } | null;
  checkedAt: string;
  checkedBy: number | null;
}

interface CheckResponse {
  counterpartyId: number;
  status: string;
  decision: Decision;
  matches: MatchResult[];
  checkedAt: string;
}

const KIND_LABEL: Record<string, { label: string; tone: ChipTone }> = {
  doc_exact: { label: 'Documento exacto', tone: 'danger' },
  name_strong: { label: 'Nombre coincide', tone: 'warning' },
  name_partial: { label: 'Nombre parcial', tone: 'neutral' },
  no_match: { label: 'Sin coincidencia', tone: 'success' },
};

type Semantic = 'success' | 'warning' | 'danger' | 'neutral';
const TONE_COLOR: Record<Semantic, string> = { success: 'var(--flit-success)', warning: 'var(--flit-warning)', danger: 'var(--flit-danger)', neutral: 'var(--flit-text-muted)' };
const TONE_BG: Record<Semantic, string> = { success: 'rgba(112,207,58,0.10)', warning: 'rgba(240,90,53,0.10)', danger: 'rgba(228,61,48,0.10)', neutral: 'var(--flit-bg-app)' };
const TONE_BORDER: Record<Semantic, string> = { success: 'rgba(112,207,58,0.30)', warning: 'rgba(240,90,53,0.30)', danger: 'rgba(228,61,48,0.30)', neutral: 'var(--flit-border-soft)' };

export default function CounterpartyDetail({ counterpartyId, onClose, onChanged }: {
  counterpartyId: number; onClose: () => void; onChanged: () => void;
}) {
  const [history, setHistory] = useState<ListCheck[]>([]);
  const [checking, setChecking] = useState(false);
  const [lastResult, setLastResult] = useState<CheckResponse | null>(null);
  useEscape(onClose);

  const loadHistory = useCallback(async () => {
    try {
      const rows = await api.get<ListCheck[]>(`/laft/lists/checks/${counterpartyId}`);
      setHistory(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error cargando historial');
    }
  }, [counterpartyId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const consultar = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const res = await api.post<CheckResponse>(`/laft/lists/check/${counterpartyId}`, {});
      setLastResult(res);
      if (res.decision.shouldBlock) toast.error(`Bloqueada: ${res.decision.reason}`);
      else if (res.decision.needsReview) toast(`Requiere revisión: ${res.decision.reason ?? ''}`, { icon: '!' });
      else toast.success('Consulta sin coincidencias en listas vinculantes');
      onChanged();
      loadHistory();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error consultando');
    } finally {
      setChecking(false);
    }
  };

  const verdictTone: Semantic = lastResult
    ? lastResult.decision.shouldBlock ? 'danger'
      : lastResult.decision.needsReview ? 'warning'
      : 'success'
    : 'neutral';

  const verdictLabel = lastResult
    ? lastResult.decision.shouldBlock ? 'Bloqueada automáticamente'
      : lastResult.decision.needsReview ? 'Requiere revisión humana'
      : 'Sin coincidencias en listas vinculantes'
    : '';

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4" style={{ background: 'rgba(22, 39, 68, 0.45)', backdropFilter: 'blur(6px)' }} {...useBackdropClose(onClose)}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Consulta de listas restrictivas"
        className="my-8 w-full max-w-3xl"
        style={{ background: 'var(--flit-bg-modal)', borderRadius: 'var(--flit-radius-xl)', boxShadow: 'var(--flit-shadow-modal)', border: '1px solid var(--flit-border-soft)' }}
      >
        <div className="flex items-center justify-between px-8 py-4" style={{ borderBottom: '1px solid var(--flit-border-soft)' }}>
          <div>
            <h2 className="text-lg font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>Consulta de listas restrictivas</h2>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Contraparte #{counterpartyId}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="flit-focus grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-white" style={{ color: 'var(--flit-text-muted)' }}>
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-8 py-5">
          <button
            type="button"
            onClick={consultar}
            disabled={checking}
            className="flit-focus mb-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-[999px] text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-55"
            style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}
          >
            {checking ? 'Consultando 8 listas...' : 'Ejecutar consulta de listas'}
          </button>

          {lastResult && (
            <div className="mb-5 rounded-[12px] p-4" style={{ background: TONE_BG[verdictTone], border: `1px solid ${TONE_BORDER[verdictTone]}` }}>
              <p className="text-sm font-semibold" style={{ color: TONE_COLOR[verdictTone] }}>{verdictLabel}</p>
              {lastResult.decision.reason && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{lastResult.decision.reason}</p>}
            </div>
          )}

          {lastResult && lastResult.matches.length > 0 && (
            <div className="mb-5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Resultado por lista</p>
              <div className="space-y-2">
                {lastResult.matches.map((m) => {
                  const kind = KIND_LABEL[m.kind] ?? KIND_LABEL.no_match;
                  return (
                    <div key={m.listId} className="flex items-center justify-between rounded-[12px] px-4 py-3" style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                          <span className="truncate">{m.listName}</span>
                          {m.binding && <StatusChip tone="danger">VINCULANTE</StatusChip>}
                        </p>
                        {m.entryName && <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--flit-text-muted)' }}>Match: {m.entryName} {m.entryDoc ? `(${m.entryDoc})` : ''}</p>}
                      </div>
                      <div className="ml-4 shrink-0 text-right">
                        <StatusChip tone={kind.tone}>{m.score} / 100</StatusChip>
                        <p className="mt-0.5 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{kind.label}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Historial de consultas</p>
            {history.length === 0 && (
              <p className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }}>Aún no se ha consultado ninguna lista para esta contraparte</p>
            )}
            {history.length > 0 && (
              <div className="overflow-hidden rounded-[12px]" style={{ border: '1px solid var(--flit-border-soft)' }}>
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      {['Fecha', 'Lista', 'Score', 'Resultado'].map((h) => (
                        <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((c) => {
                      const kind = KIND_LABEL[c.matchKind] ?? KIND_LABEL.no_match;
                      return (
                        <tr key={c.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                          <td className="px-3 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>
                            {new Date(c.checkedAt).toLocaleString('es-CO')}
                          </td>
                          <td className="px-3 py-2.5" style={{ color: 'var(--flit-text-primary)' }}>
                            {c.listName}
                            {c.binding && <span className="ml-1.5 text-[10px] font-semibold" style={{ color: 'var(--flit-danger)' }}>VIN</span>}
                          </td>
                          <td className="px-3 py-2.5 font-mono" style={{ color: 'var(--flit-text-primary)' }}>{c.matchScore}</td>
                          <td className="px-3 py-2.5"><StatusChip tone={kind.tone}>{kind.label}</StatusChip></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end px-8 py-4" style={{ borderTop: '1px solid var(--flit-border-soft)' }}>
          <button
            type="button"
            onClick={onClose}
            className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-4 text-sm font-medium"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
