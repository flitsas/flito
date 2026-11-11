// La vista consolidada del reporte de costos: una fila por cliente y periodo (HU #12434, CF-12).
//
// Rediseño (Épica #13763, spec §4): cabecera de dos filas con los grupos «Cobro al cliente» y
// «Costo de proveedor» —este aparte y sin margen ni resta, decisión del humano—, UNA sola región de
// scroll (la de `FlitTable`; el `div.overflow-x-auto` de antes era una segunda) y el error sin rojo.
//
// Aquí no se opera, se lee y se exporta: sin casillas, sin acciones de fila, sin contadores. Todo
// viene agregado del API con LOS MISMOS filtros del detalle más el tipo de periodo; la pantalla no
// suma ni agrupa nada. Cuatro estados, con la petición siempre en manos de la página.

import StatusChip from '../flit/StatusChip';
import { FlitTable, FlitTh, FlitTr, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import Monto from './Monto';
import { CONCEPTO, type ConsolidadoReporte, type CostoProveedorConsolidado, type FilaConsolidado, type Totales } from './tiposReporteCostos';

const COLUMNAS: Array<{ titulo: string; valor: (t: Totales) => number }> = [
  { titulo: CONCEPTO.soat, valor: (t) => t.soat },
  { titulo: CONCEPTO.impuesto, valor: (t) => t.impuesto },
  { titulo: 'Trámite', valor: (t) => t.derechoTramite },
  { titulo: 'GMF', valor: (t) => t.gmf },
  { titulo: CONCEPTO.logistica, valor: (t) => t.logistica },
  { titulo: 'Total reintegro', valor: (t) => t.totalReintegro },
  { titulo: CONCEPTO.digital, valor: (t) => t.tramiteDigital },
  { titulo: 'Servicio', valor: (t) => t.totalServicio },
  { titulo: 'Total', valor: (t) => t.total },
];

/** Lo que FLITO le paga al proveedor: aparte, nunca restado del cobro. */
const COSTO: Array<{ titulo: string; valor: (t: CostoProveedorConsolidado) => number }> = [
  { titulo: 'Costo SOAT', valor: (t) => t.costoProveedorSoat },
  { titulo: 'Costo logística', valor: (t) => t.costoProveedorLogistica },
  { titulo: 'Total costos', valor: (t) => t.costoProveedorTotal },
];

const AZUL = { color: 'var(--flit-blue-text)' } as const;
const BORDE = '1px solid var(--flit-border-input)';
const PRIMARIO = { color: 'var(--flit-text-primary)' } as const;

/** El `th` de la fila de grupos, como en el detalle (`scope="colgroup"`). */
function ThGrupo({ children, colSpan, rowSpan, borde }: { children?: string; colSpan?: number; rowSpan?: number; borde?: boolean }) {
  return (
    <th scope={children ? 'colgroup' : undefined} colSpan={colSpan} rowSpan={rowSpan}
      className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap"
      style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)', borderBottom: BORDE, ...(borde ? { borderLeft: BORDE } : {}) }}>
      {children}
    </th>
  );
}

