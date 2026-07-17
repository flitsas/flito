// TRAM-TRASPASO-F2/F2.2 — paso 6 «Documentos, identidad y firma».
// Backup prod 2026-06-10: cierre de gestión (enviar a validación STT) + solo lectura dual-actor.

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  ESTADO_STT_LABEL,
  transicionesDesde,
  traspasoGestionCerrada,
  type TramiteEstadoStt,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import { TRASPASO_DOC_TYPES } from '../../constants/tramite';
import ChecklistTipologia from './ChecklistTipologia';
import FlitUploadBox from '../../components/flit/FlitUploadBox';
import GradientButton from '../../components/flit/GradientButton';
import FirmaPanel, { type Firma } from './FirmaPanel';
import TraspasoStepIdentidad from './TraspasoStepIdentidad';
import TraspasoPaso6Guia, { PASO6_ANCHORS } from './TraspasoPaso6Guia';
import { useTramiteDocUpload } from './useTramiteDocUpload';

interface DocsGenerados { contratoAt?: string; improntasAt?: string; furAt?: string; improntasHash?: string }
interface Parte { nombre: string; documento: string; email: string; telefono?: string }

interface Props {
  tramiteId: number;
  tipologiaCodigo: string | null;
  checklistEstado: Record<string, boolean>;
  organismoCodigo?: string | null;
  docsGenerados?: DocsGenerados;
  vendedor?: Parte;
  comprador?: Parte;
  vin?: string;
  org?: { orgNombre?: string; orgCiudad?: string; orgCodigo?: string };
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onPazSalvoUploaded?: () => Promise<void>;
  /** Estado STT del trámite (radicado | subsanacion | en_validacion | …). */
  estado?: string;
  /** FUR ya generado/persistido en BD (columna fur_generado). */
  furGenerado?: boolean;
  /** Transición STT en curso (deshabilita botones de flujo). */
  sttBusy?: boolean;
  /** Gestión CEA cerrada → expediente en solo lectura. */
  soloLectura?: boolean;
  /** PATCH /tramites/:id/estado — el backend valida 409 biometria_gate. */
  onTransicionStt?: (estado: string) => void | Promise<void>;
}

const CARD = 'rounded-[12px] border p-4';
const cardStyle: React.CSSProperties = { borderColor: 'var(--flit-border-soft)' };

