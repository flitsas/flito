// FLITO Impuestos — reglas PURAS de la fase de un recibo (HU #12614). Sin `db`, sin OCR, sin I/O:
// `flito-recibos.service.ts` las orquesta. Viven aparte para que las tablas de decisión se prueben
// sin coreografía de `selectMock` y para que el servicio no crezca hacia el tope de `max-lines`.
//
// Tres decisiones, en el orden en que el lote las encuentra:
//   1. `faseDeCarpeta` — la carpeta del ZIP (o la ruta declarada por el navegador) DECLARA la fase.
//      Los tokens de pago mandan sobre los de liquidación («liquidaciones_pagadas» es pago), pero
//      una negación explícita («sin marca», «sin agua») va antes que todo: «SIN MARCA DE AGUA»
//      contiene «marca de agua» y aun así es liquidación. Sin token → `null` (fase por defecto, y
//      `carpetaRaiz` la reporta como carpeta sin fase). Desde la HU #12615 la regla vive en
//      `@operaciones/shared-types` (el navegador la comparte); aquí solo se re-exporta.
//   2. `resolverPlacaRepetida` — dos (o más) archivos de la MISMA placa y la MISMA fase declarada en
//      un lote (AC5): el sello decide cuál es la liquidación y cuál el pago, sea cual sea la fase
//      declarada. Con un sello ilegible en el grupo no se adivina: todos a «fase no coincide».
//      Fases declaradas distintas para la misma placa NO se agrupan: cada archivo sigue por su
//      cuenta (AC2–AC4), y si vienen cruzados la vigilancia rechaza cada uno por separado.
//   3. `vigilarFase` — el sello PAGADO leído por el OCR VIGILA la fase declarada, no la decide
//      (AC2/AC3): pago sin sello o liquidación con sello se rechazan antes de escribir nada. Ante la
//      duda (sello no leído o bajo el umbral) se respeta lo declarado (AC4), NUNCA se manda a revisión.
//
// El sello «confiable» de `leerSello` es el que marcó `remarcarConfiable` con el umbral del organismo
// del candidato. En la etapa de AC5 el candidato todavía no se conoce, así que ahí `confiable` es el
// que estampó `extraer` con el umbral por defecto del lote (decisión por defecto de la HU: buscar el
// candidato antes de agrupar costaría un SELECT por archivo). Una vez reasignada la fase por el
// sello, la vigilancia coincide por construcción o cae en «duda» y respeta lo reasignado.

import { CampoImpuesto, FaseRecibo, type ExtraccionImpuesto } from '@operaciones/shared-types';

/** Lo que dice el sello: `true` con sello, `false` sin él, `null` = no se sabe (AC4: duda). */
export type Sello = boolean | null;

export const DETALLE_PAGO_SIN_SELLO = 'No se ve el sello PAGADO; súbelo con la fase Liquidación.';
export const DETALLE_LIQUIDACION_CON_SELLO = 'Tiene sello PAGADO; súbelo con la fase Pago.';

/** El sello leído SOLO cuenta si es confiable (con el umbral que aplique); si no, es duda. */
export function leerSello(extraccion: ExtraccionImpuesto): Sello {
  const s = extraccion[CampoImpuesto.SELLO_PAGADO];
  if (!s || s.valor === null || !s.confiable) return null;
  return s.valor === 'true';
}

/**
 * Tabla declarado × sello. `null` = sigue con la fase declarada; `{ detalle }` = rechazo a
 * `faseNoCoincide`. Ante la duda (`sello === null`) NUNCA rechaza ni manda a revisión.
 */
export function vigilarFase(fase: FaseRecibo, sello: Sello): { detalle: string } | null {
  if (sello === null) return null;
  if (fase === FaseRecibo.PAGO && !sello) return { detalle: DETALLE_PAGO_SIN_SELLO };
  if (fase === FaseRecibo.LIQUIDACION && sello) return { detalle: DETALLE_LIQUIDACION_CON_SELLO };
  return null;
}

/** Un archivo del lote ya leído por el OCR, en el orden de llegada. */
export interface EntradaPlaca {
  archivo: string;
  /** Llave de cruce ya normalizada (placa del OCR o del nombre); `null` = no se agrupa. */
  llave: string | null;
  fase: FaseRecibo;
  sello: Sello;
}

export type DecisionPlaca =
  | { accion: 'procesar'; fase: FaseRecibo }
  | { accion: 'faseNoCoincide'; detalle: string }
  | { accion: 'duplicado'; detalle: string };

const cuantos = (n: number): string => (n === 2 ? 'Dos' : 'Varios');

/**
 * AC5. Devuelve una decisión por índice de `entradas`. Agrupa por `llave + fase declarada`; un grupo
 * de uno (o sin llave) se procesa tal cual. En un grupo de dos o más:
 *   · algún sello `null` → TODOS a `faseNoCoincide` («no se distingue cuál es el pago»); nada se escribe.
 *   · si no, el primero sin sello es la liquidación y el primero con sello es el pago (manda el
 *     sello, no la fase declarada); cualquier otro con un sello ya tomado → `duplicado`.
 */
export function resolverPlacaRepetida(entradas: readonly EntradaPlaca[]): DecisionPlaca[] {
  const grupos = new Map<string, number[]>();
  entradas.forEach((e, i) => {
    if (!e.llave) return;
    const k = `${e.llave}|${e.fase}`;
    grupos.set(k, [...(grupos.get(k) ?? []), i]);
  });
  const salida: DecisionPlaca[] = entradas.map((e) => ({ accion: 'procesar', fase: e.fase }));
  for (const indices of grupos.values()) {
    if (indices.length < 2) continue;
    const placa = entradas[indices[0]!]!.llave!;
    if (indices.some((i) => entradas[i]!.sello === null)) {
      const detalle = `${cuantos(indices.length)} documentos de ${placa} y no se distingue cuál es el pago.`;
      for (const i of indices) salida[i] = { accion: 'faseNoCoincide', detalle };
      continue;
    }
    const tomado = new Map<boolean, string>();
    for (const i of indices) {
      const e = entradas[i]!;
      const sello = e.sello as boolean;
      const previo = tomado.get(sello);
      if (previo !== undefined) {
        salida[i] = { accion: 'duplicado', detalle: `${cuantos(indices.length)} documentos de ${placa} con el mismo sello en el lote; ya se tomó ${previo}.` };
        continue;
      }
      tomado.set(sello, e.archivo);
      salida[i] = { accion: 'procesar', fase: sello ? FaseRecibo.PAGO : FaseRecibo.LIQUIDACION };
    }
  }
  return salida;
}

// La regla de carpetas (`faseDeCarpeta`, `carpetaRaiz`) vive desde la HU #12615 en
// `@operaciones/shared-types`: el navegador la necesita con las MISMAS regex para avisar antes de
// enviar y para ordenar las liquidaciones delante. Se re-exporta para que el servicio y sus tests
// sigan leyéndola de aquí.
export { carpetaRaiz, faseDeCarpeta } from '@operaciones/shared-types';

/** Liquidaciones primero, en sitio y estable (Node conserva el orden relativo del resto). */
export function liquidacionPrimero<T>(items: T[], faseDe: (item: T) => FaseRecibo): T[] {
  const esLiq = (item: T): number => Number(faseDe(item) === FaseRecibo.LIQUIDACION);
  return items.sort((a, b) => esLiq(b) - esLiq(a));
}
