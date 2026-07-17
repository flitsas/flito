// TRAM-INNOV-B5-MVP — panel de liquidación / pago manual en el detalle de OT.

import { useCallback, useEffect, useState, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import FlitModal from '../flit/FlitModal';

interface Pago { id: number; monto: number; metodo: string; nota: string | null; createdAt: string }
interface Liquidacion { id: number; estado: string; total: number; nota: string | null; pagos: Pago[] }

const ESTADO_TONE: Record<string, ChipTone> = { borrador: 'warning', confirmada: 'success', anulada: 'neutral' };
const fmt = (n: number) => `$${(n ?? 0).toLocaleString('es-CO')}`;
const cardStyle: React.CSSProperties = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' };

export default function LiquidacionPanel({ woId, isAdmin }: { woId: number; isAdmin: boolean }) {
  const [liqs, setLiqs] = useState<Liquidacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ liquidaciones: Liquidacion[] }>(`/liquidaciones?woId=${woId}`);
      setLiqs(Array.isArray(r.liquidaciones) ? r.liquidaciones : []);
    } catch { /* silencioso */ } finally { setLoading(false); }
  }, [woId]);

  useEffect(() => { load(); }, [load]);

  return (
    <section aria-label="Liquidación y pago" className="bg-white p-5" style={cardStyle}>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Liquidación / pago manual</p>
        {isAdmin && (
          <button type="button" onClick={() => setModal(true)}
            className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold"
            style={{ color: 'var(--flit-blue)', background: 'rgba(79, 116, 201, 0.12)' }}>
            Registrar pago manual
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p>
      ) : liqs.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin liquidaciones registradas.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {liqs.map((l) => (
            <li key={l.id} className="rounded-[10px] border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <StatusChip tone={ESTADO_TONE[l.estado] ?? 'neutral'}>{l.estado}</StatusChip>
                  <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{fmt(l.total)}</span>
                </div>
                {l.nota && <span className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{l.nota}</span>}
              </div>
              {l.pagos.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {l.pagos.map((p) => (
                    <li key={p.id} className="text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
                      Pago {fmt(p.monto)} · {p.metodo} · {(p.createdAt || '').slice(0, 10)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {modal && (
        <PagoModal woId={woId} onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} />
      )}
    </section>
  );
}

function PagoModal({ woId, onClose, onSaved }: { woId: number; onClose: () => void; onSaved: () => void }) {
  const [monto, setMonto] = useState('');
  const [nota, setNota] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputCls = 'flit-focus mt-1 w-full rounded-[10px] border bg-white px-3 py-2.5 text-sm outline-none';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const m = Number(monto);
    if (!(m > 0)) { toast.error('Ingresa un monto válido'); return; }
    if (submitting) return;
    setSubmitting(true);
    try {
      const desc = nota.trim() || 'Pago manual OT';
      const liq = await api.post<{ id: number }>('/liquidaciones', {
        woId, items: [{ descripcion: desc, cantidad: 1, valorUnitario: m }], nota: nota.trim() || undefined,
      });
      await api.post(`/liquidaciones/${liq.id}/confirmar-pago`, { monto: m, nota: nota.trim() || undefined });
      toast.success('Pago manual registrado');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); } finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Registrar pago manual" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Monto (COP)
          <input type="number" min={1} step="any" value={monto} onChange={(e) => setMonto(e.target.value)} required
            className={inputCls} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }} placeholder="0" />
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Nota / referencia (opcional)
          <textarea value={nota} onChange={(e) => setNota(e.target.value)} rows={2} maxLength={500}
            className={`${inputCls} resize-none`} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
            placeholder="Ej: efectivo, transferencia Bancolombia ref 12345" />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="flit-focus rounded-[999px] px-4 py-2 text-sm font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          <button type="submit" disabled={submitting} className="flit-focus inline-flex h-10 items-center rounded-[999px] px-4 text-sm font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)' }}>
            {submitting ? 'Registrando…' : 'Confirmar pago'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
