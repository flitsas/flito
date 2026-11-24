// FLITO — Comparendos: paginación por cursor (HU 11560, AC5 y AC6).
//
// `Paginacion.tsx` no se reutiliza y no es un descuido: exige `total`, `page` y `totalPaginas`, y su
// contador —«1.284 registros · página 3 de 26»— **es su razón de existir**. El API pagina por cursor
// y NO devuelve un total (un `COUNT(*)` sobre la tabla en cada página es justo lo que el cursor
// evita), así que reutilizarlo obligaría a pasarle números inventados. Este componente copia sus
// clases y sus estilos tal cual para que en pantalla sean indistinguibles: es el mismo patrón visual
// con otro contrato de datos, no un patrón nuevo. Lo único que se le añade es `flit-focus`, porque
// un control que se alcanza con el tabulador tiene que verse cuando lo tiene.
//
// El contador dice lo que sabe y nada más: cuántas filas trae ESTA página y en qué número va. No
// dice «de 1.284» ni «página 3 de 47» porque nadie lo sabe. Y la última página no lleva ningún
// cartel de «fin de la lista»: los dos botones inhabilitados ya lo dicen.

// UI Kit 2026: mismas piezas que `Paginacion` (`.paginador`, texto gris, botones redondos con hover del
// kit). No delega en su modo cursor porque ese modo pinta solo «Página N» y flechas sin texto, y aquí
// el contador («N comparendos en esta página · página N») y los rótulos «← Anterior» / «Siguiente →»
// son contrato (specs E2E y conciliación de boletas).
const BTN = 'paginador__flecha flit-focus inline-flex h-10 items-center rounded-full border border-[var(--color-border-control)] px-4 text-sm font-semibold text-[color:var(--color-action)] transition-colors hover:bg-[var(--kit-hover)] disabled:opacity-40 disabled:hover:bg-transparent';

interface Props {
  /** Filas de la página actual. No es un total: el API no devuelve ninguno. */
  enEstaPagina: number;
  /**
   * Qué se está contando. Por defecto «comparendos», que es de donde viene el componente.
   *
   * Se abre como prop —igual que el `sustantivo` de `Paginacion.tsx`— porque la conciliación de
   * boletas pagina también por cursor (HU 11680) y la alternativa era copiar el componente entero
   * para cambiar una palabra: dos paginaciones idénticas que el día que cambie una se separan.
   */
  sustantivo?: string;
  pagina: number;
  hayAnterior: boolean;
  haySiguiente: boolean;
  onAnterior: () => void;
  onSiguiente: () => void;
}

export default function PaginacionCursor({
  enEstaPagina, pagina, hayAnterior, haySiguiente, onAnterior, onSiguiente,
  sustantivo = 'comparendos',
}: Props) {
  return (
    <div className="kit-paginacion paginador mt-3 flex flex-wrap items-center justify-between gap-2" data-kit="paginacion">
      <span className="paginador__texto text-sm">
        <strong className="text-[color:var(--color-text-primary)]">
          {enEstaPagina.toLocaleString('es-CO')}
        </strong>
        {' '}{sustantivo} en esta página · página {pagina}
      </span>
      <div className="flex gap-2">
        <button
          type="button" className={BTN}
          disabled={!hayAnterior} onClick={onAnterior}
        >
          ← Anterior
        </button>
        <button
          type="button" className={BTN}
          disabled={!haySiguiente} onClick={onSiguiente}
        >
          Siguiente →
        </button>
      </div>
    </div>
  );
}
