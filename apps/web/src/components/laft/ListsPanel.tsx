import { useEffect, useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useEscape } from '../../lib/hooks';
import StatusChip from '../flit/StatusChip';
import FlitModal from '../flit/FlitModal';
import GradientButton from '../flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';

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
  const { hasFuncion } = useAuth();
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

  const isAdmin = hasFuncion('laft.listas.administrar');

  const columnas: ColumnaTabla<RestrictiveList>[] = [
    {
      key: 'lista',
      header: 'Lista',
      render: (l) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[color:var(--color-text-primary)]">{l.name}</span>
          {l.binding
            ? <StatusChip tone="danger">VINCULANTE</StatusChip>
            : <StatusChip tone="neutral">REFERENCIA</StatusChip>}
        </div>
      ),
    },
    {
      key: 'registros',
      header: 'Registros',
      render: (l) => (
        <span className="text-xs text-[color:var(--color-text-tertiary)]">
          {l.totalEntries.toLocaleString('es-CO')} registros
          {l.lastSyncedAt && ` · Última sincronización: ${new Date(l.lastSyncedAt).toLocaleString('es-CO')}`}
          {!l.lastSyncedAt && ' · No sincronizada'}
        </span>
      ),
    },
    {
      key: 'acciones',
      header: <span className="sr-only">Acciones</span>,
      acciones: true,
      align: 'right',
      render: (l) => (
        <>
          {isAdmin && AUTO_SYNC_CODES.includes(l.code) && (
            <GradientButton
              type="button"
              size="sm"
              variant="primary"
              onClick={() => sync(l.code)}
              disabled={syncing !== null || uploadingCode !== null}
            >
              {syncing === l.code ? 'Descargando...' : 'Sincronizar'}
            </GradientButton>
          )}
          {isAdmin && MANUAL_UPLOAD_CODES.includes(l.code) && (
            <GradientButton
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => triggerUpload(l.code)}
              disabled={syncing !== null || uploadingCode !== null}
            >
              {uploadingCode === l.code ? 'Cargando...' : 'Cargar CSV'}
            </GradientButton>
          )}
        </>
      ),
    },
  ];

  const codigo = 'rounded-[5px] border border-[color:var(--color-border)] bg-[color:var(--color-surface-elevated)] px-1 py-0.5';
  const fuerte = 'text-[color:var(--color-text-primary)]';

  return (
    <FlitModal title="Listas restrictivas" onClose={onClose} wide icono="lista">
      <p className="mb-4 text-center text-xs text-[color:var(--color-text-tertiary)]">Catálogo de fuentes consultadas en cada vinculación</p>

      <DataTable
        ariaLabel="Listas restrictivas"
        columnas={columnas}
        filas={lists}
        getKey={(l) => String(l.id)}
        status={loading ? 'loading' : undefined}
        onRetry={load}
      />

      <div className="mt-6 rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4 text-xs text-[color:var(--color-text-secondary)]">
        <p className={`mb-1.5 font-semibold ${fuerte}`}>Cómo funciona</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>Las listas <b className={fuerte}>vinculantes</b> bloquean automáticamente si hay match exacto de documento.</li>
          <li>Match por nombre con score ≥85 marca la contraparte como pendiente de revisión humana.</li>
          <li>Las listas de <b className={fuerte}>referencia</b> disparan debida diligencia intensificada sin bloqueo automático.</li>
          <li>OFAC, ONU y UE se sincronizan automáticamente desde sus fuentes oficiales.</li>
          <li>Procuraduría, Contraloría, Policía e INTERPOL se actualizan vía carga de CSV (los portales requieren autenticación humana).</li>
        </ul>
        <p className={`mb-1 mt-3 font-semibold ${fuerte}`}>Formato CSV esperado</p>
        <p>
          Columnas (cualquier orden): <code className={codigo}>documento</code>,{' '}
          <code className={codigo}>nombre</code>. Opcionales:{' '}
          <code className={codigo}>alias</code>,{' '}
          <code className={codigo}>pais</code>,{' '}
          <code className={codigo}>fecha_nacimiento</code>,{' '}
          <code className={codigo}>observacion</code>.
        </p>
      </div>

      <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFileChange} className="hidden" />

      <div className="mt-6 flex justify-end border-t border-[color:var(--color-border)] pt-4">
        <GradientButton type="button" variant="secondary" onClick={onClose}>
          Cerrar
        </GradientButton>
      </div>
    </FlitModal>
  );
}
