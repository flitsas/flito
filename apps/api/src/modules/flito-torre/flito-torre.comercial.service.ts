// Torre de Control Gerencial (Épica #14590, UX §7.1) — tablero Comercial.
//
// RN-TOR-C1 (fuga): por compañía, los trámites creados en los últimos `dias_ventana_fuga` días frente al promedio de
//   los 90 días anteriores llevado a la misma ventana. Entra si la caída supera `pct_caida_volumen`. Ignora el rango.
// RN-TOR-C2 (concentración): participación del Top 3 y del Top 5 por volumen (creados en el rango) y por ingreso
//   (`flito_liquidaciones.total` de los aprobados en el rango; solo con permiso de dinero).
// RN-TOR-C3 (embudo): cohorte de los creados en el rango → radicados (pasaron por «Entregado»/«Enviado a OT» o ya
//   aprobados) → aprobados (`fecha_aprobacion`) → facturados (`siigo_factura_tramites` activo).
// RN-TOR-C4 (venta cruzada): Top 10 clientes por trámites del rango × línea. «Autogestiona» si el cliente tiene el flag
//   `*_autogestionable` de esa línea; si no, «Usa» con al menos un registro de la línea en el rango y «No usa» sin él.
// RN-TOR-C5 (tendencia): los últimos 6 meses cerrados, creados por mes; no depende del rango.
// RN-TOR-L1 (ADR-0044): la concentración por ingreso y la línea logística de la venta cruzada excluyen las
//   liquidaciones de trámites anulados/abortados/revocados (`LIQUIDACION_VIGENTE`, el fragmento único del catálogo).
import { inArray, sql } from 'drizzle-orm';
import {
  type ConcentracionTorre, type FugaClienteTorre, type LineaVentaTorre, type ParticipacionTorre, type SerieTorre,
  type TableroComercial, type UsoLineaTorre,
} from '@operaciones/shared-types';
import {
  clients, flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones, flitoSoat, flitoTramites,
} from '../../db/schema.js';
import { FECHA_APROBACION, FECHA_CREACION, LIQUIDACION_VIGENTE } from './flito-torre.catalogo.js';
import { contarConjuntos, dondeFragmento, fragmentoConjunto, type Umbrales } from './flito-torre.conjuntos.js';
import { aConjunto, explicarComercial } from './flito-torre.frases.js';
import { donde, fechaLocal, mesAnterior, sumarDias, condicionRango, type RangoResuelto } from './flito-torre.filtro.js';
import { SIN_COMPANIA, enTorre, nombresCompania, type Ejecutor } from './flito-torre.metricas.service.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';
import {
  conCacheTablero, condTramites, diasDe, hoyDe, num, pct, r1, rangoTablero, type ContextoTablero,
} from './flito-torre.tablero-comun.js';

const T = flitoTramites;
const VENTANA_PREVIA_DIAS = 90;

