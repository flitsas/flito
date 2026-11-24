// Árbol lateral de fichas de Ayuda FLITO (Feature #13691 · HU #13896, docs/ux/flito-ayuda.md
// § «HU #13896 · Árbol lateral de fichas (slim)»). Dos niveles, grupo → fichas, con las fichas que el
// usuario ya ve en el índice (`capitulosEnOrdenDeIndice`). `≥ lg`: columna izquierda pegajosa.
// `< lg`: acordeón del kit «Fichas de ayuda», cerrado en cada carga de ficha.
//
// Patrón *disclosure* (no `role="tree"`): un botón por grupo con `aria-expanded`/`aria-controls` y
// la lista plegada con `hidden`. Los grupos desplegados viven en memoria de la SPA (estado de módulo,
// compartido por la columna y el acordeón): sobreviven al cambio de ficha y a ir al índice; se
// pierden al recargar. Sin `localStorage` ni `sessionStorage` (decisión UX).

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import {
  GRUPOS_ORDEN, GRUPO_AYUDA_LABEL, type AyudaGrupo, type EntradaAyuda,
} from '../../content/ayuda/catalogo';
import FlitAcordeon from '../flit/FlitAcordeon';

// ── Memoria de grupos desplegados (módulo; vive lo que vive la SPA) ─────────────────────────────

let desplegados: ReadonlySet<AyudaGrupo> = new Set();
const oyentes = new Set<() => void>();

function fijarDesplegados(siguiente: ReadonlySet<AyudaGrupo>) {
  desplegados = siguiente;
  oyentes.forEach((o) => o());
}

function suscribir(oyente: () => void) {
  oyentes.add(oyente);
  return () => { oyentes.delete(oyente); };
}

const leerDesplegados = () => desplegados;

/** Al abrir una ficha su grupo queda desplegado, aunque el usuario lo hubiera plegado antes. */
export function forzarGrupoDesplegado(grupo: AyudaGrupo) {
  if (desplegados.has(grupo)) return;
  fijarDesplegados(new Set([...desplegados, grupo]));
}

function alternarGrupo(grupo: AyudaGrupo) {
  const siguiente = new Set(desplegados);
  if (siguiente.has(grupo)) siguiente.delete(grupo);
  else siguiente.add(grupo);
  fijarDesplegados(siguiente);
}

function useGruposDesplegados() {
  return useSyncExternalStore(suscribir, leerDesplegados, leerDesplegados);
}

// ── Árbol ───────────────────────────────────────────────────────────────────────────────────────

interface PropsArbol {
  /** Fichas visibles en el orden del índice (`capitulosEnOrdenDeIndice(user)`). */
  fichas: readonly EntradaAyuda[];
  /** Clave de la ficha abierta. */
  actual: string;
  onElegir?: () => void;
}

