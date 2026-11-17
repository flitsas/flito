// Torre de Control Gerencial (Épica #14590) — contrato del motor de métricas. Paso contract-first: las rutas de
// consulta, exportación, placa y tableros existen y validan su entrada, pero el motor aún no está: responden 501
// con `TorreNoImplementadoError`. La lógica llega en los bloques siguientes (catálogo SQL, filtro con alcance,
// placa con `logPiiAccess`, exportación).
/**
 * Base de los errores de dominio de la Torre: `enTorre()` los deja pasar tal cual (la ruta los traduce a 4xx); todo
 * lo demás que falle dentro de una consulta se vuelve `TorreConsultaError` genérico.
 */
export class ErrorDominioTorre extends Error {}

export class TorreNoImplementadoError extends ErrorDominioTorre {
  readonly code = 'TORRE_NO_IMPLEMENTADO';
  constructor(que: string) { super(`«${que}» de la Torre de Control aún no está disponible.`); }
}

/** Marcador del motor: lanza siempre hasta que llegue la implementación. */
export function noImplementado(que: string): never {
  throw new TorreNoImplementadoError(que);
}
