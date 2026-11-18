// FLITO Logística — consola de Operaciones y del proveedor de logística (HU #14353). Organizada en pestañas:
//   1) Trámites — tabla general de TODOS los trámites aprobados, sin importar su estado logístico
//      (Pendiente de recogida → Registrada → Despachada → Entregada · Con novedad).
//   2) Viajes (HU #14116 / #14123) — LT clasificadas agrupadas por compañía; el destino es Cliente
//      o FLIT (dos POST si el grupo se reparte). Nunca cerrar-lote.
//   3) Actas — actas generadas: se firman y despachan, se descarga el PDF y se hace seguimiento hasta la
//      entrega firmada por el receptor.
// Cada acción exige su función. Lo que no es del proveedor (AC4) exige además que el enlace no sea de proveedor:
// así no aparece aunque un administrador le asigne esa función a un rol de proveedor. Los filtros viajan en el
// cuerpo de `POST /buscar`: ni la URL de la página ni la del API llevan placa, VIN o NIT (AC5).
// La firma del RECEPTOR se captura en campo (PWA). El acta combina ambas firmas en su PDF.

import { useEffect, useRef, useState } from 'react';
import type { ActaFilaLogistica, BuscarLogisticaCuerpo, CompaniaCerrableLogistica, ListadoTramitesLogistica, TramiteFilaLogistica } from '@operaciones/shared-types';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import NoAccess from '../components/NoAccess';
import { vacioConEnlace } from '../lib/copyEnlace';
import { esRechazoDeAlcance, mensajeEscrituraLogistica, mensajeLecturaLogistica, mensajePdfLogistica } from '../lib/mensajesLogisticaHttp';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitCard } from '../components/flit/flitPageKit';
import { toastError } from '../components/flit/ToastFlito';
import ViajesACliente from '../components/flito/logistica/ViajesACliente';
import { LlegadaFlitModal } from '../components/flito/ruta/LlegadaFlit';
import ViajesMasivo from '../components/flito/logistica/ViajesMasivo';
import TabMotivosLlegada from '../components/flito/logistica/TabMotivosLlegada';
import TabEntregas from '../components/flito/logistica/TabEntregas';
import TabTramites from '../components/flito/logistica/TabTramites';
import TabActas from '../components/flito/logistica/TabActas';
import ModalDespacharActa from '../components/flito/logistica/ModalDespacharActa';
import { ActaDetalleModal, DetalleModal, MotivoModal } from '../components/flito/logistica/ModalesConsola';
import { AvisoNoActualizado, type ActaDetalle, type TramiteDetalle } from '../components/flito/logistica/consolaLogistica';
import BandejaLtPendientes from '../components/flito/logistica/bandeja/BandejaLtPendientes';
import { nuevaKey } from '../lib/viajesCliente';
import { useLtPendientes } from '../components/flito/logistica/bandeja/useLtPendientes';
import { FUNCION_RESOLVER_TRAMITE } from '../components/flito/logistica/bandeja/tipos';

type ActaFila = ActaFilaLogistica;
interface Facetas {
  estados: string[]; empresas: Array<{ nit: string; nombre: string | null }>;
  organismos: Array<{ codigo: string; nombre: string | null }>;
  companiasCerrables: CompaniaCerrableLogistica[];
}
type Listado = ListadoTramitesLogistica;

type Tab = 'tramites' | 'viajes-cliente' | 'entregas' | 'actas' | 'viajes' | 'pendientes' | 'motivos-llegada';
type CargaFacetas = 'cargando' | 'ok' | 'error' | 'error403';

const DEBOUNCE_BUSCAR_MS = 400;

/** HU #13452: con enlace el vacío dice de quién son los trámites y no manda a sincronizar (operación interna). */
function vacioLogistica(tipoEnlace: Parameters<typeof vacioConEnlace>[1]): string {
  const conEnlace = vacioConEnlace('trámites aprobados', tipoEnlace);
  return conEnlace
    ? `${conEnlace} Los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.`
    : 'No hay trámites aprobados. Sincroniza desde FLIT: los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.';
}