/** RN-TOR-C1. Compartido con el 360°. */
export async function calcularFuga(
  q: Ejecutor, ctx: ContextoTablero, ventanaDias: number, umbralPct: number,
): Promise<FugaClienteTorre[]> {
  const hoy = hoyDe(ctx);
  const ventana: RangoResuelto = { desde: sumarDias(hoy, -(ventanaDias - 1)), hasta: hoy };
  const previa: RangoResuelto = { desde: sumarDias(ventana.desde, -VENTANA_PREVIA_DIAS), hasta: sumarDias(ventana.desde, -1) };
  const conds = condTramites(ctx, { desde: previa.desde, hasta: hoy }, FECHA_CREACION, ['rango']);
  const filas = await q<{ id: number; v: number; p: number }>(sql`SELECT ${T.companiaId} AS id,
      count(*) FILTER (WHERE ${condicionRango(FECHA_CREACION, ventana)})::int AS v,
      count(*) FILTER (WHERE ${condicionRango(FECHA_CREACION, previa)})::int AS p
    FROM ${T} WHERE ${donde([...conds, condicionRango(FECHA_CREACION, { desde: previa.desde, hasta: hoy }), sql`${T.companiaId} IS NOT NULL`])}
    GROUP BY 1`);
  const candidatas = filas.map((f) => {
    const promedio = (num(f.p) * ventanaDias) / VENTANA_PREVIA_DIAS;
    return { id: Number(f.id), v: num(f.v), promedio, variacion: promedio ? ((num(f.v) - promedio) / promedio) * 100 : 0 };
  }).filter((f) => f.promedio > 0 && -f.variacion > umbralPct);
  const nombres = await nombresCompania(q, candidatas.map((c) => c.id));
  return candidatas.sort((a, b) => a.variacion - b.variacion).map((c) => ({
    companiaId: c.id, compania: nombres.get(c.id) ?? `Compañía ${c.id}`,
    tramitesVentana: c.v, promedio: r1(c.promedio), variacionPct: r1(c.variacion),
  }));
}

export function concentracion(filas: { id: number | null; valor: number }[], nombres: Map<number, string>): ConcentracionTorre {
  const total = filas.reduce((s, f) => s + f.valor, 0);
  const orden = [...filas].sort((a, b) => b.valor - a.valor);
  const parte = (k: number) => orden.slice(0, k).reduce((s, f) => s + f.valor, 0);
  const top: ParticipacionTorre[] = orden.slice(0, 5).map((f) => ({
    companiaId: f.id, compania: f.id == null ? SIN_COMPANIA : nombres.get(f.id) ?? `Compañía ${f.id}`, valor: f.valor, pct: pct(f.valor, total),
  }));
  const resto = orden.slice(5);
  const valorResto = resto.reduce((s, f) => s + f.valor, 0);
  return { top, demas: { n: resto.length, valor: valorResto, pct: pct(valorResto, total) }, top3Pct: pct(parte(3), total), top5Pct: pct(parte(5), total), total };
}

export async function porCompania(q: Ejecutor, desde: ReturnType<typeof sql>, valor: ReturnType<typeof sql>, conds: ReturnType<typeof sql>[]) {
  const filas = await q<{ id: number | null; valor: string }>(sql`SELECT ${T.companiaId} AS id, ${valor} AS valor
    FROM ${desde} WHERE ${donde(conds)} GROUP BY 1`);
  return filas.map((f) => ({ id: f.id == null ? null : Number(f.id), valor: num(f.valor) }));
}

/** RN-TOR-C3: los cuatro pasos son conjuntos de la misma base (creados en el rango): UNA consulta (ADR-0047). */
export async function embudo(q: Ejecutor, ctx: ContextoTablero, u: Umbrales): Promise<TableroComercial['embudo']['pasos']> {
  const k = await contarConjuntos(q, ctx, u, [
    { clave: 'creados', conjunto: 'tramites_creados' }, { clave: 'radicados', conjunto: 'radicados_cohorte' },
    { clave: 'aprobados', conjunto: 'aprobados_cohorte' }, { clave: 'facturados', conjunto: 'facturados_cohorte' },
  ]);
  const creados = num(k.creados);
  return (['creados', 'radicados', 'aprobados', 'facturados'] as const).map((paso) => ({ paso, valor: num(k[paso]), pct: pct(num(k[paso]), creados) }));
}

