// Siigo — por qué un trámite todavía no se puede enviar a facturación electrónica (HU #11324).
//
// Los nombres llevan `TRAMITE` porque `flito-certificacion.ts` ya tiene un `MotivoNoElegible`, que
// habla de otra cosa —por qué un impuesto no se puede certificar contra el RUNT—. Dos conceptos
// distintos con el mismo nombre en el mismo paquete se confunden al importarlos, y el compilador
// solo avisa mientras coinciden: el día que uno cambie, el error sería silencioso.
//
// **Un catálogo de motivos, no un booleano.** «No elegible» no le sirve a nadie: quien mira el
// reporte necesita saber qué corregir, y quien mantiene el sistema necesita poder contar cuántos
// trámites están frenados por cada causa. Un mensaje genérico convierte las dos preguntas en una
// revisión manual, fila por fila.
//
// **Dos preguntas abiertas viven aquí, y por eso el catálogo es una lista y no una condición.**
//
//   * La 13 (¿desde cuándo se factura el histórico?) se aísla en `anterior_al_corte`, cuyo umbral es
//     un dato de configuración: cambiar la fecha cambia el veredicto sin tocar código.
//   * La 11 (¿qué entra en el universo facturable?) se aísla en el catálogo entero: ampliar el
//     universo es QUITAR un motivo, no rehacer la evaluación.

/**
 * Por qué un trámite no es elegible. El orden es el de la conversación que tendría alguien que lo
 * revisa: primero lo que depende del propio trámite, después de su cliente, y al final lo que es
 * de configuración del sistema.
 */
export const MOTIVOS_TRAMITE_NO_ELEGIBLE = [
  /** La liquidación no está sellada y facturada. La emisión es un paso POSTERIOR a «Facturar». */
  'liquidacion_no_facturada',
  /** Le falta algún soporte de los conceptos que se le van a facturar. */
  'documentacion_incompleta',
  /** Facturado antes de la fecha de corte del histórico (pregunta 13). */
  'anterior_al_corte',
  /**
   * El ambiente no tiene corte del histórico configurado, así que no se factura nada.
   *
   * Es el hermano explícito de `anterior_al_corte`: sin fecha de corte no se puede afirmar que un
   * trámite esté después de ella, y en la única puerta que hay antes de la DIAN eso se resuelve
   * bloqueando. Existe como motivo PROPIO —y no como un `anterior_al_corte` genérico— porque la
   * acción es otra: no se arregla el trámite ni se sube la fecha, se siembra la fila del ambiente.
   */
  'sin_corte_configurado',
  /** El trámite no tiene compañía resuelta: sin cliente no hay tercero ni factura. */
  'sin_compania',
  /** La compañía todavía no tiene tercero vinculado en Siigo (HU #11297). */
  'tercero_sin_vincular',
  /** El cliente no es facturable. El detalle lo pone el validador, tal cual (HU #11296). */
  'cliente_no_facturable',
  /** La parametrización no está confirmada. El detalle lo pone la compuerta, tal cual (HU #11285). */
  'compuerta_cerrada',
  /** Ya tiene una factura viva: emitir otra sería duplicarla ante la DIAN. */
  'ya_facturado',
] as const;
export type MotivoTramiteNoElegible = (typeof MOTIVOS_TRAMITE_NO_ELEGIBLE)[number];

/**
 * Texto por defecto de cada motivo.
 *
 * Los dos motivos que delegan —`cliente_no_facturable` y `compuerta_cerrada`— traen aquí una frase
 * de encabezado, pero el detalle real lo pone el servicio que decidió, palabra por palabra. El AC2
 * lo pide con todas las letras: los motivos de esos dos servicios se propagan **tal cual, sin
 * reinterpretarse**. Reescribirlos aquí crearía una segunda versión del mismo diagnóstico que se
 * quedaría vieja en cuanto el original cambiara.
 */
