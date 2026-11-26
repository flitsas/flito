// FLITO Tablero (Fase 5 P4). Porta packages/server/src/tablero/tablero.modulo.ts.
//
// Los conteos que importan son los que la operación no puede ver de otra forma: organismos sin
// clasificar y trámites retenidos (RN-01 Impuestos), registros estancados por SLA vencido, y
// diferencias de valor. El filtro por compañía autogestionable va en los conteos por estado: un tablero
// que contara registros que ninguna cola muestra estaría mintiendo (CA-01). El SQL de estancados vive
// en la BD para no traer toda la tabla a memoria.

import { and, count, eq, inArray, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { ANS_OPERATIVO,
  ALERTAS_OPERATIVAS, EstadoImpuesto, EstadoSoat, ESTADOS_IMPUESTO_OPERATIVOS, ESTADOS_SOAT_OPERATIVOS,
  ESTADOS_TRAMITE_FLITO_TERMINADOS, FlujoRevision,
  type AlertaOperativa,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoImpuestos, flitoProveedoresSoat, flitoRevisiones, flitoSoat, flitoTramites,
  organismosTransitoConfig, vehicles,
} from '../../db/schema.js';
import { listar as listarCompuerta } from '../flito-compuerta/flito-compuerta.service.js';
import { condicionAlerta } from '../flito-tramites/flito-tramites.service.js';
import { diasBorradorAbandonado } from '../flito-tramites/flito-tramites.borrador.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { condicionPorCompania } from '../../shared/alcance-filas.js';

/**
 * HU #13428 (AC4): los bloques de SOAT y de Impuestos son OPCIONALES — la ruta omite el del módulo que el
 * usuario no ve (`sinBloquesAjenos`). `resumen()` sigue devolviéndolos todos.
 */
export interface TableroResumen {
  soat?: Record<string, number>;
  impuestos?: Record<string, number>;
  revisionesPendientes: { soat?: number; impuestos?: number };
  estancados: { soat?: number; impuestos?: number };
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
async function contarAlertas(porCompania?: SQL): Promise<Record<AlertaOperativa, number>> {
  // RN-TRA-B2: el umbral de borrador es el configurable de la Torre (el mismo de `borrador_abandonado`).
  const diasBorrador = await diasBorradorAbandonado();
  const conteos = await Promise.all(ALERTAS_OPERATIVAS.map(async (alerta) => {
    const [r] = await db.select({ n: sql<number>`count(distinct ${flitoTramites.id})::int` })
      .from(flitoTramites)
      .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
      .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
      .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
      .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
      .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
      .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
      .where(and(condicionAlerta(alerta, diasBorrador), porCompania));
    return [alerta, Number(r?.n ?? 0)] as const;
  }));
  return Object.fromEntries(conteos) as Record<AlertaOperativa, number>;
}

async function contarSoat(porCompania?: SQL): Promise<Record<string, number>> {
  const filas = await db.select({ estado: flitoSoat.estado, total: count() })
    .from(flitoSoat).innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(and(eq(clients.soatAutogestionable, false), inArray(flitoSoat.estado, [...ESTADOS_SOAT_OPERATIVOS]), porCompania))
    .groupBy(flitoSoat.estado);
  // Épica #14707: `descartado` (trámite muerto) no existe en FLITO, ni como clave del conteo.
  const r = Object.fromEntries(ESTADOS_SOAT_OPERATIVOS.map((e) => [e, 0]));
  for (const f of filas) r[f.estado] = Number(f.total);
  return r;
}

async function contarImpuestos(porCompania?: SQL): Promise<Record<string, number>> {
  const filas = await db.select({ estado: flitoImpuestos.estado, total: count() })
    .from(flitoImpuestos).innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .where(and(eq(clients.impuestosAutogestionable, false), inArray(flitoImpuestos.estado, [...ESTADOS_IMPUESTO_OPERATIVOS]), porCompania))
    .groupBy(flitoImpuestos.estado);
  const r = Object.fromEntries(ESTADOS_IMPUESTO_OPERATIVOS.map((e) => [e, 0]));
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
  return contarSinGestion(ANS_OPERATIVO.SIN_GESTION_HORAS);
}

/**
 * Épica #14590 (ADR-0047): el predicado de «SOAT sin gestión fuera de ANS», exportado para que el detalle de la Torre
 * liste con el MISMO SQL con que cuenta el radar. Exige `flito_soat` INNER JOIN `clients` (por `compania_id`).
 */
export const condSoatSinGestion = (horas: number): SQL => and(
  eq(flitoSoat.estado, EstadoSoat.SOLICITADO),
  eq(clients.soatAutogestionable, false),
  isNotNull(flitoSoat.enviadoEn),
  sql`${flitoSoat.enviadoEn} < NOW() - make_interval(hours => ${horas})`,
)!;

/** Igual para el impuesto: exige `flito_impuestos` INNER JOIN `clients` (por `compania_id`). */
export const condImpuestoSinGestion = (horas: number): SQL => and(
  eq(flitoImpuestos.estado, EstadoImpuesto.SOLICITADO),
  eq(clients.impuestosAutogestionable, false),
  isNotNull(flitoImpuestos.enviadoEn),
  sql`${flitoImpuestos.enviadoEn} < NOW() - make_interval(hours => ${horas})`,
)!;

/**
 * Épica #14590 (Torre de Control, radar operativo): el MISMO predicado de «fuera de ANS» con las horas como
 * parámetro (el umbral configurable `horas_soat_impuesto_sin_soporte`) y el alcance de la compañía. El tablero
 * operativo lo llama con `ANS_OPERATIVO.SIN_GESTION_HORAS`, así que ambos no pueden discrepar con el umbral de fábrica.
 */
export async function contarSinGestion(
  horas: number, alcance: AlcanceResuelto = { enlace: 'ninguno' }, companiaIds?: readonly number[],
): Promise<{ soat: number; impuestos: number }> {
  const [soat] = await db.select({ n: count() }).from(flitoSoat)
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(and(
      condSoatSinGestion(horas),
      condicionPorCompania(flitoSoat.companiaId, alcance),
      companiaIds?.length ? inArray(flitoSoat.companiaId, [...companiaIds]) : undefined,
    ));

  const [impuestos] = await db.select({ n: count() }).from(flitoImpuestos)
    .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .where(and(
      condImpuestoSinGestion(horas),
      condicionPorCompania(flitoImpuestos.companiaId, alcance),
      companiaIds?.length ? inArray(flitoImpuestos.companiaId, [...companiaIds]) : undefined,
    ));

  return { soat: Number(soat.n), impuestos: Number(impuestos.n) };
}

/**
 * HU #13426 (AC4, decisión P-5 del PO): con enlace `compania` el tablero solo trae los bloques que
 * tienen filas de SU compañía —SOAT, Impuestos y las alertas de Trámites—, filtrados. Los indicadores
 * globales de operación (revisiones pendientes, fuera de ANS, diferencias, habilitados para entrega)
 * se OMITEN: van a 0 sin consultarse, para no cambiar la forma del DTO que la pantalla valida.
 */
async function resumenDeCompania(a: AlcanceResuelto): Promise<TableroResumen> {
  const [soat, impuestos] = await Promise.all([
    contarSoat(condicionPorCompania(flitoSoat.companiaId, a)),
    contarImpuestos(condicionPorCompania(flitoImpuestos.companiaId, a)),
  ]);
  const alertas = await contarAlertas(condicionPorCompania(flitoTramites.companiaId, a));
  return {
    soat, impuestos, alertas,
    revisionesPendientes: { soat: 0, impuestos: 0 },
    estancados: { soat: 0, impuestos: 0 },
    diferenciasDeValor: 0,
    compuertaHabilitados: 0,
  };
}

/** Resumen del tablero de Operaciones. Con enlace, solo lo de su compañía (HU #13426). */
export async function resumen(alcance: AlcanceResuelto = { enlace: 'ninguno' }): Promise<TableroResumen> {
  if (alcance.enlace !== 'ninguno') return resumenDeCompania(alcance);
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

/** Qué módulos del tablero ve el usuario (HU #13428, AC4). */
export interface ModulosVisibles { soat: boolean; impuestos: boolean }

/**
 * HU #13428 (AC4) — Quita del resumen el bloque de cada módulo que el usuario no ve: el conteo por estado
 * y su parte de «revisiones pendientes» y de «fuera de ANS». Puro: no consulta nada.
 */
export function sinBloquesAjenos(r: TableroResumen, ve: ModulosVisibles): TableroResumen {
  const salida: TableroResumen = { ...r, revisionesPendientes: { ...r.revisionesPendientes }, estancados: { ...r.estancados } };
  for (const m of ['soat', 'impuestos'] as const) {
    if (ve[m]) continue;
    delete salida[m];
    delete salida.revisionesPendientes[m];
    delete salida.estancados[m];
  }
  return salida;
}
