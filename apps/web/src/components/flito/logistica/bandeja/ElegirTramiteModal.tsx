// HU #14149 — Diálogo de dos pasos: 1) elegir candidato, 2) confirmar. Un solo FlitModal.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../../../../lib/api';
import FlitModal from '../../../flit/FlitModal';
import { FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../../flit/flitPageKit';
import ChipFirma from './ChipFirma';
import { COPY, codigoDeError, fechaCorta, fechaHora, type CandidatoLt, type PendienteLt } from './tipos';

export interface ResultadoModal {
  /** `ok`: asignada; `cierra`: LT ya no existe/pendiente (refrescar + toast de error). */
  tipo: 'ok' | 'cierra' | 'cancelar';
  texto?: string;
}

const ROT = 'text-xs';
const mutedStyle = { color: 'var(--flit-text-muted)' } as const;

function Dato({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return <div><span className={ROT} style={mutedStyle}>{rotulo}</span><div className="text-sm font-medium">{children}</div></div>;
}

function Alerta({ children, onReintentar }: { children: React.ReactNode; onReintentar?: () => void }) {
  return (
    <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
      style={{ borderColor: 'var(--flit-danger-ink)', color: 'var(--flit-danger-ink)', background: 'var(--flit-bg-card)' }}>
      <span>{children}</span>
      {onReintentar && <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>}
    </div>
  );
}

export default function ElegirTramiteModal({ lt, restoreFocusRef, onTerminar }: {
  lt: PendienteLt; restoreFocusRef: RefObject<HTMLElement | null>; onTerminar: (r: ResultadoModal) => void;
}) {
  const [paso, setPaso] = useState<1 | 2>(1);
  const [candidatos, setCandidatos] = useState<CandidatoLt[] | null>(null);
  const [errorCarga, setErrorCarga] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [alerta, setAlerta] = useState<string | null>(null);
  const [errorEnvio, setErrorEnvio] = useState(false);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const terminarRef = useRef(onTerminar);
  terminarRef.current = onTerminar;

  const cargar = useCallback(async (conservarAlerta = false) => {
    setErrorCarga(false); setCandidatos(null); setSel(null);
    if (!conservarAlerta) setAlerta(null);
    try {
      const r = await api.get<{ candidatos: CandidatoLt[] }>(`/flito/logistica/documentos/${lt.documentoId}/candidatos-tramite`);
      setCandidatos(r.candidatos);
    } catch (e) {
      const c = codigoDeError(e);
      if (c === 'LT_NO_PENDIENTE' || c === 'LT_NO_ENCONTRADA') terminarRef.current({ tipo: 'cierra', texto: COPY[c] });
      else setErrorCarga(true);
    }
  }, [lt.documentoId]);
  useEffect(() => { void cargar(); }, [cargar]);
  useEffect(() => { tituloRef.current?.focus(); }, [paso]);

  const elegido = candidatos?.find((c) => c.tramiteId === sel) ?? null;

  const asignar = async () => {
    if (!elegido || enviando) return;
    setEnviando(true); setAlerta(null); setErrorEnvio(false);
    try {
      await api.post(`/flito/logistica/documentos/${lt.documentoId}/resolver-tramite`, { tramiteId: elegido.tramiteId });
      const frase = lt.firmada ? 'Entró a su acta de organismo con la firma ya capturada.' : 'Entrará al acta cuando el organismo firme.';
      onTerminar({ tipo: 'ok', texto: `LT de ${lt.placa ?? 'la placa'} asignada al trámite ${elegido.idFlit} de ${(elegido.companiaNombre ?? 'la compañía').replace(/\.$/, '')}. ${frase}` });
    } catch (e) {
      const c = codigoDeError(e);
      setEnviando(false);
      if (c === 'LT_NO_PENDIENTE' || c === 'LT_NO_ENCONTRADA') onTerminar({ tipo: 'cierra', texto: COPY[c] });
      else if (c === 'TRAMITE_NO_CANDIDATO' || c === 'TRAMITE_YA_TIENE_LT') { setPaso(1); setAlerta(COPY[c]); void cargar(true); }
      else { setAlerta(COPY.GENERICO); setErrorEnvio(true); }
    }
  };

  const resumen = (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <Dato rotulo="Placa"><span className="tabular-nums">{lt.placa ?? '—'}</span></Dato>
      <Dato rotulo="Organismo">{lt.organismoCodigo}</Dato>
      <Dato rotulo="Recogió">{lt.recogidoPorNombre ?? '—'} · {fechaHora(lt.recogidoEn)}</Dato>
      <Dato rotulo="Firma"><ChipFirma firmada={lt.firmada} /></Dato>
    </div>
  );

  const titulo = paso === 1 ? `Elegir trámite · ${lt.placa ?? ''}` : `Confirmar trámite · ${lt.placa ?? ''}`;
  const sinCandidatos = candidatos !== null && candidatos.length === 0;

  return (
    <FlitModal title={titulo} onClose={() => onTerminar({ tipo: 'cancelar' })} cierreBloqueado={enviando} restoreFocusRef={restoreFocusRef}>
      <h3 ref={tituloRef} tabIndex={-1} className="sr-only">{titulo}</h3>
      {resumen}
      <hr className="my-3 border-0 border-t" style={{ borderColor: 'var(--flit-border-soft)' }} />

      {paso === 1 && (
        <>
          {errorCarga && <Alerta onReintentar={() => void cargar()}>No pudimos cargar los trámites de esta LT. Inténtalo de nuevo.</Alerta>}
          {alerta && <Alerta>{alerta}</Alerta>}
          {candidatos === null && !errorCarga && (
            <div aria-busy="true" aria-label="Cargando trámites" className="mt-2 space-y-2">
              {[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-lg" style={{ background: 'var(--flit-border-soft)' }} />)}
            </div>
          )}
          {sinCandidatos && (
            <>
              <FlitEmpty>Aún no hay trámites aprobados de este vehículo para elegir.<br /><span className="text-xs">Cuando haya uno, podrás elegirlo aquí.</span></FlitEmpty>
              <div className="mt-4 flex justify-end">
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => onTerminar({ tipo: 'cancelar' })}>Cerrar</button>
              </div>
            </>
          )}
          {candidatos && candidatos.length > 0 && (
            <>
              <fieldset className="mt-2 space-y-2 border-0 p-0">
                <legend className="mb-2 text-sm font-semibold">¿A cuál trámite pertenece esta LT?</legend>
                {candidatos.map((c) => {
                  const activo = sel === c.tramiteId;
                  const aprob = fechaCorta(c.fechaAprobacion);
                  return (
                    <label key={c.tramiteId}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-[var(--flit-bg-hover)] has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-[var(--flit-border-focus)]"
                      style={{ borderColor: activo ? 'var(--flit-blue-text)' : 'var(--flit-border-input)', boxShadow: activo ? 'inset 0 0 0 1px var(--flit-blue-text)' : undefined, background: activo ? 'var(--flit-bg-app)' : undefined }}>
                      <input type="radio" name="candidato-lt" className="mt-1" checked={activo} onChange={() => setSel(c.tramiteId)} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{c.companiaNombre ?? 'Compañía sin nombre'}</span>
                        <span className="block text-sm"><span className="tabular-nums">Trámite {c.idFlit}</span>{c.tipoTramite ? ` · ${c.tipoTramite}` : ''}</span>
                        <span className="block text-xs" style={mutedStyle}>{c.organismoCodigo ?? lt.organismoCodigo}{aprob ? ` · Aprobado ${aprob}` : ''}</span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              <p className="mt-3 text-xs" style={mutedStyle}>
                {elegido ? 'Elige con cuidado: después de asignarla, la LT sigue con esa compañía.' : 'Elige un trámite para continuar.'}
              </p>
              <div className="mt-4 flex flex-col-reverse justify-end gap-2 sm:flex-row">
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => onTerminar({ tipo: 'cancelar' })}>Cancelar</button>
                <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!elegido} onClick={() => { setAlerta(null); setPaso(2); }}>Continuar</button>
              </div>
            </>
          )}
        </>
      )}

      {paso === 2 && elegido && (
        <>
          <p className="text-sm">Vas a asignar esta LT a:</p>
          <p className="mt-1 text-sm font-semibold">{elegido.companiaNombre ?? 'Compañía sin nombre'}</p>
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Trámite <span className="tabular-nums">{elegido.idFlit}</span>{elegido.tipoTramite ? ` · ${elegido.tipoTramite}` : ''}
            {fechaCorta(elegido.fechaAprobacion) ? ` · Aprobado ${fechaCorta(elegido.fechaAprobacion)}` : ''} · {elegido.organismoCodigo ?? lt.organismoCodigo}
          </p>
          <h4 className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Qué pasará con el acta</h4>
          <p className="text-sm">
            {lt.firmada
              ? `Como la LT ya tiene la firma del organismo, entrará al acta de organismo de ${elegido.companiaNombre ?? 'la compañía'} con esa misma firma. No se pide otra.`
              : 'La LT quedará con esta compañía. Aún no tiene firma del organismo: entrará al acta cuando se capture.'}
          </p>
          <p className="mt-2 text-sm">Desde ahora la LT puede tener viaje y cobro de esa compañía.</p>
          {alerta && <Alerta onReintentar={errorEnvio ? () => void asignar() : undefined}>{alerta}</Alerta>}
          <div className="mt-4 flex flex-col-reverse justify-end gap-2 sm:flex-row">
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando} onClick={() => { setAlerta(null); setPaso(1); }}>Volver</button>
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={enviando} onClick={() => void asignar()}>
              {enviando ? 'Asignando…' : 'Asignar trámite'}
            </button>
          </div>
        </>
      )}
    </FlitModal>
  );
}
