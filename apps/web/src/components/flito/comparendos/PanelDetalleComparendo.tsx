// FLITO — Comparendos: el panel de detalle con su línea de tiempo (HU #11562, AC1, AC5, AC7, AC8).
//
// Tres secciones en un orden que no es casual: primero **qué es** (los datos de la fuente, que es lo
// que se vino a mirar), después **qué hago** (la gestión, la única acción posible) y al final **qué
// le ha pasado** (el historial, que es la segunda pregunta y no la primera).
//
// ── AC7 · los datos de fuente son de solo lectura, y se nota en el HTML ──────────────────────────
// La sección de fuente es un `<dl>`: no hay un `<input>` deshabilitado, ni un campo de solo lectura,
// ni un botón de editar en ninguna parte. Un control inhabilitado dice «esto se edita, pero tú no
// puedes», y aquí lo cierto es que **no se edita**: lo escribe el sync y no hay endpoint que lo
// toque (RN-04). La diferencia es comprobable contando controles dentro de la región, que es justo
// lo que hace el spec.
//
// ── AC8 · el foco ────────────────────────────────────────────────────────────────────────────────
// El panel es un `FlitModal`, así que la trampa de foco y su restauración ya existen y no se
// reimplementan. Dos cosas que sí hace esta HU:
//   · **El modal se monta a la vez que empieza la petición**, no cuando llegan los datos. Además de
//     que abrir un modal 400 ms después del clic se siente como un clic perdido, montarlo tarde
//     rompería la restauración del foco: `useFocusTrap` capturaría como origen el propio contenedor
//     del diálogo en vez de la fila que lo abrió.
//   · **`restoreFocusRef`** apunta al encabezado de la tabla. Es el respaldo para cuando la fila que
//     abrió el panel ya no está en el DOM —tras el 404, o tras recargar la lista—: ahí `.focus()`
//     sobre el nodo viejo no hace nada y el foco se quedaría en `<body>` (nota QA #63).
//
// El foco inicial es el CONTENEDOR del diálogo, que lleva el número de comparendo en su
// `aria-label`, y no el `<select>` de causal: el detalle se abre para leer, y un `select` enfocado
// en un modal recién abierto se cambia sin querer con la rueda del ratón.

