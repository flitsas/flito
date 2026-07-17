import { useState, FormEvent } from 'react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import GradientButton from './flit/GradientButton';
import { flitInp, FlitCard, flitPillWrap, flitPillBtn } from './flit/flitPageKit';

interface SoatRecord {
  razonSocialAsegur?: string; aseguradora?: string;
  numSoat?: string; noPoliza?: string;
  fechaInicioPoliza?: string; fechaExpedicion?: string;
  fechaVencimSoat?: string;
  estadoSoat?: string; estado?: string;
}
interface VehiculoRunt {
  placa?: string; noPlaca?: string;
  vin?: string; noVin?: string;
  marca?: string; linea?: string; modelo?: string;
  claseVehiculo?: string; clase?: string;
  color?: string;
  tipoServicio?: string; servicio?: string;
  estadoAutomotor?: string; estadoVehiculo?: string; estado?: string;
}
interface RuntResult {
  vehiculo: VehiculoRunt;
  tipoDocPropietario: string;
  soat?: SoatRecord | SoatRecord[];
  datosTecnicos?: Record<string, unknown>;
  rtm?: Record<string, unknown>[];
  solicitudes?: unknown;
}

interface Props {
  onVehicleFound?: (data: RuntResult) => void;
}

export default function RuntLookup({ onVehicleFound }: Props) {
  const [mode, setMode] = useState<'vin' | 'placa'>('vin');
  const [value, setValue] = useState('');
  const [documento, setDocumento] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RuntResult | null>(null);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) { toast.error('Ingrese un VIN o placa'); return; }
    if (mode === 'placa' && !documento.trim()) { toast.error('Documento del propietario requerido para consulta por placa'); return; }

    setLoading(true);
    setResult(null);
    try {
      const body = mode === 'vin' ? { vin: value.trim() } : { placa: value.trim(), documento: documento.trim() };
      const res = await api.post<{ ok: boolean; data?: RuntResult; message?: string }>('/runt/consulta-vehiculo', body);
      if (res.ok && res.data) {
        setResult(res.data);
        onVehicleFound?.(res.data);
        toast.success('Vehículo encontrado en RUNT');
      } else {
        toast.error(res.message || 'No se encontró el vehículo');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error consultando RUNT';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const veh = result?.vehiculo;
  const soatArr = result?.soat;
  const soat = Array.isArray(soatArr) ? soatArr[0] : soatArr;

  return (
    <FlitCard className="mb-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        Consulta RUNT
      </h3>

      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-2">
        <div className="inline-flex gap-1 rounded-[999px] p-1" style={flitPillWrap}>
          <button type="button" onClick={() => setMode('vin')} className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold transition-colors" style={flitPillBtn(mode === 'vin')}>VIN</button>
          <button type="button" onClick={() => setMode('placa')} className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold transition-colors" style={flitPillBtn(mode === 'placa')}>Placa</button>
        </div>

        <input
          value={value}
          onChange={(e) => setValue(e.target.value.toUpperCase())}
          placeholder={mode === 'vin' ? 'Número VIN...' : 'Placa (ej: ABC123)...'}
          className={`min-w-[200px] flex-1 font-mono ${flitInp}`}
          required
        />

        {mode === 'placa' && (
          <input
            value={documento}
            onChange={(e) => setDocumento(e.target.value)}
            placeholder="Documento del propietario"
            className={`w-48 ${flitInp}`}
            required
          />
        )}

        <GradientButton type="submit" disabled={loading}>{loading ? 'Consultando...' : 'Consultar RUNT'}</GradientButton>
      </form>

      {loading && (
        <div className="mt-3 flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-muted)' }}>
          <svg className="h-4 w-4 animate-spin motion-reduce:animate-none" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Consultando RUNT...
        </div>
      )}

      {result && veh && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <Field label="Placa" value={veh.placa || veh.noPlaca || '-'} bold />
            <Field label="VIN" value={veh.vin || veh.noVin || '-'} mono />
            <Field label="Marca / Línea" value={`${veh.marca || '-'} ${veh.linea || ''}`} />
            <Field label="Modelo" value={veh.modelo || '-'} />
            <Field label="Clase" value={veh.claseVehiculo || veh.clase || '-'} />
            <Field label="Color" value={veh.color || '-'} />
            <Field label="Servicio" value={veh.tipoServicio || veh.servicio || '-'} />
            <Field label="Estado" value={veh.estadoAutomotor || veh.estadoVehiculo || veh.estado || '-'} />
          </div>

          {soat && (
            <div className="mt-3 rounded-[10px] p-3" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
              <p className="mb-1.5 text-xs font-semibold" style={{ color: 'var(--flit-blue)' }}>SOAT</p>
              <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
                <div><span style={{ color: 'var(--flit-text-muted)' }}>Aseguradora: </span>{soat.razonSocialAsegur || soat.aseguradora || '-'}</div>
                <div><span style={{ color: 'var(--flit-text-muted)' }}>Póliza: </span>{soat.numSoat || soat.noPoliza || '-'}</div>
                <div><span style={{ color: 'var(--flit-text-muted)' }}>Inicio: </span>{soat.fechaInicioPoliza ? new Date(soat.fechaInicioPoliza).toLocaleDateString('es-CO') : (soat.fechaExpedicion ? new Date(soat.fechaExpedicion).toLocaleDateString('es-CO') : '-')}</div>
                <div><span style={{ color: 'var(--flit-text-muted)' }}>Vencimiento: </span>{soat.fechaVencimSoat ? new Date(soat.fechaVencimSoat).toLocaleDateString('es-CO') : '-'}</div>
                <div><span style={{ color: 'var(--flit-text-muted)' }}>Estado: </span>{soat.estadoSoat || soat.estado || '-'}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </FlitCard>
  );
}

function Field({ label, value, bold, mono }: { label: string; value: string; bold?: boolean; mono?: boolean }) {
  return (
    <div>
      <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{label}</span>
      <p className={`${bold ? 'font-semibold' : ''} ${mono ? 'font-mono text-xs' : ''}`} style={{ color: 'var(--flit-text-primary)' }}>{value}</p>
    </div>
  );
}
