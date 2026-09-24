// FLITO Impuestos — ORDEN de los pasos del análisis post-envío (HU #12825 punto de extensión).
//
// Un solo sitio con el orden explícito: los pasos no se registran a sí mismos al importarse (un
// efecto de import depende del orden de los imports y `__resetColaAnalisis()` lo borra en tests).
// `registrarPasoAnalisis` usa `Map.set`, así que llamar esto dos veces es idempotente.

import { registrarPasoAnalisis } from './flito-impuestos.analisis.service.js';
import { pasoAutocertificacion } from './flito-impuestos.autocertificacion.js';
import { pasoComparacion } from './flito-impuestos.comparacion.js';
import { pasoDireccion } from './flito-impuestos.direccion.js';
import { pasoExtraccion } from './flito-impuestos.extraccion.js';

export function registrarPasosAnalisisImpuestos(): void {
  // 12826 — primero: la 12827 compara con el RUNT lo que este paso extrae de la factura.
  registrarPasoAnalisis('extraccion', pasoExtraccion);
  // 12833 — antes del RUNT: si la comparación cae, la dirección confiable ya quedó confirmada.
  registrarPasoAnalisis('direccion', pasoDireccion);
  // 12827 — tercero: consulta el RUNT UNA vez (queda en `job.consultaRunt`) y calcula el semáforo.
  registrarPasoAnalisis('comparacion', pasoComparacion);
  // 12828 — cuarto: certifica con ESA misma respuesta RUNT si procede (sin reconsultar).
  registrarPasoAnalisis('autocertificacion', pasoAutocertificacion);
}
