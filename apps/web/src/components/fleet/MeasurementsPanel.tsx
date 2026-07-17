import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { useEscape } from '../../lib/hooks';
import FlitModal from '../flit/FlitModal';
import { Field, Th, inputCls, TableCard, Tr, btnPrimary, btnPrimaryStyle, btnSecondary, btnSecondaryStyle } from './shared';

interface Measurement {
  id: number; vehicleId: number; fecha: string;
  odometro: number | null; horometro: number | null;
  fuente: string; nota: string | null; excedioPromedio: boolean;
}

export default function MeasurementsPanel({ vehicleId, tipoMedicion, canCreate }: { vehicleId: number; tipoMedicion: string | null; canCreate: boolean }) {
  const [meas, setMeas] = useState<Measurement[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.get<{ data: Measurement[] }>(`/fleet/measurements/vehicle/${vehicleId}`); setMeas(r.data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [vehicleId]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {canCreate && (
        <div className="mb-3 flex justify-end">
          <button type="button" onClick={() => setShowCreate(true)} className={btnPrimary} style={btnPrimaryStyle}>Nueva medición</button>
        </div>
      )}
      <TableCard>
        <table className="w-full text-sm">
          <thead><tr>
            <Th>Fecha</Th><Th>Odómetro</Th><Th>Horómetro</Th><Th>Fuente</Th><Th>Nota</Th>
          </tr></thead>
          <tbody>
            {meas.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin mediciones</td></tr>}
            {meas.map((m) => (
              <Tr key={m.id}>
                <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{m.fecha}</td>
                <td className="px-4 py-2.5 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{m.odometro ?? '—'}</td>
                <td className="px-4 py-2.5 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{m.horometro ?? '—'}</td>
                <td className="px-4 py-2.5 capitalize" style={{ color: 'var(--flit-text-muted)' }}>{m.fuente}</td>
                <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-muted)' }}>
                  {m.nota || ''}
                  {m.excedioPromedio && <span className="ml-2 text-[11px] font-semibold" style={{ color: 'var(--flit-warning)' }}>excedió promedio</span>}
                </td>
              </Tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      {showCreate && (
        <MeasurementForm
          vehicleId={vehicleId} tipoMedicion={tipoMedicion}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

function MeasurementForm({ vehicleId, tipoMedicion, onClose, onSaved }: { vehicleId: number; tipoMedicion: string | null; onClose: () => void; onSaved: () => void }) {
  const [odometro, setOdometro] = useState('');
  const [horometro, setHorometro] = useState('');
  const [nota, setNota] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!odometro && !horometro) { toast.error('Ingrese al menos una lectura'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { vehicleId, fuente: 'manual' };
      if (odometro) body.odometro = parseInt(odometro, 10);
      if (horometro) body.horometro = parseInt(horometro, 10);
      if (nota.trim()) body.nota = nota.trim();
      const r = await api.post<{ warnings: string[] }>('/fleet/measurements', body);
      if (r.warnings && r.warnings.length > 0) r.warnings.forEach((w) => toast(w));
      toast.success('Medición registrada');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Nueva medición" onClose={onClose}>
      <form onSubmit={submit} className="px-6 pb-6 space-y-3">
          {(tipoMedicion === 'km' || tipoMedicion === 'ambos' || !tipoMedicion) && (
            <Field label="Odómetro (km)"><input type="number" value={odometro} onChange={(e) => setOdometro(e.target.value)} className={inputCls} /></Field>
          )}
          {(tipoMedicion === 'horas' || tipoMedicion === 'ambos') && (
            <Field label="Horómetro (h)"><input type="number" value={horometro} onChange={(e) => setHorometro(e.target.value)} className={inputCls} /></Field>
          )}
          <Field label="Nota"><input value={nota} onChange={(e) => setNota(e.target.value)} maxLength={500} className={inputCls} /></Field>
        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} className={btnSecondary} style={btnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={submitting} className={btnPrimary} style={btnPrimaryStyle}>
            {submitting ? 'Guardando…' : 'Registrar'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
