// FLITO — SOAT, canal Cliente: recepción multipart del alta con documentos adicionales.
// HU #13362 (Feature #13360, Épica #13201). Diseño: docs/arquitectura/hu-13362-documentos-adicionales-soat.md (D1).
//
// ── Por qué un motor propio y no `memoryStorage` ────────────────────────────────────────────────
//
// Un alta puede traer hasta 250 MB de adicionales: en memoria y con varias peticiones a la vez, eso
// tumba el proceso del VPS. Los adicionales se escriben a DISCO —un directorio temporal por
// petición, con nombres generados (nunca el `originalname`)— y se calcula el sha256 al vuelo. La
// factura de venta sigue en memoria (≤15 MB), como siempre.
//
// ── Los límites de multer son TÉCNICOS, no de negocio ───────────────────────────────────────────
//
// Los topes del AC (15 MB por archivo, 20 archivos, 250 MB por envío) los aplica
// `clasificarAdicionales` del servicio, archivo por archivo y sin tumbar el alta: un adicional
// inválido se DESCARTA. Por eso multer lleva límites holgados que nunca deben saltar por un
// excedente de negocio. Lo único que sí corta aquí:
//   · la factura de venta >15 MB → `LIMIT_FILE_SIZE`, el mismo error de siempre (AC3/AC7);
//   · más de 100 adicionales → 413 con mensaje claro (decisión de David, 2026-10-07);
//   · un adicional >15 MB deja de escribirse a disco (se drena) y llega marcado `excedeTamano`.
//
// ── Temporales ──────────────────────────────────────────────────────────────────────────────────
//
// `_removeFile` borra el temporal cuando multer aborta, y la ruta llama `limpiarTemporales(req)` en
// un `finally` en TODOS los caminos. Nada de lo escrito aquí sobrevive a la petición.

import { createHash, randomUUID } from 'crypto';
import { createWriteStream, type WriteStream } from 'fs';
import { mkdir, rm, unlink } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

const MB = 1024 * 1024;
/** Por archivo (inclusivo): 15 MB exactos se aceptan. El mismo tope de la factura de venta. */
export const TAMANO_MAX_ARCHIVO = 15 * MB;
/** Protección de DISCO por petición: 250 MB de negocio + 15 de holgura. La regla exacta es del servicio. */
export const TOPE_DISCO_PETICION = 265 * MB;
/** Techo técnico de adicionales por envío. Por encima: 413 (no de negocio; ver cabecera). */
export const MAX_TECNICO_ADICIONALES = 100;
/** Bytes que se guardan en memoria para el olfateo del MIME (`file-type` mira la cabecera). */
const BYTES_CABECERA = 4100;

export const CAMPO_FACTURA = 'facturaVenta';
export const CAMPO_ADICIONALES = 'documentosAdicionales';
export const CAMPO_ETIQUETAS = 'etiquetasDocumentosAdicionales';

/** Un adicional tal como lo deja el motor. `path` es null si no se escribió (excedido). */
export interface ArchivoAdicionalRecibido {
  originalname: string;
  path: string | null;
  /** Tamaño REAL recibido, aunque se haya dejado de escribir. */
  size: number;
  sha256: string;
  cabecera: Buffer;
  excedeTamano: boolean;
  excedeTotal: boolean;
}

interface EstadoPeticion { dir: string | null; escrito: number }
const ESTADO = Symbol('flitoSoatAdicionales');
type ReqConEstado = Request & { [ESTADO]?: EstadoPeticion };

function estadoDe(req: Request): EstadoPeticion {
  const r = req as ReqConEstado;
  if (!r[ESTADO]) r[ESTADO] = { dir: null, escrito: 0 };
  return r[ESTADO]!;
}

async function directorioDe(estado: EstadoPeticion): Promise<string> {
  if (!estado.dir) {
    estado.dir = path.join(os.tmpdir(), `flito-soat-adic-${randomUUID()}`);
    await mkdir(estado.dir, { recursive: true, mode: 0o700 });
  }
  return estado.dir;
}

type Cb = (error?: unknown, info?: Partial<Express.Multer.File>) => void;

