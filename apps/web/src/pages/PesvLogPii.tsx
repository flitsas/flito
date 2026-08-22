import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';

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

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-xs text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

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
        title="Auditoría accesos a datos personales"
        subtitle="PESV · Ley 1581 art. 17 · Log append-only de accesos a PII conductor (multa hasta 2000 SMMLV)"
      />

      {stats && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="bg-white p-6" style={CARD}>
            <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Top usuarios (últimos 30 días)</h3>
            {stats.porUsuario.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin accesos</p>}
            {stats.porUsuario.slice(0, 10).map((u, i) => (
              <div key={i} className="flex justify-between border-b py-2 text-xs last:border-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <span style={{ color: 'var(--flit-text-secondary)' }}>User #{u.user_id} <span style={{ color: 'var(--flit-text-muted)' }}>({u.user_role})</span></span>
                <span className="font-mono font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{u.accesos}</span>
              </div>
            ))}
          </div>
          <div className="bg-white p-6" style={CARD}>
            <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Top recursos accedidos</h3>
            {stats.porRecurso.length === 0 && <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin accesos</p>}
            {stats.porRecurso.slice(0, 10).map((r, i) => (
              <div key={i} className="flex justify-between border-b py-2 text-xs last:border-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <span style={{ color: 'var(--flit-text-secondary)' }}>{r.resource_tipo} <span style={{ color: 'var(--flit-text-muted)' }}>({r.accion})</span></span>
                <span className="font-mono font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{r.accesos}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
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

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Fecha UTC</Th><Th>User</Th><Th>Recurso</Th><Th>Acción</Th><Th>Campos</Th><Th>IP</Th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</td></tr>}
              {!loading && error && (
                <tr><td colSpan={6} className="py-10 text-center">
                  {/* `-ink` y no `--flit-danger` a secas: el token de estado es color de SUPERFICIE
                      y como texto sobre blanco da 4,19:1, por debajo del 4,5:1 de AGENTS.md. La
                      variante tinta existe justo para esto (`flit-tokens.css:59-68`) y da 5,72:1.
                      Las tres páginas LAFT que sirvieron de patrón usan la de superficie; eso es
                      deuda suya, no algo que copiar. */}
                  <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>No se pudo cargar el log de accesos: {error}</p>
                  <button
                    type="button"
                    onClick={() => { void load(); }}
                    className="flit-focus mt-3 inline-flex h-9 items-center rounded-[999px] border bg-white px-3 text-xs font-medium transition-colors"
                    style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
                  >Reintentar</button>
                </td></tr>
              )}
              {!loading && !error && rows.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin accesos para los filtros</td></tr>}
              {!loading && !error && rows.map((r) => (
                <tr key={r.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.accessedAt.replace('T', ' ').slice(0, 19)}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-primary)' }}>#{r.userId ?? '?'} <span style={{ color: 'var(--flit-text-muted)' }}>{r.userRole}</span></td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.resourceTipo}{r.resourceId ? `#${r.resourceId}` : ''}</td>
                  <td className="px-4 py-3 text-xs uppercase tracking-wider" style={{ color: 'var(--flit-text-secondary)' }}>{r.accion}</td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{r.camposAccedidos.join(', ')}</td>
                  <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--flit-text-muted)' }}>{r.ipOrigen ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mismo par de guardas que el `tbody`: el pie DESCRIBE un resultado, así que sin resultado no
          se pinta. Los dos botones se van con él a propósito — su `disabled` se calcula sobre
          `total`, de modo que bajo un fallo quedarían en un estado que no significa nada. */}
      {!loading && !error && (
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Total: {total.toLocaleString()} · página {Math.floor(offset / limit) + 1} de {Math.max(1, Math.ceil(total / limit))}</span>
        <div className="flex gap-2">
          <button onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3 text-xs font-medium transition-colors disabled:opacity-50" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>← Anterior</button>
          <button onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3 text-xs font-medium transition-colors disabled:opacity-50" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>Siguiente →</button>
        </div>
      </div>
      )}
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}
