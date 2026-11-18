// Torre de Control Gerencial (Épica #14590, UX §7.3) — tablero Financiero.
//
// RN-TOR-FI1 (bolsas, ignora el rango): saldo de hoy de las bolsas activas de cada compañía y consumo diario promedio de
//   los últimos 30 días (salidas de `flito_bolsas_unicas_movimientos`). Días de cobertura = saldo / consumo diario;
//   `null` sin consumo; con saldo ≤ 0 la bolsa está agotada: 0 días y crítico. Semáforo: < `dias_cobertura_rojo` crítico, < `dias_cobertura_amarillo` atención, si no ok.
// RN-TOR-FI2 (sin facturar): aprobados en el rango que no están en `siigo_factura_tramites` activo, contados y
//   valorizados con `flito_liquidaciones.total` (sin liquidación, cuentan pero no suman).
// RN-TOR-FI3 (margen, solo con dinero): cobrado = componentes de la liquidación de los aprobados en el rango; costo =
//   SOAT `flito_soat.valor_pagado`, impuesto `flito_impuestos.valor_pagado`, derecho `flito_derechos_tramite.valor`,
//   logística la tarifa del proveedor vigente a la aprobación (`flito_tarifas_proveedor_vigencias`, servicio
//   `logistica`). El trámite digital no tiene costo en FLITO: «sin costo registrado», igual que un servicio sin ningún
//   costo encontrado.
// RN-TOR-FI4 (conciliación 3/3): por aprobado en el rango, cuántos de SOAT, impuesto y derecho tienen soporte vigente en
//   `flito_soportes` (no descartado; el derecho también vale con su `soporte_id`).
// RN-TOR-L1 (ADR-0044): `calcularSinFacturar` excluye esas liquidaciones SOLO de la suma (el conteo de trámites no
//   cambia) y `calcularMargen` en su `WHERE` (`LIQUIDACION_VIGENTE`). El 360° lo hereda.
import { eq, sql } from 'drizzle-orm';
import type { SeveridadTorre, ServicioMargenTorre, TableroFinanciero } from '@operaciones/shared-types';
import {
  clients, flitoBolsasUnicas, flitoBolsasUnicasMovimientos, flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones,
  flitoSoat, flitoSoportes, flitoTarifasProveedorVigencias, flitoTramites,
} from '../../db/schema.js';
import { FACTURADO, FECHA_APROBACION, LIQUIDACION_VIGENTE } from './flito-torre.catalogo.js';
import { condicionesCompania, donde, sumarDias, type RangoResuelto } from './flito-torre.filtro.js';
import { SIN_COMPANIA, enTorre, nombresCompania, type Ejecutor } from './flito-torre.metricas.service.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';
import {
  conCacheTablero, condTramites, hoyDe, num, pctONull, r1, rangoTablero, type ContextoTablero,
} from './flito-torre.tablero-comun.js';

const T = flitoTramites;
const L = flitoLiquidaciones;
const APROBADO = sql`${T.fechaAprobacion} IS NOT NULL`;
const DIAS_CONSUMO = 30;

type FilaBolsa = TableroFinanciero['bolsas']['filas'][number];

/** RN-TOR-FI1. Compartido con el 360°. */
export async function calcularBolsas(q: Ejecutor, ctx: ContextoTablero, rojo: number, amarillo: number): Promise<FilaBolsa[]> {
  const B = flitoBolsasUnicas;
  const M = flitoBolsasUnicasMovimientos;
  const conds = [sql`${B.activa} = true`, sql`${B.companiaId} IS NOT NULL`, ...condicionesCompania(ctx.filtro, ctx.alcance, B.companiaId)];
  const desde = sumarDias(hoyDe(ctx), -(DIAS_CONSUMO - 1));
  const filas = await q<{ id: number; saldo: string; consumo: string }>(sql`SELECT ${B.companiaId} AS id,
      COALESCE(sum(${B.saldo}), 0) AS saldo,
      COALESCE(sum(mov.v), 0) AS consumo
    FROM ${B} CROSS JOIN LATERAL (SELECT COALESCE(sum(${M.valor}), 0) AS v FROM ${M}
        WHERE ${M.bolsaId} = ${B.id} AND ${M.tipo} = 'salida' AND ${M.fecha} >= ${desde}::date) mov
    WHERE ${donde(conds)} GROUP BY 1`);
  const nombres = await nombresCompania(q, filas.map((f) => Number(f.id)));
  return filas.map((f) => {
    const saldo = num(f.saldo);
    const diario = num(f.consumo) / DIAS_CONSUMO;
    // Saldo ≤ 0 = bolsa agotada: 0 días y crítico, con o sin consumo (días negativos no significan nada).
    const dias = saldo <= 0 ? 0 : diario > 0 ? r1(saldo / diario) : null;
    const sev: SeveridadTorre = saldo <= 0 ? 'critico' : dias == null ? 'ok' : dias < rojo ? 'critico' : dias < amarillo ? 'atencion' : 'ok';
    return {
      companiaId: Number(f.id), compania: nombres.get(Number(f.id)) ?? `Compañía ${f.id}`,
      saldo: ctx.dinero ? saldo : null, consumoDiario: ctx.dinero ? r1(diario) : null, diasCobertura: dias, severidad: sev,
    };
  }).sort((a, b) => (a.diasCobertura ?? Infinity) - (b.diasCobertura ?? Infinity));
}

