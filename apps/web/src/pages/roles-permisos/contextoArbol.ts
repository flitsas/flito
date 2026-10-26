// HU #13430 — Lo que comparten todas las filas del árbol de permisos (sin pasarlo nivel a nivel).
import { createContext, useContext } from 'react';
import type { Efecto, Indice, TratoExclusivas } from './arbol';

export type ModoArbol =
  | { tipo: 'rol'; rolNombre: string }
  | {
    tipo: 'usuario';
    /** Quién es (para los `sr-only` «· usuario {quien}»). Nunca va a la URL ni a la consola. */
    quien: string;
    /** Lo que trae el rol (sin excepciones). */
    rol: ReadonlySet<string>;
    excepciones: ReadonlyMap<string, Efecto>;
  };

export interface ContextoArbol {
  indice: Indice;
  /** Lo que se pinta marcado: el borrador del rol o el conjunto efectivo del usuario. */
  marcados: ReadonlySet<string>;
  modo: ModoArbol;
  editable: boolean;
  /** R6: mientras no haya cambios, el inactivo de los opcionales lo dice el servidor. */
  usarEfectivoServidor: boolean;
  abiertos: ReadonlySet<string>;
  alternarAbierto: (codigo: string) => void;
  onToggle: (codigo: string) => void;
  onConjunto?: (codigos: string[], marcar: boolean) => void;
  registrarInput: (codigo: string, el: HTMLInputElement | null) => void;
  /** Prefijo de ids (de `useId`), para enlazar `aria-describedby` sin colisiones entre árboles. */
  idBase: string;
  /**
   * HU #13452: nodos que el enlace del rol cierra → código del ítem que lleva la nota. Se pintan
   * deshabilitados. Vacío (o ausente) fuera del panel de un rol con enlace.
   */
  cerrados?: ReadonlyMap<string, string>;
  /** La nota de una línea del ítem cerrado; solo con `cerrados` no vacío. */
  notaCerrado?: string;
  /**
   * HU #13951: trato de las funciones exclusivas del Administrador. `fuera` = otro rol (bloqueadas
   * desmarcadas, no cuentan), `fija` = el Administrador (bloqueadas marcadas). Ausente en modo usuario.
   */
  exclusivas?: TratoExclusivas;
}

export const ArbolCtx = createContext<ContextoArbol | null>(null);

export function useArbol(): ContextoArbol {
  const c = useContext(ArbolCtx);
  if (!c) throw new Error('useArbol fuera de <ArbolPermisos>');
  return c;
}

/** Id estable de una pieza de un nodo (`desc`, `cuenta`, `expl`…). Los códigos llevan puntos: se limpian. */
export const idDe = (base: string, pieza: string, codigo: string) => `${base}-${pieza}-${codigo.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

export const sufijoQuien = (modo: ModoArbol) => (modo.tipo === 'rol' ? `rol ${modo.rolNombre}` : `usuario ${modo.quien}`);
