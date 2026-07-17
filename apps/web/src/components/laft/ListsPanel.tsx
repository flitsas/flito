import { useEffect, useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useEscape, useBackdropClose } from '../../lib/hooks';
import { IconClose } from '../flit/icons';
import StatusChip from '../flit/StatusChip';

interface RestrictiveList {
  id: number;
  code: string;
  name: string;
  binding: boolean;
  totalEntries: number;
  lastSyncedAt: string | null;
  active: boolean;
}

interface SyncResult {
  listCode: string;
  fetched: number;
  inserted: number;
  errors: number;
  durationMs: number;
}

const AUTO_SYNC_CODES = ['OFAC', 'UN', 'EU'];
const MANUAL_UPLOAD_CODES = ['PROCURADURIA', 'CONTRALORIA', 'POLICIA', 'INTERPOL', 'CLINTON'];

export default function ListsPanel({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const [lists, setLists] = useState<RestrictiveList[]>([]);
  useEscape(onClose);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [uploadingCode, setUploadingCode] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<RestrictiveList[]>('/laft/lists');
      setLists(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error cargando listas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const sync = async (code: string) => {
    if (syncing) return;
    setSyncing(code);
    try {
      const res = await api.post<SyncResult>(`/laft/lists/${code}/sync`, {});
      toast.success(`${code}: ${res.inserted} insertados de ${res.fetched} (${(res.durationMs / 1000).toFixed(1)}s)`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error sincronizando');
    } finally {
      setSyncing(null);
    }
  };

  const triggerUpload = (code: string) => {
    if (uploadingCode || syncing) return;
    setUploadingCode(code);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file || !uploadingCode) { setUploadingCode(null); return; }
    if (!file.name.toLowerCase().endsWith('.csv')) { toast.error('Solo archivos CSV'); setUploadingCode(null); return; }
    if (file.size > 25 * 1024 * 1024) { toast.error('Archivo excede 25MB'); setUploadingCode(null); return; }

    try {
      const res = await api.upload<SyncResult>(`/laft/lists/${uploadingCode}/upload-csv`, file, 'file');
      toast.success(`${uploadingCode}: ${res.inserted} insertados de ${res.fetched} (${res.errors} omitidos)`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error subiendo CSV');
    } finally {
      setUploadingCode(null);
    }
  };

  const isAdmin = user?.role === 'admin';

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4" style={{ background: 'rgba(22, 39, 68, 0.45)', backdropFilter: 'blur(6px)' }} {...useBackdropClose(onClose)}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Listas restrictivas"
        className="my-8 w-full max-w-3xl"
        style={{ background: 'var(--flit-bg-modal)', borderRadius: 'var(--flit-radius-xl)', boxShadow: 'var(--flit-shadow-modal)', border: '1px solid var(--flit-border-soft)' }}
      >
        <div className="flex items-center justify-between px-8 py-4" style={{ borderBottom: '1px solid var(--flit-border-soft)' }}>
          <div>
            <h2 className="text-lg font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>Listas restrictivas</h2>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Catálogo de fuentes consultadas en cada vinculación</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="flit-focus grid h-9 w-9 place-items-center rounded-lg transition-colors hover:bg-white" style={{ color: 'var(--flit-text-muted)' }}>
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-8 py-5">
          {loading && <p className="py-12 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</p>}
          {!loading && (
            <div className="space-y-2">
              {lists.map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-3 rounded-[12px] p-4" style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{l.name}</p>
                      {l.binding
                        ? <StatusChip tone="danger">VINCULANTE</StatusChip>
                        : <StatusChip tone="neutral">REFERENCIA</StatusChip>}
                    </div>
                    <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                      {l.totalEntries.toLocaleString('es-CO')} registros
                      {l.lastSyncedAt && ` · Última sincronización: ${new Date(l.lastSyncedAt).toLocaleString('es-CO')}`}
                      {!l.lastSyncedAt && ' · No sincronizada'}
                    </p>
                  </div>
                  {isAdmin && AUTO_SYNC_CODES.includes(l.code) && (
                    <button
                      type="button"
                      onClick={() => sync(l.code)}
                      disabled={syncing !== null || uploadingCode !== null}
                      className="flit-focus inline-flex h-9 shrink-0 items-center rounded-[999px] px-3 text-xs font-semibold transition-colors disabled:opacity-50"
                      style={{ background: 'rgba(79,116,201,0.14)', color: 'var(--flit-blue)' }}
                    >
                      {syncing === l.code ? 'Descargando...' : 'Sincronizar'}
                    </button>
                  )}
                  {isAdmin && MANUAL_UPLOAD_CODES.includes(l.code) && (
                    <button
                      type="button"
                      onClick={() => triggerUpload(l.code)}
                      disabled={syncing !== null || uploadingCode !== null}
                      className="flit-focus inline-flex h-9 shrink-0 items-center rounded-[999px] px-3 text-xs font-semibold transition-colors disabled:opacity-50"
                      style={{ background: 'rgba(112,207,58,0.14)', color: 'var(--flit-success)' }}
                    >
                      {uploadingCode === l.code ? 'Cargando...' : 'Cargar CSV'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 rounded-[12px] p-4 text-xs" style={{ background: 'rgba(79,116,201,0.08)', border: '1px solid rgba(79,116,201,0.20)', color: 'var(--flit-text-secondary)' }}>
            <p className="mb-1.5 font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Cómo funciona</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>Las listas <b style={{ color: 'var(--flit-text-primary)' }}>vinculantes</b> bloquean automáticamente si hay match exacto de documento.</li>
              <li>Match por nombre con score ≥85 marca la contraparte como pendiente de revisión humana.</li>
              <li>Las listas de <b style={{ color: 'var(--flit-text-primary)' }}>referencia</b> disparan debida diligencia intensificada sin bloqueo automático.</li>
              <li>OFAC, ONU y UE se sincronizan automáticamente desde sus fuentes oficiales.</li>
              <li>Procuraduría, Contraloría, Policía e INTERPOL se actualizan vía carga de CSV (los portales requieren autenticación humana).</li>
            </ul>
            <p className="mb-1 mt-3 font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Formato CSV esperado</p>
            <p>
              Columnas (cualquier orden): <code className="rounded bg-white px-1 py-0.5" style={{ border: '1px solid var(--flit-border-soft)' }}>documento</code>,{' '}
              <code className="rounded bg-white px-1 py-0.5" style={{ border: '1px solid var(--flit-border-soft)' }}>nombre</code>. Opcionales:{' '}
              <code className="rounded bg-white px-1 py-0.5" style={{ border: '1px solid var(--flit-border-soft)' }}>alias</code>,{' '}
              <code className="rounded bg-white px-1 py-0.5" style={{ border: '1px solid var(--flit-border-soft)' }}>pais</code>,{' '}
              <code className="rounded bg-white px-1 py-0.5" style={{ border: '1px solid var(--flit-border-soft)' }}>fecha_nacimiento</code>,{' '}
              <code className="rounded bg-white px-1 py-0.5" style={{ border: '1px solid var(--flit-border-soft)' }}>observacion</code>.
            </p>
          </div>
        </div>

        <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFileChange} className="hidden" />

        <div className="flex justify-end px-8 py-4" style={{ borderTop: '1px solid var(--flit-border-soft)' }}>
          <button
            type="button"
            onClick={onClose}
            className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-4 text-sm font-medium"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
