// Embudo de la cola del SOAT por estado (UI Kit 2026): la misma pieza `.embudo` que el de Impuestos, con
// un glifo por estado en su disco de color, para que el estado no dependa solo del texto ni del color.
// Sustituye al grupo de píldoras sin ícono (`FiltroSegmentado`) en la barra de filtros. Nombres accesibles
// sin cambio: el ícono es decorativo (`aria-hidden`) y el texto de cada botón es la etiqueta de siempre.
// Los glifos de los estados del SOAT se registran en ChipEstadoSoat: se importa para que existan al pintar el embudo.
import './ChipEstadoSoat';
import { Icono } from '../../flit/kit/Icono';
import { estadoKit, registrarEstados } from '../../flit/kit/tonos';

registrarEstados({
  'soat-todos': { tono: 'neutro', glifo: 'todos' },
});

const DISCO: Record<string, string> = { ok: 'ok', warn: 'warn', danger: 'danger', info: 'info' };

export interface OpcionEmbudoSoat<T extends string> {
  valor: T;
  etiqueta: string;
}

export default function EmbudoSoat<T extends string>({ opciones, valor, onCambio, ariaLabel }: {
  opciones: OpcionEmbudoSoat<T>[];
  valor: T;
  onCambio: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="embudo !mb-0" role="group" aria-label={ariaLabel} data-kit="embudo">
      {opciones.map((o) => {
        const e = estadoKit(`soat-${o.valor || 'todos'}`);
        return (
          <button key={o.valor || 'todos'} type="button" className="chip" aria-pressed={o.valor === valor} onClick={() => onCambio(o.valor)}>
            <span className={`kico estado-ico estado-ico--${DISCO[e.tono] ?? 'neutro'}`} aria-hidden="true">
              <Icono nombre={e.glifo ?? 'punto'} />
            </span>
            <span>{o.etiqueta}</span>
          </button>
        );
      })}
    </div>
  );
}
