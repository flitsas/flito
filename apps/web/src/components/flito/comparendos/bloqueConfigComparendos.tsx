// FLITO — Comparendos · Configuración: lo que comparten los bloques de parametrización (HU #11633).
//
// La vista de Configuración es una pila de tarjetas independientes —NITs, municipios, y en la HU
// #11634 causales y token—, y «independientes» es la palabra que manda: **cada bloque tiene sus
// CUATRO estados por su cuenta** (cargando, error con reintento, vacío, lleno). Un 500 del catálogo
// de municipios no puede dejar en blanco la tabla de NITs que ya había cargado, porque el operador
// leería eso como que perdió su parametrización.
//
// Ese aislamiento es el motivo de que la carga NO sea un `Promise.all`: aunque cada `catch` fuera
// propio, un `all` publica los resultados a la vez y el bloque que respondió bien se quedaría en
// «cargando» esperando al que falló. Aquí cada bloque es una petición, un estado y un reintento.
//
// **Por qué no se reutiliza `useCatalogo` de `useComparendosLista.ts`:** aquel es privado y de solo
// lectura —alimenta las ETIQUETAS y los selectores del visor— y no expone forma de tocar la lista.
// Aquí la lista se edita, y el resultado de un `POST`/`PATCH` se aplica en sitio sin volver a pedir
// el catálogo entero: refrescar mostraría otra vez el esqueleto y haría parpadear una tabla que el
// operador está mirando. Los dos hooks se parecen; fundirlos obligaría a que el del visor cargara
// con un `setItems` que nadie de allí puede usar sin romper su promesa de «solo etiquetas».

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../../../lib/api';
import StatusChip from '../../flit/StatusChip';
import { FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

/** Raíz del módulo en el API. Todo cuelga de aquí y nadie escribe la URL a mano. */
export const RUTA_COMPARENDOS = '/flito/comparendos';

/** Los cuatro estados se derivan de estos tres más el tamaño de la lista: `ok` + 0 ítems = vacío. */
export type EstadoBloque = 'cargando' | 'error' | 'ok';

export interface CatalogoConfig<T> {
  items: T[];
  estado: EstadoBloque;
  /** Aplica en sitio el resultado de una escritura. No vuelve a pedir la lista (ver cabecera). */
  setItems: (actualizar: (previos: T[]) => T[]) => void;
  recargar: () => void;
}

export function useCatalogoConfig<T>(ruta: string): CatalogoConfig<T> {
  const [items, setItems] = useState<T[]>([]);
  const [estado, setEstado] = useState<EstadoBloque>('cargando');
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vigente = true;
    setEstado('cargando');
    api.get<T[]>(ruta)
      .then((lista) => {
        if (!vigente) return;
        // `Array.isArray` y no `?? []`: un 200 con algo que no es una lista reventaría en el
        // `.map()` del render y se llevaría por delante la vista entera —justo lo contrario del
        // aislamiento que este archivo promete—. Un cuerpo inesperado se trata como lista vacía.
        setItems(Array.isArray(lista) ? lista : []);
        setEstado('ok');
      })
      .catch(() => {
        if (!vigente) return;
        // La lista se VACÍA al fallar: dejar las filas de un intento anterior bajo un mensaje de
        // error sería enseñar como cierto un catálogo que no se pudo confirmar.
        setItems([]);
        setEstado('error');
      });
    return () => { vigente = false; };
  }, [ruta, intento]);

  const recargar = useCallback(() => setIntento((i) => i + 1), []);
  return { items, estado, setItems, recargar };
}

interface PropsBloque {
  /** Encabezado del bloque. Es también su nombre accesible (`role="region"`). */
  titulo: string;
  descripcion: ReactNode;
  /** Acción principal del bloque. Va SIEMPRE en la cabecera; ver el comentario de `accion`. */
  accion: ReactNode;
  estado: EstadoBloque;
  hayItems: boolean;
  /** Copy del estado de error. Propio, nunca el mensaje del servidor (decisión de la #11559). */
  textoError: string;
  /** `aria-label` del esqueleto: «Cargando NITs monitoreados». */
  etiquetaCarga: string;
  vacio: ReactNode;
  onReintentar: () => void;
  children: ReactNode;
}

