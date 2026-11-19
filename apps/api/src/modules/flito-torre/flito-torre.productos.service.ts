// Torre de Control Gerencial (Épica #14590, B3) — Torre › Productos: SOAT, impuestos y derechos de tránsito.
//
// RN-TOR-PR1 (B3-AC1, invariante): cada KPI y cada fila de tabla es un conjunto de `CONJUNTOS_TORRE` (con su
//   segmento) contado sobre el MISMO fragmento que lista el detalle (`contarConjuntos` / `totalFragmento` / GROUP BY
//   sobre `fragmentoConjunto`). La cifra y el `total` de su detalle no pueden discrepar.
// RN-TOR-PR2: las tablas agrupan por la dimensión del conjunto (`estado`, `motivo`) o por `claveAgrupacion` de la
//   secretaría; las de estado muestran los 4 estados (en 0, sin destino); las demás, las 10 filas más grandes y el
//   resto en «Otros» (sin destino: no es un segmento). La fila total es el conjunto sin segmento.
// RN-TOR-PR3: sin `FUNCION_TORRE_DINERO`, `pagadosValor` y el `valor` de las filas van `null` y la frase no lo dice.
// RN-TOR-PR4: solo conteos y sumas; no proyecta ninguna columna del titular (ni placa), así que no hay
//   `logPiiAccess` (regla 16: se registra la lectura de columnas personales del titular; la lista con placa va por el
//   detalle, que sí registra). Ojo: las tablas de motivo AGRUPAN TEXTO LIBRE (`motivo_rechazo` del impuesto lo escribe
//   el gestor). Su etiqueta legible viaja solo en este body autenticado, a quien tiene `torre.tablero_productos.ver`;
//   la clave de la fila y el segmento del destino (que la web pone en la URL) son la clave opaca `claveMotivo`
//   (RN-TOR-P4), nunca el texto.
import { sql } from 'drizzle-orm';
import {
  conjuntoTorre, fraseDeConjunto, type CifraExplicada, type ConjuntoTorreId, type DestinoCifra, type FilaTablaProductosTorre,
  type SegmentoDetalle, type TablaAreaTorre, type TablaProductosTorre, type TableroProductos,
} from '@operaciones/shared-types';
import { CONJUNTOS_SQL, contarConjuntos, dondeFragmento, fragmentoConjunto, totalFragmento, type Umbrales } from './flito-torre.conjuntos.js';
import { claveAgrupacion } from './flito-torre.filtro.js';
import { aConjunto, definicionDe } from './flito-torre.frases.js';
import { SIN_COMPANIA, enTorre, nombreOrganismo, nombresCompania, type Ejecutor } from './flito-torre.metricas.service.js';
import { conCacheTablero, num, rangoTablero, type ContextoTablero } from './flito-torre.tablero-comun.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';

const NINGUNO: DestinoCifra = { tipo: 'ninguno' };
const COP = (n: number): string => `$${Math.round(n).toLocaleString('es-CO')}`;
export const destino = (n: number, c: ConjuntoTorreId, segmentos?: SegmentoDetalle[]): DestinoCifra => (n > 0 ? aConjunto(c, segmentos) : NINGUNO);

/** Estados del SOAT y del impuesto (mismo enum de valores), en el orden del flujo. */
export const ESTADOS_PRODUCTO = ['pendiente', 'solicitado', 'con_novedad', 'pagado'] as const;
const ETIQUETA_ESTADO: Record<string, string> = { pendiente: 'Pendiente', solicitado: 'Solicitado', con_novedad: 'Con novedad', pagado: 'Pagado' };
const ETIQUETA_MOTIVO: Record<string, string> = {
  runt_sin_respuesta: 'El RUNT no respondió', derecho: 'Derecho de tránsito', soat: 'SOAT', impuesto: 'Impuesto',
};
const etiquetaMotivo = (k: string | null): string => (k == null ? 'Sin motivo' : ETIQUETA_MOTIVO[k] ?? (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' '));
export const FILAS_TABLA_MAX = 10;
export const CLAVE_OTROS = '__otros';

