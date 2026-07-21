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

export interface ImpuestoCtx { userId: number; username: string; role: string; transitoCodigo: string | null }
