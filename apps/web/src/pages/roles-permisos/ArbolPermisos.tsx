// HU #13430 (Feature #13416) — El árbol de permisos en tres niveles: el mismo componente para el rol
// (Roles y permisos) y para el usuario (modal Editar / Nuevo usuario, AC4).
//
// Diseño: `docs/ux/hu-13430-delta-contrato-arbol.md` (manda) + `docs/ux/hu-13430-panel-tres-niveles.md`.
// Una sola lista: los 12 elementos del menú (Ayuda sin casilla, en su sitio) y, al final, el bloque de
// transversales (P-29), con forma de elemento pero sin casilla propia. Todo plegado al montar; el padre
// remonta el árbol con `key` al cambiar de rol.
//
// «Mostrar dónde está» (AC5): `foco` despliega los ancestros del código y le pone el foco a su casilla;
// si esa casilla está inactiva, al ancestro desmarcado más alto (el que hay que tocar).

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { TITULO_TRANSVERSALES, COPY_TRANSVERSALES, ancestroFaltante, cuentaDe, resumenExcepciones, textoCuenta, textoExcepciones, type Indice, type Nodo } from './arbol';
import { ArbolCtx, idDe, sufijoQuien, useArbol, type ContextoArbol, type ModoArbol } from './contextoArbol';
import { BotonDesplegar, ContenedorPanel, FilaNodo, Hueco } from './NodoArbol';

/** Clave de apertura del bloque de transversales (no es un código del catálogo). */
export const CLAVE_TRANSVERSALES = '__transversales';

export interface FocoArbol { codigo: string; token: number }

interface Props {
  arbol: readonly Nodo[];
  transversales: readonly Nodo[];
  indice: Indice;
  marcados: ReadonlySet<string>;
  modo: ModoArbol;
  editable: boolean;
  onToggle: (codigo: string) => void;
  onConjunto?: (codigos: string[], marcar: boolean) => void;
  abiertosIniciales?: Iterable<string>;
  foco?: FocoArbol | null;
  usarEfectivoServidor?: boolean;
}

export default function ArbolPermisos({
  arbol, transversales, indice, marcados, modo, editable, onToggle, onConjunto, abiertosIniciales, foco, usarEfectivoServidor = false,
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
    const esTransversal = transversales.some((t) => t.codigo === foco.codigo);
    const ancestros = indice.ancestros.get(foco.codigo) ?? [];
    setAbiertos((prev) => new Set([...prev, ...ancestros, ...(esTransversal ? [CLAVE_TRANSVERSALES] : [])]));
    setPendiente(foco.codigo);
  }, [foco, indice, transversales]);

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
  }), [indice, marcados, modo, editable, usarEfectivoServidor, abiertos, alternarAbierto, onToggle, onConjunto, registrarInput, idBase]);

  return (
    <ArbolCtx.Provider value={ctx}>
      <ul role="list" className="flex min-w-0 flex-col">
        {arbol.map((n) => <FilaNodo key={n.codigo} nodo={n} />)}
        {transversales.length > 0 && <BloqueTransversales transversales={transversales} />}
      </ul>
    </ArbolCtx.Provider>
  );
}

/** Un nodo raíz ficticio para contar los transversales con la misma regla que un elemento. */
const raizTransversales = (hijos: readonly Nodo[]): Nodo => ({
  codigo: CLAVE_TRANSVERSALES, nombre: TITULO_TRANSVERSALES, tipo: 'elemento', padre: null, orden: 0, hijos: [...hijos],
});

/** P-29: la última fila de la tarjeta, sin casilla propia; sus filas son casillas planas, nunca inactivas. */
function BloqueTransversales({ transversales }: { transversales: readonly Nodo[] }) {
  const { abiertos, alternarAbierto, marcados, modo, indice, idBase } = useArbol();
  const abierto = abiertos.has(CLAVE_TRANSVERSALES);
  const panelId = idDe(idBase, 'panel', CLAVE_TRANSVERSALES);
  const codigos = transversales.map((t) => t.codigo);
  const meta = modo.tipo === 'rol'
    ? textoCuenta(cuentaDe(raizTransversales(transversales), marcados), false, false)
    : textoExcepciones(resumenExcepciones(codigos, modo.rol, modo.excepciones, indice));
  return (
    <li className="border-t py-3" style={{ borderColor: 'var(--flit-border-soft)' }} data-codigo-fila={CLAVE_TRANSVERSALES}>
      <div className="flex items-start gap-1">
        <BotonDesplegar nombre={TITULO_TRANSVERSALES} abierto={abierto} panelId={panelId} onClick={() => alternarAbierto(CLAVE_TRANSVERSALES)} />
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 px-1 py-1">
          <span className="flex min-w-0 flex-[1_1_12rem] items-start gap-3">
            <Hueco ancho="casilla" />
            <span className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>{TITULO_TRANSVERSALES}</span>
          </span>
          {meta && <span className="pl-7 text-xs tabular-nums sm:ml-auto sm:pl-0" style={{ color: 'var(--flit-text-secondary)' }}>{meta}</span>}
        </div>
      </div>
      {abierto && (
        <ContenedorPanel id={panelId} leyenda={`${TITULO_TRANSVERSALES} · ${sufijoQuien(modo)}`}>
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{COPY_TRANSVERSALES}</p>
          <ul role="list" className="flex flex-col">
            {transversales.map((t) => <FilaNodo key={t.codigo} nodo={t} />)}
          </ul>
        </ContenedorPanel>
      )}
    </li>
  );
}
