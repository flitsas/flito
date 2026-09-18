// La tarjeta de filtros de Gastos diarios (HU #12624, AC5): empresa, periodo y tipo de gasto.
// Empresa y periodo consultan; tipo de gasto solo oculta tarjetas (RN-08). Todo lo que se ve aquí
// sale de la URL, que es la fuente de verdad del hook.

import RangoFechas, { type Rango } from '../../flit/RangoFechas';
import { FlitCard, FlitPillButton, FlitPillGroup, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../../flit/flitPageKit';
import { ALTO_CONTROL } from '../tiposReporteCostos';
import { CATEGORIAS, type FiltrosGastos, type GastosDiariosCategoria } from './tiposGastosDiarios';
import type { OpcionEmpresa } from './useGastosDiarios';

const ID_ERROR_RANGO = 'gastos-rango-error';

export default function FiltrosGastosDiarios({
  filtros, rangoVisible, errorRango, empresas, empresasCargando, hayFiltros,
  onEmpresa, onRango, onTipo, onLimpiar,
}: {
  filtros: FiltrosGastos;
  rangoVisible: Rango;
  errorRango: string | null;
  empresas: OpcionEmpresa[];
  empresasCargando: boolean;
  hayFiltros: boolean;
  onEmpresa: (v: string) => void;
  onRango: (r: Rango) => void;
  onTipo: (c: GastosDiariosCategoria) => void;
  onLimpiar: () => void;
}) {
  return (
    <FlitCard className="!p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="gastos-empresa" className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Empresa</label>
          <select id="gastos-empresa" className={flitInp} style={ALTO_CONTROL} value={filtros.empresas}
            onChange={(e) => onEmpresa(e.target.value)}>
            <option value="">{empresasCargando ? 'Cargando empresas…' : 'Todas las empresas'}</option>
            {empresas.map((e) => <option key={e.valor} value={e.valor}>{e.nombre}</option>)}
          </select>
        </div>
        <div>
          <RangoFechas etiqueta="Periodo" valor={rangoVisible} onCambio={onRango}
            describedBy={errorRango ? ID_ERROR_RANGO : undefined} />
          {errorRango && (
            <p id={ID_ERROR_RANGO} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger)' }}>{errorRango}</p>
          )}
        </div>
        <button type="button" className={`${flitBtnSecondary} ml-auto`} style={flitBtnSecondaryStyle}
          onClick={onLimpiar} disabled={!hayFiltros}>
          Limpiar filtros
        </button>
      </div>
      {/* `role="group"` con nombre: el grupo de pills del kit solo sabe ser `tablist`, y aquí son
          conmutadores (`aria-pressed`), no pestañas. */}
      <div role="group" aria-labelledby="gastos-tipo-rotulo" className="mt-3 flex flex-wrap items-center gap-2">
        <span id="gastos-tipo-rotulo" className="text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Tipo de gasto</span>
        <FlitPillGroup>
          {CATEGORIAS.map((c) => {
            const marcada = filtros.tipos.includes(c.clave);
            return (
              <FlitPillButton key={c.clave} active={marcada} pressed={marcada} onClick={() => onTipo(c.clave)}>
                {/* La pill del kit capitaliza cada palabra; «Derechos De Trámite» no es español. */}
                <span className="normal-case">{c.titulo}</span>
              </FlitPillButton>
            );
          })}
        </FlitPillGroup>
      </div>
    </FlitCard>
  );
}