function GrupoArbol({
  grupo, fichas, actual, abierto, onElegir,
}: { grupo: AyudaGrupo; fichas: EntradaAyuda[]; actual: string; abierto: boolean; onElegir?: () => void }) {
  const idLista = useId();
  return (
    <li>
      <button
        type="button"
        aria-expanded={abierto}
        aria-controls={idLista}
        onClick={() => alternarGrupo(grupo)}
        className="flit-focus flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-semibold transition-colors hover:bg-[color:var(--flit-bg-hover)]"
        style={{ color: 'var(--flit-text-primary)' }}
      >
        <ChevronRight
          aria-hidden="true"
          size={16}
          className="shrink-0 transition-transform motion-reduce:transition-none"
          style={{ color: 'var(--flit-text-muted)', transform: abierto ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span className="min-w-0 break-words">{GRUPO_AYUDA_LABEL[grupo]}</span>
      </button>
      <ul id={idLista} hidden={!abierto} className="mt-0.5 space-y-0.5 pl-6">
        {fichas.map((f) => {
          const activa = f.clave === actual;
          return (
            <li key={f.clave}>
              <Link
                to={`/flito/ayuda/${f.clave}`}
                onClick={onElegir}
                aria-current={activa ? 'page' : undefined}
                className={`flit-focus block break-words rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[color:var(--flit-bg-hover)]${activa ? ' font-semibold' : ''}`}
                // Tinta `--flit-text-primary` y no `--flit-blue-text` (spec UX): el azul sobre el velo
                // del hover y `--flit-bg-app` da 4,15:1 en claro (medido en píxel), bajo el 4.5:1.
                style={activa
                  ? { color: 'var(--flit-text-primary)', background: 'var(--flit-bg-hover)' }
                  : { color: 'var(--flit-text-secondary)' }}
              >
                {f.etiqueta}
              </Link>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function Arbol({ fichas, actual, onElegir }: PropsArbol) {
  const abiertos = useGruposDesplegados();
  const grupos = useMemo(
    () => GRUPOS_ORDEN
      .map((grupo) => ({ grupo, fichas: fichas.filter((f) => f.grupo === grupo) }))
      .filter((g) => g.fichas.length > 0),
    [fichas],
  );
  return (
    <ul className="space-y-0.5">
      {grupos.map((g) => (
        <GrupoArbol
          key={g.grupo}
          grupo={g.grupo}
          fichas={g.fichas}
          actual={actual}
          abierto={abiertos.has(g.grupo)}
          onElegir={onElegir}
        />
      ))}
    </ul>
  );
}

const ROTULO = 'Fichas de ayuda';

/** Columna izquierda (`≥ lg`), pegajosa y con scroll propio, como `TablaContenidoLateral`. */
export function ArbolFichasLateral({ fichas, actual }: PropsArbol) {
  const navRef = useRef<HTMLElement>(null);
  const abiertos = useGruposDesplegados();
  const grupoActual = fichas.find((f) => f.clave === actual)?.grupo;
  const actualVisible = !!grupoActual && abiertos.has(grupoActual);

  // Lleva la ficha actual a la vista DENTRO del árbol (scrollTop del contenedor): no mueve la página
  // ni toca el foco, que sigue en el h1 (o en el #ancla) por la regla de la ficha.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !actualVisible || nav.clientHeight === 0) return;
    const enlace = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!enlace) return;
    const c = nav.getBoundingClientRect();
    const r = enlace.getBoundingClientRect();
    if (r.top < c.top || r.bottom > c.bottom) {
      nav.scrollTop += r.top - c.top - (c.height - r.height) / 2;
    }
  }, [actual, actualVisible]);

  return (
    <nav
      ref={navRef}
      aria-label={ROTULO}
      className="hidden lg:sticky lg:top-24 lg:block lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto"
      data-testid="ayuda-arbol-lateral"
    >
      <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--flit-text-secondary)' }}>
        {ROTULO}
      </p>
      <Arbol fichas={fichas} actual={actual} />
    </nav>
  );
}

/**
 * Acordeón «Fichas de ayuda» (`< lg`). Arranca cerrado: quien lo usa le pone `key` por ficha para
 * que cada carga lo pinte cerrado (su apertura no se recuerda; la de los grupos internos sí).
 */
export function ArbolFichasPlegable({ fichas, actual }: PropsArbol) {
  const [abierto, setAbierto] = useState(false);
  return (
    <div
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px solid var(--flit-border-soft)',
        background: 'var(--flit-bg-card)',
      }}
    >
      <FlitAcordeon
        titulo={ROTULO}
        cantidad={fichas.length}
        abierto={abierto}
        onToggle={() => setAbierto((a) => !a)}
        testId="ayuda-arbol-plegable"
      >
        <nav aria-label={ROTULO} className="pb-2">
          <Arbol fichas={fichas} actual={actual} onElegir={() => setAbierto(false)} />
        </nav>
      </FlitAcordeon>
    </div>
  );
}
