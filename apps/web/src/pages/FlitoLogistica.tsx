// FLITO Logística (Fase 1) — consola de Operaciones. Trazabilidad por documento (CA-07), recogida,
// clasificación automática, cierre de lote → acta, despacho, entrega y devolución. La PWA del
// mensajero (offline, escaneo, firma) es la Fase 2. Ojo: el "entregado" de logística es el documento
// físico en manos del cliente, distinto del "Entregado" de la compuerta SOAT+Impuestos (§9.7).

import { useEffect, useState } from 'react';
import { EstadoDocumentoLogistica } from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { puedeOperar } from '../lib/permissions';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitEmpty, FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle,
  flitBtnSecondary, flitBtnSecondaryStyle, FlitPillGroup, FlitPillButton,
} from '../components/flit/flitPageKit';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

interface DocumentoFila {
  id: string; tramiteId: string; idFlit: string; tipo: string; tipoLabel: string; estado: string; estadoLabel: string;
  organismoCodigo: string; organismoNombre: string | null; companiaId: number | null; companiaNombre: string | null; companiaNit: string | null;
  placa: string | null; vin: string | null; identificador: string | null; actaId: string | null; motivo: string | null; creadoEn: string; actualizadoEn: string;
}
interface EventoDocumento { id: string; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; lat: string | null; lng: string | null; motivo: string | null; origen: string; creadoEn: string }
interface DocumentoDetalle extends DocumentoFila { eventos: EventoDocumento[] }
interface ActaFila { id: string; companiaId: number; companiaNombre: string | null; estado: string; estadoLabel: string; mensajeroId: number | null; mensajeroNombre: string | null; documentos: number; receptorNombre: string | null; entregadoEn: string | null; creadoEn: string }
interface ActaDocumento { id: string; tipo: string; tipoLabel: string; estado: string; estadoLabel: string; placa: string | null; vin: string | null; idFlit: string }
interface ActaEvento { id: string; documentoId: string; placa: string | null; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; motivo: string | null; origen: string; creadoEn: string }
interface ActaDetalle { acta: ActaFila; tienePdf: boolean; documentos: ActaDocumento[]; bitacora: ActaEvento[] }
interface Facetas {
  estados: string[]; tipos: string[]; empresas: Array<{ nit: string; nombre: string | null }>;
  organismos: Array<{ codigo: string; nombre: string | null }>;
  companiasCerrables: Array<{ companiaId: number; nombre: string | null; disponibles: number }>;
  mensajeros: Array<{ id: number; nombre: string }>;
}
interface Listado { items: DocumentoFila[]; total: number; page: number; pageSize: number }

