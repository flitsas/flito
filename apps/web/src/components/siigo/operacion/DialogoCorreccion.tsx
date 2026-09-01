// AC5, segunda acción — «registrar una corrección exige motivo y no se confirma sin él».
//
// Esto **NO corrige la factura en Siigo**: registra en FLITO una corrección que ya se hizo allá. Es
// la única salida de un rechazo de la DIAN, porque ese documento EXISTE ante la autoridad y existirá
// siempre: reintentarlo emitiría un segundo documento y darlo por perdido sugeriría que desaparece
// (el servidor responde 409 a las dos cosas sobre `fuente: 'dian'`).
//
// **Quién decide qué es admisible es el servidor**, no esta pantalla: `GET /correcciones/factura/:id`
// devuelve las opciones con su `admisible` y su `motivo`, y una opción no admisible se pinta
// inhabilitada CON SU MOTIVO al lado, no se oculta: saber por qué no se puede anular es información.
//
// **`motivo` sigue siendo texto libre de 10 a 1000 caracteres, porque así está el contrato**, y la
// tabla es append-only. La pantalla no puede cerrarlo sin romperlo; lo que sí hace es el aviso de
// datos personales, el contador y la frase «explica QUÉ se hizo, no a quién». Queda anotado como
// deuda: el mismo argumento de Ley 1581 que cerró el catálogo del descarte aplica aquí.

import { useCallback, useEffect, useId, useState, type RefObject } from 'react';
import {
  SIIGO_CORRECCION_MOTIVO_MAX, SIIGO_CORRECCION_MOTIVO_MIN, SIIGO_CORRECCION_TIPO_ETIQUETA,
} from '@operaciones/shared-types';
import type {
  SiigoBandejaItem, SiigoCorreccionRegistrada, SiigoCorreccionTipo, SiigoEvaluacionCorreccion,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
  flitBtnSecondarySm,
} from '../../flit/flitPageKit';
import { inputCls } from '../estilos';
import { etiquetaCaso } from './tipos';

interface Props {
  caso: SiigoBandejaItem;
  onCerrar: () => void;
  onHecho: (registrada: SiigoCorreccionRegistrada) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

function hoyEnIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DialogoCorreccion({ caso, onCerrar, onHecho, restoreFocusRef }: Props) {
  const [evaluacion, setEvaluacion] = useState<SiigoEvaluacionCorreccion | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorEval, setErrorEval] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  const [tipo, setTipo] = useState<SiigoCorreccionTipo | null>(null);
  const [documento, setDocumento] = useState('');
  const [motivo, setMotivo] = useState('');
  const [fechaCorreccion, setFechaCorreccion] = useState(hoyEnIso);
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [tocado, setTocado] = useState(false);