/** RN-TOR-FI2. Compartido con el 360°. */
export async function calcularSinFacturar(q: Ejecutor, ctx: ContextoTablero, rango: RangoResuelto) {
  const filas = await q<{ id: number | null; n: number; valor: string | null; antiguo: unknown }>(sql`SELECT ${T.companiaId} AS id,
      count(*)::int AS n, sum(${L.total}) FILTER (WHERE ${LIQUIDACION_VIGENTE}) AS valor, min(${T.fechaAprobacion}) AS antiguo
    FROM ${T} LEFT JOIN ${L} ON ${eq(L.tramiteId, T.id)}
    WHERE ${donde([APROBADO, sql`NOT ${FACTURADO}`, ...condTramites(ctx, rango, FECHA_APROBACION)])}
    GROUP BY 1 ORDER BY 2 DESC, 1 ASC NULLS LAST`);
  const nombres = await nombresCompania(q, filas.map((f) => f.id).filter((id): id is number => id != null));
  const ahora = Date.now();
  return filas.map((f) => ({
    companiaId: f.id == null ? null : Number(f.id),
    compania: f.id == null ? SIN_COMPANIA : nombres.get(Number(f.id)) ?? `Compañía ${f.id}`,
    tramites: num(f.n), valorEstimado: ctx.dinero ? num(f.valor) : null,
    masAntiguoDias: f.antiguo ? Math.floor((ahora - new Date(f.antiguo as string).getTime()) / 86_400_000) : 0,
  }));
}

const SERVICIOS: { servicio: ServicioMargenTorre; cobrado: string; costo: string | null }[] = [
  { servicio: 'tramite', cobrado: 'c_tram', costo: null },
  { servicio: 'soat', cobrado: 'c_soat', costo: 'k_soat' },
  { servicio: 'impuestos', cobrado: 'c_imp', costo: 'k_imp' },
  { servicio: 'derechos', cobrado: 'c_der', costo: 'k_der' },
  { servicio: 'logistica', cobrado: 'c_log', costo: 'k_log' },
];

/** RN-TOR-FI3. `null` sin permiso de dinero. Compartido con el 360°. */
export async function calcularMargen(q: Ejecutor, ctx: ContextoTablero, rango: RangoResuelto): Promise<TableroFinanciero['margen']> {
  if (!ctx.dinero) return null;
  const I = flitoImpuestos;
  const D = flitoDerechosTramite;
  const V = flitoTarifasProveedorVigencias;
  const filas = await q<Record<string, unknown>>(sql`SELECT ${T.companiaId} AS id,
      COALESCE(sum(${L.valorTramiteDigital}), 0) AS c_tram, COALESCE(sum(${L.valorSoat}), 0) AS c_soat,
      COALESCE(sum(${L.valorImpuesto}), 0) AS c_imp, COALESCE(sum(${L.valorDerecho}), 0) AS c_der,
      COALESCE(sum(${L.valorLogistica}), 0) AS c_log,
      sum(${flitoSoat.valorPagado}) AS k_soat, sum(imp.v) AS k_imp, sum(der.v) AS k_der,
      sum(CASE WHEN COALESCE(${L.valorLogistica}, 0) > 0 THEN tar.v END) AS k_log
    FROM ${L} INNER JOIN ${T} ON ${eq(T.id, L.tramiteId)}
      LEFT JOIN ${clients} ON ${eq(clients.id, T.companiaId)}
      LEFT JOIN ${flitoSoat} ON ${eq(flitoSoat.id, T.soatId)}
      LEFT JOIN LATERAL (SELECT sum(${I.valorPagado}) AS v FROM ${I} WHERE ${I.tramiteId} = ${T.id}) imp ON true
      LEFT JOIN LATERAL (SELECT sum(${D.valor}) AS v FROM ${D} WHERE ${D.tramiteId} = ${T.id}) der ON true
      LEFT JOIN LATERAL (SELECT ${V.valor} AS v FROM ${V} WHERE ${V.proveedorId} = ${clients.flitoProveedorLogisticaId}
        AND ${V.servicio} = 'logistica' AND ${V.vigenteDesde} <= ${T.fechaAprobacion}
        AND (${V.vigenteHasta} IS NULL OR ${V.vigenteHasta} > ${T.fechaAprobacion})
        ORDER BY ${V.vigenteDesde} DESC LIMIT 1) tar ON true
    WHERE ${donde([APROBADO, LIQUIDACION_VIGENTE, ...condTramites(ctx, rango, FECHA_APROBACION)])}
    GROUP BY 1`);
  const nombres = await nombresCompania(q, filas.map((f) => f.id).filter((id) => id != null).map(Number));
  const porServicio = SERVICIOS.map((s) => {
    const cobrado = filas.reduce((a, f) => a + num(f[s.cobrado]), 0);
    const conCosto = s.costo ? filas.filter((f) => f[s.costo!] != null) : [];
    const costo = conCosto.length ? conCosto.reduce((a, f) => a + num(f[s.costo!]), 0) : null;
    return { servicio: s.servicio, cobrado, costo, sinCostoRegistrado: costo == null };
  });
  const porCliente = filas.map((f) => {
    const cobrado = SERVICIOS.reduce((a, s) => a + num(f[s.cobrado]), 0);
    const costos = SERVICIOS.filter((s) => s.costo && f[s.costo] != null);
    const costo = costos.reduce((a, s) => a + num(f[s.costo!]), 0);
    const id = f.id == null ? null : Number(f.id);
    return {
      companiaId: id, compania: id == null ? SIN_COMPANIA : nombres.get(id) ?? `Compañía ${id}`,
      cobrado, costo, margenPct: pctONull(cobrado - costo, cobrado), sinCostoRegistrado: costos.length === 0,
    };
  }).sort((a, b) => b.cobrado - a.cobrado);
  return { filtrosIgnorados: [], porServicio, porCliente };
}

