// Finanzas — Reporte de costos por trámite (contabilidad / facturación / cobros).
//
// Lista los trámites con el costo de SOAT e impuesto (0 si aún no tienen valor) más los conceptos
// fijos del trámite. Los conceptos fijos siguen siendo HARDCODE, salvo el DERECHO DE TRÁMITE: desde
// la HU #10953 ese valor sale del recibo real del organismo (flito_derechos_tramite) y la constante
// queda solo como respaldo mientras el trámite no tenga su recibo cargado. Cada fila dice cuál de
// los dos se usó (`derechoTramiteEsReal`), porque un estimado y un pagado no valen lo mismo para
// quien concilia.

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoDerechosTramite, flitoImpuestos, flitoSoat, flitoTramites, vehicles } from '../../db/schema.js';

/** Conceptos fijos del costo del trámite (HARDCODE por ahora). */
export const COSTOS_FIJOS = { derechoTramite: 75000, logistica: 15000, tramiteDigital: 300000, gmf: 7000 } as const;

/**
 * Derecho de trámite de una fila: el valor real del recibo si lo hay, si no el fijo.
 *
 * Un registro sin valor (el OCR no lo pudo leer y quedó en revisión) NO cuenta como real: caer a
 * 0 descuadraría el total hacia abajo y sería peor que el estimado que ya teníamos.
 */
export function derechoDe(valorReal: string | null | undefined): { valor: number; esReal: boolean } {
  const real = valorReal === null || valorReal === undefined ? 0 : Number(valorReal) || 0;
  return real > 0 ? { valor: real, esReal: true } : { valor: COSTOS_FIJOS.derechoTramite, esReal: false };
}

export interface FiltrosReporte { buscar?: string; estados?: string[]; empresas?: string[]; page?: number; pageSize?: number }
export interface FilaReporte {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  soat: number; impuesto: number;
  derechoTramite: number; logistica: number; tramiteDigital: number; gmf: number; total: number;
  /** false = se usó el valor fijo por defecto porque el trámite aún no tiene su recibo cargado. */
  derechoTramiteEsReal: boolean;
}
export interface TotalesReporte { soat: number; impuesto: number; derechoTramite: number; logistica: number; tramiteDigital: number; gmf: number; total: number }
export interface ReporteCostos { items: FilaReporte[]; total: number; page: number; pageSize: number; totales: TotalesReporte }

const numero = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v) || 0);

function condiciones(f: FiltrosReporte): SQL[] {
  const conds: SQL[] = [];
  const t = f.buscar?.trim();
  if (t) {
    const patron = `%${t.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${t.toUpperCase()}%`;
    conds.push(or(
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
    )!);
  }
  if (f.estados?.length) conds.push(inArray(flitoTramites.flitEstado, f.estados));
  if (f.empresas?.length) conds.push(inArray(flitoTramites.companiaNit, f.empresas));
  return conds;
}

function proyeccion() {
  return db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit,
    placa: vehicles.plate, estado: flitoTramites.flitEstado, empresa: clients.name,
    soatPagado: flitoSoat.valorPagado,
    impuestoPagado: flitoImpuestos.valorPagado, impuestoLiquidado: flitoImpuestos.valorLiquidado,
    derechoValor: flitoDerechosTramite.valor,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id));
}

export async function reporteCostos(f: FiltrosReporte = {}): Promise<ReporteCostos> {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize ?? 50)));
  const conds = condiciones(f);
  const where = conds.length ? and(...conds) : undefined;

  const countRows = await db.select({ total: sql<number>`count(distinct ${flitoTramites.id})::int` })
    .from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .where(where);
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await proyeccion().where(where)
    .orderBy(desc(flitoTramites.createdAt)).limit(pageSize).offset((page - 1) * pageSize);

  const { logistica, tramiteDigital, gmf } = COSTOS_FIJOS;
  const items: FilaReporte[] = rows.map((r) => {
    const soat = numero(r.soatPagado);                              // 0 si el SOAT no tiene valor aún
    const impuesto = numero(r.impuestoPagado ?? r.impuestoLiquidado); // 0 si el impuesto no tiene valor aún
    const derecho = derechoDe(r.derechoValor);                       // real del recibo, o el fijo
    const totalFila = soat + impuesto + derecho.valor + logistica + tramiteDigital + gmf;
    return { tramiteId: r.tramiteId, idFlit: r.idFlit, placa: r.placa, estado: r.estado, empresa: r.empresa,
      soat, impuesto, derechoTramite: derecho.valor, derechoTramiteEsReal: derecho.esReal,
      logistica, tramiteDigital, gmf, total: totalFila };
  });

  const totales = items.reduce<TotalesReporte>((a, i) => ({
    soat: a.soat + i.soat, impuesto: a.impuesto + i.impuesto,
    derechoTramite: a.derechoTramite + i.derechoTramite, logistica: a.logistica + i.logistica,
    tramiteDigital: a.tramiteDigital + i.tramiteDigital, gmf: a.gmf + i.gmf, total: a.total + i.total,
  }), { soat: 0, impuesto: 0, derechoTramite: 0, logistica: 0, tramiteDigital: 0, gmf: 0, total: 0 });

  return { items, total, page, pageSize, totales };
}

export interface FacetasReporte { estados: string[]; empresas: { nit: string; nombre: string | null }[] }
export async function facetas(): Promise<FacetasReporte> {
  const [estados, empresas] = await Promise.all([
    db.selectDistinct({ v: flitoTramites.flitEstado }).from(flitoTramites).where(sql`${flitoTramites.flitEstado} is not null`),
    db.selectDistinct({ nit: flitoTramites.companiaNit, nombre: clients.name }).from(flitoTramites)
      .leftJoin(clients, eq(flitoTramites.companiaId, clients.id)).where(sql`${flitoTramites.companiaNit} is not null`),
  ]);
  return {
    estados: estados.map((e) => e.v).filter((v): v is string => !!v).sort(),
    empresas: empresas.filter((e): e is { nit: string; nombre: string | null } => !!e.nit),
  };
}
