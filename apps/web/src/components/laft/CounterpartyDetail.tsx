import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { useEscape, useBackdropClose } from '../../lib/hooks';
import { Icono } from '../flit/kit/Icono';
import GradientButton from '../flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import { ListaFila } from '../flit/Bloques';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import ModalPortal from '../flit/ModalPortal';

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
/** Veredicto con la pieza `.kit-alerta` (sin `role`: el veredicto ya lo anuncia el toast de la consulta). */
const TONO_ALERTA: Record<Semantic, 'ok' | 'warn' | 'danger' | 'info'> = { success: 'ok', warning: 'warn', danger: 'danger', neutral: 'info' };
const ICONO_ALERTA: Record<Semantic, string> = {
  success: '/kit/aviso-ok.svg', warning: '/kit/aviso-alerta.svg', danger: '/kit/aviso-error.svg', neutral: '/kit/aviso-info.svg',
};

const COLUMNAS_HISTORIAL: ColumnaTabla<ListCheck>[] = [
  { key: 'fecha', header: 'Fecha', render: (c) => <span className="text-xs text-text-secondary">{new Date(c.checkedAt).toLocaleString('es-CO')}</span> },
  {
    key: 'lista',
    header: 'Lista',
    render: (c) => (
      <span className="text-xs text-text-primary">
        {c.listName}
        {c.binding && <span className="ml-1.5 text-[10px] font-semibold text-[color:var(--kit-rojo-texto)]">VIN</span>}
      </span>
    ),
  },
  { key: 'score', header: 'Score', render: (c) => <span className="text-xs font-semibold tabular-nums text-text-primary">{c.matchScore}</span> },
  {
    key: 'resultado',
    header: 'Resultado',
    render: (c) => {
      const kind = KIND_LABEL[c.matchKind] ?? KIND_LABEL.no_match;
      return <StatusChip tone={kind.tone}>{kind.label}</StatusChip>;
    },
  },
];

const SECCION = 'mb-2 text-[0.8125rem] font-semibold text-text-primary';

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
    <ModalPortal>
    <div className="flit-modal kit-velo items-start justify-center p-3 sm:p-6" {...useBackdropClose(onClose)}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Consulta de listas restrictivas"
        className="kit-modal my-auto max-w-3xl"
      >
        <div className="kit-modal__cabeza">
          <Icono nombre="buscar" disco size={52} />
          <div className="min-w-0">
            <h2 className="kit-modal__titulo">Consulta de listas restrictivas</h2>
            <p className="mt-0.5 text-xs text-text-tertiary">Contraparte #{counterpartyId}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="kit-modal__cerrar">
            <Icono nombre="cerrar" size={20} />
          </button>
        </div>

        <div className="kit-modal__cuerpo">
          <GradientButton type="button" onClick={consultar} disabled={checking} className="mb-5 w-full">
            {checking ? 'Consultando 8 listas...' : 'Ejecutar consulta de listas'}
          </GradientButton>

          {lastResult && (
            <div className="kit-alerta mb-5" data-tono={TONO_ALERTA[verdictTone]} data-kit="alerta">
              <img src={ICONO_ALERTA[verdictTone]} alt="" aria-hidden="true" className="kit-alerta__icono" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="m-0 font-semibold">{verdictLabel}</p>
                {lastResult.decision.reason && <p className="mt-1 text-xs text-text-secondary">{lastResult.decision.reason}</p>}
              </div>
            </div>
          )}

          {lastResult && lastResult.matches.length > 0 && (
            <div className="mb-5">
              <p className={SECCION}>Resultado por lista</p>
              <ListaFila
                filas={lastResult.matches.map((m) => {
                  const kind = KIND_LABEL[m.kind] ?? KIND_LABEL.no_match;
                  return {
                    id: String(m.listId),
                    titulo: (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate">{m.listName}</span>
                        {m.binding && <StatusChip tone="danger">VINCULANTE</StatusChip>}
                      </span>
                    ),
                    detalle: m.entryName ? `Match: ${m.entryName} ${m.entryDoc ? `(${m.entryDoc})` : ''}` : undefined,
                    extra: (
                      <span className="ml-auto shrink-0 text-right">
                        <StatusChip tone={kind.tone}>{m.score} / 100</StatusChip>
                        <span className="mt-0.5 block text-[11px] text-text-tertiary">{kind.label}</span>
                      </span>
                    ),
                  };
                })}
              />
            </div>
          )}

          <div>
            <p className={SECCION}>Historial de consultas</p>
            <DataTable
              ariaLabel="Historial de consultas"
              columnas={COLUMNAS_HISTORIAL}
              filas={history}
              getKey={(c) => String(c.id)}
              emptyMessage="Aún no se ha consultado ninguna lista para esta contraparte"
            />
          </div>

          <div className="mt-5 flex justify-end">
            <GradientButton type="button" variant="secondary" onClick={onClose}>Cerrar</GradientButton>
          </div>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
