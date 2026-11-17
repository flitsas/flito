import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import FiltroSegmentado from '../components/flit/FiltroSegmentado';
import { flitBtnPrimary } from '../components/flit/flitPageKit';

interface ManifiestoRow {
  id: number;
  numero: string;
  consecutivoRndc: string | null;
  estado: string;
  fechaExpedicion: string;
  valorFleteTotal: string;
  placaPrincipal: string | null;
  conductorNombre: string | null;
  origenDane: string;
  destinoDane: string;
  radicadoAt: string | null;
  cumplidoAt: string | null;
}

const ESTADOS = ['', 'borrador', 'listo', 'radicado_rndc', 'aceptado', 'rechazado', 'cumplido', 'anulado'];

const ESTADO_TONE: Record<string, ChipTone> = {
  borrador: 'neutral', listo: 'active', radicado_rndc: 'active',
  aceptado: 'success', rechazado: 'danger', cumplido: 'success', anulado: 'neutral',
};


export default function RndcManifiestos() {
  const [items, setItems] = useState<ManifiestoRow[]>([]);
  const [estado, setEstado] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (estado) params.set('estado', estado);
      const r = await api.get<{ data: ManifiestoRow[] }>(`/rndc/manifiestos${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setLoading(false); }
  }, [estado]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Manifiestos electrónicos"
        subtitle="RNDC · Documentos legales de transporte de carga ante Mintransporte"
        icono="flito-rndc"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'RNDC', to: '/rndc' }]}
        actions={
          <Link to="/rndc/manifiestos/nuevo" className={flitBtnPrimary}>
            Nuevo manifiesto
          </Link>
        }
      />

      <div className="[&_button]:capitalize">
        <FiltroSegmentado
          ariaLabel="Filtrar por estado"
          opciones={ESTADOS.map((e) => ({ valor: e, etiqueta: (e || 'Todos').replace('_', ' ') }))}
          valor={estado}
          onCambio={setEstado}
        />
      </div>

      <DataTable
        ariaLabel="Manifiestos electrónicos"
        columnas={COLUMNAS}
        filas={items}
        getKey={(m) => String(m.id)}
        status={loading ? 'loading' : undefined}
        emptyMessage="Sin manifiestos"
      />
    </div>
  );
}

const TXT2 = 'text-xs text-[color:var(--color-text-secondary)]';

const COLUMNAS: ColumnaTabla<ManifiestoRow>[] = [
  { key: 'numero', header: 'Número', render: (m) => (
    <span className="text-xs">
      <Link to={`/rndc/manifiestos/${m.id}`} className="font-semibold text-[color:var(--color-text-primary)] hover:underline">{m.numero}</Link>
      {m.consecutivoRndc && <span className="block text-[0.75rem] text-[color:var(--kit-verde-texto)]">RNDC {m.consecutivoRndc}</span>}
    </span>
  ) },
  { key: 'vehiculo', header: 'Vehículo', render: (m) => <span className={`${TXT2} font-medium`}>{m.placaPrincipal ?? '—'}</span> },
  { key: 'conductor', header: 'Conductor', render: (m) => <span className={TXT2}>{m.conductorNombre ?? '—'}</span> },
  { key: 'ruta', header: 'Ruta', render: (m) => <span className={TXT2}>{m.origenDane} → {m.destinoDane}</span> },
  { key: 'flete', header: 'Flete', render: (m) => <span className="text-xs font-medium text-[color:var(--color-text-primary)]">$ {Number(m.valorFleteTotal).toLocaleString('es-CO')}</span> },
  { key: 'fecha', header: 'Fecha', render: (m) => <span className={TXT2}>{m.fechaExpedicion}</span> },
  { key: 'estado', header: 'Estado', render: (m) => <StatusChip tone={ESTADO_TONE[m.estado] ?? 'neutral'}>{m.estado.replace('_', ' ')}</StatusChip> },
];
