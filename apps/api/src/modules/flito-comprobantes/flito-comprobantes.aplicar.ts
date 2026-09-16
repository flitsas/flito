// Comprobantes universales (Épica #12245, Feature #12606, ADR-0018 §4) — HU #12629: APLICAR (esqueleto
// común) y DESCARTAR; HU #12630: los pagos de SOAT / impuesto / derecho a través de sus dueños.
//
// El esqueleto de `aplicar` es todo lo que NO depende del concepto: las guardas (404 → 409 ya_resuelto
// → 400 datos_invalidos), la confirmación de campos por la persona (`confirmar` de revisiones: los
// campos que ella escribió pasan a confianza 1 con su firma), el bloqueo del trámite (`FOR UPDATE`,
// `bloquearTramite` de servicios adicionales: la liquidación toma el mismo bloqueo), el soporte que ve
// el destino (el original reescrito, o un HIJO recortado cuando el documento venía de un consolidado:
// nunca se reescribe un soporte compartido, mutante (3)), y el cierre de la fila con auditoría.
//
// Lo que SÍ depende del concepto vive en `flito-comprobantes.duenos.ts` (HU #12630): la guarda del
// destino (409 `ya_pagado` / `destino_no_admite` con `puedeAdjuntar`, ANTES de subir nada a S3 y otra
// vez bajo el bloqueo del trámite) y la escritura del dueño —`conciliar` dentro de la tx (impuesto);
// `aplicarFacturaSoat` → `marcarPagado` y `registrarDesdeRevision` tras el commit (abren su propia tx
// y necesitan ver el soporte atado)—. Los honorarios (HU-3) siguen saliendo por `aplicarPago`: 409
// `destino_no_admite` con `puedeAdjuntar: true`. `esPago = false` (adjuntar documentación, D3) se
// cierra aquí entero, aunque el destino esté pagado (AC4).
//
// Si el dueño falla TRAS el commit (carrera contra otro pago del mismo SOAT, por ejemplo), la fila del
// comprobante vuelve a `pendiente` (compensación) y la persona recibe el 409 con lo que dijo el dueño:
// nunca queda un comprobante «aplicado como pago» de algo que no se pagó.
//
// Ningún log lleva contenido leído (Habeas Data): ids, conceptos, cuentas.

import { createHash } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CAMPOS_COMPROBANTE, CodigoErrorComprobante, CONCEPTOS_COSTO, ConceptoCosto, CruceComprobante, EstadoComprobante,
  TipoSoporte, type CampoExtraido, type ComprobanteDetalleDto, type ExtraccionComprobante,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoComprobantes, flitoDerechosTramite, flitoImpuestos, flitoSoportes, flitoTramites } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { getEntityDocumentStream, uploadEntityDocument } from '../../services/storage.js';
import { nombrePagina, recortarPaginas } from '../../shared/pdf/separar-paginas.js';
import { confirmar } from '../flito-revisiones/flito-revisiones.service.js';
import { bloquearTramite, TramiteNoEncontradoError, type Tx } from '../finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js';
import { columnasDeLectura, ComprobanteError, detalle, type ComprobanteCtx } from './flito-comprobantes.service.js';
import { CARPETA_COMPROBANTES } from './flito-comprobantes.carga.js';
import { comprobarDestinoPago, pagarEnTx, pagarTrasCommit, tieneDueno, type DestinoPago, type PagoArgs } from './flito-comprobantes.duenos.js';

const log = loggerFor('flito-comprobantes-aplicar');

/** La forma que `confirmar` acepta (un `Record` de campos): la universal y la del destino la cumplen. */
type Extraccion = Parameters<typeof confirmar>[0];

/** Prefijo `destino.` con el que el detalle expone (y la persona confirma) los campos del extractor especializado. */
export const PREFIJO_DESTINO = 'destino.';

/** Carpeta S3 del soporte hijo recortado: cuelga del trámite al que se aplicó. */
export const CARPETA_APLICADOS = `${CARPETA_COMPROBANTES}/tramites`;

// ─────────────────────────── Esquema ─────────────────────────────────────────

/**
 * `POST /:id/aplicar` (AC7). Un solo `tramiteId` (D11: el esquema no admite lista). SIN
 * `aceptarDiferencia` (ficha UX §7.7: el panel no conoce la tarifa antes de aplicar). El refine de
 * «trámite ≠ candidato sugerido ⇒ motivo» necesita la fila y vive en `aplicar`, no aquí.
 */
