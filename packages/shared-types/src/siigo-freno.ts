// Siigo — freno por proporción de errores (HU #11341, Feature #11244).
//
// Siigo bloquea temporalmente el usuario API si durante siete días más del 80 % de las peticiones
// son errores (`docs/integraciones/siigo-api.md` §1). Ese bloqueo no se cae sobre una petición: se
// cae sobre la facturación entera de la empresa. Este es el tercer eje de protección de la
// integración, y NO sustituye a ninguno de los dos que ya existen en `siigo.resiliencia.ts`:
//
//   · **cuota** (100 peticiones/minuto por empresa) → limitador de tasa;
//   · **salud de un endpoint** (fallos consecutivos de UN recurso) → cortacircuitos;
//   · **proporción acumulada de errores** (lo que Siigo penaliza con bloqueo) → esto.
//
// Miden fenómenos distintos y se disparan en momentos distintos. Un endpoint caído abre su
// cortacircuitos y no tiene por qué frenar la integración; una integración frenada no dice nada
// sobre si un endpoint concreto está sano.

/**
 * Medición cruda de la salud de la integración en una ventana.
 *
 * Todo lo que hace falta para reproducir el veredicto a mano: qué ventana se usó, cuántas
 * operaciones entraron, cuántas fallaron y contra qué umbral se comparó (AC6).
 */
export interface MedicionFrenoSiigo {
  ambiente: string;
  /** `mock` | `real`. Las mediciones de los dos modos NO se mezclan nunca (AC1). */
  modo: string;
  /** Ancho de la ventana configurada, en horas. */
  ventanaHoras: number;
  /** Proporción a partir de la cual se frena, entre 0 y 1. */
  umbral: number;
  /** Operaciones mínimas para que la proporción signifique algo. */
  minimoOperaciones: number;
  /**
   * Inicio efectivo de la ventana en ISO 8601. Puede ser posterior a `hasta - ventanaHoras` cuando
   * alguien reactivó la integración a mano dentro de la ventana (AC4).
   */
  desde: string;
  hasta: string;
  /**
   * Operaciones cuyo resultado dependía de la salud del servicio: éxitos, errores técnicos y
   * tiempos de espera agotados. Es el DENOMINADOR.
   */
  total: number;
  /** Fallos imputables al servicio dentro de `total`. Es el NUMERADOR. */
  errores: number;
  /**
   * Rechazos causados por datos nuestros mal formados. NO entran ni en `errores` ni en `total`
   * (AC3), y se informan aparte porque siguen siendo un problema real que alguien debe corregir.
   */
  erroresDeDatos: number;
  /** `errores / total`, o 0 cuando no hay denominador. */
  proporcion: number;
  /** `total >= minimoOperaciones`. Con dos operaciones, una proporción no dice nada. */
  muestraSuficiente: boolean;
  /** `muestraSuficiente && proporcion > umbral`. */
  superaUmbral: boolean;
}

/** Quién levantó el freno a mano y cuándo (AC4). */
export interface ReactivacionFrenoSiigo {
  fecha: string;
  usuarioId: number | null;
}

/** Veredicto del freno para un ambiente (AC6). */
export interface EstadoFrenoSiigo extends MedicionFrenoSiigo {
  /**
   * false en modo simulado: nada sale hacia Siigo, así que no hay usuario API que bloquear. La
   * medición se sigue calculando y publicando —igual que hace la compuerta de emisión— para que el
   * simulador no aparente que todo está bien.
   */
  frenoActivo: boolean;
  /** true = las operaciones nuevas contra Siigo se rechazan antes de salir a la red. */
  frenada: boolean;
  /**
   * Desde cuándo se está rechazando, en ISO 8601. Sale del primer rechazo REGISTRADO en la ventana
   * vigente; es `null` cuando el umbral ya se superó pero todavía no se ha intentado ninguna
   * operación, porque en ese caso no hay ningún hecho registrado que fechar.
   */
  frenadaDesde: string | null;
  /** Última reactivación manual vigente, si la hay. */
  ultimaReactivacion: ReactivacionFrenoSiigo | null;
  /** Texto accionable cuando está frenada; `null` cuando no lo está. */
  motivo: string | null;
}
