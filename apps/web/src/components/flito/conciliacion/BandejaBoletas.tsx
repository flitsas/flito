// FLITO Conciliación — la bandeja: tres KPI y la lista de boletas (HU #11680, AC2 y AC3).
//
// **Los KPI se calculan sobre la MISMA respuesta que la tabla**, no con tres peticiones más: pedir
// por separado un conteo del mismo libro es arriesgarse a enseñar dos cifras distintas del mismo
// dinero (el argumento ya está escrito en la cabecera de `FlitoBolsas.tsx`).
//
// Y como el listado pagina por CURSOR y el API no devuelve totales del conjunto, cuando hay más de
// una página los KPI dicen que son de esta página. Es la única forma honesta de dar la cifra sin
// inventarla: un «3 por conciliar» que en realidad son 3 de 47 es peor que no ponerlo.

import { type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { EstadoBoleta, type BoletaResumenDto } from '@operaciones/shared-types';
import { fechaDia, pesos } from '../../../lib/bolsas';
import { ETIQUETA_ESTADO_BOLETA, TONO_ESTADO_BOLETA } from '../../../lib/conciliacion';
import StatusChip from '../../flit/StatusChip';
import KpiCard from '../../flit/KpiCard';
import PaginacionCursor from '../comparendos/PaginacionCursor';
import { FlitTable, FlitTh, FlitTr, flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

interface Props {
  items: BoletaResumenDto[];
  /** Hay más páginas: los KPI son de esta página y lo dicen. */
  parcial: boolean;
  pagina: number;
  hayAnterior: boolean;
  haySiguiente: boolean;
  onAnterior: () => void;
  onSiguiente: () => void;
  /** «Revisar» del KPI de líneas sin resolver: filtra por «Por conciliar» y enfoca la tabla. */
  onRevisar: () => void;
  tablaRef: RefObject<HTMLDivElement>;
}

export default function BandejaBoletas({
  items, parcial, pagina, hayAnterior, haySiguiente, onAnterior, onSiguiente, onRevisar, tablaRef,
}: Props) {
  const cargadas = items.filter((b) => b.estado === EstadoBoleta.CARGADA);
  const conciliadas = items.filter((b) => b.estado === EstadoBoleta.CONCILIADA);
  const conNovedades = cargadas.filter((b) => b.sinCuadrar > 0);
  const lineasSinResolver = conNovedades.reduce((suma, b) => suma + b.sinCuadrar, 0);
  const totalConciliado = conciliadas.reduce((suma, b) => suma + (b.totalCruzado ?? b.totalDeclarado), 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label="Por conciliar"
          value={cargadas.length}
          hint={conNovedades.length === 0
            ? 'Ninguna tiene líneas sin resolver.'
            : conNovedades.length === 1
              ? '1 tiene líneas sin resolver.'
              : `${conNovedades.length} tienen líneas sin resolver.`}
        />
        <KpiCard
          label="Conciliadas"
          value={conciliadas.length}
          hint={`${pesos(totalConciliado)} descontados de las bolsas.`}
        />
        <KpiCard
          label="Líneas sin resolver"
          value={lineasSinResolver}
          hint={lineasSinResolver === 0
            ? 'Todas las boletas cargadas cuadran.'
            : `En ${conNovedades.length === 1 ? '1 boleta' : `${conNovedades.length} boletas`}. `
              + 'Ninguna de ellas se puede conciliar.'}
        >
          {lineasSinResolver > 0 && (
            <button
              type="button"
              className={`${flitBtnSecondarySm} mt-3 w-fit`}
              style={flitBtnSecondaryStyle}
              onClick={onRevisar}
            >
              Revisar
            </button>
          )}
        </KpiCard>
      </div>

      {parcial && (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Las tres cifras son de las {items.length} boletas de esta página. Afina los filtros para que
          quepan en una sola.
        </p>
      )}

      {/* El contenedor recibe el foco desde «Revisar»: sin él, filtrar deja el foco donde estaba y
          quien navega con teclado no sabe que la lista de abajo cambió. */}
      <div ref={tablaRef} tabIndex={-1} className="outline-none">
        <FlitTable label="Boletas de conciliación">
          <thead>
            <tr>
              <FlitTh>Boleta</FlitTh>
              <FlitTh>Cliente</FlitTh>
              <FlitTh>Pagada</FlitTh>
              <FlitTh>Líneas</FlitTh>
              <FlitTh>Total boleta</FlitTh>
              <FlitTh>Estado</FlitTh>
              <FlitTh />
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <FlitTr key={b.id}>
                <td className="px-4 py-3 text-sm font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                  {b.referencia}
                </td>
                <td className="px-4 py-3 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                  {b.companiaNombre ?? 'Cliente sin nombre'}
                </td>
                {/* `fechaPago` es una columna `date`: con `new Date` retrocedería un día en Colombia. */}
                <td className="px-4 py-3 text-sm tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
                  {fechaDia(b.fechaPago)}
                </td>
                <td className="px-4 py-3 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
                  <span className="tabular-nums">{b.filas}</span>
                  {' · '}
                  {b.sinCuadrar === 0
                    ? 'todas cuadran'
                    : <span style={{ color: 'var(--flit-danger-ink)' }}>
                        {b.sinCuadrar === 1 ? '1 no cuadra' : `${b.sinCuadrar} no cuadran`}
                      </span>}
                </td>
                <td className="px-4 py-3 text-sm tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                  {pesos(b.totalDeclarado)}
                </td>
                <td className="px-4 py-3 text-sm">
                  <StatusChip tone={TONO_ESTADO_BOLETA[b.estado]}>
                    {ETIQUETA_ESTADO_BOLETA[b.estado]}
                  </StatusChip>
                </td>
                <td className="px-4 py-3 text-right">
                  {/* Enlace y no botón: el detalle vive en una ruta propia y tiene que poder
                      abrirse en otra pestaña, copiarse y enlazarse desde el reporte de costos. */}
                  <Link
                    to={`/flito/conciliacion/${b.id}`}
                    className={flitBtnSecondarySm}
                    style={flitBtnSecondaryStyle}
                    aria-label={`Abrir la boleta ${b.referencia}`}
                  >
                    Abrir
                  </Link>
                </td>
              </FlitTr>
            ))}
          </tbody>
        </FlitTable>
      </div>

      <PaginacionCursor
        enEstaPagina={items.length}
        sustantivo="boletas"
        pagina={pagina}
        hayAnterior={hayAnterior}
        haySiguiente={haySiguiente}
        onAnterior={onAnterior}
        onSiguiente={onSiguiente}
      />
    </div>
  );
}
