// Selector de periodo del reporte de costos (HU #12434, CF-05/06/07).
//
// No es un filtro nuevo: es una forma rápida de rellenar el rango de «Aprobación». Elegir un mes o
// un trimestre escribe `aprobadoDesde/aprobadoHasta` con el primer y el último día del periodo; el
// `RangoFechas` de al lado sigue siendo el que manda, y si se edita a mano el selector se limita a
// decir «Personalizado» hasta que se vuelva a elegir algo. Por eso este componente NO tiene estado
// propio del periodo: lo deriva del rango en cada render y solo escribe en respuesta a un clic.
// Un selector que reescribiera el rango en cada render pisaría lo que el usuario acaba de poner.
//
// Las fechas se calculan con getters UTC, el mismo criterio con el que el API asigna `mes` y
// `trimestre` a cada fila: así lo que el selector pide y lo que la celda dice caen en el mismo mes.

import type { Rango } from '../flit/RangoFechas';
import { FlitPillGroup, FlitPillButton, flitInp } from '../flit/flitPageKit';
import type { TipoPeriodo } from './tiposReporteCostos';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const TRIMESTRES = ['T1', 'T2', 'T3', 'T4'];

const iso = (y: number, m: number, d: number): string =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Último día del mes `m` (base cero) del año `y`, sin tocar zonas horarias. */
const ultimoDia = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Rango cerrado del mes `m` (base cero) de `y`. */
export const rangoDeMes = (y: number, m: number): Rango =>
  ({ desde: iso(y, m, 1), hasta: iso(y, m, ultimoDia(y, m)) });

/** Rango cerrado del trimestre calendario `t` (base cero: 0 = T1) de `y` (RN-05). */
export const rangoDeTrimestre = (y: number, t: number): Rango =>
  ({ desde: iso(y, t * 3, 1), hasta: iso(y, t * 3 + 2, ultimoDia(y, t * 3 + 2)) });

export const rangoDe = (tipo: TipoPeriodo, anio: number, indice: number): Rango =>
  tipo === 'mes' ? rangoDeMes(anio, indice) : rangoDeTrimestre(anio, indice);

/** El mes en curso según el reloj del navegador, en UTC. */
export function periodoEnCurso(): { anio: number; indice: number } {
  const n = new Date();
  return { anio: n.getUTCFullYear(), indice: n.getUTCMonth() };
}

/**
 * Qué periodo del tipo dado ES este rango, si es exactamente uno. Cualquier otro rango —incluido el
 * vacío— es «Personalizado». Se compara el texto de las fechas, no instantes: 'yyyy-mm-dd' es la
 * única forma en la que la pantalla las maneja.
 */
export function periodoDe(tipo: TipoPeriodo, r: Rango): { anio: number; indice: number } | null {
  if (!/^\d{4}-\d{2}-01$/.test(r.desde)) return null;
  const anio = Number(r.desde.slice(0, 4));
  const mes = Number(r.desde.slice(5, 7)) - 1;
  if (tipo === 'mes') {
    return rangoDeMes(anio, mes).hasta === r.hasta ? { anio, indice: mes } : null;
  }
  if (mes % 3 !== 0) return null;
  const t = mes / 3;
  return rangoDeTrimestre(anio, t).hasta === r.hasta ? { anio, indice: t } : null;
}

/** Cómo se lee el periodo puesto: «Septiembre 2026», «T3 2026» o «Personalizado». */
export function textoPeriodo(tipo: TipoPeriodo, r: Rango): string {
  const p = periodoDe(tipo, r);
  if (!p) return 'Personalizado';
  return tipo === 'mes' ? `${MESES[p.indice]} ${p.anio}` : `${TRIMESTRES[p.indice]} ${p.anio}`;
}

export default function SelectorPeriodo({ tipo, onTipo, valor, onCambio }: {
  tipo: TipoPeriodo;
  onTipo: (t: TipoPeriodo) => void;
  /** El rango de «Aprobación», tal cual está. */
  valor: Rango;
  onCambio: (r: Rango) => void;
}) {
  const actual = periodoDe(tipo, valor);
  const hoy = periodoEnCurso();
  // Con «Personalizado» los selects arrancan desde el mes en curso: es el punto de partida más
  // probable, y elegir cualquier cosa vuelve a mandar.
  const anio = actual?.anio ?? hoy.anio;
  const indiceHoy = tipo === 'mes' ? hoy.indice : Math.floor(hoy.indice / 3);
  // Años a ofrecer: cuatro hacia atrás y el que esté puesto, por si un enlace guardado es más viejo.
  const anios = Array.from({ length: 5 }, (_, i) => hoy.anio - 4 + i);
  if (!anios.includes(anio)) anios.unshift(anio);
  const indices = tipo === 'mes' ? MESES : TRIMESTRES;

  const cambiarTipo = (t: TipoPeriodo) => {
    if (t === tipo) return;
    onTipo(t);
    // Al pasar de mes a trimestre (o al revés) se elige el periodo del NUEVO tipo que contiene lo
    // que estaba puesto: septiembre → T3, T3 → julio. Con «Personalizado», el mes en curso.
    const base = actual ?? { anio: hoy.anio, indice: indiceHoy };
    const mesBase = tipo === 'mes' ? base.indice : base.indice * 3;
    onCambio(rangoDe(t, base.anio, t === 'mes' ? mesBase : Math.floor(mesBase / 3)));
  };

  return (
    <fieldset className="flex min-w-0 flex-wrap items-center gap-2 rounded-[10px] border px-2 pb-1"
      style={{ borderColor: 'var(--flit-border-input)' }}>
      <legend className="px-1 text-xs font-semibold" style={{ color: 'var(--flit-text-muted)' }}>Periodo</legend>
      <FlitPillGroup label="Tipo de periodo">
        <FlitPillButton active={tipo === 'mes'} pressed={tipo === 'mes'} onClick={() => cambiarTipo('mes')}>Mes</FlitPillButton>
        <FlitPillButton active={tipo === 'trimestre'} pressed={tipo === 'trimestre'} onClick={() => cambiarTipo('trimestre')}>Trimestre</FlitPillButton>
      </FlitPillGroup>
      <select className={`${flitInp} !w-auto`} style={{ height: 30, paddingTop: 0, paddingBottom: 0 }} aria-label="Año"
        value={anio} onChange={(e) => onCambio(rangoDe(tipo, Number(e.target.value), actual?.indice ?? indiceHoy))}>
        {anios.map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      <select className={`${flitInp} !w-auto`} style={{ height: 30, paddingTop: 0, paddingBottom: 0 }}
        aria-label={tipo === 'mes' ? 'Mes' : 'Trimestre'}
        value={actual ? String(actual.indice) : ''}
        onChange={(e) => onCambio(rangoDe(tipo, anio, Number(e.target.value)))}>
        {/* La opción «Personalizado» solo existe mientras el rango no sea un periodo: no se puede
            elegir, se está en ella. */}
        {!actual && <option value="" disabled>Personalizado</option>}
        {indices.map((n, i) => <option key={n} value={i}>{n}</option>)}
      </select>
      {/* Lo que hay puesto, dicho de una vez y anunciado al cambiar. */}
      <span className="text-xs" role="status" aria-live="polite" style={{ color: 'var(--flit-text-secondary)' }}>
        {textoPeriodo(tipo, valor)}
      </span>
    </fieldset>
  );
}
