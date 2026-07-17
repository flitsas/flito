import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import GradientButton from '../../components/flit/GradientButton';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../components/flit/flitPageKit';
import type { MotivoRechazoApi, RechazarOtResponse } from './rechazoOt';

interface Props {
  tramiteId: number;
  vin?: string | null;
  placa?: string | null;
  onClose: () => void;
  onSuccess: (res: RechazarOtResponse) => void;
}

export default function RechazarOtModal({ tramiteId, vin, placa, onClose, onSuccess }: Props) {
  const [motivos, setMotivos] = useState<MotivoRechazoApi[]>([]);
  const [codigo, setCodigo] = useState('');
  const [nota, setNota] = useState('');
  const [loading, setLoading] = useState(false);
  const [sugeridos, setSugeridos] = useState<string[] | null>(null);

  useEffect(() => {
    api.get<MotivoRechazoApi[]>('/tramites/motivos-rechazo-ot')
      .then((m) => { setMotivos(m); if (m[0]) setCodigo(m[0].codigo); })
      .catch(() => toast.error('No se pudo cargar el catálogo de motivos'));
  }, []);

  const submit = useCallback(async () => {
    if (!codigo) { toast.error('Selecciona un motivo'); return; }
    setLoading(true);
    try {
      const res = await api.post<RechazarOtResponse>(`/tramites/${tramiteId}/rechazar-ot`, {
        codigo,
        nota: nota.trim() || undefined,
      });
      setSugeridos(res.checklistSugeridos?.length ? res.checklistSugeridos : null);
      toast.success('Rechazo OT registrado');
      onSuccess(res);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setLoading(false); }
  }, [codigo, nota, tramiteId, onClose, onSuccess]);

  const ref = vin || placa || `#${tramiteId}`;

  return (
    <FlitModal title="Registrar rechazo OT" onClose={onClose}>
      <p className="mb-4 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        Trámite <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{ref}</span>
        {' '}— el motivo queda en el expediente y alimenta métricas (sin datos personales).
      </p>

      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
        Motivo
      </label>
      <select
        value={codigo}
        onChange={(e) => setCodigo(e.target.value)}
        className="flit-focus mb-4 w-full rounded-[10px] border px-3 py-2.5 text-sm"
        style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
      >
        {motivos.map((m) => <option key={m.codigo} value={m.codigo}>{m.label}</option>)}
      </select>

      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
        Nota (opcional)
      </label>
      <textarea
        value={nota}
        onChange={(e) => setNota(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Detalle para el gestor interno…"
        className="flit-focus mb-4 w-full resize-y rounded-[10px] border px-3 py-2.5 text-sm"
        style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
      />

      {sugeridos && (
        <p className="mb-4 text-xs" style={{ color: 'var(--flit-warning)' }}>
          Ítems de checklist sugeridos: {sugeridos.join(', ')}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
        <GradientButton type="button" onClick={submit} disabled={loading || !codigo}>
          {loading ? 'Guardando…' : 'Confirmar rechazo'}
        </GradientButton>
      </div>
    </FlitModal>
  );
}
