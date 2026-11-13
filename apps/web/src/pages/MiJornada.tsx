import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage, ApiError } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import { FlitCard, flitInp } from '../components/flit/flitPageKit';
import { Cargador } from '../components/flit/Cargador';
import { EtiquetaEstado } from '../components/flit/Bloques';
import '../components/fleet/estados-conductores';

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

  if (loading) return <Cargador texto="Cargando..." className="p-6" />;

  const pausaAbierta = j?.pausas?.find((p) => !p.finAt);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
      <PageHeaderCard title="Mi jornada" subtitle="Control de tiempos según Decreto 1079/2015" icono="flito-jornadas" />

      {!j && (
        <FlitCard className="p-5 sm:p-6">
          <h2 className="mb-3 text-xl font-bold text-[color:var(--color-action)]">Sin jornada activa</h2>
          <div className="mb-4">
            <input
              type="text"
              inputMode="numeric"
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value.replace(/\D/g, ''))}
              placeholder="ID vehículo (opcional)"
              aria-label="ID vehículo (opcional)"
              className={flitInp}
            />
          </div>
          <GradientButton type="button" onClick={abrir} className="w-full">Iniciar jornada</GradientButton>
        </FlitCard>
      )}

      {j && (
        <div className="flex flex-col gap-4">
          <FlitCard className="p-5 sm:p-6" key={tick}>
            <div className="mb-2"><EtiquetaEstado estado="jornada-en-curso">Jornada en curso</EtiquetaEstado></div>
            <div className="text-5xl font-bold tabular-nums tracking-tight text-[color:var(--color-text-primary)]">{fmtElapsed(j.inicioAt)}</div>
            <p className="mt-2 text-xs text-[color:var(--color-text-tertiary)]">Inicio: {j.inicioAt.replace('T', ' ').slice(0, 16)}</p>
            {j.horasDescansoPre && <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">Descanso previo: {j.horasDescansoPre}h</p>}
            {j.vehicleId && <p className="text-xs text-[color:var(--color-text-secondary)]">Vehículo: #{j.vehicleId}</p>}
          </FlitCard>

          <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
            {!pausaAbierta && (
              <>
                <GradientButton type="button" variant="secondary" onClick={() => pausaAbrir('descanso')} className="w-full">Pausa descanso</GradientButton>
                <GradientButton type="button" variant="secondary" onClick={() => pausaAbrir('comida')} className="w-full">Pausa comida</GradientButton>
              </>
            )}
            {pausaAbierta && (
              <GradientButton type="button" onClick={pausaCerrar} className="w-full min-[360px]:col-span-2">
                Cerrar pausa ({pausaAbierta.motivo}, {fmtElapsed(pausaAbierta.inicioAt)})
              </GradientButton>
            )}
          </div>

          <GradientButton type="button" variant="alerta" onClick={cerrar} className="w-full">
            Cerrar jornada
          </GradientButton>

          {j.pausas.length > 0 && (
            <FlitCard className="p-5">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-primary)]">Pausas</h3>
              <div className="divide-y divide-[color:var(--color-border)]">
                {j.pausas.map((p) => (
                  <div key={p.id} className="flex justify-between gap-3 py-2 text-xs">
                    <span className="capitalize text-[color:var(--color-text-secondary)]">{p.motivo}</span>
                    <span className="font-mono tabular-nums text-[color:var(--color-text-tertiary)]">{p.inicioAt.slice(11, 16)} → {p.finAt?.slice(11, 16) ?? '...'}</span>
                  </div>
                ))}
              </div>
            </FlitCard>
          )}
        </div>
      )}
    </div>
  );
}
