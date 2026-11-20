// Torre de Control (Épica #14590) — periodos, conversión al contrato y formatos de cifra (spec UX §4, §5.2).
import {
  DEPARTAMENTO_POR_CODIGO, ETIQUETAS_AGRUPACION_TORRE, getOrganismoByCodigo,
  type AgrupacionTorre, type FechaBaseTorre, type FiltroTorre, type MetricaTorreId, type UnidadMetricaTorre,
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

// ── Barra de fechas (RN-TOR-W2, spec vistas flexibles §3) ───────────────────

/** Atajos de la barra, en el orden de la spec. «Mes» (los `m:YYYY-MM`) va en su propio select. */
export const ATAJOS_PERIODO = [
  { valor: 'hoy', etiqueta: 'Hoy' }, { valor: 'ayer', etiqueta: 'Ayer' }, { valor: 'ultimos_7', etiqueta: 'Últimos 7 días' },
  { valor: 'mes', etiqueta: 'Este mes' }, { valor: 'mes_anterior', etiqueta: 'Mes anterior' },
  { valor: 'ultimos_6m', etiqueta: 'Últimos 6 meses' }, { valor: 'anio', etiqueta: 'Este año' },
] as const satisfies readonly { valor: PeriodoTorre; etiqueta: string }[];

/** Aritmética de días sobre el texto `YYYY-MM-DD`, en UTC para que ningún horario de verano mueva el día. */
function sumarDiasIso(base: string, n: number): string {
  const [y, m, d] = base.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const primeroDeMes = (y: number, m0: number) => new Date(Date.UTC(y, m0, 1)).toISOString().slice(0, 10);
const finDeMes = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).toISOString().slice(0, 10);

/**
 * Fechas reales de un periodo, como texto `YYYY-MM-DD` de Bogotá (nunca `Date`, lección de #805). Misma regla que
 * `resolverRango` de la API (RN-TOR-F5): «Últimos 6 meses» va alineado a mes (18 nov → 1 jun), «Mes anterior» es el
 * mes calendario completo y un mes suelto en curso llega hasta hoy. La web sigue enviando el preset; esto solo llena
 * los campos Desde/Hasta, y el subtítulo del resultado sigue usando `res.rango`.
 */
export function rangoDePeriodo(f: Pick<FiltrosTorre, 'periodo' | 'rango'>, hoy = hoyBogota()): { desde: string; hasta: string } {
  const [y, m] = hoy.split('-').map(Number);
  switch (f.periodo) {
    case 'hoy': return { desde: hoy, hasta: hoy };
    case 'ayer': { const a = sumarDiasIso(hoy, -1); return { desde: a, hasta: a }; }
    case 'ultimos_7': return { desde: sumarDiasIso(hoy, -6), hasta: hoy };
    case 'mes': return { desde: primeroDeMes(y, m - 1), hasta: hoy };
    case 'mes_anterior': return { desde: primeroDeMes(y, m - 2), hasta: finDeMes(y, m - 2) };
    case 'ultimos_6m': return { desde: primeroDeMes(y, m - 6), hasta: hoy };
    case 'anio': return { desde: `${y}-01-01`, hasta: hoy };
    case 'personalizado': return f.rango ?? { desde: primeroDeMes(y, m - 1), hasta: hoy };
    default: {
      const [ym, mm] = f.periodo.slice(2).split('-').map(Number);
      const fin = finDeMes(ym, mm - 1);
      return { desde: primeroDeMes(ym, mm - 1), hasta: fin > hoy ? hoy : fin };
    }
  }
}

/** «Mes»: el mes en curso y los 12 cerrados anteriores, del más reciente al más antiguo. */
export function opcionesMes(hoy = hoyBogota()): { valor: string; etiqueta: string }[] {
  const [y, m] = hoy.split('-').map(Number);
  const actual = { valor: `m:${y}-${String(m).padStart(2, '0')}`, etiqueta: `${MESES[m - 1]} ${y}` };
  return [actual, ...mesesConNombre(hoy).map((x) => ({ valor: x.clave, etiqueta: x.etiqueta }))];
}

/** «1 de noviembre de 2026» (anuncio del lector de pantalla). */
export function fechaLarga(v: string): string {
  const [y, m, d] = v.split('-').map(Number);
  return `${d} de ${MESES[m - 1].toLowerCase()} de ${y}`;
}

// ── Etiquetas del eje de tiempo (G1, spec vistas flexibles §4) ──────────────

const DIAS_SEMANA = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const diaSemana = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return DIAS_SEMANA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const TRIMESTRE = /^(\d{4})-?(?:T|Q)([1-4])$/i;

/**
 * Etiquetas de los cortes de un eje temporal a partir de la clave ISO: la corta para el eje y las cabeceras de la
 * tabla cruzada («1 jun», «jun 2026», «T3 2026») y la larga para el tip y el `aria-label`. En día y semana, el
 * primer corte y cada 1 de enero llevan el año. Una clave que no se reconoce conserva la etiqueta de la API.
 */
export function etiquetasCortesTorre(agrupacion: AgrupacionTorre, cortes: readonly { clave: string; etiqueta: string }[]): { cortas: string[]; largas: string[] } {
  const cortas: string[] = [];
  const largas: string[] = [];
  cortes.forEach(({ clave, etiqueta }, i) => {
    const dia = /^(\d{4})-(\d{2})-(\d{2})/.exec(clave);
    const mes = /^(\d{4})-(\d{2})$/.exec(clave);
    const tri = TRIMESTRE.exec(clave);
    if ((agrupacion === 'dia' || agrupacion === 'semana') && dia) {
      const [y, m, d] = [Number(dia[1]), Number(dia[2]), Number(dia[3])];
      const conAnio = i === 0 || (m === 1 && (agrupacion === 'dia' ? d === 1 : d <= 7));
      cortas.push(`${d} ${MESES_CORTOS[m - 1]}${conAnio ? ` ${y}` : ''}`);
      if (agrupacion === 'dia') largas.push(`${diaSemana(clave.slice(0, 10))} ${d} ${MESES_CORTOS[m - 1]} ${y}`);
      else {
        const [yf, mf, df] = sumarDiasIso(clave.slice(0, 10), 6).split('-').map(Number);
        largas.push(mf === m ? `Semana del ${d} al ${df} ${MESES_CORTOS[m - 1]} ${y}`
          : `Semana del ${d} ${MESES_CORTOS[m - 1]}${yf === y ? '' : ` ${y}`} al ${df} ${MESES_CORTOS[mf - 1]} ${yf}`);
      }
    } else if (agrupacion === 'mes' && (mes || dia)) {
      const r = (mes ?? dia)!;
      const [y, m] = [Number(r[1]), Number(r[2])];
      cortas.push(`${MESES_CORTOS[m - 1]} ${y}`);
      largas.push(`${MESES[m - 1].toLowerCase()} de ${y}`);
    } else if (agrupacion === 'trimestre' && (tri || dia || mes)) {
      const y = Number((tri ?? dia ?? mes)![1]);
      const q = tri ? Number(tri[2]) : Math.floor((Number((dia ?? mes)![2]) - 1) / 3) + 1;
      cortas.push(`T${q} ${y}`);
      largas.push(`T${q} ${y} (${MESES_CORTOS[(q - 1) * 3]}–${MESES_CORTOS[(q - 1) * 3 + 2]})`);
    } else {
      cortas.push(etiqueta);
      largas.push(etiqueta);
    }
  });
  return { cortas, largas };
}

// ── Comparación con el periodo anterior (V, RN-TOR-K3) ──────────────────────

export interface VariacionTorre { texto: string; accesible: string; flecha: '▲' | '▼' | '=' | null }

const NUEVO: VariacionTorre = { texto: 'Nuevo', accesible: 'nuevo, sin registros en el periodo anterior', flecha: null };
const SIN_BASE: VariacionTorre = { texto: '—', accesible: 'sin datos para comparar', flecha: null };

/**
 * «▲ 12,0 %», «▼ 3,2 pp», «= 0,0 %», «Nuevo» (anterior en 0 o inexistente y actual > 0) o «—» (los dos en 0). Sin
 * color: la flecha va `aria-hidden` y el texto accesible dice «sube/baja X %». `v` es la variación de la API
 * (RN-TOR-K3); `null` = sin base.
 */
export function textoVariacion(actual: number, anterior: number | null, v: number | null, en: 'relativa' | 'puntos'): VariacionTorre {
  if (v === null) return actual > 0 && (anterior === null || anterior === 0) ? NUEVO : SIN_BASE;
  const pts = en === 'puntos';
  const abs = Math.abs(v).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const u = pts ? 'pp' : '%';
  if (v > 0) return { texto: `${abs} ${u}`, accesible: `sube ${abs} ${pts ? 'puntos' : '%'}`, flecha: '▲' };
  if (v < 0) return { texto: `${abs} ${u}`, accesible: `baja ${abs} ${pts ? 'puntos' : '%'}`, flecha: '▼' };
  return { texto: `0,0 ${u}`, accesible: 'sin cambio', flecha: '=' };
}

/** Variación relativa calculada en la web (solo para «Los demás», que suma sus grupos). */
export const variacionRelativa = (actual: number, anterior: number): number | null =>
  anterior === 0 ? null : Math.round(((actual - anterior) / anterior) * 1000) / 10;

/** '2026-10-02' → '2 oct 2026'. A mano, sin `Date`, para que el día no se corra de zona. */
export function fechaCorta(v: string | null | undefined): string {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${Number(d)} ${MESES_CORTOS[Number(m) - 1]} ${y}`;
}

/**
 * Rango real que aplicó la API (RN-TOR-F5), compacto: «1 jun – 18 nov 2026», «15 dic 2025 – 10 ene 2026» o «18 nov 2026»
 * si es un solo día. A mano, sin `Date`, para que el día no se corra a UTC.
 */
export function fraseRango(r: { desde: string; hasta: string }): string {
  const [yd, md, dd] = r.desde.slice(0, 10).split('-').map(Number);
  const [yh, mh, dh] = r.hasta.slice(0, 10).split('-').map(Number);
  const hasta = `${dh} ${MESES_CORTOS[mh - 1]} ${yh}`;
  if (yd === yh && md === mh && dd === dh) return hasta;
  return `${dd} ${MESES_CORTOS[md - 1]}${yd === yh ? '' : ` ${yd}`} – ${hasta}`;
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
    // RN-TOR-F5 (D7): lo resuelve la API, alineado a mes. La web no calcula otro rango.
    case 'ultimos_6m': return { preset: 'ultimos_6m' };
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
    ...(f.companiaIds.length ? { companiaIds: f.companiaIds } : {}),
    ...(f.organismos.length ? { organismos: f.organismos } : {}),
    ...(f.departamentos.length ? { departamentos: f.departamentos } : {}),
    ...(f.tiposTramite.length ? { tiposTramite: f.tiposTramite } : {}),
    ...(f.flitEstados.length ? { flitEstados: f.flitEstados } : {}),
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

/**
 * Las del contrato (las mismas del Excel), salvo `flit_estado`: en pantalla es «Estado actual» (spec UX §2, D3), para
 * que no se lea como «el estado en que se aprobó».
 */
export const ETIQUETA_AGRUPACION: Record<AgrupacionTorre, string> = { ...ETIQUETAS_AGRUPACION_TORRE, flit_estado: 'Estado actual' };
export const AGRUPACIONES_TEMPORALES: readonly AgrupacionTorre[] = ['dia', 'semana', 'mes', 'trimestre'];
export const esTemporal = (a: AgrupacionTorre | ''): a is AgrupacionTorre => a !== '' && AGRUPACIONES_TEMPORALES.includes(a);

// ── La oración del Explorador (spec UX §3.1, §5.1, §5.5) ─────────────────────

/** En minúscula, para que la oración «según la fecha de …» se lea. */
export const FECHA_BASE_ORACION: Record<FechaBaseTorre, string> = {
  creacion: 'creación', aprobacion: 'aprobación', facturacion: 'facturación', pago: 'pago',
};

const PARTICIPIO_TRAMITES: Partial<Record<FechaBaseTorre, string>> = {
  creacion: 'Trámites creados', aprobacion: 'Trámites aprobados', facturacion: 'Trámites facturados',
};

/** «Trámites aprobados», «Costo de logística · por fecha de facturación», o el nombre solo en las de una fecha. */
export function medidaConFecha(metrica: MetricaTorreId, etiqueta: string, fechas: readonly FechaBaseTorre[], fecha: FechaBaseTorre | null): string {
  if (!fecha) return etiqueta;
  if (metrica === 'tramites') return PARTICIPIO_TRAMITES[fecha] ?? etiqueta;
  return fechas.length > 1 ? `${etiqueta} · por fecha de ${FECHA_BASE_ORACION[fecha]}` : etiqueta;
}

/** «A», «A y B», «A, B y C». */
export function listaY(v: readonly string[]): string {
  if (v.length <= 1) return v[0] ?? '';
  return `${v.slice(0, -1).join(', ')} y ${v[v.length - 1]}`;
}

/** «A», «A o B», «A, B o C». */
export function listaO(v: readonly string[]): string {
  if (v.length <= 1) return v[0] ?? '';
  return `${v.slice(0, -1).join(', ')} o ${v[v.length - 1]}`;
}

/** Resumen corto de una selección: «A», «A y 2 más». */
export const resumenSeleccion = (v: readonly string[]): string => (v.length <= 1 ? v[0] ?? '' : `${v[0]} y ${v.length - 1} más`);

/** Compañías del subtítulo: «Todas las compañías», «A», «A y B», «A, B y 1 más». */
export function resumenCompanias(nombres: readonly string[]): string {
  if (nombres.length === 0) return 'Todas las compañías';
  if (nombres.length <= 2) return listaY(nombres);
  return `${nombres[0]}, ${nombres[1]} y ${nombres.length - 2} más`;
}

const FRASE_PERIODO: Record<string, string> = {
  hoy: 'hoy', ayer: 'ayer', ultimos_7: 'en los últimos 7 días', mes: 'este mes', mes_anterior: 'el mes anterior',
  anio: 'este año', ultimos_6m: 'en los últimos 6 meses', personalizado: 'en el rango elegido',
};

/** «hoy», «en octubre de 2026», «en el rango elegido»… para el vacío («No hay trámites facturados hoy.»). */
export function frasePeriodo(f: Pick<FiltrosTorre, 'periodo'>): string {
  if (f.periodo.startsWith('m:')) {
    const [y, m] = f.periodo.slice(2).split('-').map(Number);
    return `en ${MESES[m - 1].toLowerCase()} de ${y}`;
  }
  return FRASE_PERIODO[f.periodo] ?? 'en el periodo';
}

/** Periodo corto (spec §5.5): de un mes o menos. Con él, el vacío ofrece «Ver los últimos 6 meses». */
export function esPeriodoCorto(f: Pick<FiltrosTorre, 'periodo' | 'rango'>): boolean {
  if (['hoy', 'ayer', 'ultimos_7', 'mes', 'mes_anterior'].includes(f.periodo) || f.periodo.startsWith('m:')) return true;
  if (f.periodo === 'personalizado' && f.rango) {
    const dias = (Date.parse(f.rango.hasta) - Date.parse(f.rango.desde)) / 86_400_000 + 1;
    return dias <= 31;
  }
  return false;
}

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
