import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { useEscape } from '../../lib/hooks';
import FlitModal from '../flit/FlitModal';
import { Field, Th, inputCls, TableCard, Tr, btnPrimary, btnPrimaryStyle, btnSecondary, btnSecondaryStyle } from './shared';

interface DocType { id: number; codigo: string; nombre: string; requiereVigencia: boolean; }
interface VehDoc {
  id: number; tipoId: number; tipoNombre: string; numero: string | null;
  vigenciaDesde: string | null; vigenciaHasta: string | null;
  estado: string; archivoFilename: string | null; createdAt: string;
}

export default function DocumentsPanel({ vehicleId, canEdit }: { vehicleId: number; canEdit: boolean }) {
  const [docs, setDocs] = useState<VehDoc[]>([]);
  const [types, setTypes] = useState<DocType[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        api.get<{ data: VehDoc[] }>(`/fleet/documents/vehicle/${vehicleId}`),
        api.get<{ data: DocType[] }>('/fleet/documents/types'),
      ]);
      setDocs(r1.data); setTypes(r2.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [vehicleId]);
  useEffect(() => { load(); }, [load]);

  const archive = async (id: number) => {
    if (!confirm('¿Archivar este documento?')) return;
    try { await api.delete(`/fleet/documents/${id}`); toast.success('Archivado'); load(); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  return (
    <div>
      {canEdit && (
        <div className="mb-3 flex justify-end">
          <button type="button" onClick={() => setShowAdd(true)} className={btnPrimary} style={btnPrimaryStyle}>Subir documento</button>
        </div>
      )}
      <TableCard>
        <table className="w-full text-sm">
          <thead><tr>
            <Th>Tipo</Th><Th>Número</Th><Th>Vigencia</Th><Th>Estado</Th><Th>Archivo</Th><Th></Th>
          </tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin documentos</td></tr>}
            {docs.map((d) => (
              <Tr key={d.id}>
                <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{d.tipoNombre}</td>
                <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{d.numero || '—'}</td>
                <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{d.vigenciaHasta || '—'}</td>
                <td className="px-4 py-2.5"><EstadoPill estado={d.estado} vigenciaHasta={d.vigenciaHasta} /></td>
                <td className="px-4 py-2.5">
                  {d.archivoFilename
                    ? <a href={`/api/fleet/documents/${d.id}/download`} target="_blank" rel="noreferrer" className="text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>{d.archivoFilename.slice(0, 24)}</a>
                    : '—'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {canEdit && <button type="button" onClick={() => archive(d.id)} className="text-xs font-semibold hover:underline" style={{ color: 'var(--flit-danger)' }}>Archivar</button>}
                </td>
              </Tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      {showAdd && (
        <DocForm
          vehicleId={vehicleId} types={types}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
    </div>
  );
}

function EstadoPill({ estado, vigenciaHasta }: { estado: string; vigenciaHasta: string | null }) {
  const base = 'inline-flex items-center px-2 py-0.5 rounded-pill text-[11px] font-medium';
  if (estado === 'archivado') return <span className="flit-tone-muted text-xs">Archivado</span>;
  if (estado === 'vencido') return <span className={`${base} flit-danger-bg text-[color:var(--flit-danger)]`}>Vencido</span>;
  if (!vigenciaHasta) return <span className="flit-tone-muted text-xs">Sin vigencia</span>;
  const dias = Math.round((new Date(vigenciaHasta).getTime() - Date.now()) / 86_400_000);
  if (dias <= 0) return <span className={`${base} flit-danger-bg text-[color:var(--flit-danger)]`}>Vencido</span>;
  if (dias <= 7) return <span className={`${base} flit-danger-bg text-[color:var(--flit-danger)]`}>{dias}d</span>;
  if (dias <= 30) return <span className={`${base} flit-warning-bg text-[color:var(--flit-warning)]`}>{dias}d</span>;
  return <span className={`${base} flit-success-bg text-[color:var(--flit-success)]`}>Vigente</span>;
}

function DocForm({ vehicleId, types, onClose, onSaved }: { vehicleId: number; types: DocType[]; onClose: () => void; onSaved: () => void }) {
  const [tipoId, setTipoId] = useState('');
  const [numero, setNumero] = useState('');
  const [vigenciaDesde, setVigenciaDesde] = useState('');
  const [vigenciaHasta, setVigenciaHasta] = useState('');
  const [destinatarios, setDestinatarios] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  const tipo = types.find((t) => String(t.id) === tipoId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tipoId) { toast.error('Seleccione un tipo'); return; }
    if (tipo?.requiereVigencia && !vigenciaHasta) { toast.error('Este tipo requiere fecha de vencimiento'); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('vehicleId', String(vehicleId));
      fd.append('tipoId', tipoId);
      if (numero.trim()) fd.append('numero', numero.trim());
      if (vigenciaDesde) fd.append('vigenciaDesde', vigenciaDesde);
      if (vigenciaHasta) fd.append('vigenciaHasta', vigenciaHasta);
      if (destinatarios.trim()) fd.append('destinatariosExtra', destinatarios.trim());
      if (file) fd.append('archivo', file);
      const token = localStorage.getItem('token');
      const r = await fetch('/api/fleet/documents', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Error ${r.status}`);
      }
      toast.success('Documento subido');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Subir documento" onClose={onClose}>
      <form onSubmit={submit} className="px-6 pb-6 space-y-3">
          <Field label="Tipo de documento *">
            <select value={tipoId} onChange={(e) => setTipoId(e.target.value)} className={inputCls}>
              <option value="">— seleccione —</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select>
          </Field>
          <Field label="Número"><input value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={80} className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vigencia desde"><input type="date" value={vigenciaDesde} onChange={(e) => setVigenciaDesde(e.target.value)} className={inputCls} /></Field>
            <Field label={`Vigencia hasta${tipo?.requiereVigencia ? ' *' : ''}`}><input type="date" value={vigenciaHasta} onChange={(e) => setVigenciaHasta(e.target.value)} className={inputCls} /></Field>
          </div>
          <Field label="Destinatarios extra (separados por coma)">
            <input value={destinatarios} onChange={(e) => setDestinatarios(e.target.value)} placeholder="flota@flit.com.co, admin@flit.com.co" className={inputCls} />
          </Field>
          <Field label="Archivo (PDF, JPG o PNG, máx 10 MB)">
            <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }} />
          </Field>
        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} className={btnSecondary} style={btnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={submitting} className={btnPrimary} style={btnPrimaryStyle}>
            {submitting ? 'Subiendo…' : 'Guardar'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
