// FLITO — Gestión Trámites: barra de LOTE de la tabla (Épica #14707, bloque 4; UX §5.2 y §5.5; ajustes 14707).
//
// Solo existe con selección (decisión de David, ajustes 14707): sin selección no se pinta nada sobre la tabla
// —el conteo va junto a la paginación y «Columnas»/«Orden» en la cabecera de Filtros—. Con selección es sticky y
// opaca: «n seleccionados», las acciones de lote con su conteo accionable (HU #11910) y «Limpiar selección».
// «Entregar (n)» es la única primaria de la pantalla. Sin `aria-label` en las acciones: el nombre accesible es el
// texto visible (UX §5.2, WCAG 2.5.3).
import type { ReactNode } from 'react';
import GradientButton from '../../flit/GradientButton';

interface Seleccion {
  n: number;
  nAccionables: number;
  puedePedirSoat: boolean;
  enProceso: boolean;
  onSolicitarSoat: () => void;
  onSolicitarImpuestos: () => void;
  onSolicitarAmbos: () => void;
  onEntregar: () => void;
  /** «Descargar soportes (n)»: el componente del ZIP, que sí aplica a todas las marcadas. */
  descargar: ReactNode;
  onLimpiar: () => void;
}

export default function BarraTablaTramites({ seleccion }: {
  /** Sin selección (`null` o `n = 0`) la barra no existe. */
  seleccion: Seleccion | null;
}) {
  if (!seleccion || seleccion.n <= 0) return null;
  const { n, nAccionables } = seleccion;
  // `(2)` sin desajuste y `(2 de 3)` con él: el número va DENTRO del nombre accesible.
  const cuenta = nAccionables < n ? `${nAccionables} de ${n}` : `${nAccionables}`;
  return (
    <div className="barra-tabla" data-modo="seleccion" data-testid="barra-tabla">
      <div className="barra-tabla__fila">
        <span className="barra-tabla__cuenta">{n} {n === 1 ? 'seleccionado' : 'seleccionados'}</span>
        <div className="barra-tabla__acciones">
          {/* Si en lo marcado no hay ninguna accionable no se pintan: un botón que no puede actuar es peor que su ausencia. */}
          {nAccionables > 0 && (
            <>
              {seleccion.puedePedirSoat && <GradientButton variant="secondary" size="sm" disabled={seleccion.enProceso} onClick={seleccion.onSolicitarSoat}>Solicitar SOAT ({cuenta})</GradientButton>}
              <GradientButton variant="secondary" size="sm" disabled={seleccion.enProceso} onClick={seleccion.onSolicitarImpuestos}>Solicitar Impuestos ({cuenta})</GradientButton>
              {seleccion.puedePedirSoat && <GradientButton variant="secondary" size="sm" disabled={seleccion.enProceso} onClick={seleccion.onSolicitarAmbos}>Solicitar ambos ({cuenta})</GradientButton>}
              <GradientButton size="sm" className="barra-tabla__primaria" disabled={seleccion.enProceso} onClick={seleccion.onEntregar}>Entregar ({cuenta})</GradientButton>
            </>
          )}
          {seleccion.descargar}
        </div>
        <div className="barra-tabla__der">
          <GradientButton type="button" variant="ghost" size="sm" onClick={seleccion.onLimpiar}>Limpiar selección</GradientButton>
        </div>
      </div>
      {nAccionables < n && (
        <p className="barra-tabla__desajuste">
          De las {n} filas marcadas, {nAccionables} están Asignadas con empresa y secretaría emparejadas y son las únicas
          sobre las que actúan Solicitar y Entregar. Descargar soportes usa las {n}.
        </p>
      )}
    </div>
  );
}
