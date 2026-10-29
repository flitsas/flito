// FLITO Logística — consola de Operaciones. Organizada en pestañas:
//   1) Trámites — tabla general de TODOS los trámites aprobados, sin importar su estado logístico
//      (Pendiente de recogida → Registrada → Despachada → Entregada · Con novedad).
//   2) Viajes a cliente (HU #14116) — LT clasificadas agrupadas por compañía; se registra un viaje
//      (POST /traslados destino cliente). Nunca cerrar-lote.
//   3) Actas — actas generadas: se firman y despachan (firma de Operaciones), se descarga el PDF y se
//      hace seguimiento hasta la entrega firmada por el receptor.
// La firma del RECEPTOR se captura en campo (PWA). El acta combina ambas firmas en su PDF.

import { useEffect, useState } from 'react';
import { ESTADO_LOGISTICA_SIMPLE_LABEL, type CompaniaCerrableLogistica, type EstadoLogisticaSimple } from '@operaciones/shared-types';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { vacioConEnlace } from '../lib/copyEnlace';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle,
  flitBtnSecondary, flitBtnSecondaryStyle, FlitPillGroup, FlitPillButton,
} from '../components/flit/flitPageKit';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import { toastOk } from '../components/flit/ToastFlito';
import FirmaCanvas from '../components/flito/FirmaCanvas';
import ViajesACliente from '../components/flito/logistica/ViajesACliente';
import ViajesMasivo from '../components/flito/logistica/ViajesMasivo';
import ViajesLogistica from '../components/flito/logistica/ViajesLogistica';
import TabMotivosLlegada from '../components/flito/logistica/TabMotivosLlegada';
import BandejaLtPendientes from '../components/flito/logistica/bandeja/BandejaLtPendientes';
import { useLtPendientes } from '../components/flito/logistica/bandeja/useLtPendientes';
import { FUNCION_RESOLVER_TRAMITE } from '../components/flito/logistica/bandeja/tipos';

interface TramiteFila {
  tramiteId: string; idFlit: string; placa: string | null; vin: string | null; propietario: string | null;
  companiaId: number | null; companiaNombre: string | null; companiaNit: string | null;
  organismoCodigo: string | null; organismoNombre: string | null;
  docId: string | null; estado: string; estadoLabel: string;
  estadoSimple: EstadoLogisticaSimple; estadoSimpleLabel: string;
  numeroLicencia: string | null; numeroLt: string | null;
  actaId: string | null; motivo: string | null; actualizadoEn: string | null;
}
interface EventoDocumento { id: string; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; lat: string | null; lng: string | null; motivo: string | null; origen: string; creadoEn: string }
interface TramiteDetalle extends TramiteFila { propietarioDocumento: string | null; combustible: string | null; tieneFoto: boolean; eventos: EventoDocumento[] }
interface ActaFila { id: string; companiaId: number; companiaNombre: string | null; estado: string; estadoLabel: string; mensajeroId: number | null; mensajeroNombre: string | null; documentos: number; receptorNombre: string | null; entregadoEn: string | null; creadoEn: string }
interface ActaLinea { id: string; placa: string | null; secretaria: string | null; propietario: string | null; numeroLicencia: string | null; numeroLt: string | null; estado: string; estadoLabel: string; idFlit: string }
interface ActaEvento { id: string; documentoId: string; placa: string | null; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; motivo: string | null; origen: string; creadoEn: string }
interface ActaDetalle { acta: ActaFila; tienePdf: boolean; firmaEntrega: boolean; firmaRecibe: boolean; entregaNombre: string | null; documentos: ActaLinea[]; bitacora: ActaEvento[] }
interface Facetas {
  estados: string[]; empresas: Array<{ nit: string; nombre: string | null }>;
  organismos: Array<{ codigo: string; nombre: string | null }>;
  companiasCerrables: CompaniaCerrableLogistica[];
  mensajeros: Array<{ id: number; nombre: string }>;
}
interface Listado { items: TramiteFila[]; total: number; page: number; pageSize: number }

