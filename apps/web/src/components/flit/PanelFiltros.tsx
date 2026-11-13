import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Icono } from './kit/Icono';
import GradientButton from './GradientButton';

/**
 * Filtros del UI Kit 2026 (`.filtros` de #tramites): buscador con lupa + botón «Filtros» (con cuenta de activos) que
 * abre el panel; debajo, chips de filtros aplicados con su X y «Limpiar todo». El estado lo lleva el PADRE en memoria
 * o en almacenamiento local — NUNCA en la URL (regla 14: los filtros de FLITO suelen llevar PII).
 * `campos` es el contenido del panel (usa `.campo` + `.control`, o <RangoFechas>); `onAplicar` se llama al enviar.
 */
export interface FiltroAplicado { id: string; etiqueta: string }

export default function PanelFiltros({
  busqueda, onBusqueda, placeholder, campos, aplicados = [], onQuitar, onLimpiar, onAplicar, acciones,
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
}) {
  const [abierto, setAbierto] = useState(false);
  const idPanel = useId();
  const enviar = (e: FormEvent) => { e.preventDefault(); onAplicar?.(); setAbierto(false); };
  return (
    <div className="filtros" data-kit="filtros">
      <div className="filtros__barra">
        <div className="control-icono filtros__buscar">
          <Icono nombre="buscar" size={18} />
          <input className="control" type="search" placeholder={placeholder} aria-label={placeholder} value={busqueda} onChange={(e) => onBusqueda(e.target.value)} />
        </div>
        {campos && (
          <button className="btn secondary filtros__boton" type="button" aria-expanded={abierto} aria-controls={abierto ? idPanel : undefined} onClick={() => setAbierto((v) => !v)}>
            <Icono nombre="filtro" size={20} />
            <span className="filtros__texto">Filtros</span>
            {aplicados.length > 0 && <span className="filtros__cuenta" aria-label={`${aplicados.length} activos`}>{aplicados.length}</span>}
          </button>
        )}
        {acciones}
      </div>
      {aplicados.length > 0 && (
        <div className="filtros__activos" aria-label="Filtros aplicados">
          {aplicados.map((a) => (
            <button key={a.id} className="filtro-activo" type="button" aria-label={`Quitar filtro ${a.etiqueta}`} onClick={() => onQuitar?.(a.id)}>
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
