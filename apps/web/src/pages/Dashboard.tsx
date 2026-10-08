import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { hasPage, type PageSlug } from '../lib/permissions';
import { flitBtnSecondarySm } from '../components/flit/flitPageKit';
import FlitoTablero from './FlitoTablero';
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

type EstadoBloque<T> =
  | { estado: 'apagado' }
  | { estado: 'cargando' }
  | { estado: 'oculto' }
  | { estado: 'error' }
  | { estado: 'listo'; datos: T };

/**
 * HU #12872 (AC6/AC9): un bloque del tablero = una consulta con sus 4 estados. Solo se pide si el
 * bloque se va a pintar (`habilitado`); un 403 lo OCULTA (el permiso cambió, no es error); otro
 * fallo lo pone en error con reintento propio, sin tumbar a los demás.
 */
function useBloque<T>(habilitado: boolean, pedir: () => Promise<T>): EstadoBloque<T> & { reintentar: () => void } {
  const [estado, setEstado] = useState<EstadoBloque<T>>({ estado: habilitado ? 'cargando' : 'apagado' });
  const [intento, setIntento] = useState(0);
  const pedirRef = useRef(pedir);
  pedirRef.current = pedir;

  useEffect(() => {
    if (!habilitado) { setEstado({ estado: 'apagado' }); return; }
    let vivo = true;
    setEstado({ estado: 'cargando' });
    pedirRef.current()
      .then((datos) => { if (vivo) setEstado({ estado: 'listo', datos }); })
      .catch((e: unknown) => {
        if (!vivo) return;
        const status = (e as { status?: number } | null)?.status;
        setEstado({ estado: status === 403 ? 'oculto' : 'error' });
      });
    return () => { vivo = false; };
  }, [habilitado, intento]);

  const reintentar = useCallback(() => setIntento((n) => n + 1), []);
  return { ...estado, reintentar };
}

const visibleB = (b: EstadoBloque<unknown>) => b.estado === 'cargando' || b.estado === 'error' || b.estado === 'listo';

