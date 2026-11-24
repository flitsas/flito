import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import GradientButton from '../flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import { Field, VencimientoPill, inputCls } from './shared';

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

  const columnas: ColumnaTabla<DriverDoc>[] = [
    { key: 'tipo', header: 'Tipo', etiqueta: 'Tipo', render: (d) => <span className="font-medium text-[color:var(--color-text-primary)]">{d.tipoNombre}</span> },
    { key: 'numero', header: 'Número', etiqueta: 'Número', render: (d) => d.numero || '—' },
    { key: 'vigencia', header: 'Vigencia hasta', etiqueta: 'Vigencia hasta', render: (d) => d.vigenciaHasta || '—' },
    { key: 'estado', header: 'Estado', etiqueta: 'Estado', render: (d) => <VencimientoPill vigenciaHasta={d.vigenciaHasta} /> },
    {
      key: 'archivo', header: 'Archivo', etiqueta: 'Archivo',
      render: (d) => (d.archivoFilename
        ? <a href={`/api/drivers/documents/${d.id}/download`} target="_blank" rel="noreferrer" className="text-xs text-[color:var(--color-action)] transition-colors hover:underline">{d.archivoFilename.slice(0, 24)}</a>
        : '—'),
    },
    {
      key: 'acciones', header: '', acciones: true, align: 'right',
      render: (d) => (canEdit ? <GradientButton type="button" variant="alerta" size="sm" onClick={() => archive(d.id)}>Archivar</GradientButton> : null),
    },
  ];

  return (
    <div>
      {canEdit && (
        <div className="mb-3 flex justify-end">
          <GradientButton type="button" onClick={() => setShowAdd(true)}>Subir documento</GradientButton>
        </div>
      )}
      <DataTable
        ariaLabel="Documentos del conductor"
        columnas={columnas}
        filas={docs}
        getKey={(d) => String(d.id)}
        status={docs.length === 0 ? 'empty' : 'ready'}
        emptyMessage="Sin documentos"
      />
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
    <FlitModal title="Subir documento" onClose={onClose} icono="archivo-subir">
      <form onSubmit={submit}>
        <div className="space-y-3">
          <Field label="Tipo *">
            <select value={tipoId} onChange={(e) => setTipoId(e.target.value)} className={inputCls}>
              <option value="">— seleccione —</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select>
          </Field>
          <Field label="Número"><input value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={80} className={inputCls} /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Vigencia desde"><input type="date" value={vigenciaDesde} onChange={(e) => setVigenciaDesde(e.target.value)} className={inputCls} /></Field>
            <Field label={`Vigencia hasta${tipo?.requiereVigencia ? ' *' : ''}`}><input type="date" value={vigenciaHasta} onChange={(e) => setVigenciaHasta(e.target.value)} className={inputCls} /></Field>
          </div>
          <Field label="Destinatarios extra (separados por coma)">
            <input value={destinatarios} onChange={(e) => setDestinatarios(e.target.value)} placeholder="rrhh@flit.com.co" className={inputCls} />
          </Field>
          <Field label="Archivo (PDF, JPG o PNG, máx 10 MB)">
            <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-xs text-[color:var(--color-text-secondary)] file:mr-3 file:rounded-[999px] file:border-0 file:bg-[color:var(--kit-tinta-fija)] file:px-4 file:py-2 file:text-xs file:font-semibold file:text-[color:var(--kit-sobre-relleno)]" />
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>
            {submitting ? 'Subiendo…' : 'Guardar'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
