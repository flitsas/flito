// Barra de herramientas de la cola SOAT (HU 12819, §5 de `docs/ux/flito-soat-rediseno-experiencia.md`).
//
// Hasta esta HU era un muro: tres multiselect, dos `select`, las vistas rápidas, tres rangos, una
// casilla y «Limpiar» en un solo `flex-wrap` (11 renglones a 375 px antes de la primera fila). Ahora:
//   · renglón 1 — pastillas de estado, búsqueda, «Más filtros (n)» y «Limpiar filtros»;
//   · renglón 2 — las vistas rápidas, el atajo de más valor, a un clic y a la vista (NO al Cliente:
//     su copy habla de ANS y de proveedor, jerga de trastienda — P-1 de la spec);
//   · panel plegable «Más filtros», en rejilla por intención: Quién · Cuándo · Riesgo.
// Con el panel plegado, el `(n)` del botón es el estado persistente de los filtros que no se ven.
//
// El ESTADO de los filtros se queda en la página, porque alimenta la query de la cola y el cuerpo del
// export; esta barra solo lo pinta y lo cambia. Lo único propio es si el panel está abierto.
//
// UI Kit 2026 (molde #tramites): se viste con las clases de `PanelFiltros` (`.filtros`, buscador con
// lupa, botón secundario, panel) sin usar el componente, porque él cambiaría los textos («Filtros»,
// «Limpiar todo») y filtraría al «Aplicar» en vez de en vivo. Los estados van como chips del kit
// (`FiltroSegmentado`): el `Embudo` pide un conteo por estado que el API de la cola no da.

import { useState, type ReactNode, type RefObject } from 'react';
import { ESTADO_SOAT_LABEL, EstadoSoat, type FiltroVigenciaCola } from '@operaciones/shared-types';
import ThFiltroMulti from '../../flit/ThFiltroMulti';
import RangoFechas from '../../flit/RangoFechas';
import type { Preset } from '../../flit/FiltrosInteligentes';
import { FiltroVigenciaSoat } from '../VigenciaSoat';
import EmbudoSoat from './EmbudoSoat';
import { Icono } from '../../flit/kit/Icono';
import { FlitCard, flitInp } from '../../flit/flitPageKit';
import { PASTILLA_INCOMPLETA_LABEL, type FacetasSoat, type FiltroEstadoSoat } from './tipos';

export type GestionSel = '' | 'operaciones' | 'proveedor';
export type PresetSoat = Preset<{ estado: EstadoSoat | 'todos'; estancado: boolean }>;

export interface BarraFiltrosSoatProps {
  refPills: RefObject<HTMLDivElement>;
  esGestor: boolean; esCliente: boolean;
  estadosDisponibles: EstadoSoat[];
  estado: FiltroEstadoSoat; setEstado: (e: FiltroEstadoSoat) => void;
  /** HU 12997: «Por validar» (primera) y «Descartadas» (última). Solo con `soat.incompletas.buscar`. */
  conIncompletas: boolean;
  texto: string; setTexto: (t: string) => void;
  facetas: FacetasSoat | null;
  companiasSel: string[]; setCompaniasSel: (v: string[]) => void;
  organismosSel: string[]; setOrganismosSel: (v: string[]) => void;
  proveedoresSel: string[]; setProveedoresSel: (v: string[]) => void;
  gestionSel: GestionSel; setGestionSel: (v: GestionSel) => void;
  vigenciaSel: '' | FiltroVigenciaCola; setVigenciaSel: (v: '' | FiltroVigenciaCola) => void;
  presets: PresetSoat[]; preset: string | null; onAplicarPreset: (p: PresetSoat) => void;
  creadoDesde: string; creadoHasta: string; setCreado: (desde: string, hasta: string) => void;
  solicitadoDesde: string; solicitadoHasta: string; setSolicitado: (desde: string, hasta: string) => void;
  pagadoDesde: string; pagadoHasta: string; setPagado: (desde: string, hasta: string) => void;
  soloEstancado: boolean; setSoloEstancado: (v: boolean) => void;
  hayFiltros: boolean; limpiarFiltros: () => void;
}