export const MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO: Record<MotivoTramiteNoElegible, string> = {
  liquidacion_no_facturada:
    'La liquidación todavía no está sellada y facturada. Púlsala en el reporte de costos: la '
    + 'emisión electrónica es el paso siguiente, no el mismo.',
  documentacion_incompleta:
    'Falta algún soporte de los conceptos que se van a facturar. El reporte de costos señala cuál.',
  anterior_al_corte:
    'El trámite se facturó antes de la fecha desde la que se emite factura electrónica. Si debe '
    + 'entrar, cambia esa fecha en la configuración de emisión.',
  // Dice a quién acudir, no qué tocar: la fila del ambiente se siembra con una migración y no hay
  // pantalla que la escriba, así que mandar a alguien a «configurarlo» sería mandarlo a buscar algo
  // que no existe. El texto tiene que sobrevivir a que lo lea quien factura, no quien despliega.
  sin_corte_configurado:
    'Este ambiente todavía no tiene configurado desde cuándo se emite factura electrónica, y sin '
    + 'esa fecha no se factura nada. No es un problema del trámite: avisa al equipo técnico.',
  sin_compania:
    'El trámite no tiene una compañía asociada, así que no hay a quién facturarle.',
  // NO dice «no existe en Siigo», y la diferencia costó una tarde de depuración: lo que falta es el
  // VÍNCULO en FLITO, y la empresa suele estar perfectamente cargada en Siigo Nube. El mensaje
  // anterior mandaba a buscar el problema en el sitio equivocado —credenciales, ambiente, la propia
  // API de Siigo— cuando la acción correcta siempre fue sincronizar desde la ficha.
  tercero_sin_vincular:
    'La compañía todavía no está vinculada con su tercero de Siigo. Sincronízala desde su ficha: '
    + 'si ya existe en Siigo, se vincula sola y de paso completa los datos que falten aquí.',
  cliente_no_facturable:
    'La ficha fiscal del cliente está incompleta.',
  compuerta_cerrada:
    'La parametrización contable no está confirmada.',
  ya_facturado:
    'El trámite ya tiene una factura electrónica viva. Emitir otra la duplicaría ante la DIAN.',
};

/** Un motivo con su explicación. El `detalle` puede venir de otro servicio, sin retocar. */
export interface MotivoElegibilidad {
  motivo: MotivoTramiteNoElegible;
  detalle: string;
}

/** El veredicto de un trámite. `elegible` es la conclusión; `motivos` es la razón. */
export interface ElegibilidadTramite {
  tramiteId: string;
  elegible: boolean;
  /** Vacío cuando es elegible. Nunca un motivo genérico: si no se sabe, no se inventa. */
  motivos: MotivoElegibilidad[];
  /**
   * A quién se le factura. `null` = el trámite no tiene compañía, que ya es un motivo por sí solo.
   *
   * Viaja desde A2 porque la configuración de emisión se elige POR EMPRESA: sin este dato, el
   * diálogo de envío no puede agrupar las filas ni precargar el vendedor de cada una, y tendría que
   * volver a preguntar por algo que esta consulta ya sabe.
   */
  companiaId: number | null;
}

/**
 * El resumen sobre un conjunto (AC4).
 *
 * `anterioresAlCorte` sale aparte del recuento por motivo porque responde una pregunta distinta:
 * no es «cuántos están frenados» sino «cuánto histórico deja fuera la fecha que hemos puesto». Es
 * la información con la que alguien decide si esa fecha es la correcta.
 */
export interface ResumenElegibilidad {
  total: number;
  elegibles: number;
  noElegibles: number;
  porMotivo: Record<MotivoTramiteNoElegible, number>;
  anterioresAlCorte: number;
}

export function esMotivoTramiteNoElegible(v: unknown): v is MotivoTramiteNoElegible {
  return typeof v === 'string' && (MOTIVOS_TRAMITE_NO_ELEGIBLE as readonly string[]).includes(v);
}

/** Un resumen con todos los motivos a cero: ninguno desaparece por no tener casos. */
export function resumenElegibilidadVacio(): ResumenElegibilidad {
  const porMotivo = Object.fromEntries(
    MOTIVOS_TRAMITE_NO_ELEGIBLE.map((m) => [m, 0]),
  ) as Record<MotivoTramiteNoElegible, number>;
  return { total: 0, elegibles: 0, noElegibles: 0, porMotivo, anterioresAlCorte: 0 };
}
