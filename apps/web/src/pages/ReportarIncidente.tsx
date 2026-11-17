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
import GradientButton from '../components/flit/GradientButton';
import { Icono } from '../components/flit/kit/Icono';

type Tipo = 'accidente' | 'casi_accidente' | 'comparendo';

interface Coord { lat: number; lng: number; accuracy: number }

const TARJETA = 'rounded-[9px] border border-[color:var(--color-border)] bg-[var(--color-surface-elevated)] p-4';
const TIPO_BASE = 'flit-focus min-h-11 rounded-[9px] border p-3 text-xs font-semibold transition-colors';
const TIPO_ACTIVO = 'border-[color:var(--kit-azul)] bg-[var(--kit-azul-relleno)] text-white';
const TIPO_INACTIVO = 'border-[color:var(--color-border-control)] bg-[var(--color-surface-elevated)] text-[color:var(--color-text-primary)] hover:bg-[var(--kit-hover)]';
const CARGA = 'carga flit-focus min-h-[120px] p-4 text-xs font-semibold transition-colors';

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
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <PageHeaderCard
        title="Reportar incidente"
        subtitle="El reporte llega al administrador con GPS y foto"
        icono="flito-incidentes"
        miga={[{ etiqueta: 'PESV', to: '/pesv' }]}
      />

      {/* Tipo */}
      <div className="campo">
        <span className="etiqueta">Tipo de incidente</span>
        <div className="grid grid-cols-1 gap-2 min-[340px]:grid-cols-3">
          {([['accidente', 'Accidente'], ['casi_accidente', 'Casi accidente'], ['comparendo', 'Comparendo']] as Array<[Tipo, string]>).map(([k, label]) => {
            const on = tipo === k;
            return (
              <button
                key={k}
                onClick={() => setTipo(k)}
                className={`${TIPO_BASE} ${on ? TIPO_ACTIVO : TIPO_INACTIVO}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* GPS */}
      <div className={`${TARJETA} flex items-start gap-3`}>
        <Icono nombre="marcador" disco size={40} />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[color:var(--color-text-primary)]">Ubicación GPS</p>
          {coord && (
            <p className="mono mt-1 break-all text-xs text-[color:var(--color-text-primary)]">{coord.lat.toFixed(6)}, {coord.lng.toFixed(6)} (±{Math.round(coord.accuracy)}m)</p>
          )}
          {!coord && !coordError && <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">Obteniendo ubicación...</p>}
          {coordError && <p className="mt-1 text-xs text-[color:var(--kit-naranja-texto)]">{coordError}</p>}
        </div>
      </div>

      {/* Vehículo */}
      <div className="campo">
        <label htmlFor="reporte-vehiculo">Vehículo (id, opcional)</label>
        <input
          id="reporte-vehiculo"
          type="number"
          inputMode="numeric"
          value={vehicleId}
          onChange={(e) => setVehicleId(e.target.value.replace(/\D/g, ''))}
          className="control"
          placeholder="ID del vehículo si aplica"
        />
      </div>

      {/* Foto */}
      <div className="campo">
        <span className="etiqueta">Foto (cámara o galería)</span>
        {!foto && (
          <div className="grid grid-cols-1 gap-2 min-[340px]:grid-cols-2">
            <label className={CARGA}>
              <Icono nombre="nube-subir" size={32} />
              Tomar foto
              <input type="file" accept="image/*" capture="environment" onChange={handleFile} className="hidden" />
            </label>
            <label className={CARGA}>
              <Icono nombre="nube-subir" size={32} />
              Galería
              <input type="file" accept="image/jpeg,image/png" onChange={handleFile} className="hidden" />
            </label>
          </div>
        )}
        {foto && (
          <div className="carga carga--lista relative block cursor-default p-2">
            <img src={foto.preview} alt="evidencia" className="w-full rounded-[9px]" />
            <GradientButton type="button" variant="alerta" size="sm" onClick={() => setFoto(null)} className="absolute right-4 top-4">Quitar</GradientButton>
            <p className="mt-2 text-xs text-[color:var(--color-text-secondary)]">{(foto.size / 1024).toFixed(1)} KB · {foto.mime}</p>
          </div>
        )}
      </div>

      {/* Descripción */}
      <div className="campo">
        <label htmlFor="reporte-descripcion">¿Qué pasó? (mínimo 10 caracteres)</label>
        <textarea
          id="reporte-descripcion"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          rows={4}
          className="control h-auto py-3"
          placeholder="Describir lugar, otros vehículos, daños, lesiones..."
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-[color:var(--color-border)] pt-4">
        <GradientButton
          type="button"
          onClick={submit}
          disabled={submitting || descripcion.trim().length < 10}
          className="w-full justify-center"
        >
          {submitting ? 'Enviando...' : 'Reportar incidente'}
        </GradientButton>

        <p className="text-center text-xs text-[color:var(--color-text-tertiary)]">
          Al reportar, el administrador recibirá notificación con GPS, foto y descripción.
        </p>
      </div>
    </div>
  );
}
