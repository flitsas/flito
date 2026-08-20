// FLITO Conciliación — el error de dominio del módulo, en un archivo propio.
//
// Vivía dentro de `flito-conciliacion.service.ts` y sale aquí por una razón mecánica, no estética:
// el servicio del comprobante (HU #11678) tiene que lanzarlo, y el servicio principal tiene que
// preguntarle a aquel por el comprobante vivo de una boleta para componer el detalle (AC2). Con la
// clase en el servicio principal eso es un ciclo de importación entre los dos archivos — que ESM
// tolera, pero solo mientras nadie use el import en tiempo de carga del módulo, y esa es justo la
// clase de dependencia que se rompe en silencio al reordenar un import.
//
// `flito-conciliacion.service.ts` lo RE-EXPORTA, así que ningún importador existente cambia.

/**
 * Fallo de negocio del módulo. Lleva su HTTP y su `codigo`: la pantalla decide el texto por el
 * código (docs/ux), y `message` es el respaldo legible para quien mire la respuesta a pelo.
 */
export class ConciliacionError extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ConciliacionError';
  }
}