import { useRef, type ReactNode, type RefObject } from 'react';
import type { ComparendoRegistro, ComparendoRegistroDetalle } from '@operaciones/shared-types';
import FlitModal from '../../flit/FlitModal';
import StatusChip from '../../flit/StatusChip';
import { flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import FormularioGestion from './FormularioGestion';
import TimelineComparendo from './TimelineComparendo';
import { SIN_DATO, etiquetaOrigen, fechaHoraColombia, fechaLarga, pesos } from './formato';
import { useComparendoDetalle } from './useComparendoDetalle';
import type { CatalogosComparendos } from './useComparendosLista';

/**
 * Una fila del `<dl>` de fuente.
 *
 * El «—» de un campo ausente lleva `<span class="sr-only">Sin dato</span>` detrás: un guion solo se
 * lee como un guion —o no se lee— y quien navega con lector no puede distinguir «no hay dato» de
 * «hay un dato que no se anunció».
 */
function Dato({ etiqueta, valor, ayuda }: { etiqueta: string; valor: ReactNode; ayuda?: string }) {
  const ausente = valor === null || valor === undefined || valor === SIN_DATO || valor === '';
  return (
    <div className="grid gap-0.5 py-1.5 sm:grid-cols-[13rem_1fr] sm:gap-3">
      <dt className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {etiqueta}
        {ayuda && (
          <span className="mt-0.5 block text-[11px] font-normal" style={{ color: 'var(--flit-text-muted)' }}>
            {ayuda}
          </span>
        )}
      </dt>
      <dd className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        {ausente ? <>{SIN_DATO}<span className="sr-only">Sin dato</span></> : valor}
      </dd>
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section aria-label={titulo} className="space-y-2">
      <h3 className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
        {titulo}
      </h3>
      <div
        className="rounded-xl border bg-white p-4"
        style={{ borderColor: 'var(--flit-border-soft)' }}
      >
        {children}
      </div>
    </section>
  );
}

/** Esqueleto del cuerpo: tres bloques con la forma de las tres secciones, no un spinner centrado. */
function PanelCargando() {
  return (
    <div role="status" aria-busy="true" aria-label="Cargando el comparendo" className="space-y-4">
      <div className="animate-pulse space-y-4 motion-reduce:animate-none">
        {[10, 4, 5].map((barras, bloque) => (
          <div key={bloque} className="space-y-2 rounded-xl border bg-white p-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
            {Array.from({ length: barras }, (_, i) => (
              <div key={i} className="h-4" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface Props {
  /** La fila que abrió el panel: da el título antes de que llegue ninguna respuesta. */
  fila: ComparendoRegistro;
  catalogos: CatalogosComparendos;
  onCerrar: () => void;
  /** El 404: cierra el panel y vuelve a pedir la página, porque la fila de detrás también miente. */
  onCerrarYRecargar: () => void;
  /** El cuerpo del `PATCH`, para que la página parchee la fila **sin volver a pedir la página**. */
  onGestionado: (nuevo: ComparendoRegistroDetalle) => void;
  /** Respaldo del foco al cerrar, si la fila que lo abrió ya no está en el DOM (AC8). */
  respaldoFocoRef: RefObject<HTMLElement | null>;
}

export default function PanelDetalleComparendo(
  { fila, catalogos, onCerrar, onCerrarYRecargar, onGestionado, respaldoFocoRef }: Props,
) {
  const { detalle, cargando, error, recargar, reemplazar } = useComparendoDetalle(fila.id);
  // La suciedad del formulario se consulta, no se recibe: ver el porqué en la prop `sucioRef` de
  // `FormularioGestion`. Va en una `ref` para que `cerrar` lea el valor del INSTANTE de la tecla y
  // no el que hubiera cuajado en el estado dos efectos pasivos antes.
  const sucioRef = useRef(false);

  /**
   * Cerrar con una gestión a medio escribir pide confirmación.
   *
   * Mismo criterio —y mismo mecanismo— que `DiagnosticoEvaluacionDrawer` en PESV. Vale para la ✕ y
   * para Esc porque `FlitModal` encamina las dos por `onClose`, que es exactamente lo que evita que
   * una de las dos salidas se quede sin la pregunta.
   */
  const cerrar = () => {
    if (sucioRef.current && !window.confirm('Tienes una gestión sin guardar. ¿Cerrar y perderla?')) return;
    onCerrar();
  };

  const guardado = (nuevo: ComparendoRegistroDetalle) => {
    // Las dos mitades del AC3, y ninguna vuelve a pedir nada: el panel se reemplaza con el cuerpo
    // del PATCH (que ya trae el timeline con el evento nuevo el primero) y la página parchea su
    // fila con el mismo objeto.
    reemplazar(nuevo);
    onGestionado(nuevo);
  };

  const municipio = detalle?.municipioFuente
    ? catalogos.municipios[detalle.municipioFuente] ?? detalle.municipioFuente
    : null;
  const alias = detalle ? catalogos.alias[detalle.nitMonitoreado] : undefined;
  const infraccion = detalle
    ? [detalle.codigoInfraccion, detalle.descripcionInfraccion].filter(Boolean).join(' — ')
    : '';
  const vistoEn = detalle
    ? [detalle.vistoEnSimit ? 'SIMIT' : null, detalle.vistoEnMunicipal ? 'Municipal' : null]
      .filter(Boolean).join(' · ')
    : '';

  return (
    <FlitModal
      title={`Comparendo ${fila.numeroComparendo}`}
      onClose={cerrar}
      wide
      restoreFocusRef={respaldoFocoRef}
    >
      <div className="space-y-5">
        {cargando && <PanelCargando />}

        {error && (
          // Dentro del panel y no en su lugar: cerrar el modal por un error obliga a buscar la fila
          // otra vez, y quien lo abrió ya sabe cuál quería.
          <div role="alert" className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error.texto}</p>
            <div className="flex flex-wrap gap-2">
              {error.accion === 'reintentar' && (
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={recargar}>
                  Reintentar
                </button>
              )}
              {error.accion === 'cerrarYRecargar' && (
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCerrarYRecargar}>
                  Cerrar y actualizar la lista
                </button>
              )}
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={cerrar}>
                Cerrar
              </button>
            </div>
          </div>
        )}

        {detalle && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
              <StatusChip tone={detalle.estado === 'activo' ? 'active' : 'draft'}>
                {detalle.estado === 'activo' ? 'Activo' : 'Inactivo'}
              </StatusChip>
              <span>{`Origen: ${etiquetaOrigen(detalle.origenMerge)}`}</span>
              <span>{`Municipio: ${municipio ?? SIN_DATO}`}</span>
            </div>

            <Seccion titulo="Datos de la fuente">
              <p className="mb-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                Vienen de SIMIT y de los municipios. No se editan aquí.
              </p>
              <dl className="divide-y divide-[color:var(--flit-border-soft)]">
                <Dato etiqueta="N.º de comparendo" valor={detalle.numeroComparendo} />
                <Dato
                  etiqueta="NIT monitoreado"
                  ayuda="El NIT con el que se preguntó, no el del infractor."
                  valor={alias ? `${detalle.nitMonitoreado} · ${alias}` : detalle.nitMonitoreado}
                />
                <Dato etiqueta="Placa" valor={detalle.placa} />
                <Dato etiqueta="Fecha del comparendo" valor={fechaLarga(detalle.fechaComparendo)} />
                <Dato etiqueta="Infracción" valor={infraccion} />
                <Dato etiqueta="Organismo" valor={detalle.organismo} />
                <Dato etiqueta="Municipio" valor={municipio} />
                <Dato etiqueta="Monto" valor={pesos(detalle.monto)} />
                <Dato
                  etiqueta="Estado en la fuente"
                  ayuda="Lo que reporta el proveedor, tal cual. No está normalizado."
                  valor={detalle.estadoFuente}
                />
                <Dato etiqueta="Visto en" valor={vistoEn} />
                <Dato etiqueta="Registrado" valor={fechaHoraColombia(detalle.primeraVistoEn)} />
                <Dato etiqueta="Visto por última vez" valor={fechaHoraColombia(detalle.ultimoVistoEn)} />
                <Dato etiqueta="Inactivado" valor={fechaHoraColombia(detalle.inactivadoEn)} />
              </dl>
            </Seccion>

            <Seccion titulo="Gestión">
              <FormularioGestion
                registro={detalle}
                causales={catalogos.listaCausales}
                onGuardado={guardado}
                sucioRef={sucioRef}
              />
            </Seccion>

            <Seccion titulo="Historial">
              <TimelineComparendo eventos={detalle.eventos} />
            </Seccion>
          </>
        )}
      </div>
    </FlitModal>
  );
}
