// FLITO — Gestión Trámites: detalle del trámite en modal APAISADO (ADR-0046; rediseño Épica #14707, bloque 4,
// UX `docs/ux/flito-tramites-rediseno.md` §9 y maqueta aprobada).
//
// `FlitModalHorizontal`: cabecera con la posición («n de N»), el id del trámite, su fuente y su estado (o el chip
// Anulado/Revocado de 14707), «‹ Anterior» / «Siguiente ›» y la ✕; SIN placa. Lateral «Estado de la gestión»
// (desde la fila, sin botones) con el índice debajo. El contenido abre con el bloque Vehículo, que lleva en su
// encabezado la fila de acciones reales del trámite —las MISMAS llamadas y diálogos de la tabla, resueltas por
// permiso en la página—, solo si el trámite es accionable. Un trámite muerto (14707) no tiene acciones: aviso
// `warn` primero, desde la fila. Tras un 409 `TRAMITE_NO_VIGENTE` la página refresca, la fila llega muerta y el
// foco pasa al aviso (el botón pulsado deja de existir).
//
// Cada sección tiene sus cuatro estados; historial y soportes van por su propio endpoint, así que un
// fallo en uno no tumba el resto. El trámite abierto vive en memoria, nunca en la URL (§14).

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { TramiteDetalle as DetalleTramite } from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import FlitModalHorizontal from '../../../flit/FlitModalHorizontal';
import InlineAlert from '../../../flit/InlineAlert';
import StatusChip from '../../../flit/StatusChip';
import { claseBoton } from '../../../flit/GradientButton';
import { esAccionable } from '../tiposTramites';
import type { NavDetalleTramite } from './useDetalleTramite';
import {
  BloqueVehiculo, Cargando, ChipVigenciaTramite, ContenidoCostos, ContenidoPropietario, ContenidoResumen, ErrorSeccion,
  EtiquetaFuente, Seccion, SeccionHistorial,
} from './SeccionesDetalle';
import SeccionSoportes from './SeccionSoportes';
import PanelEstadoTramite from './PanelEstadoTramite';

/** Acciones del bloque Vehículo, ya filtradas por permiso en la página. Ausente = el usuario no tiene la función. */
export interface AccionesDetalle {
  soat?: (tramiteId: string) => void;
  impuestos?: (tramiteId: string) => void;
  ambos?: (tramiteId: string) => void;
  entregar?: (tramiteId: string) => void;
}

const SECCIONES = [
  ['vehiculo', 'Vehículo'], ['resumen', 'Resumen'], ['propietario', 'Propietario y gestora'],
  ['soportes', 'Soportes'], ['costos', 'Costos y facturación'], ['historial', 'Historial'],
] as const;
type ClaveSeccion = typeof SECCIONES[number][0];

/** Copy del aviso de un trámite muerto (`docs/ux/epica-14707-tramite-muerto.md` §4). Abortado = Anulado. */
const AVISO_MUERTO = {
  anulado: {
    titulo: 'Trámite anulado en FLIT',
    texto: 'Este trámite se anuló en FLIT, por eso en FLITO ya no tiene acciones: no se puede solicitar SOAT ni impuestos, ni entregar. Si tenía un SOAT o un impuesto en curso, se descartó y salió de su cola.',
  },
  revocado: {
    titulo: 'Trámite revocado en FLIT',
    texto: 'Este trámite se completó, pero FLIT lo revocó y dejó de valer. En FLITO ya no tiene acciones. Su cobro y su liquidación se conservan como histórico: puedes consultarlos en Costos y facturación, pero no generan cobros nuevos.',
  },
} as const;