  const idBase = useId();
  const idDoc = `${idBase}-doc`;
  const idMotivo = `${idBase}-motivo`;
  const idMotivoAyuda = `${idBase}-motivo-ayuda`;
  const idFecha = `${idBase}-fecha`;

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setErrorEval(null);
    api.get<SiigoEvaluacionCorreccion>(`/siigo/correcciones/factura/${caso.facturaId}`).then((e) => {
      if (!vivo) return;
      setEvaluacion(e);
      setCargando(false);
    }).catch((e) => {
      if (!vivo) return;
      setErrorEval(errorMessage(e));
      setEvaluacion(null);
      setCargando(false);
    });
    return () => { vivo = false; };
  }, [caso.facturaId, recarga]);

  const reintentar = useCallback(() => setRecarga((n) => n + 1), []);

  const documentoOk = documento.trim().length >= 1 && documento.trim().length <= 100;
  const motivoOk = motivo.trim().length >= SIIGO_CORRECCION_MOTIVO_MIN
    && motivo.trim().length <= SIIGO_CORRECCION_MOTIVO_MAX;
  const listo = tipo !== null && documentoOk && motivoOk;

  const enviar = async () => {
    setTocado(true);
    if (!listo) return;
    setEnviando(true);
    setErrorEnvio(null);
    try {
      const r = await api.post<SiigoCorreccionRegistrada>(
        `/siigo/correcciones/factura/${caso.facturaId}`,
        {
          tipo, documentoSiigo: documento.trim(), motivo: motivo.trim(), fechaCorreccion,
        },
      );
      onHecho(r);
    } catch (e) {
      // 409 `no_corregible` y 409 `duplicada` se quedan DENTRO del diálogo, sin cerrarlo y sin
      // perder lo escrito: quien acaba de teclear mil caracteres no tiene por qué repetirlos.
      setErrorEnvio(errorMessage(e));
      setEnviando(false);
    }
  };

  return (
    <FlitModal
      title={`Registrar una corrección · ${etiquetaCaso(caso)}`}
      onClose={onCerrar}
      wide
      restoreFocusRef={restoreFocusRef}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          Esto <strong>no</strong> corrige la factura en Siigo: registra en FLITO una corrección que
          ya se hizo allá. El registro no se puede editar ni borrar.
        </p>

        {cargando && (
          <p role="status" className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Comprobando qué se puede registrar…
          </p>
        )}

        {!cargando && errorEval && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              No se pudo comprobar qué correcciones admite esta factura: {errorEval}
            </p>
            <button type="button" onClick={reintentar} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
              Volver a comprobarlo
            </button>
          </div>
        )}

        {/* Vacío HONESTO: no se pinta un formulario que el servidor va a rechazar entero. */}
        {!cargando && !errorEval && evaluacion && !evaluacion.puedeCorregirse && (
          <p className="rounded-[10px] px-4 py-3 text-sm" style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-primary)' }}>
            Aquí no hay ningún documento que corregir. {evaluacion.viaTexto}
          </p>
        )}

        {!cargando && !errorEval && evaluacion?.puedeCorregirse && (
          <>
            {evaluacion.yaCorregida && (
              <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                Esta factura ya tiene una corrección registrada.
              </p>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Qué se hizo (obligatorio)
              </legend>
              {evaluacion.opciones.map((o) => (
                <label
                  key={o.tipo}
                  className="flex items-start gap-2 text-sm"
                  style={{ color: o.admisible ? 'var(--flit-text-primary)' : 'var(--flit-text-secondary)' }}
                >
                  <input
                    type="radio"
                    name="tipo-correccion"
                    className="flit-focus mt-0.5"
                    value={o.tipo}
                    disabled={!o.admisible}
                    checked={tipo === o.tipo}
                    onChange={() => setTipo(o.tipo)}
                  />
                  <span>
                    {SIIGO_CORRECCION_TIPO_ETIQUETA[o.tipo]}
                    {/* Una exclusión sin motivo no es una respuesta: el porqué va al lado, visible. */}
                    {!o.admisible && (
                      <span style={{ color: 'var(--flit-text-secondary)' }}>
                        {' '}<span aria-hidden="true">⊘</span> no aplica: {o.motivo}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={idDoc} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  Documento en Siigo (obligatorio)
                </label>
                <input
                  id={idDoc}
                  className={inputCls}
                  value={documento}
                  maxLength={100}
                  aria-invalid={tocado && !documentoOk}
                  onChange={(e) => setDocumento(e.target.value)}
                />
                {tocado && !documentoOk && (
                  <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
                    Escribe el número con el que se puede comprobar en Siigo Nube.
                  </p>
                )}
              </div>
              <div>
                <label htmlFor={idFecha} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                  Fecha en que se hizo
                </label>
                <input
                  id={idFecha}
                  type="date"
                  className={inputCls}
                  value={fechaCorreccion}
                  max={hoyEnIso()}
                  onChange={(e) => setFechaCorreccion(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label htmlFor={idMotivo} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
                Motivo (obligatorio, mínimo {SIIGO_CORRECCION_MOTIVO_MIN} caracteres)
              </label>
              <textarea
                id={idMotivo}
                className={inputCls}
                rows={3}
                maxLength={SIIGO_CORRECCION_MOTIVO_MAX}
                value={motivo}
                aria-invalid={tocado && !motivoOk}
                aria-describedby={idMotivoAyuda}
                onChange={(e) => setMotivo(e.target.value)}
              />
              {/* El mismo `id` sirve de ayuda y de error: es el patrón del visor de comparendos. */}
              <p
                id={idMotivoAyuda}
                role={tocado && !motivoOk ? 'alert' : undefined}
                className="mt-1 text-xs"
                style={{ color: tocado && !motivoOk ? 'var(--flit-danger-ink)' : 'var(--flit-text-secondary)' }}
              >
                {tocado && !motivoOk
                  ? `El motivo necesita al menos ${SIIGO_CORRECCION_MOTIVO_MIN} caracteres.`
                  : 'Explica QUÉ se hizo y por qué, no a quién. Nombres, cédulas, NIT, teléfonos y correos quedan grabados para siempre.'}
                {' '}{motivo.trim().length}/{SIIGO_CORRECCION_MOTIVO_MAX}
              </p>
            </div>

            {errorEnvio && (
              <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{errorEnvio}</p>
            )}
          </>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCerrar} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
            {evaluacion?.puedeCorregirse ? 'Cancelar' : 'Cerrar'}
          </button>
          {evaluacion?.puedeCorregirse && (
            <button
              type="button"
              onClick={enviar}
              disabled={enviando}
              className={flitBtnPrimary}
              style={flitBtnPrimaryStyle}
            >
              {enviando ? 'Registrando…' : 'Registrar la corrección'}
            </button>
          )}
        </div>
      </div>
    </FlitModal>
  );
}
