// La consulta de la bandeja: criterios, paginación, los cuatro estados y el parche local (AC2, AC5).
//
// **Los filtros viajan en el CUERPO de un POST y no en la query** (AGENTS.md §14): `clientes`
// identifica titulares, y una URL la escribe entera el access log del proxy, la guarda el historial
// del navegador y viaja en el `Referer` de la petición siguiente. La paginación sí va en la query:
// no identifica a nadie. El router del servidor está construido sobre ese mismo reparto.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SiigoBandejaFiltro, SiigoBandejaItem, SiigoBandejaPagina } from '@operaciones/shared-types';
import { api, errorMessage } from '../../../lib/api';
import { claveCaso, type CriteriosBandeja } from './tipos';

/** Cuántos casos por página. Por debajo del tope del servidor (100) y de su valor por defecto. */
export const CASOS_POR_PAGINA = 25;

export interface Bandeja {
  items: SiigoBandejaItem[];
  hayMas: boolean;
  cargando: boolean;
  error: string | null;
  /**
   * Casos cuya fila lleva un cambio que el servidor ya confirmó pero que la consulta todavía no ha
   * vuelto a leer. Se marcan en la lista: hacerlos desaparecer sería quitar de la vista la prueba de
   * lo que se acaba de hacer, justo cuando alguien quiere comprobarlo.
   */
  tocados: Set<string>;
  recargar: () => void;
  /** AC5 — «sin recargar la pantalla»: la fila se sustituye en sitio con lo que el servidor afirmó. */
  parchear: (item: SiigoBandejaItem) => void;
}

function cuerpoDe(c: CriteriosBandeja): SiigoBandejaFiltro {
  const cuerpo: SiigoBandejaFiltro = {};
  if (c.fuente) cuerpo.fuentes = [c.fuente];
  if (c.codigo) cuerpo.codigos = [c.codigo];
  if (c.clienteId !== null) cuerpo.clientes = [c.clienteId];
  if (c.antiguedadDiasMin !== null) cuerpo.antiguedadDiasMin = c.antiguedadDiasMin;
  if (c.vista === 'con_descartados') cuerpo.incluirDescartados = true;
  return cuerpo;
}

export function useBandejaFallidos(criterios: CriteriosBandeja, pagina: number): Bandeja {
  const [items, setItems] = useState<SiigoBandejaItem[]>([]);
  const [hayMas, setHayMas] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tocados, setTocados] = useState<Set<string>>(() => new Set());
  const [recarga, setRecarga] = useState(0);

  // Cada consulta se numera: la respuesta de una búsqueda que ya no es la vigente se descarta. Sin
  // esto, cambiar de filtro dos veces seguidas puede dejar en pantalla el resultado del primero.
  const vigente = useRef(0);

  useEffect(() => {
    const turno = ++vigente.current;
    setCargando(true);
    setError(null);
    const offset = pagina * CASOS_POR_PAGINA;
    api.post<SiigoBandejaPagina>(
      `/siigo/bandeja/buscar?limite=${CASOS_POR_PAGINA}&offset=${offset}`,
      cuerpoDe(criterios),
    ).then((p) => {
      if (turno !== vigente.current) return;
      setItems(p.items);
      setHayMas(p.hayMas);
      // Lo que se acaba de leer del servidor ya no es un parche: la marca se retira sola.
      setTocados(new Set());
      setCargando(false);
    }).catch((e) => {
      if (turno !== vigente.current) return;
      setError(errorMessage(e));
      // El error NO deja la lista anterior a medias: si la consulta falló no se sabe qué hay, y
      // pintar filas viejas bajo un error nuevo invita a operar sobre datos de otro momento.
      setItems([]);
      setHayMas(false);
      setCargando(false);
    });
  }, [criterios, pagina, recarga]);

  const recargar = useCallback(() => setRecarga((n) => n + 1), []);

  const parchear = useCallback((nuevo: SiigoBandejaItem) => {
    const clave = claveCaso(nuevo);
    setItems((previos) => previos.map((it) => (claveCaso(it) === clave ? nuevo : it)));
    setTocados((previos) => new Set(previos).add(clave));
  }, []);

  return { items, hayMas, cargando, error, tocados, recargar, parchear };
}
