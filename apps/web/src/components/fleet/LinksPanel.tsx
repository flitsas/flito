import { useEffect, useState, useCallback, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { useEscape } from '../../lib/hooks';
import FlitModal from '../flit/FlitModal';
import { Field, Th, inputCls, TableCard, Tr, btnPrimary, btnPrimaryStyle, btnSecondary, btnSecondaryStyle } from './shared';

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
        <div className="mb-3 flex justify-end">
          <button type="button" onClick={() => setShowLink(true)} className={btnPrimary} style={btnPrimaryStyle}>Vincular equipo</button>
        </div>
      )}
      <TableCard>
        <table className="w-full text-sm">
          <thead><tr>
            <Th>Cabezote</Th><Th>Vinculado</Th><Th>Desde</Th><Th>Hasta</Th><Th>Estado</Th><Th></Th>
          </tr></thead>
          <tbody>
            {links.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin vinculaciones registradas</td></tr>}
            {links.map((l) => (
              <Tr key={l.id}>
                <td className="px-4 py-2.5"><Link to={`/fleet/${l.vehiculoPrincipalId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>#{l.vehiculoPrincipalId}</Link></td>
                <td className="px-4 py-2.5"><Link to={`/fleet/${l.vehiculoVinculadoId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>#{l.vehiculoVinculadoId}</Link></td>
                <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{l.desde?.slice(0, 10) ?? '—'}</td>
                <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{l.hasta?.slice(0, 10) ?? '—'}</td>
                <td className="px-4 py-2.5">{l.esActual ? <span className="inline-flex items-center rounded-[999px] px-2 py-0.5 text-[11px] font-semibold" style={{ background: 'rgba(112,207,58,0.15)', color: 'var(--flit-success)' }}>Activo</span> : <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cerrado</span>}</td>
                <td className="px-4 py-2.5 text-right">
                  {l.esActual && canEdit && (
                    <button type="button" onClick={() => closeLink(l.id)} className="text-xs font-semibold hover:underline" style={{ color: 'var(--flit-danger)' }}>Cerrar</button>
                  )}
                </td>
              </Tr>
            ))}
          </tbody>
        </table>
      </TableCard>
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
  const [role, setRole] = useState<'principal' | 'vinculado'>('principal');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const otherNum = parseInt(otherId, 10);
    if (!Number.isFinite(otherNum) || otherNum <= 0) { toast.error('ID inválido'); return; }
    if (otherNum === currentId) { toast.error('No puede vincular el vehículo consigo mismo'); return; }
    setSubmitting(true);
    try {
      const body = role === 'principal'
        ? { vehiculoPrincipalId: currentId, vehiculoVinculadoId: otherNum }
        : { vehiculoPrincipalId: otherNum, vehiculoVinculadoId: currentId };
      await api.post('/fleet/links', body);
      toast.success('Vinculación creada');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Vincular equipo" onClose={onClose}>
      <form onSubmit={submit} className="px-6 pb-6 space-y-3">
          <Field label="Este vehículo es…">
            <select value={role} onChange={(e) => setRole(e.target.value as 'principal' | 'vinculado')} className={inputCls}>
              <option value="principal">Cabezote (principal)</option>
              <option value="vinculado">Trailer (vinculado)</option>
            </select>
          </Field>
          <Field label="ID del otro vehículo">
            <input value={otherId} onChange={(e) => setOtherId(e.target.value)} placeholder="Ej: 42" className={inputCls} />
          </Field>
          <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>El otro vehículo debe pertenecer a la flota propia. Si el trailer ya tiene un cabezote vigente, se cerrará automáticamente.</p>
        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} className={btnSecondary} style={btnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={submitting} className={btnPrimary} style={btnPrimaryStyle}>
            {submitting ? 'Guardando…' : 'Vincular'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
