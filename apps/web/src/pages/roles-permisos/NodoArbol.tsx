// HU #13430 — Una fila del árbol de permisos (elemento, ítem, acción u opcional) y su panel.
//
// Patrón (ficha full «Accesibilidad»): listas anidadas con `fieldset` + casillas nativas + botón de
// desplegar (disclosure), no `role="tree"`. Plegado, el panel se DESMONTA (nada oculto en el orden de
// tabulación). Tri-estado: `indeterminate` por ref y `aria-checked="mixed"` solo en el parcial.
// `aria-describedby` en el orden de la ficha: descripción → nota exclusiva (#13951) → cuenta → explicación → origen.
// Colores solo por token del kit (`--color-*`, `--kit-*`); gris = inactivo, nunca `opacity` (decisión 30 de #12717).
// Rediseño 2026 (Épica #14560): el árbol se viste como la matriz del kit — filas con línea, hover `--kit-hover`.

import { useEffect, useRef, type ReactNode } from 'react';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../components/flit/flitPageKit';
import { Icono } from '../../components/flit/kit/Icono';
import {
  COPY_AYUDA_DERIVADA, COPY_EXPLICACION_SIN_PANTALLAS, COPY_SIN_PANTALLAS, ancestroDesmarcadoCercano, ancestroFaltante, avisoSinAcciones, codigosDesmarcarTodo,
  codigosMarcarTodo, cuentaDe, descendientes, elementoSinPantallas, estadoDe, esHoja, explicacionDesmarcado, explicacionElementoAntiguo,
  explicacionItemAntiguo, fraseSinEfecto, inactivo, itemsSinAcciones, noOpcionales, notaExclusiva, opcionalesDe, origenDe,
  resumenExcepciones, rotuloOpcional, sinAcciones, sufijoSinAcciones, textoCuenta, textoExcepciones,
  type EstadoCasilla, type Nodo, type Origen,
} from './arbol';
import { idDe, sufijoQuien, useArbol } from './contextoArbol';
import { ordenDeSubgrupos, subgrupoDePagina } from '../../components/shell/sectionMeta';

const SECUNDARIO = { color: 'var(--color-text-secondary)' } as const;
const LINEA = { borderColor: 'var(--color-border)' } as const;

export function BotonDesplegar({ nombre, abierto, panelId, onClick }: { nombre: string; abierto: boolean; panelId: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flit-focus grid h-7 w-7 shrink-0 place-items-center rounded-[9px] transition-colors hover:bg-[var(--kit-hover)]"
      aria-expanded={abierto}
      aria-controls={panelId}
      aria-label={`Contenido de ${nombre}`}
      onClick={onClick}
    >
      <Icono
        nombre="derecha"
        size={14}
        className="transition-transform motion-reduce:transition-none"
        style={{ color: 'var(--color-action)', transform: abierto ? 'rotate(90deg)' : 'rotate(0deg)' }}
      />
    </button>
  );
}

/** Hueco del chevron (nodo sin hijos) o de la casilla (Ayuda): alinea los nombres. */
export const Hueco = ({ ancho }: { ancho: 'chevron' | 'casilla' }) => (
  <span aria-hidden="true" className={ancho === 'chevron' ? 'h-7 w-7 shrink-0' : 'h-4 w-4 shrink-0'} />
);