export default function FlitoLogistica() {
  const { hasFuncion, tipoEnlace, funciones } = useAuth();
  const esProveedor = tipoEnlace === 'proveedor';
  // `/mios` responde 'ninguno' a quien no tiene enlace: es un valor, no un vacío.
  const conEnlace = !!tipoEnlace && tipoEnlace !== 'ninguno';
  // Gate por función (reemplaza a `lote.cerrar`, que el proveedor no tiene).
  const permisosActas = {
    ver: hasFuncion('logistica.actas.ver'),
    // D7: `POST /actas/:id/despachar` da 403 al enlace compañía, aunque tenga la función.
    despachar: hasFuncion('logistica.actas.despachar') && tipoEnlace !== 'compania',
    devolver: hasFuncion('logistica.actas.devolver'),
    firmarLlegada: hasFuncion('logistica.actas.firmar_flit') && !esProveedor,
  };
  const puedeNovedad = hasFuncion('logistica.documento.reportar_novedad');
  const puedeVerDocumento = hasFuncion('logistica.documento.ver');
  const puedePdf = hasFuncion('logistica.actas.descargar');
  // HU #14116 / #14123: pestaña Viajes. Sin la función no se pinta (H3: sin regla por rol, sin exigir `consola.filtrar`).
  const puedeRegistrarViaje = hasFuncion('logistica.traslado.registrar');
  // HU #14149: sin la función no hay pestaña ni petición a `/pendientes-tramite`.
  const puedeResolverLt = hasFuncion(FUNCION_RESOLVER_TRAMITE) && !esProveedor;
  const ltPend = useLtPendientes(puedeResolverLt);
  // HU #14120: pestaña Motivos de llegada. GET solo al entrar (el tab lo pide). Sin badge.
  const puedeGestionarMotivos = hasFuncion('logistica.motivos.gestionar') && !esProveedor;
  const puedeViajesAdicionales = hasFuncion('logistica.viajes.registrar') && !esProveedor;
  // HU #14125: pestaña Entregas. POST solo al entrar (el tab lo pide). Sin badge.
  const puedeVerEntregas = hasFuncion('logistica.consola.ver');
  // Pestañas por función (Épica #13758): cada pestaña y cada carga inicial exige la función que la sirve.
  const puedeVerTramites = hasFuncion('logistica.consola.ver');
  const puedeListarActas = hasFuncion('logistica.actas.listar');
  const puedeFiltrar = hasFuncion('logistica.consola.filtrar');

  const [tabSel, setTab] = useState<Tab | null>(null);
  // Pestañas cuyo endpoint respondió 403 con la página abierta: se quitan de la barra.
  const [perdidas, setPerdidas] = useState<ReadonlySet<Tab>>(() => new Set());
  const [avisoPerdida, setAvisoPerdida] = useState(false);
  const [viajesDesactualizados, setViajesDesactualizados] = useState(false);
  const perder = (...tabs: Tab[]) => {
    setPerdidas((prev) => new Set([...prev, ...tabs]));
    setAvisoPerdida(true);
  };
  const [data, setData] = useState<Listado | null>(null);
  const [falloTramites, setFalloTramites] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  const [tramitesDesactualizados, setTramitesDesactualizados] = useState(false);
  const [actas, setActas] = useState<ActaFila[] | null>(null);
  const [falloActas, setFalloActas] = useState(false);
  const [actasDesactualizadas, setActasDesactualizadas] = useState(false);
  const [facetas, setFacetas] = useState<Facetas | null>(null);
  const [facetasCarga, setFacetasCarga] = useState<CargaFacetas>('cargando');
  const [busy, setBusy] = useState(false);

  const [buscar, setBuscar] = useState('');
  const [buscarDebounced, setBuscarDebounced] = useState('');
  const [estadosSel, setEstadosSel] = useState<string[]>([]);
  const [empresaSel, setEmpresaSel] = useState('');

  const [detalle, setDetalle] = useState<TramiteDetalle | null>(null);
  const [motivoModal, setMotivoModal] = useState<{ tipo: 'novedad' | 'devolucion'; id: string; trasladoId?: string; llave?: string } | null>(null);
  const [errorMotivo, setErrorMotivo] = useState<string | null>(null);
  const [despacharActa, setDespacharActa] = useState<ActaFila | null>(null);
  const [llegadaFlit, setLlegadaFlit] = useState<ActaFila | null>(null);
  const [actaDetalle, setActaDetalle] = useState<ActaDetalle | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setBuscarDebounced(buscar), DEBOUNCE_BUSCAR_MS);
    return () => window.clearTimeout(t);
  }, [buscar]);

  // El último pedido manda: una respuesta vieja no pisa la lista de los filtros de ahora.
  const pedidoTramites = useRef(0);
  const hayTramites = useRef(false);
  const cargarTramites = () => {
    if (!puedeVerTramites) return;
    const id = ++pedidoTramites.current;
    setRefrescando(true);
    setFalloTramites(false);
    const cuerpo: BuscarLogisticaCuerpo = {};
    if (buscarDebounced.trim()) cuerpo.buscar = buscarDebounced.trim();
    if (estadosSel.length) cuerpo.estados = estadosSel;
    if (empresaSel) cuerpo.empresas = [empresaSel];
    api.post<Listado>('/flito/logistica/buscar', cuerpo)
      .then((r) => {
        if (id !== pedidoTramites.current) return;
        hayTramites.current = true;
        setData(r); setTramitesDesactualizados(false); setRefrescando(false);
      })
      .catch((e: unknown) => {
        if (id !== pedidoTramites.current) return;
        setRefrescando(false);
        if (e instanceof ApiError && e.status === 403) { perder('tramites', 'entregas'); return; }
        if (hayTramites.current) setTramitesDesactualizados(true);
        else setFalloTramites(true);
      });
  };
  const hayActas = useRef(false);
  const cargarActas = () => {
    if (!puedeListarActas) return;
    setFalloActas(false);
    api.get<ActaFila[]>('/flito/logistica/actas')
      .then((r) => { hayActas.current = true; setActas(r); setActasDesactualizadas(false); })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 403) { perder('actas'); return; }
        if (hayActas.current) setActasDesactualizadas(true);
        else setFalloActas(true);
      });
  };
  const cargar = () => { cargarTramites(); cargarActas(); };
  useEffect(cargarTramites, [buscarDebounced, estadosSel, empresaSel, puedeVerTramites]);
  useEffect(cargarActas, [puedeListarActas]);

  const hayFacetas = useRef(false);
  const pideFacetas = puedeFiltrar || puedeRegistrarViaje;
  const recargarFacetas = (silencioso = false) => {
    if (!pideFacetas) { setFacetas(null); setFacetasCarga('ok'); return Promise.resolve(); }
    if (!silencioso) setFacetasCarga('cargando');
    return api.get<Facetas>('/flito/logistica/facetas')
      .then((f) => { hayFacetas.current = true; setFacetas(f); setFacetasCarga('ok'); setViajesDesactualizados(false); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) perder('viajes-cliente');
        // Refresco silencioso fallido: lo que se ve no se borra; aviso en la pestaña.
        if (silencioso && hayFacetas.current && !(e instanceof ApiError && e.status === 403)) { setViajesDesactualizados(true); return; }
        hayFacetas.current = false;
        setFacetas(null);
        setFacetasCarga(e instanceof ApiError && e.status === 403 ? 'error403' : 'error');
      });
  };
  useEffect(() => { void recargarFacetas(); }, [pideFacetas]);

  const confirmarMotivo = async (motivo: string) => {
    if (!motivoModal) return;
    setBusy(true); setErrorMotivo(null);
    try {
      if (motivoModal.tipo === 'novedad') await api.post(`/flito/logistica/documentos/${motivoModal.id}/novedad`, { motivo });
      else if (motivoModal.trasladoId) await api.post(`/flito/logistica/traslados/${motivoModal.trasladoId}/devolucion`, { motivo }, { 'Idempotency-Key': motivoModal.llave ?? nuevaKey() });
      else await api.post(`/flito/logistica/actas/${motivoModal.id}/devolucion`, { motivo });
      setMotivoModal(null);
      cargar(); void recargarFacetas();
    } catch (e) {
      setErrorMotivo(mensajeEscrituraLogistica(e));
      if (esRechazoDeAlcance(e)) cargar();
    } finally { setBusy(false); }
  };

  const toggleEstado = (e: string) => setEstadosSel((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  const limpiarFiltros = () => { setBuscar(''); setBuscarDebounced(''); setEstadosSel([]); setEmpresaSel(''); };

  // Ajeno e inexistente se ven idénticos: el helper solo mira el estado HTTP. Id estable: un toast por acción.
  const avisarLectura = (m: { texto: string; reintentar: boolean; recargar: boolean }, reintento: () => void, idToast: string) => {
    toastError(m.texto, m.reintentar ? reintento : undefined, { id: idToast });
    if (m.recargar) cargar();
  };
  const verDetalle = (id: string) => {
    api.get<TramiteDetalle>(`/flito/logistica/${id}`).then(setDetalle)
      .catch((e: unknown) => avisarLectura(mensajeLecturaLogistica(e, 'tramite'), () => verDetalle(id), 'logistica-detalle'));
  };
  const verActa = (id: string) => {
    api.get<ActaDetalle>(`/flito/logistica/actas/${id}`).then(setActaDetalle)
      .catch((e: unknown) => avisarLectura(mensajeLecturaLogistica(e, 'acta'), () => verActa(id), 'logistica-detalle'));
  };
  const descargarPdf = (id: string) => {
    api.get<{ url: string }>(`/flito/logistica/actas/${id}/pdf`).then(({ url }) => { window.open(url, '_blank'); })
      .catch((e: unknown) => avisarLectura(mensajePdfLogistica(e), () => descargarPdf(id), 'logistica-pdf'));
  };

  const cerrables = facetas?.companiasCerrables ?? [];
  const registradas = cerrables.reduce((n, c) => n + c.disponibles, 0);
  const actasPendientes = (actas ?? []).filter((a) => a.estado === 'generada').length;

  const TABS_TODAS: Array<{ key: Tab; label: string; badge?: number }> = [
    ...(puedeVerTramites ? [{ key: 'tramites' as const, label: 'Trámites', badge: data?.total }] : []),
    ...(puedeRegistrarViaje ? [{ key: 'viajes-cliente' as const, label: 'Viajes', badge: registradas || undefined }] : []),
    ...(puedeVerEntregas ? [{ key: 'entregas' as const, label: 'Entregas' }] : []),
    ...(puedeListarActas ? [{ key: 'actas' as const, label: 'Actas', badge: actasPendientes || undefined }] : []),
    ...(puedeViajesAdicionales ? [{ key: 'viajes' as const, label: 'Viajes adicionales' }] : []),
    ...(puedeResolverLt ? [{ key: 'pendientes' as Tab, label: 'LT pendientes', badge: ltPend.error ? undefined : (ltPend.items?.length || undefined) }] : []),
    ...(puedeGestionarMotivos ? [{ key: 'motivos-llegada' as const, label: 'Motivos de llegada' }] : []),
  ];
  const TABS = TABS_TODAS.filter((t) => !perdidas.has(t.key));
  // Pestaña inicial = la primera visible; si la elegida desaparece (403), pasa a la primera visible.
  const tab: Tab | null = TABS.some((t) => t.key === tabSel) ? tabSel : (TABS[0]?.key ?? null);

  // Refresco silencioso al volver a Viajes o Trámites (sin esqueleto; no se borra lo ya visto).
  const montado = useRef(false);
  useEffect(() => {
    if (!montado.current) { montado.current = true; return; }
    if (tab === 'viajes-cliente') void recargarFacetas(true);
    if (tab === 'tramites') cargarTramites();
  }, [tab]);

  if (funciones === null) {
    return <div role="status" aria-busy="true" aria-label="Cargando Logística…" className="h-24 rounded-xl" style={{ background: 'var(--flit-border-soft)' }} />;
  }
  if (TABS.length === 0) return <NoAccess page="flito_logistica" />;

  const empresas = facetas?.empresas ?? [];
  const conFiltro = buscarDebounced.trim() !== '' || estadosSel.length > 0 || empresaSel !== '';

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Logística"
        subtitle={esProveedor
          ? 'Trámites, licencias y actas de su operación: de la recogida en el organismo a la entrega firmada.'
          : 'Trámites aprobados a la espera de su licencia de tránsito: de la recogida en el organismo a la entrega firmada.'}
      />

      {/* Pestañas: con una sola visible no se pinta la barra. */}
      {TABS.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b" style={{ borderColor: 'var(--flit-border-soft)' }}>
          {TABS.map((t) => {
            const activa = tab === t.key;
            return (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
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
      )}

      {avisoPerdida && (
        <FlitCard>
          <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-text)' }}>
            Ya no tiene acceso a esta sección. Vuelva a iniciar sesión si cree que es un error.
          </p>
        </FlitCard>
      )}

      {tab === 'viajes' && puedeViajesAdicionales && <ViajesMasivo />}

      {/* ── Pestaña 1: Trámites (tabla general) ── */}
      {tab === 'tramites' && (
        <TabTramites
          data={data}
          fallo={falloTramites}
          refrescando={refrescando}
          desactualizado={tramitesDesactualizados}
          onReintentar={cargarTramites}
          buscar={buscar}
          onBuscar={setBuscar}
          estados={estadosSel}
          onEstado={toggleEstado}
          empresa={empresaSel}
          onEmpresa={setEmpresaSel}
          empresas={empresas}
          // Con enlace y una sola compañía el selector no decide nada. Operaciones no pierde el suyo.
          mostrarEmpresa={!conEnlace || empresas.length > 1}
          conFiltro={conFiltro}
          onLimpiar={limpiarFiltros}
          vacio={vacioLogistica(tipoEnlace)}
          verPropietario={!esProveedor}
          verDetalle={puedeVerDocumento}
          puedeNovedad={puedeNovedad}
          onDetalle={(f: TramiteFilaLogistica) => verDetalle(f.tramiteId)}
          onNovedad={(docId) => { setErrorMotivo(null); setMotivoModal({ tipo: 'novedad', id: docId }); }}
        />
      )}

      {tab === 'viajes-cliente' && puedeRegistrarViaje && viajesDesactualizados && (
        <AvisoNoActualizado onReintentar={() => { void recargarFacetas(true); }} />
      )}
      {tab === 'viajes-cliente' && puedeRegistrarViaje && (
        <ViajesACliente
          grupos={cerrables}
          estado={facetasCarga}
          sinPrecios={esProveedor}
          onReintentar={() => { void recargarFacetas(); }}
          onRegistrado={() => { cargar(); void recargarFacetas(); }}
          onIrMotivos={puedeGestionarMotivos ? () => setTab('motivos-llegada') : undefined}
        />
      )}

      {/* ── Pestaña Entregas (HU #14125). POST solo con la pestaña activa. ── */}
      {tab === 'entregas' && puedeVerEntregas && <TabEntregas onViajeAnulado={() => { void recargarFacetas(true); }} />}

      {/* ── Pestaña 3: Actas ── */}
      {tab === 'actas' && (
        <TabActas
          actas={actas}
          fallo={falloActas}
          desactualizado={actasDesactualizadas}
          onReintentar={cargarActas}
          esProveedor={esProveedor}
          vacio={conEnlace
            ? 'Aún no hay actas. Cuando registre un viaje, su acta aparece aquí. Las de recogida están en Mi ruta › Mis recogidas.'
            : 'Aún no hay actas. Vaya a «Viajes» y registre el viaje de una compañía con LT clasificadas.'}
          permisos={permisosActas}
          onVer={(a) => verActa(a.id)}
          onDespachar={setDespacharActa}
          onDevolver={(a) => {
            setErrorMotivo(null);
            // El proveedor devuelve el viaje a FLIT por su traslado: `/actas/:id/devolucion` se lo rechaza.
            const porTraslado = esProveedor && a.punto === 'flit' && a.trasladoId;
            setMotivoModal({ tipo: 'devolucion', id: a.id, ...(porTraslado ? { trasladoId: a.trasladoId as string, llave: nuevaKey() } : {}) });
          }}
          onFirmarLlegada={setLlegadaFlit}
        />
      )}

      {/* ── Pestaña: LT pendientes de trámite (HU #14149) ── */}
      {tab === 'pendientes' && puedeResolverLt && <BandejaLtPendientes {...ltPend} />}

      {/* ── Pestaña: Motivos de llegada (HU #14120). GET al entrar, no al montar la consola. ── */}
      {tab === 'motivos-llegada' && puedeGestionarMotivos && <TabMotivosLlegada />}

      {detalle && <DetalleModal doc={detalle} onClose={() => setDetalle(null)} />}
      {actaDetalle && <ActaDetalleModal detalle={actaDetalle} onClose={() => setActaDetalle(null)} onPdf={puedePdf ? () => descargarPdf(actaDetalle.acta.id) : undefined} />}
      {motivoModal && (
        <MotivoModal tipo={motivoModal.tipo} busy={busy} error={errorMotivo} onClose={() => setMotivoModal(null)} onConfirmar={(motivo) => void confirmarMotivo(motivo)} />
      )}
      {llegadaFlit?.trasladoId && (
        <LlegadaFlitModal
          actaId={llegadaFlit.id}
          companiaNombre={llegadaFlit.companiaNombre}
          trasladoId={llegadaFlit.trasladoId}
          onClose={() => setLlegadaFlit(null)}
          onListo={() => { setLlegadaFlit(null); cargar(); }}
        />
      )}
      {despacharActa && (
        <ModalDespacharActa
          acta={despacharActa}
          onClose={() => setDespacharActa(null)}
          onDespachado={() => { setDespacharActa(null); cargar(); void recargarFacetas(); }}
          onListaVieja={cargar}
        />
      )}
    </div>
  );
}
