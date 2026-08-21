// FLITO comparendos — formas crudas de las dos fuentes externas (Feature #11492 17a, HU #11499).
//
// Esto NO es el modelo canónico. El canónico vive en `flito_comparendos_registros` y en
// `packages/shared-types`; lo de aquí es lo que ENTRA por el cable, tal cual, antes de homologar.
// Los dos vocabularios se mantienen separados a propósito: el día que Verifik renombre un campo se
// toca este archivo y el mapa de la HU #11500, y ni la base de datos ni el frontend se enteran.
//
// Por qué todo es opcional y hay firma de índice:
//
//   1. La homologación es PROVISIONAL hasta el spike #11501 (ADR-0003). Los nombres de campo de
//      abajo son los candidatos del mapa v1; declararlos requeridos sería afirmar algo que todavía
//      nadie ha visto en una respuesta real, y TypeScript nos dejaría leerlos sin comprobar.
//   2. El `[clave: string]: unknown` es lo que hace que la respuesta completa se pueda guardar en
//      `payload_simit` / `payload_municipal` sin perder los campos que aún no sabemos nombrar. Ese
//      JSONB crudo es justamente la materia prima del spike.
//
// Los valores numéricos se tipan `string | number` porque los proveedores de tránsito mandan
// importes de las dos formas («604100» y 604100) según el endpoint, y decidir cuál es la buena es
// trabajo del merge, no del transporte.

/** De cuál de las dos integraciones vino la respuesta. Decide el mapa de homologación a aplicar. */
export type ComparendosOrigenFuente = 'simit' | 'municipal';

/** Modo de operación del adapter: `mock` no toca la red (`COMPARENDOS_SIMIT_MODE`). */
export type ComparendosModoFuente = 'mock' | 'real';

/** Un comparendo tal como lo devuelve Verifik SIMIT. Claves = candidatas del mapa v1 (ADR-0003). */
export interface ComparendoCrudoSimit {
  numeroComparendo?: string;
  comparendo?: string;
  numero?: string;
  numeroMulta?: string;
  placa?: string;
  codigoInfraccion?: string;
  codigo?: string;
  descripcionInfraccion?: string;
  fechaComparendo?: string;
  fechaImposicion?: string;
  secretariaNombre?: string;
  organismoTransito?: string;
  valorAPagar?: string | number;
  valor?: string | number;
  monto?: string | number;
  estado?: string;
  estadoCartera?: string;
  estadoPago?: string;
  // Resolución (HU #11712). Los dos llegan **nulos mientras el registro sigue siendo un comparendo**
  // y con valor cuando ya es multa, y por eso se declaran `| null` y no solo opcionales: aquí la
  // diferencia entre «no vino la clave» y «vino en null» es la que el proveedor usa para hablar.
  // `idResolucion` es un identificador de SISTEMA (`'115697134'`), no el número legible.
  numeroResolucion?: string | null;
  idResolucion?: string | null;
  [clave: string]: unknown;
}

/** Un comparendo tal como lo devuelve el UTS municipal. Otro vocabulario para lo mismo. */
export interface ComparendoCrudoMunicipal {
  numero?: string;
  numeroComparendo?: string;
  comparendo?: string;
  placa?: string;
  codigo?: string;
  infraccion?: string;
  descripcion?: string;
  descripcionInfraccion?: string;
  fecha?: string;
  fechaComparendo?: string;
  organismo?: string;
  secretaria?: string;
  valor?: string | number;
  monto?: string | number;
  estado?: string;
  estadoPago?: string;
  // Resolución (HU #11712). El UTS la nombra `nroResolucion`, verificado contra el proveedor real;
  // `numeroResolucion` es el respaldo simétrico con el nombre largo de SIMIT, no observado aquí.
  //
  // `fechaResolucion` se declara y **no se mapea a nada**: el ítem real de Medellín la trae con
  // valor (`'2026-09-22'`) y `nroResolucion` en `null` a la vez, así que usarla como señal del tipo
  // fabricaría multas. Está aquí para que quien lea este archivo sepa que existe y por qué se
  // ignora, que es más barato que volver a descubrirlo.
  nroResolucion?: string | null;
  numeroResolucion?: string | null;
  fechaResolucion?: string | null;
  [clave: string]: unknown;
}

/**
 * Lo que devuelve un adapter: la lista y el contexto con el que el sync escribe su `sync_run_step`.
 *
 * `httpStatus` y `modo` no son adorno de observabilidad. El primero es la columna `http_status` del
 * step; el segundo permite que la HU #11500 distinga una corrida real de una simulada — inactivar
 * comparendos de verdad a partir de datos de `mock` sería el peor fallo posible de este módulo.
 */
export interface RespuestaFuente<T> {
  origen: ComparendosOrigenFuente;
  /** `'simit'` o el `codigoFuente` del municipio: el valor que va literal a la columna `fuente`. */
  fuente: string;
  modo: ComparendosModoFuente;
  /** Código HTTP del proveedor. `null` en `mock`: no hubo petición que responder. */
  httpStatus: number | null;
  items: T[];
}

export type RespuestaFuenteSimit = RespuestaFuente<ComparendoCrudoSimit>;
export type RespuestaFuenteMunicipal = RespuestaFuente<ComparendoCrudoMunicipal>;

/** Etiqueta de la fuente SIMIT en la columna `fuente` de los steps (los municipios usan su código). */
export const FUENTE_SIMIT = 'simit';
