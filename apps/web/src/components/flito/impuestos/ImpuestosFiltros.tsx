// Barra de filtros de la cola de Impuestos (UI Kit 2026, molde `#tramites`, decisión D3).
// Épica #14560 (ronda 2): el molde es `BarraFiltrosCola`, el MISMO del SOAT —tarjeta con el embudo,
// buscador + «Filtros» (panel), chips de lo aplicado y «Vistas rápidas» como chips (antes, un
// selector «Vista»)—. El ESTADO sigue en la página —alimenta la query de la cola y el cuerpo del
// export— y se filtra en vivo, como antes: el panel solo agrupa los controles. Nada de esto va a la
// URL (regla 14: el buscador lleva PII).
import type { ReactNode } from 'react';
import ThFiltroMulti from '../../flit/ThFiltroMulti';
import RangoFechas from '../../flit/RangoFechas';
import type { Preset } from '../../flit/FiltrosInteligentes';
import BarraFiltrosCola, { GrupoFiltros as Grupo, type FiltroActivo } from '../BarraFiltrosCola';

export type GestionImpuesto = '' | 'operaciones' | 'organismo';
type Rango = { desde: string; hasta: string };

export interface ImpuestosFiltrosProps<F> {
  /** El embudo de fases (`EmbudoEstadoCola`), primero dentro de la tarjeta. */
  embudo: ReactNode;
  esGestor: boolean;
  texto: string; setTexto: (t: string) => void;
  facetas: { companias: { id: number; nombre: string }[]; organismos: { codigo: string; nombre: string | null }[] } | null;
  companiasSel: string[]; setCompaniasSel: (v: string[]) => void;
  organismosSel: string[]; setOrganismosSel: (v: string[]) => void;
  gestionSel: GestionImpuesto; setGestionSel: (v: GestionImpuesto) => void;
  presets: Array<Preset<F>>; preset: string | null; onAplicarPreset: (p: Preset<F>) => void;
  creado: Rango; setCreado: (r: Rango) => void;
  solicitado: Rango; setSolicitado: (r: Rango) => void;
  pagado: Rango; setPagado: (r: Rango) => void;
  soloEstancado: boolean; setSoloEstancado: (v: boolean) => void;
  liquidadoPendiente: boolean; setLiquidadoPendiente: (v: boolean) => void;
  hayFiltros: boolean; limpiarFiltros: () => void;
}

const CASILLA = 'flex cursor-pointer items-center gap-2 text-sm font-semibold text-[color:var(--color-text-primary)]';
const GESTION: Record<Exclude<GestionImpuesto, ''>, string> = { operaciones: 'Operaciones', organismo: 'El organismo' };