/** La factura: a memoria, ≤15 MB; por encima, el `LIMIT_FILE_SIZE` de siempre. */
function recibirFactura(file: Express.Multer.File, cb: Cb): void {
  const trozos: Buffer[] = [];
  let size = 0;
  let cortado = false;
  file.stream.on('data', (chunk: Buffer) => {
    if (cortado) return;
    size += chunk.length;
    if (size > TAMANO_MAX_ARCHIVO) {
      cortado = true;
      file.stream.resume();
      cb(new multer.MulterError('LIMIT_FILE_SIZE', CAMPO_FACTURA));
      return;
    }
    trozos.push(chunk);
  });
  file.stream.on('error', (e) => { if (!cortado) { cortado = true; cb(e); } });
  file.stream.on('end', () => {
    if (cortado) return;
    const buffer = Buffer.concat(trozos);
    cb(null, { buffer, size: buffer.length });
  });
}

/** Un adicional: a disco con sha256 al vuelo; excedido → se drena sin escribir y se marca. */
async function recibirAdicional(req: Request, file: Express.Multer.File, cb: Cb): Promise<void> {
  const estado = estadoDe(req);
  let destino: string;
  try {
    destino = path.join(await directorioDe(estado), randomUUID());
  } catch (e) { file.stream.resume(); cb(e); return; }

  const hash = createHash('sha256');
  const cabecera: Buffer[] = [];
  let largoCabecera = 0;
  let size = 0;
  let escritoAqui = 0;
  let excedeTamano = false;
  let excedeTotal = false;
  let out: WriteStream | null = createWriteStream(destino, { mode: 0o600 });
  let terminado = false;
  const fin = (e: unknown, info?: Partial<Express.Multer.File>) => { if (!terminado) { terminado = true; cb(e, info); } };

  const abandonar = () => {
    file.stream.resume();
    if (!out) return;
    out.destroy();
    out = null;
    estado.escrito -= escritoAqui;
    unlink(destino).catch(() => { /* el `finally` de la ruta borra el directorio entero */ });
  };

  out.on('error', (e) => { out = null; file.stream.resume(); fin(e); });
  file.stream.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (largoCabecera < BYTES_CABECERA) {
      const parte = chunk.subarray(0, BYTES_CABECERA - largoCabecera);
      cabecera.push(parte);
      largoCabecera += parte.length;
    }
    if (!out) return;
    if (size > TAMANO_MAX_ARCHIVO) { excedeTamano = true; abandonar(); return; }
    if (estado.escrito + chunk.length > TOPE_DISCO_PETICION) { excedeTotal = true; abandonar(); return; }
    hash.update(chunk);
    estado.escrito += chunk.length;
    escritoAqui += chunk.length;
    if (!out.write(chunk)) {
      file.stream.pause();
      out.once('drain', () => file.stream.resume());
    }
  });
  file.stream.on('error', (e) => { abandonar(); fin(e); });
  file.stream.on('end', () => {
    const info = {
      size, sha256: hash.digest('hex'), cabecera: Buffer.concat(cabecera), excedeTamano, excedeTotal,
    };
    if (!out) { fin(null, { ...info, path: null } as unknown as Partial<Express.Multer.File>); return; }
    out.end(() => fin(null, { ...info, path: destino } as unknown as Partial<Express.Multer.File>));
  });
}

const motor: multer.StorageEngine = {
  _handleFile(req, file, cb) {
    if (file.fieldname === CAMPO_ADICIONALES) { void recibirAdicional(req, file, cb); return; }
    recibirFactura(file, cb);
  },
  _removeFile(_req, file, cb) {
    const p = (file as { path?: string | null }).path;
    if (!p) { cb(null); return; }
    unlink(p).then(() => cb(null), () => cb(null));
  },
};

/**
 * La factura conserva su filtro de siempre (mime declarado o extensión `.pdf`; el filtro de verdad
 * es `verificarPdfReal`, por bytes). Los adicionales pasan todos: el filtro de verdad es
 * `detectMime` en `clasificarAdicionales`, que descarta sin tumbar el alta.
 */
const filtroArchivos: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (file.fieldname === CAMPO_ADICIONALES) { cb(null, true); return; }
  if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
  else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
};

/**
 * HU #13364 (D2) — la misma pieza para el alta y para la carga posterior: mismo motor, mismo filtro,
 * mismo techo técnico. Solo cambian los campos admitidos.
 */