export default function ConsolidadoReporteCostos({ data, cargando, error, onReintentar, onLimpiarFiltros }: {
  data: ConsolidadoReporte | null;
  cargando: boolean;
  error: string | null;
  onReintentar: () => void;
  onLimpiarFiltros: () => void;
}) {
  if (error) {
    return (
      // Sin rojo y sin el error crudo del API (D-6): tinta primaria, borde del kit y la salida puesta.
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[10px] border p-3 text-sm"
        style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
        <span aria-hidden="true" style={{ color: 'var(--flit-text-muted)' }}>ⓘ</span>
        <span>No se pudo calcular el consolidado. Vuelve a intentarlo.</span>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>Reintentar</button>
      </div>
    );
  }
  if (cargando || !data) {
    return (
      <div role="status" className="space-y-2 py-4">
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Calculando el consolidado…</p>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-4 rounded" style={{ background: 'var(--flit-bg-app)', width: `${80 - i * 15}%` }} />
        ))}
      </div>
    );
  }
  if (data.items.length === 0) {
    return (
      <FlitEmpty>
        <p>No hay trámites que coincidan con los filtros.</p>
        <p className="mt-1">Cambia el periodo o limpia los filtros.</p>
        <button className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle} onClick={onLimpiarFiltros}>Limpiar filtros</button>
      </FlitEmpty>
    );
  }

  const clientes = new Set(data.items.map((i) => i.clienteClave)).size;
  const periodos = new Set(data.items.map((i) => i.periodo ?? '')).size;

  return (
    <>
      <p className="mb-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <strong style={{ color: 'var(--flit-text-primary)' }}>{clientes.toLocaleString('es-CO')}</strong> {clientes === 1 ? 'cliente' : 'clientes'} ·{' '}
        <strong style={{ color: 'var(--flit-text-primary)' }}>{periodos.toLocaleString('es-CO')}</strong> {periodos === 1 ? 'periodo' : 'periodos'}
      </p>
        <FlitTable label="Consolidado por cliente y periodo">
          <thead>
            <tr>
              <ThGrupo colSpan={3} />
              <ThGrupo colSpan={COLUMNAS.length} borde>Cobro al cliente</ThGrupo>
              <ThGrupo colSpan={COSTO.length} borde>Costo de proveedor</ThGrupo>
              <ThGrupo borde />
            </tr>
            <FlitTr>
              <FlitTh>Cliente</FlitTh>
              <FlitTh>Periodo</FlitTh>
              <FlitTh center>Trámites</FlitTh>
              {COLUMNAS.map((c, i) => <FlitTh key={c.titulo} center className={`whitespace-nowrap ${i === 0 ? 'border-l border-[color:var(--flit-border-input)]' : ''}`}>{c.titulo}</FlitTh>)}
              {COSTO.map((c, i) => <FlitTh key={c.titulo} center className={`whitespace-nowrap ${i === 0 ? 'border-l border-[color:var(--flit-border-input)]' : ''}`}>{c.titulo}</FlitTh>)}
              <FlitTh center className="border-l border-[color:var(--flit-border-input)]">Incompletos</FlitTh>
            </FlitTr>
          </thead>
          <tbody>
            {data.items.map((f) => <Fila key={`${f.clienteClave}|${f.periodo ?? ''}`} f={f} />)}
          </tbody>
          <tfoot>
            <FlitTr>
              {/* Sin conteo de trámites: el API no lo agrega y la pantalla no suma (RN-02). */}
              <td className="px-4 py-2 text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--flit-text-secondary)' }}>
                Totales del filtro
              </td>
              <td />
              <td />
              {COLUMNAS.map((c, i) => (
                <td key={c.titulo} className="px-4 py-2 text-right font-semibold tabular-nums whitespace-nowrap"
                  style={{ ...(c.titulo === 'Total' ? AZUL : {}), ...(i === 0 ? { borderLeft: BORDE } : {}) }}>
                  <Monto v={c.valor(data.totales)} />
                </td>
              ))}
              {COSTO.map((c, i) => (
                <td key={c.titulo} className="px-4 py-2 text-right font-semibold tabular-nums whitespace-nowrap"
                  style={{ ...PRIMARIO, ...(i === 0 ? { borderLeft: BORDE } : {}) }}>
                  <Monto v={c.valor(data.totales)} />
                </td>
              ))}
              <td className="px-4 py-2 text-center font-semibold tabular-nums" style={{ borderLeft: BORDE }}>{data.totales.filasIncompletas.toLocaleString('es-CO')}</td>
            </FlitTr>
          </tfoot>
        </FlitTable>
    </>
  );
}

function Fila({ f }: { f: FilaConsolidado }) {
  return (
    <FlitTr>
      <td className="min-w-[12rem] px-4 py-2 font-semibold">{f.clienteNombre}</td>
      <td className="px-4 py-2 tabular-nums whitespace-nowrap">
        {/* Sin fecha de aprobación NO es un dato que falte: el trámite sigue esperando al
            organismo. El mismo texto que la celda de fechas del detalle. */}
        {f.periodo ?? <span className="italic" style={{ color: 'var(--flit-text-muted)' }}>Sin aprobar</span>}
      </td>
      <td className="px-4 py-2 text-center tabular-nums">{f.tramites.toLocaleString('es-CO')}</td>
      {COLUMNAS.map((c, i) => (
        <td key={c.titulo} className="px-4 py-2 text-right tabular-nums whitespace-nowrap"
          style={{ ...(c.titulo === 'Total' ? AZUL : {}), ...(i === 0 ? { borderLeft: BORDE } : {}) }}>
          <Monto v={c.valor(f)} negrita={c.titulo === 'Total'} />
        </td>
      ))}
      {COSTO.map((c, i) => (
        <td key={c.titulo} className="px-4 py-2 text-right tabular-nums whitespace-nowrap"
          style={{ ...PRIMARIO, ...(i === 0 ? { borderLeft: BORDE } : {}) }}
          title={c.titulo === 'Total costos' && f.tramitesCostoSinConfigurar > 0
            ? `${f.tramitesCostoSinConfigurar} trámites con un costo de proveedor sin configurar`
            : undefined}>
          <Monto v={c.valor(f)} negrita={c.titulo === 'Total costos'} />
        </td>
      ))}
      <td className="px-4 py-2 text-center" style={{ borderLeft: BORDE }}>
        {/* Un chip con el número, no una fila teñida: lo dice sin apoyarse en el color. */}
        {f.filasIncompletas > 0
          ? (
            <span aria-label={`${f.filasIncompletas} trámites con conceptos sin resolver`}>
              <StatusChip tone="draft">{f.filasIncompletas.toLocaleString('es-CO')}</StatusChip>
            </span>
          )
          : <span style={{ color: 'var(--flit-text-muted)' }}>0</span>}
      </td>
    </FlitTr>
  );
}
