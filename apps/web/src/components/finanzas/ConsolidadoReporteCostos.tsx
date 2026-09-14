// La vista consolidada del reporte de costos: una fila por cliente y periodo (HU #12434, CF-12).
//
// Aquí no se opera, se lee y se exporta: sin casillas, sin acciones de fila, sin contadores. Todo
// viene agregado del API con LOS MISMOS filtros del detalle más el tipo de periodo; la pantalla no
// suma ni agrupa nada. Cuatro estados, con la petición siempre en manos de la página.

import StatusChip from '../flit/StatusChip';
import { FlitTable, FlitTh, FlitTr, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import Monto from './Monto';
import { CONCEPTO, type ConsolidadoReporte, type FilaConsolidado, type Totales } from './tiposReporteCostos';

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

const AZUL = { color: 'var(--flit-blue-text)' } as const;

export default function ConsolidadoReporteCostos({ data, cargando, error, onReintentar, onLimpiarFiltros }: {
  data: ConsolidadoReporte | null;
  cargando: boolean;
  error: string | null;
  onReintentar: () => void;
  onLimpiarFiltros: () => void;
}) {
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-red-600">No se pudo calcular el consolidado: {error}.</span>
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
      <div className="overflow-x-auto">
        <FlitTable label="Consolidado por cliente y periodo">
          <thead>
            <FlitTr>
              <FlitTh>Cliente</FlitTh>
              <FlitTh>Periodo</FlitTh>
              <FlitTh center>Trámites</FlitTh>
              {COLUMNAS.map((c) => <FlitTh key={c.titulo} center>{c.titulo}</FlitTh>)}
              <FlitTh center>Incompletos</FlitTh>
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
              {COLUMNAS.map((c) => (
                <td key={c.titulo} className="px-4 py-2 text-right font-semibold tabular-nums" style={c.titulo === 'Total' ? AZUL : undefined}>
                  <Monto v={c.valor(data.totales)} />
                </td>
              ))}
              <td className="px-4 py-2 text-center font-semibold tabular-nums">{data.totales.filasIncompletas.toLocaleString('es-CO')}</td>
            </FlitTr>
          </tfoot>
        </FlitTable>
      </div>
    </>
  );
}

function Fila({ f }: { f: FilaConsolidado }) {
  return (
    <FlitTr>
      <td className="px-4 py-2 font-semibold whitespace-nowrap">{f.clienteNombre}</td>
      <td className="px-4 py-2 tabular-nums whitespace-nowrap">
        {/* Sin fecha de aprobación NO es un dato que falte: el trámite sigue esperando al
            organismo. El mismo texto que la celda de fechas del detalle. */}
        {f.periodo ?? <span className="italic" style={{ color: 'var(--flit-text-muted)' }}>Sin aprobar</span>}
      </td>
      <td className="px-4 py-2 text-center tabular-nums">{f.tramites.toLocaleString('es-CO')}</td>
      {COLUMNAS.map((c) => (
        <td key={c.titulo} className="px-4 py-2 text-right tabular-nums" style={c.titulo === 'Total' ? AZUL : undefined}>
          <Monto v={c.valor(f)} negrita={c.titulo === 'Total'} />
        </td>
      ))}
      <td className="px-4 py-2 text-center">
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