function crearUpload(campos: multer.Field[]) {
  const archivos = campos.reduce((n, c) => n + (c.maxCount ?? 1), 0);
  return multer({
    storage: motor,
    limits: { fileSize: 251 * MB, files: archivos, fields: 200 },
    fileFilter: filtroArchivos,
  }).fields(campos);
}

const multerAlta = crearUpload([
  { name: CAMPO_FACTURA, maxCount: 1 },
  { name: CAMPO_ADICIONALES, maxCount: MAX_TECNICO_ADICIONALES },
]);

/** Carga posterior (HU #13364): SOLO adicionales, hasta el techo técnico. */
const multerAdicionales = crearUpload([{ name: CAMPO_ADICIONALES, maxCount: MAX_TECNICO_ADICIONALES }]);

export const MENSAJE_DEMASIADOS_ARCHIVOS =
  `Se enviaron demasiados archivos (máximo técnico ${MAX_TECNICO_ADICIONALES} documentos adicionales por envío)`;
export const MENSAJE_CAMPO_NO_PERMITIDO = 'Campo de archivo no permitido';

/** El exceso del techo técnico: por cantidad total o por el `maxCount` del campo de adicionales. */
function esExcesoDeArchivos(e: unknown): boolean {
  if (!(e instanceof multer.MulterError)) return false;
  return e.code === 'LIMIT_FILE_COUNT' || (e.code === 'LIMIT_UNEXPECTED_FILE' && e.field === CAMPO_ADICIONALES);
}

/** Un archivo en un campo que esta ruta no admite (p. ej. `facturaVenta` en la carga posterior). */
function esCampoAjeno(e: unknown): boolean {
  return e instanceof multer.MulterError && e.code === 'LIMIT_UNEXPECTED_FILE' && e.field !== CAMPO_ADICIONALES;
}

/**
 * Middleware del alta. Cualquier error de multer limpia los temporales; el exceso del techo técnico
 * sale como **413** con mensaje claro, el resto sigue al manejador global como hasta hoy.
 */
export function uploadAlta(req: Request, res: Response, next: NextFunction): void {
  multerAlta(req, res, (e?: unknown) => {
    if (!e) { next(); return; }
    void limpiarTemporales(req).finally(() => {
      if (esExcesoDeArchivos(e)) { res.status(413).json({ error: MENSAJE_DEMASIADOS_ARCHIVOS }); return; }
      next(e);
    });
  });
}

/**
 * Middleware de la carga posterior (HU #13364). Igual que `uploadAlta`, y además un archivo en otro
 * campo es un **400** (no un 500 del manejador global).
 */
export function uploadAdicionales(req: Request, res: Response, next: NextFunction): void {
  multerAdicionales(req, res, (e?: unknown) => {
    if (!e) { next(); return; }
    void limpiarTemporales(req).finally(() => {
      if (esExcesoDeArchivos(e)) { res.status(413).json({ error: MENSAJE_DEMASIADOS_ARCHIVOS }); return; }
      if (esCampoAjeno(e)) { res.status(400).json({ error: MENSAJE_CAMPO_NO_PERMITIDO }); return; }
      next(e);
    });
  });
}

/** Borra el directorio temporal de la petición, si se creó. Idempotente. */
export async function limpiarTemporales(req: Request): Promise<void> {
  const estado = (req as ReqConEstado)[ESTADO];
  if (!estado?.dir) return;
  const dir = estado.dir;
  estado.dir = null;
  await rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort: tmp del SO */ });
}

/** Lo que el alta recibió, ya separado por campo. Las etiquetas, alineadas por índice. */
export function archivosDelAlta(req: Request): {
  factura: Express.Multer.File | null; adicionales: ArchivoAdicionalRecibido[]; etiquetas: unknown;
} {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[] | undefined>;
  return {
    factura: files[CAMPO_FACTURA]?.[0] ?? null,
    adicionales: (files[CAMPO_ADICIONALES] ?? []) as unknown as ArchivoAdicionalRecibido[],
    etiquetas: (req.body as Record<string, unknown> | undefined)?.[CAMPO_ETIQUETAS],
  };
}

/** Lo que recibió la carga posterior (HU #13364): solo adicionales y sus etiquetas. */
export function archivosDeCarga(req: Request): { adicionales: ArchivoAdicionalRecibido[]; etiquetas: unknown } {
  const { adicionales, etiquetas } = archivosDelAlta(req);
  return { adicionales, etiquetas };
}
