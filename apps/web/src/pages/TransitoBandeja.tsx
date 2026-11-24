import { useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ESTADO_STT_LABEL, getOrganismoByCodigo, transicionesDesde,
  type OrganismoTransitoAsignado, type TramiteEstadoStt,
} from '@operaciones/shared-types';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip from '../components/flit/StatusChip';
import Pestanas from '../components/flit/Pestanas';
import InlineAlert from '../components/flit/InlineAlert';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { Cargador } from '../components/flit/Cargador';
import { BarraAccion } from '../components/flit/Bloques';
import FlitModal from '../components/flit/FlitModal';
import FlitOrganismoCombobox from '../components/flit/FlitOrganismoCombobox';
import FlitSelect from '../components/flit/FlitSelect';
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

// HU #13426: la última secretaría elegida por un usuario con enlace a varias. Solo comodidad: si
// el storage falla o el código ya no está en su lista, se empieza en la que el servidor marca
// `porDefecto`.
const SECRETARIA_KEY = 'flit.transito.secretaria';

function readSecretaria(): string {
  try {
    return localStorage.getItem(SECRETARIA_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeSecretaria(codigo: string) {
  try {
    localStorage.setItem(SECRETARIA_KEY, codigo);
  } catch { /* ignore */ }
}

type SecretariasState =
  | { status: 'cargando' }
  | { status: 'error' }
  | { status: 'listo'; lista: OrganismoTransitoAsignado[] };

/**
 * La lista viene del enlace del usuario si trae un `porDefecto` o tiene un solo elemento. Sin
 * enlace el servidor devuelve el catálogo completo sin `porDefecto` (operador interno) y `[]` si no
 * hay nada: en ambos casos se sigue el flujo de siempre.
 */
function listaDelEnlace(lista: OrganismoTransitoAsignado[]): OrganismoTransitoAsignado[] | null {
  if (lista.length === 1 || lista.some((o) => o.porDefecto)) return lista;
  return null;
}

function secretariaInicial(lista: OrganismoTransitoAsignado[]): string {
  const guardada = readSecretaria();
  if (guardada && lista.some((o) => o.codigo === guardada)) return guardada;
  return (lista.find((o) => o.porDefecto) ?? lista[0]).codigo;
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

// Input de placa del kit (`.control`): mayúsculas, mono bold; inválido con borde naranja.
function placaInputCls(invalid: boolean): string {
  const base = 'control !w-28 text-center mono text-sm font-bold uppercase';
  return invalid ? `${base} !border-[var(--kit-naranja)]` : base;
}

export default function TransitoBandeja() {
  const { user, hasFuncion } = useAuth();
  // HU #12170: alcance multi-organismo = `transito.config.listar` (solo Operaciones en el seed).
  const isAdmin = hasFuncion('transito.config.listar');
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
  // HU #13426: secretarías del enlace. El admin no las pide: su flujo (adminScope) no cambia.
  const [secretarias, setSecretarias] = useState<SecretariasState>(
    isAdmin ? { status: 'listo', lista: [] } : { status: 'cargando' },
  );
  const [secretaria, setSecretaria] = useState('');

  // Sin la función de listar organismos no hay selector posible: el flujo de siempre.
  const puedeListarSecretarias = hasFuncion('transito.organismos.listar');

  const cargarSecretarias = useCallback(async () => {
    if (isAdmin || !puedeListarSecretarias) {
      setSecretarias({ status: 'listo', lista: [] });
      return;
    }
    setSecretarias({ status: 'cargando' });
    try {
      const lista = await api.get<OrganismoTransitoAsignado[]>('/transito/organismos');
      const segura = Array.isArray(lista) ? lista : [];
      const delEnlace = listaDelEnlace(segura);
      if (delEnlace) setSecretaria(secretariaInicial(delEnlace));
      setSecretarias({ status: 'listo', lista: segura });
    } catch (e) {
      // 403: el servidor no le da catálogo → flujo de siempre, no un callejón.
      if (e instanceof ApiError && e.status === 403) setSecretarias({ status: 'listo', lista: [] });
      else setSecretarias({ status: 'error' });
    }
  }, [isAdmin, puedeListarSecretarias]);

  useEffect(() => { cargarSecretarias(); }, [cargarSecretarias]);

  const enlace = secretarias.status === 'listo' ? listaDelEnlace(secretarias.lista) : null;
  const secretariaElegida = enlace?.find((o) => o.codigo === secretaria) ?? null;

  const scopeCodigo = isAdmin
    ? (adminScope || null)
    : enlace
      ? (secretariaElegida?.codigo ?? null)
      : (user?.transitoCodigo ?? null);

  const organismo = useMemo(() => {
    if (secretariaElegida) return secretariaElegida;
    return scopeCodigo ? getOrganismoByCodigo(scopeCodigo) ?? null : null;
  }, [scopeCodigo, secretariaElegida]);

  const displayLabel = orgConfig?.alias?.trim() || organismo?.ciudad || organismo?.nombre;

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

  // Con enlace, la secretaría elegida acota la consulta; sin ella el servidor usa la suya.
  const organismoQuery = isAdmin ? (adminScope || null) : enlace ? (secretariaElegida?.codigo ?? null) : null;
  const secretariasListas = secretarias.status === 'listo';

  const load = useCallback(async () => {
    if (!secretariasListas) return;
    setLoading(true);
    setScopeError(null);
    const qs = organismoQuery ? `?organismo=${encodeURIComponent(organismoQuery)}` : '';
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
      if (!isAdmin && hasFuncion('transito.bandeja.ver_pendientes') && /organismo/i.test(msg)) {
        setScopeError(msg);
      } else {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [organismoQuery, secretariasListas, isAdmin, tab, hasFuncion]);

  useEffect(() => { load(); }, [load]);

  const handleAdminScope = (codigo: string) => {
    setAdminScope(codigo);
    writeAdminScope(codigo);
  };

  // Escrituras: el `?organismo=` es opcional; con enlace se manda la secretaría que se está viendo.
  const escrituraQs = !isAdmin && organismoQuery ? `?organismo=${encodeURIComponent(organismoQuery)}` : '';

  const handleSecretaria = (codigo: string) => {
    setSecretaria(codigo);
    writeSecretaria(codigo);
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
      await api.post(`/transito/tomar/${id}${escrituraQs}`);
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
      await api.post(`/transito/asignar-placa/${id}${escrituraQs}`, { placa });
      toast.success(`Placa ${placa.toUpperCase()} preasignada`);
      setPlacaInput(prev => { const n = { ...prev }; delete n[id]; return n; });
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const confirmarPlaca = async (id: number) => {
    try {
      await api.post(`/transito/confirmar-placa/${id}${escrituraQs}`);
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

  // Columnas comunes de las tres tablas (molde #organismo › Trámites): ≤900 px cada fila es una tarjeta.
  const columnas = (
    ident: (t: Tramite) => ReactNode,
    extra: ColumnaTabla<Tramite>[],
  ): ColumnaTabla<Tramite>[] => [
    {
      key: 'tramite', header: 'Trámite', render: (t) => (
        <div className="flex flex-col items-start gap-1.5">
          <div className="flex flex-wrap items-center gap-2">{ident(t)}{showOrganismoBadge && <OrganismoBadge codigo={t.organismoCodigo} />}</div>
          <button type="button" onClick={() => setExpedienteId(t.id)} className={ENLACE}>Ver expediente</button>
        </div>
      ),
    },
    { key: 'vehiculo', header: 'Vehículo', render: (t) => <VehiculoCelda t={t} v={v} /> },
    { key: 'vin', header: 'VIN', render: (t) => <span className="mono font-medium">{t.vin || '—'}</span> },
    { key: 'comprador', header: 'Comprador', render: (t) => <CompradorCelda comprador={c(t)} /> },
    ...extra,
  ];

  const idMatricula = (t: Tramite) => (
    <>
      <span className="mono text-xs font-bold text-[var(--color-action)]">MI-{String(t.id).padStart(4, '0')}</span>
      {t.estado === 'enviado_transito' && <StatusChip tone="warning">Enviado</StatusChip>}
    </>
  );

  const colsPendientes = columnas(idMatricula, [
    {
      key: 'enviado', header: 'Enviado', soloEscritorio: false, render: (t) => (t.updatedAt && t.estado === 'enviado_transito' ? (
        <span className="text-xs text-[var(--color-text-tertiary)]">
          Enviado: {new Date(t.updatedAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
        </span>
      ) : null),
    },
    {
      key: 'acciones', header: 'Acciones', acciones: true, align: 'right', render: (t) => (
        <GradientButton type="button" size="sm" onClick={() => tomar(t.id)}>Tomar trámite</GradientButton>
      ),
    },
  ]);

  const colsMis = columnas(idMatricula, [
    {
      key: 'estado', header: 'Estado', render: (t) => (
        <div className="flex flex-col items-start gap-1">
          <StatusChip tone={t.estado === 'recibido_transito' ? 'active' : 'success'}>
            {t.estado === 'recibido_transito' ? 'Recibido' : 'Placa preasignada'}
          </StatusChip>
          {t.placa && <span className="text-xs font-bold text-[var(--kit-verde-texto)]">Placa: {t.placa}</span>}
        </div>
      ),
    },
    {
      key: 'acciones', header: 'Acciones', acciones: true, align: 'right', render: (t) => {
        const recibido = t.estado === 'recibido_transito';
        const rawPlaca = placaInput[t.id] || '';
        const placaInvalid = rawPlaca.length > 0 && !placaValida(rawPlaca);
        return (
          <div className="flex flex-wrap items-center justify-end gap-2">
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
                  <GradientButton type="button" size="sm" variant="success" onClick={() => asignarPlaca(t.id)}>
                    Asignar placa
                  </GradientButton>
                </div>
                {placaInvalid && (
                  <p className="text-xs font-medium text-[var(--kit-naranja-texto)]">Placa: 4–10 caracteres alfanuméricos</p>
                )}
              </div>
            )}
            {t.estado === 'placa_preasignada' && (
              <GradientButton type="button" size="sm" onClick={() => confirmarPlaca(t.id)}>Confirmar y enviar</GradientButton>
            )}
            {canRechazarOt(t.estado) && (
              <GradientButton type="button" size="sm" variant="alerta" onClick={() => setRechazarTramite(t)}>
                Devolver con observación
              </GradientButton>
            )}
          </div>
        );
      },
    },
  ]);

  const colsTraspasos = columnas((t) => (
    <>
      <span className="mono text-xs font-bold text-[var(--color-action)]">{t.numeroRadicado || `TD-${String(t.id).padStart(5, '0')}`}</span>
      {t.placa && <StatusChip tone="neutral">{t.placa}</StatusChip>}
    </>
  ), [
    {
      key: 'estado', header: 'Estado', render: (t) => (
        <div className="flex flex-col items-start gap-1">
          <StatusChip tone="active">{ESTADO_STT_LABEL[t.estado as TramiteEstadoStt] ?? t.estado}</StatusChip>
          {t.updatedAt && (
            <span className="text-xs text-[var(--color-text-tertiary)]">
              Actualizado: {new Date(t.updatedAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'acciones', header: 'Acciones', acciones: true, align: 'right', render: (t) => {
        const trans = transicionesDesde(t.estado);
        return (
          <div className="flex flex-col items-end gap-2">
            {trans.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1.5">
                {trans.map((e) => (
                  <GradientButton key={e} type="button" size="sm" variant={DESTRUCTIVO.test(e) ? 'alerta' : 'secondary'} onClick={() => transicionarTraspaso(t.id, e)}>
                    {ESTADO_STT_LABEL[e]}
                  </GradientButton>
                ))}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-x-3 gap-y-1">
              {isAdmin && <Link to={`/tramite/traspaso?id=${t.id}`} className={ENLACE}>Abrir wizard</Link>}
              <Link to={`/transito/traspaso?id=${t.id}`} className={ENLACE}>Abrir expediente STT</Link>
            </div>
          </div>
        );
      },
    },
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title={displayLabel ? `Bandeja de tránsito — ${displayLabel}` : 'Bandeja de tránsito'}
        subtitle={
          organismo
            ? `Trámites enviados a ${organismo.nombre}`
            : isAdmin
              ? 'Vista global — todos los organismos'
              : 'Trámites pendientes de asignación de placa'
        }
        icono={orgConfig?.logoUrl ? undefined : 'flito-transito'}
        miga={[]}
        leading={
          orgConfig?.logoUrl ? (
            <img src={orgConfig.logoUrl} alt="" className="h-12 w-12 shrink-0 rounded-[9px] border border-[var(--color-border)] object-contain" />
          ) : undefined
        }
      />

      <Pestanas
        etiqueta="Tipo de bandeja"
        activa={tab}
        onElegir={(id) => setTab(id as BandejaTab)}
        pestanas={[
          { id: 'matricula', etiqueta: 'Matrícula inicial' },
          { id: 'traspaso', etiqueta: 'Traspasos STT' },
        ]}
      />

      {isAdmin && (
        <div className="card flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
          <div className="campo min-w-0 flex-1">
            <label htmlFor="admin-transito-scope">Filtrar por organismo</label>
            <FlitOrganismoCombobox
              id="admin-transito-scope"
              value={adminScope}
              onChange={handleAdminScope}
              allowEmpty
              emptyLabel="Todos los organismos"
              aria-label="Filtrar bandeja por organismo de tránsito"
            />
          </div>
          <p className="nota leading-relaxed text-[var(--color-text-tertiary)] sm:max-w-xs">
            {adminScope
              ? 'Vista acotada a un municipio. Los usuarios tránsito solo ven su organismo asignado.'
              : 'Vista global. Cada tarjeta muestra el municipio destino.'}
          </p>
        </div>
      )}

      {!isAdmin && secretarias.status === 'cargando' && (
        <InlineAlert tono="info">Cargando sus secretarías de tránsito…</InlineAlert>
      )}

      {!isAdmin && secretarias.status === 'error' && (
        <div className="kit-alerta flex-wrap" data-kit="alerta" data-tono="danger" role="status">
          <img src="/kit/aviso-error.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
          <p className="min-w-0 flex-1 text-sm font-medium">
            No pudimos cargar sus secretarías de tránsito. Reintente para ver la bandeja.
          </p>
          <GradientButton type="button" size="sm" variant="secondary" onClick={() => { void cargarSecretarias(); }}>
            Reintentar secretarías
          </GradientButton>
        </div>
      )}

      {enlace && enlace.length > 1 && (
        <div className="card flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
          <div className="min-w-0 flex-1 sm:max-w-sm">
            <FlitSelect
              label="Secretaría"
              value={secretaria}
              onChange={handleSecretaria}
              opciones={enlace.map((o) => ({ valor: o.codigo, etiqueta: o.ciudad || o.nombre }))}
              ayuda="La bandeja muestra una secretaría a la vez."
            />
          </div>
        </div>
      )}

      {scopeError && (
        <InlineAlert tono="danger" titulo={scopeError}>
          <p className="mt-1 text-xs">El administrador FLIT debe asignar su organismo en Usuarios y usted debe volver a iniciar sesión.</p>
        </InlineAlert>
      )}

      {loading && secretariasListas && <Cargador className="py-10" />}

      {!loading && !scopeError && tab === 'matricula' && (
        <>
          <section className="flex flex-col gap-3">
            <SectionTitle label={`Pendientes de recibir (${pendientes.length})`} />
            {pendientes.length > 0 && (
              <BarraAccion>
                {pendientes.length === 1
                  ? 'Hay 1 trámite esperando que lo tomes para asignar placa.'
                  : `Hay ${pendientes.length} trámites esperando que los tomes para asignar placa.`}
              </BarraAccion>
            )}
            <DataTable
              ariaLabel="Pendientes de recibir"
              columnas={colsPendientes}
              filas={pendientes}
              getKey={(t) => String(t.id)}
              emptyMessage={organismo ? `Sin pendientes en ${organismo.ciudad}` : 'No hay trámites pendientes'}
              emptyDetalle={emptyPendientesHint}
            />
          </section>

          <section className="flex flex-col gap-3">
            <SectionTitle label={`Mis trámites (${misTramites.length})`} />
            <DataTable
              ariaLabel="Mis trámites"
              columnas={colsMis}
              filas={misTramites}
              getKey={(t) => String(t.id)}
              emptyMessage={organismo ? `Sin trámites asignados en ${organismo.ciudad}` : 'No tiene trámites asignados'}
              emptyDetalle={emptyMisHint}
            />
          </section>
        </>
      )}

      {!loading && !scopeError && tab === 'traspaso' && (
        <section className="flex flex-col gap-3">
          <SectionTitle label={`Traspasos activos (${traspasos.length})`} />
          <DataTable
            ariaLabel="Traspasos activos"
            columnas={colsTraspasos}
            filas={traspasos}
            getKey={(t) => String(t.id)}
            emptyMessage={organismo ? `Sin traspasos activos en ${organismo.ciudad}` : 'No hay traspasos STT activos'}
            emptyDetalle="Los traspasos radicados por el gestor aparecen aquí con su radicado TD- y estado STT."
          />
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

const ENLACE = 'text-xs font-semibold text-[var(--color-action)] underline-offset-2 transition-colors hover:underline';
// Transiciones STT que retroceden o cierran el trámite: botón naranja (destructivo) del kit.
const DESTRUCTIVO = /rechaz|anul|cancel|devuel|revoc/i;

function SectionTitle({ label }: { label: string }) {
  return <h3 className="text-sm font-bold uppercase tracking-[0.03em] text-[var(--color-text-primary)]">{label}</h3>;
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

function VehiculoCelda({ t, v }: { t: Tramite; v: (t: Tramite) => { marca?: string; linea?: string; modelo?: string } }) {
  return <span className="font-semibold">{[v(t).marca, v(t).linea, v(t).modelo].filter(Boolean).join(' ') || 'Vehículo sin datos'}</span>;
}

function CompradorCelda({ comprador }: { comprador: { nombre?: string; documento?: string } }) {
  if (!comprador.nombre) return <span className="text-[var(--color-text-tertiary)]">—</span>;
  return (
    <span>
      {comprador.nombre}
      {comprador.documento && <span className="mono ml-1 text-xs text-[var(--color-text-tertiary)]">· {comprador.documento}</span>}
    </span>
  );
}
