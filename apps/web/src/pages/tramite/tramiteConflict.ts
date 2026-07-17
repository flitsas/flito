import { ApiError } from '../../lib/api';

export type TramiteConflictExisting = {
  id: number;
  estado: string;
  paso: number;
  placa: string | null;
  vin?: string;
};

export type TramiteConflictPayload = {
  code: 'TRAMITE_DUPLICADO' | 'TRAMITE_MATRICULA_COMPLETADA';
  message: string;
  existingTramite: TramiteConflictExisting;
};

export function parseTramiteConflict(err: unknown): TramiteConflictPayload | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.rawDetails as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return null;
  const existing = body.existingTramite as TramiteConflictExisting | undefined;
  if (!existing?.id) return null;
  const code = body.code === 'TRAMITE_MATRICULA_COMPLETADA'
    ? 'TRAMITE_MATRICULA_COMPLETADA'
    : 'TRAMITE_DUPLICADO';
  return {
    code,
    message: typeof body.error === 'string' ? body.error : err.message,
    existingTramite: existing,
  };
}
