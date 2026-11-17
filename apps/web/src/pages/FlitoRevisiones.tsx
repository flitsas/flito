// FLITO Revisiones OCR (Fase 6). Porta paginas/revisiones.tsx al kit flit/ + api.
// Todo documento con OCR que no superó la coincidencia cae aquí. Nada se da por válido sin que una
// persona lo confirme (RN-04/RN-05): los campos pre-llenados vienen marcados como no confiables.

import { useEffect, useId, useMemo, useState } from 'react';
import { RotateCw } from 'lucide-react';
import {
  CAMPO_DERECHO_TRAMITE_LABEL, CAMPO_FACTURA_VENTA_LABEL, CAMPO_IMPUESTO_LABEL, CAMPO_SOAT_LABEL,
  CANDIDATOS_REVISION_TEXTO_MAX, MOTIVO_CANDIDATO_YA_TIENE_DERECHO, MOTIVO_REVISION_LABEL,
  type CandidatoRevisionDto, type FlujoRevision,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  COPY_REINTENTO, mensajeReintento, normLlave, reintentarLecturaRevision, useCandidatosRevision,
} from '../lib/revisiones';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton, flitInp,
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import StatusChip from '../components/flit/StatusChip';
import FlitComboboxBuscable, { type OpcionBuscable } from '../components/flit/FlitComboboxBuscable';

type Grupo = 'soat' | 'impuestos' | 'derechos';
type CampoExtraido = { valor: string | null; confianza: number; confiable: boolean };

interface RevisionItem {
  id: string; modulo: FlujoRevision; motivo: string; detalle: string; registroId: string | null;
  placaSugerida: string | null; extraccion: Record<string, CampoExtraido | undefined>; resuelto: boolean;
  creadoEn: string; soporte: { id: string; nombreArchivo: string };
  /** BUG #14569: el trámite asociado viene en el listado; el auditor lo ve sin usar el buscador. */
  registroActual: CandidatoRevisionDto | null;
}

const ETIQUETA_MODULO: Record<FlujoRevision, string> = {
  soat: 'Comprobante SOAT', impuestos: 'Recibo de impuestos', factura_venta: 'Factura de venta',
  derechos: 'Recibo de derecho de tránsito',
};
const labelCampo = (modulo: FlujoRevision, clave: string): string => {
  const map = modulo === 'soat' ? CAMPO_SOAT_LABEL
    : modulo === 'factura_venta' ? CAMPO_FACTURA_VENTA_LABEL
    : modulo === 'derechos' ? CAMPO_DERECHO_TRAMITE_LABEL
    : CAMPO_IMPUESTO_LABEL;
  return (map as Record<string, string>)[clave] ?? clave;
};
const norm = (v: string | null | undefined) => (v ?? '').toUpperCase().replace(/[\s-]/g, '');
// Bajo lg los botones del formulario llegan a 44 px (táctil), todos a la vez: una sola altura por barra.
const TACTIL = 'min-h-[44px] lg:min-h-0';
const fechaHora = (iso: string) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

function useRevisiones(modulo: FlujoRevision, incluirResueltas: boolean, nonce: number) {
  const [data, setData] = useState<RevisionItem[]>([]);
  useEffect(() => {
    const q = new URLSearchParams({ modulo, incluirResueltas: String(incluirResueltas) });
    api.get<RevisionItem[]>(`/flito/revisiones?${q}`)
      .then((r) => setData(Array.isArray(r) ? r : []))
      .catch(() => setData([]));
  }, [modulo, incluirResueltas, nonce]);
  return data;
}

// Visor del documento: se descarga como blob (el endpoint exige token y redirige a S3 prefirmado).
function useSoporteUrl(soporteId: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!soporteId) { setUrl(null); return; }
    let objectUrl: string | null = null;
    let vivo = true;
    api.get<Blob>(`/flito/revisiones/soporte/${soporteId}/archivo`).then((blob) => {
      if (!vivo) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => setUrl(null));
    return () => { vivo = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [soporteId]);
  return url;
}

const ult6 = (v: string | null | undefined) => (v ? v.slice(-6) : '');
type OrigenEleccion = 'auto' | 'manual' | 'previo' | null;
type Aviso = { tono: 'info' | 'warning'; texto: string; accion?: { label: string; onClick: () => void } };

