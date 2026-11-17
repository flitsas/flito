// Torre de Control (Épica #14590) — periodos, conversión al contrato y formatos de cifra (spec UX §4, §5.2).
import {
  DEPARTAMENTO_POR_CODIGO, getOrganismoByCodigo, type AgrupacionTorre, type FiltroTorre, type UnidadMetricaTorre,
} from '@operaciones/shared-types';
import type { FiltrosTorre, PeriodoTorre } from '../../lib/torreFiltros';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Hoy en Bogotá (`YYYY-MM-DD`): la API cuenta los días en esa zona. */
export function hoyBogota(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function sumarDias(base: string, n: number): string {
  const [y, m, d] = base.split('-').map(Number);
  const f = new Date(y, m - 1, d + n);
  return iso(f.getFullYear(), f.getMonth(), f.getDate());
}
function ultimoDia(y: number, m: number): number { return new Date(y, m + 1, 0).getDate(); }

/** Los 12 meses cerrados anteriores al actual, del más reciente al más antiguo. */
export function mesesConNombre(hoy = hoyBogota()): { clave: `m:${string}`; etiqueta: string }[] {
  const [y, m] = hoy.split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const f = new Date(y, m - 2 - i, 1);
    return { clave: `m:${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}` as const, etiqueta: `${MESES[f.getMonth()]} ${f.getFullYear()}` };
  });
}

const ETIQUETA_PERIODO: Record<string, string> = {
  hoy: 'Hoy', ayer: 'Ayer', ultimos_7: 'Últimos 7 días', mes: 'Este mes', mes_anterior: 'Mes anterior',
  ultimos_6m: 'Últimos 6 meses', anio: 'Este año', personalizado: 'Rango personalizado…',
};

export function opcionesPeriodo(): { valor: string; etiqueta: string }[] {
  return [
    ...['hoy', 'ayer', 'ultimos_7', 'mes', 'mes_anterior', 'ultimos_6m', 'anio'].map((v) => ({ valor: v, etiqueta: ETIQUETA_PERIODO[v] })),
    ...mesesConNombre().map((m) => ({ valor: m.clave, etiqueta: m.etiqueta })),
    { valor: 'personalizado', etiqueta: ETIQUETA_PERIODO.personalizado },
  ];
}

/** '2026-10-02' → '2 oct 2026'. A mano, sin `Date`, para que el día no se corra de zona. */
export function fechaCorta(v: string | null | undefined): string {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${Number(d)} ${MESES_CORTOS[Number(m) - 1]} ${y}`;
}

export function etiquetaPeriodo(f: Pick<FiltrosTorre, 'periodo' | 'rango'>): string {
  if (f.periodo.startsWith('m:')) {
    const [y, m] = f.periodo.slice(2).split('-').map(Number);
    return `${MESES[m - 1]} ${y}`;
  }
  if (f.periodo === 'personalizado' && f.rango) return `${fechaCorta(f.rango.desde)} – ${fechaCorta(f.rango.hasta)}`;
  return ETIQUETA_PERIODO[f.periodo] ?? 'Este mes';
}

function rangoDe(periodo: PeriodoTorre, rango: FiltrosTorre['rango']): FiltroTorre['rango'] {
  const hoy = hoyBogota();
  switch (periodo) {
    case 'hoy': return { preset: 'hoy' };
    case 'ayer': return { preset: 'ayer' };
    case 'mes': return { preset: 'mes' };
    case 'mes_anterior': return { preset: 'mes_anterior' };
    case 'anio': return { preset: 'anio' };
    case 'ultimos_7': return { desde: sumarDias(hoy, -6), hasta: hoy };
    case 'ultimos_6m': {
      const [y, m] = hoy.split('-').map(Number);
      const ini = new Date(y, m - 1 - 5, 1);
      return { desde: iso(ini.getFullYear(), ini.getMonth(), 1), hasta: hoy };
    }
    case 'personalizado': return rango ?? { preset: 'mes' };
    default: {
      const [y, m] = periodo.slice(2).split('-').map(Number);
      return { desde: iso(y, m - 1, 1), hasta: iso(y, m - 1, ultimoDia(y, m - 1)) };
    }
  }
}

/** Estado de la barra → `FiltroTorre` del contrato. */
export function aFiltroTorre(f: FiltrosTorre): FiltroTorre {
  return {
    rango: rangoDe(f.periodo, f.rango),
    ...(f.companiaId ? { companiaIds: [f.companiaId] } : {}),
    ...(f.organismo ? { organismos: [f.organismo] } : {}),
    ...(f.departamento ? { departamentos: [f.departamento] } : {}),
    ...(f.tipoTramite ? { tiposTramite: [f.tipoTramite] } : {}),
    ...(f.flitEstado ? { flitEstados: [f.flitEstado] } : {}),
  };
}

export const nombreOrganismo = (codigo: string) => getOrganismoByCodigo(codigo)?.nombre ?? codigo;
export const nombreDepartamento = (codigo: string) => DEPARTAMENTO_POR_CODIGO[codigo] ?? codigo;

/** 'en_radicacion' → 'En radicacion'. Los estados de FLIT llegan como clave. */
export function humanizar(v: string | null | undefined): string {
  if (!v) return '—';
  const t = v.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const ETIQUETA_AGRUPACION: Record<AgrupacionTorre, string> = {
  dia: 'Día', semana: 'Semana', mes: 'Mes', trimestre: 'Trimestre', compania: 'Compañía', organismo: 'Organismo de tránsito',
  departamento: 'Departamento', tipo_tramite: 'Tipo de trámite', flit_estado: 'Estado',
};
export const AGRUPACIONES_TEMPORALES: readonly AgrupacionTorre[] = ['dia', 'semana', 'mes', 'trimestre'];

// ── Cifras ───────────────────────────────────────────────────────────────────

const entero = (n: number) => Math.round(n).toLocaleString('es-CO');
const decimal = (n: number) => n.toLocaleString('es-CO', { maximumFractionDigits: 1, minimumFractionDigits: 0 });

/** «$ 18.400.000» (tablas). */
export const pesos = (n: number) => `$ ${entero(n)}`;

/** «$ 18,4 millones» (cifra grande). */
export function pesosCorto(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$ ${decimal(n / 1e9)} mil millones`;
  if (a >= 1e6) return `$ ${decimal(n / 1e6)} millones`;
  return pesos(n);
}

/** Horas → «3,5 días» (o «5 horas» si no llega a un día). */
export function duracion(horas: number): string {
  if (horas < 24) { const h = Math.round(horas); return `${h} ${h === 1 ? 'hora' : 'horas'}`; }
  const d = Math.round((horas / 24) * 10) / 10;
  return `${decimal(d)} ${d === 1 ? 'día' : 'días'}`;
}

export const porcentaje = (n: number) => `${decimal(Math.round(n * 10) / 10)} %`;

/** Formato de una cifra según la unidad del catálogo. `corto` = la cifra grande de la tarjeta. */
export function formatoUnidad(unidad: UnidadMetricaTorre, n: number, corto = false): string {
  if (unidad === 'cop') return corto ? pesosCorto(n) : pesos(n);
  if (unidad === 'horas') return duracion(n);
  if (unidad === 'pct') return porcentaje(n);
  return entero(n);
}

export const conteo = entero;

/** «−38 %» con el signo menos tipográfico. */
export const variacion = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n))} %`;
