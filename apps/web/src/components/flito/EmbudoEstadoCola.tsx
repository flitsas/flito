// Embudo de estado de las colas de SOAT e Impuestos (Épica #14560, spec §5): UN wrapper sobre el `Embudo`
// del kit (`Bloques.tsx`) en vez de los dos casi idénticos que había (`EmbudoSoat` e `ImpuestosEmbudo`).
// Lo único propio de cada módulo es el glifo de cada estado, que se registra aquí con el prefijo del
// módulo para no pisar las claves del kit. Las colas no exponen conteos por estado: el chip va sin cifra.
// Nombres accesibles y `aria-pressed` sin cambio: el ícono es decorativo y el texto es la etiqueta de siempre.
// Los glifos de los estados se registran en ChipEstadoSoat / ChipEstadoImpuesto: se importan para que existan al pintar.
import './soat/ChipEstadoSoat';
import './impuestos/ChipEstadoImpuesto';
import { Embudo } from '../flit/Bloques';
import { registrarEstados } from '../flit/kit/tonos';

registrarEstados({
  'soat-todos': { tono: 'neutro', glifo: 'todos' },
  'impuesto-todos': { tono: 'neutro', glifo: 'todos' },
});

export interface OpcionEmbudo<T extends string> {
  /** `''` = «Todos» (convención de la cola SOAT); se registra como `<módulo>-todos`. */
  valor: T;
  etiqueta: string;
}

export default function EmbudoEstadoCola<T extends string>({ modulo, opciones, valor, onCambio, ariaLabel }: {
  /** Prefijo de los glifos registrados: `soat-…` / `impuesto-…`. */
  modulo: 'soat' | 'impuesto';
  opciones: OpcionEmbudo<T>[];
  valor: T;
  onCambio: (v: T) => void;
  ariaLabel: string;
}) {
  const id = (v: string) => v || 'todos';
  return (
    <Embudo className="!mb-0" etiqueta={ariaLabel} activo={id(valor)}
      chips={opciones.map((o) => ({ id: id(o.valor), etiqueta: o.etiqueta, estado: `${modulo}-${id(o.valor)}` }))}
      onElegir={(elegido) => {
        const o = opciones.find((x) => id(x.valor) === elegido);
        if (o) onCambio(o.valor);
      }} />
  );
}
