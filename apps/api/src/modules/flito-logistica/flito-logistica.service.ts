// FLITO Logística — trazabilidad de la Licencia de Tránsito (LT) y consola de Operaciones.
//
// MODELO (corregido): la consola muestra TODOS los trámites en estado FLIT 'Aprobado' (lo que se
// espera para entrega). La LT NO nace del sync: nace cuando el mensajero ESCANEA el PDF417 del
// reverso de la LT en el organismo. El escaneo se empareja por placa+VIN contra un trámite aprobado
// y crea el documento en 'recogido' (o 'novedad' si el VIN no coincide). El n.º de LT (que no viaja
// en el código) se captura manual. Operaciones valida y, por empresa, cierra el lote → acta con las
// columnas Placa | Secretaría | Propietario | N.º licencia | N.º LT y DOS firmas: entrega (Operaciones,
// en consola, al despachar) y recibe (receptor, en campo). El PDF del acta combina ambas.
// Ojo (§9.7): el 'entregado' de logística ≠ EstadoTramiteFlito.ENTREGADO (compuerta SOAT+Impuestos).

import { and, eq, inArray } from 'drizzle-orm';
import {
  EstadoActaLogistica, EstadoDocumentoLogistica, ESTADO_ACTA_LOGISTICA_LABEL, puedeEntrarEnActa,
  type EstadoDocumentoLogistica as TEstadoDoc,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoLogisticaActas, flitoLogisticaDocumentos, flitoProveedoresLogistica } from '../../db/schema.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { LogisticaError, bufDesdeDataUrl, exigirTramiteResuelto, log, transicionar, type DbOrTx, type LogisticaCtx } from './flito-logistica.base.js';
import { generarActaPdf } from './flito-logistica.acta-pdf.js';

// HU #14108 (ADR-0030 §11): barrel. Los importadores (rutas, soportes, tests) siguen importando este archivo.
export * from './flito-logistica.base.js';
export * from './flito-logistica.escaneo.js';
export * from './flito-logistica.consulta.js';
export * from './flito-logistica.acta-pdf.js';
export * from './flito-logistica.idempotencia.js';

// ── Novedad sobre una LT ya escaneada ────────────────────────────────────────

async function cargarDocumento(exec: DbOrTx, id: string): Promise<{ id: string; estado: string } | undefined> {
  const [d] = await exec.select({ id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado })
    .from(flitoLogisticaDocumentos).where(eq(flitoLogisticaDocumentos.id, id)).limit(1);
  return d;
}

/** Novedad (dañada/inconsistente) sobre una LT ya escaneada. Motivo obligatorio; bloquea (RN-04). */
export async function registrarNovedad(documentoId: string, motivo: string, ctx: LogisticaCtx): Promise<void> {
  const m = motivo?.trim();
  if (!m) throw new LogisticaError('La novedad requiere motivo');
  await db.transaction(async (tx) => {
    const d = await cargarDocumento(tx, documentoId);
    if (!d) throw new LogisticaError('Documento no encontrado', 404);
    await transicionar(tx, d, EstadoDocumentoLogistica.NOVEDAD, ctx, { motivo: m });
  });
}

// ── Actas (cerrar lote, despachar con firma de Operaciones, entregar, devolver) ──

/** Proveedor logístico por defecto (la primera mensajería propia activa), o null. */
async function proveedorPorDefecto(exec: DbOrTx): Promise<string | null> {
  const [prov] = await exec.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
    .where(and(eq(flitoProveedoresLogistica.activo, true), eq(flitoProveedoresLogistica.estrategia, 'pwa_propia')))
    .limit(1);
  return prov?.id ?? null;
}

export interface ResultadoCerrarLote { actaId: string; documentos: number }

/**
 * Cierra el lote de una empresa y genera un acta con sus LT 'clasificado' (CA-04, una por empresa).
 * Entregas parciales SIEMPRE (HU #13936, retira la regla "Solo completo" de CA-08/09): el acta
 * lleva las LT listas y las pendientes (novedad/sin clasificar) siguen en la bandeja para un lote
 * posterior. `clients.logistica_permite_parcial` ya no se lee (columna conservada, sin efecto) y
 * el acta registra `permiteParcial = true`. Sin LT listas → 400; compañía autogestionada → 409.
 */
