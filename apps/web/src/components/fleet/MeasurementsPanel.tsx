import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { useEscape } from '../../lib/hooks';
import { Icono } from '../flit/kit/Icono';
import FlitModal from '../flit/FlitModal';
import GradientButton from '../flit/GradientButton';
import DataTable from '../flit/DataTable';
import { flitInp, FlitField } from '../flit/flitPageKit';

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
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" onClick={() => setShowCreate(true)}><Icono nombre="mas" size={18} />Nueva medición</GradientButton>
        </div>
      )}
      <DataTable<Measurement>
        ariaLabel="Mediciones del vehículo"
        filas={meas}
        getKey={(m) => String(m.id)}
        status={meas.length === 0 ? 'empty' : 'ready'}
        emptyMessage="Sin mediciones"
        columnas={[
          { key: 'fecha', header: 'Fecha', render: (m) => m.fecha },
          { key: 'odometro', header: 'Odómetro', render: (m) => <span className="tabular-nums">{m.odometro ?? '—'}</span> },
          { key: 'horometro', header: 'Horómetro', render: (m) => <span className="tabular-nums">{m.horometro ?? '—'}</span> },
          { key: 'fuente', header: 'Fuente', render: (m) => <span className="capitalize text-[color:var(--color-text-tertiary)]">{m.fuente}</span> },
          {
            key: 'nota', header: 'Nota',
            render: (m) => (
              <span className="text-[color:var(--color-text-tertiary)]">
                {m.nota || ''}
                {m.excedioPromedio && <span className="ml-2 text-xs font-semibold text-[color:var(--kit-naranja-texto)]">excedió promedio</span>}
              </span>
            ),
          },
        ]}
      />
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
    <FlitModal title="Nueva medición" onClose={onClose} icono="medidor">
      <form onSubmit={submit} className="space-y-3">
          {(tipoMedicion === 'km' || tipoMedicion === 'ambos' || !tipoMedicion) && (
            <FlitField label="Odómetro (km)"><input type="number" value={odometro} onChange={(e) => setOdometro(e.target.value)} className={flitInp} /></FlitField>
          )}
          {(tipoMedicion === 'horas' || tipoMedicion === 'ambos') && (
            <FlitField label="Horómetro (h)"><input type="number" value={horometro} onChange={(e) => setHorometro(e.target.value)} className={flitInp} /></FlitField>
          )}
          <FlitField label="Nota"><input value={nota} onChange={(e) => setNota(e.target.value)} maxLength={500} className={flitInp} /></FlitField>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Registrar'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
