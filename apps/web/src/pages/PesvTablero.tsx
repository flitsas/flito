import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import KpiCard from '../components/flit/KpiCard';
import { EstadoVista } from '../components/flit/Cargador';

interface Tablero {
  anio: number;
  trimestre: string;
  documentos: {
    politicaVigente: { id: number; version: number; titulo: string; firmadaAt: string | null } | null;
    planActual: { id: number; anio: number; estado: string; presupuestoCop: string } | null;
    planProximo: { anio: number; estado: string } | null;
    diagnosticoActual: { id: number; estado: string; scoreGlobal: number } | null;
    ultimaActaComite: { id: number; numero: number; fecha: string; estado: string } | null;
  };
  cumplimiento: {
    diagnosticoReferencia: { id: number; anio: number; scoreGlobal: number } | null;
    scoresPorFase: Record<string, { score: number; estandares: number; cubiertos: number; parciales: number; ausentes: number }>;
    estandaresPorFase: Record<string, Array<{ codigo: string; nombre: string; score: number; estado: string }>>;
    total24Pasos: number;
  };
  jornadasMes: { total: number; cerradasAutomatica: number; horasTotales: string; alarmasMes: number; alarmasPendientes: number; conductoresExcedenSemanal: number };
  rutas: { total: number; conAnalisisTrimestre: number; sinAnalisisTrimestre: number };
}

const FASES = [
  { key: 'planear', label: 'PLANEAR' },
  { key: 'hacer', label: 'HACER' },
  { key: 'verificar', label: 'VERIFICAR' },
  { key: 'actuar', label: 'ACTUAR' },
] as const;

const MIGA = [{ etiqueta: 'Cumplimiento' }, { etiqueta: 'PESV', to: '/pesv' }];
const H3 = 'mb-3 text-sm font-semibold text-[color:var(--color-text-primary)]';
const COLOR_ESTADO: Record<string, string> = { cubierto: 'text-[color:var(--kit-verde-texto)]', parcial: 'text-[color:var(--kit-naranja-texto)]' };

