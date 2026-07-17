// Vista móvil-first para conductor reportar incidente con foto + GPS.
// Usa Geolocation API navegador + <input type="file" accept="image/*" capture> que
// abre la cámara directamente en móviles (iOS/Android).
//
// El email a admin va automático al hacer POST.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';

type Tipo = 'accidente' | 'casi_accidente' | 'comparendo';

interface Coord { lat: number; lng: number; accuracy: number }

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-3 text-base text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';

export default function ReportarIncidente() {
  const navigate = useNavigate();
  const [tipo, setTipo] = useState<Tipo>('casi_accidente');
  const [descripcion, setDescripcion] = useState('');
  const [coord, setCoord] = useState<Coord | null>(null);
  const [coordError, setCoordError] = useState<string | null>(null);
  const [foto, setFoto] = useState<{ base64: string; mime: string; size: number; preview: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [vehicleId, setVehicleId] = useState<string>('');

  useEffect(() => {
    if (!navigator.geolocation) { setCoordError('Geolocalización no disponible en este navegador'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoord({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => setCoordError('No se obtuvo GPS: ' + err.message),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }, []);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast.error('Foto excede 8MB'); return; }
    const mime = f.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] ?? '';
      setFoto({ base64, mime, size: f.size, preview: dataUrl });
    };
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    if (descripcion.trim().length < 10) { toast.error('Descripción mínima 10 caracteres'); return; }
    setSubmitting(true);
    try {
      const fecha = new Date().toISOString().slice(0, 10);
      const hora = new Date().toTimeString().slice(0, 5);
      interface IncidentReportBody {
        tipo: Tipo;
        fecha: string;
        hora: string;
        descripcion: string;
        vehicleId?: number;
        lat?: number;
        lng?: number;
        fotoBase64?: string;
        fotoMime?: string;
      }
      const body: IncidentReportBody = { tipo, fecha, hora, descripcion: descripcion.trim() };
      if (vehicleId.trim()) body.vehicleId = parseInt(vehicleId, 10);
      if (coord) { body.lat = coord.lat; body.lng = coord.lng; }
      if (foto) { body.fotoBase64 = foto.base64; body.fotoMime = foto.mime; }
      const r = await api.post<{ data: { id: number } }>('/drivers/incidents/report-mobile', body);
      toast.success(`Incidente reportado #${r.data.id}. Admin notificado.`);
      navigate('/pesv');
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <PageHeaderCard
        title="Reportar incidente"
        subtitle="El reporte llega al administrador con GPS y foto"
      />

      {/* Tipo */}
      <div>
        <label className="mb-2 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Tipo de incidente</label>
        <div className="grid grid-cols-3 gap-2">
          {([['accidente', 'Accidente'], ['casi_accidente', 'Casi accidente'], ['comparendo', 'Comparendo']] as Array<[Tipo, string]>).map(([k, label]) => {
            const on = tipo === k;
            return (
              <button
                key={k}
                onClick={() => setTipo(k)}
                className="flit-focus rounded-[10px] p-3 text-xs font-semibold transition-colors"
                style={on
                  ? { background: 'var(--flit-gradient-danger)', color: '#fff' }
                  : { background: '#fff', border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-primary)' }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* GPS */}
      <div className="rounded-[12px] p-3" style={{ background: 'var(--flit-bg-app)', border: '1px solid var(--flit-border-soft)' }}>
        <p className="text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-muted)' }}>Ubicación GPS</p>
        {coord && (
          <p className="mt-1 font-mono text-xs" style={{ color: 'var(--flit-text-primary)' }}>{coord.lat.toFixed(6)}, {coord.lng.toFixed(6)} (±{Math.round(coord.accuracy)}m)</p>
        )}
        {!coord && !coordError && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Obteniendo ubicación...</p>}
        {coordError && <p className="mt-1 text-xs" style={{ color: 'var(--flit-warning)' }}>{coordError}</p>}
      </div>

      {/* Vehículo */}
      <div>
        <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Vehículo (id, opcional)</label>
        <input
          type="number"
          inputMode="numeric"
          value={vehicleId}
          onChange={(e) => setVehicleId(e.target.value.replace(/\D/g, ''))}
          className={inputCls}
          placeholder="ID del vehículo si aplica"
        />
      </div>

      {/* Foto */}
      <div>
        <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Foto (cámara o galería)</label>
        {!foto && (
          <div className="grid grid-cols-2 gap-2">
            <label className="flit-focus cursor-pointer rounded-[12px] p-4 text-center text-xs transition-colors" style={{ border: '2px dashed var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              Tomar foto
              <input type="file" accept="image/*" capture="environment" onChange={handleFile} className="hidden" />
            </label>
            <label className="flit-focus cursor-pointer rounded-[12px] p-4 text-center text-xs transition-colors" style={{ border: '2px dashed var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
              Galería
              <input type="file" accept="image/jpeg,image/png" onChange={handleFile} className="hidden" />
            </label>
          </div>
        )}
        {foto && (
          <div className="relative">
            <img src={foto.preview} alt="evidencia" className="w-full rounded-[12px]" style={{ border: '1px solid var(--flit-border-soft)' }} />
            <button onClick={() => setFoto(null)} className="absolute right-2 top-2 rounded-[999px] bg-white px-2 py-1 text-xs" style={{ border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>Quitar</button>
            <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{(foto.size / 1024).toFixed(1)} KB · {foto.mime}</p>
          </div>
        )}
      </div>

      {/* Descripción */}
      <div>
        <label className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>¿Qué pasó? (mínimo 10 caracteres)</label>
        <textarea
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          rows={4}
          className={inputCls}
          placeholder="Describir lugar, otros vehículos, daños, lesiones..."
        />
      </div>

      <button
        onClick={submit}
        disabled={submitting || descripcion.trim().length < 10}
        className="flit-focus w-full rounded-[999px] py-4 text-base font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: 'var(--flit-gradient-danger)', boxShadow: 'var(--flit-shadow-button)' }}
      >
        {submitting ? 'Enviando...' : 'Reportar incidente'}
      </button>

      <p className="text-center text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
        Al reportar, el administrador recibirá notificación con GPS, foto y descripción.
      </p>
    </div>
  );
}
