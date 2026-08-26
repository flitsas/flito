// Reporte de costos — ¿cuáles de los trámites de esta página se pueden enviar a facturación
// electrónica? (HU #11329, Feature #11242).
//
// **UN lote por vista, y solo cuando hay algo que preguntar.** Dos compuertas antes de salir a la
// red, y las dos ahorran la petición entera, no parte de ella:
//
//   1. sin la acción `emitir` no se pregunta NUNCA. Un `auditor` no puede enviar nada, así que
//      pagarle una consulta cara en cada carga sería gastar por una acción que no existe para él;
//   2. sin candidatos en la página tampoco. Que un trámite sea candidato se sabe gratis con la
//      columna que la fila ya trae (`estadoLiquidacion === 'facturado'`), que es **la misma** que
//      lee `motivosLocales()` en el servidor — no una regla paralela que se parezca.
//
// **Por qué al cargar y no al seleccionar.** El AC4 dice que lo no elegible «aparece» inhabilitado.
// Preguntar al marcar una casilla —o fila a fila— haría que la acción naciera habilitada y se
// volviera inhabilitada al llegar la respuesta, que es «acabar» inhabilitada y no «aparecer».
//
// **Por qué la caché no es peligrosa: el navegador NO es la compuerta.** La compuerta es el `POST`,
// que vuelve a evaluar y devuelve `no_elegible` con sus motivos. Un veredicto que se quedó viejo
// cuesta, como mucho, una línea en el diálogo de resultados — que es lo que el AC5 ya pinta.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ElegibilidadTramite, ResumenElegibilidad } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';

/**
 * Espeja `TOPE_TRAMITES_ELEGIBILIDAD` de `facturacion.elegibilidad.service.ts`.
 *
 * Con `pageSize = 50` es inalcanzable desde esta pantalla, y aun así se comprueba: si algún día la
 * página crece, el fallo sería un 400 críptico en mitad de un cierre de mes.
 */
export const TOPE_ELEGIBILIDAD = 400;

const SIN_VEREDICTOS: ReadonlyMap<string, ElegibilidadTramite> = new Map();

interface Respuesta { items: ElegibilidadTramite[]; resumen: ResumenElegibilidad }

interface Estado {
  veredictos: ReadonlyMap<string, ElegibilidadTramite>;
  resumen: ResumenElegibilidad | null;
  cargando: boolean;
  error: string | null;
}

const INICIAL: Estado = { veredictos: SIN_VEREDICTOS, resumen: null, cargando: false, error: null };

export interface Elegibilidad extends Estado {
  /** Repite la consulta descartando lo guardado. Es la acción del estado de error (AC2). */
  reintentar: () => void;
}

/**
 * @param candidatos ids de los trámites sobre los que tiene sentido preguntar.
 * @param habilitado `false` = ni una petición (rol sin `emitir`).
 * @param clave la MISMA clave de invalidación del reporte (filtros + página + recarga). Cambiar de
 *   página o de filtro vacía lo guardado: los veredictos son de una vista, no del navegador.
 */
export function useElegibilidadFacturacion(
  candidatos: string[], habilitado: boolean, clave: string,
): Elegibilidad {
  // La lista viaja como cadena para que el efecto dependa de su CONTENIDO y no de la identidad del
  // array, que cambia en cada render del reporte y dispararía una consulta por pintado.
  const idsKey = candidatos.join(',');
  const [estado, setEstado] = useState<Estado>(INICIAL);
  const [intento, setIntento] = useState(0);
  // En una `ref` y no en estado: lo guardado no se pinta, y como estado sería una dependencia del
  // efecto que lo escribe.
  const guardado = useRef<{ clave: string; datos: Estado } | null>(null);

  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',');
    if (!habilitado || ids.length === 0) { setEstado(INICIAL); return; }

    // Caché por trámite: si todos los de esta vista ya tienen veredicto, no se vuelve a preguntar.
    const cache = guardado.current;
    if (cache && cache.clave === clave && ids.every((id) => cache.datos.veredictos.has(id))) {
      setEstado(cache.datos);
      return;
    }

    let vivo = true;
    setEstado({ ...INICIAL, cargando: true });
    // `URLSearchParams` y no interpolar: los identificadores vienen del servidor y hoy son UUID,
    // pero un `&` suelto el día que ese campo cambie de forma partiría la consulta en dos.
    const q = new URLSearchParams({ ids: ids.slice(0, TOPE_ELEGIBILIDAD).join(',') });
    api.get<Respuesta>(`/siigo/elegibilidad/tramites?${q.toString()}`)
      .then((r) => {
        if (!vivo) return;
        const datos: Estado = {
          veredictos: new Map(r.items.map((i) => [i.tramiteId, i])),
          resumen: r.resumen, cargando: false, error: null,
        };
        guardado.current = { clave, datos };
        setEstado(datos);
      })
      .catch((e) => {
        if (!vivo) return;
        // El fallo NO se traga con un mapa vacío que pareciera «ninguno es elegible»: son cosas
        // distintas, y afirmar la segunda cuando pasó la primera manda a alguien a arreglar un
        // problema que no existe. Por eso el estado de error se pinta antes que el de vacío.
        guardado.current = null;
        setEstado({ ...INICIAL, error: errorMessage(e) });
      });
    return () => { vivo = false; };
  }, [habilitado, idsKey, clave, intento]);

  const reintentar = useCallback(() => {
    guardado.current = null;
    setIntento((n) => n + 1);
  }, []);

  return { ...estado, reintentar };
}