export async function cerrarLote(companiaId: number, ctx: LogisticaCtx): Promise<ResultadoCerrarLote> {
  const res = await db.transaction(async (tx) => {
    const [compania] = await tx.select({
      id: clients.id, nombre: clients.name,
      autogestionable: clients.logisticaAutogestionable,
      direccion: clients.address, contactoNombre: clients.name, contactoDoc: clients.document,
    }).from(clients).where(eq(clients.id, companiaId)).limit(1);
    if (!compania) throw new LogisticaError('Compañía no encontrada', 404);
    // Parametrización por compañía (RN-05): FLITO no gestiona la logística de compañías autogestionadas.
    if (compania.autogestionable) throw new LogisticaError('La logística de esta compañía es autogestionada por el cliente; FLITO no la gestiona', 409);

    const docs = await tx.select({ id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado })
      .from(flitoLogisticaDocumentos)
      .where(and(
        eq(flitoLogisticaDocumentos.companiaId, companiaId),
        inArray(flitoLogisticaDocumentos.estado, [
          EstadoDocumentoLogistica.RECOGIDO, EstadoDocumentoLogistica.CLASIFICADO,
          EstadoDocumentoLogistica.NOVEDAD, EstadoDocumentoLogistica.DEVUELTO,
        ] as TEstadoDoc[]),
      ));

    const listos = docs.filter((d) => puedeEntrarEnActa(d.estado as TEstadoDoc));
    await exigirTramiteResuelto(tx, listos.map((d) => d.id)); // ADR-0030 §17.2: nunca una LT pendiente en un acta de compañía
    const pendientes = docs.filter((d) => !puedeEntrarEnActa(d.estado as TEstadoDoc));
    if (listos.length === 0) throw new LogisticaError('No hay LT clasificadas para esta empresa', 400, { pendientes: pendientes.length });

    const proveedorId = await proveedorPorDefecto(tx);
    const [acta] = await tx.insert(flitoLogisticaActas).values({
      companiaId, estado: EstadoActaLogistica.GENERADA, permiteParcial: true,
      proveedorLogisticaId: proveedorId,
      direccionEntrega: compania.direccion, contactoNombre: compania.contactoNombre, contactoDocumento: compania.contactoDoc,
    }).returning({ id: flitoLogisticaActas.id });

    for (const d of listos) {
      await tx.update(flitoLogisticaDocumentos).set({ actaId: acta.id, updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, d.id));
      await transicionar(tx, d, EstadoDocumentoLogistica.EN_ACTA, ctx);
    }
    return { actaId: acta.id, documentos: listos.length };
  });
  try { await generarActaPdf(res.actaId); }
  catch (e) { log.warn({ actaId: res.actaId, err: (e as Error).message }, 'no se pudo generar el PDF base del acta'); }
  return res;
}

async function docsDeActa(exec: DbOrTx, actaId: string): Promise<Array<{ id: string; estado: string }>> {
  return exec.select({ id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado })
    .from(flitoLogisticaDocumentos).where(eq(flitoLogisticaDocumentos.actaId, actaId));
}

async function cargarActa(exec: DbOrTx, actaId: string): Promise<{ id: string; estado: string; mensajeroId: number | null }> {
  const [acta] = await exec.select({ id: flitoLogisticaActas.id, estado: flitoLogisticaActas.estado, mensajeroId: flitoLogisticaActas.mensajeroId })
    .from(flitoLogisticaActas).where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!acta) throw new LogisticaError('Acta no encontrada', 404);
  return acta;
}

export interface DespachoInput { mensajeroId: number; firmaEntrega: string; entregaNombre?: string | null }

/**
 * Despacha el acta a un mensajero. Aquí Operaciones firma en consola la ENTREGA (primera de las dos
 * firmas del acta): se guarda su firma + nombre. Las LT pasan a 'despachado' y aparecen en la ruta
 * del mensajero, que en campo recogerá la firma del RECEPTOR (CA-05).
 */
export async function despachar(actaId: string, datos: DespachoInput, ctx: LogisticaCtx): Promise<{ documentos: number }> {
  if (!datos.firmaEntrega?.trim()) throw new LogisticaError('El despacho requiere la firma de quien entrega (Operaciones)');
  const acta0 = await cargarActa(db, actaId);
  if (acta0.estado !== EstadoActaLogistica.GENERADA) throw new LogisticaError(`El acta no se puede despachar en estado "${acta0.estado}"`);

  const firmaKey = await uploadEntityDocument('flito-logistica-firmas-entrega', actaId, 'firma-entrega.png', bufDesdeDataUrl(datos.firmaEntrega), 'image/png');

  const res = await db.transaction(async (tx) => {
    const acta = await cargarActa(tx, actaId);
    if (acta.estado !== EstadoActaLogistica.GENERADA) throw new LogisticaError(`El acta no se puede despachar en estado "${acta.estado}"`);
    await tx.update(flitoLogisticaActas).set({
      estado: EstadoActaLogistica.DESPACHADA, mensajeroId: datos.mensajeroId,
      firmaEntregaStorageKey: firmaKey, entregaNombre: datos.entregaNombre?.trim() || ctx.username,
      updatedAt: new Date(),
    }).where(eq(flitoLogisticaActas.id, actaId));
    const docs = await docsDeActa(tx, actaId);
    for (const d of docs) await transicionar(tx, d, EstadoDocumentoLogistica.DESPACHADO, ctx);
    return { documentos: docs.length };
  });
  try { await generarActaPdf(actaId); }
  catch (e) { log.warn({ actaId, err: (e as Error).message }, 'no se pudo regenerar el PDF del acta tras despacho'); }
  return res;
}

