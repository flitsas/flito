// Invariante de dominio: matrícula inicial (B01, sin tipología) → un VIN, un trámite activo.
// Rechazado permite reintentar; completado bloquea de por vida.

import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramitesDigitales } from '../../db/schema.js';
import { normalizeVin } from '../vehicles/vehiculo-historial.js';

export type TramiteVinConflictCode = 'TRAMITE_DUPLICADO' | 'TRAMITE_MATRICULA_COMPLETADA';

export interface TramiteVinConflictExisting {
  id: number;
  estado: string;
  paso: number;
  placa: string | null;
  vin: string;
}

export interface TramiteVinConflict {
  code: TramiteVinConflictCode;
  message: string;
  existingTramite: TramiteVinConflictExisting;
}

export class TramiteVinConflictError extends Error {
  readonly code: TramiteVinConflictCode;
  readonly existingTramite: TramiteVinConflictExisting;

  constructor(conflict: TramiteVinConflict) {
    super(conflict.message);
    this.name = 'TramiteVinConflictError';
    this.code = conflict.code;
    this.existingTramite = conflict.existingTramite;
  }
}

/** Matrícula inicial = tipo B01 por defecto y sin tipología de traspaso u otra. */
export function isMatriculaInicial(input: { tipologiaCodigo?: string | null }): boolean {
  return !input.tipologiaCodigo;
}

export async function findVinMatriculaInicialConflict(
  vin: string,
  opts?: { excludeTramiteId?: number },
): Promise<TramiteVinConflict | null> {
  const normalized = normalizeVin(vin);
  if (!normalized) return null;

  const conditions = [eq(tramitesDigitales.vin, normalized)];
  if (opts?.excludeTramiteId != null) {
    conditions.push(ne(tramitesDigitales.id, opts.excludeTramiteId));
  }

  const rows = await db
    .select({
      id: tramitesDigitales.id,
      estado: tramitesDigitales.estado,
      paso: tramitesDigitales.paso,
      placa: tramitesDigitales.placa,
      vin: tramitesDigitales.vin,
    })
    .from(tramitesDigitales)
    .where(and(...conditions))
    .orderBy(desc(tramitesDigitales.updatedAt))
    .limit(10);

  const blocking = rows.filter((r) => r.estado !== 'rechazado');
  if (blocking.length === 0) return null;

  const latest = blocking[0]!;
  const existingTramite: TramiteVinConflictExisting = {
    id: latest.id,
    estado: latest.estado,
    paso: latest.paso,
    placa: latest.placa,
    vin: latest.vin ?? normalized,
  };

  if (latest.estado === 'completado') {
    return {
      code: 'TRAMITE_MATRICULA_COMPLETADA',
      message:
        'Este vehículo ya tiene una matrícula inicial completada. Un VIN solo puede matricularse una vez.',
      existingTramite,
    };
  }

  const placaHint = latest.placa ? ` (placa ${latest.placa})` : '';
  return {
    code: 'TRAMITE_DUPLICADO',
    message:
      `Ya existe un trámite de matrícula inicial para este VIN${placaHint}. ` +
      'Continúe el trámite existente en lugar de crear uno nuevo.',
    existingTramite,
  };
}

export async function assertVinDisponibleMatriculaInicial(
  vin: string,
  opts?: { excludeTramiteId?: number },
): Promise<void> {
  const conflict = await findVinMatriculaInicialConflict(vin, opts);
  if (conflict) throw new TramiteVinConflictError(conflict);
}
