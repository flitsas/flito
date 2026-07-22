// FLITO Tablero (Fase 5 P4). Porta packages/server/src/tablero/tablero.modulo.ts.
//
// Los conteos que importan son los que la operación no puede ver de otra forma: organismos sin
// clasificar y trámites retenidos (RN-01 Impuestos), registros estancados por SLA vencido, y
// diferencias de valor. El filtro por compañía autogestionable va en los conteos por estado: un tablero
// que contara registros que ninguna cola muestra estaría mintiendo (CA-01). El SQL de estancados vive
// en la BD para no traer toda la tabla a memoria.

import { and, count, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import {
  EstadoImpuesto, EstadoSoat, ESTADOS_TRAMITE_FLITO_TERMINADOS, FlujoRevision,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoImpuestos, flitoProveedoresSoat, flitoRevisiones, flitoSoat, flitoTramites,
  organismosTransitoConfig,
} from '../../db/schema.js';
import { listar as listarCompuerta } from '../flito-compuerta/flito-compuerta.service.js';

export interface TableroResumen {
  soat: Record<string, number>;
  impuestos: Record<string, number>;
  revisionesPendientes: { soat: number; impuestos: number };
  estancados: { soat: number; impuestos: number };
  diferenciasDeValor: number;
  compuertaHabilitados: number;
}

async function contarSoat(): Promise<Record<string, number>> {
  const filas = await db.select({ estado: flitoSoat.estado, total: count() })
    .from(flitoSoat).innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(eq(clients.soatAutogestionable, false)).groupBy(flitoSoat.estado);
  const r = Object.fromEntries(Object.values(EstadoSoat).map((e) => [e, 0]));
  for (const f of filas) r[f.estado] = Number(f.total);
  return r;
}

async function contarImpuestos(): Promise<Record<string, number>> {
  const filas = await db.select({ estado: flitoImpuestos.estado, total: count() })
    .from(flitoImpuestos).innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .where(eq(clients.impuestosAutogestionable, false)).groupBy(flitoImpuestos.estado);
  const r = Object.fromEntries(Object.values(EstadoImpuesto).map((e) => [e, 0]));
  for (const f of filas) r[f.estado] = Number(f.total);
  return r;
}

async function contarRevisiones(modulo: FlujoRevision): Promise<number> {
  const [r] = await db.select({ n: count() }).from(flitoRevisiones)
    .where(and(eq(flitoRevisiones.modulo, modulo), eq(flitoRevisiones.resuelto, false)));
  return Number(r.n);
}

async function diferenciasDeValor(): Promise<number> {
  const [r] = await db.select({ n: count() }).from(flitoImpuestos)
    .where(and(eq(flitoImpuestos.marcadoPorDiferencia, true), eq(flitoImpuestos.estado, EstadoImpuesto.PAGADO)));
  return Number(r.n);
}

/** SLA vencido. El cálculo del vencimiento vive en SQL (intervalo por horas de SLA). */
async function contarEstancados(): Promise<{ soat: number; impuestos: number }> {
  const [soat] = await db.select({ n: count() }).from(flitoSoat)
    .innerJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(and(
      eq(flitoSoat.estado, EstadoSoat.SOLICITADO),
      eq(clients.soatAutogestionable, false),
      isNotNull(flitoProveedoresSoat.slaHoras),
      isNotNull(flitoSoat.enviadoEn),
      sql`${flitoSoat.enviadoEn} < NOW() - (${flitoProveedoresSoat.slaHoras} || ' hours')::interval`,
    ));

  const [impuestos] = await db.select({ n: count() }).from(flitoImpuestos)
    .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo))
    .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .where(and(
      eq(flitoImpuestos.estado, EstadoImpuesto.SOLICITADO),
      eq(clients.impuestosAutogestionable, false),
      isNotNull(organismosTransitoConfig.flitoSlaHoras),
      isNotNull(flitoImpuestos.enviadoEn),
      sql`${flitoImpuestos.enviadoEn} < NOW() - (${organismosTransitoConfig.flitoSlaHoras} || ' hours')::interval`,
    ));

  return { soat: Number(soat.n), impuestos: Number(impuestos.n) };
}

/** Resumen del tablero de Operaciones. */
export async function resumen(): Promise<TableroResumen> {
  const [soat, impuestos] = await Promise.all([contarSoat(), contarImpuestos()]);
  const [revisionSoat, revisionImpuestos, habilitados, diferencias, estancados] = await Promise.all([
    contarRevisiones(FlujoRevision.SOAT),
    contarRevisiones(FlujoRevision.IMPUESTOS),
    listarCompuerta(true),
    diferenciasDeValor(),
    contarEstancados(),
  ]);

  return {
    soat,
    impuestos,
    revisionesPendientes: { soat: revisionSoat, impuestos: revisionImpuestos },
    estancados,
    diferenciasDeValor: diferencias,
    compuertaHabilitados: habilitados.length,
  };
}
