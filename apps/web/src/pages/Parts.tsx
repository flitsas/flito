import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import PanelFiltros from '../components/flit/PanelFiltros';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { flitInp, FlitField } from '../components/flit/flitPageKit';
import { ESTADO_STOCK_BAJO } from '../components/maintenance/estados-mantenimiento';

interface Part {
  id: number; codigo: string; nombre: string;
  unidadMedida: string; inventariable: boolean;
  existenciaMin: string; existenciaMax: string | null;
  valorPromedio: string; systemId: number | null;
  stockTotal: string;
}
interface Location { id: number; codigo: string; nombre: string; }

const UNIDADES = ['und', 'lt', 'gal', 'kg', 'mt', 'cm'];

export default function Parts() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('maintenance.inicio.administrar');
  const [items, setItems] = useState<Part[]>([]);
  const [search, setSearch] = useState('');
  const [conStockBajo, setConStockBajo] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showMovement, setShowMovement] = useState<Part | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (conStockBajo) params.set('conStockBajo', '1');
      const r = await api.get<{ data: Part[] }>(`/parts${params.toString() ? '?' + params.toString() : ''}`);
      setItems(r.data);
    } catch (err) { toast.error(errorMessage(err)); }
  }, [search, conStockBajo]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<{ data: Location[] }>('/parts/locations').then((r) => setLocations(r.data)).catch(() => {}); }, []);

  const columnas: ColumnaTabla<Part>[] = [
    { key: 'codigo', header: 'Código', etiqueta: 'Código', render: (p) => <span className="font-mono text-xs text-[color:var(--color-text-secondary)]">{p.codigo}</span> },
    { key: 'nombre', header: 'Nombre', etiqueta: 'Nombre', render: (p) => <span className="font-medium text-[color:var(--color-text-primary)]">{p.nombre}</span> },
    { key: 'unidad', header: 'Unidad', etiqueta: 'Unidad', render: (p) => <span className="text-[color:var(--color-text-secondary)]">{p.unidadMedida}</span> },
    {
      key: 'stock', header: 'Stock', etiqueta: 'Stock',
      render: (p) => {
        const stock = Number(p.stockTotal);
        const low = stock < Number(p.existenciaMin);
        return low
          ? <EtiquetaEstado estado={ESTADO_STOCK_BAJO}><span className="tabular-nums font-semibold">{stock}</span></EtiquetaEstado>
          : <span className="tabular-nums font-semibold text-[color:var(--color-text-primary)]">{stock}</span>;
      },
    },
    { key: 'min', header: 'Mín', etiqueta: 'Mín', render: (p) => <span className="tabular-nums text-[color:var(--color-text-tertiary)]">{Number(p.existenciaMin) || '—'}</span> },
    {
      key: 'costo', header: 'Costo prom.', etiqueta: 'Costo prom.',
      render: (p) => <span className="tabular-nums text-[color:var(--color-text-secondary)]">{Number(p.valorPromedio).toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 })}</span>,
    },
    {
      key: 'acciones', header: '', acciones: true, align: 'right',
      render: (p) => (isAdmin ? (
        <GradientButton type="button" variant="secondary" size="sm" onClick={() => setShowMovement(p)}>Movimiento</GradientButton>
      ) : null),
    },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Repuestos"
        subtitle="Inventario con costo promedio ponderado y kardex automático"
        icono="flito-repuestos"
        miga={[{ etiqueta: 'Mantenimiento', to: '/maintenance' }]}
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo repuesto</GradientButton> : undefined}
      />

      <PanelFiltros
        busqueda={search}
        onBusqueda={setSearch}
        placeholder="Buscar por código o nombre"
        aplicados={conStockBajo ? [{ id: 'stock-bajo', etiqueta: 'Solo stock bajo' }] : []}
        onQuitar={() => setConStockBajo(false)}
        campos={(
          <label className="flex min-h-10 items-center gap-2 text-sm text-[color:var(--color-text-secondary)]">
            <input type="checkbox" className="h-4 w-4 accent-[var(--kit-azul)]" checked={conStockBajo} onChange={(e) => setConStockBajo(e.target.checked)} />
            Solo stock bajo
          </label>
        )}
      />

      <DataTable
        ariaLabel="Repuestos"
        columnas={columnas}
        filas={items}
        getKey={(p) => String(p.id)}
        emptyMessage="Sin repuestos"
      />

      {showCreate && <PartForm onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
      {showMovement && (
        <MovementForm
          part={showMovement} locations={locations}
          onClose={() => setShowMovement(null)}
          onSaved={() => { setShowMovement(null); load(); }}
        />
      )}
    </div>
  );
}

function PartForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [codigo, setCodigo] = useState('');
  const [nombre, setNombre] = useState('');
  const [unidad, setUnidad] = useState('und');
  const [existenciaMin, setExistenciaMin] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!codigo.trim() || !nombre.trim()) { toast.error('Código y nombre requeridos'); return; }
    setSubmitting(true);
    try {
      await api.post('/parts', {
        codigo: codigo.trim().toUpperCase(),
        nombre: nombre.trim(),
        unidadMedida: unidad,
        existenciaMin: parseFloat(existenciaMin) || 0,
      });
      toast.success('Repuesto creado');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Nuevo repuesto" onClose={onClose} icono="mas">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Código *"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} maxLength={30} className={flitInp} /></FlitField>
        <FlitField label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={150} className={flitInp} /></FlitField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FlitField label="Unidad"><select value={unidad} onChange={(e) => setUnidad(e.target.value)} className={flitInp}>{UNIDADES.map((u) => <option key={u} value={u}>{u}</option>)}</select></FlitField>
          <FlitField label="Stock mínimo"><input type="number" min="0" step="0.01" value={existenciaMin} onChange={(e) => setExistenciaMin(e.target.value)} className={flitInp} /></FlitField>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Crear'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}

type MovementTipo = 'entrada' | 'salida' | 'traslado' | 'ajuste';

function MovementForm({ part, locations, onClose, onSaved }: { part: Part; locations: Location[]; onClose: () => void; onSaved: () => void }) {
  const [tipo, setTipo] = useState<MovementTipo>('entrada');
  const [cantidad, setCantidad] = useState('');
  const [valorUnit, setValorUnit] = useState('');
  const [origenId, setOrigenId] = useState<string>('');
  const [destinoId, setDestinoId] = useState<string>(locations[0]?.id ? String(locations[0].id) : '');
  const [factura, setFactura] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = parseFloat(cantidad);
    if (!Number.isFinite(q) || q <= 0) { toast.error('Cantidad inválida'); return; }
    if (tipo === 'entrada' && (!destinoId || !valorUnit)) { toast.error('Entrada requiere ubicación destino y valor unitario'); return; }
    if (tipo === 'salida' && !origenId) { toast.error('Salida requiere ubicación origen'); return; }
    if (tipo === 'traslado' && (!origenId || !destinoId)) { toast.error('Traslado requiere ambas ubicaciones'); return; }
    if (tipo === 'traslado' && origenId === destinoId) { toast.error('Origen y destino deben ser distintos'); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { tipo, partId: part.id, cantidad: q };
      if (valorUnit) body.valorUnit = parseFloat(valorUnit);
      if (origenId) body.ubicacionOrigenId = parseInt(origenId, 10);
      if (destinoId) body.ubicacionDestinoId = parseInt(destinoId, 10);
      if (factura.trim()) body.factura = factura.trim();
      if (observaciones.trim()) body.observaciones = observaciones.trim();
      await api.post('/parts/movements', body);
      toast.success('Movimiento registrado');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title={`Movimiento — ${part.codigo}`} onClose={onClose} icono="intercambio">
      <form onSubmit={submit} className="space-y-3">
          <FlitField label="Tipo">
            <select value={tipo} onChange={(e) => setTipo(e.target.value as MovementTipo)} className={flitInp}>
              <option value="entrada">Entrada (compra)</option>
              <option value="salida">Salida (consumo)</option>
              <option value="traslado">Traslado entre ubicaciones</option>
              <option value="ajuste">Ajuste de inventario</option>
            </select>
          </FlitField>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FlitField label="Cantidad *"><input type="number" min="0.001" step="0.001" value={cantidad} onChange={(e) => setCantidad(e.target.value)} className={flitInp} /></FlitField>
            {tipo === 'entrada' && (
              <FlitField label="Valor unitario *"><input type="number" min="0" step="0.01" value={valorUnit} onChange={(e) => setValorUnit(e.target.value)} className={flitInp} /></FlitField>
            )}
          </div>
          {(tipo === 'salida' || tipo === 'traslado') && (
            <FlitField label="Ubicación origen *">
              <select value={origenId} onChange={(e) => setOrigenId(e.target.value)} className={flitInp}>
                <option value="">— seleccione —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.codigo} — {l.nombre}</option>)}
              </select>
            </FlitField>
          )}
          {(tipo === 'entrada' || tipo === 'traslado' || tipo === 'ajuste') && (
            <FlitField label="Ubicación destino *">
              <select value={destinoId} onChange={(e) => setDestinoId(e.target.value)} className={flitInp}>
                <option value="">— seleccione —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.codigo} — {l.nombre}</option>)}
              </select>
            </FlitField>
          )}
          {tipo === 'entrada' && <FlitField label="Factura"><input value={factura} onChange={(e) => setFactura(e.target.value)} maxLength={50} className={flitInp} /></FlitField>}
          <FlitField label="Observaciones"><input value={observaciones} onChange={(e) => setObservaciones(e.target.value)} maxLength={500} className={flitInp} /></FlitField>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" disabled={submitting}>{submitting ? 'Guardando…' : 'Registrar'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
