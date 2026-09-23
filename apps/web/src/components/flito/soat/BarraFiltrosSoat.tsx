// Barra de herramientas de la cola SOAT (HU #12819, §5 de `docs/ux/flito-soat-rediseno-experiencia.md`).
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

import { useState, type ReactNode, type RefObject } from 'react';
import { FilterX, Search, SlidersHorizontal } from 'lucide-react';
import { ESTADO_SOAT_LABEL, EstadoSoat, type FiltroVigenciaCola } from '@operaciones/shared-types';
import ThFiltroMulti from '../../flit/ThFiltroMulti';
import RangoFechas from '../../flit/RangoFechas';
import type { Preset } from '../../flit/FiltrosInteligentes';
import { FiltroVigenciaSoat } from '../VigenciaSoat';
import {
  FlitCard, FlitPillGroup, FlitPillButton, flitInp, flitBtnSecondary, flitBtnSecondarySm,
} from '../../flit/flitPageKit';
import type { FacetasSoat } from './tipos';

export type GestionSel = '' | 'operaciones' | 'proveedor';
export type PresetSoat = Preset<{ estado: EstadoSoat | 'todos'; estancado: boolean }>;

export interface BarraFiltrosSoatProps {
  refPills: RefObject<HTMLDivElement>;
  esGestor: boolean; esCliente: boolean;
  estadosDisponibles: EstadoSoat[];
  estado: EstadoSoat | 'todos'; setEstado: (e: EstadoSoat | 'todos') => void;
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
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{titulo}</p>
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

  return (
    <FlitCard>
      <div className="flex flex-wrap items-center gap-3">
        <div ref={p.refPills} tabIndex={-1} className="flit-focus max-w-full rounded-[999px]">
          <FlitPillGroup>
            {!esGestor && (
              <FlitPillButton active={estado === 'todos'} onClick={() => setEstado('todos')}>Todos</FlitPillButton>
            )}
            {p.estadosDisponibles.map((e) => (
              <FlitPillButton key={e} active={estado === e} onClick={() => setEstado(e)}>{ESTADO_SOAT_LABEL[e]}</FlitPillButton>
            ))}
          </FlitPillGroup>
        </div>
        <div className="relative w-full min-w-0 sm:ml-auto sm:w-72">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--flit-text-muted)' }} />
          <input className={`${flitInp} h-10 pl-9`} placeholder="Buscar placa, VIN, comprador…" aria-label="Buscar SOAT"
            value={texto} onChange={(e) => p.setTexto(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={flitBtnSecondary} aria-expanded={abierto} aria-controls={ID_PANEL}
            onClick={() => setAbierto((a) => !a)}>
            <SlidersHorizontal size={16} aria-hidden="true" className="shrink-0" />
            {activosPanel > 0 ? `Más filtros (${activosPanel})` : 'Más filtros'}
          </button>
          {(p.hayFiltros || !!texto) && (
            <button type="button" className={flitBtnSecondary} onClick={p.limpiarFiltros}>
              <FilterX size={16} aria-hidden="true" className="shrink-0" />
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {presets.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Vistas rápidas:</span>
          {presets.map((pr) => {
            const puesto = p.preset === pr.nombre;
            return (
              <button key={pr.nombre} type="button" aria-pressed={puesto} title={pr.descripcion}
                className={flitBtnSecondarySm}
                style={puesto ? { borderColor: 'var(--flit-blue-text)', color: 'var(--flit-blue-text)', background: 'var(--flit-bg-app)' } : undefined}
                onClick={() => (puesto ? p.limpiarFiltros() : p.onAplicarPreset(pr))}>
                {pr.nombre}
              </button>
            );
          })}
        </div>
      )}

      {abierto && (
        <div id={ID_PANEL} role="group" aria-label="Más filtros"
          className="mt-4 grid grid-cols-1 gap-5 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3"
          style={{ borderColor: 'var(--flit-border-soft)' }}>
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
              <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
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
            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
              <input type="checkbox" className="flit-focus" checked={p.soloEstancado} onChange={(e) => p.setSoloEstancado(e.target.checked)} />
              Solo sin gestión
            </label>
          </Grupo>
        </div>
      )}
    </FlitCard>
  );
}
