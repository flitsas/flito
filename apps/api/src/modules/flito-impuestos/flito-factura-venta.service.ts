// FLITO Impuestos — tipos compartidos del dominio de impuestos.
//
// Integración FLIT (Fase 8): la factura de venta YA NO se carga a mano ni se analiza con OCR. Viene de
// FLIT (campo `factura` = id S3) y se ve/descarga vía el endpoint presigned (ver flito-impuestos.routes:
// GET /:id/factura-venta y POST /facturas-venta/zip). Este archivo conserva solo los tipos que otros
// módulos reutilizan (ImpuestoError/ArchivoSubido/ImpuestoCtx); la lógica de carga/OCR se retiró.

export class ImpuestoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface ArchivoSubido { originalname: string; mimetype: string; buffer: Buffer; size: number }

/**
 * Contexto del actor sobre el dominio de impuestos.
 *
 * `organismos` (HU #12053) es la atadura CA-10 del `gestor_impuestos`, y es una LISTA: se lee de
 * `flito_gestor_organismos`, no de `users.transito_codigo` —que es del rol `transito` y solo cabía
 * uno—. El campo se RENOMBRÓ en vez de cambiarle solo el tipo a propósito: conservar el nombre
 * dejaba compilando cada `if (ctx.transitoCodigo)` con una semántica nueva.
 *
 * `[]` para los otros once roles. Para el gestor, `[]` significa **no ve nada** (sin frontera no hay
 * cola), nunca «sin acotar».
 */
export interface ImpuestoCtx { userId: number; username: string; role: string; organismos: string[] }
