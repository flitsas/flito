// FLITO — detalle de un comprobante (HU #12612, Feature #12605): visor a la izquierda, lo leído a
// la derecha, en SOLO LECTURA. Sin Asociar / Aplicar / Descartar: eso llega con #12606 y aquí no
// existen ni apagados (UX §7.8: ausentes, no `disabled`).
//
// Lo único que hace es «Releer» sobre un pendiente `ocr_no_disponible` (C-L5): vuelve a pedir la
// lectura y repinta campos y motivo. Nunca pinta `extraccion` cruda: solo `campos[]` con el nivel de
// confianza que calcula el servidor (D11: el front no deriva alta/media/baja de un número).

import { useCallback, useEffect, useState, type RefObject } from 'react';
import {
  CodigoErrorComprobante, MOTIVO_PENDIENTE_COMPROBANTE_LABEL, MotivoPendienteComprobante,
  TIPO_DOCUMENTO_COMPROBANTE_LABEL, type ComprobanteDetalleDto,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { RUTA_COMPROBANTES, chipConfianza, labelCampo, textoCarga, textoPaginas } from '../../lib/comprobantes';
import FlitModal from '../flit/FlitModal';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import VisorPdf from '../flit/VisorPdf';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';

const TONO_ESTADO: Record<ComprobanteDetalleDto['estado'], ChipTone> = { pendiente: 'warning', aplicado: 'success', descartado: 'neutral' };
const ROTULO_ESTADO: Record<ComprobanteDetalleDto['estado'], string> = { pendiente: 'Pendiente', aplicado: 'Aplicado', descartado: 'Descartado' };

const COPY_SIN_LECTURA = 'FLITO no pudo leer este documento.';
const COPY_RELEER_503 = 'El lector sigue sin estar disponible. Inténtalo más tarde.';
const COPY_SIN_ARCHIVO = 'Tu usuario no puede abrir el archivo. Pídele a un administrador la función “Abrir el archivo de un comprobante”.';

type Archivo = { url: string; esPdf: boolean };

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
      setArchivo({ url: objectUrl, esPdf: blob.type.includes('pdf') });
    }).catch((e) => { if (vivo) setError(errorMessage(e)); });
    return () => { vivo = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, habilitado, nonce]);
  return { archivo, error, reintentar: () => setNonce((n) => n + 1) };
}

export default function DetalleComprobante({ id, onClose, onColaActualizada, restoreFocusRef }: {
  id: string;
  onClose: () => void;
  /** Tras releer con éxito, o al pulsar «Actualizar la cola» en un 404: la página refresca y anuncia. */
  onColaActualizada: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { hasFuncion } = useAuth();
  const [detalle, setDetalle] = useState<ComprobanteDetalleDto | null>(null);
  const [error, setError] = useState<{ texto: string; noExiste: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [releyendo, setReleyendo] = useState(false);
  const [errorReleer, setErrorReleer] = useState<string | null>(null);
  const puedeAbrirArchivo = hasFuncion('comprobantes.archivo.descargar');
  const { archivo, error: errorArchivo, reintentar: reintentarArchivo } = useArchivoComprobante(id, puedeAbrirArchivo);

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
      setDetalle(d);
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
            ) : !archivo || !detalle ? (
              <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando el documento…</div>
            ) : archivo.esPdf ? (
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

        <section aria-label="Lectura" className="min-h-0 overflow-auto text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          {error ? (
            <div className="space-y-3">
              <p role="alert" className="text-red-600">{error.noExiste ? error.texto : `No se pudo abrir el comprobante. ${error.texto}`}</p>
              {error.noExiste
                ? <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => { onColaActualizada(); onClose(); }}>Actualizar la cola</button>
                : <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setNonce((n) => n + 1)}>Reintentar</button>}
            </div>
          ) : !detalle ? (
            <div className="animate-pulse space-y-3 motion-reduce:animate-none" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-4 rounded" style={{ background: 'var(--flit-border-soft)', width: i < 3 ? '60%' : '100%' }} />)}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={TONO_ESTADO[detalle.estado]}>{ROTULO_ESTADO[detalle.estado]}</StatusChip>
                  {detalle.motivoPendiente && <span>{detalle.detallePendiente ?? MOTIVO_PENDIENTE_COMPROBANTE_LABEL[detalle.motivoPendiente]}</span>}
                </p>
                <p>{textoCarga(detalle)}</p>
                <p className="flex flex-wrap items-center gap-2">
                  <span>Leído: {detalle.tipoDocumento ? TIPO_DOCUMENTO_COMPROBANTE_LABEL[detalle.tipoDocumento] : 'sin identificar'}</span>
                  <StatusChip tone={chipTipo.tono}>{chipTipo.texto}</StatusChip>
                </p>
              </div>

              {sinLectura && (
                <div className="space-y-2">
                  <p style={{ color: 'var(--flit-text-primary)' }}>{COPY_SIN_LECTURA}</p>
                  {puedeReleer && (
                    <div className="flex flex-wrap items-center gap-3">
                      <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={releyendo} onClick={releer}>Releer</button>
                      <span role="status" aria-live="polite" className="text-xs">{releyendo ? 'Releyendo…' : ''}</span>
                    </div>
                  )}
                  {errorReleer && <p role="alert" className="text-red-600">{errorReleer}</p>}
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
    </FlitModal>
  );
}