const MD_COLS: Record<number, string> = { 1: 'md:grid-cols-1', 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4' };

const tarjeta = { borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-card)' } as const;

// =============================================================
//   DASHBOARD — Patrón FLIT (prototipo p.4–5)
//   HU #12872: cada bloque se pinta si y solo si el usuario puede abrir la página a la que lleva
//   (`hasPage` del destino) y, para los datos, la función de la guarda del endpoint. Ningún nombre
//   de rol decide.
// =============================================================
export default function Dashboard() {
  const { user, hasFuncion } = useAuth();
  const puede = (p: PageSlug) => hasPage(user, p);

  const verVehiculos = puede('vehicles');
  const verSoat = puede('soat');
  const verFlota = puede('fleet');
  const verRndc = puede('rndc');
  const verMant = puede('maintenance_inicio');
  const verPesv = puede('pesv');
  const verTableroPesv = puede('pesv_tablero_ejecutivo');
  const verRum = hasFuncion('rum.resumen.ver');
  const verMetricas = hasFuncion('tramite.metricas.ver_resumen');
  const tableroFlito = hasFuncion('tablero.tablero.ver');

  // `/soat/stats` exige `soat.antiguo.administrar` (soat.routes.ts): sin ella no se pide.
  const statsSoat = useBloque<SoatStats>(
    !tableroFlito && (verVehiculos || verSoat || verMant) && hasFuncion('soat.antiguo.administrar'),
    () => api.get<SoatStats>('/soat/stats'),
  );
  const vencimientos = useBloque<FleetExpiring>(!tableroFlito && verFlota, () => api.get<FleetExpiring>('/fleet/documents/expiring?dias=60'));
  const rndc = useBloque<number>(
    !tableroFlito && verRndc,
    () => api.get<RndcManifestos>('/rndc/manifiestos?estadoEnvio=error_envio&limit=1').then((d) => d.total ?? d.data?.length ?? 0),
  );

  const soat = statsSoat.estado === 'listo' ? statsSoat.datos : null;
  const expiring = vencimientos.estado === 'listo' ? vencimientos.datos : null;
  const total = soat ? soat.pendiente + soat.comprado + soat.verificado + soat.rechazado : 0;
  const pctVigentes = total > 0 ? Math.round((soat!.verificado / total) * 100) : 0;
  // FLOTA-04: el endpoint real es { data, count }; toleramos { total, items }.
  const expCount = expiring?.count ?? expiring?.total ?? expiring?.data?.length ?? expiring?.items?.length ?? 0;
  const expVencidos = (expiring?.data ?? []).filter((d) => d.estado === 'vencido').length;
  const soatPendiente = soat?.pendiente ?? 0;
  const rndcCount = rndc.estado === 'listo' ? rndc.datos : 0;
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
  const animVehicles = useCountUp(soat ? totalVehicles : 0, { duration: 1200 });
  const animPct = useCountUp(soat ? pctVigentes : 0, { duration: 1300 });
  const animExp = useCountUp(expiring ? expCount : 0, { duration: 1100 });
  const animRndc = useCountUp(rndcCount, { duration: 1000 });

  const saludLabel = pctVigentes >= 90 ? 'Excelente' : pctVigentes >= 70 ? 'Bueno' : 'Atención';
  const saludTone: ChipTone = pctVigentes >= 90 ? 'success' : pctVigentes >= 70 ? 'active' : 'warning';

  // ---------- Inicio del dominio FLITO: quien tiene el tablero FLITO lo ve como home. ----------
  // HU #12170: tablero FLITO por función, no por rol admin.
  if (tableroFlito) return <FlitoTablero />;

  const soatVisible = visibleB(statsSoat);
  const mVehiculos = verVehiculos && soatVisible;
  const mSoat = verSoat && soatVisible;
  const mVenc = verFlota && visibleB(vencimientos);
  const mRndc = verRndc && visibleB(rndc);
  const nMetricas = [mVehiculos, mSoat, mVenc, mRndc].filter(Boolean).length;

  const kpiFlota = mVehiculos;
  const kpiSoat = mSoat;
  const columnaDerecha = kpiFlota || kpiSoat;
  const enlaces = verVehiculos || verTableroPesv || verRum || verMetricas;
  // «Tablero PESV» solo no justifica el bloque: ya tiene su atajo abajo (UX §2, «solo PESV»).
  const estadoOperativo = nMetricas > 0 || verVehiculos || verRum || verMetricas;
  const atajos = [verMant, mRndc, verPesv, verTableroPesv].filter(Boolean).length;

  const cargandoSoat = statsSoat.estado === 'cargando';
  const cargandoVenc = vencimientos.estado === 'cargando';
  const cargandoRndc = rndc.estado === 'cargando';
  const valorSoat = (v: string) => (cargandoSoat ? '·' : v);

  const alertas = [
    mSoat && soatPendiente > 0,
    mVenc && expVencidos > 0,
    mVenc && expCount > 0,
  ].some(Boolean);

  const cabecera = (
    <PageHeaderCard
      title={`${greeting}, ${userFirstName}`}
      subtitle={`Panel operativo · ${fechaLarga}`}
    />
  );

  // ---------- Vacío útil: ningún bloque con permiso. ----------
  if (!estadoOperativo && !columnaDerecha && atajos === 0) {
    return (
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
        {cabecera}
        <div className="p-8" style={tarjeta} data-testid="tablero-vacio">
          <p className="max-w-[60ch] text-base leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
            Tu tablero no tiene indicadores con tus permisos actuales. Pulsa{' '}
            <kbd
              className="mx-1 inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs"
              style={{ border: '1px solid var(--flit-border-input)', color: 'var(--flit-text-primary)', background: 'var(--flit-bg-app)' }}
            >
              {isMac ? '⌘' : 'Ctrl'} K
            </kbd>{' '}
            o usa el menú para ir a tus secciones. Si te falta una, pídele a un administrador que te la habilite.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      {cabecera}

      {(estadoOperativo || columnaDerecha) && (
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 lg:gap-6">
        {estadoOperativo && (
        <article
          className={`flex flex-col p-7 lg:p-9 ${columnaDerecha ? 'lg:col-span-8' : 'lg:col-span-12'}`}
          style={tarjeta}
        >
          <h2 className="text-xl font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>
            Estado operativo
          </h2>
          <p className="mt-3 max-w-[52ch] text-sm leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
            Revisa los indicadores de tus módulos y salta a la acción que corresponda.
          </p>

          {enlaces && (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {/* CTA primario solo con permiso de Vehículos: no se promueve otro enlace a gradiente. */}
            {verVehiculos && (
              <Link
                to="/vehicles"
                className="flit-focus inline-flex items-center justify-center gap-2 px-6 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99]"
                style={{ height: '44px', borderRadius: 'var(--flit-radius-pill)', background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}
              >
                Ver vehículos
                <ArrowIcon className="h-4 w-4" />
              </Link>
            )}
            {verTableroPesv && <EnlaceTexto to="/pesv/tablero" color="var(--flit-blue)">Tablero PESV</EnlaceTexto>}
            {verRum && <EnlaceTexto to="/admin/rendimiento">Rendimiento (RUM)</EnlaceTexto>}
            {verMetricas && <EnlaceTexto to="/admin/tramites-metricas">Métricas trámites</EnlaceTexto>}
          </div>
          )}

          {nMetricas > 0 && (
          <div
            className={`mt-8 grid gap-6 border-t pt-7 ${nMetricas === 1 ? 'grid-cols-1' : 'grid-cols-2'} ${MD_COLS[nMetricas]}`}
            style={{ borderColor: 'var(--flit-border-soft)' }}
            aria-busy={cargandoSoat || cargandoVenc || cargandoRndc}
          >
            {mVehiculos && (statsSoat.estado === 'error'
              ? <ErrorBloque nombre="los vehículos" onReintentar={statsSoat.reintentar} />
              : <StatItem label="Vehículos" value={valorSoat(String(animVehicles))} hint="En operación" tone="neutral" />)}
            {mSoat && (statsSoat.estado === 'error'
              ? <ErrorBloque nombre="SOAT" onReintentar={statsSoat.reintentar} />
              : <StatItem label="SOAT vigentes" value={valorSoat(`${animPct}%`)} hint={soat ? `${soat.verificado} de ${total}` : '—'} tone="success" />)}
            {mVenc && (vencimientos.estado === 'error'
              ? <ErrorBloque nombre="los vencimientos" onReintentar={vencimientos.reintentar} />
              : <StatItem label="Por vencer 60d" value={cargandoVenc ? '·' : String(animExp)} hint="Documentos" tone={expCount > 0 ? 'warning' : 'neutral'} to="/fleet?tab=vencimientos" />)}
            {mRndc && (rndc.estado === 'error'
              ? <ErrorBloque nombre="RNDC" onReintentar={rndc.reintentar} />
              : <StatItem label="RNDC errores" value={cargandoRndc ? '·' : String(animRndc)} hint="Manifiestos" tone={rndcCount > 0 ? 'danger' : 'success'} />)}
          </div>
          )}
        </article>
        )}

        {columnaDerecha && (
        <div className={`grid grid-cols-1 gap-5 lg:gap-6 ${estadoOperativo ? 'lg:col-span-4' : 'sm:grid-cols-2 lg:col-span-12'}`}>
          {kpiFlota && (statsSoat.estado === 'error'
            ? <div className="p-6" style={tarjeta}><ErrorBloque nombre="la flota" onReintentar={statsSoat.reintentar} /></div>
            : (
              <KpiCard
                to="/vehicles"
                ariaLabel="Ver flota completa"
                label="Flota"
                value={cargandoSoat ? '·' : animVehicles}
                hint="Vehículos en operación"
                chip={{ tone: 'active', label: 'Activa' }}
              />
            ))}
          {kpiSoat && (statsSoat.estado === 'error'
            ? <div className="p-6" style={tarjeta}><ErrorBloque nombre="la salud SOAT" onReintentar={statsSoat.reintentar} /></div>
            : (
              <KpiCard
                to="/soat"
                ariaLabel={`Ver salud SOAT — ${pctVigentes}% vigentes`}
                label="Salud SOAT"
                value={cargandoSoat ? '·' : `${animPct}%`}
                hint={saludLabel}
                chip={{ tone: saludTone, label: saludLabel }}
              >
                <div className="mt-auto pt-4 h-14" aria-hidden="true">
                  <Sparkline data={healthSpark} stroke="var(--flit-blue)" className="h-full w-full" />
                </div>
              </KpiCard>
            ))}
        </div>
        )}
      </div>
      )}

      {/* ===== FLOTA-04 · Atención operativa: cada fila depende del permiso de su destino ===== */}
      {alertas && (
        <section aria-label="Atención operativa" className="p-5 sm:p-6" style={tarjeta}>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--flit-text-muted)' }}>
            Atención operativa
          </p>
          <ul className="flex flex-col gap-2.5">
            {mSoat && soatPendiente > 0 && (
              <AlertRow
                chip={{ tone: 'warning', label: 'Pendiente' }}
                text={`${soatPendiente} solicitud${soatPendiente === 1 ? '' : 'es'} SOAT pendiente${soatPendiente === 1 ? '' : 's'} de compra`}
                cta="Ir a SOAT" to="/soat"
              />
            )}
            {mVenc && expVencidos > 0 && (
              <AlertRow
                chip={{ tone: 'danger', label: 'Vencido' }}
                text={`${expVencidos} documento${expVencidos === 1 ? '' : 's'} vencido${expVencidos === 1 ? '' : 's'}`}
                cta="Ver vencimientos" to="/fleet?tab=vencimientos"
              />
            )}
            {mVenc && expCount > 0 && (
              <AlertRow
                chip={{ tone: 'warning', label: 'Por vencer' }}
                text={`${expCount} documento${expCount === 1 ? '' : 's'} por vencer en 60 días`}
                cta="Ver vencimientos" to="/fleet?tab=vencimientos"
              />
            )}
          </ul>
        </section>
      )}

      {/* ===== Fila de atajos: solo los de páginas que el usuario abre ===== */}
      {atajos > 0 && (
      <section aria-label="Atajos operacionales" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        {verMant && (
          <ShortcutCard
            to="/maintenance"
            label="Mantenimiento"
            chip={{ tone: 'active', label: 'Activo' }}
            value={soat ? String(totalVehicles) : (cargandoSoat ? '·' : '—')}
            hint="Flota bajo seguimiento"
          />
        )}
        {mRndc && (rndc.estado === 'error'
          ? <div className="p-6" style={tarjeta}><ErrorBloque nombre="RNDC" onReintentar={rndc.reintentar} /></div>
          : (
            <ShortcutCard
              to="/rndc"
              label="RNDC"
              chip={rndcCount > 0 ? { tone: 'danger', label: 'Errores' } : { tone: 'success', label: 'Al día' }}
              value={cargandoRndc ? '·' : (rndcCount > 0 ? String(rndcCount) : 'OK')}
              hint={rndcCount > 0 ? 'Manifiestos con error' : 'Envíos al día'}
            />
          ))}
        {verPesv && (
          <ShortcutCard
            to="/pesv"
            label="PESV"
            chip={{ tone: 'active', label: 'Procesos' }}
            value="—"
            hint="Gestión de seguridad vial"
          />
        )}
        {verTableroPesv && (
          <ShortcutCard
            to="/pesv/tablero"
            label="Tablero ejecutivo"
            chip={{ tone: 'success', label: 'PHVA' }}
            value="—"
            hint="Score y reporte SuperTransporte"
          />
        )}
      </section>
      )}
    </div>
  );
}

/** Error de UN bloque: copy pulido + reintento que repite solo esa consulta (UX §2). */
function ErrorBloque({ nombre, onReintentar }: { nombre: string; onReintentar: () => void }) {
  return (
    <div role="status" className="flex flex-col items-start gap-2" data-testid="tablero-bloque-error">
      <p className="text-sm" style={{ color: 'var(--flit-danger-text)' }}>No pudimos cargar {nombre}.</p>
      <button type="button" className={flitBtnSecondarySm} onClick={onReintentar}>Reintentar</button>
    </div>
  );
}

function EnlaceTexto({ to, color = 'var(--flit-text-secondary)', children }: { to: string; color?: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="flit-focus inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-[color:var(--flit-bg-app)]"
      style={{ color }}
    >
      {children}
      <ArrowIcon className="h-4 w-4" />
    </Link>
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
      className="flit-focus group flex flex-col bg-flit-card p-6 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]"
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