const ID_PANEL = 'soat-mas-filtros';

function Grupo({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-text-tertiary)]">{titulo}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export default function BarraFiltrosSoat(p: BarraFiltrosSoatProps) {
  const { esGestor, esCliente, estado, setEstado, texto } = p;
  const [abierto, setAbierto] = useState(false);
  // Compañía para el Cliente solo si su cola tiene más de una (§3): con una sola, filtrar por ella
  // no cambia nada. Para Operaciones y gestor, como siempre.
  const conCompania = !esCliente || (p.facetas?.companias.length ?? 0) > 1;
  const conProveedor = !esGestor && !esCliente;
  // Cuántos filtros del PANEL están puestos: es lo que se ve con el panel plegado.
  const activosPanel = [
    p.companiasSel.length > 0, p.organismosSel.length > 0, p.proveedoresSel.length > 0, !!p.gestionSel,
    !!(p.creadoDesde || p.creadoHasta), !!(p.solicitadoDesde || p.solicitadoHasta),
    !!(p.pagadoDesde || p.pagadoHasta), !!p.vigenciaSel, p.soloEstancado,
  ].filter(Boolean).length;
  const presets = esCliente ? [] : p.presets;

  // Las pastillas de estado, en el orden de siempre: Todos · Por validar · estados · Descartadas.
  const opcionesEstado: Array<{ valor: FiltroEstadoSoat; etiqueta: string }> = [
    ...(!esGestor ? [{ valor: 'todos' as FiltroEstadoSoat, etiqueta: 'Todos' }] : []),
    ...(p.conIncompletas ? [{ valor: 'incompleta' as FiltroEstadoSoat, etiqueta: PASTILLA_INCOMPLETA_LABEL.incompleta }] : []),
    ...p.estadosDisponibles.map((e) => ({ valor: e as FiltroEstadoSoat, etiqueta: ESTADO_SOAT_LABEL[e] })),
    ...(p.conIncompletas ? [{ valor: 'descartada' as FiltroEstadoSoat, etiqueta: PASTILLA_INCOMPLETA_LABEL.descartada }] : []),
  ];

  return (
    <FlitCard>
      <div className="filtros" data-kit="filtros">
      <div ref={p.refPills} tabIndex={-1} className="flit-focus mb-3 max-w-full overflow-x-auto rounded-[9px]">
        <EmbudoSoat ariaLabel="Estado del SOAT" opciones={opcionesEstado} valor={estado} onCambio={setEstado} />
      </div>
      <div className="filtros__barra">
        <div className="control-icono filtros__buscar">
          <Icono nombre="buscar" size={18} />
          <input className="control" type="search" placeholder="Buscar placa, VIN, comprador…" aria-label="Buscar SOAT"
            value={texto} onChange={(e) => p.setTexto(e.target.value)} />
        </div>
        <button type="button" className="btn secondary filtros__boton" aria-expanded={abierto} aria-controls={ID_PANEL}
          onClick={() => setAbierto((a) => !a)}>
          <Icono nombre="filtro" size={20} />
          {activosPanel > 0 ? `Más filtros (${activosPanel})` : 'Más filtros'}
        </button>
        {(p.hayFiltros || !!texto) && (
          <button type="button" className="btn ghost" onClick={p.limpiarFiltros}>
            <Icono nombre="cerrar" size={16} />
            Limpiar filtros
          </button>
        )}
      </div>

      {presets.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-[color:var(--color-text-secondary)]">Vistas rápidas:</span>
          {presets.map((pr) => {
            const puesto = p.preset === pr.nombre;
            return (
              <button key={pr.nombre} type="button" aria-pressed={puesto} title={pr.descripcion}
                className="chip chip--sm h-10 min-h-0 whitespace-nowrap transition-colors"
                onClick={() => (puesto ? p.limpiarFiltros() : p.onAplicarPreset(pr))}>
                {pr.nombre}
              </button>
            );
          })}
        </div>
      )}

      {abierto && (
        <div id={ID_PANEL} role="group" aria-label="Más filtros"
          className="filtros__panel mt-3 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Grupo titulo="Quién">
            {conCompania && (
              <ThFiltroMulti seleccion={p.companiasSel} onCambio={p.setCompaniasSel} placeholder="Compañía"
                vacio="Sin compañías en la cola"
                opciones={(p.facetas?.companias ?? []).map((c) => ({ value: String(c.id), label: c.nombre }))} />
            )}
            <ThFiltroMulti seleccion={p.organismosSel} onCambio={p.setOrganismosSel} placeholder="Organismo"
              vacio="Sin organismos en la cola"
              opciones={(p.facetas?.organismos ?? []).map((o) => ({ value: o.codigo, label: o.nombre ?? o.codigo }))} />
            {/* Al gestor no se le ofrece: ya está atado a su proveedor y elegir otro solo vaciaría la
                cola. Al cliente tampoco: los nombres de los proveedores son justo lo que el backend le
                quita de cada fila, y `facetasCola` se los devuelve vacíos. */}
            {conProveedor && (
              <ThFiltroMulti seleccion={p.proveedoresSel} onCambio={p.setProveedoresSel} placeholder="Proveedor"
                vacio="Sin proveedores en la cola"
                opciones={(p.facetas?.proveedores ?? []).map((pr) => ({ value: pr.id, label: pr.nombre }))} />
            )}
            {conProveedor && (
              <label className="flex items-center gap-2 text-xs font-semibold text-[color:var(--color-text-secondary)]">
                Gestiona
                <select className={`${flitInp} h-10 max-w-[11rem]`} value={p.gestionSel}
                  onChange={(e) => p.setGestionSel(e.target.value as GestionSel)}>
                  <option value="">Cualquiera</option>
                  <option value="operaciones">Operaciones</option>
                  <option value="proveedor">Un proveedor</option>
                </select>
              </label>
            )}
          </Grupo>

          {/* Creado → solicitado → pagado: el orden del ciclo. El rótulo es además su `aria-label`,
              así que los tres rangos tienen nombres accesibles distintos. */}
          <Grupo titulo="Cuándo">
            <RangoFechas etiqueta="Creado en FLITO" valor={{ desde: p.creadoDesde, hasta: p.creadoHasta }}
              onCambio={(r) => p.setCreado(r.desde, r.hasta)} />
            <RangoFechas etiqueta="Solicitado" valor={{ desde: p.solicitadoDesde, hasta: p.solicitadoHasta }}
              onCambio={(r) => p.setSolicitado(r.desde, r.hasta)} />
            <RangoFechas etiqueta="Pagado" valor={{ desde: p.pagadoDesde, hasta: p.pagadoHasta }}
              onCambio={(r) => p.setPagado(r.desde, r.hasta)} />
          </Grupo>

          <Grupo titulo="Riesgo">
            {/* La guarda es `!esCliente` y NO la de «Gestiona»: al gestor este filtro sí le sirve —es
                su reclamación—, y al Cliente el backend ni siquiera le acepta el parámetro
                (`filtrosPermitidos`), así que ofrecérselo sería un control que no hace nada. */}
            {!esCliente && <FiltroVigenciaSoat valor={p.vigenciaSel} onCambio={p.setVigenciaSel} />}
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-[color:var(--color-text-secondary)]">
              <input type="checkbox" className="flit-focus" checked={p.soloEstancado} onChange={(e) => p.setSoloEstancado(e.target.checked)} />
              Solo sin gestión
            </label>
          </Grupo>
        </div>
      )}
      </div>
    </FlitCard>
  );
}
