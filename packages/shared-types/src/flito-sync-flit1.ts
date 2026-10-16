// Parámetros de la lectura automática de FLIT 1 (HU #13628, Feature #13612, Épica #13576).
// Diseño: `docs/diseno/hu-13628-parametros-lectura-flit1.md`. Tabla `flito_sync_flit1_lectura` (0241).
// Los límites y defaults de aquí son los que valida el API; el SQL de la 0241 los repite como CHECK y
// `migracion-0241.test.ts` ata ambos.

/** Rango admitido de cada parámetro numérico (inclusive). */
export const LIMITES_PARAMETROS_LECTURA_FLIT1 = {
  frecuenciaMinutos: { min: 2, max: 60 },
  ventanaDias: { min: 1, max: 90 },
  ventanaNocturnaDias: { min: 7, max: 90 },
} as const;

/** Valores de un ambiente en el que nadie ha guardado parámetros (AC1). El arranque es «hoy − 1 mes». */
export const DEFAULTS_PARAMETROS_LECTURA_FLIT1 = {
  frecuenciaMinutos: 2,
  ventanaDias: 7,
  ventanaNocturnaDias: 60,
} as const;

/** Cuerpo de `PUT /api/flito/sync/flit1/parametros-lectura`. Los cuatro campos son obligatorios. */
export interface ParametrosLecturaFlit1Input {
  frecuenciaMinutos: number;
  ventanaDias: number;
  ventanaNocturnaDias: number;
  /** `YYYY-MM-DD`, día real y no futuro en America/Bogota. */
  arranque: string;
}

/** Respuesta del GET y del PUT de `/flit1/parametros-lectura`. */
export interface ParametrosLecturaFlit1 {
  frecuenciaMinutos: number;
  ventanaDias: number;
  ventanaNocturnaDias: number;
  /** `YYYY-MM-DD`. Si nunca se guardó, es hoy − 1 mes en America/Bogota. */
  arranque: string;
  /** `true` cuando `arranque` es el calculado («hace 1 mes») y no uno guardado. */
  arranquePorDefecto: boolean;
  /** ISO. `null` = nadie ha guardado parámetros en este ambiente. */
  actualizadoEn: string | null;
  actualizadoPor: { id: number; nombre: string } | null;
}

/** Respuesta de `GET /api/flito/sync/flit1/estado-lectura` (AC8). Vacíos antes de la primera corrida. */
export interface EstadoLecturaFlit1 {
  ultimaLecturaBuenaEn: string | null;
  proximaLecturaPrevistaEn: string | null;
  /** `codigo` es técnico (`^[a-z0-9_]{1,40}$`), nunca texto libre. */
  ultimoFallo: { en: string; codigo: string } | null;
}