function chipCandidato(c: CandidatoRevisionDto): OpcionBuscable['chip'] {
  if (!c.seleccionable) return { texto: c.motivoNoSeleccionable ?? MOTIVO_CANDIDATO_YA_TIENE_DERECHO, tone: 'neutral' };
  if (c.coincide.placa && c.coincide.vin) return { texto: 'Coincide placa y VIN', tone: 'success' };
  if (c.coincide.placa) return { texto: 'Coincide placa', tone: 'success' };
  if (c.coincide.vin) return { texto: 'Coincide VIN', tone: 'success' };
  return null;
}

/** Derechos: «tipo · organismo» (sin VIN). El resto: «detalle · VIN …6». */
const detalleCandidato = (modulo: FlujoRevision, c: CandidatoRevisionDto): string | null =>
  modulo === 'derechos' ? c.detalle
    : [c.detalle, c.vin ? `VIN …${ult6(c.vin)}` : null].filter(Boolean).join(' · ') || null;

const COPY_BUSCADOR = {
  pista: 'Escribe al menos 3 caracteres de la placa, el VIN o el número FLIT para buscar el trámite.',
  cargando: 'Buscando trámites…',
  error: 'No pudimos buscar los trámites.',
  truncado: 'Hay más trámites que coinciden. Escribe más de la placa, el VIN o el número FLIT para afinar.',
  anuncio: (n: number, truncado: boolean) => (truncado ? `Hay más de ${n} trámites; afina la búsqueda` : n === 1 ? '1 trámite' : `${n} trámites`),
};

