// FLITO — detalle de un comprobante (HU #12612 → #12634, Feature #12606): visor a la izquierda y, a
// la derecha, el panel de asociación si está PENDIENTE (`PanelAsociacion`: tres decisiones, campos
// editables, Aplicar / Adjuntar / Descartar) o la ficha en SOLO LECTURA si ya está aplicado o
// descartado (UX §7.8: sin botones, ausentes y no `disabled`).
//
// «Releer» sobre un pendiente `ocr_no_disponible` (C-L5) vuelve a pedir la lectura y repinta el
// panel entero (candidatos incluidos, slim D-14). Nunca pinta `extraccion` cruda: solo `campos[]`
// con el nivel de confianza que calcula el servidor (D11). AC8: si el archivo es PDF lo dice el
// `contentType` del DTO o la cabecera `%PDF`, nunca `blob.type`.
//
// HU #12635: la cabecera lleva el mismo chip de seis estados que la fila (`asociacionDe`) y la
// línea «Ver trámite {idFlit} ↗ · Ver soportes»; el visor de soportes se abre ENCIMA del detalle.

import { useCallback, useEffect, useState, type RefObject } from 'react';
import {
  CONCEPTO_COSTO_LABEL, CodigoErrorComprobante, MotivoPendienteComprobante,
  TIPO_DOCUMENTO_COMPROBANTE_LABEL, type ComprobanteDetalleDto, type CruceComprobante,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  ASOCIACION_COMPROBANTE_LABEL, RUTA_COMPROBANTES, TONO_ASOCIACION, abrirArchivoComprobante, asociacionDe, chipConfianza, esPdfArchivo,
  hrefVerTramite, labelCampo, pesosComprobante, textoAsociacion, textoCarga, textoPaginas,
} from '../../lib/comprobantes';
import { hasPage } from '../../lib/permissions';
import FlitModal from '../flit/FlitModal';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import VisorPdf from '../flit/VisorPdf';
import VisorSoportes from '../flit/VisorSoportes';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import PanelAsociacion from './PanelAsociacion';

const COPY_SIN_LECTURA = 'FLITO no pudo leer este documento.';
const COPY_RELEER_503 = 'El lector sigue sin estar disponible. Inténtalo más tarde.';
const COPY_SIN_ARCHIVO = 'Tu usuario no puede abrir el archivo. Pídele a un administrador la función “Abrir el archivo de un comprobante”.';

const CRUCE_LABEL: Record<CruceComprobante, string> = { id_flit: 'ID FLIT', vin: 'VIN', placa: 'placa', manual: 'asociación manual' };

type Archivo = { url: string; blob: Blob };

/** Descarga el archivo como blob (el endpoint exige token y redirige a S3 prefirmado), como Revisiones. */
function useArchivoComprobante(id: string, habilitado: boolean) {
  const [archivo, setArchivo] = useState<Archivo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!habilitado) return undefined;
    let objectUrl: string | null = null;
    let vivo = true;
    setArchivo(null); setError(null);
    api.get<Blob>(`${RUTA_COMPROBANTES}/${id}/archivo`).then((blob) => {
      if (!vivo) return;
      objectUrl = URL.createObjectURL(blob);
      setArchivo({ url: objectUrl, blob });
    }).catch((e) => { if (vivo) setError(errorMessage(e)); });
    return () => { vivo = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, habilitado, nonce]);
  return { archivo, error, reintentar: () => setNonce((n) => n + 1) };
}

