// Torre de Control (Épica #14590, spec UX §5.1, §5.4, maqueta `torre-detalle.html`) — la tabla del Detalle universal.
// Pinta las columnas que manda el API, en su orden (§5.6); las de dinero ya llegan fuera si el rol no ve dinero.
// `DataTable` del kit: ≥ lg tabla con encabezados ordenables (`aria-sort`), < lg tarjetas (`data-modo="tarjetas"`) con
// «Ordenar por» en un select, porque no hay encabezados que pulsar. «Abrir trámite» por fila solo si hay con qué.
import type { ColumnaDetalle, ColumnaDetalleId, FilaDetalle, OrdenDetalle, ResultadoDetalle, ValorCelda } from '@operaciones/shared-types';
import DataTable, { type ColumnaTabla } from '../flit/DataTable';
import FlitSelect from '../flit/FlitSelect';
import { EtiquetaEstado } from '../flit/Bloques';
import { conteo, duracion, fechaCorta, humanizar, pesos } from './formatoTorre';

export const TAMANOS_DETALLE = [25, 50, 100] as const;
export type TamanoDetalle = (typeof TAMANOS_DETALLE)[number];

const FALTANTE: Record<string, string> = { soat: 'SOAT', impuesto: 'Impuesto', derecho: 'Derecho' };

/** Texto de una celda según el tipo de su columna. */
export function textoCelda(col: ColumnaDetalle, v: ValorCelda | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (col.tipo) {
    case 'fecha': return fechaCorta(String(v));
    case 'cop': return typeof v === 'number' ? pesos(v) : String(v);
    case 'horas': return typeof v === 'number' ? duracion(v) : String(v);
    case 'dias': case 'numero': return typeof v === 'number' ? conteo(v) : String(v);
    case 'booleano': return v === true ? 'Sí' : v === false ? 'No' : String(v);
    case 'lista': return Array.isArray(v) ? v.map((x) => FALTANTE[x] ?? humanizar(x)).join(' · ') : String(v);
    default: return Array.isArray(v) ? v.join(', ') : String(v);
  }
}

const ALINEADO_DERECHA = new Set<ColumnaDetalle['tipo']>(['cop', 'horas', 'dias', 'numero']);
const flecha = (dir: 'asc' | 'desc') => (dir === 'asc' ? '▲' : '▼');

function Celda({ col, fila, clave }: { col: ColumnaDetalle; fila: FilaDetalle; clave: ColumnaDetalleId }) {
  const v = fila.celdas[col.id];
  if (col.id === 'placa') return <strong>{textoCelda(col, v)}</strong>;
  if (col.id === 'estado' && typeof v === 'string' && v) return <EtiquetaEstado estado={v}>{humanizar(v)}</EtiquetaEstado>;
  if (col.tipo === 'lista' && Array.isArray(v) && v.length) {
    return (
      <span className="flex flex-wrap gap-1">
        {v.map((x) => <EtiquetaEstado key={x} estado="neutro">{FALTANTE[x] ?? humanizar(x)}</EtiquetaEstado>)}
      </span>
    );
  }
  const texto = textoCelda(col, v);
  return col.id === clave ? <strong className="tabular-nums">{texto}</strong> : <span className="tabular-nums">{texto}</span>;
}

