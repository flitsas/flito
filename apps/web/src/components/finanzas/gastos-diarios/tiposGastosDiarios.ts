// Finanzas — Gastos diarios (HU #12624). Lo PURO de la pantalla: las cinco categorías en su orden,
// los rótulos, la lectura de la URL, la validación del rango y el total del periodo. Sin JSX ni
// React a propósito: `tiposGastosDiarios.test.ts` corre con `node --test` y aquí viven los tres
// mutantes del AC9 (quitar «estimado», sumar solo visibles, consultar al cambiar tipo de gasto).
//
// Las fechas son SIEMPRE 'yyyy-mm-dd' en texto (misma regla que `RangoFechas`): un `Date` desde ese
// texto cae en medianoche UTC y en Colombia retrocede un día.

import {
  GASTOS_DIARIOS_CATEGORIAS, GASTOS_DIARIOS_RANGO_DEFAULT_DIAS, GASTOS_DIARIOS_RANGO_MAX_DIAS,
  type GastosDiariosCategoria, type GastosDiariosTotales,
} from '@operaciones/shared-types';

export type { GastosDiariosCategoria, GastosDiariosTotales };

export interface CategoriaGasto {
  clave: GastosDiariosCategoria;
  /** Título de la tarjeta y de la pill. */
  titulo: string;
  /** Qué cuenta la cifra, bajo ella («SOAT pagados»). */
  rotulo: string;
  /** Qué día se toma: `title` corto del rótulo (la ficha lo cuenta entero). */
  cuando: string;
  /** El conteo en el `aria-label` de la región: «12 pagados», «1 trámite con logística». */
  conteo: (n: number) => string;
  /** Cómo se pinta en la gráfica (HU #12625): token de color del tema + patrón, para leerla sin color. */
  serie: SerieGrafica;
}

/** Los cinco patrones de `PatronesSerie`: uno por categoría, en este orden. */
export type PatronSerie = 'solido' | 'rayas' | 'puntos' | 'lineas' | 'cruz';

