// Tarjeta de embudo + búsqueda de las colas de SOAT e Impuestos (Épica #14560, ronda 2): UNA pieza para
// las dos, con el mismo orden —embudo de estado, buscador con «Filtros», filtros aplicados, «Vistas
// rápidas» como chips y el panel Quién · Cuándo · Riesgo—. Solo presentación: el estado de cada filtro
// lo lleva la página de cada módulo y se filtra EN VIVO (sin «Aplicar»), como hacía el SOAT. El
// contenido del panel y las vistas rápidas son de cada módulo; el molde es común.
import { useId, useState, type ReactNode, type RefObject } from 'react';
import { Icono } from '../flit/kit/Icono';
import { FlitCard } from '../flit/flitPageKit';

export interface VistaRapida { nombre: string; descripcion?: string }
export interface FiltroActivo { id: string; etiqueta: string; quitar: () => void }

export default function BarraFiltrosCola<V extends VistaRapida>({
  embudo, refEmbudo, texto, setTexto, placeholder, ariaBuscar, panel, cuentaPanel, aplicados = [],
  vistas, vista, onVista, hayFiltros, limpiarFiltros, pie,
}: {
  /** El `EmbudoEstadoCola` del módulo. */
  embudo: ReactNode;
  /** Destino del foco al cambiar de pastilla desde fuera (SOAT, HU 12997). */
  refEmbudo?: RefObject<HTMLDivElement>;
  texto: string; setTexto: (t: string) => void;
  placeholder: string;
  /** `aria-label` del buscador; por defecto, el placeholder. */
  ariaBuscar?: string;
  /** Contenido del panel (los grupos Quién · Cuándo · Riesgo del módulo). Opcional (HU #14665): sin
   *  panel no se pinta el botón «Filtros», que abriría un panel vacío. */
  panel?: ReactNode;
  /** Cuántos filtros del panel están puestos: la burbuja del botón con el panel plegado. */
  cuentaPanel?: number;
  /** Chips de lo aplicado, con su ✕ (opcional). */
  aplicados?: FiltroActivo[];
  vistas: V[]; vista: string | null; onVista: (v: V) => void;
  hayFiltros: boolean; limpiarFiltros: () => void;
  /** Nota al pie de la tarjeta (p. ej. el tope de filas cargadas). Opcional. */
  pie?: ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);
  const idPanel = useId();
  const tienePanel = panel !== undefined && panel !== null;
  return (
    <FlitCard>
      <div className="filtros" data-kit="filtros">
        <div ref={refEmbudo} tabIndex={-1} className="flit-focus mb-3 max-w-full overflow-x-auto rounded-[9px]">
          {embudo}
        </div>
        <div className="filtros__barra">
          <div className="control-icono filtros__buscar">
            <Icono nombre="buscar" size={18} />
            <input className="control" type="search" placeholder={placeholder} aria-label={ariaBuscar ?? placeholder}
              value={texto} onChange={(e) => setTexto(e.target.value)} />
          </div>
          {tienePanel && (
            <button type="button" className="btn secondary filtros__boton" aria-expanded={abierto} aria-controls={idPanel}
              onClick={() => setAbierto((a) => !a)}>
              <Icono nombre="filtro" size={20} />
              <span className="filtros__texto">Filtros</span>
              {!!cuentaPanel && cuentaPanel > 0 && <span className="filtros__cuenta" aria-label={`${cuentaPanel} activos`}>{cuentaPanel}</span>}
            </button>
          )}
          {(hayFiltros || !!texto) && (
            <button type="button" className="btn ghost" onClick={limpiarFiltros}>
              <Icono nombre="cerrar" size={16} />
              Limpiar filtros
            </button>
          )}
        </div>

        {aplicados.length > 0 && (
          <div className="filtros__activos" aria-label="Filtros aplicados">
            {aplicados.map((a) => (
              <button key={a.id} className="filtro-activo" type="button" aria-label={`Quitar filtro ${a.etiqueta}`} onClick={a.quitar}>
                <span>{a.etiqueta}</span><Icono nombre="cerrar" size={14} />
              </button>
            ))}
          </div>
        )}

        {vistas.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-[color:var(--color-text-secondary)]">Vistas rápidas:</span>
            {vistas.map((v) => {
              const puesta = vista === v.nombre;
              return (
                <button key={v.nombre} type="button" aria-pressed={puesta} title={v.descripcion}
                  className="chip chip--sm h-10 min-h-0 whitespace-nowrap transition-colors"
                  onClick={() => (puesta ? limpiarFiltros() : onVista(v))}>
                  {v.nombre}
                </button>
              );
            })}
          </div>
        )}

        {tienePanel && abierto && (
          <div id={idPanel} role="group" aria-label="Filtros"
            className="filtros__panel mt-3 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {panel}
          </div>
        )}

        {pie}
      </div>
    </FlitCard>
  );
}

/** Grupo del panel (Quién · Cuándo · Riesgo). */
export function GrupoFiltros({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-tertiary)]">{titulo}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
