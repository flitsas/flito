import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import DriverDocumentsPanel from '../components/pesv/DriverDocumentsPanel';
import PageHeaderCard from '../components/flit/PageHeaderCard';

interface Profile {
  cedula: string | null;
  fechaNacimiento: string | null;
  licenciaNumero: string;
  categorias: string[];
  licenciaVigencia: string | null;
  examenPsicoFecha: string | null;
  examenPsicoVigencia: string | null;
  restriccionesMedicas: string[];
  arl: string | null;
  eps: string | null;
  fondoPensiones: string | null;
  contratoTipo: string | null;
  experienciaAnios: string;
  sancionesCount: number;
}
interface User { id: number; name: string; username: string; email: string | null; }
interface Detail { user: User; profile: Profile | null; documentosCount: number; incidentesCount: number; }

interface IncidentRow {
  id: number; tipo: string; fecha: string; gravedad: string; estado: string;
  descripcion: string | null; plate: string | null; victimasCount: number;
}

type Tab = 'datos' | 'documentos' | 'capacitaciones' | 'incidentes';

const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function DriverDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>('datos');

  const load = useCallback(async () => {
    if (!id) return;
    try { setD(await api.get<Detail>(`/drivers/${id}`)); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <div className="p-6 text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</div>;
  const p = d.profile;

  const subtitle = `@${d.user.username} · ${d.user.email || 'sin email'}`
    + (p ? ` · Licencia ${p.licenciaNumero} · Categorías: ${p.categorias.join(', ')} · ${p.contratoTipo}` : '');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <div>
        <Link to="/pesv/conductores" className="text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>← Conductores</Link>
      </div>
      <PageHeaderCard title={d.user.name} subtitle={subtitle} />

      <div style={{ borderBottom: '1px solid var(--flit-border-soft)' }}>
        <nav className="-mb-px flex gap-6 flex-wrap">
          <TabBtn active={tab === 'datos'} onClick={() => setTab('datos')}>Datos</TabBtn>
          <TabBtn active={tab === 'documentos'} onClick={() => setTab('documentos')}>Documentos ({d.documentosCount})</TabBtn>
          <TabBtn active={tab === 'capacitaciones'} onClick={() => setTab('capacitaciones')}>Capacitaciones</TabBtn>
          <TabBtn active={tab === 'incidentes'} onClick={() => setTab('incidentes')}>Incidentes ({d.incidentesCount})</TabBtn>
        </nav>
      </div>

      {tab === 'datos' && p && <DatosPanel p={p} />}
      {tab === 'datos' && !p && <div className="bg-white p-6 text-sm" style={{ ...CARD, color: 'var(--flit-text-muted)' }}>Conductor sin perfil registrado</div>}
      {tab === 'documentos' && <DriverDocumentsPanel userId={Number(id)} canEdit={isAdmin} />}
      {tab === 'capacitaciones' && <CapacitacionesPanel userId={Number(id)} />}
      {tab === 'incidentes' && <IncidentesPanel userId={Number(id)} />}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flit-focus pb-2 text-sm font-semibold transition-colors"
      style={{
        borderBottom: `2px solid ${active ? 'var(--flit-blue)' : 'transparent'}`,
        color: active ? 'var(--flit-blue)' : 'var(--flit-text-muted)',
      }}
    >
      {children}
    </button>
  );
}

function DatosPanel({ p }: { p: Profile }) {
  const rows: [string, string | number | null | undefined][] = [
    ['Cédula', p.cedula],
    ['Fecha de nacimiento', p.fechaNacimiento],
    ['Licencia', p.licenciaNumero],
    ['Categorías', p.categorias.join(', ')],
    ['Vigencia licencia', p.licenciaVigencia],
    ['Examen psicosensométrico', p.examenPsicoFecha],
    ['Vigencia examen', p.examenPsicoVigencia],
    ['Restricciones médicas', p.restriccionesMedicas.join(', ') || '—'],
    ['ARL', p.arl],
    ['EPS', p.eps],
    ['Fondo de pensiones', p.fondoPensiones],
    ['Tipo de contrato', p.contratoTipo],
    ['Experiencia (años)', p.experienciaAnios],
    ['Sanciones', p.sancionesCount],
  ];
  return (
    <div className="bg-white p-6" style={CARD}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm md:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
            <dd className="font-medium" style={{ color: 'var(--flit-text-primary)' }}>{v ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CapacitacionesPanel({ userId }: { userId: number }) {
  const [rows, setRows] = useState<{ year: number; horas: number }[]>([]);
  useEffect(() => {
    const year = new Date().getFullYear();
    api.get<{ data: { userId: number; horas: number }[] }>(`/drivers/trainings/report/horas-conductor?year=${year}`)
      .then((r) => {
        const mine = r.data.find((x) => x.userId === userId);
        setRows([{ year, horas: mine?.horas ?? 0 }]);
      })
      .catch((err) => toast.error(errorMessage(err)));
  }, [userId]);
  return (
    <div className="bg-white p-6" style={CARD}>
      <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Horas de capacitación por año</h3>
      <ul className="text-sm">
        {rows.map((r) => (
          <li key={r.year} className="flex items-center justify-between border-t py-2 first:border-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <span style={{ color: 'var(--flit-text-secondary)' }}>{r.year}</span>
            <span className="font-bold tabular-nums" style={{ color: 'var(--flit-blue)' }}>{r.horas} h</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Para registrar asistencia, ve a /pesv/capacitaciones.</p>
    </div>
  );
}

function IncidentesPanel({ userId }: { userId: number }) {
  const [items, setItems] = useState<IncidentRow[]>([]);
  useEffect(() => {
    api.get<{ data: IncidentRow[] }>(`/drivers/incidents?conductorId=${userId}`)
      .then((r) => setItems(r.data))
      .catch((err) => toast.error(errorMessage(err)));
  }, [userId]);
  return (
    <div className="overflow-hidden bg-white" style={CARD}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr>
            <Th>Fecha</Th><Th>Tipo</Th><Th>Gravedad</Th><Th>Vehículo</Th><Th>Víctimas</Th><Th>Estado</Th>
          </tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={6} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin incidentes registrados</td></tr>}
            {items.map((i) => (
              <tr key={i.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{i.fecha}</td>
                <td className="px-4 py-3 capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{i.tipo.replace('_', ' ')}</td>
                <td className="px-4 py-3 capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{i.gravedad}</td>
                <td className="px-4 py-3" style={{ color: 'var(--flit-text-secondary)' }}>{i.plate || '—'}</td>
                <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{i.victimasCount}</td>
                <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-muted)' }}>{i.estado}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}
