import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage, ApiError } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';

interface Pausa { id: number; motivo: string; inicioAt: string; finAt: string | null; duracionMin: number | null; }
interface Jornada {
  id: number;
  conductorId: number;
  vehicleId: number | null;
  inicioAt: string;
  finAt: string | null;
  horasConduccion: string | null;
  horasDescansoPre: string | null;
  cerrada: boolean;
  pausas: Pausa[];
}

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

function genIdempotencyKey(): string {
  return 'mi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function fmtElapsed(inicioISO: string): string {
  const ms = Date.now() - new Date(inicioISO).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export default function MiJornada() {
  const [j, setJ] = useState<Jornada | null>(null);
  const [vehicleId, setVehicleId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<Jornada>('/jornadas/abierta');
      setJ(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setJ(null);
      else toast.error(errorMessage(e));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const abrir = async () => {
    try {
      const body: Record<string, unknown> = {};
      if (vehicleId.trim()) body.vehicleId = parseInt(vehicleId, 10);
      await api.post('/jornadas/abrir', body, { 'Idempotency-Key': genIdempotencyKey() });
      toast.success('Jornada abierta');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const cerrar = async () => {
    if (!j) return;
    if (!confirm('¿Cerrar jornada? Se calcularán alarmas si excedes los límites.')) return;
    try {
      await api.post(`/jornadas/${j.id}/cerrar`, {}, { 'Idempotency-Key': genIdempotencyKey() });
      toast.success('Jornada cerrada');
      setJ(null);
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const pausaAbrir = async (motivo: string) => {
    if (!j) return;
    try {
      await api.post(`/jornadas/${j.id}/pausa/abrir`, { motivo });
      toast.success('Pausa registrada');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const pausaCerrar = async () => {
    if (!j) return;
    try {
      await api.post(`/jornadas/${j.id}/pausa/cerrar`, {});
      toast.success('Pausa cerrada');
      await load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  if (loading) return <div className="p-6 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</div>;

  const pausaAbierta = j?.pausas?.find((p) => !p.finAt);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <PageHeaderCard title="Mi jornada" subtitle="Control de tiempos según Decreto 1079/2015" />

      {!j && (
        <div className="bg-white p-6" style={CARD}>
          <h2 className="mb-3 text-xl font-bold" style={{ color: 'var(--flit-blue-text)' }}>Sin jornada activa</h2>
          <div className="mb-4">
            <input
              type="text"
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value.replace(/\D/g, ''))}
              placeholder="ID vehículo (opcional)"
              className={inputCls}
            />
          </div>
          <GradientButton type="button" onClick={abrir} className="w-full">Iniciar jornada</GradientButton>
        </div>
      )}

      {j && (
        <div className="flex flex-col gap-4">
          <div className="bg-white p-6" style={{ ...CARD, border: '1px solid rgba(112,207,58,0.35)' }} key={tick}>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-success)' }}>Jornada en curso</p>
            <div className="text-5xl font-bold tabular-nums tracking-tight" style={{ color: 'var(--flit-text-primary)' }}>{fmtElapsed(j.inicioAt)}</div>
            <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>Inicio: {j.inicioAt.replace('T', ' ').slice(0, 16)}</p>
            {j.horasDescansoPre && <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Descanso previo: {j.horasDescansoPre}h</p>}
            {j.vehicleId && <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Vehículo: #{j.vehicleId}</p>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {!pausaAbierta && (
              <>
                <button onClick={() => pausaAbrir('descanso')} className="flit-focus rounded-[999px] px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--flit-warning)' }}>Pausa descanso</button>
                <button onClick={() => pausaAbrir('comida')} className="flit-focus rounded-[999px] px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--flit-warning)' }}>Pausa comida</button>
              </>
            )}
            {pausaAbierta && (
              <button onClick={pausaCerrar} className="flit-focus col-span-2 rounded-[999px] px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--flit-text-primary)' }}>
                Cerrar pausa ({pausaAbierta.motivo}, {fmtElapsed(pausaAbierta.inicioAt)})
              </button>
            )}
          </div>

          <button onClick={cerrar} className="flit-focus w-full rounded-[999px] px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--flit-gradient-danger)' }}>
            Cerrar jornada
          </button>

          {j.pausas.length > 0 && (
            <div className="bg-white p-5" style={CARD}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-primary)' }}>Pausas</h3>
              {j.pausas.map((p) => (
                <div key={p.id} className="flex justify-between py-1 text-xs">
                  <span className="capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{p.motivo}</span>
                  <span className="font-mono" style={{ color: 'var(--flit-text-muted)' }}>{p.inicioAt.slice(11, 16)} → {p.finAt?.slice(11, 16) ?? '...'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