export const margenTotalPct = (m: TableroFinanciero['margen']): number | null => {
  if (!m) return null;
  const cobrado = m.porServicio.reduce((a, s) => a + s.cobrado, 0);
  const costo = m.porServicio.reduce((a, s) => a + (s.costo ?? 0), 0);
  return pctONull(cobrado - costo, cobrado);
};

async function conciliacion(q: Ejecutor, ctx: ContextoTablero, rango: RangoResuelto): Promise<TableroFinanciero['conciliacion']> {
  const S = flitoSoportes;
  const I = flitoImpuestos;
  const D = flitoDerechosTramite;
  const vigente = sql`COALESCE(${S.descartado}, false) = false`;
  const puntos = sql`(CASE WHEN EXISTS (SELECT 1 FROM ${S} WHERE ${S.soatId} = ${T.soatId} AND ${vigente}) THEN 1 ELSE 0 END
    + CASE WHEN EXISTS (SELECT 1 FROM ${S} INNER JOIN ${I} ON ${eq(I.id, S.impuestoId)} WHERE ${I.tramiteId} = ${T.id} AND ${vigente}) THEN 1 ELSE 0 END
    + CASE WHEN EXISTS (SELECT 1 FROM ${D} WHERE ${D.tramiteId} = ${T.id} AND (${D.soporteId} IS NOT NULL
        OR EXISTS (SELECT 1 FROM ${S} WHERE ${S.derechoId} = ${D.id} AND ${vigente}))) THEN 1 ELSE 0 END)`;
  const filas = await q<{ p: number; n: number }>(sql`SELECT ${puntos} AS p, count(*)::int AS n FROM ${T}
    WHERE ${donde([APROBADO, ...condTramites(ctx, rango, FECHA_APROBACION)])} GROUP BY 1`);
  const de = (p: number) => num(filas.find((f) => Number(f.p) === p)?.n);
  const total = filas.reduce((a, f) => a + num(f.n), 0);
  return { filtrosIgnorados: [], completos: de(3), dos: de(2), uno: de(1), cero: de(0), total, pctCompletos: pctONull(de(3), total) };
}

export async function tableroFinanciero(ctx: ContextoTablero): Promise<TableroFinanciero> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('financiera', ctx, () => enTorre(async (q) => {
    const bolsas = await calcularBolsas(q, ctx, u.dias_cobertura_rojo, u.dias_cobertura_amarillo);
    const sinFacturar = await calcularSinFacturar(q, ctx, rango);
    const margen = await calcularMargen(q, ctx, rango);
    const conc = await conciliacion(q, ctx, rango);
    const menor = bolsas.find((b) => b.diasCobertura != null);
    return {
      rango, dineroVisible: ctx.dinero, generadoEn: new Date().toISOString(),
      cifras: {
        menorCobertura: menor ? { companiaId: menor.companiaId, compania: menor.compania, dias: menor.diasCobertura!, severidad: menor.severidad } : null,
        sinFacturarValor: ctx.dinero ? sinFacturar.reduce((a, f) => a + (f.valorEstimado ?? 0), 0) : null,
        sinFacturarTramites: sinFacturar.reduce((a, f) => a + f.tramites, 0),
        margenPct: margenTotalPct(margen),
        soportesCompletosPct: conc.pctCompletos,
      },
      bolsas: {
        filtrosIgnorados: ['rango', 'organismos', 'departamentos', 'tiposTramite', 'flitEstados'],
        umbralAtencionDias: u.dias_cobertura_amarillo, umbralCriticoDias: u.dias_cobertura_rojo, filas: bolsas,
      },
      sinFacturar: { filtrosIgnorados: [], filas: sinFacturar.slice(0, 50) },
      margen,
      conciliacion: conc,
    };
  }));
}
