// FLITO — Comparendos: las tres pestañas de la pantalla y el marco que comparten (HU #11633).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// POR QUÉ PESTAÑAS Y NO RUTAS
//
// `/flito/comparendos` es UNA página con UN permiso (`flito_comparendos`, solo `admin`) y tres
// trabajos distintos encima: mirar el consolidado, disparar la sincronización y parametrizar lo que
// esa sincronización consulta. La spec de UX (`docs/ux/flito-comparendos-config-sync.md`) cierra la
// discusión: pestañas en la misma página, no subrutas —que exigirían otra entrada en `App.tsx` y
// otro `lazy` para el mismo permiso— y no un scroll único de tres pantallas.
//
// Lo que sí necesita cada pestaña es un DESTINO ESTABLE: el vacío del visor va a ofrecer «Ir a la
// sincronización» (HU #11637) y un correo interno tiene que poder apuntar a la configuración. De ahí
// `?vista=`, que es estado de NAVEGACIÓN y no un dato: `vista` no es PII (AGENTS.md §14) y puede
// viajar en la URL. El NIT, el alias y la placa NO, y por eso ningún control de esta pantalla
// escribe nada más en la query.
//
// Tres decisiones de cableado que no son evidentes al leer el JSX:
//
//   1. **El default OMITE el parámetro.** Volver a Registros borra `vista` en lugar de escribir
//      `?vista=registros`: la URL que el operador usa a diario es la corta, y ensuciarla haría que
//      cada copia-y-pega de la pantalla llevara un parámetro que no dice nada.
//   2. **Se navega con `replace`.** Las pills no son sitios distintos sino secciones de la misma
//      pantalla; apilar una entrada de historial por clic obligaría a pulsar «atrás» cuatro veces
//      para salir de una pantalla en la que solo se estuvo una vez. Los demás parámetros de la
//      query se conservan tal cual (se copia el `URLSearchParams` previo).
//   3. **El marco lo pinta LA VISTA, no la página.** Es al revés de lo que parece natural, y el
//      motivo es la cabecera: el botón de exportar del visor vive en el slot de acciones del
//      `PageHeaderCard` (HU #11561) y solo la vista de Registros puede construirlo —necesita los
//      criterios APLICADOS, que viven en su hook—. Con la cabecera en la página habría que izar
//      `useComparendosLista` hasta ahí, y entonces entrar a Configuración dispararía una consulta
//      del listado que nadie pidió. Así, cada vista monta el marco con SUS acciones y el resto del
//      marco es idéntico porque lo escribe este archivo una sola vez.
//
// Consecuencia del punto 3 que hay que atender a mano: al cambiar de pestaña, el marco entero se
// desmonta y se vuelve a montar, así que **el foco se caería a `<body>`**. Por eso `nav` lleva un
// campo `foco` que dice a dónde tiene que ir el foco en el próximo montaje — al panel (clic) o a la
// pestaña activa (flechas del teclado, que en el patrón ARIA de tabs mueven foco Y selección sin
// abandonar el tablist).
// ══════════════════════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeaderCard from '../../flit/PageHeaderCard';
import { FlitPillGroup, flitPillBtn, flitPillBtnClase } from '../../flit/flitPageKit';

export type VistaComparendos = 'registros' | 'sincronizacion' | 'configuracion';

/** El orden es el de las pills y el de las flechas del teclado: de lo operativo a lo que se toca poco. */
export const VISTAS: { valor: VistaComparendos; etiqueta: string }[] = [
  { valor: 'registros', etiqueta: 'Registros' },
  { valor: 'sincronizacion', etiqueta: 'Sincronización' },
  { valor: 'configuracion', etiqueta: 'Configuración' },
];

export const PARAM_VISTA = 'vista';

const TITULO = 'Comparendos monitoreados';

/**
 * El subtítulo es lo único de la cabecera que cambia con la pestaña, y cambia porque las tres
 * pantallas responden preguntas distintas. El de Registros es el de la HU #11560, palabra por
 * palabra: cambiarlo aquí sería reescribir el visor desde una HU que no lo toca.
 */
const SUBTITULO: Record<VistaComparendos, string> = {
  registros:
    'Lo que SIMIT y los municipios reportan de los NIT que se vigilan. Los datos vienen de la fuente '
    + 'y no se editan aquí: lo único que se registra es la causal y la observación de gestión.',
  sincronizacion:
    'Consulta SIMIT y los municipios activos sobre los NIT vigilados. No hay corrida automática: '
    + 'cada sincronización la disparas tú.',
  configuracion:
    'NIT vigilados, municipios fuente, causales de gestión y el token SIMIT. Sin esto, la '
    + 'sincronización no tiene qué consultar.',
};

/**
 * La vista que pide la URL, o Registros.
 *
 * Un valor que no está en la lista NO abre una sección vacía ni un error: cae a Registros, que es la
 * pantalla que el operador venía a ver. La comprobación se hace contra `VISTAS` y no con un `if`
 * por valor para que añadir la cuarta pestaña no exija acordarse de este archivo.
 */
export function leerVista(valor: string | null | undefined): VistaComparendos {
  const encontrada = VISTAS.find((v) => v.valor === valor);
  return encontrada ? encontrada.valor : 'registros';
}

/** A dónde va el foco en el próximo montaje del marco. Ver el comentario de cabecera, punto 3. */
export type FocoTrasCambiar = 'ninguno' | 'panel' | 'pestana';

export interface NavComparendos {
  vista: VistaComparendos;
  /** Cambia de pestaña. `foco` es 'panel' por defecto: el clic lleva al contenido. */
  cambiar: (vista: VistaComparendos, foco?: FocoTrasCambiar) => void;
  foco: FocoTrasCambiar;
}

