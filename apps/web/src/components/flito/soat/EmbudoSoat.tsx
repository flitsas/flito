// Embudo de la cola del SOAT por estado. Desde la Épica #14560 es el wrapper único de las dos colas
// (`EmbudoEstadoCola`), con el prefijo `soat-` fijado; se conserva este nombre para no tocar
// `BarraFiltrosSoat` (variante legítima, fuera del alcance de la épica).
import EmbudoEstadoCola, { type OpcionEmbudo } from '../EmbudoEstadoCola';

export type OpcionEmbudoSoat<T extends string> = OpcionEmbudo<T>;

export default function EmbudoSoat<T extends string>(props: {
  opciones: OpcionEmbudoSoat<T>[]; valor: T; onCambio: (v: T) => void; ariaLabel: string;
}) {
  return <EmbudoEstadoCola modulo="soat" {...props} />;
}
