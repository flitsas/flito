// TRAM-INNOV-B3 — panel «Firma electrónica» del wizard (gestor) para traspaso_standard.
// Lista las firmas del trámite y permite solicitar por rol pendiente.

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import StatusChip, { type ChipTone } from '../../components/flit/StatusChip';

export interface Firma { id: number; rol: string; estado: string; proveedor: string }

const ESTADO_TONE: Record<string, ChipTone> = {
  pendiente_envio: 'neutral', enviada: 'active', firmada: 'success', rechazada: 'danger', cancelada: 'neutral',
};
const ESTADO_LABEL: Record<string, string> = {
  pendiente_envio: 'Pendiente de envío', enviada: 'Enviada', firmada: 'Firmada', rechazada: 'Rechazada', cancelada: 'Cancelada',
};
const ACTIVOS = ['pendiente_envio', 'enviada', 'firmada'];
const ROLES = ['comprador', 'vendedor'] as const;

export default function FirmaPanel({ tramiteId, disabled, disabledHint, onFirmasChange }: {
  tramiteId: number;
  disabled?: boolean;
  disabledHint?: string;
  /** Dual-actor: notifica las firmas al paso 6 (gate de cierre de gestión STT). */
  onFirmasChange?: (firmas: Firma[]) => void;
}) {
  const [firmas, setFirmas] = useState<Firma[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ firmas: Firma[] }>(`/tramites/${tramiteId}/firma`);
      const list = Array.isArray(r.firmas) ? r.firmas : [];
      setFirmas(list);
      onFirmasChange?.(list);
    } catch { /* silencioso */ } finally { setLoading(false); }
  }, [tramiteId, onFirmasChange]);

  useEffect(() => { load(); }, [load]);

  const solicitar = async (rol: string) => {
    if (submitting) return;
    setSubmitting(rol);
    try {
      await api.post(`/tramites/${tramiteId}/firma/solicitar`, { rol });
      toast.success(`Firma solicitada al ${rol}`);
      await load();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSubmitting(null); }
  };

  const activaDe = (rol: string) => firmas.find((f) => f.rol === rol && ACTIVOS.includes(f.estado));

  return (
    <section aria-label="Firma electrónica" className="rounded-[12px] border p-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <p className="mb-2 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>
        Firma electrónica del contrato de compraventa
      </p>
      <p className="mb-2 rounded-[8px] px-3 py-2 text-[11px]" style={{ background: 'rgba(79,116,201,0.08)', color: 'var(--flit-text-secondary)' }}>
        <strong>Firma electrónica ≠ validación biométrica.</strong> La biometría (arriba) valida identidad para RUNT/FUR. La firma es un paso aparte sobre el PDF del contrato.
      </p>
      {disabled && (
        <p className="mb-2 rounded-[8px] px-3 py-2 text-xs" role="status"
          style={{ background: 'var(--flit-amber-soft, #fff7e6)', color: 'var(--flit-text-secondary)' }}>
          {disabledHint || 'Genera o sube el contrato de compraventa antes de solicitar la firma.'}
        </p>
      )}
      {loading ? (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {ROLES.map((rol) => {
            const f = activaDe(rol);
            return (
              <li key={rol} className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm capitalize" style={{ color: 'var(--flit-text-primary)' }}>{rol}</span>
                  {f
                    ? <StatusChip tone={ESTADO_TONE[f.estado] ?? 'neutral'}>{ESTADO_LABEL[f.estado] ?? f.estado}</StatusChip>
                    : <StatusChip tone="neutral">Sin solicitar</StatusChip>}
                </div>
                {!f && (
                  <button
                    type="button" onClick={() => solicitar(rol)} disabled={submitting === rol || disabled}
                    title={disabled ? (disabledHint || 'Requiere contrato de compraventa') : undefined}
                    className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    style={{ color: 'var(--flit-blue)', background: 'rgba(79, 116, 201, 0.12)' }}
                  >
                    {submitting === rol ? 'Solicitando…' : 'Solicitar firma'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
