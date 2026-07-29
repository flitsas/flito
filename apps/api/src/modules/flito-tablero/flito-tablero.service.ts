// FLITO Tablero (Fase 5 P4). Porta packages/server/src/tablero/tablero.modulo.ts.
//
// Los conteos que importan son los que la operación no puede ver de otra forma: organismos sin
// clasificar y trámites retenidos (RN-01 Impuestos), registros estancados por SLA vencido, y
// diferencias de valor. El filtro por compañía autogestionable va en los conteos por estado: un tablero
// que contara registros que ninguna cola muestra estaría mintiendo (CA-01). El SQL de estancados vive
// en la BD para no traer toda la tabla a memoria.

import { and, count, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { ANS_OPERATIVO,
  ALERTAS_OPERATIVAS, EstadoImpuesto, EstadoSoat, ESTADOS_TRAMITE_FLITO_TERMINADOS, FlujoRevision,
  type AlertaOperativa,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoImpuestos, flitoProveedoresSoat, flitoRevisiones, flitoSoat, flitoTramites,
  organismosTransitoConfig, vehicles,
} from '../../db/schema.js';
import { listar as listarCompuerta } from '../flito-compuerta/flito-compuerta.service.js';
import { condicionAlerta } from '../flito-tramites/flito-tramites.service.js';

export interface TableroResumen {
  soat: Record<string, number>;
  impuestos: Record<string, number>;
  revisionesPendientes: { soat: number; impuestos: number };
  estancados: { soat: number; impuestos: number };
  diferenciasDeValor: number;
  compuertaHabilitados: number;
  /** Alertas operativas (Feature #10942). Cada conteo es el total del listado con esa alerta. */
  alertas: Record<AlertaOperativa, number>;
}

/**
 * Conteo de cada alerta operativa.
 *
 * Reutiliza `condicionAlerta()` del servicio de trámites en vez de reescribir el predicado: así la
 * tarjeta del tablero y la tabla filtrada no pueden discrepar (AC4). Los joins son los mismos que
 * usa el COUNT del listado, porque las condiciones referencian el proveedor SOAT y el organismo.
 */
async function contarAlertas(): Promise<Record<AlertaOperativa, number>> {
  const conteos = await Promise.all(ALERTAS_OPERATIVAS.map(async (alerta) => {
    const [r] = await db.select({ n: sql<number>`count(distinct ${flitoTramites.id})::int` })
      .from(flitoTramites)
      .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
      .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
      .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
      .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
      .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
      .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
      .where(condicionAlerta(alerta));
    return [alerta, Number(r?.n ?? 0)] as const;
  }));
  return Object.fromEntries(conteos) as Record<AlertaOperativa, number>;
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

/**
 * Solicitudes que pasaron el ANS de gestión (HU #11024).
 *
 * El ANS es único, así que el `INNER JOIN` con el proveedor y con el organismo deja de hacer falta
 * para medir: antes un SOAT sin proveedor asignado, o un impuesto de un organismo sin ANS puesto,
 * no se contaban nunca — justo los que menos vigilados están.
 */
async function contarEstancados(): Promise<{ soat: number; impuestos: number }> {
  const [soat] = await db.select({ n: count() }).from(flitoSoat)
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(and(
      eq(flitoSoat.estado, EstadoSoat.SOLICITADO),
      eq(clients.soatAutogestionable, false),
      isNotNull(flitoSoat.enviadoEn),
      sql`${flitoSoat.enviadoEn} < NOW() - make_interval(hours => ${ANS_OPERATIVO.SIN_GESTION_HORAS})`,
    ));

  const [impuestos] = await db.select({ n: count() }).from(flitoImpuestos)
    .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .where(and(
      eq(flitoImpuestos.estado, EstadoImpuesto.SOLICITADO),
      eq(clients.impuestosAutogestionable, false),
      isNotNull(flitoImpuestos.enviadoEn),
      sql`${flitoImpuestos.enviadoEn} < NOW() - make_interval(hours => ${ANS_OPERATIVO.SIN_GESTION_HORAS})`,
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
  // Las alertas van en una tanda aparte, no dentro del Promise.all de arriba: son 4 consultas más y
  // juntarlas dispararía diez simultáneas contra el pool para pintar una sola pantalla.
  const alertas = await contarAlertas();

  return {
    soat,
    impuestos,
    revisionesPendientes: { soat: revisionSoat, impuestos: revisionImpuestos },
    estancados,
    diferenciasDeValor: diferencias,
    compuertaHabilitados: habilitados.length,
    alertas,
  };
}
