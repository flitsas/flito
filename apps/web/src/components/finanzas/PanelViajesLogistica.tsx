// El panel de viajes de logística de un trámite del Reporte de costos (HU #12628, Feature #12618,
// épica #12244). Diseño: `docs/ux/finanzas-reporte-costos-viajes.md`. Calco de SOLO LECTURA de
// `PanelServiciosAdicionales`: responde «¿por qué Logística vale eso? ¿cuántos viajes hubo?».
//
// Tres cosas que este componente no hace, y son deliberadas:
//   · NO escribe. Registrar y quitar viajes es de la consola logística de Operaciones
//     (`logistica.viajes.*`); un panel con dos dueños es dos verdades. Por eso tampoco avisa
//     «reversa para cambiar»: aquí no hay nada que cambiar. Cero botones y cero inputs en el cuerpo.
//   · NO suma nada. `totalLogistica` y `totalViajes` los calcula el servidor; la pantalla los pinta.
//   · NO cachea entre aperturas: cada montaje repide el GET.

import { useEffect, useState, type RefObject } from 'react';
import type { DesgloseViajesLogistica, ViajeLogisticaSellado } from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../lib/api';
import { textoMotivo } from '../../lib/viajesLogistica';
import {
  etiquetaModoViaje, lineaOrigen, rutaViajesDeTramiteReporte, textoTarifaDelMomento, textoTotalViajesPanel,
  textoViajeIncluido, tituloPanelViajes,
} from '../../lib/viajesLogisticaReporte';
import { fechaHoraCorta } from '../../lib/tarifas';
import FlitModal from '../flit/FlitModal';
import { FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import { pesos } from './tiposReporteCostos';

const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;
const BORDE_SUAVE = { borderColor: 'var(--flit-border-soft)' } as const;

/** Lo que falla al PEDIR el desglose. El 403 y el 404 no se reintentan: reintentar no los arregla. */
interface ErrorCarga { mensaje: string; reintentable: boolean; tramiteIdo: boolean }

export default function PanelViajesLogistica({ tramiteId, idFlit, placa, onClose, onActualizar, restoreFocusRef }: {
  tramiteId: string;
  idFlit: string;
  placa: string | null;
  onClose: () => void;
  /** El `refrescar()` de la página, solo para el 404 («Actualizar el reporte»). Nunca `ejecutar()`. */
  onActualizar: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [datos, setDatos] = useState<DesgloseViajesLogistica | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState<ErrorCarga | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setErrorCarga(null);
    api.get<DesgloseViajesLogistica>(rutaViajesDeTramiteReporte(tramiteId))
      .then((r) => { if (vivo) setDatos(r); })
      .catch((e) => {
        if (!vivo) return;
        setDatos(null);
        setErrorCarga(errorDeCarga(e));
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [tramiteId, recarga]);

  return (
    <FlitModal lateral title={tituloPanelViajes(idFlit, placa)} onClose={onClose} restoreFocusRef={restoreFocusRef}>
      <div className="flex h-full flex-col">
        {/* Sin región viva propia: el panel no anuncia nada (una sola `aria-live` por superficie, la
            de la página). El esqueleto lleva `role="status"` como el de servicios. */}
        {cargando && <Esqueleto />}

        {!cargando && errorCarga && (
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
                onClick={() => { onActualizar(); onClose(); }}>
                Actualizar el reporte
              </button>
            )}
          </div>
        )}

        {!cargando && !errorCarga && datos && <Cuerpo datos={datos} />}
      </div>
    </FlitModal>
  );
}

/**
 * Los cuatro cuerpos posibles, decididos por lo que el SERVIDOR dice y no por `items.length`:
 *   · `gestionaLogistica: false` → la compañía autogestiona: ni cabecera, ni pie con cifra («$ 0»
 *     sería un relleno).
 *   · `origen: 'sin_desglose'`   → sellada antes del concepto: solo se sabe el total. Sin «Viaje 1»,
 *     porque no se sabe si lo hubo.
 *   · `items: []`                → solo el incluido: cabecera + «Sin viajes adicionales.» + «1 viaje».
 *   · lleno                      → cabecera + lista + pie.
 */
function Cuerpo({ datos }: { datos: DesgloseViajesLogistica }) {
  const items = datos.items ?? [];
  const sinDesglose = datos.origen === 'sin_desglose';

  if (!datos.gestionaLogistica) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Sin línea de origen: no hay estimación ni sello que explicar cuando no se cobra. */}
        <FlitEmpty>La logística de esta compañía la gestiona el cliente: no hay viajes que cobrar.</FlitEmpty>
      </div>
    );
  }

  return (
    <>
      <p className="mb-3 text-sm" style={SECUNDARIO}>{lineaOrigen(datos)}</p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sinDesglose && (
          <FlitEmpty>Sin dato: se liquidó antes de que FLITO cobrara viajes adicionales.</FlitEmpty>
        )}

        {!sinDesglose && (
          <>
            {/* La cabecera fija: el viaje 1 va dentro de la tarifa y no es una fila de la lista. */}
            <p className="border-b pb-3 text-sm font-medium tabular-nums" style={BORDE_SUAVE} data-viaje="1">
              {textoViajeIncluido(datos.tarifa)}
            </p>

            {items.length === 0 && <FlitEmpty>Sin viajes adicionales.</FlitEmpty>}

            {items.length > 0 && (
              <ul className="divide-y" style={BORDE_SUAVE}>
                {items.map((item) => <FilaViaje key={item.id} item={item} />)}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="mt-3 border-t pt-3" style={BORDE_SUAVE}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs" style={SECUNDARIO}>
            {datos.totalViajes === null ? '' : textoTotalViajesPanel(datos.totalViajes)}
          </span>
          <span className="text-sm">
            <span style={SECUNDARIO}>Total logística</span>{' '}
            {/* Del SERVIDOR: tarifa + Σ viajes ya sumados allí. Aquí no se suma nada. */}
            <strong className="tabular-nums">{datos.totalLogistica === null ? '—' : pesos(datos.totalLogistica)}</strong>
          </span>
        </div>
      </div>
    </>
  );
}

/** Dos renglones por viaje, como en servicios: qué y cuánto arriba; cómo, por qué, quién y cuándo debajo. */
function FilaViaje({ item }: { item: ViajeLogisticaSellado }) {
  const motivo = textoMotivo(item);
  return (
    <li className="py-3" data-id={item.id}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">Viaje {item.numero}</span>
        <span className="tabular-nums">{pesos(item.valor)}</span>
      </div>
      <div className="mt-1 text-xs" style={SECUNDARIO}>
        {etiquetaModoViaje(item.modo)} · {textoTarifaDelMomento(item.tarifaVigente)}
      </div>
      {/* El detalle de «Otro» es texto libre del operador: una línea, y el completo en `title`. */}
      <div className="mt-0.5 truncate text-xs" style={SECUNDARIO} title={motivo}>
        {motivo} · {item.registradoPorNombre ?? 'Sin autor'} · {fechaHoraCorta(item.registradoEn)}
      </div>
    </li>
  );
}

/** El 403 y el 404 del GET no ofrecen «Reintentar»: no se arreglan repitiendo la petición. */
function errorDeCarga(e: unknown): ErrorCarga {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 403) {
    return {
      mensaje: 'Tu usuario ya no puede ver los viajes de este trámite. Vuelve a entrar para actualizar tus permisos.',
      reintentable: false, tramiteIdo: false,
    };
  }
  if (status === 404) return { mensaje: 'El trámite ya no existe.', reintentable: false, tramiteIdo: true };
  return {
    mensaje: `No se pudieron cargar los viajes de este trámite. ${errorMessage(e)}`,
    reintentable: true, tramiteIdo: false,
  };
}

/**
 * Cargando: la FORMA de lo que viene —cabecera, dos viajes de dos renglones y el pie sin cifras—.
 * Sin spinner: un esqueleto con la forma de lo que viene no miente sobre cuánto falta.
 */
function Esqueleto() {
  const barra = (ancho: string) => (
    <span className={`block h-3 ${ancho} rounded`} style={{ background: 'var(--flit-border-soft)' }} />
  );
  return (
    <div role="status" aria-busy="true" aria-label="Consultando los viajes…">
      <div className="pb-3">{barra('w-48')}</div>
      {[0, 1].map((i) => (
        <div key={i} className="border-t py-3" style={BORDE_SUAVE}>
          <div className="flex items-center justify-between gap-3">{barra('w-24')}{barra('w-20')}</div>
          <div className="mt-2">{barra('w-56')}</div>
        </div>
      ))}
      <div className="mt-3 flex justify-between border-t pt-3" style={BORDE_SUAVE}>{barra('w-16')}{barra('w-32')}</div>
    </div>
  );
}
