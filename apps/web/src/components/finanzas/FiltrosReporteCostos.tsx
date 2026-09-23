// La tarjeta de filtros del reporte de costos (HU #12434). Tres bandas y se acabó: arriba EN QUÉ
// punto del cobro está el trámite —que es a lo que se entra—, en medio sobre QUÉ trámites (búsqueda,
// empresa, tipo, estado, organismo) y abajo CUÁNDO (el periodo y los dos rangos), cada control del
// mismo alto y en su columna.

import RangoFechas from '../flit/RangoFechas';
import { FlitCard, flitInp, FlitPillGroup, flitPillBtn, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import FiltroMulti from './FiltroMulti';
import SelectorPeriodo from './SelectorPeriodo';
import { ALTO_CONTROL, ETAPAS, type Facetas, type FiltrosDetalle, type Resumen } from './tiposReporteCostos';

export default function FiltrosReporteCostos({ filtros, onCambio, facetas, facetasCargando, resumen, hayFiltros, onLimpiar }: {
  filtros: FiltrosDetalle;
  onCambio: (parche: Partial<FiltrosDetalle>) => void;
  facetas: Facetas | null;
  facetasCargando: boolean;
  /** Los contadores de las etapas. Cuentan con los demás filtros puestos, no sobre todo. */
  resumen: Resumen | null;
  hayFiltros: boolean;
  onLimpiar: () => void;
}) {
  return (
    <FlitCard className="!p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <FlitPillGroup>
          {ETAPAS.map((e) => (
            <button key={e.v} type="button" title={e.ayuda} onClick={() => onCambio({ etapa: e.v })}
              aria-pressed={filtros.etapa === e.v}
              className="flit-focus inline-flex items-center gap-2 rounded-[999px] px-4 py-2 text-xs font-semibold transition-colors"
              style={flitPillBtn(filtros.etapa === e.v)}>
              {e.label}
              {/* El número decide a dónde ir: sin él hay que entrar en cada pestaña para ver si
                  tiene trabajo dentro. */}
              {resumen && e.cuenta && (
                <span className="rounded-[999px] px-1.5 py-0.5 text-[10px] tabular-nums"
                  style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>
                  {e.cuenta(resumen).toLocaleString('es-CO')}
                </span>
              )}
            </button>
          ))}
        </FlitPillGroup>

        <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}
          title="Con soporte cargado de SOAT, impuesto, derecho y logística — saltando los que la compañía autogestiona.">
          <input type="checkbox" checked={filtros.docCompleta} onChange={(e) => onCambio({ docCompleta: e.target.checked })} />
          Solo con soportes completos
        </label>

        {/* Solo `ml-auto`: el tamaño se queda el del botón secundario de siempre. */}
        <button className={`${flitBtnSecondary} ml-auto`} style={flitBtnSecondaryStyle}
          disabled={!hayFiltros} onClick={onLimpiar}>Limpiar filtros</button>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <input className={flitInp} style={ALTO_CONTROL} placeholder="Placa, VIN o trámite FLIT…"
          aria-label="Buscar" value={filtros.buscar} onChange={(e) => onCambio({ buscar: e.target.value })} />
        <select className={flitInp} style={ALTO_CONTROL} aria-label="Empresa" value={filtros.empresa}
          onChange={(e) => onCambio({ empresa: e.target.value })}>
          <option value="">Todas las empresas</option>
          {facetas?.empresas.map((e) => <option key={e.valor} value={e.valor}>{e.nombre}</option>)}
        </select>
        <select className={flitInp} style={ALTO_CONTROL} aria-label="Tipo de trámite" value={filtros.tipo}
          onChange={(e) => onCambio({ tipo: e.target.value })}>
          <option value="">Todos los tipos</option>
          {facetas?.tipos.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <FiltroMulti rotulo="Estado" ariaLabel="Estado del trámite"
          opciones={(facetas?.estados ?? []).map((e) => ({ valor: e, nombre: e }))}
          seleccion={filtros.estados} onCambio={(estados) => onCambio({ estados })}
          cargando={facetasCargando} textoVacio="Sin estados que ofrecer" textoCualquiera="Cualquier estado" />
        {/* Va después de Estado: filtra sobre QUÉ trámites, no cuándo. La selección viaja por
            código y se lee por nombre: el código a secas no se enseña nunca (CF-08). */}
        <FiltroMulti rotulo="OT" ariaLabel="Organismo de tránsito"
          opciones={facetas?.organismos ?? []}
          seleccion={filtros.organismos} onCambio={(organismos) => onCambio({ organismos })}
          cargando={facetasCargando} plural="organismos"
          textoVacio="Sin organismos que ofrecer" textoCualquiera="Cualquier organismo" />
      </div>

      {/* CUÁNDO. El selector rellena «Aprobación»; los dos rangos son independientes y van
          rotulados: «desde/hasta» a secas, con dos fechas en juego, no dice sobre cuál filtra. */}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <SelectorPeriodo tipo={filtros.tipoPeriodo} onTipo={(tipoPeriodo) => onCambio({ tipoPeriodo })}
          valor={{ desde: filtros.aprobadoDesde, hasta: filtros.aprobadoHasta }}
          onCambio={(r) => onCambio({ aprobadoDesde: r.desde, aprobadoHasta: r.hasta })} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <RangoFechas etiqueta="Aprobación" valor={{ desde: filtros.aprobadoDesde, hasta: filtros.aprobadoHasta }}
            onCambio={(r) => onCambio({ aprobadoDesde: r.desde, aprobadoHasta: r.hasta })} />
          <RangoFechas etiqueta="Creación" valor={{ desde: filtros.desde, hasta: filtros.hasta }}
            onCambio={(r) => onCambio({ desde: r.desde, hasta: r.hasta })} />
        </div>
      </div>
    </FlitCard>
  );
}
