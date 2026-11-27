// FLITO — Gestión Trámites: barra de la tabla (Épica #14707, bloque 4; UX §5.2 y §5.5).
//
// Una sola barra, sticky y opaca, con dos modos. Sin selección: el conteo («1.284 trámites», o
// «Actualizando…»), «Columnas» y «Orden». Con selección cambia de modo en el mismo sitio —no se inserta
// otra barra, así que marcar una casilla no mueve la tabla—: «n seleccionados», las acciones de lote con
// su conteo accionable (HU #11910) y «Limpiar selección». En modo selección se ocultan Columnas, Orden y
// el conteo, porque cambiarlos limpiaría la selección. «Entregar (n)» es la única primaria de la pantalla.
// Sin `aria-label` en las acciones: el nombre accesible es el texto visible (UX §5.2, WCAG 2.5.3).
import type { ReactNode } from 'react';
import GradientButton from '../../flit/GradientButton';
import { flitInp } from '../../flit/flitPageKit';
import type { Orden } from './useFiltrosTramites';

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

export default function BarraTablaTramites({ total, cargando, columnas, orden, onOrden, seleccion }: {
  total: number;
  cargando: boolean;
  columnas: ReactNode;
  orden: Orden;
  onOrden: (o: Orden) => void;
  /** Con `n > 0` la barra pasa a modo selección. */
  seleccion: Seleccion | null;
}) {
  if (seleccion && seleccion.n > 0) {
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

  return (
    <div className="barra-tabla" data-testid="barra-tabla">
      <div className="barra-tabla__fila">
        <span className="barra-tabla__cuenta" role="status">
          {cargando ? 'Actualizando…' : `${total.toLocaleString('es-CO')} ${total === 1 ? 'trámite' : 'trámites'}`}
        </span>
        <div className="barra-tabla__der">
          {columnas}
          {/* Orden cronológico: el gestor trabaja de lo más viejo a lo más nuevo. */}
          <label className="flex items-center gap-2 text-xs font-semibold text-[color:var(--color-text-secondary)]">
            Orden
            <select className={flitInp} value={orden} onChange={(e) => onOrden(e.target.value as Orden)}>
              <option value="recientes">Más recientes primero</option>
              <option value="antiguos">Más antiguos primero</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