/** La KPI que ES un conjunto: su frase y su definición salen del catálogo. */
export function kpi(c: ConjuntoTorreId, n: number, u: Umbrales, extra: Partial<CifraExplicada> & { cola?: string } = {}): CifraExplicada {
  const def = conjuntoTorre(c);
  const { cola, ...resto } = extra;
  const frase = fraseDeConjunto(def, n, def.umbral ? u[def.umbral] : undefined);
  return { frase: n > 0 && cola ? `${frase} ${cola}` : frase, definicion: definicionDe(c, u), destino: destino(n, c), ...resto };
}

type Dimension = TablaAreaTorre['dimension'];

/** B4: las tablas de Logística y Financiera reusan `tablaArea` con sus estados y su orden. */
export interface OpcionesTabla {
  /** Estados en el orden del flujo (se muestran aunque estén en 0); defecto, los del SOAT/impuesto. */
  estados?: readonly string[];
  etiquetasEstado?: Readonly<Record<string, string>>;
  /** Ordenar por valor ↓ (solo con permiso de dinero; si no, por cantidad). */
  ordenValor?: boolean;
}

/** RN-TOR-PR2: una tabla = el conjunto agrupado por su dimensión. */
export async function tablaArea(
  q: Ejecutor, ctx: ContextoTablero, u: Umbrales, c: ConjuntoTorreId, dimension: Dimension, titulo: string, conValor: boolean,
  op: OpcionesTabla = {},
): Promise<TablaAreaTorre> {
  const estados = op.estados ?? ESTADOS_PRODUCTO;
  const etiquetasEstado = op.etiquetasEstado ?? ETIQUETA_ESTADO;
  const f = fragmentoConjunto(c, ctx, u);
  const def = conjuntoTorre(c);
  const k = dimension === 'organismo' || dimension === 'compania' ? claveAgrupacion(dimension, f.dims, undefined)
    : CONJUNTOS_SQL[c].dimensiones![dimension]!;
  const suma = conValor && f.cols.valor ? sql`, COALESCE(sum(${f.cols.valor}), 0)::numeric AS v` : sql`, NULL::numeric AS v`;
  // Motivo: la clave es opaca (RN-TOR-P4); la etiqueta, el motivo corto (todas las filas de una clave tienen el mismo).
  const etiquetaSql = dimension === 'motivo' ? sql`, min(${f.cols.motivo!}) AS e` : sql`, NULL::text AS e`;
  const orden = op.ordenValor && ctx.dinero && conValor ? sql`ORDER BY 3 DESC NULLS LAST, 2 DESC, 1 ASC NULLS LAST` : sql`ORDER BY 2 DESC, 1 ASC NULLS LAST`;
  const filas = await q<{ k: string | null; n: number; v: string | null; e: string | null }>(sql`SELECT ${k} AS k, count(*)::int AS n${suma}${etiquetaSql}
    FROM ${f.desde} WHERE ${dondeFragmento(f)} GROUP BY 1 ${orden}`);
  const valor = (v: string | number | null): number | null | undefined => (!conValor ? undefined : ctx.dinero ? num(v) : null);
  const fila = (clave: string | null, etiqueta: string, n: number, v: string | number | null, conDestino = true): FilaTablaProductosTorre => {
    const out: FilaTablaProductosTorre = {
      clave, etiqueta, n, destino: conDestino ? destino(n, c, [{ dimension, valores: [clave] }]) : NINGUNO,
    };
    const val = valor(v);
    if (val !== undefined) out.valor = val;
    return out;
  };
  const textoMotivo = new Map(filas.map((r) => [r.k, r.e]));
  const nombres = dimension === 'compania' ? await nombresCompania(q, filas.map((r) => r.k).filter((x): x is string => x != null).map(Number)) : null;
  const etiquetaDe = (clave: string | null): string => (dimension === 'estado' ? etiquetasEstado[clave ?? ''] ?? clave ?? 'Sin estado'
    : dimension === 'organismo' ? nombreOrganismo(clave)
      : dimension === 'compania' ? (clave == null ? SIN_COMPANIA : nombres!.get(Number(clave)) ?? `Compañía ${clave}`)
        : etiquetaMotivo(textoMotivo.get(clave) ?? null));

  let salida: FilaTablaProductosTorre[];
  if (dimension === 'estado') {
    const por = new Map(filas.map((r) => [r.k, r]));
    salida = [
      ...estados.map((e) => fila(e, etiquetaDe(e), num(por.get(e)?.n), por.get(e)?.v ?? 0)),
      ...filas.filter((r) => !(estados as readonly (string | null)[]).includes(r.k)).map((r) => fila(r.k, etiquetaDe(r.k), num(r.n), r.v)),
    ];
  } else {
    const top = filas.slice(0, FILAS_TABLA_MAX);
    const resto = filas.slice(FILAS_TABLA_MAX);
    salida = top.map((r) => fila(r.k, etiquetaDe(r.k), num(r.n), r.v));
    if (resto.length) {
      salida.push(fila(CLAVE_OTROS, `Otros (${resto.length})`, resto.reduce((a, r) => a + num(r.n), 0), resto.reduce((a, r) => a + num(r.v), 0), false));
    }
  }
  const nTotal = filas.reduce((a, r) => a + num(r.n), 0);
  const total: FilaTablaProductosTorre = { clave: null, etiqueta: 'Total', n: nTotal, destino: destino(nTotal, c) };
  const vTotal = valor(filas.reduce((a, r) => a + num(r.v), 0));
  if (vTotal !== undefined) total.valor = vTotal;
  return {
    titulo, dimension, conjunto: c, definicion: definicionDe(c, u), conValor, filas: salida, total,
    filtrosIgnorados: [...def.filtrosIgnorados],
  };
}

