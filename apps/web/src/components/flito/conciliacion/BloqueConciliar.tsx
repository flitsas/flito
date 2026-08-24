// FLITO Conciliación — el bloque que decide (HU #11680, AC4).
//
// Es el punto de no retorno de la pantalla: al confirmar sale el dinero de la bolsa del cliente y de
// la de tránsito, y **no vuelve** ni aunque el trámite cambie de estado (CF-07). De ahí las tres
// reglas de este componente:
//
//   · **No hay conciliación parcial** (RN-02): basta una línea que no cuadre para que el botón entero
//     se bloquee. Media boleta conciliada obligaría a llevar dos verdades sobre el mismo pago.
//   · **El botón bloqueado usa `aria-disabled`, no `disabled`.** Un `<button disabled>` no recibe
//     foco, así que su nombre accesible es inalcanzable con teclado o lector: poner ahí un
//     `aria-label` bonito cumpliría el AC4 de mentirijillas. Enfocable, con el motivo en el nombre,
//     y un clic que no dispara ninguna petición: lleva el foco al texto que explica por qué.
//   · **El 409 `boleta_incompleta` se distingue por `codigo` y no por el número.** Los tres rechazos
//     de negocio de `conciliar` son 409 y necesitan textos distintos; un `if (status === 409)` que
//     asuma «ya conciliada» pintaría el mensaje equivocado en el caso más caro de los tres.

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BoletaDetalleDto, ConciliacionRealizadaDto } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import { pesos } from '../../../lib/bolsas';
import { codigoDe, extraDe, nombreBotonBloqueado, textoBloqueante } from '../../../lib/conciliacion';
import FlitModal from '../../flit/FlitModal';
import {
  FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';

interface Props {
  boleta: BoletaDetalleDto;
  /** El cuadre de hoy, cuando el servidor lo devuelve dentro de un rechazo: la tabla se repinta. */
  onCuadreActualizado: (boleta: BoletaDetalleDto) => void;
  onConciliada: (resultado: ConciliacionRealizadaDto) => void;
  /**
   * Dónde devolver el foco al cerrar el diálogo. Tras conciliar, el botón que lo abrió **ya no
   * existe**: sin este respaldo el foco se caería a `<body>`.
   */
  focoDeRespaldo: RefObject<HTMLElement | null>;
}

export default function BloqueConciliar(
  { boleta, onCuadreActualizado, onConciliada, focoDeRespaldo }: Props,
) {
  const [confirmando, setConfirmando] = useState(false);
  const [enVuelo, setEnVuelo] = useState(false);
  const [aviso, setAviso] = useState<{ titulo: string; detalle: string } | null>(null);
  const bloqueanteRef = useRef<HTMLParagraphElement>(null);
  const avisoRef = useRef<HTMLDivElement>(null);

  const bloqueado = boleta.sinCuadrar > 0;

  // El rechazo llega después de un clic y cambia la tabla que hay debajo: el foco va al aviso, que
  // es donde está la única pregunta que tiene quien acaba de pulsar un botón que mueve dinero.
  useEffect(() => { if (aviso) avisoRef.current?.focus(); }, [aviso]);

  async function conciliar(): Promise<void> {
    if (enVuelo) return;
    setEnVuelo(true);
    setAviso(null);
    try {
      const resultado = await api.post<ConciliacionRealizadaDto>(
        `/flito/conciliacion/boletas/${boleta.id}/conciliar`, {},
      );
      setConfirmando(false);
      onConciliada(resultado);
    } catch (e) {
      setConfirmando(false);
      setAviso(avisoDelRechazo(e, onCuadreActualizado));
    } finally {
      setEnVuelo(false);
    }
  }

  return (
    <>
      <FlitCard>
        <div className="space-y-3">
          {aviso && (
            <div
              ref={avisoRef}
              role="alert"
              tabIndex={-1}
              className="rounded-[12px] p-3 outline-none"
              style={{ background: '#FDE8E3', color: 'var(--flit-warning-ink)' }}
            >
              <p className="text-sm font-semibold">{aviso.titulo}</p>
              <p className="text-sm">{aviso.detalle}</p>
            </div>
          )}

          {bloqueado && (
            <p
              ref={bloqueanteRef}
              id="conciliar-bloqueante"
              tabIndex={-1}
              className="text-sm outline-none"
              style={{ color: 'var(--flit-danger-ink)' }}
            >
              {textoBloqueante(boleta.filas, boleta.sinCuadrar)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={flitBtnPrimary}
              style={{ ...flitBtnPrimaryStyle, opacity: bloqueado ? 0.5 : 1 }}
              aria-disabled={bloqueado}
              aria-label={bloqueado ? nombreBotonBloqueado(boleta.filas, boleta.sinCuadrar) : undefined}
              aria-describedby={bloqueado ? 'conciliar-bloqueante' : undefined}
              // Bloqueado, el clic NO dispara ninguna petición: lleva el foco al motivo, que es la
              // única acción útil que queda.
              onClick={() => (bloqueado ? bloqueanteRef.current?.focus() : setConfirmando(true))}
            >
              Conciliar boleta
            </button>
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Total de la boleta: <strong className="tabular-nums">{pesos(boleta.totalDeclarado)}</strong>
              {' · '}Suma de los SOAT que cruzaron:{' '}
              <strong className="tabular-nums">
                {boleta.totalCruzado === null ? 'todavía sin calcular' : pesos(boleta.totalCruzado)}
              </strong>
            </p>
          </div>

          {bloqueado && (
            <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Faltan líneas por cruzar, así que todavía no se puede comparar el total.
            </p>
          )}
        </div>
      </FlitCard>

      {confirmando && (
        <FlitModal
          title={`Conciliar ${boleta.referencia}`}
          // A mitad de una transacción que mueve dinero, el diálogo no se cierra: ni con Esc, ni con
          // clic fuera. Cerrarlo dejaría al usuario sin saber si el dinero salió o no.
          onClose={enVuelo ? () => undefined : () => setConfirmando(false)}
          restoreFocusRef={focoDeRespaldo}
          wide
        >
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
              Vas a conciliar <strong>{boleta.filas === 1 ? '1 SOAT' : `${boleta.filas} SOAT`}</strong> de{' '}
              <strong>{boleta.companiaNombre ?? 'este cliente'}</strong> por{' '}
              <strong className="tabular-nums">{pesos(boleta.totalCruzado ?? boleta.totalDeclarado)}</strong>.
            </p>
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              Al confirmar, ese valor sale de la bolsa del cliente y de la bolsa de tránsito.{' '}
              <strong style={{ color: 'var(--flit-danger-ink)' }}>No se puede deshacer</strong>: si más
              adelante el trámite cambia de estado, el dinero no vuelve.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                disabled={enVuelo} onClick={() => setConfirmando(false)}
              >
                Cancelar
              </button>
              {/* El botón dice el VERBO, no «Aceptar»: es lo último que se lee antes de mover dinero. */}
              <button
                type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                disabled={enVuelo} onClick={conciliar}
              >
                {enVuelo ? 'Conciliando…' : 'Sí, conciliar'}
              </button>
            </div>
          </div>
        </FlitModal>
      )}
    </>
  );
}

/**
 * Traduce el rechazo de `conciliar` y, si trae el cuadre de hoy, lo entrega para repintar la tabla.
 *
 * «No se descontó nada» no es una frase tranquilizadora de relleno: es la única pregunta que tiene
 * quien acaba de pulsar un botón que mueve dinero.
 */
function avisoDelRechazo(
  e: unknown, onCuadreActualizado: (b: BoletaDetalleDto) => void,
): { titulo: string; detalle: string } {
  const codigo = codigoDe(e);
  if (codigo === 'boleta_incompleta') {
    const boleta = extraDe<BoletaDetalleDto>(e, 'boleta');
    const sinCuadrar = extraDe<number>(e, 'sinCuadrar') ?? boleta?.sinCuadrar ?? 0;
    // La tabla se repinta con las líneas que trae el 409, no con las que había en pantalla.
    if (boleta) onCuadreActualizado(boleta);
    return {
      titulo: sinCuadrar === 1
        ? 'La boleta cambió desde que la cargaste: ahora hay 1 línea que no cuadra.'
        : `La boleta cambió desde que la cargaste: ahora hay ${sinCuadrar} líneas que no cuadran.`,
      detalle: 'No se descontó nada. Revisa la tabla, que ya está actualizada.',
    };
  }
  if (codigo === 'boleta_ya_conciliada') {
    return {
      titulo: 'Esta boleta ya estaba conciliada.',
      detalle: 'Su dinero salió de la bolsa una sola vez. Vuelve a abrirla para ver el resultado.',
    };
  }
  if (codigo === 'boleta_descartada') {
    return {
      titulo: 'Esta boleta está descartada.',
      detalle: 'No se descontó nada. Vuelve a cargar el archivo si la necesitas.',
    };
  }
  return { titulo: 'No se pudo conciliar la boleta.', detalle: errorMessage(e) };
}
