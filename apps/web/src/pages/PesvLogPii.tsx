import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { FlitCard, flitInp, flitBtnSecondarySm } from '../components/flit/flitPageKit';
import { ListaFila } from '../components/flit/Bloques';

interface Row {
  id: number; userId: number | null; userRole: string | null; resourceTipo: string; resourceId: number | null;
  accion: string; camposAccedidos: string[]; motivo: string | null; ipOrigen: string | null;
  userAgent: string | null; requestId: string | null; accessedAt: string;
}
interface Stats {
  desde: string;
  porUsuario: Array<{ user_id: number; user_role: string; accesos: number }>;
  porRecurso: Array<{ resource_tipo: string; accion: string; accesos: number }>;
}

const inputCls = flitInp;

export default function PesvLogPii() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState({ userId: '', resourceTipo: '', accion: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const limit = 100;

  // Bug #11772. En el log de la Ley 1581 art. 17 —la prueba documental de quién miró datos
  // personales— «no pude leer el registro» y «nadie accedió» son conclusiones OPUESTAS: una obliga
  // a reintentar, la otra cierra una inspección. Por eso el fallo NO puede dejar la pantalla en su
  // estado vacío ni conservar el resultado de la consulta anterior:
  // El `catch` NO limpia `rows` ni `total`, y eso es deliberado: lo único que hace es DECLARAR que
  // no pudo leer. Quien deja de afirmar es el render — la guarda `!loading && !error` que llevan
  // tanto el `tbody` como el pie. Limpiar el estado además sería una segunda mecánica para lo mismo
  // que ninguna prueba puede distinguir (comprobado por mutación en las dos: `rows` y `total`), y
  // la siguiente persona la tomaría por necesaria. Patrón de `LaftAuditPlan`/`LaftManual`/`LaftOfficer`.
  //
  // ██ Y en particular: bajo el fallo el pie NO puede escribir «Total: 0». ██
  //
  // Fue el primer intento de este mismo Bug y está mal por el motivo que abre este comentario:
  // `Total: 0` ES «nadie accedió». Poner cero no neutraliza la afirmación, la sustituye por la
  // afirmación FALSA — y en el log probatorio del art. 17 esa es exactamente la que este Bug
  // persigue. La cura para un dato que no se puede afirmar no es afirmar cero: es NO AFIRMAR.
  // El mismo defecto vive en `LaftUnusual.tsx` («0 operaciones registradas») y en `Laft.tsx`
  // («0 total») — Bug #11768. Tres vistas, dos Bugs, un solo patrón de fallo: **la tabla se movió
  // al cuarto estado y el contador se quedó afirmando cero.**
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (filter.userId) params.set('userId', filter.userId);
    if (filter.resourceTipo) params.set('resourceTipo', filter.resourceTipo);
    if (filter.accion) params.set('accion', filter.accion);
    if (filter.from) params.set('from', filter.from);
    if (filter.to) params.set('to', filter.to);
    try {
      const r = await api.get<{ rows: Row[]; total: number }>('/privacy/pii-access-log?' + params.toString());
      setRows(r.rows ?? []);
      setTotal(r.total ?? 0);
    } catch (e) {
      setError(errorMessage(e));
    } finally { setLoading(false); }
  }, [filter, offset]);

  /**
   * Todo cambio de filtro estrena paginación.
   *
   * Sin este `setOffset(0)` el `useEffect` volvía a pedir con el desplazamiento del filtro anterior:
   * desde la página 2, aplicar un rango con menos de 100 registros mandaba `offset=100`, el backend
   * respondía `rows: []` CORRECTAMENTE —no hay nada en ese desplazamiento— y la vista escribía «Sin
   * accesos para los filtros». Un falso vacío con 200 OK, sin error de por medio que avisara.
   */
  const aplicarFiltro = (cambio: Partial<typeof filter>) => {
    setFilter((f) => ({ ...f, ...cambio }));
    setOffset(0);
  };

  const loadStats = async () => {
    try {
      const r = await api.get<Stats>('/privacy/pii-access-log/stats');
      setStats(r);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { loadStats(); }, []);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        icono="flito-privacidad"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'Privacidad' }]}
        title="Auditoría accesos a datos personales"
        subtitle="PESV · Ley 1581 art. 17 · Log append-only de accesos a PII conductor (multa hasta 2000 SMMLV)"
      />

      {stats && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FlitCard className="!mt-0">
            <h3 className="mb-3 text-sm font-semibold text-[color:var(--color-text-primary)]">Top usuarios (últimos 30 días)</h3>
            {stats.porUsuario.length === 0 && <p className="text-xs text-[color:var(--color-text-tertiary)]">Sin accesos</p>}
            <ListaFila filas={stats.porUsuario.slice(0, 10).map((u, i) => ({
              id: String(i),
              titulo: <>User #{u.user_id}</>,
              detalle: <>({u.user_role})</>,
              extra: <span className="font-mono text-xs font-semibold text-[color:var(--color-text-primary)]">{u.accesos}</span>,
            }))} />
          </FlitCard>
          <FlitCard className="!mt-0">
            <h3 className="mb-3 text-sm font-semibold text-[color:var(--color-text-primary)]">Top recursos accedidos</h3>
            {stats.porRecurso.length === 0 && <p className="text-xs text-[color:var(--color-text-tertiary)]">Sin accesos</p>}
            <ListaFila filas={stats.porRecurso.slice(0, 10).map((r, i) => ({
              id: String(i),
              titulo: <>{r.resource_tipo}</>,
              detalle: <>({r.accion})</>,
              extra: <span className="font-mono text-xs font-semibold text-[color:var(--color-text-primary)]">{r.accesos}</span>,
            }))} />
          </FlitCard>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <input placeholder="userId" value={filter.userId} onChange={(e) => aplicarFiltro({ userId: e.target.value.replace(/\D/g, '') })} className={inputCls} />
        <input placeholder="resourceTipo" value={filter.resourceTipo} onChange={(e) => aplicarFiltro({ resourceTipo: e.target.value })} className={inputCls} />
        <select value={filter.accion} onChange={(e) => aplicarFiltro({ accion: e.target.value })} className={inputCls}>
          <option value="">— acción —</option>
          <option value="read">read</option>
          <option value="decrypt">decrypt</option>
          <option value="export">export</option>
          <option value="search">search</option>
        </select>
        <input type="date" value={filter.from} onChange={(e) => aplicarFiltro({ from: e.target.value })} className={inputCls} />
        <input type="date" value={filter.to} onChange={(e) => aplicarFiltro({ to: e.target.value })} className={inputCls} />
      </div>

      {/* `DataTable` conserva las cuatro ramas que antes vivían en el `tbody`: bajo `error` no pinta
          ninguna fila (ni las de la consulta anterior) y escribe el error con `role="alert"` y
          [Reintentar]; el vacío solo aparece con `!loading && !error` (Bug #11772). */}
      <DataTable
        ariaLabel="Log de accesos a datos personales"
        columnas={COLUMNAS}
        filas={rows}
        getKey={(r) => String(r.id)}
        status={loading ? 'loading' : error ? 'error' : rows.length === 0 ? 'empty' : 'ready'}
        errorMessage={`No se pudo cargar el log de accesos: ${error ?? ''}`}
        onRetry={() => { void load(); }}
        emptyMessage="Sin accesos para los filtros"
      />

      {/* Mismo par de guardas que el `tbody`: el pie DESCRIBE un resultado, así que sin resultado no
          se pinta. Los dos botones se van con él a propósito — su `disabled` se calcula sobre
          `total`, de modo que bajo un fallo quedarían en un estado que no significa nada. */}
      {!loading && !error && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[color:var(--color-text-tertiary)]">Total: {total.toLocaleString()} · página {Math.floor(offset / limit) + 1} de {Math.max(1, Math.ceil(total / limit))}</span>
        <div className="flex gap-2">
          <button onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className={`${flitBtnSecondarySm} disabled:cursor-not-allowed disabled:opacity-50`}>← Anterior</button>
          <button onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className={`${flitBtnSecondarySm} disabled:cursor-not-allowed disabled:opacity-50`}>Siguiente →</button>
        </div>
      </div>
      )}
    </div>
  );
}

const COLUMNAS: ColumnaTabla<Row>[] = [
  { key: 'fecha', header: 'Fecha UTC', render: (r) => <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">{r.accessedAt.replace('T', ' ').slice(0, 19)}</span> },
  { key: 'user', header: 'User', render: (r) => <span className="text-xs text-[color:var(--color-text-primary)]">#{r.userId ?? '?'} <span className="text-[color:var(--color-text-tertiary)]">{r.userRole}</span></span> },
  { key: 'recurso', header: 'Recurso', render: (r) => <span className="text-xs text-[color:var(--color-text-secondary)]">{r.resourceTipo}{r.resourceId ? `#${r.resourceId}` : ''}</span> },
  { key: 'accion', header: 'Acción', render: (r) => <span className="text-xs uppercase tracking-wider text-[color:var(--color-text-secondary)]">{r.accion}</span> },
  { key: 'campos', header: 'Campos', render: (r) => <span className="text-xs text-[color:var(--color-text-secondary)]">{r.camposAccedidos.join(', ')}</span> },
  { key: 'ip', header: 'IP', render: (r) => <span className="font-mono text-xs text-[color:var(--color-text-tertiary)]">{r.ipOrigen ?? '—'}</span> },
];