export const aplicarSchema = z.object({
  tramiteId: z.string().uuid(),
  concepto: z.enum(CONCEPTOS_COSTO as [ConceptoCosto, ...ConceptoCosto[]]),
  esPago: z.boolean(),
  campos: z.record(z.string().max(200)).default({}),
  motivo: z.string().trim().min(5).max(500).optional(),
}).refine((b) => Object.keys(b.campos).length === 0 || !!b.motivo, { message: 'Confirmar campos exige motivo', path: ['motivo'] });

export type AplicarBody = z.infer<typeof aplicarSchema>;

export const motivoSchema = z.object({ motivo: z.string().trim().min(5).max(500) });

// ─────────────────────────── Errores ─────────────────────────────────────────

const noEncontrado = (que = 'El comprobante no existe') => new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, que);
const yaResuelto = () => new ComprobanteError(409, CodigoErrorComprobante.YA_RESUELTO, 'El comprobante ya no está pendiente');
const datosInvalidos = (msg: string) => new ComprobanteError(400, CodigoErrorComprobante.DATOS_INVALIDOS, msg);

/**
 * El eslabón declarado de la HU #12629, que la #12630 cerró para SOAT / impuesto / derecho: los
 * HONORARIOS siguen respondiendo 409 con `puedeAdjuntar: true` hasta HU-3, que sustituye esta salida
 * por su fila documental sin tocar el esqueleto.
 */
export function aplicarPago(concepto: ConceptoCosto): never {
  throw new ComprobanteError(409, CodigoErrorComprobante.DESTINO_NO_ADMITE, `El pago de ${concepto} aún no se aplica desde aquí`, {
    detalle: 'Los pagos se aplican en la siguiente entrega', puedeAdjuntar: true,
  });
}

// ─────────────────────────── Confirmación de campos ──────────────────────────

const UNIVERSALES: readonly string[] = CAMPOS_COMPROBANTE;

/**
 * Reparte lo que la persona confirmó: las claves universales van a `extraccion`; las `destino.*` a
 * `extraccionDestino` (sin el prefijo). Una clave que no es ni lo uno ni lo otro es un 400: el
 * extractor descarta claves desconocidas y aceptarla aquí sería guardar un dato que nadie leerá.
 */
export function repartirCampos(campos: Record<string, string>): { universales: Record<string, string>; destino: Record<string, string> } {
  const universales: Record<string, string> = {};
  const destino: Record<string, string> = {};
  for (const [k, v] of Object.entries(campos)) {
    if (UNIVERSALES.includes(k)) universales[k] = v;
    else if (k.startsWith(PREFIJO_DESTINO) && k.length > PREFIJO_DESTINO.length) destino[k.slice(PREFIJO_DESTINO.length)] = v;
    else throw datosInvalidos(`Campo desconocido: ${k}`);
  }
  return { universales, destino };
}

// ─────────────────────────── Soporte del destino ─────────────────────────────

interface Soporte { id: string; storageKey: string; nombreArchivo: string; contentType: string }

/** El hijo recortado, ya subido a S3 (ANTES de la tx, CA-11): lo que falta es su fila. */
interface HijoSubido { storageKey: string; nombreArchivo: string; hash: string; tamanoBytes: number }

async function aBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const trozos: Buffer[] = [];
  for await (const t of stream) trozos.push(Buffer.from(t));
  return Buffer.concat(trozos);
}

/**
 * Recorta las `paginas` del consolidado y sube el hijo a S3 bajo el trámite. S3 antes que BD: si la tx
 * luego falla, queda un objeto huérfano que se puede barrer; al revés quedaría una fila que apunta a nada.
 */
async function subirHijo(soporte: Soporte, paginas: number[], tramiteId: string): Promise<HijoSubido> {
  const entero = await aBuffer(await getEntityDocumentStream(soporte.storageKey) as AsyncIterable<Uint8Array>);
  const buf = await recortarPaginas(entero, paginas);
  const nombreArchivo = nombrePagina(soporte.nombreArchivo, paginas[0]!);
  const storageKey = await uploadEntityDocument(CARPETA_APLICADOS, tramiteId, nombreArchivo, buf, 'application/pdf');
  return { storageKey, nombreArchivo, hash: createHash('sha256').update(buf).digest('hex'), tamanoBytes: buf.length };
}