export default function PesvTablero() {
  const [data, setData] = useState<Tablero | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<Tablero>('/pesv/tablero');
      setData(r);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const exportSisi = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const blob = await api.post<Blob>('/pesv/export/sisi', { anio: data.anio });
      const url = URL.createObjectURL(blob as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pesv-export-${data.anio}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Paquete SISI/PESV descargado');
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setExporting(false); }
  };

  if (loading || !data) {
    return (
      <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
        <EstadoVista status={loading ? 'loading' : 'error'} cargando="Cargando tablero..." onRetry={load} />
      </div>
    );
  }

  const scoreTotal = Object.values(data.cumplimiento.scoresPorFase).length > 0
    ? (Object.values(data.cumplimiento.scoresPorFase).reduce((s, f) => s + f.score, 0) / Object.values(data.cumplimiento.scoresPorFase).length).toFixed(1)
    : '0.0';

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Tablero ejecutivo PESV"
        icono="flito-pesv"
        miga={MIGA}
        subtitle={`Cumplimiento 24 estándares PHVA · Res. 40595/2022 · ${data.trimestre}`}
        actions={<GradientButton type="button" variant="secondary" onClick={exportSisi} disabled={exporting}>{exporting ? 'Generando...' : 'Descargar paquete SISI/PESV'}</GradientButton>}
      />

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 sm:col-span-6 md:col-span-4">
          <KpiCard
            label={`Score PESV ${data.anio}`}
            value={`${scoreTotal}%`}
            hint={`${data.cumplimiento.total24Pasos} de 24 pasos · diagnóstico ${data.cumplimiento.diagnosticoReferencia?.anio ?? '—'}`}
            icono="flito-pesv"
          />
        </div>

        {FASES.map((f) => {
          const score = data.cumplimiento.scoresPorFase[f.key];
          return (
            <div key={f.key} className="col-span-12 sm:col-span-6 md:col-span-4 xl:col-span-2">
              {score
                ? <KpiCard label={f.label} value={`${score.score.toFixed(1)}%`} hint={`${score.cubiertos}/${score.estandares} cubiertos`} />
                : <KpiCard label={f.label} value="—" hint="sin datos" />}
            </div>
          );
        })}

        <div className="card col-span-12 md:col-span-6">
          <h3 className={H3}>Documentos PESV</h3>
          <DocRow label="Política vigente" status={!!data.documentos.politicaVigente} text={data.documentos.politicaVigente ? `v${data.documentos.politicaVigente.version} · ${data.documentos.politicaVigente.titulo}` : 'NO HAY POLÍTICA VIGENTE'} />
          <DocRow label={`Plan ${data.anio}`} status={!!data.documentos.planActual} text={data.documentos.planActual ? `${data.documentos.planActual.estado} · $ ${Number(data.documentos.planActual.presupuestoCop).toLocaleString('es-CO')}` : 'no registrado'} />
          <DocRow label={`Plan ${data.anio + 1}`} status={!!data.documentos.planProximo} text={data.documentos.planProximo ? data.documentos.planProximo.estado : 'falta crear próximo año'} />
          <DocRow label="Diagnóstico" status={!!data.documentos.diagnosticoActual} text={data.documentos.diagnosticoActual ? `${data.documentos.diagnosticoActual.estado} · score ${data.documentos.diagnosticoActual.scoreGlobal.toFixed(1)}%` : 'no registrado'} />
          <DocRow label="Última acta comité" status={!!data.documentos.ultimaActaComite} text={data.documentos.ultimaActaComite ? `#${data.documentos.ultimaActaComite.numero} (${data.documentos.ultimaActaComite.fecha})` : 'sin actas'} />
        </div>

        <div className="card col-span-12 sm:col-span-6 md:col-span-3">
          <h3 className={H3}>Jornadas (mes)</h3>
          <Kpi label="Total registradas" v={data.jornadasMes.total} />
          <Kpi label="Cerradas auto >16h" v={data.jornadasMes.cerradasAutomatica} accent={data.jornadasMes.cerradasAutomatica > 0} />
          <Kpi label="Alarmas mes" v={data.jornadasMes.alarmasMes} accent={data.jornadasMes.alarmasMes > 0} />
          <Kpi label="Alarmas pendientes ack" v={data.jornadasMes.alarmasPendientes} accent={data.jornadasMes.alarmasPendientes > 0} />
          <Kpi label="Conductores >60h sem" v={data.jornadasMes.conductoresExcedenSemanal} accent={data.jornadasMes.conductoresExcedenSemanal > 0} />
        </div>

        <div className="card col-span-12 sm:col-span-6 md:col-span-3">
          <h3 className={H3}>Rutas {data.trimestre}</h3>
          <Kpi label="Total activas" v={data.rutas.total} />
          <Kpi label="Con análisis trimestre" v={data.rutas.conAnalisisTrimestre} />
          <Kpi label="Sin análisis trimestre" v={data.rutas.sinAnalisisTrimestre} accent={data.rutas.sinAnalisisTrimestre > 0} />
        </div>

        {FASES.map((f) => {
          const items = data.cumplimiento.estandaresPorFase[f.key] ?? [];
          if (!items.length) return null;
          return (
            <div key={f.key + '-detail'} className="card col-span-12 md:col-span-6">
              <h3 className={H3}>{f.label} — detalle estándares</h3>
              <div className="space-y-1">
                {items.map((it) => (
                  <div key={it.codigo} className="flex items-center gap-2 border-b border-[color:var(--color-border)] py-2 text-xs last:border-0">
                    <span className="w-8 font-mono text-[color:var(--color-text-tertiary)]">P{it.codigo}</span>
                    <span className="min-w-0 flex-1 text-[color:var(--color-text-primary)]">{it.nombre}</span>
                    <span className={`w-12 text-right font-mono font-semibold ${COLOR_ESTADO[it.estado] ?? 'text-[color:var(--kit-rojo-texto)]'}`}>{it.score.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DocRow({ label, status, text }: { label: string; status: boolean; text: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--color-border)] py-2 last:border-0">
      <span className="text-xs font-medium text-[color:var(--color-text-secondary)]">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusChip tone={status ? 'success' : 'danger'}>{status ? 'OK' : 'FALTA'}</StatusChip>
        <span className="text-xs text-[color:var(--color-text-secondary)]">{text}</span>
      </div>
    </div>
  );
}

function Kpi({ label, v, accent }: { label: string; v: number | string; accent?: boolean }) {
  return (
    <div className="flex justify-between gap-2 py-1.5 text-xs">
      <span className="text-[color:var(--color-text-secondary)]">{label}</span>
      <span className={`font-mono font-semibold ${accent ? 'text-[color:var(--kit-naranja-texto)]' : 'text-[color:var(--color-text-primary)]'}`}>{v}</span>
    </div>
  );
}
