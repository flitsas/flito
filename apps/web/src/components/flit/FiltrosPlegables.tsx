import { useId, useState, type ReactNode } from 'react';
import { Icono } from './kit/Icono';

/**
 * Épica #14560 (decisión b): pliega en teléfono (<640 px) un bloque de filtros que ya existe, SOLO en
 * presentación. Por encima de 640 px no cambia nada: el envoltorio no pinta caja (`display: contents`
 * en modo `linea`, bloque sin estilo en modo `bloque`). Por debajo, muestra un botón «Filtros (n)» que
 * abre y cierra el bloque.
 *
 * Lo que NO hace, a propósito:
 *  · No aplica filtros ni decide cuándo se aplican: los controles siguen siendo los de la página, con
 *    su comportamiento (al cambiar, o con su botón Buscar).
 *  · No desmonta los controles al plegar: se ocultan por CSS (kit-responsive.css, V13), así no se
 *    pierde estado ni se rompen selectores E2E en escritorio.
 *
 * `modo`:
 *  · `linea`  → el bloque vive dentro de una barra flex que envuelve (sus hijos son ítems de esa barra).
 *  · `bloque` → el bloque es una fila propia (rejilla, formulario apilado).
 * `activos` = filtros del bloque distintos de su valor por defecto; 0 → solo «Filtros».
 */
export default function FiltrosPlegables({
  children, activos = 0, modo = 'bloque',
}: {
  children: ReactNode;
  activos?: number;
  modo?: 'linea' | 'bloque';
}) {
  const [abierto, setAbierto] = useState(false);
  const id = useId();
  return (
    <div className="kit-plegable" data-kit="filtros-plegables" data-modo-plegable={modo} data-abierto={abierto || undefined}>
      <button
        type="button"
        className="btn secondary kit-plegable__boton"
        aria-expanded={abierto}
        aria-controls={id}
        onClick={() => setAbierto((v) => !v)}
      >
        <Icono nombre="filtro" size={20} />
        <span>{activos > 0 ? `Filtros (${activos})` : 'Filtros'}</span>
      </button>
      <div id={id} className="kit-plegable__cuerpo">{children}</div>
    </div>
  );
}
