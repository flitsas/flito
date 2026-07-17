import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ESTADO_STT_LABEL, getOrganismoByCodigo, transicionesDesde, type TramiteEstadoStt } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';
import FlitOrganismoCombobox from '../components/flit/FlitOrganismoCombobox';
import ExpedienteTimeline from './tramite/ExpedienteTimeline';
import TransitoExpedienteMatriculaModal from './tramite/TransitoExpedienteMatriculaModal';
import RechazarOtModal from './tramite/RechazarOtModal';
import { canRechazarOt } from './tramite/rechazoOt';

const ADMIN_SCOPE_KEY = 'flit.transito.adminScope';

function readAdminScope(): string {
  try {
    return sessionStorage.getItem(ADMIN_SCOPE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeAdminScope(codigo: string) {
  try {
    if (codigo) sessionStorage.setItem(ADMIN_SCOPE_KEY, codigo);
    else sessionStorage.removeItem(ADMIN_SCOPE_KEY);
  } catch { /* ignore */ }
}

interface Tramite {
  id: number;
  vin: string | null;
  estado: string;
  placa?: string | null;
  organismoCodigo?: string | null;
  numeroRadicado?: string | null;
  createdAt?: string;
  updatedAt?: string;
  vehiculo?: { marca?: string; linea?: string; modelo?: string } | null;
  comprador?: { nombre?: string; documento?: string } | null;
}

type BandejaTab = 'matricula' | 'traspaso';

const PLACA_MIN = 4;
const PLACA_MAX = 10;

function placaValida(raw: string): boolean {
  const clean = raw.trim().toUpperCase();
  return clean.length >= PLACA_MIN && clean.length <= PLACA_MAX;
}

// Input de placa FLIT: blanco, borde `--flit-border-input`, mayúsculas, mono bold.
function placaInputCls(invalid: boolean): string {
  const base =
    'flit-focus w-28 rounded-[10px] border bg-white px-3 py-2 text-center font-mono text-sm font-bold uppercase text-[color:var(--flit-text-primary)] outline-none transition-shadow';
  return invalid
    ? `${base} border-[color:var(--flit-danger)]`
    : `${base} border-[color:var(--flit-border-input)]`;
}

export default function TransitoBandeja() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [adminScope, setAdminScope] = useState(readAdminScope);
  const [pendientes, setPendientes] = useState<Tramite[]>([]);
  const [misTramites, setMisTramites] = useState<Tramite[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [placaInput, setPlacaInput] = useState<Record<number, string>>({});
  const [expedienteId, setExpedienteId] = useState<number | null>(null);
  const [rechazarTramite, setRechazarTramite] = useState<Tramite | null>(null);
  const [orgConfig, setOrgConfig] = useState<{ alias: string | null; logoUrl: string | null } | null>(null);
  const [tab, setTab] = useState<BandejaTab>('matricula');
  const [traspasos, setTraspasos] = useState<Tramite[]>([]);

  const scopeCodigo = isAdmin ? (adminScope || null) : (user?.transitoCodigo ?? null);

  const organismo = useMemo(() => {
    return scopeCodigo ? getOrganismoByCodigo(scopeCodigo) ?? null : null;
  }, [scopeCodigo]);

  const displayLabel = orgConfig?.alias?.trim() || organismo?.ciudad;

  useEffect(() => {
    if (!scopeCodigo) {
      setOrgConfig(null);
      return;
    }
    api.get<{ alias: string | null; logoUrl: string | null }>(`/transito/organismos-config/${scopeCodigo}`)
      .then((d) => setOrgConfig({ alias: d.alias ?? null, logoUrl: d.logoUrl ?? null }))
      .catch(() => setOrgConfig(null));
  }, [scopeCodigo]);

  const showOrganismoBadge = isAdmin && !adminScope;

  const load = useCallback(async () => {
    setLoading(true);
    setScopeError(null);
    const qs = isAdmin && adminScope ? `?organismo=${encodeURIComponent(adminScope)}` : '';
    try {
      if (tab === 'matricula') {
        const [p, m] = await Promise.all([
          api.get<Tramite[]>(`/transito/pendientes${qs}`),
          api.get<Tramite[]>(`/transito/mis-tramites${qs}`),
        ]);
        setPendientes(Array.isArray(p) ? p : []);
        setMisTramites(Array.isArray(m) ? m : []);
        setTraspasos([]);
      } else {
        const t = await api.get<Tramite[]>(`/transito/traspasos${qs}`);
        setTraspasos(Array.isArray(t) ? t : []);
        setPendientes([]);
        setMisTramites([]);
      }
    } catch (e) {
      const msg = errorMessage(e);
      if (user?.role === 'transito' && /organismo/i.test(msg)) {
        setScopeError(msg);
      } else {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [adminScope, isAdmin, tab, user?.role]);

  useEffect(() => { load(); }, [load]);

  const handleAdminScope = (codigo: string) => {
    setAdminScope(codigo);
    writeAdminScope(codigo);
  };

  const emptyPendientesHint = organismo
    ? `No hay trámites enviados a ${organismo.ciudad} en este momento.`
    : isAdmin
      ? 'Cuando operador envíe un trámite a tránsito, aparecerá aquí con el botón «Tomar trámite».'
      : 'Cuando operador envíe un trámite a tránsito, aparecerá aquí con el botón «Tomar trámite».';

  const emptyMisHint = organismo
    ? `Ningún trámite de ${organismo.ciudad} está asignado a usted.`
    : 'Tome un trámite de la sección «Pendientes de recibir» para asignar y confirmar placa.';

  const tomar = async (id: number) => {
    try {
      await api.post(`/transito/tomar/${id}`);
      toast.success('Trámite tomado');
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const asignarPlaca = async (id: number) => {
    const placa = placaInput[id];
    if (!placa || !placaValida(placa)) { toast.error('Ingrese una placa válida'); return; }
    try {
      await api.post(`/transito/asignar-placa/${id}`, { placa });
      toast.success(`Placa ${placa.toUpperCase()} preasignada`);
      setPlacaInput(prev => { const n = { ...prev }; delete n[id]; return n; });
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const confirmarPlaca = async (id: number) => {
    try {
      await api.post(`/transito/confirmar-placa/${id}`);
      toast.success('Placa confirmada y enviada al operador');
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const transicionarTraspaso = async (id: number, estado: string) => {
    try {
      await api.patch<{ estado: string }>(`/tramites/${id}/estado`, { estado });
      toast.success(`Estado: ${ESTADO_STT_LABEL[estado as TramiteEstadoStt] ?? estado}`);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const v = (t: Tramite) => t.vehiculo || {};
  const c = (t: Tramite) => t.comprador || {};

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title={displayLabel ? `Bandeja de tránsito — ${displayLabel}` : 'Bandeja de tránsito'}
        subtitle={
          organismo
            ? `Trámites enviados a ${organismo.nombre}`
            : isAdmin
              ? 'Vista global — todos los organismos'
              : 'Trámites pendientes de asignación de placa'
        }
        leading={
          orgConfig?.logoUrl ? (
            <img
              src={orgConfig.logoUrl}
              alt=""
              className="h-12 w-12 shrink-0 rounded-xl object-contain"
              style={{ border: '1px solid var(--flit-border-soft)' }}
            />
          ) : undefined
        }
      />

      <div
        className="flex gap-2 rounded-xl border bg-white p-1.5"
        style={{ borderColor: 'var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
        role="tablist"
        aria-label="Tipo de bandeja"
      >
        {([
          { id: 'matricula' as const, label: 'Matrícula inicial' },
          { id: 'traspaso' as const, label: 'Traspasos STT' },
        ]).map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className="flit-focus flex-1 rounded-[10px] px-3 py-2 text-xs font-semibold transition-colors"
            style={{
              color: tab === id ? '#fff' : 'var(--flit-text-secondary)',
              background: tab === id ? 'var(--flit-gradient-primary)' : 'transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {isAdmin && (
        <div
          className="flex flex-col gap-2 rounded-xl border bg-white p-4 sm:flex-row sm:items-end sm:gap-4"
          style={{ borderColor: 'var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
        >
          <div className="min-w-0 flex-1">
            <label htmlFor="admin-transito-scope" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
              Filtrar por organismo
            </label>
            <FlitOrganismoCombobox
              id="admin-transito-scope"
              value={adminScope}
              onChange={handleAdminScope}
              allowEmpty
              emptyLabel="Todos los organismos"
              aria-label="Filtrar bandeja por organismo de tránsito"
            />
          </div>
          <p className="text-[11px] leading-relaxed sm:max-w-xs" style={{ color: 'var(--flit-text-muted)' }}>
            {adminScope
              ? 'Vista acotada a un municipio. Los usuarios tránsito solo ven su organismo asignado.'
              : 'Vista global. Cada tarjeta muestra el municipio destino.'}
          </p>
        </div>
      )}

      {scopeError && (
        <div
          className="rounded-xl border px-4 py-4 text-sm"
          style={{ borderColor: 'var(--flit-danger)', background: 'rgba(220, 38, 38, 0.08)' }}
          role="alert"
        >
          <p className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{scopeError}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            El administrador FLIT debe asignar su organismo en Usuarios y usted debe volver a iniciar sesión.
          </p>
        </div>
      )}

      {loading && (
        <div className="py-16 text-center">
          <div className="inline-block h-10 w-10 animate-spin rounded-full border-4 motion-reduce:animate-none"
            style={{ borderColor: 'var(--flit-border-soft)', borderTopColor: 'var(--flit-blue)' }} />
        </div>
      )}

      {!loading && !scopeError && tab === 'matricula' && (
        <>
          <section>
            <SectionTitle barColor="var(--flit-warning)" label={`Pendientes de recibir (${pendientes.length})`} />
            {pendientes.length > 0 && (
              <div
                className="mb-3 flex items-start gap-2 rounded-xl border px-4 py-3"
                style={{ background: 'rgba(240, 90, 53, 0.10)', borderColor: 'var(--flit-warning)' }}
                role="status"
              >
                <span className="mt-0.5 text-sm font-bold" style={{ color: 'var(--flit-warning)' }} aria-hidden>!</span>
                <p className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                  {pendientes.length === 1
                    ? 'Hay 1 trámite esperando que lo tomes para asignar placa.'
                    : `Hay ${pendientes.length} trámites esperando que los tomes para asignar placa.`}
                </p>
              </div>
            )}
            {pendientes.length === 0 ? (
              <EmptyCard
                text={organismo ? `Sin pendientes en ${organismo.ciudad}` : 'No hay trámites pendientes'}
                hint={emptyPendientesHint}
              />
            ) : (
              <div className="space-y-3">
                {pendientes.map(t => (
                  <Card key={t.id}>
                    <TramiteBody t={t} v={v} c={c} showOrganismoBadge={showOrganismoBadge} onVerExpediente={() => setExpedienteId(t.id)} />
                    <GradientButton type="button" onClick={() => tomar(t.id)} className="shrink-0 self-center sm:self-auto">
                      Tomar trámite
                    </GradientButton>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionTitle barColor="var(--flit-blue)" label={`Mis trámites (${misTramites.length})`} />
            {misTramites.length === 0 ? (
              <EmptyCard
                text={organismo ? `Sin trámites asignados en ${organismo.ciudad}` : 'No tiene trámites asignados'}
                hint={emptyMisHint}
              />
            ) : (
              <div className="space-y-3">
                {misTramites.map(t => {
                  const recibido = t.estado === 'recibido_transito';
                  const estadoTone: ChipTone = recibido ? 'active' : 'success';
                  const estadoLabel = recibido ? 'Recibido' : 'Placa preasignada';
                  const rawPlaca = placaInput[t.id] || '';
                  const placaInvalid = rawPlaca.length > 0 && !placaValida(rawPlaca);
                  return (
                    <Card key={t.id}>
                      <TramiteBody t={t} v={v} c={c} placaHighlight={t.placa} showOrganismoBadge={showOrganismoBadge} onVerExpediente={() => setExpedienteId(t.id)} />
                      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                        <StatusChip tone={estadoTone}>{estadoLabel}</StatusChip>

                        {recibido && (
                          <div className="flex flex-col items-stretch gap-1 sm:items-end">
                            <div className="flex items-center gap-2">
                              <input
                                value={rawPlaca}
                                onChange={e => setPlacaInput(prev => ({ ...prev, [t.id]: e.target.value.toUpperCase() }))}
                                placeholder="ABC123"
                                maxLength={PLACA_MAX}
                                aria-invalid={placaInvalid}
                                className={placaInputCls(placaInvalid)}
                              />
                              <GradientButton type="button" variant="success" onClick={() => asignarPlaca(t.id)}>
                                Asignar placa
                              </GradientButton>
                            </div>
                            {placaInvalid && (
                              <p className="text-[11px] font-medium" style={{ color: 'var(--flit-danger)' }}>
                                Placa: 4–10 caracteres alfanuméricos
                              </p>
                            )}
                          </div>
                        )}

                        {t.estado === 'placa_preasignada' && (
                          <GradientButton type="button" onClick={() => confirmarPlaca(t.id)} className="shrink-0">
                            Confirmar y enviar
                          </GradientButton>
                        )}

                        {canRechazarOt(t.estado) && (
                          <button
                            type="button"
                            onClick={() => setRechazarTramite(t)}
                            className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-4 text-xs font-medium"
                            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
                          >
                            Devolver con observación
                          </button>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {!loading && !scopeError && tab === 'traspaso' && (
        <section>
          <SectionTitle barColor="var(--flit-blue)" label={`Traspasos activos (${traspasos.length})`} />
          {traspasos.length === 0 ? (
            <EmptyCard
              text={organismo ? `Sin traspasos activos en ${organismo.ciudad}` : 'No hay traspasos STT activos'}
              hint="Los traspasos radicados por el gestor aparecen aquí con su radicado TD- y estado STT."
            />
          ) : (
            <div className="space-y-3">
              {traspasos.map((t) => {
                const trans = transicionesDesde(t.estado);
                return (
                  <Card key={t.id}>
                    <TraspasoBody t={t} v={v} c={c} showOrganismoBadge={showOrganismoBadge} onVerExpediente={() => setExpedienteId(t.id)} />
                    <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                      <StatusChip tone="active">{ESTADO_STT_LABEL[t.estado as TramiteEstadoStt] ?? t.estado}</StatusChip>
                      {trans.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {trans.map((e) => (
                            <button
                              key={e}
                              type="button"
                              onClick={() => transicionarTraspaso(t.id, e)}
                              className="flit-focus rounded-[999px] px-2.5 py-1 text-[10px] font-semibold"
                              style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}
                            >
                              {ESTADO_STT_LABEL[e]}
                            </button>
                          ))}
                        </div>
                      )}
                      {isAdmin && (
                        <Link
                          to={`/tramite/traspaso?id=${t.id}`}
                          className="flit-focus text-[11px] font-semibold"
                          style={{ color: 'var(--flit-blue)' }}
                        >
                          Abrir wizard
                        </Link>
                      )}
                      <Link
                        to={`/transito/traspaso?id=${t.id}`}
                        className="flit-focus text-[11px] font-semibold"
                        style={{ color: 'var(--flit-blue)' }}
                      >
                        Abrir expediente STT
                      </Link>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}

      {expedienteId !== null && (
        tab === 'matricula' ? (
          <TransitoExpedienteMatriculaModal tramiteId={expedienteId} onClose={() => setExpedienteId(null)} />
        ) : (
          <FlitModal title={`Expediente #${expedienteId}`} onClose={() => setExpedienteId(null)}>
            <ExpedienteTimeline tramiteId={expedienteId} />
          </FlitModal>
        )
      )}

      {rechazarTramite && (
        <RechazarOtModal
          tramiteId={rechazarTramite.id}
          vin={rechazarTramite.vin}
          placa={rechazarTramite.placa}
          onClose={() => setRechazarTramite(null)}
          onSuccess={() => { setRechazarTramite(null); load(); }}
        />
      )}
    </div>
  );
}

function SectionTitle({ barColor, label }: { barColor: string; label: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="h-5 w-1.5 rounded-full" style={{ background: barColor }} />
      <h3 className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--flit-text-primary)' }}>{label}</h3>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col gap-3 bg-white p-4 sm:flex-row sm:items-center"
      style={{ borderRadius: 'var(--flit-radius-card)', boxShadow: 'var(--flit-shadow-card)', border: '1px solid var(--flit-border-soft)' }}
    >
      {children}
    </div>
  );
}

function EmptyCard({ text, hint }: { text: string; hint?: string }) {
  return (
    <div
      className="p-10 text-center"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px dashed var(--flit-border-input)', background: 'var(--flit-bg-card)' }}
    >
      <p className="text-sm font-medium" style={{ color: 'var(--flit-text-muted)' }}>{text}</p>
      {hint && (
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed" style={{ color: 'var(--flit-text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function OrganismoBadge({ codigo }: { codigo: string | null | undefined }) {
  const org = codigo ? getOrganismoByCodigo(codigo) : undefined;
  if (!org) return null;
  return (
    <span title={`${org.nombre} (${org.codigo})`}>
      <StatusChip tone="neutral">{org.ciudad}</StatusChip>
    </span>
  );
}

function TramiteBody({
  t,
  v,
  c,
  placaHighlight,
  showOrganismoBadge,
  onVerExpediente,
}: {
  t: Tramite;
  v: (t: Tramite) => { marca?: string; linea?: string; modelo?: string };
  c: (t: Tramite) => { nombre?: string; documento?: string };
  placaHighlight?: string | null;
  showOrganismoBadge?: boolean;
  onVerExpediente: () => void;
}) {
  const comprador = c(t);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-bold" style={{ color: 'var(--flit-blue)' }}>
          MI-{String(t.id).padStart(4, '0')}
        </span>
        {t.estado === 'enviado_transito' && <StatusChip tone="warning">Enviado</StatusChip>}
        {showOrganismoBadge && <OrganismoBadge codigo={t.organismoCodigo} />}
      </div>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {[v(t).marca, v(t).linea, v(t).modelo].filter(Boolean).join(' ') || 'Vehículo sin datos'}
      </p>
      <dl className="grid gap-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>VIN</dt>
          <dd className="font-mono font-medium" style={{ color: 'var(--flit-text-primary)' }}>{t.vin || '—'}</dd>
        </div>
        {comprador.nombre && (
          <div>
            <dt className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Comprador</dt>
            <dd style={{ color: 'var(--flit-text-primary)' }}>
              {comprador.nombre}
              {comprador.documento && (
                <span className="ml-1 font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                  · {comprador.documento}
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>
      {placaHighlight && (
        <p className="text-xs font-bold" style={{ color: 'var(--flit-success)' }}>
          Placa: {placaHighlight}
        </p>
      )}
      {t.updatedAt && t.estado === 'enviado_transito' && (
        <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          Enviado: {new Date(t.updatedAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
        </p>
      )}
      <button
        type="button"
        onClick={onVerExpediente}
        className="flit-focus mt-0.5 self-start text-[11px] font-semibold"
        style={{ color: 'var(--flit-blue)' }}
      >
        Ver expediente
      </button>
    </div>
  );
}

function TraspasoBody({
  t,
  v,
  c,
  showOrganismoBadge,
  onVerExpediente,
}: {
  t: Tramite;
  v: (t: Tramite) => { marca?: string; linea?: string; modelo?: string };
  c: (t: Tramite) => { nombre?: string; documento?: string };
  showOrganismoBadge?: boolean;
  onVerExpediente: () => void;
}) {
  const comprador = c(t);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-bold" style={{ color: 'var(--flit-blue)' }}>
          {t.numeroRadicado || `TD-${String(t.id).padStart(5, '0')}`}
        </span>
        {t.placa && <StatusChip tone="neutral">{t.placa}</StatusChip>}
        {showOrganismoBadge && <OrganismoBadge codigo={t.organismoCodigo} />}
      </div>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {[v(t).marca, v(t).linea, v(t).modelo].filter(Boolean).join(' ') || 'Vehículo sin datos'}
      </p>
      <dl className="grid gap-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>VIN</dt>
          <dd className="font-mono font-medium" style={{ color: 'var(--flit-text-primary)' }}>{t.vin || '—'}</dd>
        </div>
        {comprador.nombre && (
          <div>
            <dt className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>Comprador</dt>
            <dd style={{ color: 'var(--flit-text-primary)' }}>
              {comprador.nombre}
              {comprador.documento && (
                <span className="ml-1 font-mono text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
                  · {comprador.documento}
                </span>
              )}
            </dd>
          </div>
        )}
      </dl>
      {t.updatedAt && (
        <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          Actualizado: {new Date(t.updatedAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
        </p>
      )}
      <button
        type="button"
        onClick={onVerExpediente}
        className="flit-focus mt-0.5 self-start text-[11px] font-semibold"
        style={{ color: 'var(--flit-blue)' }}
      >
        Ver expediente
      </button>
    </div>
  );
}
