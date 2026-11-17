import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { hasPage, type PageSlug } from '../lib/permissions';
import GradientButton, { claseBoton } from '../components/flit/GradientButton';
import BannerInicio from '../components/flit/BannerInicio';
import { Icono, IconoModulo } from '../components/flit/kit/Icono';
import FlitoTablero from './FlitoTablero';
import { useCountUp } from '../lib/useCountUp';
import Sparkline from '../components/flit/Sparkline';
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
  // HU #13589: «Rendimiento» es un ítem de Administración (P-35..P-37): se mira la página, como el resto.
  const verRum = puede('admin_rendimiento');
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

  const alertas = [
    mSoat && soatPendiente > 0,
    mVenc && expVencidos > 0,
    mVenc && expCount > 0,
  ].some(Boolean);

  const cabecera = (
    <BannerInicio
      etiqueta="Panel operativo"
      laminas={[{ titulo: `${greeting}, ${userFirstName}`, texto: `Panel operativo · ${fechaLarga}`, icono: 'rejilla', fondo: 'degradado' }]}
    />
  );

  // ---------- Vacío útil: ningún bloque con permiso. ----------
  if (!estadoOperativo && !columnaDerecha && atajos === 0) {
    return (
      <div className="mx-auto max-w-[1600px]">
        <div className="espacio-abajo">{cabecera}</div>
        <div className="card" data-testid="tablero-vacio">
          <p className="max-w-[60ch] text-base leading-relaxed text-[color:var(--color-text-secondary)]">
            Tu tablero no tiene indicadores con tus permisos actuales. Pulsa{' '}
            <kbd className="mx-1 inline-flex items-center rounded-[9px] border border-[color:var(--color-border-control)] bg-[color:var(--color-surface)] px-2 py-0.5 font-mono text-xs text-[color:var(--color-text-primary)]">
              {isMac ? '⌘' : 'Ctrl'} K
            </kbd>{' '}
            o usa el menú para ir a tus secciones. Si te falta una, pídele a un administrador que te la habilite.
          </p>
        </div>
      </div>
    );
  }

  const esqueleto = <span className="kit-esqueleto inline-block h-6 w-16 align-middle" aria-hidden="true" />;
  const txtVenc = cargandoVenc ? '·' : String(animExp);

  return (
    <div className="mx-auto max-w-[1600px]">
      {/* Molde `#inicio`: banner (2fr) + cifras 2×2 (1fr). */}
      {nMetricas > 0 ? (
        <div className="inicio-tope">
          {cabecera}
          <div className="metricas" aria-busy={cargandoSoat || cargandoVenc || cargandoRndc}>
            {mVehiculos && (statsSoat.estado === 'error'
              ? <ErrorBloque nombre="los vehículos" onReintentar={statsSoat.reintentar} />
              : <KpiCard label="Vehículos" value={cargandoSoat ? esqueleto : animVehicles} hint="En operación" icono="flito-vehiculos" />)}
            {mSoat && (statsSoat.estado === 'error'
              ? <ErrorBloque nombre="SOAT" onReintentar={statsSoat.reintentar} />
              : <KpiCard label="SOAT vigentes" value={cargandoSoat ? esqueleto : `${animPct}%`} hint={soat ? `${soat.verificado} de ${total}` : '—'} icono="flito-soat" />)}
            {mVenc && (vencimientos.estado === 'error'
              ? <ErrorBloque nombre="los vencimientos" onReintentar={vencimientos.reintentar} />
              : (
                <KpiCard
                  label="Por vencer 60d"
                  value={cargandoVenc ? esqueleto : animExp}
                  hint="Documentos"
                  icono="flito-gastos-diarios"
                  pendiente={expCount > 0}
                  to="/fleet?tab=vencimientos"
                  ariaLabel={`Por vencer 60d: ${txtVenc} — Documentos`}
                />
              ))}
            {mRndc && (rndc.estado === 'error'
              ? <ErrorBloque nombre="RNDC" onReintentar={rndc.reintentar} />
              : <KpiCard label="RNDC errores" value={cargandoRndc ? esqueleto : animRndc} hint="Manifiestos" icono="flito-rndc" pendiente={rndcCount > 0} />)}
          </div>
        </div>
      ) : (
        <div className="espacio-abajo">{cabecera}</div>
      )}

      {(estadoOperativo || columnaDerecha) && (
      <div className="rejilla rejilla--2 espacio-abajo">
        {estadoOperativo && (
        <article className="card">
          <div className="card__cabeza">
            <div>
              <h2>Estado operativo</h2>
              <p className="max-w-[52ch]">Revisa los indicadores de tus módulos y salta a la acción que corresponda.</p>
            </div>
          </div>

          {enlaces && (
          <div className="flex flex-wrap items-center gap-3">
            {/* CTA primario solo con permiso de Vehículos: no se promueve otro enlace a primario. */}
            {verVehiculos && (
              <Link to="/vehicles" className={claseBoton('primary')} data-variante="primario">
                Ver vehículos
                <Icono nombre="derecha" size={16} />
              </Link>
            )}
            {verTableroPesv && <EnlaceTexto to="/pesv/tablero">Tablero PESV</EnlaceTexto>}
            {verRum && <EnlaceTexto to="/admin/rendimiento">Rendimiento (RUM)</EnlaceTexto>}
            {verMetricas && <EnlaceTexto to="/admin/tramites-metricas">Métricas trámites</EnlaceTexto>}
          </div>
          )}
        </article>
        )}

        {columnaDerecha && (
        <div className="metricas !mb-0 content-start">
          {kpiFlota && (statsSoat.estado === 'error'
            ? <ErrorBloque nombre="la flota" onReintentar={statsSoat.reintentar} />
            : (
              <KpiCard
                to="/vehicles"
                ariaLabel="Ver flota completa"
                label="Flota"
                value={cargandoSoat ? esqueleto : animVehicles}
                hint="Vehículos en operación"
                icono="flito-flota"
                chip={{ tone: 'active', label: 'Activa' }}
              />
            ))}
          {kpiSoat && (statsSoat.estado === 'error'
            ? <ErrorBloque nombre="la salud SOAT" onReintentar={statsSoat.reintentar} />
            : (
              <KpiCard
                to="/soat"
                ariaLabel={`Ver salud SOAT — ${pctVigentes}% vigentes`}
                label="Salud SOAT"
                value={cargandoSoat ? esqueleto : `${animPct}%`}
                hint={saludLabel}
                icono="flito-impuestos-soat"
                chip={{ tone: saludTone, label: saludLabel }}
              >
                <div className="h-14 pt-3" aria-hidden="true">
                  <Sparkline data={healthSpark} stroke="var(--kit-azul)" className="h-full w-full" />
                </div>
              </KpiCard>
            ))}
        </div>
        )}
      </div>
      )}

      {(alertas || atajos > 0) && (
      <div className="rejilla rejilla--2">
      {/* ===== FLOTA-04 · Atención operativa: cada fila depende del permiso de su destino ===== */}
      {alertas && (
        <section aria-label="Atención operativa" className="card">
          <p className="mb-2 text-sm font-semibold text-[color:var(--color-text-primary)]">
            Atención operativa
          </p>
          <ul className="actividad">
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
      <section aria-label="Atajos operacionales" className="card">
        <div className="accesos">
        {verMant && (
          <ShortcutCard
            to="/maintenance"
            label="Mantenimiento"
            icono="flito-mantenimiento"
            chip={{ tone: 'active', label: 'Activo' }}
            value={soat ? String(totalVehicles) : (cargandoSoat ? '·' : '—')}
            hint="Flota bajo seguimiento"
          />
        )}
        {mRndc && (rndc.estado === 'error'
          ? <ErrorBloque nombre="RNDC" onReintentar={rndc.reintentar} />
          : (
            <ShortcutCard
              to="/rndc"
              label="RNDC"
              icono="flito-rndc"
              chip={rndcCount > 0 ? { tone: 'danger', label: 'Errores' } : { tone: 'success', label: 'Al día' }}
              value={cargandoRndc ? '·' : (rndcCount > 0 ? String(rndcCount) : 'OK')}
              hint={rndcCount > 0 ? 'Manifiestos con error' : 'Envíos al día'}
            />
          ))}
        {verPesv && (
          <ShortcutCard
            to="/pesv"
            label="PESV"
            icono="flito-pesv"
            chip={{ tone: 'active', label: 'Procesos' }}
            value="—"
            hint="Gestión de seguridad vial"
          />
        )}
        {verTableroPesv && (
          <ShortcutCard
            to="/pesv/tablero"
            label="Tablero ejecutivo"
            icono="flito-cumplimiento"
            chip={{ tone: 'success', label: 'PHVA' }}
            value="—"
            hint="Score y reporte SuperTransporte"
          />
        )}
        </div>
      </section>
      )}
      </div>
      )}
    </div>
  );
}

