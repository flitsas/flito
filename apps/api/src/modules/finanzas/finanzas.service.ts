// Finanzas — Reporte de costos por trámite (contabilidad / facturación / cobros).
//
// Lista los trámites con el costo de SOAT e impuesto (0 si aún no tienen valor) más los conceptos
// fijos del trámite. Los conceptos fijos son HARDCODE por ahora (pendiente parametrizarlos).

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoImpuestos, flitoSoat, flitoTramites, vehicles } from '../../db/schema.js';

/** Conceptos fijos del costo del trámite (HARDCODE por ahora). */
export const COSTOS_FIJOS = { derechoTramite: 75000, logistica: 15000, tramiteDigital: 300000, gmf: 7000 } as const;

export interface FiltrosReporte { buscar?: string; estados?: string[]; empresas?: string[]; page?: number; pageSize?: number }
export interface FilaReporte {
  tramiteId: string; idFlit: string; placa: string | null; estado: string | null; empresa: string | null;
  soat: number; impuesto: number;
  derechoTramite: number; logistica: number; tramiteDigital: number; gmf: number; total: number;
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
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id));
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

  const { derechoTramite, logistica, tramiteDigital, gmf } = COSTOS_FIJOS;
  const items: FilaReporte[] = rows.map((r) => {
    const soat = numero(r.soatPagado);                              // 0 si el SOAT no tiene valor aún
    const impuesto = numero(r.impuestoPagado ?? r.impuestoLiquidado); // 0 si el impuesto no tiene valor aún
    const totalFila = soat + impuesto + derechoTramite + logistica + tramiteDigital + gmf;
    return { tramiteId: r.tramiteId, idFlit: r.idFlit, placa: r.placa, estado: r.estado, empresa: r.empresa,
      soat, impuesto, derechoTramite, logistica, tramiteDigital, gmf, total: totalFila };
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
