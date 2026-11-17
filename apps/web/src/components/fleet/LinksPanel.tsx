import { useEffect, useState, useCallback, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { useEscape } from '../../lib/hooks';
import { EtiquetaEstado } from '../flit/Bloques';
import { Icono } from '../flit/kit/Icono';
import { ESTADO_FLOTA } from './estados-flota';
import FlitModal from '../flit/FlitModal';
import GradientButton from '../flit/GradientButton';
import DataTable from '../flit/DataTable';
import { flitInp, FlitField } from '../flit/flitPageKit';

interface LinkRow {
  id: number;
  vehiculoPrincipalId: number;
  vehiculoVinculadoId: number;
  desde: string | null;
  hasta: string | null;
  esActual: boolean;
}

export default function LinksPanel({ vehicleId, canEdit, onChanged }: { vehicleId: number; canEdit: boolean; onChanged: () => void }) {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [showLink, setShowLink] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.get<{ data: LinkRow[] }>(`/fleet/links/vehicle/${vehicleId}`); setLinks(r.data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [vehicleId]);
  useEffect(() => { load(); }, [load]);

  const closeLink = async (id: number) => {
    if (!confirm('¿Cerrar esta vinculación?')) return;
    try { await api.patch(`/fleet/links/${id}/close`); toast.success('Vínculo cerrado'); load(); onChanged(); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  return (
    <div>
      {canEdit && (
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" onClick={() => setShowLink(true)}><Icono nombre="mas" size={18} />Vincular equipo</GradientButton>
        </div>
      )}
      <DataTable<LinkRow>
        ariaLabel="Vinculaciones del vehículo"
        filas={links}
        getKey={(l) => String(l.id)}
        status={links.length === 0 ? 'empty' : 'ready'}
        emptyMessage="Sin vinculaciones registradas"
        columnas={[
          { key: 'cabezote', header: 'Cabezote', render: (l) => <Link to={`/fleet/${l.vehiculoPrincipalId}`} className="rounded-[9px] font-semibold text-[color:var(--color-action)] transition-colors hover:underline">#{l.vehiculoPrincipalId}</Link> },
          { key: 'vinculado', header: 'Vinculado', render: (l) => <Link to={`/fleet/${l.vehiculoVinculadoId}`} className="rounded-[9px] font-semibold text-[color:var(--color-action)] transition-colors hover:underline">#{l.vehiculoVinculadoId}</Link> },
          { key: 'desde', header: 'Desde', render: (l) => l.desde?.slice(0, 10) ?? '—' },
          { key: 'hasta', header: 'Hasta', render: (l) => l.hasta?.slice(0, 10) ?? '—' },
          {
            key: 'estado', header: 'Estado',
            render: (l) => (l.esActual
              ? <EtiquetaEstado estado={ESTADO_FLOTA.vinculoActivo}>Activo</EtiquetaEstado>
              : <EtiquetaEstado estado={ESTADO_FLOTA.vinculoCerrado}>Cerrado</EtiquetaEstado>),
          },
          {
            key: 'acciones', header: '', acciones: true, align: 'right',
            render: (l) => (l.esActual && canEdit
              ? <GradientButton type="button" variant="alerta" size="sm" onClick={() => closeLink(l.id)}>Cerrar</GradientButton>
              : null),
          },
        ]}
      />
      {showLink && (
        <LinkForm
          currentId={vehicleId}
          onClose={() => setShowLink(false)}
          onSaved={() => { setShowLink(false); load(); onChanged(); }}
        />
      )}
    </div>
  );
}

function LinkForm({ currentId, onClose, onSaved }: { currentId: number; onClose: () => void; onSaved: () => void }) {
  const [otherId, setOtherId] = useState('');
  const [tipoVinculo, setTipoVinculo] = useState<'principal' | 'vinculado'>('principal');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const otherNum = parseInt(otherId, 10);
    if (!Number.isFinite(otherNum) || otherNum <= 0) { toast.error('ID inválido'); return; }
    if (otherNum === currentId) { toast.error('No puede vincular el vehículo consigo mismo'); return; }
    setSubmitting(true);
    try {
      const body = tipoVinculo === 'principal'
        ? { vehiculoPrincipalId: currentId, vehiculoVinculadoId: otherNum }
        : { vehiculoPrincipalId: otherNum, vehiculoVinculadoId: currentId };
      await api.post('/fleet/links', body);
      toast.success('Vinculación creada');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Vincular equipo" onClose={onClose} icono="intercambio">
      <form onSubmit={submit} className="space-y-3">
          <FlitField label="Este vehículo es…">
            <select value={tipoVinculo} onChange={(e) => setTipoVinculo(e.target.value as 'principal' | 'vinculado')} className={flitInp}>
              <option value="principal">Cabezote (principal)</option>
              <option value="vinculado">Trailer (vinculado)</option>
            </select>
          </FlitField>
          <FlitField label="ID del otro vehículo">
            <input value={otherId} onChange={(e) => setOtherId(e.target.value)} placeholder="Ej: 42" className={flitInp} />
          </FlitField>
          <p className="text-xs text-[color:var(--color-text-tertiary)]">El otro vehículo debe pertenecer a la flota propia. Si el trailer ya tiene un cabezote vigente, se cerrará automáticamente.</p>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Vincular'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
