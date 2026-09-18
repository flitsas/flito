// La sección «Viajes adicionales» del detalle de un trámite en la consola logística (HU #12620,
// Feature #12617, Épica #12244). Diseño: `docs/ux/flito-logistica-viajes.md`.
//
// Es la ÚNICA superficie de la consola logística que enseña precios: ni la cola, ni el acta ni su
// PDF los muestran. Tres cosas que no hace, y son deliberadas:
//   · NO suma nada. `totalViajes` y `totalAdicionales` los calcula el servidor; aquí se pintan.
//   · NO decide por rol: `puedeRegistrar`/`puedeQuitar` llegan resueltos con `hasFuncion`, y el
//     montaje mismo lo condiciona `DetalleModal` a `logistica.viajes.ver`.
//   · NO sondea para enterarse de una liquidación ajena: el 409 de la propia escritura llega antes
//     y se atiende en caliente.

import { useEffect, useRef, useState } from 'react';
import type { ViajeLogistica, ViajesLogisticaDeTramite } from '@operaciones/shared-types';
import { api } from '../../../lib/api';
import {
  errorDeCarga, rutaViajesDeTramite, textoTotalAdicionales, textoTotalViajes, type ErrorCarga, type FalloEscritura,
} from '../../../lib/viajesLogistica';
import { FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import FilaViajeLogistica from './FilaViajeLogistica';
import ModalRegistrarViaje from './ModalRegistrarViaje';

const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
const MUTED = { color: 'var(--flit-text-muted)' } as const;
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;

export default function ViajesLogistica({ tramiteId, idFlit, puedeRegistrar, puedeQuitar, fecha }: {
  tramiteId: string;
  idFlit: string;
  /** `logistica.viajes.registrar`, resuelta con `hasFuncion` (nunca por rol). */
  puedeRegistrar: boolean;
  /** `logistica.viajes.quitar`. */
  puedeQuitar: boolean;
  /** El `fecha()` de la página: la fila se lee como la bitácora de al lado. */
  fecha: (iso: string | null) => string;
}) {
  const [datos, setDatos] = useState<ViajesLogisticaDeTramite | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<ErrorCarga | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [registrando, setRegistrando] = useState(false);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [errorLinea, setErrorLinea] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState('');
  /** Un 409 `TRAMITE_LIQUIDADO` sella la sección en el acto, antes de que llegue el GET siguiente. */
  const [selladoEnCaliente, setSelladoEnCaliente] = useState(false);
  const registrarRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setErrorCarga(null);
    api.get<ViajesLogisticaDeTramite>(rutaViajesDeTramite(tramiteId))
      .then((r) => { if (vivo) setDatos(r); })
      .catch((e) => { if (vivo) { setDatos(null); setErrorCarga(errorDeCarga(e)); } })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [tramiteId, recarga]);

  const items = datos?.items ?? [];
  const liquidado = (datos?.liquidado ?? false) || selladoEnCaliente;
  const gestiona = datos?.gestionaLogistica ?? true;
  const editable = gestiona && !liquidado;
  // El esqueleto es SOLO de la primera carga: con datos en la mano la lista se queda a la vista.
  const primeraCarga = cargando && datos === null;

  const volverAlPie = () => setTimeout(() => registrarRef.current?.focus(), 0);

  const trasEscribir = (mensaje: string) => {
    setAnuncio(mensaje);
    setErrorLinea(null);
    setConfirmando(null);
    setRecarga((n) => n + 1);
  };

  const atenderFallo = (fallo: FalloEscritura) => {
    // El 422 sin tarifa lo cuenta el modal, que sigue abierto: repetirlo aquí sería decirlo dos veces.
    if (!fallo.forzarManual) setErrorLinea(fallo.mensaje);
    setConfirmando(null);
    if (fallo.soloLectura) setSelladoEnCaliente(true);
    if (fallo.recargarLista) setRecarga((n) => n + 1);
  };

  return (
    <section aria-labelledby="viajes-logistica-titulo" className="mb-4 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <h3 id="viajes-logistica-titulo" className="mb-2 text-xs font-bold uppercase tracking-wide" style={SECUNDARIO}>Viajes adicionales</h3>

      {primeraCarga && <Esqueleto />}

      {!primeraCarga && errorCarga && (
        <div>
          <p role="alert" className="text-sm" style={PELIGRO}>{errorCarga.mensaje}</p>
          {errorCarga.reintentable && (
            <button type="button" className={`${flitBtnSecondary} mt-2`} style={flitBtnSecondaryStyle} onClick={() => setRecarga((n) => n + 1)}>
              Reintentar
            </button>
          )}
        </div>
      )}

      {datos && !errorCarga && (
        <>
          {/* La única región viva de la sección: los totales, y dentro —sin verse— lo que se acaba
              de hacer. Un solo `aria-live`: dos anunciarían a la vez. */}
          <p role="status" aria-live="polite" className="mb-2 flex flex-wrap items-baseline justify-between gap-3 text-sm">
            {gestiona && (
              <>
                <span>{textoTotalViajes(datos.totalViajes)}</span>
                <strong className="tabular-nums">{textoTotalAdicionales(datos.totalAdicionales)}</strong>
              </>
            )}
            <span className="sr-only">{anuncio}</span>
          </p>

          {!gestiona && <p className="mb-2 text-sm" style={MUTED}>La logística de esta compañía la gestiona el cliente.</p>}
          {gestiona && liquidado && (
            <p className="mb-2 text-sm" style={MUTED}>Trámite liquidado: reversa la liquidación para registrar o quitar viajes.</p>
          )}

          {gestiona && items.length === 0 && (
            <FlitEmpty>
              Sin viajes adicionales. El viaje 1 se cobra con la tarifa vigente.
              {puedeRegistrar && editable && <> Registra el siguiente con «Registrar viaje», aquí abajo.</>}
            </FlitEmpty>
          )}

          {items.length > 0 && (
            <ul className="divide-y" style={{ borderColor: 'var(--flit-border-soft)' }}>
              {items.map((viaje) => (
                <FilaViajeLogistica key={viaje.id} viaje={viaje} tramiteId={tramiteId} fecha={fecha}
                  puedeQuitar={puedeQuitar && editable}
                  abierta={confirmando === viaje.id}
                  onAbrir={() => { setConfirmando(viaje.id); setErrorLinea(null); }}
                  onCancelar={() => setConfirmando(null)}
                  onQuitado={(v) => { trasEscribir(`Viaje N.º ${v.numero} quitado.`); volverAlPie(); }}
                  onFallo={atenderFallo} />
              ))}
            </ul>
          )}

          {errorLinea && <p role="alert" className="mt-2 text-sm" style={PELIGRO}>{errorLinea}</p>}

          {/* La única primaria del modal del detalle. */}
          {puedeRegistrar && editable && (
            <div className="mt-3 flex justify-end">
              <button type="button" ref={registrarRef} className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => { setRegistrando(true); setErrorLinea(null); }}>
                Registrar viaje
              </button>
            </div>
          )}

          {registrando && (
            <ModalRegistrarViaje tramiteId={tramiteId} idFlit={idFlit} tarifaVigente={datos.tarifaVigente}
              restoreFocusRef={registrarRef}
              onClose={() => setRegistrando(false)}
              onRegistrado={(v: ViajeLogistica) => { setRegistrando(false); trasEscribir(`Viaje N.º ${v.numero} registrado.`); volverAlPie(); }}
              onFallo={atenderFallo} />
          )}
        </>
      )}
    </section>
  );
}

/** Cargando: la FORMA de la lista —dos renglones por viaje—, sin spinner. */
function Esqueleto() {
  const barra = (ancho: string) => <span className={`block h-3 ${ancho} rounded`} style={{ background: 'var(--flit-border-soft)' }} />;
  return (
    <div role="status" aria-busy="true" aria-label="Cargando viajes…">
      {[0, 1].map((i) => (
        <div key={i} className="border-t py-2 first:border-t-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="flex items-center justify-between gap-3">{barra('w-40')}{barra('w-16')}</div>
          <div className="mt-2">{barra('w-56')}</div>
        </div>
      ))}
    </div>
  );
}