export default function ModalDetalleTramite({ nav, recarga, suspendido, enProceso, acciones, errorAccion }: {
  nav: NavDetalleTramite;
  /** Cambia tras una acción de la tabla o de la modal: el detalle se vuelve a pedir. */
  recarga: number;
  /** Hay otro diálogo encima (proveedor, resultado): la trampa de foco se le cede. */
  suspendido: boolean;
  enProceso: boolean;
  acciones: AccionesDetalle;
  /** Fallo de la última acción lanzada desde aquí, ya con copy pulido (nunca el error crudo del API). */
  errorAccion?: string | null;
}) {
  const fila = nav.actual!;
  const { hasFuncion } = useAuth();
  const uid = useId();
  const tituloId = `${uid}-titulo`;
  const sid = (k: ClaveSeccion) => `${uid}-${k}`;
  const contenidoRef = useRef<HTMLElement>(null);
  const avisoRef = useRef<HTMLDivElement>(null);
  const [detalle, setDetalle] = useState<DetalleTramite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [conteoSoportes, setConteoSoportes] = useState<number | null>(null);
  const [activa, setActiva] = useState<ClaveSeccion>('vehiculo');
  const vigencia = fila.vigenciaTramite;
  const muerto = vigencia !== 'vigente';

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

  // Al cambiar de trámite: el contenido vuelve arriba y el detalle anterior no se queda pintado. Por debajo de
  // `lg` quien desplaza es `.kit-modal__columnas`.
  useEffect(() => {
    setDetalle(null); setActiva('vehiculo');
    const c = contenidoRef.current;
    c?.scrollTo?.({ top: 0 });
    c?.closest('.kit-modal__columnas')?.scrollTo?.({ top: 0 });
    // Abierta desde el chip de estado de la fila: va directo a Historial (bloque 4, UX §5.3).
    if (nav.seccion) { const k = nav.seccion; requestAnimationFrame(() => irA(k)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fila.tramiteId]);

  // 14707 §6: el mismo trámite pasa de vivo a muerto (409 + refresco) → el foco va al aviso, que lo anuncia.
  const previo = useRef<{ id: string; muerto: boolean } | null>(null);
  useEffect(() => {
    const antes = previo.current;
    if (antes && antes.id === fila.tramiteId && !antes.muerto && muerto) avisoRef.current?.focus();
    previo.current = { id: fila.tramiteId, muerto };
  }, [fila.tramiteId, muerto]);

  const irA = (k: ClaveSeccion) => {
    setActiva(k);
    document.getElementById(sid(k))?.scrollIntoView({ block: 'start' });
  };
  // El índice sigue a la sección visible: la última cuyo borde superior ya pasó el tope del que desplaza
  // (al final del desplazamiento, la última sección, aunque sea corta).
  const alDesplazar = (c: HTMLElement) => {
    const indice = c.querySelector<HTMLElement>('.kit-modal__indice');
    const tope = c.getBoundingClientRect().top + (indice && getComputedStyle(indice).position === 'sticky' ? indice.offsetHeight : 0) + 24;
    const alFinal = c.scrollTop + c.clientHeight >= c.scrollHeight - 2 && c.scrollTop > 0;
    let visible: ClaveSeccion = 'vehiculo';
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
  const botones = accionable ? ([
    ['soat', 'Solicitar SOAT', acciones.soat],
    ['impuestos', 'Solicitar Impuestos', acciones.impuestos],
    ['ambos', 'Solicitar ambos', acciones.ambos],
    ['entregar', 'Entregar', acciones.entregar],
  ] as const).filter(([, , fn]) => !!fn) : [];
  const navBtn = claseBoton('ghost', 'sm');
  const aviso = muerto ? AVISO_MUERTO[vigencia === 'revocado' ? 'revocado' : 'anulado'] : null;

  return (
    <FlitModalHorizontal
      tituloId={tituloId}
      titulo={fila.idFlit}
      antetitulo={`Gestión Trámites · ${nav.posicion !== null ? `${nav.posicion} de ${nav.total.toLocaleString('es-CO')}` : 'cargando…'}`}
      chips={(
        <>
          <EtiquetaFuente fuente={detalle?.resumen.fuente ?? fila.fuente} />
          {muerto
            ? <ChipVigenciaTramite vigencia={vigencia} />
            : <StatusChip tone={fila.asignado ? 'active' : 'neutral'}>{detalle?.resumen.estado ?? fila.estado}</StatusChip>}
        </>
      )}
      navegacion={(
        <>
          <button type="button" className={navBtn} disabled={!nav.hayAnterior || nav.cargandoPagina} onClick={nav.anterior}>‹ Anterior</button>
          <button type="button" className={navBtn} disabled={!nav.haySiguiente || nav.cargandoPagina} onClick={nav.siguiente}>Siguiente ›</button>
        </>
      )}
      lateral={<PanelEstadoTramite fila={fila} detalle={detalle} errorDetalle={!!error} />}
      etiquetaLateral="Estado de la gestión"
      indice={(
        <nav className="kit-modal__indice" aria-label="Secciones del trámite">
          <ul className="indice-lista">
            {SECCIONES.map(([k, rotulo]) => (
              <li key={k}>
                <button type="button" onClick={() => irA(k)} aria-current={activa === k ? 'true' : undefined}>
                  {rotulo}{k === 'soportes' && conteoSoportes !== null ? ` (${conteoSoportes})` : ''}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      etiquetaContenido={`Detalle del trámite ${fila.idFlit}`}
      contenidoRef={contenidoRef}
      onScrollContenido={alDesplazar}
      onClose={nav.cerrar}
      trampaActiva={!suspendido}
    >
      {aviso && (
        <div ref={avisoRef} tabIndex={-1} className="rounded-[9px] outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--kit-azul)]">
          <InlineAlert tono="warn" titulo={aviso.titulo}><p className="m-0 mt-1">{aviso.texto}</p></InlineAlert>
        </div>
      )}
      <BloqueVehiculo id={sid('vehiculo')} fila={fila} detalle={detalle} errorAccion={muerto ? null : errorAccion}
        acciones={botones.length > 0 ? (
          <div className="acciones-fila">
            {botones.map(([k, rotulo, fn]) => (
              <button key={k} type="button" disabled={enProceso} onClick={() => fn!(fila.tramiteId)}
                className={claseBoton(k === 'entregar' ? 'primary' : 'secondary', 'sm')}>{rotulo}</button>
            ))}
          </div>
        ) : undefined} />
      {bloqueDetalle('resumen', 'Resumen', (d) => <ContenidoResumen d={d} />)}
      {bloqueDetalle('propietario', 'Propietario y gestora', (d) => <ContenidoPropietario d={d} />)}
      <SeccionSoportes key={fila.tramiteId} id={sid('soportes')} tramiteId={fila.tramiteId} idFlit={fila.idFlit}
        tieneFacturaVenta={detalle?.costos.tieneFacturaVenta ?? false}
        puedeVer={hasFuncion('tramites.tramite.ver_soportes')}
        puedeDescargar={hasFuncion('tramites.soportes.descargar')}
        onConteo={setConteoSoportes} />
      {bloqueDetalle('costos', 'Costos y facturación', (d) => <ContenidoCostos d={d} />)}
      <SeccionHistorial key={`h-${fila.tramiteId}`} id={sid('historial')} tramiteId={fila.tramiteId}
        puedeVer={hasFuncion('tramites.tramite.ver_historial')} />
    </FlitModalHorizontal>
  );
}
