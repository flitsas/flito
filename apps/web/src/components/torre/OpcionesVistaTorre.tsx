// Torre de Control (Épica #14590) — fila de vista del resultado del Explorador (spec UX vistas flexibles §5, P-7).
// Actúa sobre la PRESENTACIÓN, no sobre la pregunta: «Mostrar» N grupos (`top`, RN-TOR-K4), «Valores» Absoluto/% (solo
// en el cruce y en conteo/dinero, RN-TOR-K5) y «Comparar con el periodo anterior» (`comparar`, RN-TOR-K1..K3). Solo se
// pintan los controles que aplican; si no aplica ninguno, la fila no existe. Peso secundario: ninguno es primaria.
import { TOPES_TORRE, type TopGruposTorre } from '@operaciones/shared-types';
import FiltroSegmentado from '../flit/FiltroSegmentado';
import FlitSelect from '../flit/FlitSelect';
import FlitSwitch from '../flit/FlitSwitch';

export interface VistaTorre {
  top: TopGruposTorre;
  pct: boolean;
  comparar: boolean;
}

export const VISTA_TORRE_INICIAL: VistaTorre = { top: TOPES_TORRE.TOP_GRUPOS_DEFECTO as TopGruposTorre, pct: false, comparar: false };

const OPCIONES_TOP = TOPES_TORRE.TOP_GRUPOS.map((n) => ({ valor: String(n), etiqueta: `${n} grupos` }));
const OPCIONES_VALORES = [{ valor: 'absoluto', etiqueta: 'Absoluto' }, { valor: 'pct', etiqueta: '%' }] as const;

export default function OpcionesVistaTorre({ vista, onCambio, conTop, conPct, conComparar, notaTop }: {
  vista: VistaTorre;
  onCambio: (v: VistaTorre) => void;
  conTop: boolean;
  conPct: boolean;
  conComparar: boolean;
  /** Nota en línea bajo «Mostrar» (p. ej. el tope de 12 columnas). */
  notaTop?: string;
}) {
  if (!conTop && !conPct && !conComparar) return null;
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3" data-torre="opciones-vista">
      {conTop && (
        <div className="w-full sm:w-44">
          <FlitSelect label="Mostrar" value={String(vista.top)} opciones={OPCIONES_TOP} ayuda={notaTop}
            onChange={(v) => onCambio({ ...vista, top: Number(v) as TopGruposTorre })} />
        </div>
      )}
      {conPct && (
        <div className="flex min-w-0 flex-col gap-1.5 pb-1">
          <span className="text-[0.8125rem] font-semibold" style={{ color: 'var(--flit-text-primary)' }} aria-hidden="true">Valores</span>
          <FiltroSegmentado ariaLabel="Valores: absoluto o porcentaje" opciones={OPCIONES_VALORES} valor={vista.pct ? 'pct' : 'absoluto'}
            onCambio={(v) => onCambio({ ...vista, pct: v === 'pct' })} />
        </div>
      )}
      {conComparar && (
        <label className="box-content flex h-10 cursor-pointer items-center gap-3 pb-1 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          <FlitSwitch etiqueta="Comparar con el periodo anterior" checked={vista.comparar} testId="torre-comparar"
            onToggle={(c) => onCambio({ ...vista, comparar: c })} />
          <span aria-hidden="true">Comparar con el periodo anterior</span>
        </label>
      )}
    </div>
  );
}
