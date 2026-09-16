// FLITO Impuestos — la carpeta del ZIP DECLARA la fase del recibo (HU #12614 / #12615).
//
// Vive aquí, y no en el API, porque la regla la aplican DOS sitios con la misma ruta: el servidor,
// al archivar cada recibo y al reportar `carpetasSinFase`; y el navegador, al avisar ANTES de
// enviar qué carpetas no dicen nada y al ordenar las liquidaciones delante de los pagos. Duplicar
// las regex sería garantía de que el aviso mienta el día que cambie una.
//
// Orden de evaluación: la negación explícita primero («sin marca», «sin agua»), luego los tokens
// de pago, luego los de liquidación. Los tokens de pago mandan sobre los de liquidación
// («liquidaciones_pagadas» es pago), pero «SIN MARCA DE AGUA» contiene «marca de agua» y aun así es
// liquidación. Sin token → `null`: fase por defecto (la del selector) y carpeta «sin fase».
//
// Solo cuenta el DIRECTORIO de la ruta: el nombre del archivo no declara fase («pagado.pdf» suelto
// se archiva con la fase del selector).

import { FaseRecibo } from './flito-estados.js';

/** Solo el directorio de la ruta: el nombre del archivo no declara fase («pagado.pdf» suelto). */
const directorioDe = (ruta: string): string[] => ruta.split('/').slice(0, -1).filter((s) => s !== '');

// `pagos?(?![a-z])` para no casar «propagó»; `pagad` cubre pagado/pagada/pagados.
const NEGACION = /sin[\s_-]*(?:marca|agua)/;
const TOKENS_PAGO = /pagad|pagos?(?![a-z])|con[\s_-]*marca|marca[\s_-]*de[\s_-]*agua|con[\s_-]*agua/;
const TOKENS_LIQUIDACION = /limpi|original|liquidac/;

/** La fase que DECLARA la carpeta de la ruta, o `null` si ninguna palabra la nombra. */
export function faseDeCarpeta(ruta: string): FaseRecibo | null {
  const t = directorioDe(ruta).join('/').toLowerCase();
  if (t === '') return null;
  if (NEGACION.test(t)) return FaseRecibo.LIQUIDACION;
  if (TOKENS_PAGO.test(t)) return FaseRecibo.PAGO;
  if (TOKENS_LIQUIDACION.test(t)) return FaseRecibo.LIQUIDACION;
  return null;
}

/** Primer segmento de carpeta de la ruta (`liquidaciones/2026/ABC.pdf` → `liquidaciones`); sin carpeta → `null`. */
export function carpetaRaiz(ruta: string): string | null {
  return directorioDe(ruta)[0] ?? null;
}
