// HU #13430 (Feature #13416) — El árbol de permisos en tres niveles: el mismo componente para el rol
// (Roles y permisos) y para el usuario (modal Editar / Nuevo usuario, AC4).
//
// Diseño: `docs/ux/hu-13430-delta-contrato-arbol.md` (manda) + `docs/ux/hu-13430-panel-tres-niveles.md`.
// Una sola lista: los elementos del menú (Ayuda sin casilla, en su sitio). HU #13589: ya no hay bloque de
// transversales (P-29 retirado por P-35..P-37). Todo plegado al montar; el padre remonta el árbol con
// `key` al cambiar de rol.
//
// «Mostrar dónde está» (AC5): `foco` despliega los ancestros del código y le pone el foco a su casilla;
// si esa casilla está inactiva, al ancestro desmarcado más alto (el que hay que tocar).

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ancestroFaltante, type Indice, type Nodo, type TratoExclusivas } from './arbol';
import { ArbolCtx, type ContextoArbol, type ModoArbol } from './contextoArbol';
import { FilaNodo } from './NodoArbol';

export interface FocoArbol { codigo: string; token: number }

interface Props {
  arbol: readonly Nodo[];
  indice: Indice;
  marcados: ReadonlySet<string>;
  modo: ModoArbol;
  editable: boolean;
  onToggle: (codigo: string) => void;
  onConjunto?: (codigos: string[], marcar: boolean) => void;
  abiertosIniciales?: Iterable<string>;
  foco?: FocoArbol | null;
  usarEfectivoServidor?: boolean;
  /** HU #13452: nodos cerrados por el enlace del rol (deshabilitados, con nota en el ítem). */
  cerrados?: ReadonlyMap<string, string>;
  notaCerrado?: string;
  /** HU #13951: trato de las exclusivas del Administrador (solo en el panel de un rol). */
  exclusivas?: TratoExclusivas;
}

export default function ArbolPermisos({
  arbol, indice, marcados, modo, editable, onToggle, onConjunto, abiertosIniciales, foco, usarEfectivoServidor = false,
  cerrados, notaCerrado, exclusivas,
}: Props) {
  const idBase = useId();
  const [abiertos, setAbiertos] = useState<Set<string>>(() => new Set(abiertosIniciales ?? []));
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [pendiente, setPendiente] = useState<string | null>(null);

  const alternarAbierto = useCallback((codigo: string) => setAbiertos((prev) => {
    const s = new Set(prev);
    if (s.has(codigo)) s.delete(codigo); else s.add(codigo);
    return s;
  }), []);
  const registrarInput = useCallback((codigo: string, el: HTMLInputElement | null) => {
    if (el) inputs.current.set(codigo, el); else inputs.current.delete(codigo);
  }, []);

  useEffect(() => {
    if (!foco) return;
    const ancestros = indice.ancestros.get(foco.codigo) ?? [];
    setAbiertos((prev) => new Set([...prev, ...ancestros]));
    setPendiente(foco.codigo);
  }, [foco, indice]);

  useEffect(() => {
    if (!pendiente) return;
    let destino = inputs.current.get(pendiente);
    if (destino?.disabled) {
      const arriba = ancestroFaltante(pendiente, marcados, indice);
      if (arriba) destino = inputs.current.get(arriba.codigo);
    }
    destino?.focus();
    destino?.scrollIntoView?.({ block: 'center' });
    setPendiente(null);
  }, [pendiente, abiertos, marcados, indice]);

  const ctx = useMemo<ContextoArbol>(() => ({
    indice, marcados, modo, editable, usarEfectivoServidor, abiertos, alternarAbierto, onToggle, onConjunto, registrarInput, idBase,
    cerrados, notaCerrado, exclusivas,
  }), [indice, marcados, modo, editable, usarEfectivoServidor, abiertos, alternarAbierto, onToggle, onConjunto, registrarInput, idBase, cerrados, notaCerrado, exclusivas]);

  return (
    <ArbolCtx.Provider value={ctx}>
      <ul role="list" className="flex min-w-0 flex-col">
        {arbol.map((n) => <FilaNodo key={n.codigo} nodo={n} />)}
      </ul>
    </ArbolCtx.Provider>
  );
}
