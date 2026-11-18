// FLITO — Gestión Trámites: detalle del trámite en modal ancha (ADR-0046, Épica #14560).
//
// Se abre con el botón «Ver» de cada fila. Cabecera con la posición («n de N»), el id del trámite,
// su fuente y su estado, y «‹ Anterior» / «Siguiente ›» / «Cerrar». A la izquierda un índice que
// desplaza a cada sección (bajo `lg` pasa arriba como tira deslizable). Pie con las acciones reales
// del trámite, que son las MISMAS llamadas y diálogos de la tabla: la página las pasa ya resueltas
// por permiso y aquí solo se pintan si el trámite es accionable (misma regla que la barra).
//
// Cada sección tiene sus cuatro estados; historial y soportes van por su propio endpoint, así que un
// fallo en uno no tumba el resto. El trámite abierto vive en memoria, nunca en la URL (§14).

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { TramiteDetalle as DetalleTramite } from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useEscape, useFocusTrap } from '../../../../lib/hooks';
import ModalPortal from '../../../flit/ModalPortal';
import StatusChip from '../../../flit/StatusChip';
import { claseBoton } from '../../../flit/GradientButton';
import { esAccionable } from '../tiposTramites';
import type { NavDetalleTramite } from './useDetalleTramite';
import {
  Cargando, ContenidoCostos, ContenidoPropietario, ContenidoResumen, ContenidoVehiculo, ErrorSeccion,
  EtiquetaFuente, Seccion, SeccionHistorial,
} from './SeccionesDetalle';
import SeccionSoportes from './SeccionSoportes';

/** Acciones del pie, ya filtradas por permiso en la página. Ausente = el usuario no tiene la función. */
export interface AccionesDetalle {
  soat?: (tramiteId: string) => void;
  impuestos?: (tramiteId: string) => void;
  ambos?: (tramiteId: string) => void;
  entregar?: (tramiteId: string) => void;
}

const SECCIONES = [
  ['resumen', 'Resumen'], ['vehiculo', 'Vehículo'], ['propietario', 'Propietario y gestora'],
  ['soportes', 'Soportes'], ['costos', 'Costos y facturación'], ['historial', 'Historial'],
] as const;
type ClaveSeccion = typeof SECCIONES[number][0];