function CasillaTri({ codigo, estado, deshabilitada, bloqueada = false, describedBy, inputRef, onChange }: {
  codigo: string; estado: EstadoCasilla; deshabilitada: boolean; describedBy?: string;
  /** HU #13951 (AC4): `aria-disabled` en vez de `disabled` — sigue enfocable y lee su nota; no cambia. */
  bloqueada?: boolean;
  inputRef: (el: HTMLInputElement | null) => void; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const parcial = estado === 'parcial';
  useEffect(() => { if (ref.current) ref.current.indeterminate = parcial; }, [parcial]);
  return (
    <input
      ref={(el) => { ref.current = el; inputRef(el); }}
      type="checkbox"
      className="flit-focus mt-0.5 h-[18px] w-[18px] shrink-0 accent-[var(--color-action)] disabled:cursor-not-allowed aria-disabled:cursor-not-allowed"
      data-codigo={codigo}
      data-estado={estado}
      checked={estado === 'marcada'}
      aria-checked={parcial ? 'mixed' : undefined}
      disabled={bloqueada ? undefined : deshabilitada}
      aria-disabled={bloqueada ? true : undefined}
      aria-describedby={describedBy}
      onChange={bloqueada ? () => undefined : onChange}
    />
  );
}

const ETIQUETA_ORIGEN: Record<Origen, string> = {
  rol: 'Del rol', no_lo_trae: 'No lo trae', anadido: 'Añadido', anadido_ya_rol: 'Añadido · ya lo trae el rol',
  anadido_sin_efecto: 'Añadido', quitado: 'Quitado',
};

function EtiquetaOrigen({ id, origen, elemento }: { id: string; origen: Origen; elemento: boolean }) {
  if (origen === 'no_lo_trae' && !elemento) return null;
  const resalta = origen === 'anadido' || origen === 'quitado' || origen === 'anadido_sin_efecto';
  return (
    <span id={id} style={resalta ? { color: 'var(--color-action)' } : SECUNDARIO} className={resalta ? 'font-semibold' : undefined}>
      {ETIQUETA_ORIGEN[origen]}
      {origen === 'anadido_sin_efecto' && <span className="font-normal" style={SECUNDARIO}> · sin efecto</span>}
    </span>
  );
}

/** «Ayuda»: derivada, sin casilla, sin chevron, sin cuenta y sin hover (no es un control). */
export function FilaAyuda({ nodo }: { nodo: Nodo }) {
  return (
    <li className="border-t px-2 py-3 sm:px-3" style={LINEA} data-codigo-fila={nodo.codigo}>
      <div className="flex items-start gap-1">
        <Hueco ancho="chevron" />
        <div className="flex min-w-0 flex-1 items-start gap-3 px-1 py-1">
          <Hueco ancho="casilla" />
          <div className="min-w-0">
            <p className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>{nodo.nombre}</p>
            <p className="mt-0.5 text-sm" style={SECUNDARIO}>{COPY_AYUDA_DERIVADA}</p>
          </div>
        </div>
      </div>
    </li>
  );
}

export function FilaNodo({ nodo, padre, idRotulo }: { nodo: Nodo; padre?: Nodo; idRotulo?: string }) {
  const ctx = useArbol();
  const { marcados, indice, modo, editable, idBase } = ctx;
  if (nodo.derivado) return <FilaAyuda nodo={nodo} />;

  const esElemento = nodo.tipo === 'elemento';
  const tieneHijos = nodo.hijos.length > 0;
  const abierto = tieneHijos && ctx.abiertos.has(nodo.codigo);
  const marcado = marcados.has(nodo.codigo);
  // HU #13951: trato de las exclusivas del Administrador (panel del rol; HU #13970 también el del usuario).
  const trato = ctx.exclusivas;
  const exclusiva = trato !== undefined && nodo.exclusivaAdmin === true;
  const estado = estadoDe(nodo, marcados, trato);
  const hoja = esHoja(nodo, trato);
  let estaInactivo = inactivo(nodo.codigo, marcados, indice);
  // R6 (delta §2): el opcional con dos padres solo es fiable con el `efectivo` del servidor; sin cambios, manda ese.
  if (ctx.usarEfectivoServidor && nodo.opcional && marcado && nodo.efectivoServidor !== undefined) estaInactivo = !nodo.efectivoServidor;
  // HU #13452: cerrado por el enlace del rol → deshabilitado; la nota la lleva el ítem que lo cierra.
  const cerradoPor = ctx.cerrados?.get(nodo.codigo) ?? null;
  const deshabilitada = exclusiva || !editable || estaInactivo || cerradoPor !== null;
  const id = (pieza: string) => idDe(idBase, pieza, nodo.codigo);

  const conSinAcciones = sinAcciones(nodo, marcados);
  const explicacionItem = explicacionItemAntiguo(nodo, padre);
  const origen = modo.tipo === 'usuario' ? origenDe(nodo.codigo, modo.rol, modo.excepciones, indice) : null;
  const faltante = origen === 'anadido_sin_efecto' ? ancestroFaltante(nodo.codigo, marcados, indice) : null;
  const cercano = estaInactivo && !faltante ? ancestroDesmarcadoCercano(nodo.codigo, marcados, indice) : null;

  // PR 4: área sin pantallas → «Sin pantallas aún» en la ranura de la cuenta y su explicación en la de la descripción.
  const sinPantallas = elementoSinPantallas(nodo);
  const descripcion = sinPantallas ? COPY_EXPLICACION_SIN_PANTALLAS : nodo.descripcion;
  let meta = '';
  if (sinPantallas) {
    meta = COPY_SIN_PANTALLAS;
  } else if (modo.tipo === 'rol') {
    const cuenta = textoCuenta(cuentaDe(nodo, marcados, trato), hoja, !marcado);
    const sinAcc = esElemento ? sufijoSinAcciones(itemsSinAcciones(nodo, marcados)) : '';
    meta = [cuenta, sinAcc].filter(Boolean).join(' · ');
  } else if (tieneHijos) {
    meta = textoExcepciones(resumenExcepciones(descendientes(nodo).map((d) => d.codigo), modo.rol, modo.excepciones, indice));
  }
  const mostrarOrigen = origen !== null && !(origen === 'no_lo_trae' && !esElemento);

  const describedBy = [
    descripcion ? id('desc') : null,
    exclusiva ? id('excl') : null,
    meta ? id('cuenta') : null,
    faltante ? id('sinefecto') : null,
    cercano ? idDe(idBase, 'expl', cercano) : null,
    conSinAcciones ? id('sinacc') : null,
    explicacionItem ? id('antiguo') : null,
    cerradoPor ? idDe(idBase, 'enlace', cerradoPor) : null,
    idRotulo ?? null,
    mostrarOrigen ? id('origen') : null,
  ].filter(Boolean).join(' ') || undefined;

  const apagada = cerradoPor !== null || (exclusiva && trato === 'fuera');
  const nombreColor = apagada || estaInactivo ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)';
  const hover = deshabilitada ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--kit-hover)]';

  return (
    <li
      className={esElemento ? 'border-t px-2 py-3 first:border-t-0 sm:px-3' : 'py-0.5'}
      style={esElemento ? LINEA : undefined}
      data-codigo-fila={nodo.codigo}
    >
      <div className="flex items-start gap-1">
        {tieneHijos
          ? <BotonDesplegar nombre={nodo.nombre} abierto={abierto} panelId={id('panel')} onClick={() => ctx.alternarAbierto(nodo.codigo)} />
          : <Hueco ancho="chevron" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-x-3">
            <label className={`flex min-w-0 flex-[1_1_12rem] items-start gap-3 rounded-[9px] px-1 py-1 transition-colors ${hover}`}>
              <CasillaTri
                codigo={nodo.codigo}
                estado={estado}
                deshabilitada={deshabilitada}
                bloqueada={exclusiva}
                describedBy={describedBy}
                inputRef={(el) => ctx.registrarInput(nodo.codigo, el)}
                onChange={() => ctx.onToggle(nodo.codigo)}
              />
              <span className={`min-w-0 break-words text-sm ${esElemento ? 'font-semibold' : 'font-normal'}`} style={{ color: nombreColor }}>
                {nodo.nombre}
                <span className="sr-only"> · {sufijoQuien(modo)}</span>
              </span>
            </label>
            {(meta || mostrarOrigen) && (
              <span className="flex flex-wrap gap-x-2 pl-8 pt-1 text-xs tabular-nums sm:ml-auto sm:pl-0" style={SECUNDARIO}>
                {mostrarOrigen && origen && <EtiquetaOrigen id={id('origen')} origen={origen} elemento={esElemento} />}
                {meta && <span id={id('cuenta')}>{mostrarOrigen ? `· ${meta}` : meta}</span>}
              </span>
            )}
          </div>
          {descripcion && (
            <p id={id('desc')} className="ml-8 text-sm" style={SECUNDARIO} data-aviso={sinPantallas ? 'sin-pantallas' : undefined}>{descripcion}</p>
          )}
          {exclusiva && trato && (
            <p id={id('excl')} className="ml-8 break-words text-sm" style={SECUNDARIO} data-aviso="exclusiva-admin">{notaExclusiva(trato, modo.tipo)}</p>
          )}
          {faltante && <p id={id('sinefecto')} className="ml-8 text-sm" style={SECUNDARIO}>{fraseSinEfecto(faltante.nombre)}</p>}
          {conSinAcciones && (
            <p id={id('sinacc')} className="ml-8 text-sm" style={SECUNDARIO} data-aviso="sin-acciones">{avisoSinAcciones(nodo.nombre, modo.tipo)}</p>
          )}
          {explicacionItem && <p id={id('antiguo')} className="ml-8 text-sm" style={SECUNDARIO}>{explicacionItem}</p>}
          {cerradoPor === nodo.codigo && ctx.notaCerrado && (
            <p id={id('enlace')} className="ml-8 text-sm" style={SECUNDARIO} data-aviso="cerrado-por-enlace">{ctx.notaCerrado}</p>
          )}
        </div>
      </div>
      {abierto && <PanelNodo nodo={nodo} panelId={id('panel')} />}
    </li>
  );
}