/** Error de UN bloque: copy pulido + reintento que repite solo esa consulta (UX §2). */
function ErrorBloque({ nombre, onReintentar }: { nombre: string; onReintentar: () => void }) {
  return (
    <div role="status" className="card flex flex-col items-start gap-2" data-testid="tablero-bloque-error" data-kit="error">
      <p className="text-sm text-[color:var(--kit-rojo-texto)]">No pudimos cargar {nombre}.</p>
      <GradientButton variant="secondary" size="sm" onClick={onReintentar}>Reintentar</GradientButton>
    </div>
  );
}

function EnlaceTexto({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className={claseBoton('secondary', 'sm')} data-variante="secundario">
      {children}
      <Icono nombre="derecha" size={16} />
    </Link>
  );
}

// =============================================================
//   AlertRow — fila de «Atención operativa» (FLOTA-04): chip + texto + CTA.
// =============================================================
function AlertRow({ chip, text, cta, to }: { chip: { tone: ChipTone; label: string }; text: string; cta: string; to: string }) {
  return (
    <li className="justify-between">
      <span className="flex min-w-0 flex-wrap items-center gap-3">
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
        <span className="text-sm text-[color:var(--color-text-primary)]">{text}</span>
      </span>
      <Link to={to} className={claseBoton('ghost', 'sm')}>
        {cta} <Icono nombre="derecha" size={16} />
      </Link>
    </li>
  );
}

// =============================================================
//   ShortcutCard — atajo (`.acceso` del kit: disco del módulo + chip + cifra + «Abrir»).
// =============================================================
function ShortcutCard({ to, label, icono, chip, value, hint }: {
  to: string; label: string; icono: string; chip: { tone: ChipTone; label: string }; value: string; hint: string;
}) {
  return (
    <Link to={to} aria-label={`${label} — abrir`} className="acceso">
      <IconoModulo clave={icono} disco size={40} />
      <span className="min-w-0">
        <strong className="flex flex-wrap items-center gap-2">{label} <StatusChip tone={chip.tone}>{chip.label}</StatusChip></strong>
        <span className="tabular-nums">{value} · {hint}</span>
        <span className="mt-1 inline-flex items-center gap-1 font-semibold text-[color:var(--color-action)]">
          Abrir <Icono nombre="derecha" size={14} />
        </span>
      </span>
    </Link>
  );
}