// Estados SIMPLE → tono del chip (mismos tonos del kit).
const TONO_SIMPLE: Record<EstadoLogisticaSimple, ChipTone> = {
  pendiente: 'neutral', registrada: 'active', despachada: 'warning', entregada: 'success', novedad: 'danger',
};
const TONO_ACTA: Record<string, ChipTone> = { generada: 'neutral', despachada: 'warning', entregada: 'success', devuelta: 'danger' };
const ESTADOS_SIMPLE: EstadoLogisticaSimple[] = ['pendiente', 'registrada', 'despachada', 'entregada', 'novedad'];

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—');

type Tab = 'tramites' | 'viajes-cliente' | 'actas' | 'viajes' | 'pendientes' | 'motivos-llegada';
type CargaFacetas = 'cargando' | 'ok' | 'error' | 'error403';

/** HU #13452: con enlace el vacío dice de quién son los trámites y no manda a sincronizar (operación interna). */
function vacioLogistica(tipoEnlace: Parameters<typeof vacioConEnlace>[1]): string {
  const conEnlace = vacioConEnlace('trámites aprobados', tipoEnlace);
  return conEnlace
    ? `${conEnlace} Los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.`
    : 'No hay trámites aprobados. Sincroniza desde FLIT: los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.';
}

export default function FlitoLogistica() {
  const { hasFuncion, tipoEnlace } = useAuth();
  // HU #12170 — despachar / novedad / devolver en Actas (no gobierna Viajes a cliente).
  const esOperaciones = hasFuncion('logistica.lote.cerrar');
  // HU #14116: pestaña Viajes a cliente. Sin ella no se pinta (AC7).
  const puedeRegistrarViaje = hasFuncion('logistica.traslado.registrar');
  // HU #14149: sin la función no hay pestaña ni petición a `/pendientes-tramite`.
  const puedeResolverLt = hasFuncion(FUNCION_RESOLVER_TRAMITE);
  const ltPend = useLtPendientes(puedeResolverLt);
  // HU #14120: pestaña Motivos de llegada. GET solo al entrar (el tab lo pide). Sin badge.
  const puedeGestionarMotivos = hasFuncion('logistica.motivos.gestionar');

  const [tab, setTab] = useState<Tab>('tramites');
  const [data, setData] = useState<Listado | null>(null);
  const [actas, setActas] = useState<ActaFila[] | null>(null);
  const [facetas, setFacetas] = useState<Facetas | null>(null);
  const [facetasCarga, setFacetasCarga] = useState<CargaFacetas>('cargando');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [buscar, setBuscar] = useState('');
  const [estadosSel, setEstadosSel] = useState<string[]>([]);
  const [empresaSel, setEmpresaSel] = useState('');

  const [detalle, setDetalle] = useState<TramiteDetalle | null>(null);
  const [motivoModal, setMotivoModal] = useState<{ tipo: 'novedad' | 'devolucion'; id: string } | null>(null);
  const [despacharActa, setDespacharActa] = useState<ActaFila | null>(null);
  const [actaDetalle, setActaDetalle] = useState<ActaDetalle | null>(null);

  const cargar = () => {
    setError(null);
    const params = new URLSearchParams();
    if (buscar.trim()) params.set('buscar', buscar.trim());
    if (estadosSel.length) params.set('estados', estadosSel.join(','));
    if (empresaSel) params.set('empresas', empresaSel);
    api.get<Listado>(`/flito/logistica?${params.toString()}`).then(setData).catch((e) => setError(errorMessage(e)));
    api.get<ActaFila[]>('/flito/logistica/actas').then(setActas).catch(() => setActas([]));
  };
  useEffect(cargar, [buscar, estadosSel, empresaSel]);
  const recargarFacetas = () => {
    setFacetasCarga('cargando');
    return api.get<Facetas>('/flito/logistica/facetas')
      .then((f) => { setFacetas(f); setFacetasCarga('ok'); })
      .catch((e) => {
        setFacetas(null);
        setFacetasCarga(e instanceof ApiError && e.status === 403 ? 'error403' : 'error');
      });
  };
  useEffect(() => { recargarFacetas(); }, []);

  const accion = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); cargar(); recargarFacetas(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const toggleEstado = (e: string) => setEstadosSel((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  const verDetalle = (id: string) => api.get<TramiteDetalle>(`/flito/logistica/${id}`).then(setDetalle).catch((e) => setError(errorMessage(e)));
  const verActa = (id: string) => api.get<ActaDetalle>(`/flito/logistica/actas/${id}`).then(setActaDetalle).catch((e) => setError(errorMessage(e)));
  const descargarPdf = async (id: string) => {
    try { const { url } = await api.get<{ url: string }>(`/flito/logistica/actas/${id}/pdf`); window.open(url, '_blank'); }
    catch (e) { setError(errorMessage(e)); }
  };

  const filas = data?.items ?? [];
  const cerrables = facetas?.companiasCerrables ?? [];
  const registradas = cerrables.reduce((n, c) => n + c.disponibles, 0);
  const actasPendientes = (actas ?? []).filter((a) => a.estado === 'generada').length;

  const TABS: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: 'tramites', label: 'Trámites', badge: data?.total },
    ...(puedeRegistrarViaje ? [{ key: 'viajes-cliente' as const, label: 'Viajes a cliente', badge: registradas || undefined }] : []),
    { key: 'actas', label: 'Actas', badge: actasPendientes || undefined },
    ...(hasFuncion('logistica.viajes.registrar') ? [{ key: 'viajes' as const, label: 'Viajes adicionales' }] : []),
    ...(puedeResolverLt ? [{ key: 'pendientes' as Tab, label: 'LT pendientes', badge: ltPend.error ? undefined : (ltPend.items?.length || undefined) }] : []),
    ...(puedeGestionarMotivos ? [{ key: 'motivos-llegada' as const, label: 'Motivos de llegada' }] : []),
  ];

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Logística"
        subtitle="Trámites aprobados a la espera de su licencia de tránsito: de la recogida en el organismo a la entrega firmada."
      />

      {/* Pestañas */}
      <div className="flex flex-wrap gap-1 border-b" style={{ borderColor: 'var(--flit-border-soft)' }}>
        {TABS.map((t) => {
          const activa = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              aria-label={t.badge != null ? `${t.label}, ${t.badge}` : undefined}
              className="flit-focus relative -mb-px rounded-t-lg px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--flit-bg-hover)]"
              style={{
                color: activa ? 'var(--flit-blue-text)' : 'var(--flit-text-secondary)',
                borderBottom: `2px solid ${activa ? 'var(--flit-blue-text)' : 'transparent'}`,
              }}>
              {t.label}
              {t.badge != null && (
                <span className="ml-2 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums"
                  style={{ background: activa ? 'rgba(48,102,190,0.12)' : 'var(--flit-border-soft)', color: activa ? 'var(--flit-blue-text)' : 'var(--flit-text-secondary)' }}>
                  {t.badge.toLocaleString('es-CO')}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && <FlitCard><p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p></FlitCard>}

      {tab === 'viajes' && hasFuncion('logistica.viajes.registrar') && <ViajesMasivo />}

      {/* ── Pestaña 1: Trámites (tabla general) ── */}
      {tab === 'tramites' && (
        <>
          <FlitCard>
            <div className="flex flex-wrap items-center gap-3">
              <input className={flitInp + ' max-w-xs'} placeholder="Buscar placa, VIN o trámite FLIT…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
              <select className={flitInp + ' max-w-xs'} value={empresaSel} onChange={(e) => setEmpresaSel(e.target.value)}>
                <option value="">Todas las empresas</option>
                {facetas?.empresas.map((e) => <option key={e.nit} value={e.nit}>{e.nombre ?? e.nit}</option>)}
              </select>
            </div>
            <div className="mt-3">
              <FlitPillGroup>
                {ESTADOS_SIMPLE.map((e) => (
                  <FlitPillButton key={e} active={estadosSel.includes(e)} onClick={() => toggleEstado(e)}>{ESTADO_LOGISTICA_SIMPLE_LABEL[e]}</FlitPillButton>
                ))}
              </FlitPillGroup>
            </div>
          </FlitCard>

          {data && filas.length === 0 && (
            <FlitCard><FlitEmpty>{vacioLogistica(tipoEnlace)}</FlitEmpty></FlitCard>
          )}

          {filas.length > 0 && (
            <FlitCard>
              <div className="overflow-x-auto">
                <FlitTable>
                  <thead>
                    <FlitTr>
                      <FlitTh>Placa</FlitTh><FlitTh>Propietario</FlitTh><FlitTh>Empresa</FlitTh>
                      <FlitTh>Secretaría</FlitTh><FlitTh>N.º LT</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Acciones</FlitTh>
                    </FlitTr>
                  </thead>
                  <tbody>
                    {filas.map((f) => (
                      <FlitTr key={f.tramiteId}>
                        <td className="px-4 py-2">
                          <div className="text-sm font-medium tabular-nums">{f.placa ?? '—'}</div>
                          <div className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.idFlit}</div>
                        </td>
                        <td className="px-4 py-2 text-sm">{f.propietario ?? '—'}</td>
                        <td className="px-4 py-2 text-sm">{f.companiaNombre ?? f.companiaNit ?? '—'}</td>
                        <td className="px-4 py-2 text-sm">{f.organismoNombre ?? f.organismoCodigo ?? '—'}</td>
                        <td className="px-4 py-2 text-sm tabular-nums">{f.numeroLt ?? '—'}</td>
                        <td className="px-4 py-2">
                          <StatusChip tone={TONO_SIMPLE[f.estadoSimple]}>{f.estadoSimpleLabel}</StatusChip>
                          {f.motivo && <div className="mt-1 text-xs" style={{ color: 'var(--flit-danger)' }}>{f.motivo}</div>}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap gap-2">
                            <button className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }} onClick={() => verDetalle(f.tramiteId)}>Detalle</button>
                            {esOperaciones && f.docId && f.estadoSimple === 'registrada' && (
                              <button className="text-xs font-semibold" style={{ color: 'var(--flit-danger)' }}
                                onClick={() => setMotivoModal({ tipo: 'novedad', id: f.docId! })}>Novedad</button>
                            )}
                          </div>
                        </td>
                      </FlitTr>
                    ))}
                  </tbody>
                </FlitTable>
              </div>
            </FlitCard>
          )}
        </>
      )}

      {tab === 'viajes-cliente' && puedeRegistrarViaje && (
        <ViajesACliente
          grupos={cerrables}
          estado={facetasCarga}
          onReintentar={() => { void recargarFacetas(); }}
          onRegistrado={() => { cargar(); void recargarFacetas(); }}
        />
      )}

      {/* ── Pestaña 3: Actas ── */}
      {tab === 'actas' && (
        <FlitCard>
          <h2 className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Actas</h2>
          {(!actas || actas.length === 0) ? (
            <FlitEmpty>Aún no hay actas. Ve a «Viajes a cliente» y registra el viaje de una compañía con LT clasificadas.</FlitEmpty>
          ) : (
            <div className="overflow-x-auto">
              <FlitTable>
                <thead>
                  <FlitTr>
                    <FlitTh>Empresa</FlitTh><FlitTh>Licencias</FlitTh><FlitTh>Mensajero</FlitTh>
                    <FlitTh>Estado</FlitTh><FlitTh>Receptor</FlitTh><FlitTh>Acciones</FlitTh>
                  </FlitTr>
                </thead>
                <tbody>
                  {actas.map((a) => (
                    <FlitTr key={a.id}>
                      <td className="px-4 py-2 text-sm">{a.companiaNombre ?? '—'}</td>
                      <td className="px-4 py-2 text-sm tabular-nums">{a.documentos}</td>
                      <td className="px-4 py-2 text-sm">{a.mensajeroNombre ?? '—'}</td>
                      <td className="px-4 py-2"><StatusChip tone={TONO_ACTA[a.estado] ?? 'neutral'}>{a.estadoLabel}</StatusChip></td>
                      <td className="px-4 py-2 text-sm">{a.receptorNombre ? `${a.receptorNombre} · ${fecha(a.entregadoEn)}` : '—'}</td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }} onClick={() => verActa(a.id)}>Ver</button>
                          {esOperaciones && a.estado === 'generada' && (
                            <button className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }} onClick={() => setDespacharActa(a)}>Firmar y despachar</button>
                          )}
                          {esOperaciones && a.estado === 'despachada' && (
                            <button className="text-xs font-semibold" style={{ color: 'var(--flit-danger)' }} onClick={() => setMotivoModal({ tipo: 'devolucion', id: a.id })}>Devolver</button>
                          )}
                        </div>
                      </td>
                    </FlitTr>
                  ))}
                </tbody>
              </FlitTable>
            </div>
          )}
        </FlitCard>
      )}

      {/* ── Pestaña: LT pendientes de trámite (HU #14149) ── */}
      {tab === 'pendientes' && puedeResolverLt && <BandejaLtPendientes {...ltPend} />}

      {/* ── Pestaña: Motivos de llegada (HU #14120). GET al entrar, no al montar la consola. ── */}
      {tab === 'motivos-llegada' && puedeGestionarMotivos && <TabMotivosLlegada />}

      {detalle && <DetalleModal doc={detalle} onClose={() => setDetalle(null)} />}
      {actaDetalle && <ActaDetalleModal detalle={actaDetalle} onClose={() => setActaDetalle(null)} onPdf={() => descargarPdf(actaDetalle.acta.id)} />}
      {motivoModal && (
        <MotivoModal tipo={motivoModal.tipo} busy={busy} onClose={() => setMotivoModal(null)}
          onConfirmar={(motivo) => accion(() => motivoModal.tipo === 'novedad'
            ? api.post(`/flito/logistica/documentos/${motivoModal.id}/novedad`, { motivo })
            : api.post(`/flito/logistica/actas/${motivoModal.id}/devolucion`, { motivo })).then(() => setMotivoModal(null))} />
      )}
      {despacharActa && facetas && (
        <DespacharModal mensajeros={facetas.mensajeros} busy={busy} onClose={() => setDespacharActa(null)}
          onDespachar={(payload) => accion(() => api.post(`/flito/logistica/actas/${despacharActa.id}/despachar`, payload)).then(() => {
            const m = facetas.mensajeros.find((x) => x.id === payload.mensajeroId);
            toastOk(`Viaje despachado a ${m?.nombre ?? 'el mensajero'}.`);
            setDespacharActa(null);
          })} />
      )}
    </div>
  );
}