/** La FK del destino que lleva el soporte de documentación (`soat_id` / `impuesto_id` / `derecho_id`); ninguna en los honorarios. */
async function fkDestino(tx: Tx, tramiteId: string, concepto: ConceptoCosto): Promise<{ soatId?: string; impuestoId?: string; derechoId?: string }> {
  if (concepto === ConceptoCosto.SOAT) {
    const [t] = await tx.select({ soatId: flitoTramites.soatId }).from(flitoTramites).where(eq(flitoTramites.id, tramiteId)).limit(1);
    return t?.soatId ? { soatId: t.soatId } : {};
  }
  if (concepto === ConceptoCosto.IMPUESTO) {
    const [i] = await tx.select({ id: flitoImpuestos.id }).from(flitoImpuestos).where(eq(flitoImpuestos.tramiteId, tramiteId)).limit(1);
    return i ? { impuestoId: i.id } : {};
  }
  if (concepto === ConceptoCosto.DERECHO) {
    const [d] = await tx.select({ id: flitoDerechosTramite.id }).from(flitoDerechosTramite).where(eq(flitoDerechosTramite.tramiteId, tramiteId)).limit(1);
    return d ? { derechoId: d.id } : {};
  }
  return {};
}

/**
 * Dentro de la tx: el soporte que verá el destino. Con `hijo` se INSERTA una fila nueva (el original
 * compartido no se toca: mutante (3)); sin él se reescribe el original en sitio (`tipo` + FK). El
 * `tipo` es `documento_tramite` al adjuntar y el del dueño al pagar (`factura_soat`: `pagarEnTx` de
 * SOAT lo exige; `recibo_impuesto` / `recibo_caja_impuesto`; `derecho_tramite`).
 */
async function soporteDelDestino(tx: Tx, soporte: Soporte, hijo: HijoSubido | null, fk: Record<string, string | undefined>, tipo: string, ctx: ComprobanteCtx): Promise<string> {
  if (hijo) {
    const [s] = await tx.insert(flitoSoportes).values({
      tipo, nombreArchivo: hijo.nombreArchivo, contentType: 'application/pdf',
      storageKey: hijo.storageKey, hash: hijo.hash, tamanoBytes: hijo.tamanoBytes,
      subidoPorId: ctx.userId, subidoPorNombre: ctx.username, ...fk,
    }).returning({ id: flitoSoportes.id });
    return s!.id;
  }
  await tx.update(flitoSoportes).set({ tipo, ...fk }).where(eq(flitoSoportes.id, soporte.id));
  return soporte.id;
}

// ─────────────────────────── Bloqueo del comprobante ─────────────────────────

/**
 * Relee el comprobante DENTRO de la tx con `FOR UPDATE` y exige que siga `pendiente`. La guarda de
 * fuera de la tx no basta: dos `aplicar` (o un `aplicar` y un `descartar`) concurrentes la pasan y el
 * segundo reescribiría el soporte hacia otro destino mientras su UPDATE condicionado afecta 0 filas.
 * Orden de bloqueo fijo en `aplicar` y `descartar`: comprobante PRIMERO, trámite después
 * (`bloquearTramite`), para no cruzar bloqueos con otra petición.
 */
async function bloquearComprobantePendiente(tx: Tx, id: string): Promise<void> {
  const [fila] = await tx.select({ estado: flitoComprobantes.estado }).from(flitoComprobantes)
    .where(eq(flitoComprobantes.id, id)).for('update').limit(1);
  if (!fila) throw noEncontrado();
  if (fila.estado !== EstadoComprobante.PENDIENTE) throw yaResuelto();
}

// ─────────────────────────── aplicar ─────────────────────────────────────────