/** El contenido desplegado de un nodo: explicaciones, botones del elemento, hijos y, al final, opcionales. */
function PanelNodo({ nodo, panelId }: { nodo: Nodo; panelId: string }) {
  const ctx = useArbol();
  const { marcados, modo, editable, idBase } = ctx;
  const desmarcado = !marcados.has(nodo.codigo);
  const antiguo = nodo.tipo === 'elemento' ? explicacionElementoAntiguo(nodo) : null;
  const opcionales = opcionalesDe(nodo);
  const idRotulo = idDe(idBase, 'opc', nodo.codigo);
  const conBotones = nodo.tipo === 'elemento' && editable && modo.tipo === 'rol' && ctx.onConjunto;
  return (
    <ContenedorPanel id={panelId} leyenda={`Contenido de ${nodo.nombre} · ${sufijoQuien(modo)}`}>
      {desmarcado && (
        <p id={idDe(idBase, 'expl', nodo.codigo)} className="text-sm" style={SECUNDARIO}>{explicacionDesmarcado(nodo.nombre, modo.tipo)}</p>
      )}
      {antiguo && <p className="text-sm" style={SECUNDARIO}>{antiguo}</p>}
      {conBotones && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={() => ctx.onConjunto?.(codigosMarcarTodo([nodo]).filter((c) => !ctx.cerrados?.has(c) && !(ctx.exclusivas === 'fuera' && ctx.indice.porCodigo.get(c)?.exclusivaAdmin)), true)}>
            Marcar todo<span className="sr-only"> en {nodo.nombre}</span>
          </button>
          <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle} onClick={() => ctx.onConjunto?.(codigosDesmarcarTodo([nodo]).filter((c) => !(ctx.exclusivas === 'fija' && ctx.indice.porCodigo.get(c)?.exclusivaAdmin)), false)}>
            Desmarcar todo<span className="sr-only"> en {nodo.nombre}</span>
          </button>
        </div>
      )}
      <ul role="list" className="flex flex-col">
        {subgruposDe(nodo).map((g) => (g.titulo === null
          ? g.nodos.map((h) => <FilaNodo key={h.codigo} nodo={h} padre={nodo} />)
          : (
            <li key={g.titulo} data-subgrupo={g.titulo}>
              <p className="pb-1 pt-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>{g.titulo}</p>
              <ul role="list" aria-label={g.titulo} className="flex flex-col">
                {g.nodos.map((h) => <FilaNodo key={h.codigo} nodo={h} padre={nodo} />)}
              </ul>
            </li>
          )))}
        {opcionales.length > 0 && (
          <li id={idRotulo} className="pt-2 text-xs font-semibold" style={SECUNDARIO}>{rotuloOpcional(nodo.nombre)}</li>
        )}
        {opcionales.map((h) => <FilaNodo key={h.codigo} nodo={h} padre={nodo} idRotulo={idRotulo} />)}
      </ul>
    </ContenedorPanel>
  );
}

