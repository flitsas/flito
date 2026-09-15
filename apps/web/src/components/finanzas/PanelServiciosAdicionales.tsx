// El panel de servicios adicionales de un trámite del Reporte de costos (HU #12548, Feature #12544,
// épica #12246). Diseño: `docs/ux/finanzas-reporte-costos-servicios-adicionales.md` §6.
//
// Es la única superficie donde se ve, se añade y se quita lo que FLITO le cobra a un trámite APARTE
// del trámite. Nace en la fila del reporte porque es ahí donde se decide el cobro, un instante
// antes de sellarlo. No es el catálogo (`/flito/servicios-adicionales`), no es el detalle del
// trámite y no es una bitácora: enseña lo VIVO.
//
// Tres cosas que este componente no hace, y son deliberadas:
//   · NO usa `ejecutar()` de la página. Ese pinta el error como aviso GLOBAL —contra el AC3— y
//     vacía la selección de filas marcadas para liquidar. Tras un 201 o un 204 solo llama a
//     `onCambio()` (el `refrescar()` de la página), que repide reporte, contadores y elegibilidad.
//   · NO suma nada. El `total` lo calcula el servidor; la pantalla lo pinta.
//   · NO sondea para enterarse de una liquidación ajena: el 409 de la propia escritura llega antes
//     y dice más (§12-D12).

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ServiciosAdicionalesDeTramite } from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../lib/api';
import {
  etiquetaCantidad, rutaServiciosDeTramite, tipoIdsDe, type FalloEscritura,
} from '../../lib/serviciosAdicionalesTramite';
import FlitModal from '../flit/FlitModal';
import { FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import BuscadorTipoServicio from './BuscadorTipoServicio';
import FilaServicioAdicional from './FilaServicioAdicional';
import { pesos } from './tiposReporteCostos';

const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;

/** Lo que falla al PEDIR la lista. El 403 y el 404 no se reintentan: reintentar no los arregla. */
interface ErrorCarga { mensaje: string; reintentable: boolean; tramiteIdo: boolean }

/** «Servicios adicionales · FLIT-10234 · ABC123», sin « · » colgando cuando no hay placa (QA2). */
export const tituloPanel = (idFlit: string, placa: string | null): string =>
  ['Servicios adicionales', idFlit, placa].filter((p) => p !== null && p !== '').join(' · ');

export default function PanelServiciosAdicionales({
  tramiteId, idFlit, placa, sellada, puedeAsignar, puedeQuitar, recargaPagina, onClose, onCambio, restoreFocusRef,
}: {
  tramiteId: string;
  idFlit: string;
  placa: string | null;
  /** Lo que la FILA ya sabe. El `liquidado` del GET manda sobre esto en cuanto llega. */
  sellada: boolean;
  /** `finanzas.servicios_adicionales.asignar`, resuelta con `hasFuncion` (nunca por rol). */
  puedeAsignar: boolean;
  /** `finanzas.servicios_adicionales.quitar`. */
  puedeQuitar: boolean;
  /**
   * El contador `recarga` de la página. El panel se re-lee cuando cambia, que es lo que lo devuelve
   * a EDITABLE tras reversar sin recargar la pantalla (AC5) y lo que mantiene `liquidado` honesto.
   */
  recargaPagina: number;
  onClose: () => void;
  /** El `refrescar()` de la página: reporte + contadores + elegibilidad. Nunca `ejecutar()`. */
  onCambio: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [datos, setDatos] = useState<ServiciosAdicionalesDeTramite | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<ErrorCarga | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [buscando, setBuscando] = useState(false);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [errorLinea, setErrorLinea] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState('');
  /** Un 409 `TRAMITE_LIQUIDADO` sella el panel en el acto, antes de que llegue el GET siguiente. */
  const [selladoEnCaliente, setSelladoEnCaliente] = useState(false);
  const anadirRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setErrorCarga(null);
    api.get<ServiciosAdicionalesDeTramite>(rutaServiciosDeTramite(tramiteId))
      .then((r) => { if (vivo) setDatos(r); })
      .catch((e) => {
        if (!vivo) return;
        setDatos(null);
        setErrorCarga(errorDeCarga(e));
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [tramiteId, recarga, recargaPagina]);

  const items = datos?.items ?? [];
  // El GET manda: `liquidado` es «hay liquidación sellada en cualquier estado». `sellada` de la fila
  // es el respaldo mientras el GET viaja, y el 409 es el que se adelanta a los dos.
  const soloLectura = (datos ? datos.liquidado : sellada) || selladoEnCaliente;
  const editable = !soloLectura;
  const puedeAnadir = puedeAsignar && editable;

  /**
   * El esqueleto es SOLO de la primera carga. Si cualquier recarga volviera a pintarlo, el buscador
   * y el error en línea se desmontarían con ella —y el mensaje que acaba de explicar el 409
   * desaparecería antes de leerse—. Con datos ya en la mano, la lista se queda a la vista mientras
   * llega la siguiente: es lo que hay, y en un instante será lo nuevo.
   */
  const primeraCarga = cargando && datos === null;

  const volverAlPie = () => setTimeout(() => anadirRef.current?.focus(), 0);

  const trasEscribir = (mensaje: string) => {
    setAnuncio(mensaje);
    setErrorLinea(null);
    setConfirmando(null);
    // El reporte de debajo: celda «Serv. adic.», «Servicio», «Total», el contador del botón y el
    // pie de totales. Sin `window.location.reload` (AC3, AC4).
    onCambio();
    // Y la lista del panel, que es la que tiene delante quien acaba de escribir.
    setRecarga((n) => n + 1);
  };

  const atenderFallo = (fallo: FalloEscritura) => {
    setErrorLinea(fallo.mensaje);
    setConfirmando(null);
    if (fallo.soloLectura) { setSelladoEnCaliente(true); setBuscando(false); }
    if (fallo.tramiteIdo) { setBuscando(false); setErrorCarga({ mensaje: fallo.mensaje, reintentable: false, tramiteIdo: true }); }
    if (fallo.recargarLista) setRecarga((n) => n + 1);
  };

  return (
    <FlitModal lateral title={tituloPanel(idFlit, placa)} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="flex h-full flex-col">
        {/* Una sola región viva por superficie: las confirmaciones del panel NO se duplican en la de
            la página (§9). */}
        <p className="sr-only" role="status" aria-live="polite">{anuncio}</p>

        {soloLectura && !primeraCarga && !errorCarga && (
          <p className="mb-3 text-sm" style={SECUNDARIO}>
            Liquidado: estos servicios quedaron sellados.
            {/* La segunda frase es INSTRUCCIÓN, no reproche, y solo para quien puede reversar algo
                que él mismo podría volver a cambiar. Al auditor reversar no le toca (AC5). */}
            {(puedeAsignar || puedeQuitar) && <> Reversa la liquidación para cambiarlos.</>}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {primeraCarga && <Esqueleto />}

          {!primeraCarga && errorCarga && (
            <div>
              <p role="alert" className="text-sm" style={PELIGRO}>{errorCarga.mensaje}</p>
              {errorCarga.reintentable && (
                <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}
                  onClick={() => setRecarga((n) => n + 1)}>
                  Reintentar
                </button>
              )}
              {errorCarga.tramiteIdo && (
                <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle}
                  onClick={() => { onCambio(); onClose(); }}>
                  Actualizar el reporte
                </button>
              )}
            </div>
          )}

          {!primeraCarga && !errorCarga && (
            <>
              {/* Vive DENTRO del panel y encima de la lista: no es un segundo diálogo (§6.2). */}
              {buscando && puedeAnadir && (
                <BuscadorTipoServicio
                  tramiteId={tramiteId}
                  asignados={tipoIdsDe(items)}
                  onAsignado={(nombre) => trasEscribir(`${nombre} añadido.`)}
                  onRecargarLista={() => setRecarga((n) => n + 1)}
                  onFallo={atenderFallo}
                  onCerrar={() => { setBuscando(false); volverAlPie(); }}
                />
              )}

              {items.length === 0 && (
                <FlitEmpty>
                  Este trámite no tiene servicios adicionales.
                  {/* El vacío NO duplica la primaria: la señala con palabras, que vive en el pie. */}
                  {puedeAnadir && <> Añade el primero desde el catálogo con «Añadir servicio», aquí abajo.</>}
                </FlitEmpty>
              )}

              {items.length > 0 && (
                <ul className="divide-y" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  {items.map((item) => (
                    <FilaServicioAdicional
                      key={item.id}
                      item={item}
                      tramiteId={tramiteId}
                      puedeQuitar={puedeQuitar && editable}
                      abierta={confirmando === item.id}
                      onAbrir={() => { setConfirmando(item.id); setErrorLinea(null); }}
                      onCancelar={() => setConfirmando(null)}
                      onQuitado={(nombre) => { trasEscribir(`${nombre} quitado.`); volverAlPie(); }}
                      onFallo={atenderFallo}
                    />
                  ))}
                </ul>
              )}

              {errorLinea && <p role="alert" className="mt-3 text-sm" style={PELIGRO}>{errorLinea}</p>}
            </>
          )}
        </div>

        {!errorCarga && (
          <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs" style={SECUNDARIO}>{primeraCarga ? '' : etiquetaCantidad(items.length)}</span>
              <span className="text-sm">
                <span style={SECUNDARIO}>Total</span>{' '}
                {/* El total lo calcula el SERVIDOR. Aquí el cero sí se escribe: es el total del
                    panel, no una celda de concepto ausente de la tabla. */}
                <strong className="tabular-nums">{datos ? pesos(datos.total) : ''}</strong>
              </span>
            </div>
            {/* La única primaria del panel. Se calla mientras el buscador está abierto: el buscador
                ES esa acción, desplegada. */}
            {puedeAnadir && !buscando && !primeraCarga && (
              <div className="mt-3 flex justify-end">
                {/* Sin `aria-expanded`: el botón DESAPARECE al abrirse el buscador, así que el
                    atributo solo podría decir «false» y estaría mintiendo sobre lo que hay. */}
                <button type="button" ref={anadirRef} className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                  onClick={() => { setBuscando(true); setErrorLinea(null); }}>
                  Añadir servicio
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </FlitModal>
  );
}

/** El 403 y el 404 del GET no ofrecen «Reintentar»: no se arreglan repitiendo la petición. */
function errorDeCarga(e: unknown): ErrorCarga {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 403) {
    return {
      mensaje: 'Tu usuario ya no puede ver los servicios adicionales de este trámite. Vuelve a entrar para actualizar tus permisos.',
      reintentable: false, tramiteIdo: false,
    };
  }
  if (status === 404) return { mensaje: 'Este trámite ya no existe.', reintentable: false, tramiteIdo: true };
  return {
    mensaje: `No se pudieron cargar los servicios adicionales de este trámite. ${errorMessage(e)}`,
    reintentable: true, tramiteIdo: false,
  };
}

/**
 * Cargando: la FORMA de la lista —dos renglones por servicio— y el pie ya dibujado sin cifras. Sin
 * spinner: un esqueleto con la forma de lo que viene no miente sobre cuánto falta.
 */
function Esqueleto() {
  const barra = (ancho: string) => (
    <span className={`block h-3 ${ancho} rounded`} style={{ background: 'var(--flit-border-soft)' }} />
  );
  return (
    <div role="status" aria-busy="true" aria-label="Cargando los servicios adicionales del trámite">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border-t py-3 first:border-t-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="flex items-center justify-between gap-3">{barra('w-40')}{barra('w-20')}</div>
          <div className="mt-2">{barra('w-56')}</div>
        </div>
      ))}
    </div>
  );
}