/**
 * Una tarjeta de parametrización con sus cuatro estados.
 *
 * `role="region"` con nombre: son cuatro tarjetas largas en un mismo scroll y sin regiones un lector
 * de pantalla no puede saltar de una a otra. El nombre sale del propio `<h2>`, así que no puede
 * quedarse desincronizado del título que se ve.
 *
 * **La acción de alta vive SOLO en la cabecera**, también en el estado vacío. El wireframe la pinta
 * dos veces —arriba y dentro del recuadro vacío— y no se hace: serían dos controles con el mismo
 * nombre accesible («Agregar NIT») a un palmo el uno del otro, que para quien navega con lector es
 * una ambigüedad sin ninguna ganancia. El copy del vacío sigue diciendo qué hacer, y el botón está
 * justo encima.
 */
export function BloqueConfig({
  titulo, descripcion, accion, estado, hayItems, textoError, etiquetaCarga, vacio, onReintentar, children,
}: PropsBloque) {
  const idTitulo = `bloque-${titulo.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section role="region" aria-labelledby={idTitulo}>
      <FlitCard>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-3xl">
            <h2 id={idTitulo} className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
              {titulo}
            </h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{descripcion}</p>
          </div>
          {accion}
        </div>

        {/* El orden importa y es el del visor: el ERROR va antes que el vacío. Si la consulta falló
            no se sabe si hay filas, y decir «todavía no hay» sería afirmar algo que nadie comprobó. */}
        {estado === 'cargando' && <EsqueletoBloque etiqueta={etiquetaCarga} />}

        {estado === 'error' && (
          // `role="alert"` como en el visor: el bloque que falla tiene que anunciarse solo, porque
          // quien usa lector de pantalla no va a ir tarjeta por tarjeta comprobando cuál cargó.
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
            {/* `--flit-danger` es color de superficie: como texto de 14px sobre la tarjeta blanca se
                queda en 4,19. La variante tinta (bug #11604) sube a 5,71 sin dejar de ser rojo. */}
            <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{textoError}</p>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>
              Reintentar
            </button>
          </div>
        )}

        {estado === 'ok' && !hayItems && <FlitEmpty>{vacio}</FlitEmpty>}
        {estado === 'ok' && hayItems && children}
      </FlitCard>
    </section>
  );
}

/**
 * Filas fantasma. Cuatro y no un spinner: el spinner obliga a la tarjeta a saltar de alto cuando
 * llegan los datos, y cuatro barras ya insinúan la forma de lo que viene.
 *
 * `role="status"` + `aria-busy` + nombre: quien no ve la pantalla necesita que le digan que ESTE
 * bloque está cargando, y con cuatro bloques en la misma vista el nombre es lo único que distingue
 * cuál.
 */
export function EsqueletoBloque({ etiqueta }: { etiqueta: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={etiqueta}
      className="animate-pulse space-y-2 motion-reduce:animate-none"
    >
      {Array.from({ length: 4 }, (_, fila) => (
        <div key={fila} className="h-9" style={{ background: 'var(--flit-border-soft)', borderRadius: 8 }} />
      ))}
    </div>
  );
}

/**
 * Activo / inactivo con la etiqueta DENTRO del chip.
 *
 * El punto de color es decorativo y `aria-hidden` en `StatusChip`: si el estado se distinguiera solo
 * por el color, la tabla dejaría fuera a quien no lo percibe (y a cualquiera que la imprima).
 * Masculino en los dos catálogos («Inactivo», no «Inactiva») porque el sujeto es «el NIT» y «el
 * municipio»; que coincida además simplifica la lectura de dos tablas seguidas.
 */
export function ChipEstadoConfig({ activo }: { activo: boolean }) {
  return <StatusChip tone={activo ? 'success' : 'neutral'}>{activo ? 'Activo' : 'Inactivo'}</StatusChip>;
}

/**
 * El error de un formulario, bajo el formulario.
 *
 * `role="alert"` para que se anuncie sin tener que ir a buscarlo, y una sola por modal: el spec de
 * QA afirma sobre `getByRole('alert')` y dos alertas simultáneas serían una ambigüedad.
 */
export function ErrorFormulario({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>
      {children}
    </p>
  );
}