export interface EntregaInput { receptorNombre: string; receptorDocumento: string; firma?: string; foto?: string | null; lat?: string | null; lng?: string | null }

/**
 * Entrega con firma del RECEPTOR (segunda firma del acta). RN-03: ninguna LT pasa a 'entregado' sin
 * firma. El acta queda sellada con firma, nombre/documento del receptor, hora y ubicación (§9.5); el
 * GPS es best-effort (RN-07). CA-11: un mensajero solo entrega sus propias actas. El PDF se regenera
 * con ambas firmas embebidas (entrega + recibe).
 */
export async function entregar(actaId: string, datos: EntregaInput, ctx: LogisticaCtx): Promise<{ documentos: number }> {
  if (!datos.receptorNombre?.trim() || !datos.receptorDocumento?.trim()) throw new LogisticaError('La entrega requiere nombre y documento del receptor (RN-03)');
  if (!datos.firma?.trim()) throw new LogisticaError('La entrega requiere la firma del receptor (RN-03)');

  const acta0 = await cargarActa(db, actaId);
  if (acta0.estado !== EstadoActaLogistica.DESPACHADA) throw new LogisticaError(`El acta no se puede entregar en estado "${acta0.estado}"`);
  if (!ctx.operaAjenas && acta0.mensajeroId !== ctx.userId) throw new LogisticaError('Solo puedes entregar tus propias actas', 403);

  const firmaKey = await uploadEntityDocument('flito-logistica-firmas', actaId, 'firma.png', bufDesdeDataUrl(datos.firma), 'image/png');
  const fotoKey = datos.foto?.trim() ? await uploadEntityDocument('flito-logistica-evidencia', actaId, 'evidencia.jpg', bufDesdeDataUrl(datos.foto), 'image/jpeg') : null;

  const res = await db.transaction(async (tx) => {
    const acta = await cargarActa(tx, actaId);
    if (acta.estado !== EstadoActaLogistica.DESPACHADA) throw new LogisticaError(`El acta no se puede entregar en estado "${acta.estado}"`);
    await tx.update(flitoLogisticaActas).set({
      estado: EstadoActaLogistica.ENTREGADA, receptorNombre: datos.receptorNombre.trim(),
      receptorDocumento: datos.receptorDocumento.trim(), firmaStorageKey: firmaKey, fotoStorageKey: fotoKey,
      entregadoLat: datos.lat ?? null, entregadoLng: datos.lng ?? null, entregadoEn: new Date(), updatedAt: new Date(),
    }).where(eq(flitoLogisticaActas.id, actaId));
    const docs = await docsDeActa(tx, actaId);
    for (const d of docs) await transicionar(tx, d, EstadoDocumentoLogistica.ENTREGADO, ctx, { lat: datos.lat, lng: datos.lng });
    return { documentos: docs.length };
  });
  try { await generarActaPdf(actaId); }
  catch (e) { log.warn({ actaId, err: (e as Error).message }, 'no se pudo regenerar el PDF firmado del acta'); }
  return res;
}

/** Devolución: el receptor no estaba o rechazó (CA-10). Motivo obligatorio; se reprograma. */
export async function registrarDevolucion(actaId: string, motivo: string, ctx: LogisticaCtx): Promise<{ documentos: number }> {
  const m = motivo?.trim();
  if (!m) throw new LogisticaError('La devolución requiere motivo (RN-04)');
  return db.transaction(async (tx) => {
    const acta = await cargarActa(tx, actaId);
    if (acta.estado !== EstadoActaLogistica.DESPACHADA) throw new LogisticaError(`El acta no se puede devolver en estado "${acta.estado}"`);
    if (!ctx.operaAjenas && acta.mensajeroId !== ctx.userId) throw new LogisticaError('Solo puedes registrar devoluciones de tus propias actas', 403);
    await tx.update(flitoLogisticaActas).set({ estado: EstadoActaLogistica.DEVUELTA, motivoDevolucion: m, updatedAt: new Date() }).where(eq(flitoLogisticaActas.id, actaId));
    const docs = await docsDeActa(tx, actaId);
    for (const d of docs) await transicionar(tx, d, EstadoDocumentoLogistica.DEVUELTO, ctx, { motivo: m });
    return { documentos: docs.length };
  });
}

/** Reversa un estado avanzado con justificación (RN-08). Solo Operaciones; desvincula del acta. */
export async function reversar(documentoId: string, estadoDestino: TEstadoDoc, motivo: string, ctx: LogisticaCtx): Promise<void> {
  const m = motivo?.trim();
  if (!m) throw new LogisticaError('La reversa requiere justificación (RN-08)');
  await db.transaction(async (tx) => {
    const d = await cargarDocumento(tx, documentoId);
    if (!d) throw new LogisticaError('Documento no encontrado', 404);
    await tx.update(flitoLogisticaDocumentos).set({ actaId: null, updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, documentoId));
    await transicionar(tx, d, estadoDestino, ctx, { motivo: m, origen: 'usuario' });
  });
}

export { ESTADO_ACTA_LOGISTICA_LABEL };