function DetalleModal({ doc, onClose }: { doc: TramiteDetalle; onClose: () => void }) {
  const { hasFuncion } = useAuth();
  return (
    <FlitModal title={`Licencia · ${doc.placa ?? doc.vin ?? ''}`} onClose={onClose} wide>
      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Trámite FLIT</span><div>{doc.idFlit}</div></div>
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Empresa</span><div>{doc.companiaNombre ?? doc.companiaNit ?? '—'}</div></div>
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Secretaría</span><div>{doc.organismoNombre ?? doc.organismoCodigo ?? '—'}</div></div>
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Estado</span><div><StatusChip tone={TONO_SIMPLE[doc.estadoSimple]}>{doc.estadoSimpleLabel}</StatusChip></div></div>
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Propietario</span><div>{doc.propietario ?? '—'}{doc.propietarioDocumento ? ` · ${doc.propietarioDocumento}` : ''}</div></div>
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>N.º licencia / N.º LT</span><div className="tabular-nums">{doc.numeroLicencia ?? '—'} / {doc.numeroLt ?? '—'}</div></div>
      </div>
      {/* HU #12620: sin `logistica.viajes.ver` la sección no existe ni pide nada al API. */}
      {hasFuncion('logistica.viajes.ver') && (
        <ViajesLogistica tramiteId={doc.tramiteId} idFlit={doc.idFlit} fecha={fecha}
          puedeRegistrar={hasFuncion('logistica.viajes.registrar')} puedeQuitar={hasFuncion('logistica.viajes.quitar')} />
      )}
      {doc.docId ? (
        <>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Bitácora</h3>
          <ol className="space-y-2">
            {doc.eventos.map((e) => (
              <li key={e.id} className="text-sm">
                <span className="font-medium">{ESTADO_LOGISTICA_SIMPLE_LABEL[simple(e.estadoNuevo)]}</span>
                <span style={{ color: 'var(--flit-text-muted)' }}> · {fecha(e.creadoEn)} · {e.actorNombre ?? (e.origen === 'api' ? 'sistema' : '—')}</span>
                {e.motivo && <div className="text-xs" style={{ color: 'var(--flit-danger)' }}>{e.motivo}</div>}
                {(e.lat && e.lng) && <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>📍 {e.lat}, {e.lng}</div>}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>La licencia aún no se ha recogido. El mensajero la escaneará en el organismo.</p>
      )}
    </FlitModal>
  );
}

// Colapsa un estado interno de evento al vocabulario simple para la bitácora del detalle.
function simple(estadoInterno: string): EstadoLogisticaSimple {
  switch (estadoInterno) {
    case 'recogido': case 'clasificado': case 'en_acta': return 'registrada';
    case 'despachado': return 'despachada';
    case 'entregado': return 'entregada';
    case 'novedad': case 'devuelto': return 'novedad';
    default: return 'pendiente';
  }
}

function ActaDetalleModal({ detalle, onClose, onPdf }: { detalle: ActaDetalle; onClose: () => void; onPdf: () => void }) {
  const { acta, documentos, bitacora, firmaEntrega, firmaRecibe, entregaNombre } = detalle;
  return (
    <FlitModal title={`Acta · ${acta.companiaNombre ?? ''}`} onClose={onClose} wide>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <StatusChip tone={TONO_ACTA[acta.estado] ?? 'neutral'}>{acta.estadoLabel}</StatusChip>
          <span className="ml-2" style={{ color: 'var(--flit-text-muted)' }}>
            {acta.documentos} licencia(s) · {acta.mensajeroNombre ? `Mensajero: ${acta.mensajeroNombre}` : 'Sin despachar'}
          </span>
        </div>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onPdf}>Descargar PDF</button>
      </div>

      <div className="mb-4 flex gap-2 text-xs">
        <span className="rounded-full px-2 py-1" style={{ background: firmaEntrega ? 'rgba(112,207,58,0.14)' : 'rgba(89,103,125,0.14)', color: firmaEntrega ? 'var(--flit-success)' : 'var(--flit-text-secondary)' }}>
          {firmaEntrega ? `✓ Entrega${entregaNombre ? ` · ${entregaNombre}` : ''}` : 'Entrega sin firmar'}
        </span>
        <span className="rounded-full px-2 py-1" style={{ background: firmaRecibe ? 'rgba(112,207,58,0.14)' : 'rgba(89,103,125,0.14)', color: firmaRecibe ? 'var(--flit-success)' : 'var(--flit-text-secondary)' }}>
          {firmaRecibe ? `✓ Recibe${acta.receptorNombre ? ` · ${acta.receptorNombre}` : ''}` : 'Recibe sin firmar'}
        </span>
      </div>

      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Licencias</h3>
      <div className="mb-4 overflow-x-auto">
        <FlitTable>
          <thead>
            <FlitTr><FlitTh>Placa</FlitTh><FlitTh>Secretaría</FlitTh><FlitTh>Propietario</FlitTh><FlitTh>N.º licencia</FlitTh><FlitTh>N.º LT</FlitTh><FlitTh>Estado</FlitTh></FlitTr>
          </thead>
          <tbody>
            {documentos.map((d) => (
              <FlitTr key={d.id}>
                <td className="px-4 py-2 text-sm tabular-nums">{d.placa ?? '—'}</td>
                <td className="px-4 py-2 text-sm">{d.secretaria ?? '—'}</td>
                <td className="px-4 py-2 text-sm">{d.propietario ?? '—'}</td>
                <td className="px-4 py-2 text-sm tabular-nums">{d.numeroLicencia ?? '—'}</td>
                <td className="px-4 py-2 text-sm tabular-nums">{d.numeroLt ?? '—'}</td>
                <td className="px-4 py-2"><StatusChip tone={TONO_SIMPLE[simple(d.estado)]}>{ESTADO_LOGISTICA_SIMPLE_LABEL[simple(d.estado)]}</StatusChip></td>
              </FlitTr>
            ))}
          </tbody>
        </FlitTable>
      </div>

      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Bitácora del despacho</h3>
      <ol className="space-y-2">
        {bitacora.map((e) => (
          <li key={e.id} className="text-sm">
            <span className="tabular-nums">{e.placa ?? '—'}</span>
            <span className="ml-1 font-medium">{ESTADO_LOGISTICA_SIMPLE_LABEL[simple(e.estadoNuevo)]}</span>
            <span style={{ color: 'var(--flit-text-muted)' }}> · {fecha(e.creadoEn)} · {e.actorNombre ?? (e.origen === 'api' ? 'sistema' : '—')}</span>
            {e.motivo && <div className="text-xs" style={{ color: 'var(--flit-danger)' }}>{e.motivo}</div>}
          </li>
        ))}
      </ol>
    </FlitModal>
  );
}

function MotivoModal({ tipo, busy, onClose, onConfirmar }: { tipo: 'novedad' | 'devolucion'; busy: boolean; onClose: () => void; onConfirmar: (motivo: string) => void }) {
  const [motivo, setMotivo] = useState('');
  const titulo = tipo === 'novedad' ? 'Reportar novedad' : 'Registrar devolución';
  return (
    <FlitModal title={titulo} onClose={onClose}>
      <FlitField label="Motivo (obligatorio)">
        <textarea className={flitInp} rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={tipo === 'novedad' ? 'Dañada o inconsistente…' : 'Receptor ausente o rechazó…'} />
      </FlitField>
      <div className="mt-4 flex justify-end gap-2">
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={busy || !motivo.trim()} onClick={() => onConfirmar(motivo.trim())}>Confirmar</button>
      </div>
    </FlitModal>
  );
}

function DespacharModal({ mensajeros, busy, onClose, onDespachar }: { mensajeros: Facetas['mensajeros']; busy: boolean; onClose: () => void; onDespachar: (payload: { mensajeroId: number; firmaEntrega: string; entregaNombre?: string }) => void }) {
  const [sel, setSel] = useState('');
  const [nombre, setNombre] = useState('');
  const [firma, setFirma] = useState<string | null>(null);
  return (
    <FlitModal title="Firmar entrega y despachar" onClose={onClose}>
      <FlitField label="Mensajero">
        <select className={flitInp} value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">Selecciona…</option>
          {mensajeros.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
        </select>
      </FlitField>
      {mensajeros.length === 0 && <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>No hay mensajeros registrados. Crea un usuario con rol Mensajero.</p>}
      <div className="mt-3">
        <FlitField label="Nombre de quien entrega (Operaciones)">
          <input className={flitInp} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Opcional (por defecto tu usuario)" />
        </FlitField>
      </div>
      <div className="mt-3">
        <span className="mb-1 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Firma de quien entrega</span>
        <FirmaCanvas onChange={setFirma} />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={busy || !sel || !firma}
          onClick={() => onDespachar({ mensajeroId: Number(sel), firmaEntrega: firma!, entregaNombre: nombre.trim() || undefined })}>Firmar y despachar</button>
      </div>
    </FlitModal>
  );
}
