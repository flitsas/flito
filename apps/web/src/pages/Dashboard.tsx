import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCountUp } from '../lib/useCountUp';
import Sparkline from '../components/flit/Sparkline';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import KpiCard from '../components/flit/KpiCard';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

interface SoatStats {
  totalVehicles: number;
  pendiente: number;
  enviado: number;
  comprado: number;
  verificado: number;
  rechazado: number;
}

interface ExpiringDoc { estado?: 'vigente' | 'por_vencer' | 'vencido' | 'archivado'; }
// El endpoint real devuelve { data, count }; toleramos también { total, items }
// (forma usada por mocks antiguos) para no romper tests existentes.
interface FleetExpiring { total?: number; count?: number; items?: unknown[]; data?: ExpiringDoc[]; }
interface RndcManifestos { data?: Array<{ id: number }>; total?: number; }

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

// =============================================================
//   DASHBOARD — Patrón FLIT (prototipo p.4–5)
//   Contenido sobre el AppShell (fondo #EAF2FF): PageHeaderCard +
//   tarjetas blancas FLIT (KPI principal 8 cols + KpiCards 4 cols +
//   fila de atajos). Datos/API/links conservados sin cambios.
// =============================================================
export default function Dashboard() {
  const { user } = useAuth();
  const [soat, setSoat] = useState<SoatStats | null>(null);
  const [expiring, setExpiring] = useState<FleetExpiring | null>(null);
  const [rndcErrors, setRndcErrors] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user?.role !== 'admin') { setLoading(false); return; }
    Promise.allSettled([
      api.get<SoatStats>('/soat/stats'),
      api.get<FleetExpiring>('/fleet/documents/expiring?dias=60').catch(() => ({ total: 0 } as FleetExpiring)),
      api.get<RndcManifestos>('/rndc/manifiestos?estadoEnvio=error_envio&limit=1').catch(() => ({ data: [] } as RndcManifestos)),
    ]).then((res) => {
      if (res[0].status === 'fulfilled') setSoat(res[0].value);
      if (res[1].status === 'fulfilled') setExpiring(res[1].value);
      if (res[2].status === 'fulfilled') {
        const d = res[2].value as RndcManifestos;
        setRndcErrors(d.total ?? d.data?.length ?? 0);
      }
      setLoading(false);
    });
  }, [user]);

  const total = soat ? soat.pendiente + soat.comprado + soat.verificado + soat.rechazado : 0;
  const pctVigentes = total > 0 ? Math.round((soat!.verificado / total) * 100) : 0;
  // FLOTA-04: el endpoint real es { data, count }; toleramos { total, items }.
  const expCount = expiring?.count ?? expiring?.total ?? expiring?.data?.length ?? expiring?.items?.length ?? 0;
  const expVencidos = (expiring?.data ?? []).filter((d) => d.estado === 'vencido').length;
  const soatPendiente = soat?.pendiente ?? 0;
  const rndcCount = rndcErrors ?? 0;
  const totalVehicles = soat?.totalVehicles ?? 0;

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Buenos días';
    if (h < 19) return 'Buenas tardes';
    return 'Buenas noches';
  })();

  const fechaLarga = new Date().toLocaleDateString('es-CO', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });

  const userFirstName = user?.name?.split(' ')[0] ?? 'operador';

  // Sparkline pseudo-data (curva subiendo) basada en pctVigentes.
  const healthSpark = (() => {
    const target = pctVigentes || 80;
    return [
      Math.max(target - 12, 0),
      Math.max(target - 8, 0),
      Math.max(target - 9, 0),
      Math.max(target - 5, 0),
      Math.max(target - 6, 0),
      Math.max(target - 2, 0),
      target,
    ];
  })();

  // Animated count-ups para hero stats.
  const animVehicles = useCountUp(loading ? 0 : totalVehicles, { duration: 1200 });
  const animPct = useCountUp(loading ? 0 : pctVigentes, { duration: 1300 });
  const animExp = useCountUp(loading ? 0 : expCount, { duration: 1100 });
  const animRndc = useCountUp(loading ? 0 : rndcCount, { duration: 1000 });

  const saludLabel = pctVigentes >= 90 ? 'Excelente' : pctVigentes >= 70 ? 'Bueno' : 'Atención';
  const saludTone: ChipTone = pctVigentes >= 90 ? 'success' : pctVigentes >= 70 ? 'active' : 'warning';

  // ---------- Vista no-admin: header + tarjeta guía ⌘K. ----------
  if (user?.role !== 'admin') {
    return (
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
        <PageHeaderCard
        title={`${greeting}, ${userFirstName}`}
        subtitle={`Panel operativo · ${fechaLarga}`}
      />
        <div
          className="bg-white p-8"
          style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
        >
          <p className="max-w-[52ch] text-base leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
            Pulsa{' '}
            <kbd
              className="mx-1 inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs"
              style={{ border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-primary)', background: 'var(--flit-bg-app)' }}
            >
              {isMac ? '⌘' : 'Ctrl'} K
            </kbd>{' '}
            para navegar a tus secciones.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      {/* ----- Encabezado en tarjeta blanca ----- */}
      <PageHeaderCard
        title={`${greeting}, ${userFirstName}`}
        subtitle={`Panel operativo · ${fechaLarga}`}
      />

      {/* ----- Grid 12 cols: KPI principal 8 + columna 4 ----- */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
        {/* ===== KPI principal (8 cols) ===== */}
        <article
          className="flex flex-col bg-white p-7 lg:col-span-8 lg:p-9"
          style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
        >
          <h2 className="text-xl font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>
            Estado operativo
          </h2>
          <p className="mt-3 max-w-[52ch] text-sm leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
            Flota, SOAT, manifiestos RNDC y cumplimiento PESV en un solo lugar.
            Revisa los indicadores y salta a la acción que corresponda.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {/* CTA primario: Link con estética pastilla gradiente FLIT (evita
                anidar <button> dentro de <a>). GradientButton queda en la
                librería para acciones-botón reales. */}
            <Link
              to="/vehicles"
              className="flit-focus inline-flex items-center justify-center gap-2 px-6 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99]"
              style={{ height: '44px', borderRadius: 'var(--flit-radius-pill)', background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}
            >
              Ver vehículos
              <ArrowIcon className="h-4 w-4" />
            </Link>
            <Link
              to="/pesv/tablero"
              className="flit-focus inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium"
              style={{ color: 'var(--flit-blue)' }}
            >
              Tablero PESV
              <ArrowIcon className="h-4 w-4" />
            </Link>
            {user?.role === 'admin' && (
              <Link
                to="/admin/rendimiento"
                className="flit-focus inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium"
                style={{ color: 'var(--flit-text-secondary)' }}
              >
                Rendimiento (RUM)
                <ArrowIcon className="h-4 w-4" />
              </Link>
            )}
            {user?.role === 'admin' && (
              <Link
                to="/admin/tramites-metricas"
                className="flit-focus inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium"
                style={{ color: 'var(--flit-text-secondary)' }}
              >
                Métricas trámites
                <ArrowIcon className="h-4 w-4" />
              </Link>
            )}
          </div>

          {/* Fila de métricas */}
          <div
            className="mt-8 grid grid-cols-2 gap-6 border-t pt-7 md:grid-cols-4"
            style={{ borderColor: 'var(--flit-border-soft)' }}
            aria-busy={loading}
          >
            <StatItem label="Vehículos" value={loading ? '·' : String(animVehicles)} hint="En operación" tone="neutral" />
            <StatItem label="SOAT vigentes" value={loading ? '·' : `${animPct}%`} hint={soat ? `${soat.verificado} de ${total}` : '—'} tone="success" />
            <StatItem label="Por vencer 60d" value={loading ? '·' : String(animExp)} hint="Documentos" tone={expCount > 0 ? 'warning' : 'neutral'} to="/fleet?tab=vencimientos" />
            <StatItem label="RNDC errores" value={loading ? '·' : String(animRndc)} hint="Manifiestos" tone={rndcCount > 0 ? 'danger' : 'success'} />
          </div>
        </article>

        {/* ===== Columna derecha (4 cols) ===== */}
        <div className="grid grid-cols-1 gap-5 lg:col-span-4 lg:gap-6">
          <KpiCard
            to="/vehicles"
            ariaLabel="Ver flota completa"
            label="Flota"
            value={loading ? '·' : animVehicles}
            hint="Vehículos en operación"
            chip={{ tone: 'active', label: 'Activa' }}
          />
          <KpiCard
            to="/soat"
            ariaLabel={`Ver salud SOAT — ${pctVigentes}% vigentes`}
            label="Salud SOAT"
            value={loading ? '·' : `${animPct}%`}
            hint={saludLabel}
            chip={{ tone: saludTone, label: saludLabel }}
          >
            <div className="mt-auto pt-4 h-14" aria-hidden="true">
              <Sparkline data={healthSpark} stroke="var(--flit-blue)" className="h-full w-full" />
            </div>
          </KpiCard>
        </div>
      </div>

      {/* ===== FLOTA-04 · Atención operativa (admin) ===== */}
      {!loading && (soatPendiente > 0 || expVencidos > 0 || expCount > 0) && (
        <section
          aria-label="Atención operativa"
          className="bg-white p-5 sm:p-6"
          style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
        >
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>
            Atención operativa
          </p>
          <ul className="flex flex-col gap-2.5">
            {soatPendiente > 0 && (
              <AlertRow
                chip={{ tone: 'warning', label: 'Pendiente' }}
                text={`${soatPendiente} solicitud${soatPendiente === 1 ? '' : 'es'} SOAT pendiente${soatPendiente === 1 ? '' : 's'} de compra`}
                cta="Ir a SOAT" to="/soat"
              />
            )}
            {expVencidos > 0 && (
              <AlertRow
                chip={{ tone: 'danger', label: 'Vencido' }}
                text={`${expVencidos} documento${expVencidos === 1 ? '' : 's'} vencido${expVencidos === 1 ? '' : 's'}`}
                cta="Ver vencimientos" to="/fleet?tab=vencimientos"
              />
            )}
            {expCount > 0 && (
              <AlertRow
                chip={{ tone: 'warning', label: 'Por vencer' }}
                text={`${expCount} documento${expCount === 1 ? '' : 's'} por vencer en 60 días`}
                cta="Ver vencimientos" to="/fleet?tab=vencimientos"
              />
            )}
          </ul>
        </section>
      )}

      {/* ===== Fila de atajos ===== */}
      <section aria-label="Atajos operacionales" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        <ShortcutCard
          to="/maintenance"
          label="Mantenimiento"
          chip={{ tone: 'active', label: 'Activo' }}
          value={loading ? '·' : String(totalVehicles)}
          hint="Flota bajo seguimiento"
        />
        <ShortcutCard
          to="/rndc"
          label="RNDC"
          chip={rndcCount > 0 ? { tone: 'danger', label: 'Errores' } : { tone: 'success', label: 'Al día' }}
          value={loading ? '·' : (rndcCount > 0 ? String(rndcCount) : 'OK')}
          hint={rndcCount > 0 ? 'Manifiestos con error' : 'Envíos al día'}
        />
        <ShortcutCard
          to="/pesv"
          label="PESV"
          chip={{ tone: 'active', label: 'Procesos' }}
          value="—"
          hint="Gestión de seguridad vial"
        />
        <ShortcutCard
          to="/pesv/tablero"
          label="Tablero ejecutivo"
          chip={{ tone: 'success', label: 'PHVA' }}
          value="—"
          hint="Score y reporte SuperTransporte"
        />
      </section>
    </div>
  );
}

// =============================================================
//   StatItem — métrica dentro del KPI principal (semántica FLIT).
// =============================================================
type StatTone = 'neutral' | 'success' | 'warning' | 'danger';

const STAT_COLOR: Record<StatTone, string> = {
  neutral: 'var(--flit-text-primary)',
  success: 'var(--flit-success)',
  warning: 'var(--flit-warning)',
  danger: 'var(--flit-danger)',
};

function StatItem({ label, value, hint, tone, to }: { label: string; value: string; hint: string; tone: StatTone; to?: string }) {
  const inner = (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>
        {label}
      </p>
      <p className="mt-2 text-3xl font-bold tabular-nums tracking-tight leading-none md:text-4xl" style={{ color: STAT_COLOR[tone] }}>
        {value}
      </p>
      <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{hint}</p>
    </>
  );
  // FLOTA-04: «Por vencer 60d» es clickeable → deep link a Fleet/vencimientos.
  if (to) {
    return (
      <Link to={to} className="flit-focus flex flex-col rounded-[10px] transition-opacity hover:opacity-80" aria-label={`${label}: ${value} — ${hint}`}>
        {inner}
      </Link>
    );
  }
  return <div className="flex flex-col">{inner}</div>;
}

// =============================================================
//   AlertRow — fila de «Atención operativa» (FLOTA-04): chip + texto + CTA.
// =============================================================
function AlertRow({ chip, text, cta, to }: { chip: { tone: ChipTone; label: string }; text: string; cta: string; to: string }) {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border px-4 py-3"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
    >
      <div className="flex items-center gap-3">
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
        <span className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{text}</span>
      </div>
      <Link
        to={to}
        className="flit-focus inline-flex items-center gap-1.5 rounded-[999px] px-3 py-1.5 text-xs font-semibold"
        style={{ color: 'var(--flit-blue)', background: 'rgba(79, 116, 201, 0.12)' }}
      >
        {cta} <ArrowIcon className="h-3.5 w-3.5" />
      </Link>
    </li>
  );
}

// =============================================================
//   ShortcutCard — atajo (tarjeta blanca + chip + CTA flecha).
// =============================================================
function ShortcutCard({ to, label, chip, value, hint }: {
  to: string; label: string; chip: { tone: ChipTone; label: string }; value: string; hint: string;
}) {
  return (
    <Link
      to={to}
      aria-label={`${label} — abrir`}
      className="flit-focus group flex flex-col bg-white p-6 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]"
      style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>
          {label}
        </p>
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
      </div>
      <p className="mt-4 text-3xl font-bold tabular-nums tracking-tight leading-none" style={{ color: 'var(--flit-text-primary)' }}>
        {value}
      </p>
      <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{hint}</p>
      <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--flit-blue)' }}>
        Abrir <ArrowIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

function ArrowIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M5 12h14" />
      <path d="m13 5 7 7-7 7" />
    </svg>
  );
}