const ESTADO_LABEL: Record<string, string> = {
  generado: 'Generado', recogido: 'Recogido', clasificado: 'Clasificado', en_acta: 'En acta',
  despachado: 'Despachado', entregado: 'Entregado', novedad: 'Novedad', devuelto: 'Devuelto',
};
const TONO_DOC: Record<string, ChipTone> = {
  generado: 'neutral', recogido: 'active', clasificado: 'active', en_acta: 'active',
  despachado: 'warning', entregado: 'success', novedad: 'danger', devuelto: 'danger',
};
const TONO_ACTA: Record<string, ChipTone> = { generada: 'neutral', despachada: 'warning', entregada: 'success', devuelta: 'danger' };

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export default function FlitoLogistica() {
  const { user } = useAuth();
  const esOperaciones = puedeOperar(user?.role);

  const [data, setData] = useState<Listado | null>(null);
  const [actas, setActas] = useState<ActaFila[] | null>(null);
  const [facetas, setFacetas] = useState<Facetas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [buscar, setBuscar] = useState('');
  const [estadosSel, setEstadosSel] = useState<string[]>([]);
  const [empresaSel, setEmpresaSel] = useState('');

  // Modales.
  const [detalle, setDetalle] = useState<DocumentoDetalle | null>(null);
  const [cerrarOpen, setCerrarOpen] = useState(false);
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
  useEffect(() => { api.get<Facetas>('/flito/logistica/facetas').then(setFacetas).catch(() => setFacetas(null)); }, []);

  const accion = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); cargar(); api.get<Facetas>('/flito/logistica/facetas').then(setFacetas).catch(() => {}); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const toggleEstado = (e: string) => setEstadosSel((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  const verDetalle = (id: string) => api.get<DocumentoDetalle>(`/flito/logistica/${id}`).then(setDetalle).catch((e) => setError(errorMessage(e)));
  const verActa = (id: string) => api.get<ActaDetalle>(`/flito/logistica/actas/${id}`).then(setActaDetalle).catch((e) => setError(errorMessage(e)));
  const descargarPdf = async (id: string) => {
    try { const { url } = await api.get<{ url: string }>(`/flito/logistica/actas/${id}/pdf`); window.open(url, '_blank'); }
    catch (e) { setError(errorMessage(e)); }
  };

  const filas = data?.items ?? [];

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Logística"
        subtitle="Trazabilidad de licencias y placas: de la emisión del organismo a la entrega firmada."
        actions={esOperaciones && (
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCerrarOpen(true)}>Cerrar lote</button>
        )}
      />

      {/* Filtros */}
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
            {(facetas?.estados ?? Object.values(EstadoDocumentoLogistica)).map((e) => (
              <FlitPillButton key={e} active={estadosSel.includes(e)} onClick={() => toggleEstado(e)}>{ESTADO_LABEL[e] ?? e}</FlitPillButton>
            ))}
          </FlitPillGroup>
        </div>
      </FlitCard>

      {error && <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>}

      {data && filas.length === 0 && (
        <FlitCard><FlitEmpty>No hay documentos de logística. Sincroniza desde FLIT: al aprobarse un trámite, sus licencias y placas aparecen aquí en «Generado».</FlitEmpty></FlitCard>
      )}

      {filas.length > 0 && (
        <FlitCard>
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Documento</FlitTh><FlitTh>Trámite FLIT</FlitTh><FlitTh>Empresa</FlitTh>
                <FlitTh>Organismo</FlitTh><FlitTh>Estado</FlitTh><FlitTh>Acciones</FlitTh>
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <FlitTr key={f.id}>
                  <td className="px-4 py-2">
                    <div className="text-sm font-medium">{f.tipoLabel}</div>
                    <div className="text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.placa ?? f.vin ?? '—'}</div>
                  </td>
                  <td className="px-4 py-2 text-xs tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{f.idFlit}</td>
                  <td className="px-4 py-2 text-sm">{f.companiaNombre ?? f.companiaNit ?? '—'}</td>
                  <td className="px-4 py-2 text-sm">{f.organismoNombre ?? f.organismoCodigo}</td>
                  <td className="px-4 py-2">
                    <StatusChip tone={TONO_DOC[f.estado] ?? 'neutral'}>{f.estadoLabel}</StatusChip>
                    {f.motivo && <div className="mt-1 text-xs" style={{ color: 'var(--flit-danger)' }}>{f.motivo}</div>}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-2">
                      <button className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }} onClick={() => verDetalle(f.id)}>Detalle</button>
                      {esOperaciones && f.estado === EstadoDocumentoLogistica.GENERADO && (
                        <>
                          <button className="text-xs font-semibold" style={{ color: 'var(--flit-success)' }} disabled={busy}
                            onClick={() => accion(() => api.post('/flito/logistica/recoger', { documentoIds: [f.id] }))}>Recoger</button>
                          <button className="text-xs font-semibold" style={{ color: 'var(--flit-danger)' }}
                            onClick={() => setMotivoModal({ tipo: 'novedad', id: f.id })}>Novedad</button>
                        </>
                      )}
                    </div>
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        </FlitCard>
      )}

      {/* Panel de actas */}
      <FlitCard>
        <h2 className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Actas</h2>
        {(!actas || actas.length === 0) ? (
          <FlitEmpty>Aún no hay actas. Cierra el lote de una empresa con documentos clasificados para generar una.</FlitEmpty>
        ) : (
          <FlitTable>
            <thead>
              <FlitTr>
                <FlitTh>Empresa</FlitTh><FlitTh>Documentos</FlitTh><FlitTh>Mensajero</FlitTh>
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
                        <button className="text-xs font-semibold" style={{ color: 'var(--flit-blue-text)' }} onClick={() => setDespacharActa(a)}>Despachar</button>
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
        )}
      </FlitCard>

      {detalle && <DetalleModal doc={detalle} onClose={() => setDetalle(null)} />}
      {actaDetalle && <ActaDetalleModal detalle={actaDetalle} onClose={() => setActaDetalle(null)} onPdf={() => descargarPdf(actaDetalle.acta.id)} />}
      {cerrarOpen && facetas && (
        <CerrarLoteModal cerrables={facetas.companiasCerrables} busy={busy} onClose={() => setCerrarOpen(false)}
          onCerrar={(companiaId) => accion(() => api.post('/flito/logistica/cerrar-lote', { companiaId })).then(() => setCerrarOpen(false))} />
      )}
      {motivoModal && (
        <MotivoModal tipo={motivoModal.tipo} busy={busy} onClose={() => setMotivoModal(null)}
          onConfirmar={(motivo) => accion(() => motivoModal.tipo === 'novedad'
            ? api.post(`/flito/logistica/documentos/${motivoModal.id}/novedad`, { motivo })
            : api.post(`/flito/logistica/actas/${motivoModal.id}/devolucion`, { motivo })).then(() => setMotivoModal(null))} />
      )}
      {despacharActa && facetas && (
        <DespacharModal mensajeros={facetas.mensajeros} busy={busy} onClose={() => setDespacharActa(null)}
          onDespachar={(mensajeroId) => accion(() => api.post(`/flito/logistica/actas/${despacharActa.id}/despachar`, { mensajeroId })).then(() => setDespacharActa(null))} />
      )}
    </div>
  );
}

