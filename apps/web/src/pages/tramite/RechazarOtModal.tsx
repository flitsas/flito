import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import GradientButton from '../../components/flit/GradientButton';
import { flitInp } from '../../components/flit/flitPageKit';
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
    <FlitModal title="Registrar rechazo OT" onClose={onClose} icono="alerta">
      <p className="mb-4 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        Trámite <span className="font-semibold" style={{ color: 'var(--color-text-primary)' }}>{ref}</span>
        {' '}— el motivo queda en el expediente y alimenta métricas (sin datos personales).
      </p>

      <label htmlFor="rechazo-ot-motivo" className="mb-1 block text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
        Motivo
      </label>
      <select
        id="rechazo-ot-motivo"
        value={codigo}
        onChange={(e) => setCodigo(e.target.value)}
        className={`${flitInp} mb-4`}
      >
        {motivos.map((m) => <option key={m.codigo} value={m.codigo}>{m.label}</option>)}
      </select>

      <label htmlFor="rechazo-ot-nota" className="mb-1 block text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
        Nota (opcional)
      </label>
      <textarea
        id="rechazo-ot-nota"
        value={nota}
        onChange={(e) => setNota(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Detalle para el gestor interno…"
        className={`${flitInp} mb-4 resize-y`}
      />

      {sugeridos && (
        <p className="mb-4 text-xs" style={{ color: 'var(--kit-naranja-texto)' }}>
          Ítems de checklist sugeridos: {sugeridos.join(', ')}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
        <GradientButton type="button" variant="alerta" onClick={submit} disabled={loading || !codigo}>
          {loading ? 'Guardando…' : 'Confirmar rechazo'}
        </GradientButton>
      </div>
    </FlitModal>
  );
}
