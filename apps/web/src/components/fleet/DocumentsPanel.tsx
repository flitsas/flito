import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { useEscape } from '../../lib/hooks';
import { EtiquetaEstado } from '../flit/Bloques';
import { Icono } from '../flit/kit/Icono';
import { ESTADO_FLOTA, estadoPorDias } from './estados-flota';
import FlitModal from '../flit/FlitModal';
import GradientButton from '../flit/GradientButton';
import DataTable from '../flit/DataTable';
import { flitInp, FlitField } from '../flit/flitPageKit';

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
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <GradientButton type="button" onClick={() => setShowAdd(true)}><Icono nombre="nube-subir" size={18} />Subir documento</GradientButton>
        </div>
      )}
      <DataTable<VehDoc>
        ariaLabel="Documentos del vehículo"
        filas={docs}
        getKey={(d) => String(d.id)}
        status={docs.length === 0 ? 'empty' : 'ready'}
        emptyMessage="Sin documentos"
        columnas={[
          { key: 'tipo', header: 'Tipo', render: (d) => <span className="font-medium text-[color:var(--color-text-primary)]">{d.tipoNombre}</span> },
          { key: 'numero', header: 'Número', render: (d) => d.numero || '—' },
          { key: 'vigencia', header: 'Vigencia', render: (d) => d.vigenciaHasta || '—' },
          { key: 'estado', header: 'Estado', render: (d) => <EstadoPill estado={d.estado} vigenciaHasta={d.vigenciaHasta} /> },
          {
            key: 'archivo', header: 'Archivo',
            render: (d) => (d.archivoFilename
              ? <a href={`/api/fleet/documents/${d.id}/download`} target="_blank" rel="noreferrer" className="rounded-[9px] text-xs font-semibold text-[color:var(--color-action)] transition-colors hover:underline">{d.archivoFilename.slice(0, 24)}</a>
              : '—'),
          },
          {
            key: 'acciones', header: '', acciones: true, align: 'right',
            render: (d) => (canEdit ? <GradientButton type="button" variant="alerta" size="sm" onClick={() => archive(d.id)}>Archivar</GradientButton> : null),
          },
        ]}
      />
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
  if (estado === 'archivado') return <EtiquetaEstado estado={ESTADO_FLOTA.docArchivado}>Archivado</EtiquetaEstado>;
  if (estado === 'vencido') return <EtiquetaEstado estado={ESTADO_FLOTA.docVencido}>Vencido</EtiquetaEstado>;
  if (!vigenciaHasta) return <EtiquetaEstado estado={ESTADO_FLOTA.docSinVigencia}>Sin vigencia</EtiquetaEstado>;
  const dias = Math.round((new Date(vigenciaHasta).getTime() - Date.now()) / 86_400_000);
  const clave = estadoPorDias(dias);
  if (clave === ESTADO_FLOTA.docVencido) return <EtiquetaEstado estado={clave}>Vencido</EtiquetaEstado>;
  if (clave === ESTADO_FLOTA.docVigente) return <EtiquetaEstado estado={clave}>Vigente</EtiquetaEstado>;
  return <EtiquetaEstado estado={clave}>{dias}d</EtiquetaEstado>;
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
    <FlitModal title="Subir documento" onClose={onClose} icono="nube-subir">
      <form onSubmit={submit} className="space-y-3">
          <FlitField label="Tipo de documento *">
            <select value={tipoId} onChange={(e) => setTipoId(e.target.value)} className={flitInp}>
              <option value="">— seleccione —</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select>
          </FlitField>
          <FlitField label="Número"><input value={numero} onChange={(e) => setNumero(e.target.value)} maxLength={80} className={flitInp} /></FlitField>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FlitField label="Vigencia desde"><input type="date" value={vigenciaDesde} onChange={(e) => setVigenciaDesde(e.target.value)} className={flitInp} /></FlitField>
            <FlitField label={`Vigencia hasta${tipo?.requiereVigencia ? ' *' : ''}`}><input type="date" value={vigenciaHasta} onChange={(e) => setVigenciaHasta(e.target.value)} className={flitInp} /></FlitField>
          </div>
          <FlitField label="Destinatarios extra (separados por coma)">
            <input value={destinatarios} onChange={(e) => setDestinatarios(e.target.value)} placeholder="flota@flit.com.co, admin@flit.com.co" className={flitInp} />
          </FlitField>
          <FlitField label="Archivo (PDF, JPG o PNG, máx 10 MB)">
            <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full rounded-[9px] text-xs text-[color:var(--color-text-secondary)] file:mr-3 file:rounded-full file:border-0 file:bg-[var(--kit-tinta-fija)] file:px-3.5 file:py-1.5 file:text-xs file:text-[color:var(--kit-sobre-relleno)] file:transition-colors hover:file:opacity-90" />
          </FlitField>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>
            {submitting ? 'Subiendo…' : 'Guardar'}
          </GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