export default function DetalleComprobante({ id, onClose, onColaActualizada, onResuelto, restoreFocusRef }: {
  id: string;
  onClose: () => void;
  /** Tras releer con éxito, o al pulsar «Actualizar la cola» en un 404 / `ya_resuelto`: la página refresca y anuncia. */
  onColaActualizada: () => void;
  /** Aplicado, adjuntado o descartado con éxito: la página muestra el toast, refresca y cierra. */
  onResuelto: (toast: string) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { user, hasFuncion } = useAuth();
  const [detalle, setDetalle] = useState<ComprobanteDetalleDto | null>(null);
  const [verSoportes, setVerSoportes] = useState(false);
  const [error, setError] = useState<{ texto: string; noExiste: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [version, setVersion] = useState(0);
  const [releyendo, setReleyendo] = useState(false);
  const [errorReleer, setErrorReleer] = useState<string | null>(null);
  const [esPdf, setEsPdf] = useState<boolean | null>(null);
  const [errorSoporte, setErrorSoporte] = useState<string | null>(null);
  const puedeAbrirArchivo = hasFuncion('comprobantes.archivo.descargar');
  const { archivo, error: errorArchivo, reintentar: reintentarArchivo } = useArchivoComprobante(id, puedeAbrirArchivo);
  const contentType = detalle?.archivo.contentType;

  useEffect(() => {
    if (!archivo || contentType === undefined) { setEsPdf(null); return undefined; }
    let vivo = true;
    esPdfArchivo(contentType, archivo.blob).then((v) => { if (vivo) setEsPdf(v); });
    return () => { vivo = false; };
  }, [archivo, contentType]);

  useEffect(() => {
    let vivo = true;
    setDetalle(null); setError(null);
    api.get<ComprobanteDetalleDto>(`${RUTA_COMPROBANTES}/${id}`)
      .then((d) => { if (vivo) setDetalle(d); })
      .catch((e) => {
        if (!vivo) return;
        const noExiste = e instanceof ApiError && e.status === 404;
        setError({ texto: noExiste ? 'Este comprobante ya no existe.' : errorMessage(e), noExiste });
      });
    return () => { vivo = false; };
  }, [id, nonce]);

  const releer = useCallback(async () => {
    setReleyendo(true); setErrorReleer(null);
    try {
      const d = await api.post<ComprobanteDetalleDto>(`${RUTA_COMPROBANTES}/${id}/releer`);
      setDetalle(d); setVersion((v) => v + 1);
      onColaActualizada();
    } catch (e) {
      const codigo = e instanceof ApiError ? (e.rawDetails as { codigo?: string } | null)?.codigo : undefined;
      const sigueCaido = (e instanceof ApiError && e.status === 503) || codigo === CodigoErrorComprobante.OCR_NO_DISPONIBLE;
      setErrorReleer(sigueCaido ? COPY_RELEER_503 : errorMessage(e));
    } finally {
      setReleyendo(false);
    }
  }, [id, onColaActualizada]);

  const paginas = detalle ? textoPaginas(detalle.paginas) : null;
  const titulo = detalle ? `Comprobante · ${detalle.archivo.nombre}${paginas ? ` · ${paginas}` : ''}` : 'Comprobante';
  const campoTipo = detalle?.campos.find((c) => c.campo === 'tipoDocumento');
  const chipTipo = campoTipo ? chipConfianza(campoTipo) : { texto: 'Sin lectura', tono: 'neutral' as ChipTone };
  const sinLectura = detalle?.motivoPendiente === MotivoPendienteComprobante.OCR_NO_DISPONIBLE;
  const puedeReleer = sinLectura && detalle?.estado === 'pendiente' && hasFuncion('comprobantes.comprobante.releer');
  const actualizarCola = () => { onColaActualizada(); onClose(); };
  const verSoporteAplicado = () => {
    setErrorSoporte(null);
    abrirArchivoComprobante(id, true).catch((e) => setErrorSoporte(`No se pudo abrir el soporte aplicado. ${errorMessage(e)}`));
  };
  const motivoFicha = detalle?.estado === 'aplicado' ? detalle.aplicadoMotivo : detalle?.estado === 'descartado' ? detalle.descartadoMotivo : null;
  const asociacion = detalle ? asociacionDe(detalle) : null;
  const segundoTexto = detalle ? textoAsociacion(detalle, true) : '';
  // AC3: «Ver trámite» solo con placa y con la página; «Ver soportes» solo con trámite y la función
  // (la ruta `GET /flito/tramites/:id/soportes` la exige). Sin guarda el control NO existe.
  // En un pendiente ambos apuntan a `detalle.tramite` (el cruce fijado), nunca al combobox.
  const hrefTramite = hasPage(user, 'flito_tramites') ? hrefVerTramite(detalle?.tramite ?? null) : null;
  const tramiteSoportes = detalle?.tramite && hasFuncion('tramites.tramite.ver_soportes') ? detalle.tramite : null;

  const cabecera = detalle && asociacion && (
    <>
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          <StatusChip tone={TONO_ASOCIACION[asociacion]}>{ASOCIACION_COMPROBANTE_LABEL[asociacion]}</StatusChip>
          {segundoTexto && <span>{segundoTexto}</span>}
        </p>
        <p>{textoCarga(detalle)}</p>
        <p className="flex flex-wrap items-center gap-2">
          <span>Leído: {detalle.tipoDocumento ? TIPO_DOCUMENTO_COMPROBANTE_LABEL[detalle.tipoDocumento] : 'sin identificar'}</span>
          <StatusChip tone={chipTipo.tono}>{chipTipo.texto}</StatusChip>
        </p>
        {detalle.estado === 'aplicado' && (
          <p style={{ color: 'var(--flit-text-primary)' }}>
            {[detalle.esPago ? 'Comprobante de pago' : 'Documentación', detalle.concepto ? CONCEPTO_COSTO_LABEL[detalle.concepto] : null,
              detalle.tramite?.idFlit, detalle.tramite?.placa, detalle.cruce ? `cruce por ${CRUCE_LABEL[detalle.cruce]}` : null].filter(Boolean).join(' · ')}
          </p>
        )}
        {(hrefTramite || tramiteSoportes) && (
          <p className="flex flex-wrap items-center gap-2">
            {hrefTramite && detalle.tramite && (
              <a href={hrefTramite} target="_blank" rel="noopener" className="flit-focus underline" style={{ color: 'var(--flit-blue-text)' }}>
                Ver trámite {detalle.tramite.idFlit} ↗
              </a>
            )}
            {hrefTramite && tramiteSoportes && <span aria-hidden="true" style={{ color: 'var(--flit-text-muted)' }}>·</span>}
            {tramiteSoportes && (
              <button type="button" className="flit-focus underline" style={{ color: 'var(--flit-blue-text)' }} onClick={() => setVerSoportes(true)}>
                Ver soportes
              </button>
            )}
          </p>
        )}
      </div>

      {sinLectura && (
        <div className="space-y-2">
          <p style={{ color: 'var(--flit-text-primary)' }}>{COPY_SIN_LECTURA}</p>
          {puedeReleer && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={releyendo} onClick={releer}>Releer</button>
              {releyendo && <span role="status" aria-live="polite" className="text-xs">Releyendo…</span>}
            </div>
          )}
          {errorReleer && <p role="alert" className="text-red-600">{errorReleer}</p>}
        </div>
      )}
    </>
  );

  return (
    <FlitModal title={titulo} onClose={onClose} full restoreFocusRef={restoreFocusRef}>
      <div className="grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[55fr_45fr] lg:grid-rows-[minmax(0,1fr)]" aria-busy={!detalle && !error}>
        <section aria-label="Documento" className="flex min-h-0 flex-col gap-2 max-lg:max-h-[45vh]">
          <div className="min-h-0 flex-1">
            {!puedeAbrirArchivo ? (
              <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{COPY_SIN_ARCHIVO}</p>
            ) : errorArchivo ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm">
                <p role="alert" className="text-red-600">No se pudo abrir el documento.</p>
                <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={reintentarArchivo}>Reintentar</button>
              </div>
            ) : !archivo || !detalle || esPdf === null ? (
              <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando el documento…</div>
            ) : esPdf ? (
              <VisorPdf url={archivo.url} nombre={detalle.archivo.nombre} paginaInicial={detalle.paginas?.[0]} />
            ) : (
              <div className="h-full overflow-auto rounded-md" style={{ background: 'var(--flit-border-soft)' }}>
                <img src={archivo.url} alt={detalle.archivo.nombre} className="w-full rounded-sm bg-white" />
              </div>
            )}
          </div>
          {puedeAbrirArchivo && archivo && (
            <a href={archivo.url} target="_blank" rel="noopener" className="flit-focus self-start text-sm underline" style={{ color: 'var(--flit-blue-text)' }}>
              Abrir el archivo original ↗
            </a>
          )}
        </section>

        <section aria-label="Lectura" className="flex min-h-0 flex-col text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {error ? (
            <div className="space-y-3">
              <p role="alert" className="text-red-600">{error.noExiste ? error.texto : `No se pudo abrir el comprobante. ${error.texto}`}</p>
              {error.noExiste
                ? <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={actualizarCola}>Actualizar la cola</button>
                : <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setNonce((n) => n + 1)}>Reintentar</button>}
            </div>
          ) : !detalle ? (
            <div className="animate-pulse space-y-3 motion-reduce:animate-none" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-4 rounded" style={{ background: 'var(--flit-border-soft)', width: i < 3 ? '60%' : '100%' }} />)}
            </div>
          ) : detalle.estado === 'pendiente' ? (
            <PanelAsociacion key={`${detalle.id}-${version}`} detalle={detalle} onResuelto={onResuelto} onActualizarCola={actualizarCola}>
              {cabecera}
            </PanelAsociacion>
          ) : (
            <div className="min-h-0 flex-1 space-y-4 overflow-auto">
              {cabecera}
              {detalle.estado === 'aplicado' && detalle.esPago && (
                <p className="flex items-center justify-between gap-2 border-b pb-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Valor al aplicar</span>
                  <span style={{ color: 'var(--flit-text-primary)' }}>{pesosComprobante(detalle.valor)}</span>
                </p>
              )}
              {motivoFicha && <p>Motivo: «{motivoFicha}»</p>}
              {detalle.estado === 'aplicado' && detalle.soporteAplicadoId && puedeAbrirArchivo && (
                <div className="space-y-1">
                  <button type="button" className="flit-focus text-sm underline" style={{ color: 'var(--flit-blue-text)' }} onClick={verSoporteAplicado}>
                    Ver el soporte aplicado ↗
                  </button>
                  {errorSoporte && <p role="alert" style={{ color: 'var(--flit-danger-ink)' }}>{errorSoporte}</p>}
                </div>
              )}
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Datos leídos</p>
              <dl className="space-y-2">
                {detalle.campos.map((c) => {
                  const chip = chipConfianza(c);
                  return (
                    <div key={c.campo} className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-0.5 border-b pb-2" style={{ borderColor: 'var(--flit-border-soft)' }}>
                      <dt className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{labelCampo(c.campo)}</dt>
                      <dd className="row-span-2 self-center"><StatusChip tone={chip.tono}>{chip.texto}</StatusChip></dd>
                      {/* Sin lectura = vacío. Nunca se inventa un valor (D11). */}
                      <dd className="min-h-[1.25rem] break-words" style={{ color: 'var(--flit-text-primary)' }}>{c.valor ?? ''}</dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          )}
        </section>
      </div>
      {verSoportes && tramiteSoportes && (
        <VisorSoportes ruta={`/flito/tramites/${tramiteSoportes.id}/soportes`} titulo={tramiteSoportes.idFlit} onClose={() => setVerSoportes(false)} />
      )}
    </FlitModal>
  );
}