function DetalleModal({ doc, onClose }: { doc: DocumentoDetalle; onClose: () => void }) {
  return (
    <FlitModal title={`${doc.tipoLabel} · ${doc.placa ?? doc.vin ?? ''}`} onClose={onClose} wide>
      <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Trámite FLIT</span><div>{doc.idFlit}</div></div>
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Empresa</span><div>{doc.companiaNombre ?? doc.companiaNit ?? '—'}</div></div>
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Organismo</span><div>{doc.organismoNombre ?? doc.organismoCodigo}</div></div>
        <div><span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Estado</span><div><StatusChip tone={TONO_DOC[doc.estado] ?? 'neutral'}>{doc.estadoLabel}</StatusChip></div></div>
      </div>
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Bitácora</h3>
      <ol className="space-y-2">
        {doc.eventos.map((e) => (
          <li key={e.id} className="text-sm">
            <span className="font-medium">{ESTADO_LABEL[e.estadoNuevo] ?? e.estadoNuevo}</span>
            <span style={{ color: 'var(--flit-text-muted)' }}> · {fecha(e.creadoEn)} · {e.actorNombre ?? (e.origen === 'api' ? 'sistema' : '—')}</span>
            {e.motivo && <div className="text-xs" style={{ color: 'var(--flit-danger)' }}>{e.motivo}</div>}
            {(e.lat && e.lng) && <div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>📍 {e.lat}, {e.lng}</div>}
          </li>
        ))}
      </ol>
    </FlitModal>
  );
}

