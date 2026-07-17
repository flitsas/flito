import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import { flitInp, FlitTh, FlitTr, FlitTable, FlitField, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';

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
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Repuestos"
        subtitle="Inventario con costo promedio ponderado y kardex automático"
        actions={isAdmin ? <GradientButton type="button" onClick={() => setShowCreate(true)}>Nuevo repuesto</GradientButton> : undefined}
      />

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por código o nombre"
          className={`min-w-[240px] flex-1 ${flitInp}`}
        />
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          <input type="checkbox" checked={conStockBajo} onChange={(e) => setConStockBajo(e.target.checked)} />
          Solo stock bajo
        </label>
      </div>

      <FlitTable>
        <table className="w-full text-sm">
          <thead><tr>
            <FlitTh>Código</FlitTh><FlitTh>Nombre</FlitTh><FlitTh>Unidad</FlitTh><FlitTh>Stock</FlitTh><FlitTh>Mín</FlitTh><FlitTh>Costo prom.</FlitTh><FlitTh></FlitTh>
          </tr></thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin repuestos</td></tr>}
            {items.map((p) => {
              const stock = Number(p.stockTotal);
              const min = Number(p.existenciaMin);
              const low = stock < min;
              return (
                <FlitTr key={p.id}>
                  <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{p.codigo}</td>
                  <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{p.nombre}</td>
                  <td className="px-4 py-2.5" style={{ color: 'var(--flit-text-secondary)' }}>{p.unidadMedida}</td>
                  <td className="px-4 py-2.5 tabular-nums font-semibold" style={{ color: low ? '#dc2626' : 'var(--flit-text-primary)' }}>{stock}</td>
                  <td className="px-4 py-2.5 tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{min || '—'}</td>
                  <td className="px-4 py-2.5 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{Number(p.valorPromedio).toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 })}</td>
                  <td className="px-4 py-2.5 text-right">
                    {isAdmin && (
                      <button type="button" onClick={() => setShowMovement(p)} className="text-xs hover:underline" style={{ color: 'var(--flit-blue)' }}>Movimiento</button>
                    )}
                  </td>
                </FlitTr>
              );
            })}
          </tbody>
        </table>
      </FlitTable>

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
    <FlitModal title="Nuevo repuesto" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 px-6 pb-6">
        <FlitField label="Código *"><input value={codigo} onChange={(e) => setCodigo(e.target.value)} maxLength={30} className={flitInp} /></FlitField>
        <FlitField label="Nombre *"><input value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={150} className={flitInp} /></FlitField>
        <div className="grid grid-cols-2 gap-3">
          <FlitField label="Unidad"><select value={unidad} onChange={(e) => setUnidad(e.target.value)} className={flitInp}>{UNIDADES.map((u) => <option key={u} value={u}>{u}</option>)}</select></FlitField>
          <FlitField label="Stock mínimo"><input type="number" min="0" step="0.01" value={existenciaMin} onChange={(e) => setExistenciaMin(e.target.value)} className={flitInp} /></FlitField>
        </div>
        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={submitting} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>{submitting ? 'Guardando…' : 'Crear'}</button>
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
    <FlitModal title={`Movimiento — ${part.codigo}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 px-6 pb-6">
          <FlitField label="Tipo">
            <select value={tipo} onChange={(e) => setTipo(e.target.value as MovementTipo)} className={flitInp}>
              <option value="entrada">Entrada (compra)</option>
              <option value="salida">Salida (consumo)</option>
              <option value="traslado">Traslado entre ubicaciones</option>
              <option value="ajuste">Ajuste de inventario</option>
            </select>
          </FlitField>
          <div className="grid grid-cols-2 gap-3">
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
        <div className="flex justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" onClick={onClose} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={submitting} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>{submitting ? 'Guardando…' : 'Registrar'}</button>
        </div>
      </form>
    </FlitModal>
  );
}