export default function ImpuestosFiltros<F>(p: ImpuestosFiltrosProps<F>) {
  const sinRango: Rango = { desde: '', hasta: '' };
  // Los chips de lo aplicado reutilizan los rótulos de cada control; quitar uno es poner su control
  // en vacío, el mismo setter que usa el panel.
  const aplicados: FiltroActivo[] = [
    ...(p.companiasSel.length ? [{ id: 'companias', etiqueta: `Compañía (${p.companiasSel.length})`, quitar: () => p.setCompaniasSel([]) }] : []),
    ...(p.organismosSel.length ? [{ id: 'organismos', etiqueta: `Organismo (${p.organismosSel.length})`, quitar: () => p.setOrganismosSel([]) }] : []),
    ...(p.gestionSel ? [{ id: 'gestion', etiqueta: `Gestiona: ${GESTION[p.gestionSel]}`, quitar: () => p.setGestionSel('') }] : []),
    ...(p.creado.desde || p.creado.hasta ? [{ id: 'creado', etiqueta: 'Creado en FLITO', quitar: () => p.setCreado(sinRango) }] : []),
    ...(p.solicitado.desde || p.solicitado.hasta ? [{ id: 'solicitado', etiqueta: 'Solicitado', quitar: () => p.setSolicitado(sinRango) }] : []),
    ...(p.pagado.desde || p.pagado.hasta ? [{ id: 'pagado', etiqueta: 'Pagado', quitar: () => p.setPagado(sinRango) }] : []),
    ...(p.soloEstancado ? [{ id: 'estancado', etiqueta: 'Solo sin gestión', quitar: () => p.setSoloEstancado(false) }] : []),
    ...(p.liquidadoPendiente ? [{ id: 'liquidado', etiqueta: 'Liquidado, pendiente de pago', quitar: () => p.setLiquidadoPendiente(false) }] : []),
  ];

  // Los tres grupos van directo a la rejilla del panel de `BarraFiltrosCola` (1/2/3 columnas).
  const campos = (
    <>
      <Grupo titulo="Quién">
        <ThFiltroMulti seleccion={p.companiasSel} onCambio={p.setCompaniasSel} placeholder="Compañía"
          vacio="Sin compañías en la cola"
          opciones={(p.facetas?.companias ?? []).map((c) => ({ value: String(c.id), label: c.nombre }))} />
        {/* Al gestor no se le ofrece: ya está atado a su organismo y elegir otro solo vaciaría la cola. */}
        {!p.esGestor && (
          <ThFiltroMulti seleccion={p.organismosSel} onCambio={p.setOrganismosSel} placeholder="Organismo"
            vacio="Sin organismos en la cola"
            opciones={(p.facetas?.organismos ?? []).map((o) => ({ value: o.codigo, label: o.nombre ?? o.codigo }))} />
        )}
        {/* Al gestor tampoco: dentro de su frontera todo lo gestiona él, así que solo tendría
            una opción con resultados y otra siempre vacía. */}
        {!p.esGestor && (
          <label className="flex items-center gap-2 text-xs font-semibold text-[color:var(--color-text-secondary)]">
            Gestiona
            <select className="control max-w-[11rem]" value={p.gestionSel}
              onChange={(e) => p.setGestionSel(e.target.value as GestionImpuesto)}>
              <option value="">Cualquiera</option>
              <option value="operaciones">Operaciones</option>
              <option value="organismo">El organismo</option>
            </select>
          </label>
        )}
      </Grupo>
      {/* Orden del ciclo (creado → solicitado → pagado). El rótulo es además su `aria-label`, así
          que los tres rangos tienen nombres accesibles distintos. */}
      <Grupo titulo="Cuándo">
        <RangoFechas etiqueta="Creado en FLITO" valor={p.creado} onCambio={p.setCreado} />
        <RangoFechas etiqueta="Solicitado" valor={p.solicitado} onCambio={p.setSolicitado} />
        <RangoFechas etiqueta="Pagado" valor={p.pagado} onCambio={p.setPagado} />
      </Grupo>
      <Grupo titulo="Riesgo">
        <label className={CASILLA}>
          <input type="checkbox" className="size-4 accent-[var(--kit-azul)]" checked={p.soloEstancado}
            onChange={(e) => p.setSoloEstancado(e.target.checked)} />
          Solo sin gestión
        </label>
        <label className={CASILLA}>
          <input type="checkbox" className="size-4 accent-[var(--kit-azul)]" checked={p.liquidadoPendiente}
            onChange={(e) => p.setLiquidadoPendiente(e.target.checked)} />
          Liquidado, pendiente de pago
        </label>
      </Grupo>
    </>
  );

  return (
    <BarraFiltrosCola embudo={p.embudo} texto={p.texto} setTexto={p.setTexto}
      placeholder="Buscar placa, VIN, trámite, comprador…"
      panel={campos} cuentaPanel={aplicados.length} aplicados={aplicados}
      vistas={p.presets} vista={p.preset} onVista={p.onAplicarPreset}
      hayFiltros={p.hayFiltros} limpiarFiltros={p.limpiarFiltros} />
  );
}