function Formulario({ revision, soloLectura, onResuelta, onActualizada }: {
  revision: RevisionItem; soloLectura: boolean; onResuelta: () => void;
  /** Reintentar lectura devolvió la revisión con la extracción nueva: la cola la reemplaza. */
  onActualizada: (r: RevisionItem) => void;
}) {
  const [valores, setValores] = useState<Record<string, string>>({});
  const [claves, setClaves] = useState<string[]>([]);
  const [motivo, setMotivo] = useState('');
  const [modo, setModo] = useState<'idle' | 'resolver' | 'descartar'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Trámite elegido: se guarda el OBJETO (no solo el id) para que la tabla de comparación no se vacíe
  // cuando la lista cambia. `origen` decide si una corrección de la placa puede moverlo (spec §85).
  // El listado ya trae el trámite asociado: es la selección inicial, sin esperar al buscador.
  const [elegido, setElegido] = useState<CandidatoRevisionDto | null>(revision.registroActual ?? null);
  const [origen, setOrigen] = useState<OrigenEleccion>(revision.registroId || revision.registroActual ? 'previo' : null);
  const [retirada, setRetirada] = useState(false);
  const [texto, setTexto] = useState('');
  const [abierto, setAbierto] = useState(false);
  const [leyendo, setLeyendo] = useState(false);
  const [confirmarReintento, setConfirmarReintento] = useState(false);
  const [avisoLectura, setAvisoLectura] = useState<{ tono: 'info' | 'error'; texto: string } | null>(null);
  const base = useId();

  const modulo = revision.modulo;
  const mostrarVin = modulo === 'soat' || modulo === 'factura_venta';
  const bloqueado = soloLectura || revision.resuelto;
  // Mientras se vuelve a leer el documento no se edita ni se envía nada.
  const inactivo = bloqueado || leyendo;

  useEffect(() => {
    const iniciales: Record<string, string> = {};
    for (const [clave, campo] of Object.entries(revision.extraccion)) if (campo?.valor) iniciales[clave] = campo.valor;
    setValores(iniciales);
    setMotivo(''); setModo('idle'); setError(null);
    api.get<string[]>(`/flito/revisiones/campos/${modulo}`).then(setClaves).catch(() => setClaves([]));
  }, [revision, modulo]);

  // Auto-filtro: lo que está AHORA en los campos (corregido o leído). El auditor no busca (403).
  const placaFiltro = valores.placa || revision.extraccion.placa?.valor || revision.placaSugerida || '';
  const vinFiltro = valores.vin || revision.extraccion.vin?.valor || '';
  const cand = useCandidatosRevision(revision.id, {
    texto, placa: placaFiltro, vin: vinFiltro, habilitado: !soloLectura, conRegistro: !!revision.registroId,
  });
  const registroId = elegido?.id ?? (origen === 'previo' ? revision.registroId ?? '' : '');

  useEffect(() => {
    if (origen === 'previo' && !elegido && cand.registroActual) setElegido(cand.registroActual);
  }, [origen, elegido, cand.registroActual]);

  // Preselección: solo sobre el auto-filtro (sin texto), nunca sobre una elección manual o previa.
  useEffect(() => {
    if (bloqueado || !cand.claveRespuesta || cand.consulta.texto) return;
    if (origen === 'manual' || origen === 'previo') return;
    const elegibles = cand.items.filter((c) => c.seleccionable);
    const unico = elegibles.length === 1 && (elegibles[0].coincide.placa || elegibles[0].coincide.vin) ? elegibles[0] : null;
    if (unico) { setElegido(unico); setOrigen('auto'); setRetirada(false); }
    else if (origen === 'auto') { setElegido(null); setOrigen(null); setRetirada(true); }
    // Se reevalúa una vez por respuesta nueva, no en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cand.claveRespuesta]);

  const elegirManual = (id: string) => {
    const c = cand.items.find((x) => x.id === id);
    if (!c || !c.seleccionable) return;
    setElegido(c); setOrigen('manual'); setRetirada(false); setTexto('');
  };
  const buscarConCampos = () => { setTexto(''); setAbierto(true); };

  let aviso: Aviso | null = null;
  if (!bloqueado && elegido && origen === 'auto') {
    aviso = {
      tono: 'info',
      texto: elegido.coincide.placa
        ? `Elegido automáticamente: es el único trámite con la placa ${elegido.placa}.`
        : `Elegido automáticamente: es el único trámite con el VIN …${ult6(elegido.vin)}.`,
      accion: { label: 'Cambiar', onClick: () => setAbierto(true) },
    };
  } else if (!bloqueado && !elegido && retirada) {
    aviso = { tono: 'info', texto: 'Cambiaste la placa y ya no hay un único trámite que coincida. Elige uno.' };
  } else if (!bloqueado && elegido) {
    const pc = normLlave(placaFiltro); const pt = normLlave(elegido.placa);
    const vc = normLlave(vinFiltro); const vt = normLlave(elegido.vin);
    if (pc && pt && pc !== pt) {
      aviso = {
        tono: 'warning',
        texto: `La placa de los campos (${pc}) no es la del trámite elegido (${pt}). Revisa cuál corresponde.`,
        accion: { label: `Buscar con ${pc}`, onClick: buscarConCampos },
      };
    } else if (mostrarVin && vc && vt && vc !== vt) {
      aviso = {
        tono: 'warning',
        texto: `El VIN de los campos (…${ult6(vc)}) no es el del trámite elegido (…${ult6(vt)}). Revisa cuál corresponde.`,
        accion: { label: `Buscar con …${ult6(vc)}`, onClick: buscarConCampos },
      };
    }
  }
  const avisoId = `${base}-aviso`;

  const { consulta } = cand;
  const encabezado = consulta.texto ? null
    : consulta.placa && consulta.vin ? `Filtrado por la placa ${consulta.placa} y el VIN del documento`
    : consulta.placa ? `Filtrado por la placa ${consulta.placa} del documento`
    : consulta.vin ? `Filtrado por el VIN …${ult6(consulta.vin)} del documento`
    : null;
  const termino = consulta.texto || consulta.placa || consulta.vin;
  const opciones: OpcionBuscable[] = cand.items.map((c) => ({
    id: c.id, principal: c.idFlit ?? 'Sin N.º FLIT', secundario: c.placa ?? 'sin placa',
    detalle: detalleCandidato(modulo, c), chip: chipCandidato(c), deshabilitada: !c.seleccionable,
  }));
  const etiquetaSeleccion = elegido
    ? `${elegido.etiqueta}${elegido.detalle ? ` · ${elegido.detalle}` : ''}`
    : bloqueado ? 'Sin trámite asociado' : null;

  // ¿El revisor ya corrigió algún campo? Entonces reintentar le pide confirmación antes de pisarlo.
  const editado = Object.keys({ ...valores, ...revision.extraccion })
    .some((k) => (valores[k] ?? '') !== (revision.extraccion[k]?.valor ?? ''));
  const reintentar = async () => {
    setConfirmarReintento(false); setAvisoLectura(null); setLeyendo(true);
    try {
      const r = await reintentarLecturaRevision<RevisionItem>(revision.id);
      if (r.sinLectura) setAvisoLectura({ tono: 'info', texto: COPY_REINTENTO.sinLectura });
      else {
        setAvisoLectura({ tono: 'info', texto: COPY_REINTENTO.actualizada(r.camposLeidos) });
        onActualizada(r.revision);
      }
    } catch (e) { setAvisoLectura({ tono: 'error', texto: mensajeReintento(e) }); }
    finally { setLeyendo(false); }
  };

  const enviar = async () => {
    setError(null); setEnviando(true);
    try {
      if (modo === 'resolver') await api.post(`/flito/revisiones/${revision.id}/resolver`, { registroId, campos: valores, motivo });
      else await api.post(`/flito/revisiones/${revision.id}/descartar`, { motivo });
      onResuelta();
    } catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone="neutral">{ETIQUETA_MODULO[modulo]}</StatusChip>
          <StatusChip tone="warning">{MOTIVO_REVISION_LABEL[revision.motivo as keyof typeof MOTIVO_REVISION_LABEL] ?? revision.motivo}</StatusChip>
          {revision.resuelto && <StatusChip tone="success">Resuelta</StatusChip>}
        </div>
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{revision.detalle}</p>
      </div>

      <FlitField label="Trámite contra el que se concilia *" inputId={`${base}-tramite`}>
        <FlitComboboxBuscable
          id={`${base}-tramite`}
          etiquetaSeleccion={etiquetaSeleccion}
          placeholder="Selecciona el trámite…"
          seleccionadoId={elegido?.id ?? null}
          onElegir={elegirManual}
          abierto={abierto}
          onAbiertoChange={setAbierto}
          texto={texto}
          onTextoChange={setTexto}
          estado={cand.estado === 'inactivo' ? 'pista' : cand.estado}
          opciones={opciones}
          truncado={cand.truncado}
          onReintentar={cand.reintentar}
          encabezado={encabezado}
          disabled={inactivo}
          required
          describedBy={aviso ? avisoId : undefined}
          placeholderBusqueda="Placa, VIN o número FLIT"
          ariaLabelBusqueda="Buscar trámite por placa, VIN o número FLIT"
          ariaLabelLista="Trámites"
          maxLength={CANDIDATOS_REVISION_TEXTO_MAX}
          copy={{
            ...COPY_BUSCADOR,
            sinResultados: <>
              <p>No hay trámites por elegir con «{termino}».</p>
              <p>Revisa la placa o busca por el número FLIT. Si el documento no es de ningún trámite, descártalo.</p>
            </>,
          }}
        />
      </FlitField>

      {aviso && (
        <div id={avisoId} role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--flit-border-soft)', color: aviso.tono === 'warning' ? 'var(--flit-warning-ink)' : 'var(--flit-text-secondary)' }}>
          <span aria-hidden>{aviso.tono === 'warning' ? '⚠' : 'ⓘ'}</span>
          <span className="min-w-0 flex-1 basis-48">{aviso.texto}</span>
          {aviso.accion && (
            <button type="button" onClick={aviso.accion.onClick}
              className="flit-focus min-h-[44px] rounded-md px-2 text-sm font-medium underline-offset-2 transition-colors hover:bg-[color:var(--flit-bg-hover)] hover:underline lg:min-h-8"
              style={{ color: 'var(--flit-blue-text)' }}>
              {aviso.accion.label}
            </button>
          )}
        </div>
      )}

      {elegido && (
        <div className="rounded-lg border text-sm" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="grid grid-cols-[70px_1fr_1fr] gap-2 border-b px-3 py-1.5 text-xs font-semibold" style={{ color: 'var(--flit-text-muted)', borderColor: 'var(--flit-border-soft)' }}>
            <span>Campo</span><span>Trámite</span><span>Leído del PDF</span>
          </div>
          {[{ e: 'Placa', t: elegido.placa ?? '—', l: revision.extraccion.placa?.valor ?? null },
            ...(mostrarVin ? [{ e: 'VIN', t: elegido.vin ?? '—', l: revision.extraccion.vin?.valor ?? null }] : [])
          ].map((f) => {
            const cruza = f.l !== null && norm(f.t) === norm(f.l);
            return (
              <div key={f.e} className="grid grid-cols-[70px_1fr_1fr] items-center gap-2 px-3 py-1.5">
                <span style={{ color: 'var(--flit-text-muted)' }}>{f.e}</span>
                <span className="break-all font-medium tabular-nums">{f.t}</span>
                <span className="break-all" style={cruza ? undefined : { color: 'var(--flit-danger-ink)' }}>{f.l ? `${cruza ? '✓ ' : '✗ '}${f.l}` : 'No leído'}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-2">
        {claves.map((clave) => {
          const campo = revision.extraccion[clave];
          return (
            <div key={clave} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm font-medium" htmlFor={`c-${clave}`}>{labelCampo(modulo, clave)}</label>
                {/* El chip no puede decir siempre "no confiable": desde que existe el motivo
                    cruce_ambiguo, a esta cola llegan documentos con lecturas perfectamente
                    confiables cuyo problema es a QUÉ trámite pertenecen, no qué dicen. */}
                {campo
                  ? <StatusChip tone={campo.confiable ? 'success' : 'warning'}>
                      {Math.round(campo.confianza * 100)}% · {campo.confiable ? 'confiable' : 'no confiable'}
                    </StatusChip>
                  : <StatusChip tone="neutral">Sin lectura</StatusChip>}
              </div>
              <input id={`c-${clave}`} className={flitInp} disabled={inactivo}
                value={valores[clave] ?? ''} placeholder="Escribe el valor correcto"
                onChange={(e) => setValores((v) => ({ ...v, [clave]: e.target.value }))} />
            </div>
          );
        })}
      </div>

      {!soloLectura && !revision.resuelto && modo === 'idle' && (
        <div className="flex flex-wrap gap-2">
          <button className={`${flitBtnPrimary} ${TACTIL}`} style={flitBtnPrimaryStyle} disabled={!registroId || leyendo} onClick={() => setModo('resolver')}>Confirmar y resolver</button>
          <button className={`${flitBtnSecondary} ${TACTIL}`} style={flitBtnSecondaryStyle} disabled={leyendo} onClick={() => setModo('descartar')}>Descartar documento</button>
          <button type="button" className={`${flitBtnSecondary} ${TACTIL}`} style={flitBtnSecondaryStyle} disabled={leyendo || confirmarReintento}
            onClick={() => (editado ? setConfirmarReintento(true) : reintentar())}>
            <RotateCw size={16} aria-hidden />{leyendo ? 'Leyendo de nuevo…' : 'Reintentar lectura'}
          </button>
        </div>
      )}

      {confirmarReintento && !leyendo && (
        <div role="group" aria-labelledby={`${base}-confirma`} className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <p id={`${base}-confirma`} className="text-sm" style={{ color: 'var(--flit-warning-text)' }}>{COPY_REINTENTO.confirmar}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={`${flitBtnSecondary} ${TACTIL}`} style={flitBtnSecondaryStyle} onClick={reintentar}>Reintentar de todos modos</button>
            <button type="button" className={`${flitBtnSecondary} ${TACTIL}`} style={flitBtnSecondaryStyle} onClick={() => setConfirmarReintento(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {avisoLectura && !revision.resuelto && modo === 'idle' && (
        <div role="status" className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--flit-border-soft)', color: avisoLectura.tono === 'error' ? 'var(--flit-danger-text)' : 'var(--flit-text-secondary)' }}>
          {avisoLectura.texto}
        </div>
      )}

      {modo !== 'idle' && (
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <p className="text-sm font-medium">{modo === 'resolver' ? 'Deja constancia de qué validaste' : 'Motivo del descarte (mín. 5 caracteres)'}</p>
          <textarea className={`${flitInp} mt-2 min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          {error && <p className="mt-1 text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}
          <div className="mt-2 flex gap-2">
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={enviando || !motivo.trim() || (modo === 'descartar' && motivo.trim().length < 5)} onClick={enviar}>
              {enviando ? 'Enviando…' : modo === 'resolver' ? 'Resolver' : 'Descartar'}
            </button>
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => { setModo('idle'); setError(null); }}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FlitoRevisiones() {
  const { hasFuncion } = useAuth();
  const [grupo, setGrupo] = useState<Grupo>('soat');
  const [incluirResueltas, setIncluirResueltas] = useState(false);
  const [seleccionadaId, setSeleccionadaId] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  // Revisiones que «Reintentar lectura» devolvió con extracción nueva; mandan sobre la cola cargada.
  const [reemplazos, setReemplazos] = useState<Record<string, RevisionItem>>({});

  // HU #12872: solo lectura = sin la función de resolver (la guarda de `POST /:id/resolver`).
  const soloLectura = !hasFuncion('revisiones.revision.resolver');

  const rSoat = useRevisiones('soat', incluirResueltas, recarga);
  const rImp = useRevisiones('impuestos', incluirResueltas, recarga);
  const rFv = useRevisiones('factura_venta', incluirResueltas, recarga);
  const rDer = useRevisiones('derechos', incluirResueltas, recarga);

  const data = useMemo(() => {
    const base = grupo === 'soat' ? rSoat : grupo === 'derechos' ? rDer
      : [...rImp, ...rFv].sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
    return base.map((r) => reemplazos[r.id] ?? r);
  }, [grupo, rSoat, rImp, rFv, rDer, reemplazos]);
  const seleccionada = useMemo(() => data.find((r) => r.id === seleccionadaId) ?? data[0] ?? null, [data, seleccionadaId]);
  const url = useSoporteUrl(seleccionada?.soporte.id);

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Revisiones OCR"
        subtitle="Todo documento con OCR que no superó la coincidencia cae aquí. Nada se da por válido sin que alguien lo confirme."
        actions={
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={incluirResueltas} onChange={(e) => setIncluirResueltas(e.target.checked)} />
            Incluir resueltas
          </label>
        }
      />

      <FlitPillGroup>
        <FlitPillButton active={grupo === 'soat'} onClick={() => { setGrupo('soat'); setSeleccionadaId(null); }}>SOAT</FlitPillButton>
        <FlitPillButton active={grupo === 'impuestos'} onClick={() => { setGrupo('impuestos'); setSeleccionadaId(null); }}>Impuestos</FlitPillButton>
        <FlitPillButton active={grupo === 'derechos'} onClick={() => { setGrupo('derechos'); setSeleccionadaId(null); }}>Derechos de tránsito</FlitPillButton>
      </FlitPillGroup>

      {data.length === 0 ? (
        <FlitCard><FlitEmpty>No hay nada en revisión. Cuando una extracción no supere el umbral o su llave no cruce, el documento aparecerá aquí.</FlitEmpty></FlitCard>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_1fr]">
          <FlitCard>
            <p className="mb-2 text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Cola ({data.length})</p>
            <div className="space-y-1.5">
              {data.map((r) => (
                <button key={r.id} type="button" onClick={() => setSeleccionadaId(r.id)}
                  className="w-full rounded-md border p-2 text-left transition-colors hover:bg-[color:var(--flit-bg-hover)]"
                  style={{ borderColor: seleccionada?.id === r.id ? 'var(--flit-blue-text)' : 'var(--flit-border-soft)' }}>
                  <p className="truncate text-sm font-medium">{r.soporte.nombreArchivo}</p>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{ETIQUETA_MODULO[r.modulo]} · {fechaHora(r.creadoEn)}</p>
                </button>
              ))}
            </div>
          </FlitCard>

          {seleccionada && (
            <>
              <FlitCard>
                <p className="mb-2 truncate text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>{seleccionada.soporte.nombreArchivo}</p>
                {url ? <object data={url} type="application/pdf" className="h-[600px] w-full rounded-md border" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <a href={url} target="_blank" rel="noreferrer">Abrir el documento</a>
                </object> : <p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando documento…</p>}
              </FlitCard>

              <FlitCard>
                {soloLectura && <div className="mb-3 rounded-md border p-2 text-sm" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-blue-text)' }}>Solo lectura · Auditoría ve la cola y los soportes, pero no los resuelve.</div>}
                <Formulario key={seleccionada.id} revision={seleccionada} soloLectura={!!soloLectura}
                  onResuelta={() => { setSeleccionadaId(null); setReemplazos({}); setRecarga((n) => n + 1); }}
                  onActualizada={(r) => setReemplazos((m) => ({ ...m, [r.id]: r }))} />
              </FlitCard>
            </>
          )}
        </div>
      )}
    </div>
  );
}