export function useNavComparendos(): NavComparendos {
  const [params, setParams] = useSearchParams();
  const vista = leerVista(params.get(PARAM_VISTA));
  // Arranca en 'ninguno' a propósito: al ENTRAR a la pantalla nadie ha cambiado de pestaña, y robar
  // el foco al cargar una página es de las cosas que más molestan a quien navega con teclado.
  const [foco, setFoco] = useState<FocoTrasCambiar>('ninguno');

  const cambiar = useCallback((destino: VistaComparendos, comoEnfocar: FocoTrasCambiar = 'panel') => {
    setFoco(comoEnfocar);
    setParams((previos) => {
      const siguientes = new URLSearchParams(previos);
      if (destino === 'registros') siguientes.delete(PARAM_VISTA);
      else siguientes.set(PARAM_VISTA, destino);
      return siguientes;
    }, { replace: true });
  }, [setParams]);

  return useMemo(() => ({ vista, cambiar, foco }), [vista, cambiar, foco]);
}

interface PropsMarco {
  nav: NavComparendos;
  /** Slot de acciones de la cabecera. Hoy solo lo usa Registros (exportar a Excel). */
  acciones?: ReactNode;
  children: ReactNode;
}

/**
 * Cabecera + pestañas + panel. Lo monta cada vista con sus propias acciones (ver punto 3 arriba).
 *
 * A11y del patrón de pestañas:
 *   · `role="tablist"` con nombre, `role="tab"` con `aria-selected`, panel con `role="tabpanel"`
 *     etiquetado por su pestaña.
 *   · `tabIndex` itinerante: solo la pestaña activa está en el orden de tabulación, y las flechas
 *     ←/→ (y Inicio/Fin) mueven entre pestañas. Sin esto, un grupo de pestañas mete tres paradas de
 *     tabulador antes del contenido.
 *   · `aria-controls` **solo en la pestaña activa**: el panel de las otras dos no existe en el DOM
 *     —montar los tres sería pedir el listado y los catálogos a la vez— y apuntar a un `id` que no
 *     está es una referencia rota que axe marca (`aria-valid-attr-value`).
 */
export function MarcoComparendos({ nav, acciones, children }: PropsMarco) {
  const tituloPanelRef = useRef<HTMLHeadingElement>(null);
  const pestanaActivaRef = useRef<HTMLButtonElement>(null);

  // El foco se coloca AL MONTAR, que es cuando se acaba de cambiar de pestaña (el marco se monta con
  // su vista). Depender de `nav.foco` y no de una lista vacía no es cosmética: es lo que hace que
  // volver a pulsar la pestaña ya activa —que no desmonta nada— también devuelva el foco al panel.
  useEffect(() => {
    if (nav.foco === 'panel') tituloPanelRef.current?.focus();
    else if (nav.foco === 'pestana') pestanaActivaRef.current?.focus();
  }, [nav.foco]);

  const alTeclear = (e: KeyboardEvent<HTMLButtonElement>, indice: number) => {
    const salto = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const destino = salto !== 0
      ? (indice + salto + VISTAS.length) % VISTAS.length
      : e.key === 'Home' ? 0
        : e.key === 'End' ? VISTAS.length - 1
          : -1;
    if (destino < 0) return;
    // Sin esto, ←/→ desplazarían la página además de cambiar de pestaña.
    e.preventDefault();
    nav.cambiar(VISTAS[destino].valor, 'pestana');
  };

  return (
    <div className="space-y-4">
      <PageHeaderCard title={TITULO} subtitle={SUBTITULO[nav.vista]} actions={acciones} />

      <FlitPillGroup role="tablist" label="Secciones de comparendos">
        {VISTAS.map((v, indice) => {
          const activa = v.valor === nav.vista;
          return (
            <button
              key={v.valor}
              ref={activa ? pestanaActivaRef : undefined}
              type="button"
              role="tab"
              id={`tab-${v.valor}`}
              aria-selected={activa}
              aria-controls={activa ? `panel-${v.valor}` : undefined}
              tabIndex={activa ? 0 : -1}
              onClick={() => nav.cambiar(v.valor)}
              onKeyDown={(e) => alTeclear(e, indice)}
              className={flitPillBtnClase}
              style={flitPillBtn(activa)}
            >
              {v.etiqueta}
            </button>
          );
        })}
      </FlitPillGroup>

      <div
        role="tabpanel"
        id={`panel-${nav.vista}`}
        aria-labelledby={`tab-${nav.vista}`}
        className="space-y-4"
      >
        {/* Destino del foco al cambiar de pestaña, y encabezado del panel.
            Es un `h2` y no el propio panel porque lo que hay que anunciar es DÓNDE se ha llegado, y
            un contenedor enfocado no dice nada; además deja el panel fuera del orden de lectura
            duplicado. `sr-only focus:not-sr-only`: no ocupa sitio —la cabecera ya nombra la
            pantalla— pero se hace visible al recibir el foco, porque un elemento enfocado que no se
            ve incumple «foco visible» para quien navega con teclado sin lector. Es el mismo patrón
            del encabezado de resultados del visor. */}
        <h2
          ref={tituloPanelRef}
          tabIndex={-1}
          className="flit-focus sr-only rounded focus:not-sr-only focus:block focus:text-sm focus:font-semibold"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          {VISTAS.find((v) => v.valor === nav.vista)?.etiqueta}
        </h2>
        {children}
      </div>
    </div>
  );
}