function ActaDetalleModal({ detalle, onClose, onPdf }: { detalle: ActaDetalle; onClose: () => void; onPdf: () => void }) {
  const { acta, documentos, bitacora } = detalle;
  return (
    <FlitModal title={`Acta · ${acta.companiaNombre ?? ''}`} onClose={onClose} wide>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <StatusChip tone={TONO_ACTA[acta.estado] ?? 'neutral'}>{acta.estadoLabel}</StatusChip>
          <span className="ml-2" style={{ color: 'var(--flit-text-muted)' }}>
            {acta.documentos} documento(s) · {acta.mensajeroNombre ? `Mensajero: ${acta.mensajeroNombre}` : 'Sin despachar'}
          </span>
        </div>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onPdf}>Descargar PDF</button>
      </div>

      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Documentos</h3>
      <ul className="mb-4 space-y-1">
        {documentos.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
            <span>{d.tipoLabel} · <span className="tabular-nums">{d.placa ?? d.vin ?? '—'}</span> <span style={{ color: 'var(--flit-text-muted)' }}>({d.idFlit})</span></span>
            <StatusChip tone={TONO_DOC[d.estado] ?? 'neutral'}>{d.estadoLabel}</StatusChip>
          </li>
        ))}
      </ul>

      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Bitácora del despacho</h3>
      <ol className="space-y-2">
        {bitacora.map((e) => (
          <li key={e.id} className="text-sm">
            <span className="tabular-nums">{e.placa ?? '—'}</span>
            <span className="ml-1 font-medium">{ESTADO_LABEL[e.estadoNuevo] ?? e.estadoNuevo}</span>
            <span style={{ color: 'var(--flit-text-muted)' }}> · {fecha(e.creadoEn)} · {e.actorNombre ?? (e.origen === 'api' ? 'sistema' : '—')}</span>
            {e.motivo && <div className="text-xs" style={{ color: 'var(--flit-danger)' }}>{e.motivo}</div>}
          </li>
        ))}
      </ol>
    </FlitModal>
  );
}

function CerrarLoteModal({ cerrables, busy, onClose, onCerrar }: { cerrables: Facetas['companiasCerrables']; busy: boolean; onClose: () => void; onCerrar: (companiaId: number) => void }) {
  return (
    <FlitModal title="Cerrar lote → generar acta" onClose={onClose}>
      {cerrables.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>No hay empresas con documentos clasificados. Recoge y clasifica documentos primero.</p>
      ) : (
        <ul className="space-y-2">
          {cerrables.map((c) => (
            <li key={c.companiaId} className="flex items-center justify-between gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <div><div className="text-sm font-medium">{c.nombre ?? `#${c.companiaId}`}</div><div className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{c.disponibles} clasificado(s)</div></div>
              <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={busy} onClick={() => onCerrar(c.companiaId)}>Generar acta</button>
            </li>
          ))}
        </ul>
      )}
    </FlitModal>
  );
}

function MotivoModal({ tipo, busy, onClose, onConfirmar }: { tipo: 'novedad' | 'devolucion'; busy: boolean; onClose: () => void; onConfirmar: (motivo: string) => void }) {
  const [motivo, setMotivo] = useState('');
  const titulo = tipo === 'novedad' ? 'Reportar novedad' : 'Registrar devolución';
  return (
    <FlitModal title={titulo} onClose={onClose}>
      <FlitField label="Motivo (obligatorio)">
        <textarea className={flitInp} rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={tipo === 'novedad' ? 'Faltante, dañado o inconsistente…' : 'Receptor ausente o rechazó…'} />
      </FlitField>
      <div className="mt-4 flex justify-end gap-2">
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={busy || !motivo.trim()} onClick={() => onConfirmar(motivo.trim())}>Confirmar</button>
      </div>
    </FlitModal>
  );
}

function DespacharModal({ mensajeros, busy, onClose, onDespachar }: { mensajeros: Facetas['mensajeros']; busy: boolean; onClose: () => void; onDespachar: (mensajeroId: number) => void }) {
  const [sel, setSel] = useState('');
  return (
    <FlitModal title="Despachar acta" onClose={onClose}>
      <FlitField label="Mensajero">
        <select className={flitInp} value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">Selecciona…</option>
          {mensajeros.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
        </select>
      </FlitField>
      {mensajeros.length === 0 && <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>No hay mensajeros registrados. Crea un usuario con rol Mensajero.</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={busy || !sel} onClick={() => onDespachar(Number(sel))}>Despachar</button>
      </div>
    </FlitModal>
  );
}