export default function TablaDetalleTorre({
  res, nombre, orden, onOrden, pagina, tamano, onPagina, onTamano, onAbrir, ocupado,
}: {
  res: ResultadoDetalle;
  /** «Borradores abandonados»: caption y aria-label. */
  nombre: string;
  orden: OrdenDetalle | null;
  onOrden: (o: OrdenDetalle) => void;
  pagina: number;
  tamano: TamanoDetalle;
  onPagina: (p: number) => void;
  onTamano: (t: TamanoDetalle) => void;
  /** «Abrir trámite» (ficha de la placa). Sin él, no hay columna de acción. */
  onAbrir?: (placa: string) => void;
  /** Cambio de página/filtro en curso: la tabla anterior queda atenuada, sin parpadear a esqueleto (§5.3). */
  ocupado: boolean;
}) {
  const clave = orden?.columna ?? res.columnas[0]?.id;
  const ordenables = res.columnas.filter((c) => c.ordenable);
  const alternar = (c: ColumnaDetalle) => onOrden({
    columna: c.id, dir: orden?.columna === c.id ? (orden.dir === 'asc' ? 'desc' : 'asc') : c.tipo === 'texto' ? 'asc' : 'desc',
  });

  const columnas: ColumnaTabla<FilaDetalle>[] = res.columnas.map((c) => {
    const activa = orden?.columna === c.id;
    return {
      key: c.id,
      etiqueta: c.etiqueta,
      align: ALINEADO_DERECHA.has(c.tipo) ? 'right' : 'left',
      ariaSort: c.ordenable ? (activa ? (orden!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined,
      header: c.ordenable ? (
        <button type="button" onClick={() => alternar(c)} data-torre="ordenar" data-columna={c.id}
          className="flit-focus inline-flex items-center gap-1 rounded-md px-1 -mx-1 uppercase transition-colors hover:bg-[var(--kit-hover)]">
          {c.etiqueta}
          <span aria-hidden="true" className={activa ? '' : 'opacity-40'}>{activa ? flecha(orden!.dir) : '↕'}</span>
        </button>
      ) : c.etiqueta,
      render: (f: FilaDetalle) => <Celda col={c} fila={f} clave={clave as ColumnaDetalleId} />,
    };
  });
  if (onAbrir) {
    columnas.push({
      key: '__abrir', header: <span className="sr-only">Acciones</span>, acciones: true,
      render: (f) => {
        const placa = typeof f.celdas.placa === 'string' ? f.celdas.placa : null;
        if (!placa) return null;
        return (
          <button type="button" onClick={() => onAbrir(placa)} data-torre="abrir-tramite"
            className="flit-focus inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-sm font-semibold text-[color:var(--color-action)] transition-colors hover:bg-[var(--kit-hover)] hover:underline"
            aria-label={`Abrir trámite ${placa} (abre la ficha de la placa)`}>
            Abrir trámite <span aria-hidden="true">↗</span>
          </button>
        );
      },
    });
  }

  const paginable = Math.min(res.total, 10_000);
  const totalPaginas = Math.max(1, Math.ceil(paginable / tamano));
  const valorOrden = orden ? `${orden.columna}:${orden.dir}` : '';

  return (
    <div className={`flex min-w-0 flex-col gap-3 transition-opacity ${ocupado ? 'opacity-60' : ''}`} aria-busy={ocupado || undefined} data-torre="tabla-detalle">
      <div className="flex flex-wrap items-end gap-3 lg:hidden">
        {ordenables.length > 0 && (
          <div className="min-w-0 flex-1 basis-48">
            <FlitSelect label="Ordenar por" value={valorOrden}
              opciones={ordenables.flatMap((c) => [
                { valor: `${c.id}:desc`, etiqueta: `${c.etiqueta} (${c.tipo === 'texto' ? 'Z a A' : 'mayor primero'})` },
                { valor: `${c.id}:asc`, etiqueta: `${c.etiqueta} (${c.tipo === 'texto' ? 'A a Z' : 'menor primero'})` },
              ])}
              onChange={(v) => { const [columna, dir] = v.split(':'); onOrden({ columna: columna as ColumnaDetalleId, dir: dir as 'asc' | 'desc' }); }} />
          </div>
        )}
      </div>
      <DataTable ariaLabel={`${nombre}: ${conteo(res.total)} registros`} caption={`${nombre}: ${conteo(res.total)} registros`}
        columnas={columnas} filas={res.filas} getKey={(f) => f.id}
        paginacion={{
          total: res.total, page: pagina, totalPaginas, sustantivo: 'registros', singular: 'registro',
          onPrev: () => onPagina(Math.max(1, pagina - 1)), onNext: () => onPagina(Math.min(totalPaginas, pagina + 1)),
        }} />
      <div className="flex flex-wrap items-end justify-end gap-3">
        <div className="w-44">
          <FlitSelect label="Registros por página" value={String(tamano)}
            opciones={TAMANOS_DETALLE.map((t) => ({ valor: String(t), etiqueta: String(t) }))}
            onChange={(v) => onTamano(Number(v) as TamanoDetalle)} />
        </div>
      </div>
    </div>
  );
}