/** Opción del menú cuyos ítems el panel agrupa con los subgrupos del riel del dock (Épica #14678, solo presentación). */
const ELEMENTO_CON_SUBGRUPOS = { codigo: 'menu.kyverum', seccion: 'kyverum' } as const;

/**
 * Los hijos (no opcionales) de un nodo en el orden en que se pintan. En Kyverum, agrupados por subgrupo en el orden
 * del riel (Tránsito · Flota · Mantenimiento · PESV · RNDC · LAFT · Trámites) y, al final, los ítems sin entrada de
 * menú. Los subgrupos no son nodos del árbol (ADR-0048, decisión 6): no tienen casilla ni cuentan en «k de n».
 */
function subgruposDe(nodo: Nodo): Array<{ titulo: string | null; nodos: Nodo[] }> {
  const hijos = noOpcionales(nodo);
  if (nodo.codigo !== ELEMENTO_CON_SUBGRUPOS.codigo) return [{ titulo: null, nodos: hijos }];
  const porTitulo = new Map<string | null, Nodo[]>();
  for (const h of hijos) {
    const t = h.slug ? subgrupoDePagina(ELEMENTO_CON_SUBGRUPOS.seccion, h.slug) : null;
    porTitulo.set(t, [...(porTitulo.get(t) ?? []), h]);
  }
  const orden = [...ordenDeSubgrupos(ELEMENTO_CON_SUBGRUPOS.seccion), ...[...porTitulo.keys()].filter((t): t is string => t !== null && !ordenDeSubgrupos(ELEMENTO_CON_SUBGRUPOS.seccion).includes(t))];
  const grupos = orden.filter((t) => porTitulo.has(t)).map((t) => ({ titulo: t as string | null, nodos: porTitulo.get(t)! }));
  if (porTitulo.has(null)) grupos.push({ titulo: null, nodos: porTitulo.get(null)! });
  return grupos;
}

export function ContenedorPanel({ id, leyenda, children }: { id: string; leyenda: string; children: ReactNode }) {
  return (
    <div id={id} className="ml-3 mt-1 border-l-2 pl-3 sm:pl-5" style={LINEA}>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="sr-only">{leyenda}</legend>
        {children}
      </fieldset>
    </div>
  );
}