export interface SerieGrafica {
  /** Token CSS de `flit-tokens.css` (`--flit-serie-*`), con par claro/oscuro; nunca un hex. */
  token: `--flit-serie-${string}`;
  patron: PatronSerie;
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/**
 * Orden fijo (AC3): SOAT · Impuestos · Derechos de trámite · Logística · Servicios adicionales. Es
 * también el orden de apilado de la gráfica, de abajo arriba (HU #12625, AC1).
 */
export const CATEGORIAS: readonly CategoriaGasto[] = [
  { clave: 'soat', titulo: 'SOAT', rotulo: 'SOAT pagados', cuando: 'Pólizas pagadas, el día del pago.',
    conteo: (n) => plural(n, 'pagado', 'pagados'), serie: { token: '--flit-serie-soat', patron: 'solido' } },
  { clave: 'impuesto', titulo: 'Impuestos', rotulo: 'Impuestos pagados', cuando: 'Recibos pagados, el día del pago.',
    conteo: (n) => plural(n, 'pagado', 'pagados'), serie: { token: '--flit-serie-impuesto', patron: 'rayas' } },
  { clave: 'derecho', titulo: 'Derechos de trámite', rotulo: 'Derechos pagados', cuando: 'Derechos con fecha de pago, ese día.',
    conteo: (n) => plural(n, 'pagado', 'pagados'), serie: { token: '--flit-serie-derecho', patron: 'puntos' } },
  { clave: 'logistica', titulo: 'Logística', rotulo: 'Trámites con logística', cuando: 'Trámites con logística, el día de aprobación del trámite.',
    conteo: (n) => plural(n, 'trámite con logística', 'trámites con logística'),
    serie: { token: '--flit-serie-logistica', patron: 'lineas' } },
  { clave: 'serviciosAdicionales', titulo: 'Servicios adicionales', rotulo: 'Servicios asignados', cuando: 'Cada servicio asignado, el día en que se asignó.',
    conteo: (n) => plural(n, 'asignado', 'asignados'), serie: { token: '--flit-serie-servicios', patron: 'cruz' } },
];

/** Rótulos del bloque Total (AC4). La palabra «estimado» acompaña al GMF: es un mutante del AC9. */
export const ROTULOS_TOTAL = {
  suma: 'Suma de categorías',
  gmf: 'GMF (4×1000) estimado',
  total: 'Total con GMF',
  /** `title` y `aria-describedby` del GMF (copy del AC4). */
  notaGmf: 'Calculado sobre la suma del periodo; la liquidación lo calcula por trámite.',
  incluyeTodas: 'Incluye todas las categorías',
} as const;

export const esCategoria = (v: string): v is GastosDiariosCategoria =>
  (GASTOS_DIARIOS_CATEGORIAS as readonly string[]).includes(v);

export interface FiltrosGastos {
  /** Vacíos = últimos 30 días, que aplica el API sin parámetros (RN-09). */
  desde: string;
  hasta: string;
  /** NITs separados por coma, tal como viaja en la faceta del reporte; vacío = todas. */
  empresas: string;
  /** Las marcadas. Se pintan solo estas; el total no las mira (RN-08). */
  tipos: readonly GastosDiariosCategoria[];
}

export const FILTROS_INICIALES: FiltrosGastos = { desde: '', hasta: '', empresas: '', tipos: GASTOS_DIARIOS_CATEGORIAS };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** `?desde&hasta&empresas&tipos` → filtros. `tipos` ausente = las cinco; presente y vacío = ninguna. */
export function leerFiltros(params: URLSearchParams): FiltrosGastos {
  const iso = (k: string) => { const v = params.get(k) ?? ''; return ISO.test(v) ? v : ''; };
  const tipos = params.has('tipos')
    ? GASTOS_DIARIOS_CATEGORIAS.filter((c) => (params.get('tipos') ?? '').split(',').includes(c))
    : GASTOS_DIARIOS_CATEGORIAS;
  return { desde: iso('desde'), hasta: iso('hasta'), empresas: params.get('empresas') ?? '', tipos };
}

/** Filtros → query, sin lo que coincide con el arranque (`tipos` se omite con las cinco). */
export function escribirFiltros(f: FiltrosGastos): URLSearchParams {
  const p = new URLSearchParams();
  if (f.desde) p.set('desde', f.desde);
  if (f.hasta) p.set('hasta', f.hasta);
  if (f.empresas) p.set('empresas', f.empresas);
  if (f.tipos.length !== GASTOS_DIARIOS_CATEGORIAS.length) p.set('tipos', f.tipos.join(','));
  return p;
}

/**
 * Lo que dispara una consulta: `desde|hasta|empresas`. `tipos` NO está aquí a propósito: desmarcar
 * un tipo de gasto oculta su tarjeta sin petición (AC5). Es el tercer mutante del AC9.
 */
export const claveDeConsulta = (f: Pick<FiltrosGastos, 'desde' | 'hasta' | 'empresas'>) =>
  [f.desde, f.hasta, f.empresas].join('|');

export const hayFiltros = (f: FiltrosGastos) => escribirFiltros(f).toString() !== '';

const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export function hoyIso(ahora = new Date()): string {
  return iso(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
}

function sumarDias(base: string, n: number): string {
  const [y, m, d] = base.split('-').map(Number);
  const f = new Date(y, m - 1, d + n);
  return iso(f.getFullYear(), f.getMonth(), f.getDate());
}

/** Días entre dos ISO, ambos incluidos (`desde === hasta` → 1). Sin UTC: calendario local. */
export function diasEntre(desde: string, hasta: string): number {
  const dia = (v: string) => { const [y, m, d] = v.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((dia(hasta) - dia(desde)) / 86_400_000) + 1;
}

/** Los últimos 30 días con hoy incluido: lo que el API aplica sin parámetros y lo que el campo enseña. */
export function rangoPorDefecto(hoy = hoyIso()): { desde: string; hasta: string } {
  return { desde: sumarDias(hoy, -(GASTOS_DIARIOS_RANGO_DEFAULT_DIAS - 1)), hasta: hoy };
}

export const ERROR_RANGO = {
  invertido: 'La fecha final es anterior a la inicial.',
  largo: `El periodo no puede superar ${GASTOS_DIARIOS_RANGO_MAX_DIAS} días. Acorta el rango.`,
} as const;

/** La validación local (AC5): con error no se consulta. Vacíos o a medias → sin error (no se consulta por otra razón). */
export function validarRango(desde: string, hasta: string): string | null {
  if (!desde || !hasta) return null;
  if (hasta < desde) return ERROR_RANGO.invertido;
  if (diasEntre(desde, hasta) > GASTOS_DIARIOS_RANGO_MAX_DIAS) return ERROR_RANGO.largo;
  return null;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «18 ago» o «18 ago 2026». Mismo formato que `RangoFechas.bonita`, a mano para no mover el día de zona. */
export function diaCorto(v: string, conAnio: boolean): string {
  const [y, m, d] = v.split('-');
  return `${Number(d)} ${MESES[Number(m) - 1]}${conAnio ? ` ${y}` : ''}`;
}

/** «entre el 18 ago y el 16 sep 2026»; el año una sola vez si coincide. */
export function textoRango(desde: string, hasta: string): string {
  const mismoAnio = desde.slice(0, 4) === hasta.slice(0, 4);
  return `entre el ${diaCorto(desde, !mismoAnio)} y el ${diaCorto(hasta, true)}`;
}

/** «3.450.000», sin símbolo, para leerlo como «3.450.000 pesos». */
export const cifra = (valor: string | number) =>
  new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Number(valor));

/** `aria-label` de la región de una tarjeta (AC8): «SOAT: 12 pagados, 3.450.000 pesos». */
export const ariaTarjeta = (c: CategoriaGasto, cantidad: number, valor: string) =>
  `${c.titulo}: ${c.conteo(cantidad)}, ${cifra(valor)} pesos`;

/** Las cinco en cero: el estado vacío, aunque el 200 traiga la serie entera. */
export const sinGastos = (t: GastosDiariosTotales) => CATEGORIAS.every((c) => t[c.clave].cantidad === 0);

export interface TotalPeriodoDatos {
  suma: string;
  gmf: string;
  total: string;
  /** Hay tipos de gasto desmarcados: se dice «Incluye todas las categorías». */
  hayOcultas: boolean;
}

/**
 * El bloque Total (AC4, RN-08): SIEMPRE los tres valores del API, que suman las cinco categorías.
 * `tipos` solo decide si hay que avisar que hay ocultas; no entra en la cuenta. Segundo mutante.
 */
export function totalDelPeriodo(t: GastosDiariosTotales, tipos: readonly GastosDiariosCategoria[]): TotalPeriodoDatos {
  return { suma: t.base, gmf: t.gmfEstimado, total: t.total, hayOcultas: tipos.length < CATEGORIAS.length };
}
