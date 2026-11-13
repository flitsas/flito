import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import DriverDocumentsPanel from '../components/pesv/DriverDocumentsPanel';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import Pestanas from '../components/flit/Pestanas';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { Cargador, Vacio } from '../components/flit/Cargador';
import { Fichas } from '../components/flit/Bloques';
import { FlitCard } from '../components/flit/flitPageKit';

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

export default function DriverDetail() {
  const { id } = useParams<{ id: string }>();
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('drivers.conductores.administrar');
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>('datos');

  const load = useCallback(async () => {
    if (!id) return;
    try { setD(await api.get<Detail>(`/drivers/${id}`)); }
    catch (err) { toast.error(errorMessage(err)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <Cargador className="p-6" />;
  const p = d.profile;

  const subtitle = `@${d.user.username} · ${d.user.email || 'sin email'}`
    + (p ? ` · Licencia ${p.licenciaNumero} · Categorías: ${p.categorias.join(', ')} · ${p.contratoTipo}` : '');

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title={d.user.name}
        subtitle={subtitle}
        icono="flito-conductores"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }, { etiqueta: 'Conductores', to: '/pesv/conductores' }, { etiqueta: d.user.name }]}
      />

      <Pestanas
        etiqueta="Secciones del conductor"
        activa={tab}
        onElegir={(t) => setTab(t as Tab)}
        pestanas={[
          { id: 'datos', etiqueta: 'Datos' },
          { id: 'documentos', etiqueta: `Documentos (${d.documentosCount})` },
          { id: 'capacitaciones', etiqueta: 'Capacitaciones' },
          { id: 'incidentes', etiqueta: `Incidentes (${d.incidentesCount})` },
        ]}
      />

      {tab === 'datos' && p && <DatosPanel p={p} />}
      {tab === 'datos' && !p && <FlitCard><Vacio texto="Conductor sin perfil registrado" icono="credencial" /></FlitCard>}
      {tab === 'documentos' && <DriverDocumentsPanel userId={Number(id)} canEdit={isAdmin} />}
      {tab === 'capacitaciones' && <CapacitacionesPanel userId={Number(id)} />}
      {tab === 'incidentes' && <IncidentesPanel userId={Number(id)} />}
    </div>
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
    <FlitCard>
      <Fichas items={rows.map(([k, v]) => ({ etiqueta: k, valor: v ?? '—' }))} />
    </FlitCard>
  );
}

function CapacitacionesPanel({ userId }: { userId: number }) {
  const [rows, setRows] = useState<{ year: number; horas: number }[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  useEffect(() => {
    const year = new Date().getFullYear();
    api.get<{ data: { userId: number; horas: number }[] }>(`/drivers/trainings/report/horas-conductor?year=${year}`)
      .then((r) => {
        const mine = r.data.find((x) => x.userId === userId);
        setRows([{ year, horas: mine?.horas ?? 0 }]);
      })
      .catch((err) => setAviso(avisoPanel(err, 'Capacitaciones', 'las horas de capacitación')));
  }, [userId]);
  return (
    <FlitCard>
      <h3 className="mb-2 text-sm font-semibold text-[color:var(--color-text-primary)]">Horas de capacitación por año</h3>
      {aviso && <p role="status" className="py-2 text-sm text-[color:var(--color-text-tertiary)]">{aviso}</p>}
      <ul className="text-sm">
        {rows.map((r) => (
          <li key={r.year} className="flex items-center justify-between border-t border-[color:var(--color-border)] py-2 first:border-0">
            <span className="text-[color:var(--color-text-secondary)]">{r.year}</span>
            <span className="font-bold tabular-nums text-[color:var(--color-action)]">{r.horas} h</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[0.6875rem] text-[color:var(--color-text-tertiary)]">Para registrar asistencia, ve a /pesv/capacitaciones.</p>
    </FlitCard>
  );
}

function IncidentesPanel({ userId }: { userId: number }) {
  const [items, setItems] = useState<IncidentRow[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ data: IncidentRow[] }>(`/drivers/incidents?conductorId=${userId}`)
      .then((r) => setItems(r.data))
      .catch((err) => setAviso(avisoPanel(err, 'Incidentes', 'los incidentes del conductor')));
  }, [userId]);
  if (aviso) {
    return <p role="status" className="card text-sm text-[color:var(--color-text-tertiary)]">{aviso}</p>;
  }
  const columnas: ColumnaTabla<IncidentRow>[] = [
    { key: 'fecha', header: 'Fecha', render: (i) => <span className="text-[color:var(--color-text-secondary)]">{i.fecha}</span> },
    { key: 'tipo', header: 'Tipo', render: (i) => <span className="capitalize text-[color:var(--color-text-secondary)]">{i.tipo.replace('_', ' ')}</span> },
    { key: 'gravedad', header: 'Gravedad', render: (i) => <span className="capitalize text-[color:var(--color-text-secondary)]">{i.gravedad}</span> },
    { key: 'vehiculo', header: 'Vehículo', render: (i) => <span className="text-[color:var(--color-text-secondary)]">{i.plate || '—'}</span> },
    { key: 'victimas', header: 'Víctimas', render: (i) => <span className="tabular-nums text-[color:var(--color-text-secondary)]">{i.victimasCount}</span> },
    { key: 'estado', header: 'Estado', render: (i) => <span className="text-xs capitalize text-[color:var(--color-text-tertiary)]">{i.estado}</span> },
  ];
  return (
    <DataTable
      ariaLabel="Incidentes del conductor"
      columnas={columnas}
      filas={items}
      getKey={(i) => String(i.id)}
      emptyMessage="Sin incidentes registrados"
    />
  );
}

// HU #13421: las pestañas del detalle leen endpoints de OTROS ítems del menú (Capacitaciones,
// Incidentes). Quien tiene «Conductores» sin ese ítem recibe 403: la pestaña lo dice en su sitio,
// sin toast ni error crudo, y el resto del detalle sigue funcionando.
function avisoPanel(err: unknown, item: string, que: string): string {
  if (err instanceof ApiError && err.status === 403) return `No tienes acceso a ${que}: depende del permiso de ${item}.`;
  return `No se pudieron cargar ${que}. Vuelve a abrir la pestaña para reintentar.`;
}
