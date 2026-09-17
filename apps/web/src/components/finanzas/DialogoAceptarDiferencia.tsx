// Reporte de costos — el modal «Aceptar diferencia» (HU #12655, AC5; slim §4).
//
// Qué hace: deja constancia de que el valor del comprobante, aunque no cuadre con la tarifa (o el
// catálogo), es correcto. NO cambia el valor ni el sello (D-37): el servidor solo firma quién, cuándo
// y por qué. Por eso la intro lo dice antes del campo, y por eso el botón vive también en filas
// selladas.
//
// Con dos o tres diferencias pendientes en la misma fila (D-35): una línea por concepto con su
// casilla marcada, UN motivo, y un POST por comprobante EN SECUENCIA. Si el segundo falla, el modal
// no cierra: la primera línea pasa a «Aceptada» sin casilla y bajo la fallida queda su error.
//
// Análogo del mismo público: `siigo/operacion/DialogoDescartar` (motivo obligatorio, primaria
// apagada explicada por una región `role="status"` que se monta siempre y solo cambia de texto).

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ApiError, errorMessage } from '../../lib/api';
import { aceptarDiferencia } from '../../lib/comprobantes';
import {
  avisoAceptadas, lineaModal, MOTIVO_DIFERENCIA_MAX, MOTIVO_DIFERENCIA_MIN, motivoDiferenciaValido, NOMBRE_CONCEPTO,
  pendientesDe, ROTULO_ACEPTANDO, ROTULO_ACEPTAR, tituloModalAceptar, valorDocumentalDe, type ConceptoDocumental,
} from '../../lib/diferenciaDocumental';
import FlitModal from '../flit/FlitModal';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../flit/flitPageKit';
import type { Fila } from './tiposReporteCostos';

interface Props {
  fila: Fila;
  onCerrar: () => void;
  /** Todos los POST en 200: la página avisa y refresca (`refrescar()`, no `ejecutar()`: la selección sigue). */
  onHecho: (aviso: string) => void;
  /** Un 409/404 en alguna línea: la fila cambió bajo el modal; la página refresca de fondo. */
  onDesactualizado: () => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

type EstadoLinea = 'pendiente' | 'aceptada';

/** Qué decir DESPUÉS de `errorMessage(e)`, por código (slim §4). El texto del servidor va delante. */
function sufijoDe(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 409 || status === 404) return ' La fila se actualizó.';
  if (status === 403) return ' Vuelve a entrar para actualizar tus permisos.';
  return '';
}

