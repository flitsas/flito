// FLITO — Gestión Trámites: navegación del detalle en modal (ADR-0046).
//
// El trámite abierto vive SOLO en memoria (nunca en la URL: AGENTS.md §14). «Anterior» y
// «Siguiente» recorren las filas de la página cargada; en los extremos piden la página vecina con los
// mismos filtros (decisión del humano 2026-11-18) y, cuando esa página llega, abren su primera o su
// última fila. Mientras tanto la modal conserva la instantánea del trámite que estaba mirando.

import { useEffect, useRef, useState } from 'react';
import type { TramiteFila } from '../tiposTramites';

type Pendiente = { hacia: 'primero' | 'ultimo'; filasAlPedir: TramiteFila[] | null } | null;

export interface NavDetalleTramite {
  /** Instantánea del trámite abierto, o null con la modal cerrada. */
  actual: TramiteFila | null;
  /** Posición 1-based dentro del total filtrado; null mientras llega la página vecina. */
  posicion: number | null;
  total: number;
  hayAnterior: boolean;
  haySiguiente: boolean;
  cargandoPagina: boolean;
  abrir: (f: TramiteFila) => void;
  anterior: () => void;
  siguiente: () => void;
  cerrar: () => void;
}

/** Selector del botón «Ver» de una fila: es adonde vuelve el foco al cerrar. */
export const atributoVer = 'data-ver-tramite';

export function useDetalleTramite(
  data: TramiteFila[] | null, page: number, total: number, pageSize: number, setPage: (p: number) => void,
): NavDetalleTramite {
  const [actual, setActual] = useState<TramiteFila | null>(null);
  const [pendiente, setPendiente] = useState<Pendiente>(null);
  const ultimoAbierto = useRef<string | null>(null);
  const filas = data ?? [];
  const totalPaginas = Math.max(1, Math.ceil(total / pageSize));

  // Llega la página vecina pedida (o se recarga la actual tras una acción): se abre su extremo o se
  // refresca la instantánea con la fila nueva del mismo trámite.
  useEffect(() => {
    if (!data) return;
    if (pendiente) {
      if (data === pendiente.filasAlPedir) return; // aún es la página vieja
      setPendiente(null);
      const destino = pendiente.hacia === 'primero' ? data[0] : data[data.length - 1];
      if (destino) setActual(destino);
      return;
    }
    setActual((a) => (a ? data.find((f) => f.tramiteId === a.tramiteId) ?? a : a));
  }, [data, pendiente]);

  useEffect(() => { if (actual) ultimoAbierto.current = actual.tramiteId; }, [actual]);

  const idx = actual && !pendiente ? filas.findIndex((f) => f.tramiteId === actual.tramiteId) : -1;
  const posicion = idx >= 0 ? (page - 1) * pageSize + idx + 1 : null;

  const irPagina = (p: number, hacia: 'primero' | 'ultimo') => {
    setPendiente({ hacia, filasAlPedir: data });
    setPage(p);
  };

  return {
    actual,
    posicion,
    total,
    hayAnterior: idx > 0 || (idx === 0 && page > 1),
    haySiguiente: idx >= 0 && (idx < filas.length - 1 || page < totalPaginas),
    cargandoPagina: pendiente !== null,
    abrir: (f) => { setPendiente(null); setActual(f); },
    anterior: () => {
      if (idx > 0) setActual(filas[idx - 1]);
      else if (idx === 0 && page > 1) irPagina(page - 1, 'ultimo');
    },
    siguiente: () => {
      if (idx >= 0 && idx < filas.length - 1) setActual(filas[idx + 1]);
      else if (idx === filas.length - 1 && page < totalPaginas) irPagina(page + 1, 'primero');
    },
    cerrar: () => {
      const id = ultimoAbierto.current;
      setActual(null); setPendiente(null);
      // Después del desmontaje (que restaura el foco al elemento previo): el foco vuelve al «Ver» de
      // la fila del trámite que se estaba mirando, que puede no ser el que abrió la modal.
      setTimeout(() => {
        const boton = id ? document.querySelector<HTMLElement>(`[${atributoVer}="${CSS.escape(id)}"]`) : null;
        boton?.focus();
      }, 0);
    },
  };
}
