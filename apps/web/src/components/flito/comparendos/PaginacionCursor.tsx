// FLITO — Comparendos: paginación por cursor (HU #11560, AC5 y AC6).
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

const BTN = 'flit-focus rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40';
const BTN_ESTILO = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;

interface Props {
  /** Filas de la página actual. No es un total: el API no devuelve ninguno. */
  enEstaPagina: number;
  pagina: number;
  hayAnterior: boolean;
  haySiguiente: boolean;
  onAnterior: () => void;
  onSiguiente: () => void;
}

export default function PaginacionCursor({
  enEstaPagina, pagina, hayAnterior, haySiguiente, onAnterior, onSiguiente,
}: Props) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <strong style={{ color: 'var(--flit-text-primary)' }}>
          {enEstaPagina.toLocaleString('es-CO')}
        </strong>
        {' '}comparendos en esta página · página {pagina}
      </span>
      <div className="flex gap-2">
        <button
          type="button" className={BTN} style={BTN_ESTILO}
          disabled={!hayAnterior} onClick={onAnterior}
        >
          ← Anterior
        </button>
        <button
          type="button" className={BTN} style={BTN_ESTILO}
          disabled={!haySiguiente} onClick={onSiguiente}
        >
          Siguiente →
        </button>
      </div>
    </div>
  );
}