export default function TraspasoStepDocumentos({
  tramiteId, tipologiaCodigo, checklistEstado, organismoCodigo, docsGenerados,
  vendedor, comprador, vin, org, onPatch, onPazSalvoUploaded,
  estado, furGenerado, sttBusy, soloLectura, onTransicionStt,
}: Props) {
  const [tipologia, setTipologia] = useState<string | null>(tipologiaCodigo);
  const [checklist, setChecklist] = useState<Record<string, boolean>>(checklistEstado || {});
  const [contratoAt, setContratoAt] = useState<string | undefined>(docsGenerados?.contratoAt);
  const [improntasAt, setImprontasAt] = useState<string | undefined>(docsGenerados?.improntasAt);
  const [furAt, setFurAt] = useState<string | undefined>(docsGenerados?.furAt);
  const [generando, setGenerando] = useState<string | null>(null);
  // TRAM-F3: gate de generación — ambas biométricas aprobadas (paridad CEA paso 6→7).
  const [biometriaOk, setBiometriaOk] = useState(false);
  // Dual-actor: firmas electrónicas (gate de cierre de gestión STT).
  const [firmas, setFirmas] = useState<Firma[]>([]);
  const onFirmasChange = useCallback((list: Firma[]) => setFirmas(list), []);

  const { archivos, uploading, ocrResults, cargarDocs, subirDoc } = useTramiteDocUpload(tramiteId, { vin });

  useEffect(() => { cargarDocs(); }, [cargarDocs]);

  const contratoDoc = archivos.find((a) => a.tipo === 'compraventa');
  const contratoSubido = Boolean(contratoDoc);
  const hayContrato = Boolean(contratoAt) || contratoSubido;
  const docTipos = archivos.map((a) => a.tipo);

  // ---- Cierre de gestión → validación STT (dual-actor) ----
  const gestionAbierta = Boolean(estado) && !traspasoGestionCerrada(estado as string);
  const furOk = Boolean(furAt) || Boolean(furGenerado) || archivos.some((a) => a.tipo === 'fur');
  const firmaOk = (['vendedor', 'comprador'] as const)
    .every((rol) => firmas.some((f) => f.rol === rol && f.estado === 'firmada'));
  const requisitosCierre = [
    { key: 'biometria', label: 'Biométrica de vendedor y comprador aprobada', ok: biometriaOk },
    { key: 'contrato', label: 'Contrato de compraventa en expediente', ok: hayContrato },
    { key: 'fur', label: 'FUR generado', ok: furOk },
    { key: 'firma', label: 'Firma electrónica de ambas partes', ok: firmaOk },
  ];
  const cierreListo = requisitosCierre.every((r) => r.ok);
  const estadoLabel = ESTADO_STT_LABEL[estado as TramiteEstadoStt] ?? estado ?? '';
  const otrasTransiciones = estado ? transicionesDesde(estado).filter((e) => !(gestionAbierta && e === 'en_validacion')) : [];

  const orgPayload = org?.orgCodigo || organismoCodigo
    ? { orgNombre: org?.orgNombre, orgCiudad: org?.orgCiudad, orgCodigo: org?.orgCodigo || organismoCodigo }
    : org || {};

  const marcarPazSalvoChecklist = async () => {
    if (checklist.paz_salvo || soloLectura) return;
    const next = { ...checklist, paz_salvo: true };
    setChecklist(next);
    try { await onPatch({ checklistEstado: next }); } catch (e) { toast.error(errorMessage(e)); }
  };

  const cambiarTipologia = async (codigo: string) => {
    if (soloLectura) return;
    setTipologia(codigo);
    try { await onPatch({ tipologiaCodigo: codigo }); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  const toggleItem = async (itemId: string, checked: boolean) => {
    if (soloLectura) return;
    const next = { ...checklist, [itemId]: checked };
    setChecklist(next);
    try { await onPatch({ checklistEstado: next }); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  // FUR requiere biométrica (sellos). Contrato: borrador sin sellos; regenerar tras biométrica para versión firmada.
  const requiereBiometria = (kind: string) => kind === 'fur';
  const generar = async (kind: 'contrato' | 'fur' | 'improntas') => {
    if (generando || soloLectura) return;
    if (requiereBiometria(kind) && !biometriaOk) {
      toast.error('Valida la biométrica de ambas partes antes de generar el FUR');
      return;
    }
    if ((kind === 'fur' || kind === 'contrato') && !orgPayload.orgCodigo && !organismoCodigo) {
      toast.error('Selecciona el organismo de tránsito destino antes de generar documentos legales');
      return;
    }
    setGenerando(kind);
    const meta = {
      contrato: { path: 'generar-contrato', file: `Contrato_Compraventa_${tramiteId}.pdf`, label: 'Contrato de compraventa' },
      fur: { path: 'generar-fur', file: `FUR_${tramiteId}.pdf`, label: 'FUR' },
      improntas: { path: 'generar-improntas', file: `Improntas_${tramiteId}.pdf`, label: 'Improntas' },
    }[kind];
    try {
      await api.downloadPost(`/tramites/${tramiteId}/${meta.path}`, meta.file, orgPayload);
      toast.success(`${meta.label} generado y guardado en expediente`);
      const nowIso = new Date().toISOString();
      if (kind === 'contrato') setContratoAt(nowIso);
      if (kind === 'improntas') setImprontasAt(nowIso);
      if (kind === 'fur') setFurAt(nowIso);
      await cargarDocs();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setGenerando(null); }
  };

  const abrirContrato = async (modo: 'ver' | 'descargar') => {
    const nombre = `Contrato_Compraventa_${tramiteId}.pdf`;
    try {
      let blob: Blob;
      if (contratoDoc) {
        blob = await api.get<Blob>(`/tramites/${tramiteId}/documentos/${contratoDoc.id}/archivo`);
      } else {
        blob = await api.post<Blob>(`/tramites/${tramiteId}/generar-contrato`, orgPayload);
      }
      const url = URL.createObjectURL(blob);
      if (modo === 'ver') {
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = nombre;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>6. Documentos y firma</p>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Valida identidad → genera contrato y FUR → anexos → firma electrónica. Usa la guía azul para saltar a cada bloque.
        </p>
      </div>

      <TraspasoPaso6Guia
        biometriaOk={biometriaOk}
        hayContrato={hayContrato}
        furOk={furOk}
        anexosCount={archivos.length}
        firmaOk={firmaOk}
      />

      {vendedor && comprador && (
        <TraspasoStepIdentidad tramiteId={tramiteId} vendedor={vendedor} comprador={comprador} onEstadoChange={setBiometriaOk} />
      )}

      <section id={PASO6_ANCHORS.documentos} aria-label="Documentos legales" className={`${CARD} scroll-mt-24`} style={cardStyle}>
        <p className="mb-1 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>Contrato de compraventa y documentos legales</p>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          Usa los datos comerciales del paso 5 (valor Fasecolda). El PDF se guarda en el expediente y también se descarga al generarlo.
          Cláusula quinta: <strong>los gastos del traspaso y el impuesto derivado serán asumidos por el comprador.</strong>
        </p>
        {hayContrato && (
          <div className="mb-3 rounded-[10px] border p-3" style={{ borderColor: 'rgba(112,207,58,0.35)', background: 'rgba(112,207,58,0.08)' }}>
            <p className="text-xs font-semibold" style={{ color: 'var(--flit-success)' }}>
              Contrato de compraventa en expediente
              {contratoAt ? ` · generado ${new Date(contratoAt).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => abrirContrato('ver')}
                className="flit-focus rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
                style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}>
                Ver contrato
              </button>
              <button type="button" onClick={() => abrirContrato('descargar')}
                className="flit-focus rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
                style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}>
                Descargar PDF
              </button>
            </div>
          </div>
        )}
        {!biometriaOk && !soloLectura && (
          <p className="mb-2 rounded-[8px] px-3 py-2 text-[11px]" role="status"
            style={{ background: 'var(--flit-amber-soft, #fff7e6)', color: 'var(--flit-text-secondary)' }}>
            Puedes generar el <strong>contrato</strong> ya con el valor del paso 5. El <strong>FUR</strong> y la versión del contrato con sellos electrónicos requieren biométrica aprobada arriba.
            {' '}
            <a href="#traspaso-identidad-biometrica" className="font-semibold underline" style={{ color: 'var(--flit-blue)' }}>
              Validar identidad ↑
            </a>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {([
            { kind: 'contrato' as const, label: 'Contrato de compraventa', done: hayContrato },
            { kind: 'fur' as const, label: 'FUR', done: Boolean(furAt) },
            { kind: 'improntas' as const, label: 'Improntas', done: Boolean(improntasAt) || archivos.some((a) => a.tipo === 'impronta') },
          ]).map(({ kind, label, done }) => {
            const bloqueado = requiereBiometria(kind) && !biometriaOk;
            return (
              <button
                key={kind} type="button" onClick={() => generar(kind)} disabled={generando !== null || bloqueado || soloLectura}
                title={soloLectura ? 'Expediente bloqueado — gestión enviada a STT' : bloqueado ? 'Requiere biométrica aprobada de ambas partes' : undefined}
                className="flit-focus inline-flex items-center gap-1 rounded-[999px] border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}
              >
                {generando === kind ? 'Generando…' : (done ? `Regenerar ${label}` : `Generar ${label}`)}
                {done && <span aria-hidden>✓</span>}
              </button>
            );
          })}
        </div>
      </section>

      <div id={PASO6_ANCHORS.checklist} className="scroll-mt-24">
      <ChecklistTipologia
        tipologiaCodigo={tipologia}
        checklistEstado={checklist}
        docTipos={docTipos}
        organismoCodigo={organismoCodigo}
        tramiteId={tramiteId}
        readOnly={soloLectura}
        onChangeTipologia={cambiarTipologia}
        onToggleItem={toggleItem}
      />
      </div>

      <section id={PASO6_ANCHORS.anexos} aria-label="Anexos del traspaso" className={`${CARD} scroll-mt-24`} style={cardStyle}>
        <p className="mb-2 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>Anexos del expediente</p>
        <p className="mb-3 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          Sube SOAT, impronta escaneada o cédulas. Los ítems del checklist se marcan automáticamente al cargar el documento correcto.
        </p>
        {soloLectura && (
          <p className="mb-3 rounded-[8px] px-3 py-2 text-[11px] font-semibold" role="status"
            style={{ background: 'var(--flit-blue-soft)', color: 'var(--flit-blue-text)' }}>
            Expediente bloqueado — gestión enviada a STT. Los anexos quedan en solo consulta.
          </p>
        )}
        <div
          className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${soloLectura ? 'pointer-events-none opacity-60' : ''}`}
          aria-disabled={soloLectura || undefined}
        >
          {TRASPASO_DOC_TYPES.map((dt) => {
            const uploaded = archivos.filter((a) => a.tipo === dt.key);
            const isUploading = uploading[dt.key] || false;
            const ocrResult = ocrResults[dt.key];
            const rejected = ocrResult?._rechazado;
            const verified = uploaded.length > 0 && (!ocrResult || !rejected);
            const boxState = isUploading ? 'uploading' : rejected ? 'rejected' : verified ? 'verified' : 'idle';
            return (
              <FlitUploadBox
                key={dt.key}
                label={dt.label}
                state={boxState}
                count={uploaded.length}
                onFile={async (f) => {
                  if (isUploading || soloLectura) return;
                  await subirDoc(dt.key, f);
                  if (dt.key === 'paz_salvo') {
                    await marcarPazSalvoChecklist();
                    await onPazSalvoUploaded?.();
                  }
                }}
              />
            );
          })}
        </div>
      </section>

      <div id={PASO6_ANCHORS.firma} className="scroll-mt-24">
      <FirmaPanel
        tramiteId={tramiteId}
        disabled={!hayContrato || soloLectura}
        disabledHint={soloLectura
          ? 'Expediente bloqueado — la gestión ya fue enviada a STT.'
          : 'Genera o sube el contrato de compraventa antes de solicitar la firma.'}
        onFirmasChange={onFirmasChange}
      />
      </div>

      {/* Dual-actor: cierre de gestión CEA → validación STT / botones de flujo del operador. */}
      {estado && onTransicionStt && (
        <section id={PASO6_ANCHORS.stt} aria-label="Flujo del trámite STT" className={`${CARD} scroll-mt-24`} style={cardStyle}>
          <p className="mb-1 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>
            Cierre de gestión y flujo STT
          </p>
          <p className="mb-3 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
            Expediente STT en <strong>{estadoLabel}</strong>.
            {gestionAbierta
              ? ' Completa el checklist de abajo y envía la gestión a validación STT.'
              : ' La gestión CEA está cerrada; el avance del trámite lo controla el organismo de tránsito.'}
          </p>
          {gestionAbierta && (
            <>
              <ul className="mb-3 flex flex-col gap-1.5">
                {requisitosCierre.map((r) => (
                  <li key={r.key} className="flex items-center gap-2 text-xs"
                    style={{ color: r.ok ? 'var(--flit-success)' : 'var(--flit-text-muted)' }}>
                    <span className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold"
                      style={{ background: r.ok ? 'var(--flit-success)' : 'var(--flit-border-soft)', color: r.ok ? 'white' : 'var(--flit-text-muted)' }}
                      aria-hidden>
                      {r.ok ? '✓' : '·'}
                    </span>
                    {r.label}
                    {!r.ok && <span className="text-[10px]">(pendiente)</span>}
                  </li>
                ))}
              </ul>
              <GradientButton
                type="button"
                onClick={() => onTransicionStt('en_validacion')}
                disabled={Boolean(sttBusy) || !cierreListo}
                aria-disabled={Boolean(sttBusy) || !cierreListo}
                title={cierreListo ? undefined : 'Completa biométrica, contrato, FUR y firma antes de enviar'}
              >
                {sttBusy ? 'Enviando…' : 'Enviar a validación STT'}
              </GradientButton>
              <p className="mt-2 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
                Al enviar, la gestión CEA se cierra (solo lectura) y el traspaso pasa a validación STT.
                Si el organismo pide correcciones, volverá como Subsanación.
              </p>
            </>
          )}
          {otrasTransiciones.length > 0 && (
            <div className="mt-3">
              <p className="mb-2 text-[11px] font-semibold uppercase" style={{ color: 'var(--flit-text-muted)' }}>
                {gestionAbierta ? 'Otras transiciones (operador)' : 'Flujo del trámite (operador)'}
              </p>
              <div className="flex flex-wrap gap-2">
                {otrasTransiciones.map((e) => (
                  <button key={e} type="button" onClick={() => onTransicionStt(e)} disabled={sttBusy}
                    className="flit-focus rounded-[999px] px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    style={{ color: 'var(--flit-blue)', background: 'rgba(79, 116, 201, 0.12)' }}>
                    {ESTADO_STT_LABEL[e]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