/** RN-TOR-C5: últimos 6 meses cerrados. */
async function tendencia(q: Ejecutor, ctx: ContextoTablero): Promise<{ mensual: SerieTorre[]; trimestral: SerieTorre[] }> {
  const meses: string[] = [];
  let r = mesAnterior(hoyDe(ctx));
  for (let i = 0; i < 6; i++) { meses.unshift(r.desde.slice(0, 7)); r = mesAnterior(r.desde); }
  const rango: RangoResuelto = { desde: `${meses[0]}-01`, hasta: mesAnterior(hoyDe(ctx)).hasta };
  const filas = await q<{ k: string; n: number }>(sql`SELECT to_char(date_trunc('month', ${fechaLocal(FECHA_CREACION)}), 'YYYY-MM') AS k, count(*)::int AS n
    FROM ${T} WHERE ${donde(condTramites(ctx, rango, FECHA_CREACION, ['rango']).concat(condicionRango(FECHA_CREACION, rango)))} GROUP BY 1`);
  const porMes = new Map(filas.map((f) => [f.k, num(f.n)]));
  const mensual = meses.map((m) => ({ clave: m, etiqueta: m, valor: porMes.get(m) ?? 0 }));
  const trim = new Map<string, number>();
  for (const m of mensual) {
    const k = `${m.clave.slice(0, 4)}-T${Math.floor((Number(m.clave.slice(5, 7)) - 1) / 3) + 1}`;
    trim.set(k, (trim.get(k) ?? 0) + m.valor);
  }
  return { mensual, trimestral: [...trim].map(([k, v]) => ({ clave: k, etiqueta: k, valor: v })) };
}

async function ventaCruzada(
  q: Ejecutor, rango: RangoResuelto, top: { id: number; tramites: number }[], nombres: Map<number, string>,
): Promise<TableroComercial['ventaCruzada']['filas']> {
  const ids = top.map((t) => t.id);
  if (!ids.length) return [];
  const usoPor = async (tabla: ReturnType<typeof sql>, col: Parameters<typeof inArray>[0], extra: ReturnType<typeof sql>) => {
    const filas = await q<{ id: number }>(sql`SELECT DISTINCT ${col} AS id FROM ${tabla} WHERE ${inArray(col, ids)} AND ${extra}`);
    return new Set(filas.map((f) => Number(f.id)));
  };
  const enRango = (col: Parameters<typeof condicionRango>[0]['expr']) => condicionRango({ expr: col }, rango);
  const [soat, impuestos, derechos, logistica, flags] = await Promise.all([
    usoPor(sql`${flitoSoat}`, flitoSoat.companiaId, enRango(flitoSoat.createdAt)),
    usoPor(sql`${flitoImpuestos}`, flitoImpuestos.companiaId, enRango(flitoImpuestos.createdAt)),
    usoPor(sql`${flitoDerechosTramite}`, flitoDerechosTramite.companiaId, enRango(flitoDerechosTramite.createdAt)),
    usoPor(sql`${flitoLiquidaciones} INNER JOIN ${T} ON ${T.id} = ${flitoLiquidaciones.tramiteId}`, T.companiaId,
      sql`${flitoLiquidaciones.valorLogistica} > 0 AND ${LIQUIDACION_VIGENTE} AND ${condicionRango(FECHA_CREACION, rango)}`),
    q<{ id: number; soat: boolean; imp: boolean; log: boolean }>(sql`SELECT ${clients.id} AS id, ${clients.soatAutogestionable} AS soat,
      ${clients.impuestosAutogestionable} AS imp, ${clients.logisticaAutogestionable} AS log FROM ${clients} WHERE ${inArray(clients.id, ids)}`),
  ]);
  const flag = new Map(flags.map((f) => [Number(f.id), f]));
  const uso = (usa: boolean, autogestiona = false): UsoLineaTorre => (autogestiona ? 'autogestiona' : usa ? 'usa' : 'no_usa');
  return top.map((t) => {
    const f = flag.get(t.id);
    const lineas: Record<LineaVentaTorre, UsoLineaTorre> = {
      tramites: uso(t.tramites > 0), soat: uso(soat.has(t.id), f?.soat), impuestos: uso(impuestos.has(t.id), f?.imp),
      derechos: uso(derechos.has(t.id)), logistica: uso(logistica.has(t.id), f?.log),
    };
    return { companiaId: t.id, compania: nombres.get(t.id) ?? `Compañía ${t.id}`, tramites: t.tramites, lineas };
  });
}