export default function DialogoAceptarDiferencia({ fila, onCerrar, onHecho, onDesactualizado, restoreFocusRef }: Props) {
  // Las pendientes se leen UNA vez al abrir: la fila viva puede cambiar bajo el modal (refresco de
  // fondo tras un 409) y las líneas no deben desaparecer mientras se decide.
  const [lineas] = useState<ConceptoDocumental[]>(() => pendientesDe(fila));
  const [marcadas, setMarcadas] = useState<Set<ConceptoDocumental>>(() => new Set(lineas));
  const [estado, setEstado] = useState<Map<ConceptoDocumental, EstadoLinea>>(new Map());
  const [errores, setErrores] = useState<Map<ConceptoDocumental, string>>(new Map());
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sinPermiso, setSinPermiso] = useState(false);
  const idMotivo = useId();
  const idAyuda = `${idMotivo}-ayuda`;
  const idExigencia = `${idMotivo}-exigencia`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Foco al abrir: el textarea (§4). `useFocusTrap` del kit enfoca el primer control; aquí el
  // primero puede ser una casilla, y lo que hay que escribir es el motivo.
  useEffect(() => { textareaRef.current?.focus(); }, []);

  const conCasillas = lineas.length > 1;
  const porAceptar = lineas.filter((c) => estado.get(c) !== 'aceptada' && (!conCasillas || marcadas.has(c)));
  const quedanPendientes = lineas.some((c) => estado.get(c) !== 'aceptada');
  const motivoOk = motivoDiferenciaValido(motivo);
  const puedeEnviar = motivoOk && porAceptar.length > 0 && !enviando && !sinPermiso;

  const exigencia = !quedanPendientes
    ? 'No queda nada por aceptar. Cierra el diálogo.'
    : porAceptar.length === 0
      ? 'Marca al menos una diferencia para poder aceptar.'
      : motivoOk ? 'Motivo listo: ya se puede aceptar.' : 'Escribe el motivo para poder aceptar.';

  const enviar = async () => {
    if (!puedeEnviar) return;
    setEnviando(true);
    setError(null);
    setErrores(new Map());
    const aceptadas: ConceptoDocumental[] = [];
    let desactualizado = false;
    try {
      // En secuencia, no en paralelo: un 403 en la primera no debe disparar dos más.
      for (const c of porAceptar) {
        const vd = valorDocumentalDe(fila, c);
        if (!vd) continue;
        try {
          await aceptarDiferencia(vd.comprobanteId, motivo.trim());
          aceptadas.push(c);
          setEstado((m) => new Map(m).set(c, 'aceptada'));
        } catch (e) {
          const status = e instanceof ApiError ? e.status : 0;
          const texto = `${errorMessage(e)}${sufijoDe(e)}`;
          if (status === 409 || status === 404) {
            // Ya aceptada o el comprobante cambió: esa línea deja de ofrecerse y la fila se relee.
            setEstado((m) => new Map(m).set(c, 'aceptada'));
            desactualizado = true;
          }
          if (status === 403) setSinPermiso(true);
          if (conCasillas) setErrores((m) => new Map(m).set(c, texto)); else setError(texto);
          if (status === 400) textareaRef.current?.focus();
          // 5xx / red: se para aquí; lo escrito se conserva y volver a pulsar reintenta.
          if (status !== 409 && status !== 404) break;
        }
      }
    } finally {
      setEnviando(false);
    }
    if (desactualizado) onDesactualizado();
    const fallidas = porAceptar.filter((c) => !aceptadas.includes(c));
    if (aceptadas.length > 0 && fallidas.length === 0 && !desactualizado) onHecho(avisoAceptadas(fila.idFlit, aceptadas));
  };

  return (
    <FlitModal title={tituloModalAceptar(fila.idFlit, fila.placa)} onClose={onCerrar} restoreFocusRef={restoreFocusRef}>
      <div className="flex flex-col gap-4" aria-busy={enviando || undefined}>
        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          El valor del comprobante se queda como está en el reporte y en la liquidación. Aceptar solo
          deja constancia de que la diferencia es correcta.
        </p>

        <ul className="flex flex-col gap-3">
          {lineas.map((c) => {
            const vd = valorDocumentalDe(fila, c);
            if (!vd) return null;
            const l = lineaModal(c, vd);
            const aceptada = estado.get(c) === 'aceptada';
            const errorLinea = errores.get(c);
            return (
              <li key={c} className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                <div className="flex items-start gap-2">
                  {conCasillas && !aceptada && (
                    <input type="checkbox" className="flit-focus mt-1" aria-label={`Aceptar ${NOMBRE_CONCEPTO[c].toLowerCase()}`}
                      checked={marcadas.has(c)} disabled={enviando}
                      onChange={(e) => setMarcadas((s) => { const n = new Set(s); if (e.target.checked) n.add(c); else n.delete(c); return n; })} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-semibold">{NOMBRE_CONCEPTO[c]}{aceptada && <span className="ml-2 text-xs font-normal" style={{ color: 'var(--flit-text-secondary)' }}>Aceptada</span>}</span>
                      <span className="tabular-nums font-semibold">{l.diferencia}</span>
                    </div>
                    <div>{l.linea1}</div>
                    {l.linea2 && <div className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{l.linea2}</div>}
                    {errorLinea && <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{errorLinea}</p>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div>
          <label htmlFor={idMotivo} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            Por qué se acepta (obligatorio)
          </label>
          <textarea id={idMotivo} ref={textareaRef} className={flitInp} rows={2} maxLength={MOTIVO_DIFERENCIA_MAX}
            value={motivo} aria-describedby={idAyuda} disabled={enviando || sinPermiso}
            onChange={(e) => setMotivo(e.target.value)} />
          <p id={idAyuda} className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <span>Entre {MOTIVO_DIFERENCIA_MIN} y {MOTIVO_DIFERENCIA_MAX} caracteres. Queda en la auditoría del comprobante. No escribas cédulas, teléfonos ni correos.</span>
            <span className="tabular-nums">{motivo.length}/{MOTIVO_DIFERENCIA_MAX}</span>
          </p>
        </div>

        {error && <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <span id={idExigencia} role="status" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{exigencia}</span>
          <button type="button" onClick={onCerrar} className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enviando}>
            Cancelar
          </button>
          <button type="button" onClick={enviar} disabled={!puedeEnviar} aria-describedby={idExigencia}
            className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
            {enviando ? ROTULO_ACEPTANDO : ROTULO_ACEPTAR}
          </button>
        </div>
      </div>
    </FlitModal>
  );
}