/** `fecha_pago` leída (`YYYY-MM-DD`, ya validada por `columnasDeLectura`) como instante en Bogotá; `null` si no la hay. */
function fechaPagoDe(fechaDocumento: string | null): Date | null {
  if (!fechaDocumento) return null;
  const d = new Date(`${fechaDocumento}T00:00:00-05:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `POST /:id/aplicar` (AC7 de #12629; pagos de #12630). Orden: 404 → 409 `ya_resuelto` → 400 (Zod +
 * «trámite ≠ sugerido exige motivo») → pago: guarda del dueño con `db` (409 `ya_pagado` /
 * `destino_no_admite`, ANTES de S3; honorarios: eslabón) → recorte y subida del hijo (fuera de la tx)
 * → tx: `FOR UPDATE` sobre el comprobante (sigue pendiente, o 409), `FOR UPDATE` sobre el trámite,
 * guarda del dueño otra vez bajo el bloqueo, soporte del destino, impuesto: `conciliar`, cierre de la
 * fila → tras el commit: SOAT / derecho escriben en su propia tx. Devuelve el detalle. Si la carrera
 * se pierde tras subir el hijo, el objeto de S3 queda huérfano (aceptado: la fila no lo referencia).
 */
export async function aplicar(id: string, cuerpo: unknown, ctx: ComprobanteCtx): Promise<ComprobanteDetalleDto> {
  const [c] = await db.select({
    id: flitoComprobantes.id, estado: flitoComprobantes.estado, soporteId: flitoComprobantes.soporteId, paginas: flitoComprobantes.paginas,
    tramiteId: flitoComprobantes.tramiteId, cruce: flitoComprobantes.cruce, tipoDocumento: flitoComprobantes.tipoDocumento,
    extraccion: flitoComprobantes.extraccion, extraccionDestino: flitoComprobantes.extraccionDestino,
  }).from(flitoComprobantes).where(eq(flitoComprobantes.id, id)).limit(1);
  if (!c) throw noEncontrado();
  if (c.estado !== EstadoComprobante.PENDIENTE) throw yaResuelto();

  const parsed = aplicarSchema.safeParse(cuerpo ?? {});
  if (!parsed.success) throw datosInvalidos(parsed.error.issues[0]?.message ?? 'Cuerpo inválido');
  const body = parsed.data;
  const esSugerido = c.tramiteId !== null && body.tramiteId === c.tramiteId;
  if (!esSugerido && !body.motivo) throw datosInvalidos('Asociar a un trámite distinto del sugerido exige motivo');
  const { universales, destino } = repartirCampos(body.campos);

  // Los campos que la persona escribió pasan a confianza 1 con su firma; los demás conservan la suya.
  const extraccion = confirmar(c.extraccion as Extraccion, universales, ctx.userId) as ExtraccionComprobante;
  const extraccionDestinoBase = (c.extraccionDestino as Record<string, CampoExtraido> | null) ?? null;
  const extraccionDestino = extraccionDestinoBase || Object.keys(destino).length
    ? (confirmar((extraccionDestinoBase ?? {}) as Extraccion, destino, ctx.userId) as Record<string, CampoExtraido>)
    : null;
  const lectura = columnasDeLectura({ extraccion, extraccionDestino: extraccionDestino as never, tipoDestino: null });
  const tipoDocumento = lectura.tipoDocumento ?? c.tipoDocumento ?? null;

  // El dispatcher por concepto (AC4): la guarda del dueño ANTES de subir nada a S3; honorarios → eslabón.
  const destinoPago: DestinoPago | null = !body.esPago ? null
    : tieneDueno(body.concepto) ? await comprobarDestinoPago(db, body.tramiteId, body.concepto, tipoDocumento)
      : aplicarPago(body.concepto);

  const [soporte] = await db.select({ id: flitoSoportes.id, storageKey: flitoSoportes.storageKey, nombreArchivo: flitoSoportes.nombreArchivo, contentType: flitoSoportes.contentType })
    .from(flitoSoportes).where(eq(flitoSoportes.id, c.soporteId)).limit(1);
  if (!soporte) throw noEncontrado('El archivo del comprobante no existe');
  const paginas = c.paginas ?? null;
  const hijo = paginas ? await subirHijo(soporte, paginas, body.tramiteId) : null;

  const cruce = esSugerido ? (c.cruce ?? CruceComprobante.MANUAL) : CruceComprobante.MANUAL;
  const argsBase = { tramiteId: body.tramiteId, extraccionDestino: extraccionDestino ?? {}, motivo: body.motivo ?? null, fechaPago: fechaPagoDe(lectura.fechaDocumento), ctx };
  let args: PagoArgs | null = null;
  await db.transaction(async (tx) => {
    await bloquearComprobantePendiente(tx, id);
    let tramite: { id: string; idFlit: string };
    try {
      tramite = await bloquearTramite(tx, body.tramiteId);
    } catch (e) {
      if (e instanceof TramiteNoEncontradoError) throw noEncontrado('El trámite no existe');
      throw e;
    }
    // Bajo el bloqueo del trámite, el estado REAL del destino: la carrera con otro pago se pierde aquí.
    const enTx = destinoPago ? await comprobarDestinoPago(tx, tramite.id, destinoPago.concepto, tipoDocumento) : null;
    const fk = enTx ? enTx.fk : await fkDestino(tx, tramite.id, body.concepto);
    const soporteAplicadoId = await soporteDelDestino(tx, soporte, hijo, fk, enTx?.tipoSoporte ?? TipoSoporte.DOCUMENTO_TRAMITE, ctx);
    const cierre: CierreComprobante = {
      tramiteId: tramite.id, concepto: body.concepto, cruce, motivo: body.motivo ?? null, soporteAplicadoId,
      extraccion, extraccionDestino, tipoDocumento,
      placaLeida: lectura.placaLeida, vinLeido: lectura.vinLeido, idFlitLeido: lectura.idFlitLeido,
      fechaDocumento: lectura.fechaDocumento, numeroDocumento: lectura.numeroDocumento, emisor: lectura.emisor,
    };
    if (!enTx) { await adjuntarDocumentacion(tx, id, cierre, ctx); return; }
    args = { ...argsBase, tramiteId: tramite.id, soporteAplicadoId };
    const pago = await pagarEnTx(tx, enTx, args);
    await cerrarComoPago(tx, id, cierre, pago?.valorPagado ?? lectura.valor, ctx);
  });
  if (destinoPago && args) await pagarDespuesDelCommit(id, destinoPago, args);
  log.info({ comprobanteId: id, tramiteId: body.tramiteId, concepto: body.concepto, esPago: body.esPago, cruce, hijo: hijo !== null, por: ctx.userId },
    destinoPago ? 'Comprobante aplicado como pago' : 'Comprobante adjuntado como documentación');
  return detalle(id);
}

/**
 * SOAT y derecho escriben tras el commit (ver cabecera). Si el dueño rechaza —el SOAT dejó de estar
 * `solicitado` entre la guarda y su tx, por ejemplo—, el comprobante vuelve a `pendiente` y la
 * persona recibe 409 `destino_no_admite` con lo que dijo el dueño; el soporte queda atado (retipado o
 * el hijo insertado) y un reintento lo reutiliza sin tocar S3 de nuevo.
 */
async function pagarDespuesDelCommit(id: string, destinoPago: DestinoPago, args: PagoArgs): Promise<void> {
  try {
    await pagarTrasCommit(destinoPago, args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error desconocido';
    log.error({ comprobanteId: id, tramiteId: args.tramiteId, concepto: destinoPago.concepto, err: msg }, 'El dueño rechazó el pago tras el commit; el comprobante vuelve a pendiente');
    await db.update(flitoComprobantes).set({
      estado: EstadoComprobante.PENDIENTE, esPago: null, valor: null, soporteAplicadoId: null,
      aplicadoPorId: null, aplicadoEn: null, aplicadoMotivo: null, updatedAt: new Date(),
    }).where(and(eq(flitoComprobantes.id, id), eq(flitoComprobantes.estado, EstadoComprobante.APLICADO)));
    if (e instanceof ComprobanteError) throw e;
    throw new ComprobanteError(409, CodigoErrorComprobante.DESTINO_NO_ADMITE, `El pago no se registró en ${destinoPago.concepto}: ${msg}`, { detalle: msg, puedeAdjuntar: false });
  }
}

interface CierreComprobante {
  tramiteId: string;
  concepto: ConceptoCosto;
  cruce: string;
  motivo: string | null;
  soporteAplicadoId: string;
  extraccion: ExtraccionComprobante;
  extraccionDestino: Record<string, CampoExtraido> | null;
  tipoDocumento: string | null;
  placaLeida: string | null;
  vinLeido: string | null;
  idFlitLeido: string | null;
  fechaDocumento: string | null;
  numeroDocumento: string | null;
  emisor: string | null;
}

/** La fila `aplicado`: lo común a documentar y pagar; `esPago` y `valor` los pone cada camino. */
async function cerrar(tx: Tx, id: string, d: CierreComprobante, pago: { esPago: boolean; valor: string | null }, ctx: ComprobanteCtx): Promise<void> {
  await tx.update(flitoComprobantes).set({
    estado: EstadoComprobante.APLICADO, motivoPendiente: null, detallePendiente: null,
    tramiteId: d.tramiteId, concepto: d.concepto, cruce: d.cruce, esPago: pago.esPago, valor: pago.valor,
    soporteAplicadoId: d.soporteAplicadoId, extraccion: d.extraccion, extraccionDestino: d.extraccionDestino,
    tipoDocumento: d.tipoDocumento, placaLeida: d.placaLeida, vinLeido: d.vinLeido, idFlitLeido: d.idFlitLeido,
    fechaDocumento: d.fechaDocumento, numeroDocumento: d.numeroDocumento, emisor: d.emisor,
    aplicadoAutomaticamente: false, aplicadoPorId: ctx.userId, aplicadoEn: new Date(), aplicadoMotivo: d.motivo,
    updatedAt: new Date(),
  }).where(and(eq(flitoComprobantes.id, id), eq(flitoComprobantes.estado, EstadoComprobante.PENDIENTE)));
}

/**
 * `esPago = false` (D3): la fila queda `aplicado` como DOCUMENTACIÓN del trámite: `es_pago = false`,
 * `valor` NULL (mutante (6): documentar no es pagar), `cruce` el sugerido o `manual`, pareja
 * quién+cuándo y motivo, la extracción confirmada y el soporte que ve el destino.
 */
async function adjuntarDocumentacion(tx: Tx, id: string, d: CierreComprobante, ctx: ComprobanteCtx): Promise<void> {
  await cerrar(tx, id, d, { esPago: false, valor: null }, ctx);
}

/**
 * `esPago = true` (AC5): `es_pago = true` y `valor` como COPIA («valor al aplicar»: lo que el dueño
 * concilió, o lo leído/confirmado). El reporte de costos y la liquidación NO lo leen (F3).
 */
async function cerrarComoPago(tx: Tx, id: string, d: CierreComprobante, valor: string | null, ctx: ComprobanteCtx): Promise<void> {
  await cerrar(tx, id, d, { esPago: true, valor }, ctx);
}

// ─────────────────────────── descartar ───────────────────────────────────────

/**
 * `POST /:id/descartar` (AC6): estado + pareja + motivo. El soporte se marca `descartado = true`
 * (libera el hash para recargar, patrón `flito-revisiones.descartar`) SOLO si ningún otro comprobante
 * no descartado comparte el `soporte_id`: en un consolidado, descartar una página no puede «liberar»
 * el archivo del que las otras siguen vivas.
 */
export async function descartar(id: string, motivo: string, ctx: ComprobanteCtx): Promise<void> {
  const [c] = await db.select({ id: flitoComprobantes.id, estado: flitoComprobantes.estado, soporteId: flitoComprobantes.soporteId })
    .from(flitoComprobantes).where(eq(flitoComprobantes.id, id)).limit(1);
  if (!c) throw noEncontrado();
  if (c.estado !== EstadoComprobante.PENDIENTE) throw yaResuelto();

  await db.transaction(async (tx) => {
    await bloquearComprobantePendiente(tx, id);
    await tx.update(flitoComprobantes).set({
      estado: EstadoComprobante.DESCARTADO, motivoPendiente: null, detallePendiente: null,
      descartadoPorId: ctx.userId, descartadoEn: new Date(), descartadoMotivo: motivo.trim(), updatedAt: new Date(),
    }).where(and(eq(flitoComprobantes.id, id), eq(flitoComprobantes.estado, EstadoComprobante.PENDIENTE)));
    const [vivos] = await tx.select({ n: sql<number>`count(*)::int` }).from(flitoComprobantes)
      .where(and(eq(flitoComprobantes.soporteId, c.soporteId), ne(flitoComprobantes.id, id), ne(flitoComprobantes.estado, EstadoComprobante.DESCARTADO)));
    if ((vivos?.n ?? 0) === 0) {
      await tx.update(flitoSoportes).set({ descartado: true }).where(eq(flitoSoportes.id, c.soporteId));
    }
  });
  log.info({ comprobanteId: id, por: ctx.userId }, 'Comprobante descartado');
}
