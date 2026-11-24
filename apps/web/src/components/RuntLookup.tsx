import { useState, FormEvent } from 'react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import GradientButton from './flit/GradientButton';
import { flitInp, FlitCard, flitPillWrap, flitPillBtn } from './flit/flitPageKit';
import { Girador } from './flit/Cargador';
import Placa from './flit/Placa';
import { Icono } from './flit/kit/Icono';

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
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
        <Icono nombre="consulta" size={18} className="text-[color:var(--color-action)]" />
        Consulta RUNT
      </h3>

      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-2">
        <div className="inline-flex gap-1 rounded-[999px] p-1" style={flitPillWrap}>
          <button type="button" onClick={() => setMode('vin')} className="flit-focus h-8 rounded-[999px] px-3 text-xs font-semibold transition-colors" style={flitPillBtn(mode === 'vin')}>VIN</button>
          <button type="button" onClick={() => setMode('placa')} className="flit-focus h-8 rounded-[999px] px-3 text-xs font-semibold transition-colors" style={flitPillBtn(mode === 'placa')}>Placa</button>
        </div>

        <label className="min-w-0 flex-1 basis-[12rem]">
          <span className="sr-only">{mode === 'vin' ? 'Número VIN' : 'Placa'}</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value.toUpperCase())}
            placeholder={mode === 'vin' ? 'Número VIN...' : 'Placa (ej: ABC123)...'}
            className={`w-full font-mono ${flitInp}`}
            required
          />
        </label>

        {mode === 'placa' && (
          <label className="min-w-0 basis-[12rem] grow sm:grow-0">
            <span className="sr-only">Documento del propietario</span>
            <input
              value={documento}
              onChange={(e) => setDocumento(e.target.value)}
              placeholder="Documento del propietario"
              className={`w-full ${flitInp}`}
              required
            />
          </label>
        )}

        <GradientButton type="submit" disabled={loading} ocupado={loading}>{loading ? 'Consultando...' : 'Consultar RUNT'}</GradientButton>
      </form>

      {loading && (
        <div className="mt-3 flex items-center gap-2 text-sm text-[color:var(--color-text-tertiary)]" role="status">
          <Girador />
          Consultando RUNT...
        </div>
      )}

      {result && veh && (
        <div className="mt-3 border-t border-[color:var(--color-border)] pt-3">
          {(veh.placa || veh.noPlaca) && (
            <div className="mb-3"><Placa placa={(veh.placa || veh.noPlaca) as string} /></div>
          )}
          <div className="grid grid-cols-1 gap-3 text-sm min-[380px]:grid-cols-2 md:grid-cols-4">
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
            <div className="mt-3 rounded-[9px] border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
              <p className="mb-1.5 text-xs font-semibold text-[color:var(--color-action)]">SOAT</p>
              <div className="grid grid-cols-1 gap-2 text-xs text-[color:var(--color-text-primary)] min-[380px]:grid-cols-2 md:grid-cols-5">
                <div><span className="text-[color:var(--color-text-tertiary)]">Aseguradora: </span>{soat.razonSocialAsegur || soat.aseguradora || '-'}</div>
                <div><span className="text-[color:var(--color-text-tertiary)]">Póliza: </span>{soat.numSoat || soat.noPoliza || '-'}</div>
                <div><span className="text-[color:var(--color-text-tertiary)]">Inicio: </span>{soat.fechaInicioPoliza ? new Date(soat.fechaInicioPoliza).toLocaleDateString('es-CO') : (soat.fechaExpedicion ? new Date(soat.fechaExpedicion).toLocaleDateString('es-CO') : '-')}</div>
                <div><span className="text-[color:var(--color-text-tertiary)]">Vencimiento: </span>{soat.fechaVencimSoat ? new Date(soat.fechaVencimSoat).toLocaleDateString('es-CO') : '-'}</div>
                <div><span className="text-[color:var(--color-text-tertiary)]">Estado: </span>{soat.estadoSoat || soat.estado || '-'}</div>
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
    <div className="min-w-0">
      <span className="text-xs text-[color:var(--color-text-tertiary)]">{label}</span>
      <p className={`break-words text-[color:var(--color-text-primary)] ${bold ? 'font-semibold' : ''} ${mono ? 'font-mono text-xs' : ''}`}>{value}</p>
    </div>
  );
}
