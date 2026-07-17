// TRAM-OPS-01 — embudo operativo de trámites (agrupación por etapa).

import { sql, desc, eq, and } from 'drizzle-orm';
import type { TramiteModalidadEntrada } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { tramitesDigitales } from '../../db/schema.js';
import { createdInRangeCondition, type FechaRango } from '../../shared/utils/fecha-rango.js';

export interface EmbudoColumnaDef {
  id: string;
  label: string;
  estados: readonly string[];
}

export const EMBUDO_COLUMNAS: EmbudoColumnaDef[] = [
  { id: 'borrador', label: 'Borrador', estados: ['borrador', 'radicado'] },
  { id: 'en_preparacion', label: 'En preparación', estados: ['en_validacion', 'documentos', 'identidad', 'aprobado', 'en_tramite'] },
  // TRAM-TRASPASO-F1: subsanación visible (estado STT del traspaso).
  { id: 'subsanacion', label: 'Subsanación', estados: ['subsanacion'] },
  { id: 'en_transito', label: 'En tránsito', estados: ['enviado_transito', 'recibido_transito', 'placa_preasignada'] },
  { id: 'soat_cierre', label: 'SOAT / cierre', estados: ['solicitud_soat', 'soat_comprado', 'soat_verificado', 'completado', 'entregado'] },
  { id: 'rechazado', label: 'Rechazado', estados: ['rechazado', 'anulado'] },
];

const ESTADO_A_COLUMNA = new Map<string, string>();
const ETAPA_IDS = new Set(EMBUDO_COLUMNAS.map((c) => c.id));
for (const col of EMBUDO_COLUMNAS) {
  for (const e of col.estados) ESTADO_A_COLUMNA.set(e, col.id);
}

/** Estados DB de una etapa del embudo (p. ej. borrador → borrador + radicado). */
export function getEstadosForEtapa(etapaId: string): readonly string[] | null {
  if (!ETAPA_IDS.has(etapaId)) return null;
  return EMBUDO_COLUMNAS.find((c) => c.id === etapaId)?.estados ?? null;
}

export interface EmbudoTramiteItem {
  id: number;
  vin: string | null;
  placa: string | null;
  tipologiaCodigo: string | null;
  estado: string;
  paso: number;
  updatedAt: string;
  motivoRechazoCodigo: string | null;
  vehiculo: { marca?: string; linea?: string } | null;
  comprador: { nombre?: string; documento?: string } | null;
  // TRAM-TRASPASO-F1: modalidad + radicado STT (para la tarjeta del embudo).
  modalidadEntrada: string;
  numeroRadicado: string | null;
}

export interface EmbudoColumnaResponse {
  id: string;
  label: string;
  count: number;
  tramites: EmbudoTramiteItem[];
}

export interface EmbudoResponse {
  columnas: EmbudoColumnaResponse[];
}

export async function getEmbudo(limitPerColumn: number, rango?: FechaRango, modalidadEntrada?: TramiteModalidadEntrada): Promise<EmbudoResponse> {
  const cap = Math.min(Math.max(1, limitPerColumn), 100);
  const maxRows = cap * EMBUDO_COLUMNAS.length;
  const conditions: any[] = [];
  const rangoCond = rango ? createdInRangeCondition(tramitesDigitales.createdAt, rango) : null;
  if (rangoCond) conditions.push(rangoCond);
  if (modalidadEntrada) conditions.push(eq(tramitesDigitales.modalidadEntrada, modalidadEntrada));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  let countQuery = db.select({
    estado: tramitesDigitales.estado,
    n: sql<number>`count(*)::int`,
  }).from(tramitesDigitales).$dynamic();
  if (whereClause) countQuery = countQuery.where(whereClause);
  const countRows = await countQuery.groupBy(tramitesDigitales.estado);

  const counts = new Map<string, number>();
  for (const col of EMBUDO_COLUMNAS) counts.set(col.id, 0);
  for (const cr of countRows ?? []) {
    const colId = ESTADO_A_COLUMNA.get(cr.estado);
    if (colId) counts.set(colId, (counts.get(colId) ?? 0) + cr.n);
  }

  let rowsQuery = db.select({
    id: tramitesDigitales.id,
    vin: tramitesDigitales.vin,
    placa: tramitesDigitales.placa,
    tipologiaCodigo: tramitesDigitales.tipologiaCodigo,
    estado: tramitesDigitales.estado,
    paso: tramitesDigitales.paso,
    updatedAt: tramitesDigitales.updatedAt,
    motivoRechazoCodigo: tramitesDigitales.motivoRechazoCodigo,
    vehiculo: tramitesDigitales.vehiculo,
    comprador: tramitesDigitales.comprador,
    modalidadEntrada: tramitesDigitales.modalidadEntrada,
    numeroRadicado: tramitesDigitales.numeroRadicado,
  }).from(tramitesDigitales).$dynamic();
  if (whereClause) rowsQuery = rowsQuery.where(whereClause);
  const rows = await rowsQuery.orderBy(desc(tramitesDigitales.updatedAt)).limit(maxRows);

  const buckets = new Map<string, EmbudoTramiteItem[]>();
  for (const col of EMBUDO_COLUMNAS) buckets.set(col.id, []);

  for (const row of rows) {
    const colId = ESTADO_A_COLUMNA.get(row.estado);
    if (!colId) continue;
    const bucket = buckets.get(colId)!;
    if (bucket.length < cap) {
      const v = (row.vehiculo || {}) as { marca?: string; linea?: string };
      const c = (row.comprador || {}) as { nombre?: string; documento?: string };
      bucket.push({
        id: row.id,
        vin: row.vin,
        placa: row.placa,
        tipologiaCodigo: row.tipologiaCodigo,
        estado: row.estado,
        paso: row.paso,
        motivoRechazoCodigo: row.motivoRechazoCodigo,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
        vehiculo: v.marca || v.linea ? { marca: v.marca, linea: v.linea } : null,
        comprador: c.nombre || c.documento ? { nombre: c.nombre, documento: c.documento } : null,
        modalidadEntrada: row.modalidadEntrada,
        numeroRadicado: row.numeroRadicado,
      });
    }
  }

  return {
    columnas: EMBUDO_COLUMNAS.map((col) => ({
      id: col.id,
      label: col.label,
      count: counts.get(col.id) ?? 0,
      tramites: buckets.get(col.id) ?? [],
    })),
  };
}
