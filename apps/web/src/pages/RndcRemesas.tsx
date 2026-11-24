import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import FiltroSegmentado from '../components/flit/FiltroSegmentado';
import { flitBtnPrimary } from '../components/flit/flitPageKit';

interface RemesaRow {
  id: number;
  numero: string;
  consecutivoRndc: string | null;
  estado: 'borrador' | 'activa' | 'cumplida' | 'anulada';
  clientId: number | null;
  clientName: string | null;
  origenNombre: string | null;
  municipioOrigenDane: string;
  municipioDestinoDane: string;
  cantidadCargada: string;
  pesoKg: string | null;
  valorFlete: string;
  fechaCargue: string;
  manifiestoId: number | null;
  cumplidoAt: string | null;
}

const ESTADOS = ['', 'borrador', 'activa', 'cumplida', 'anulada'];

const ESTADO_TONE: Record<string, ChipTone> = {
  borrador: 'neutral', activa: 'active', cumplida: 'success', anulada: 'danger',
};


export default function RndcRemesas() {
  const [items, setItems] = useState<RemesaRow[]>([]);
  const [estado, setEstado] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (estado) params.set('estado', estado);
      const r = await api.get<{ data: RemesaRow[] }>(`/rndc/remesas${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setLoading(false); }
  }, [estado]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Remesas de carga"
        subtitle="RNDC · Documentos de despacho que se agrupan en manifiestos electrónicos"
        icono="flito-rndc"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'RNDC', to: '/rndc' }]}
        actions={
          <Link to="/rndc/remesas/nueva" className={flitBtnPrimary}>
            Nueva remesa
          </Link>
        }
      />

      <div className="[&_button]:capitalize">
        <FiltroSegmentado
          ariaLabel="Filtrar por estado"
          opciones={ESTADOS.map((e) => ({ valor: e, etiqueta: e || 'Todos' }))}
          valor={estado}
          onCambio={setEstado}
        />
      </div>

      <DataTable
        ariaLabel="Remesas de carga"
        columnas={COLUMNAS}
        filas={items}
        getKey={(r) => String(r.id)}
        status={loading ? 'loading' : undefined}
        emptyMessage="Sin remesas"
      />
    </div>
  );
}

const TXT2 = 'text-xs text-[color:var(--color-text-secondary)]';

const COLUMNAS: ColumnaTabla<RemesaRow>[] = [
  { key: 'numero', header: 'Número', render: (r) => (
    <span className="text-xs">
      <Link to={`/rndc/remesas/${r.id}`} className="font-semibold text-[color:var(--color-text-primary)] hover:underline">{r.numero}</Link>
      {r.consecutivoRndc && <span className="block text-[0.75rem] text-[color:var(--kit-verde-texto)]">RNDC {r.consecutivoRndc}</span>}
    </span>
  ) },
  { key: 'cliente', header: 'Cliente', render: (r) => <span className={TXT2}>{r.clientName ?? '—'}</span> },
  { key: 'ruta', header: 'Ruta', render: (r) => <span className={TXT2}>{r.municipioOrigenDane} → {r.municipioDestinoDane}</span> },
  { key: 'cantidad', header: 'Cantidad', render: (r) => <span className={TXT2}>{Number(r.cantidadCargada).toLocaleString('es-CO')}</span> },
  { key: 'flete', header: 'Flete', render: (r) => <span className="text-xs font-medium text-[color:var(--color-text-primary)]">$ {Number(r.valorFlete).toLocaleString('es-CO')}</span> },
  { key: 'fecha', header: 'Fecha', render: (r) => <span className={TXT2}>{r.fechaCargue}</span> },
  { key: 'estado', header: 'Estado', render: (r) => <StatusChip tone={ESTADO_TONE[r.estado] ?? 'neutral'}>{r.estado}</StatusChip> },
  { key: 'manifiesto', header: 'Manifiesto', render: (r) => (
    <span className="text-xs">
      {r.manifiestoId ? (
        <Link to={`/rndc/manifiestos/${r.manifiestoId}`} className="text-[color:var(--color-action)] hover:underline">#{r.manifiestoId}</Link>
      ) : <span className="text-[color:var(--color-text-tertiary)]">—</span>}
    </span>
  ) },
];
