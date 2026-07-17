// Tipos PESV compartidos entre páginas y componentes (espejo de los contratos zod
// publicados en `apps/api/src/modules/pesv/diagnostico.schemas.ts`).
// Las columnas numeric de Postgres llegan como string en el JSON (driver postgres-js).

export type NivelEmpresa = 'basico' | 'estandar' | 'avanzado';

export type NivelRubrica = 'no_implementado' | 'en_desarrollo' | 'implementado' | 'sostenido';

export type FasePhva = 'planear' | 'hacer' | 'verificar' | 'actuar';

export const NIVEL_RUBRICA_TO_SCORE: Record<NivelRubrica, 0 | 50 | 75 | 100> = {
  no_implementado: 0,
  en_desarrollo: 50,
  implementado: 75,
  sostenido: 100,
};

export const NIVEL_RUBRICA_LABEL: Record<NivelRubrica, string> = {
  no_implementado: 'No implementado',
  en_desarrollo: 'En desarrollo',
  implementado: 'Implementado',
  sostenido: 'Sostenido',
};

export interface PreflightBloqueo {
  estandarId: number;
  codigo: string;
  motivo: 'sin_evaluar' | 'nivel_implementado_sin_evidencia' | 'nivel_sostenido_sin_evidencia';
}

export interface PreflightAdvertencia {
  estandarId: number;
  codigo: string;
  motivo: 'en_desarrollo_sin_comentario';
}

export interface PreflightResponse {
  scoreProyectado: number;
  totalEstandares: number;
  evaluados: number;
  conEvidencia: number;
  bloqueos: PreflightBloqueo[];
  advertencias: PreflightAdvertencia[];
  puedeCerrar: boolean;
}