/** Las tablas de Productos no cortan por compañía. */
const tabla = async (
  q: Ejecutor, ctx: ContextoTablero, u: Umbrales, c: ConjuntoTorreId, dimension: TablaProductosTorre['dimension'], titulo: string, conValor: boolean,
): Promise<TablaProductosTorre> => (await tablaArea(q, ctx, u, c, dimension, titulo, conValor)) as TablaProductosTorre;

const conValorPagado = (t: { total: number; valorTotal: number | null }, ctx: ContextoTablero): string | undefined =>
  (ctx.dinero && t.total > 0 && t.valorTotal != null ? `Valor pagado: ${COP(t.valorTotal)}.` : undefined);

/** `POST /tableros/productos` (B3-AC1). */
export async function tableroProductos(ctx: ContextoTablero): Promise<TableroProductos> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('productos', ctx, () => enTorre(async (q) => {
    const critico: SegmentoDetalle[] = [{ dimension: 'severidad', valores: ['critico'] }];
    const k = await contarConjuntos(q, ctx, u, [
      { clave: 'porVencer', conjunto: 'soat_por_vencer' },
      { clave: 'vigencia', conjunto: 'soat_vigencia_no_verificada' },
      { clave: 'soatSinGestion', conjunto: 'soat_sin_gestion' },
      { clave: 'soatSinGestionCrit', conjunto: 'soat_sin_gestion', segmentos: critico },
      { clave: 'impSinGestion', conjunto: 'impuesto_sin_gestion' },
      { clave: 'impSinGestionCrit', conjunto: 'impuesto_sin_gestion', segmentos: critico },
      { clave: 'conDiferencia', conjunto: 'impuestos_con_diferencia' },
      { clave: 'direccion', conjunto: 'impuestos_direccion_pendiente' },
      { clave: 'sinSoporte', conjunto: 'derechos_sin_soporte' },
      { clave: 'pendientes', conjunto: 'derechos_pendientes_sin_resolver' },
    ]);
    const [soatPag, impPag, derPag] = await Promise.all([
      totalFragmento(q, fragmentoConjunto('soat_pagados_periodo', ctx, u)),
      totalFragmento(q, fragmentoConjunto('impuestos_pagados_periodo', ctx, u)),
      totalFragmento(q, fragmentoConjunto('derechos_pagados_periodo', ctx, u)),
    ]);
    const [tSoatEstado, tIncompletas, tImpEstado, tNovedad, tDerOrg, tPendientes] = await Promise.all([
      tabla(q, ctx, u, 'soat_por_estado', 'estado', 'SOAT creados en el periodo, por estado', true),
      tabla(q, ctx, u, 'soat_incompletas_abiertas', 'motivo', 'Solicitudes de SOAT incompletas, por motivo', false),
      tabla(q, ctx, u, 'impuestos_por_estado', 'estado', 'Impuestos creados en el periodo, por estado', true),
      tabla(q, ctx, u, 'impuestos_rechazados_periodo', 'motivo', 'Impuestos con novedad, por motivo', false),
      tabla(q, ctx, u, 'derechos_pagados_periodo', 'organismo', 'Derechos pagados en el periodo, por secretaría', true),
      tabla(q, ctx, u, 'derechos_pendientes_sin_resolver', 'motivo', 'Recibos pendientes de asociar, por concepto', false),
    ]);
    const horas = u.horas_soat_impuesto_sin_soporte;
    const desgloseCritico = (c: 'soat_sin_gestion' | 'impuesto_sin_gestion', n: number) =>
      [{ etiqueta: `Más de ${horas * 2} horas`, valor: n, destino: destino(n, c, critico) }];
    const valorDe = (t: { valorTotal: number | null }) => (ctx.dinero ? t.valorTotal ?? 0 : null);

    return {
      soat: {
        cifras: {
          pagadosPeriodo: soatPag.total, pagadosValor: valorDe(soatPag), porVencer: k.porVencer!, sinGestion: k.soatSinGestion!,
          vigenciaNoVerificada: k.vigencia!,
        },
        explicaciones: {
          pagadosPeriodo: kpi('soat_pagados_periodo', soatPag.total, u, { cola: conValorPagado(soatPag, ctx) }),
          porVencer: kpi('soat_por_vencer', k.porVencer!, u),
          sinGestion: kpi('soat_sin_gestion', k.soatSinGestion!, u, { desglose: desgloseCritico('soat_sin_gestion', k.soatSinGestionCrit!) }),
          vigenciaNoVerificada: kpi('soat_vigencia_no_verificada', k.vigencia!, u),
        },
        tablas: [tSoatEstado, tIncompletas],
      },
      impuestos: {
        cifras: {
          pagadosPeriodo: impPag.total, pagadosValor: valorDe(impPag), sinGestion: k.impSinGestion!,
          conDiferencia: k.conDiferencia!, direccionPendiente: k.direccion!,
        },
        explicaciones: {
          pagadosPeriodo: kpi('impuestos_pagados_periodo', impPag.total, u, { cola: conValorPagado(impPag, ctx) }),
          sinGestion: kpi('impuesto_sin_gestion', k.impSinGestion!, u, { desglose: desgloseCritico('impuesto_sin_gestion', k.impSinGestionCrit!) }),
          conDiferencia: kpi('impuestos_con_diferencia', k.conDiferencia!, u),
          direccionPendiente: kpi('impuestos_direccion_pendiente', k.direccion!, u),
        },
        tablas: [tImpEstado, tNovedad],
      },
      derechos: {
        cifras: {
          pagadosPeriodo: derPag.total, pagadosValor: valorDe(derPag), sinSoporte: k.sinSoporte!, pendientesSinResolver: k.pendientes!,
        },
        explicaciones: {
          pagadosPeriodo: kpi('derechos_pagados_periodo', derPag.total, u, { cola: conValorPagado(derPag, ctx) }),
          sinSoporte: kpi('derechos_sin_soporte', k.sinSoporte!, u),
          pendientesSinResolver: kpi('derechos_pendientes_sin_resolver', k.pendientes!, u),
        },
        tablas: [tDerOrg, tPendientes],
      },
      rango: { desde: rango.desde, hasta: rango.hasta },
      dineroVisible: ctx.dinero,
      generadoEn: new Date().toISOString(),
    };
  }));
}
