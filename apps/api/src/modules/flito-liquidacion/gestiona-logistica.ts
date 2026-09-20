// FLITO — ¿Gestiona FLITO la logística de ESTE trámite? El predicado que comparten la liquidación
// (HU #12546: qué se cobra) y los viajes adicionales (HU #12619: qué se puede registrar).
//
// La compañía puede autogestionar la logística (`clients.logistica_autogestionable`), pero un trámite
// concreto puede tener una EXCEPCIÓN viva (`flito_excepciones_autogestion`, concepto 'logistica',
// `revocado_en IS NULL`) que se la encarga a FLITO. La excepción gana: si FLITO la hizo, la cobra.
// Sacarla del predicado (mutante nombrado de la #12619) rompe los dos módulos.
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { flitoExcepcionesAutogestion, flitoTramites } from '../../db/schema.js';

/**
 * La condición del LEFT JOIN a la excepción VIVA de logística del trámite. Un trámite no puede tener
 * dos excepciones vivas del mismo concepto (índice parcial), así que el join no multiplica filas.
 */
export function excepcionLogisticaViva(): SQL {
  return and(
    eq(flitoExcepcionesAutogestion.tramiteId, flitoTramites.id),
    eq(flitoExcepcionesAutogestion.concepto, 'logistica'),
    isNull(flitoExcepcionesAutogestion.revocadoEn),
  )!;
}

/** true si FLITO gestiona la logística: la compañía no autogestiona, o hay excepción viva. */
export function gestionaLogistica(logisticaAutogestionable: boolean | null, excepcionViva: boolean | null): boolean {
  return !logisticaAutogestionable || Boolean(excepcionViva);
}
