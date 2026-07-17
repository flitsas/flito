import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import { Field, Th, VencimientoPill, inputCls } from './shared';

interface DocType { id: number; codigo: string; nombre: string; requiereVigencia: boolean; }
interface DriverDoc {
  id: number; tipoNombre: string; numero: string | null;
  vigenciaDesde: string | null; vigenciaHasta: string | null;
  estado: string; archivoFilename: string | null;
}

export default function DriverDocumentsPanel({ userId, canEdit }: { userId: number; canEdit: boolean }) {
  const [docs, setDocs] = useState<DriverDoc[]>([]);
  const [types, setTypes] = useState<DocType[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        api.get<{ data: DriverDoc[] }>(`/drivers/documents/user/${userId}`),
        api.get<{ data: DocType[] }>('/drivers/documents/types'),
      ]);
      setDocs(r1.data); setTypes(r2.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const archive = async (id: number) => {
    if (!confirm('¿Archivar este documento?')) return;
    try { await api.delete(`/drivers/documents/${id}`); toast.success('Archivado'); load(); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  return (
    <div>
      {canEdit && (
        <div className="mb-3 flex justify-end">
          <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-[color:var(--flit-blue)] text-[color:var(--flit-blue)]-foreground hover:bg-[color:var(--flit-blue)]-hover transition-colors text-sm font-medium">Subir documento</button>
        </div>
      )}
      <div className="bg-white rounded-xl border border-[color:var(--flit-border-soft)] shadow-[var(--flit-shadow-card)] overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr>
            <Th>Tipo</Th><Th>Número</Th><Th>Vigencia hasta</Th><Th>Estado</Th><Th>Archivo</Th><Th></Th>
          </tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={6} className="py-8 text-center flit-tone-muted text-sm">Sin documentos</td></tr>}
            {docs.map((d) => (
              <tr key={d.id} className="border-t border-[color:var(--flit-border-soft)] hover:bg-[color:var(--flit-bg-app)]/50 transition-colors">
                <td className="px-4 py-3 text-sm font-medium flit-tone-primary">{d.tipoNombre}</td>
                <td className="px-4 py-3 text-sm flit-tone-secondary">{d.numero || '—'}</td>
                <td className="px-4 py-3 text-sm flit-tone-secondary">{d.vigenciaHasta || '—'}</td>
                <td className="px-4 py-3"><VencimientoPill vigenciaHasta={d.vigenciaHasta} /></td>
                <td className="px-4 py-3">
                  {d.archivoFilename
                    ? <a href={`/api/drivers/documents/${d.id}/download`} target="_blank" rel="noreferrer" className="text-xs text-[color:var(--flit-blue)] hover:underline">{d.archivoFilename.slice(0, 24)}</a>
                    : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  {canEdit && <button onClick={() => archive(d.id)} className="text-xs text-[color:var(--flit-danger)] hover:underline">Archivar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showAdd && (
        <DriverDocForm
          userId={userId} types={types}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
    </div>
  );
}

function DriverDocForm({ userId, types, onClose, onSaved }: { userId: number; types: DocType[]; onClose: () => void; onSaved: () => void }) {
  const [tipoId, setTipoId] = useState('');
  const [numero, setNumero] = useState('');
  const [vigenciaDesde, setVigenciaDesde] = useState('');
  const [vigenciaHasta, setVigenciaHasta] = useState('');
  const [destinatarios, setDestinatarios] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tipo = types.find((t) => String(t.id) === tipoId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tipoId) { toast.error('Seleccione un tipo'); return; }
    if (tipo?.requiereVigencia && !vigenciaHasta) { toast.error('Este tipo requiere vigencia'); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('userId', String(userId));
      fd.append('tipoId', tipoId);
      if (numero.trim()) fd.append('numero', numero.trim());
      if (vigenciaDesde) fd.append('vigenciaDesde', vigenciaDesde);
      if (vigenciaHasta) fd.append('vigenciaHasta', vigenciaHasta);
      if (destinatarios.trim()) fd.append('destinatariosExtra', destinatarios.trim());
      if (file) fd.append('archivo', file);
      const token = localStorage.getItem('token');
      const r = await fetch('/api/drivers/documents', {
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

  // FLIT-CLEANUP-08 PR1: modal unificado vía FlitModal (elimina el overlay Aura
  // residual y el header hand-rolled; backdrop/cierre los aporta FlitModal).
  return (
    <FlitModal title="Subir documento" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-3">
          <Field label="Tipo *">
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
            <input value={destinatarios} onChange={(e) => setDestinatarios(e.target.value)} placeholder="rrhh@flit.com.co" className={inputCls} />
          </Field>
          <Field label="Archivo (PDF, JPG o PNG, máx 10 MB)">
            <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs flit-tone-secondary" />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>Cancelar</button>
          <button type="submit" disabled={submitting} className="flit-focus inline-flex h-10 items-center rounded-[999px] px-5 text-sm font-semibold text-white transition-opacity disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
            {submitting ? 'Subiendo…' : 'Guardar'}
          </button>
        </div>
      </form>
    </FlitModal>
  );
}
