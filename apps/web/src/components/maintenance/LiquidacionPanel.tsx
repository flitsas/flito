// TRAM-INNOV-B5-MVP — panel de liquidación / pago manual en el detalle de OT.

import { useCallback, useEffect, useState, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import GradientButton from '../flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import { Cargador } from '../flit/Cargador';
import { EtiquetaEstado } from '../flit/Bloques';
import { ESTADO_LIQUIDACION } from './estados-mantenimiento';

interface Pago { id: number; monto: number; metodo: string; nota: string | null; createdAt: string }
interface Liquidacion { id: number; estado: string; total: number; nota: string | null; pagos: Pago[] }

const fmt = (n: number) => `$${(n ?? 0).toLocaleString('es-CO')}`;
const claveEstado = (estado: string) => ESTADO_LIQUIDACION[estado as keyof typeof ESTADO_LIQUIDACION] ?? estado;

const COLUMNAS: ColumnaTabla<Liquidacion>[] = [
  { key: 'estado', header: 'Estado', etiqueta: 'Estado', render: (l) => <EtiquetaEstado estado={claveEstado(l.estado)}>{l.estado}</EtiquetaEstado> },
  { key: 'total', header: 'Total', etiqueta: 'Total', align: 'right', render: (l) => <span className="mono tabular-nums font-semibold text-[color:var(--color-text-primary)]">{fmt(l.total)}</span> },
  { key: 'nota', header: 'Nota', etiqueta: 'Nota', render: (l) => <span className="text-xs text-[color:var(--color-text-tertiary)]">{l.nota}</span> },
  {
    key: 'pagos', header: 'Pagos', etiqueta: 'Pagos',
    render: (l) => (l.pagos.length > 0 ? (
      <ul className="space-y-0.5">
        {l.pagos.map((p) => (
          <li key={p.id} className="text-xs text-[color:var(--color-text-secondary)]">
            Pago <span className="mono tabular-nums">{fmt(p.monto)}</span> · {p.metodo} · {(p.createdAt || '').slice(0, 10)}
          </li>
        ))}
      </ul>
    ) : null),
  },
];

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
    <section aria-label="Liquidación y pago" className="card flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base font-semibold text-[color:var(--color-text-primary)]">Liquidación / pago manual</p>
        {isAdmin && (
          <GradientButton type="button" variant="secondary" size="sm" onClick={() => setModal(true)}>
            Registrar pago manual
          </GradientButton>
        )}
      </div>

      {loading ? (
        <Cargador texto="Cargando…" />
      ) : (
        <DataTable
          ariaLabel="Liquidaciones de la orden"
          columnas={COLUMNAS}
          filas={liqs}
          getKey={(l) => String(l.id)}
          emptyMessage="Sin liquidaciones registradas."
        />
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
    <FlitModal title="Registrar pago manual" icono="pago" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="campo">
          <label htmlFor="pago-manual-monto">Monto (COP)</label>
          <input id="pago-manual-monto" type="number" min={1} step="any" value={monto} onChange={(e) => setMonto(e.target.value)} required
            className="control mono" placeholder="0" />
        </div>
        <div className="campo">
          <label htmlFor="pago-manual-nota">Nota / referencia (opcional)</label>
          <textarea id="pago-manual-nota" value={nota} onChange={(e) => setNota(e.target.value)} rows={2} maxLength={500}
            className="control resize-none" placeholder="Ej: efectivo, transferencia Bancolombia ref 12345" />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" variant="success" disabled={submitting} ocupado={submitting}>
            {submitting ? 'Registrando…' : 'Confirmar pago'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
