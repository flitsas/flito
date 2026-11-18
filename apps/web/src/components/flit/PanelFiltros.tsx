import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Icono } from './kit/Icono';
import GradientButton from './GradientButton';

/**
 * Filtros del UI Kit 2026 (`.filtros` de #tramites): buscador con lupa + botón «Filtros» (con cuenta de activos) que
 * abre el panel; debajo, chips de filtros aplicados con su X y «Limpiar todo». El estado lo lleva el PADRE en memoria
 * o en almacenamiento local — NUNCA en la URL (regla 14: los filtros de FLITO suelen llevar PII).
 * `campos` es el contenido del panel (usa `.campo` + `.control`, o <RangoFechas>); `onAplicar` se llama al enviar.
 */
export interface FiltroAplicado {
  id: string; etiqueta: string;
  /** `aria-label` del ✕ cuando la etiqueta va resumida («OT: A y 2 más»). Por defecto «Quitar filtro {etiqueta}». Aditiva. */
  ariaQuitar?: string;
}

/**
 * Autocompletado del buscador (ADITIVO, Torre #14590 — spec `docs/ux/flito-torre-explorador-flexible.md` §6). Con él, el
 * input pasa a `role="combobox"` y `lista` se pinta bajo la barra, a todo su ancho. `onKeyDown` corre antes que el Enter de
 * `onEnviarBusqueda`: si devuelve `true`, la tecla ya se atendió. Sin la prop, el buscador es el de siempre.
 */
export interface ComboboxBusqueda {
  expandido: boolean;
  listboxId: string;
  activoId?: string;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  lista: ReactNode;
}

export default function PanelFiltros({
  busqueda, onBusqueda, placeholder, campos, aplicados = [], onQuitar, onLimpiar, onAplicar, acciones,
  onEnviarBusqueda, textoBoton = 'Filtros', etiquetaBusqueda, describedBy, combobox,
}: {
  busqueda: string;
  onBusqueda: (v: string) => void;
  placeholder: string;
  campos?: ReactNode;
  aplicados?: FiltroAplicado[];
  onQuitar?: (id: string) => void;
  onLimpiar?: () => void;
  onAplicar?: () => void;
  /** Botones extra a la derecha de la barra (exportar…). */
  acciones?: ReactNode;
  /** Enter en el buscador (Torre de Control: abre la ficha de la placa en vez de filtrar). Opcional y aditiva. */
  onEnviarBusqueda?: (texto: string) => void;
  /** Rótulo del botón del panel; por defecto «Filtros». */
  textoBoton?: string;
  /** `aria-label` del buscador cuando debe decir más que el placeholder. Por defecto, el placeholder. */
  etiquetaBusqueda?: string;
  /** `aria-describedby` del buscador (p. ej. un error en línea bajo la barra). */
  describedBy?: string;
  /** Autocompletado del buscador (ver `ComboboxBusqueda`). Opcional y aditiva. */
  combobox?: ComboboxBusqueda;
}) {
  const [abierto, setAbierto] = useState(false);
  const idPanel = useId();
  const enviar = (e: FormEvent) => { e.preventDefault(); onAplicar?.(); setAbierto(false); };
  const alTeclear = (e: KeyboardEvent<HTMLInputElement>) => {
    if (combobox?.onKeyDown(e)) return;
    if (onEnviarBusqueda && e.key === 'Enter') { e.preventDefault(); onEnviarBusqueda(busqueda); }
  };
  const barra = (
    <div className="filtros__barra">
      <div className="control-icono filtros__buscar">
        <Icono nombre="buscar" size={18} />
        <input className="control" type="search" placeholder={placeholder} aria-label={etiquetaBusqueda ?? placeholder} value={busqueda}
          aria-describedby={describedBy} onChange={(e) => onBusqueda(e.target.value)}
          onKeyDown={onEnviarBusqueda || combobox ? alTeclear : undefined}
          {...(combobox ? {
            role: 'combobox', autoComplete: 'off', 'aria-autocomplete': 'list' as const, 'aria-expanded': combobox.expandido,
            'aria-controls': combobox.listboxId, 'aria-activedescendant': combobox.activoId,
            onFocus: combobox.onFocus, onBlur: combobox.onBlur,
          } : {})} />
      </div>
      {campos && (
        <button className="btn secondary filtros__boton" type="button" aria-expanded={abierto} aria-controls={abierto ? idPanel : undefined} onClick={() => setAbierto((v) => !v)}>
          <Icono nombre="filtro" size={20} />
          <span className="filtros__texto">{textoBoton}</span>
          {aplicados.length > 0 && <span className="filtros__cuenta" aria-label={`${aplicados.length} activos`}>{aplicados.length}</span>}
        </button>
      )}
      {acciones}
    </div>
  );
  return (
    <div className="filtros" data-kit="filtros">
      {combobox ? <div className="relative">{barra}{combobox.lista}</div> : barra}
      {aplicados.length > 0 && (
        <div className="filtros__activos" aria-label="Filtros aplicados">
          {aplicados.map((a) => (
            <button key={a.id} className="filtro-activo" type="button" aria-label={a.ariaQuitar ?? `Quitar filtro ${a.etiqueta}`} onClick={() => onQuitar?.(a.id)}>
              <span>{a.etiqueta}</span><Icono nombre="cerrar" size={14} />
            </button>
          ))}
          {onLimpiar && <button className="btn sm ghost" type="button" onClick={onLimpiar}>Limpiar todo</button>}
        </div>
      )}
      {campos && abierto && (
        <form className="filtros__panel" id={idPanel} noValidate onSubmit={enviar}>
          <div className="filtros__campos">{campos}</div>
          <div className="filtros__pie">
            {onLimpiar && <button className="btn ghost" type="button" onClick={onLimpiar}>Limpiar</button>}
            <GradientButton type="submit">Aplicar filtros</GradientButton>
          </div>
        </form>
      )}
    </div>
  );
}
