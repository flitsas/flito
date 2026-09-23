// Barra de filtros de la cola SOAT (HU #12819, fase 0): movida tal cual desde `pages/FlitoSoat.tsx`.
// El ESTADO de los filtros se queda en la página, porque alimenta la query de la cola y el cuerpo
// del export; esta barra solo lo pinta y lo cambia.

import type { RefObject } from 'react';
import { ESTADO_SOAT_LABEL, EstadoSoat, type FiltroVigenciaCola } from '@operaciones/shared-types';
import ThFiltroMulti from '../../flit/ThFiltroMulti';
import RangoFechas from '../../flit/RangoFechas';
import FiltrosInteligentes, { type Preset } from '../../flit/FiltrosInteligentes';
import { FiltroVigenciaSoat } from '../VigenciaSoat';
import {
  FlitCard, FlitPillGroup, FlitPillButton, flitInp, flitBtnSecondary, flitBtnSecondaryStyle,
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

export default function BarraFiltrosSoat(p: BarraFiltrosSoatProps) {
  const { esGestor, esCliente, estado, setEstado, texto } = p;
  return (
      <FlitCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div ref={p.refPills} tabIndex={-1} className="flit-focus rounded-[999px]">
            <FlitPillGroup>
              {!esGestor && (
                <FlitPillButton active={estado === 'todos'} onClick={() => setEstado('todos')}>Todos</FlitPillButton>
              )}
              {p.estadosDisponibles.map((e) => (
                <FlitPillButton key={e} active={estado === e} onClick={() => setEstado(e)}>{ESTADO_SOAT_LABEL[e]}</FlitPillButton>
              ))}
            </FlitPillGroup>
          </div>
          <input className={`${flitInp} max-w-xs`} placeholder="Buscar placa, VIN, comprador…"
            value={texto} onChange={(e) => p.setTexto(e.target.value)} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <ThFiltroMulti seleccion={p.companiasSel} onCambio={p.setCompaniasSel} placeholder="Compañía"
            vacio="Sin compañías en la cola"
            opciones={(p.facetas?.companias ?? []).map((c) => ({ value: String(c.id), label: c.nombre }))} />
          <ThFiltroMulti seleccion={p.organismosSel} onCambio={p.setOrganismosSel} placeholder="Organismo"
            vacio="Sin organismos en la cola"
            opciones={(p.facetas?.organismos ?? []).map((o) => ({ value: o.codigo, label: o.nombre ?? o.codigo }))} />
          {/* Al gestor no se le ofrece: ya está atado a su proveedor y elegir otro solo vaciaría la
              cola. Al cliente tampoco: los nombres de los proveedores son justo lo que el backend le
              quita de cada fila, y `facetasCola` se los devuelve vacíos. */}
          {!esGestor && !esCliente && (
            <ThFiltroMulti seleccion={p.proveedoresSel} onCambio={p.setProveedoresSel} placeholder="Proveedor"
              vacio="Sin proveedores en la cola"
              opciones={(p.facetas?.proveedores ?? []).map((pr) => ({ value: pr.id, label: pr.nombre }))} />
          )}

          {!esGestor && !esCliente && (
            <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
              Gestiona
              <select className={`${flitInp} max-w-[11rem]`} value={p.gestionSel}
                onChange={(e) => p.setGestionSel(e.target.value as GestionSel)}>
                <option value="">Cualquiera</option>
                <option value="operaciones">Operaciones</option>
                <option value="proveedor">Un proveedor</option>
              </select>
            </label>
          )}

          {/* La guarda es `!esCliente` y NO la de «Gestiona» (`!esGestor && !esCliente`): al gestor
              este filtro sí le sirve —es su reclamación—, y al Cliente el backend ni siquiera le
              acepta el parámetro (`filtrosPermitidos`), así que ofrecérselo sería un control que no
              hace nada. */}
          {!esCliente && <FiltroVigenciaSoat valor={p.vigenciaSel} onCambio={p.setVigenciaSel} />}

          <FiltrosInteligentes presets={p.presets} activo={p.preset}
            onAplicar={p.onAplicarPreset} onQuitar={p.limpiarFiltros} />

          {/* Antes de «Solicitado» y «Pagado»: es el orden del ciclo (creado → solicitado → pagado).
              El rótulo es además su `aria-label`, así que los tres rangos de la pantalla tienen
              nombres accesibles distintos. */}
          <RangoFechas etiqueta="Creado en FLITO" valor={{ desde: p.creadoDesde, hasta: p.creadoHasta }}
            onCambio={(r) => p.setCreado(r.desde, r.hasta)} />
          <RangoFechas etiqueta="Solicitado" valor={{ desde: p.solicitadoDesde, hasta: p.solicitadoHasta }}
            onCambio={(r) => p.setSolicitado(r.desde, r.hasta)} />
          <RangoFechas etiqueta="Pagado" valor={{ desde: p.pagadoDesde, hasta: p.pagadoHasta }}
            onCambio={(r) => p.setPagado(r.desde, r.hasta)} />

          <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
            <input type="checkbox" checked={p.soloEstancado} onChange={(e) => p.setSoloEstancado(e.target.checked)} />
            Solo sin gestión
          </label>

          {(p.hayFiltros || !!texto) && (
            <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={p.limpiarFiltros}>Limpiar filtros</button>
          )}
        </div>
      </FlitCard>
  );
}
