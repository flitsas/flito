// FLITO Conciliación — boletas de pago externo cruzadas contra los SOAT (Feature #11623).
//
// Módulo PURO (sin zod ni side-effects): lo consumen API y web. En esta HU (#11673) solo vive aquí
// el vocabulario que la capa de datos necesita afirmar —los estados de una boleta, los desenlaces
// del cruce y la normalización del número de póliza—. Los DTO de carga, cruce y conciliación
// llegan con las HU siguientes, cuando existan los endpoints que los devuelven.
//
// Qué es una boleta: Financiera paga en un portal externo un lote de SOAT de UNA compañía, descarga
// el Excel del portal y lo carga en FLITO. Cada fila del Excel es una línea, y una línea cruza por
// NÚMERO DE PÓLIZA contra un SOAT ya pagado. Si todas cuadran, el dinero sale de las dos bolsas en
// ese momento (CF-03), sin esperar al sellado de la liquidación.
//
// Diseño y tradeoffs: docs/adr/ADR-0006-flito-conciliacion-boletas-soat.md

/**
 * Estado de una boleta.
 *
 *   cargada     — el Excel ya se leyó y cruzó, pero no ha salido un peso de ninguna bolsa
 *   conciliada  — el descuento se asentó. Es terminal: una boleta conciliada no se deshace, y por
 *                 eso tampoco se borra (descartar es un UPDATE, no un DELETE)
 *   descartada  — carga abandonada. Libera el hash del archivo para poder rehacer la boleta sin
 *                 tener que renombrar el .xlsx
 *
 * Espejo del CHECK `flito_concil_boleta_estado_chk` de la migración 0157.
 */
export const EstadoBoleta = {
  CARGADA: 'cargada',
  CONCILIADA: 'conciliada',
  DESCARTADA: 'descartada',
} as const;

export type EstadoBoleta = (typeof EstadoBoleta)[keyof typeof EstadoBoleta];

/**
 * Concepto que agrupa una boleta. Una boleta es de UN solo concepto y de UNA sola compañía (RN-01).
 *
 * El MVP solo admite `soat`; el módulo se llama Conciliación —y no «Conciliación de SOAT»— porque
 * impuestos entra después por la misma puerta. Espejo del CHECK `flito_concil_boleta_concepto_chk`.
 */
export const ConceptoBoleta = {
  SOAT: 'soat',
} as const;

export type ConceptoBoleta = (typeof ConceptoBoleta)[keyof typeof ConceptoBoleta];

/**
 * Desenlace del cruce de UNA línea contra los SOAT de la compañía.
 *
 * Solo `ok` deja conciliar, y basta con que una línea no lo sea para que la boleta entera se quede
 * quieta (CF-02): no hay conciliación parcial, porque media boleta conciliada obligaría a llevar dos
 * verdades sobre el mismo pago externo.
 *
 *   ok               — cruzó con un SOAT pagado de la compañía y el valor coincide
 *   no_encontrada    — ninguna póliza de la compañía coincide
 *   no_pagado        — el SOAT existe pero todavía no está en `pagado`
 *   valor_distinto   — cruzó, pero el valor del portal no es el que FLITO tiene registrado
 *   poliza_duplicada — la póliza aparece en más de un SOAT: hay que corregir el número antes
 *   otra_compania    — la póliza es de un SOAT de otra compañía
 *   ya_conciliada    — ese SOAT ya salió de la bolsa en otra boleta
 *
 * Espejo del CHECK `flito_concil_linea_resultado_chk` de la 0157.
 */
export const ResultadoCruce = {
  OK: 'ok',
  NO_ENCONTRADA: 'no_encontrada',
  NO_PAGADO: 'no_pagado',
  VALOR_DISTINTO: 'valor_distinto',
  POLIZA_DUPLICADA: 'poliza_duplicada',
  OTRA_COMPANIA: 'otra_compania',
  YA_CONCILIADA: 'ya_conciliada',
} as const;

export type ResultadoCruce = (typeof ResultadoCruce)[keyof typeof ResultadoCruce];

/**
 * Longitud máxima de una póliza normalizada. Es el `varchar(60)` de `flito_soat.numero_poliza` y de
 * `flito_conciliacion_lineas.numero_poliza_norm`, y el tope del CHECK de formato de las dos.
 *
 * No es un límite de negocio —una póliza SOAT real ronda los 10-12 dígitos— sino un guarda contra la
 * otra clase de entrada: un OCR que leyó un párrafo entero donde debía haber un número. Sin él, ese
 * párrafo sería un `22001 value too long` en mitad de la transacción que marca el SOAT como pagado.
 */
export const POLIZA_MAX_LONGITUD = 60;

/**
 * Normaliza un número de póliza: se queda solo con A-Z y 0-9, en mayúsculas.
 *
 * Vive aquí, y no en el backend, porque tiene que ser BIT A BIT lo mismo que hace el backfill de la
 * migración 0157 (`upper(regexp_replace(valor, '[^A-Za-z0-9]', '', 'g'))`) y lo que la pantalla
 * enseña. Si el SQL y esto divergen, el síntoma no es un error: es una póliza que «no aparece».
 *
 * **El orden importa y es el del SQL: primero se filtra, después se pasa a mayúsculas.** Al revés
 * —`toUpperCase()` y luego filtrar— no es lo mismo: en JavaScript `'ß'.toUpperCase()` es `'SS'` y
 * `'ﬁ'.toUpperCase()` es `'FI'`, así que un carácter que PostgreSQL habría tirado se convertiría
 * aquí en dos letras que se quedan. Filtrando primero solo sobreviven ASCII, y sobre ASCII
 * `toUpperCase()` de JS y `upper()` de PostgreSQL coinciden siempre.
 */
export function normalizarPoliza(valor: string): string {
  return valor.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * La póliza tal como debe quedar en la COLUMNA `numero_poliza`, o `null` si no hay nada usable.
 *
 * Es el mismo predicado del backfill de la 0157 (`length(...) BETWEEN 1 AND 60`), y existe para que
 * los dos caminos que escriben la columna —el backfill una vez, y `pagarEnTx` en cada pago— no
 * puedan discrepar sobre qué es una póliza legible:
 *
 *   · la cadena vacía se guarda como `null` y NO como `''`. Un `''` pasaría por un valor y cruzaría
 *     con cualquier otra fila vacía: dos SOAT sin póliza legible se «encontrarían» entre sí.
 *   · lo que excede el tope se guarda como `null` en vez de reventar la transacción con un 22001.
 *
 * Un `null` aquí no es un fallo silencioso: es un SOAT que no se podrá conciliar hasta que alguien
 * corrija el número, y la pantalla del cruce lo dice con esas palabras (`no_encontrada`).
 */
export function polizaParaColumna(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  const norm = normalizarPoliza(valor);
  if (norm.length < 1 || norm.length > POLIZA_MAX_LONGITUD) return null;
  return norm;
}