export default function ModalDetalleTramite({ nav, recarga, suspendido, enProceso, acciones }: {
  nav: NavDetalleTramite;
  /** Cambia tras una acción de la tabla o de la modal: el detalle se vuelve a pedir. */
  recarga: number;
  /** Hay otro diálogo encima (proveedor, resultado): la trampa de foco se le cede. */
  suspendido: boolean;
  enProceso: boolean;
  acciones: AccionesDetalle;
}) {
  const fila = nav.actual!;
  const { hasFuncion } = useAuth();
  const uid = useId();
  const tituloId = `${uid}-titulo`;
  const sid = (k: ClaveSeccion) => `${uid}-${k}`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cuerpoRef = useRef<HTMLDivElement>(null);
  const [detalle, setDetalle] = useState<DetalleTramite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [conteoSoportes, setConteoSoportes] = useState<number | null>(null);
  const [activa, setActiva] = useState<ClaveSeccion>('resumen');

  // Escape cierra solo el diálogo de más arriba (los modales se apilan en <body> por orden de montaje).
  useEscape(() => {
    const abiertos = document.querySelectorAll('[data-flit-modal]');
    if (abiertos.length === 0 || abiertos[abiertos.length - 1] === overlayRef.current) nav.cerrar();
  });
  useFocusTrap(dialogRef, !suspendido);

  useEffect(() => {
    let vivo = true;
    setError(null);
    api.get<DetalleTramite>(`/flito/tramites/${fila.tramiteId}/detalle`)
      .then((d) => { if (vivo) setDetalle(d); })
      .catch((e) => {
        if (!vivo) return;
        setDetalle(null);
        setError(e instanceof ApiError && e.status === 404
          ? 'Este trámite ya no está disponible o quedó fuera de tu alcance. Cierra la ventana y actualiza la tabla.'
          : `No se pudo cargar el detalle del trámite. ${errorMessage(e)}`);
      });
    return () => { vivo = false; };
  }, [fila.tramiteId, recarga, nonce]);

  // Al cambiar de trámite: el cuerpo vuelve arriba y el detalle anterior no se queda pintado.
  useEffect(() => {
    setDetalle(null); setActiva('resumen');
    cuerpoRef.current?.scrollTo?.({ top: 0 });
  }, [fila.tramiteId]);

  const irA = (k: ClaveSeccion) => {
    setActiva(k);
    document.getElementById(sid(k))?.scrollIntoView({ block: 'start' });
  };
  // El índice sigue a la sección visible: la última cuyo borde superior ya pasó el tope del cuerpo
  // (al final del desplazamiento, la última sección, aunque sea corta).
  const alDesplazar = () => {
    const c = cuerpoRef.current;
    if (!c) return;
    const tope = c.getBoundingClientRect().top + 24;
    const alFinal = c.scrollTop + c.clientHeight >= c.scrollHeight - 2 && c.scrollTop > 0;
    let visible: ClaveSeccion = 'resumen';
    for (const [k] of SECCIONES) {
      const el = document.getElementById(sid(k));
      if (el && el.getBoundingClientRect().top <= tope) visible = k;
    }
    setActiva(alFinal ? SECCIONES[SECCIONES.length - 1][0] : visible);
  };

  const bloqueDetalle = (k: ClaveSeccion, titulo: string, contenido: (d: DetalleTramite) => ReactNode) => (
    <Seccion id={sid(k)} titulo={titulo}>
      {error ? <ErrorSeccion texto={error} rotulo="Reintentar" onReintentar={() => setNonce((n) => n + 1)} />
        : detalle === null ? <Cargando que="el detalle" />
        : contenido(detalle)}
    </Seccion>
  );

  const accionable = esAccionable(fila);
  const botonesPie = accionable ? ([
    ['soat', 'Solicitar SOAT', acciones.soat],
    ['impuestos', 'Solicitar Impuestos', acciones.impuestos],
    ['ambos', 'Solicitar ambos', acciones.ambos],
    ['entregar', 'Entregar', acciones.entregar],
  ] as const).filter(([, , fn]) => !!fn) : [];
  const navBtn = claseBoton('secondary', 'sm');

  return (
    <ModalPortal>
      <div ref={overlayRef} data-flit-modal="" className="flit-modal kit-velo items-center justify-center p-3 sm:p-6">
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={tituloId} tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          className="kit-modal my-auto h-[calc(100dvh-3rem)] max-w-[min(80rem,96vw)] overflow-hidden outline-none">
          <header className="flex flex-none flex-wrap items-start justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <small className="kit-modal__ante" aria-live="polite">
                Gestión Trámites · {nav.posicion !== null ? `${nav.posicion} de ${nav.total.toLocaleString('es-CO')}` : 'cargando…'}
              </small>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2 id={tituloId} className="kit-modal__titulo tabular-nums">{fila.idFlit}</h2>
                <EtiquetaFuente fuente={detalle?.resumen.fuente ?? fila.fuente} />
                <StatusChip tone={fila.asignado ? 'active' : 'neutral'}>{detalle?.resumen.estado ?? fila.estado}</StatusChip>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={navBtn} disabled={!nav.hayAnterior || nav.cargandoPagina} onClick={nav.anterior}>‹ Anterior</button>
              <button type="button" className={navBtn} disabled={!nav.haySiguiente || nav.cargandoPagina} onClick={nav.siguiente}>Siguiente ›</button>
              <button type="button" className={claseBoton('ghost', 'sm')} onClick={nav.cerrar}>Cerrar</button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <nav aria-label="Secciones del trámite"
              className="flex flex-none gap-1 overflow-x-auto border-b border-[color:var(--color-border)] px-3 py-2 lg:w-56 lg:flex-col lg:overflow-x-visible lg:border-b-0 lg:border-r lg:py-4">
              {SECCIONES.map(([k, rotulo]) => (
                <button key={k} type="button" onClick={() => irA(k)} aria-current={activa === k ? 'true' : undefined}
                  className={'flit-focus shrink-0 whitespace-nowrap rounded-[9px] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--kit-hover)] '
                    + (activa === k ? 'bg-[var(--kit-hover)] font-semibold text-[color:var(--color-action)]' : 'text-[color:var(--color-text-secondary)]')}>
                  {rotulo}{k === 'soportes' && conteoSoportes !== null ? ` (${conteoSoportes})` : ''}
                </button>
              ))}
            </nav>
            <div ref={cuerpoRef} onScroll={alDesplazar} tabIndex={0} role="region" aria-label={`Detalle del trámite ${fila.idFlit}`}
              className="flit-focus-inset min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
              {bloqueDetalle('resumen', 'Resumen', (d) => <ContenidoResumen d={d} />)}
              {bloqueDetalle('vehiculo', 'Vehículo', (d) => <ContenidoVehiculo d={d} />)}
              {bloqueDetalle('propietario', 'Propietario y gestora', (d) => <ContenidoPropietario d={d} />)}
              <SeccionSoportes key={fila.tramiteId} id={sid('soportes')} tramiteId={fila.tramiteId} idFlit={fila.idFlit}
                tieneFacturaVenta={detalle?.costos.tieneFacturaVenta ?? false}
                puedeVer={hasFuncion('tramites.tramite.ver_soportes')}
                puedeDescargar={hasFuncion('tramites.soportes.descargar')}
                onConteo={setConteoSoportes} />
              {bloqueDetalle('costos', 'Costos y facturación', (d) => <ContenidoCostos d={d} />)}
              <SeccionHistorial key={`h-${fila.tramiteId}`} id={sid('historial')} tramiteId={fila.tramiteId}
                puedeVer={hasFuncion('tramites.tramite.ver_historial')} />
            </div>
          </div>

          {botonesPie.length > 0 && (
            <footer className="grid flex-none grid-cols-2 gap-2 border-t sm:flex sm:flex-wrap sm:items-center sm:justify-end border-[color:var(--color-border)] px-4 py-3 sm:px-6">
              {botonesPie.map(([k, rotulo, fn]) => (
                <button key={k} type="button" disabled={enProceso} onClick={() => fn!(fila.tramiteId)}
                  className={claseBoton(k === 'entregar' ? 'primary' : 'secondary', 'sm')}>{rotulo}</button>
              ))}
            </footer>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