export async function tableroComercial(ctx: ContextoTablero): Promise<TableroComercial> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('comercial', ctx, () => enTorre(async (q) => {
    const fuga = await calcularFuga(q, ctx, u.dias_ventana_fuga, u.pct_caida_volumen);
    // Volumen = el conjunto `tramites_creados` (el mismo fragmento que su detalle), agrupado por compañía.
    const creadosF = fragmentoConjunto('tramites_creados', ctx, u);
    const volumen = await porCompania(q, creadosF.desde, sql`count(*)`, [dondeFragmento(creadosF)]);
    const ingreso = ctx.dinero
      ? await porCompania(q, sql`${flitoLiquidaciones} INNER JOIN ${T} ON ${T.id} = ${flitoLiquidaciones.tramiteId}`,
        sql`COALESCE(sum(${flitoLiquidaciones.total}), 0)`, [sql`${T.fechaAprobacion} IS NOT NULL`, LIQUIDACION_VIGENTE, ...condTramites(ctx, rango, FECHA_APROBACION)])
      : null;
    const ids = [...volumen, ...(ingreso ?? [])].map((f) => f.id).filter((id): id is number => id != null);
    const nombres = await nombresCompania(q, ids);
    const pasos = await embudo(q, ctx, u);
    const tend = await tendencia(q, ctx);
    const dias = diasDe(rango);
    const anterior: RangoResuelto = { desde: sumarDias(rango.desde, -dias), hasta: sumarDias(rango.desde, -1) };
    const [ant] = await q(sql`SELECT count(*)::int AS n FROM ${T} WHERE ${donde(condTramites(ctx, anterior, FECHA_CREACION))}`);
    const granularidad = dias <= 92 ? sql`'day'` : sql`'week'`;
    const spark = await q<{ n: number }>(sql`SELECT date_trunc(${granularidad}, ${fechaLocal(FECHA_CREACION)}) AS k, count(*)::int AS n
      FROM ${T} WHERE ${donde(condTramites(ctx, rango, FECHA_CREACION))} GROUP BY 1 ORDER BY 1`);
    const topVenta = volumen.filter((f): f is { id: number; valor: number } => f.id != null)
      .sort((a, b) => b.valor - a.valor).slice(0, 10).map((f) => ({ id: f.id, tramites: f.valor }));
    const vol = concentracion(volumen, nombres);
    const creados = pasos[0]!.valor;
    const sinExplicar: Omit<TableroComercial, 'explicaciones'> = {
      rango, dineroVisible: ctx.dinero, generadoEn: new Date().toISOString(),
      cifras: {
        clientesEnCaida: fuga.length, concentracionTop3Pct: vol.top3Pct, concentracionTop5Pct: vol.top5Pct,
        conversionFacturadoPct: pct(pasos[3]!.valor, creados), tramitesPeriodo: creados, tramitesPeriodoAnterior: num(ant?.n),
        sparkline: spark.map((s) => num(s.n)),
      },
      fuga: {
        filtrosIgnorados: ['rango'], umbralPct: u.pct_caida_volumen, ventanaDias: u.dias_ventana_fuga,
        filas: fuga.map((f) => ({ ...f, destino: aConjunto('tramites_creados', [{ dimension: 'compania', valores: [String(f.companiaId)] }]) })),
      },
      concentracion: { filtrosIgnorados: [], volumen: vol, ingreso: ingreso ? concentracion(ingreso, nombres) : null },
      embudo: { filtrosIgnorados: [], pasos },
      tendencia: { filtrosIgnorados: ['rango'], ...tend },
      ventaCruzada: { filtrosIgnorados: [], filas: await ventaCruzada(q, rango, topVenta, nombres) },
    };
    return { ...sinExplicar, explicaciones: explicarComercial(sinExplicar, u) };
  }));
}

