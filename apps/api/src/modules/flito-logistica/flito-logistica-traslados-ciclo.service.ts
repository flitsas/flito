// HU #14115 (Feature C2 #14092, Épica #13758, ADR-0030 C2.2 / Q5b) — ciclo del traslado a cliente:
// despachar → entregar (parcial) | devolver; anular en `registrado`; reversa de línea entregada.
// Destino FLIT (C3.4): 422. Liquidación (C2.5): no. Precio congelado: no se borra.
//
// PII: la cédula del receptor se cifra en `acta_firmas` rol `recibe` (`protegerDocumento`, AAD = firmaId).
// No se escribe `receptor_documento` en claro. Operaciones (rol `entrega`) no lleva cédula (N4).

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { EstadoActaLogistica, EstadoDocumentoLogistica, type EstadoDocumentoLogistica as TEstadoDoc } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  flitoLogisticaActaFirmas, flitoLogisticaActas, flitoLogisticaDocumentos,
  flitoLogisticaTrasladoLts, flitoLogisticaTraslados,
} from '../../db/schema.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { bufDesdeDataUrl, log, LogisticaError, transicionar, type DbOrTx, type LogisticaCtx } from './flito-logistica.base.js';
import { generarActaPdf } from './flito-logistica.acta-pdf.js';
import { protegerDocumento } from './flito-logistica.cifrado.js';
import {
  DestinoFlitNoDisponibleError, EntregaSinEntregadasError,
  TrasladoActaNoEncontradaError, TrasladoEstadoNoAdmisibleError, TrasladoLtsNoCoincidenError,
  TrasladoNoEncontradoError,
} from './flito-logistica-traslados.errors.js';

/** El enum TS aún no declara `en_flit`; el de BD sí (0274). */
const EN_FLIT = 'en_flit' as TEstadoDoc;

export interface DespachoTrasladoInput { mensajeroId: number; firmaEntrega?: string | null; entregaNombre?: string | null }

export interface EntregaTrasladoInput {
  receptorNombre: string; receptorDocumento: string; firma?: string;
  foto?: string | null; lat?: string | null; lng?: string | null;
  ltsDevueltas?: string[]; ltsEntregadas?: string[];
}

export interface ResultadoCicloTraslado {
  documentos: number;
  trasladoId: string;
  estado: string;
  entregados?: number;
  devueltos?: number;
  firmaId?: string;
}

interface TrasladoMin {
  id: string; destino: string; origen: string; estado: string; mensajeroId: number | null;
}
interface ActaMin { id: string; estado: string; mensajeroId: number | null }
interface LineaMin { id: string; documentoId: string; estado: string; precio: string | null }

function estadoTrasRegreso(origen: string): TEstadoDoc {
  return origen === 'flit' ? EN_FLIT : EstadoDocumentoLogistica.CLASIFICADO;
}

async function cargarTraslado(exec: DbOrTx, id: string): Promise<TrasladoMin> {
  const [t] = await exec.select({
    id: flitoLogisticaTraslados.id, destino: flitoLogisticaTraslados.destino,
    origen: flitoLogisticaTraslados.origen, estado: flitoLogisticaTraslados.estado,
    mensajeroId: flitoLogisticaTraslados.mensajeroId,
  }).from(flitoLogisticaTraslados).where(eq(flitoLogisticaTraslados.id, id)).limit(1).for('update');
  if (!t) throw new TrasladoNoEncontradoError();
  if (t.destino === 'flit') throw new DestinoFlitNoDisponibleError();
  return t;
}

async function actaDeTraslado(exec: DbOrTx, trasladoId: string): Promise<ActaMin> {
  const [a] = await exec.select({
    id: flitoLogisticaActas.id, estado: flitoLogisticaActas.estado, mensajeroId: flitoLogisticaActas.mensajeroId,
  }).from(flitoLogisticaActas).where(eq(flitoLogisticaActas.trasladoId, trasladoId)).limit(1);
  if (!a) throw new TrasladoActaNoEncontradaError();
  return a;
}

async function lineasDe(exec: DbOrTx, trasladoId: string): Promise<LineaMin[]> {
  return exec.select({
    id: flitoLogisticaTrasladoLts.id, documentoId: flitoLogisticaTrasladoLts.documentoId,
    estado: flitoLogisticaTrasladoLts.estado, precio: flitoLogisticaTrasladoLts.precio,
  }).from(flitoLogisticaTrasladoLts).where(eq(flitoLogisticaTrasladoLts.trasladoId, trasladoId))
    .orderBy(flitoLogisticaTrasladoLts.documentoId).for('update');
}

async function docsDe(exec: DbOrTx, ids: string[]): Promise<Array<{ id: string; estado: string }>> {
  if (!ids.length) return [];
  return exec.select({ id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado })
    .from(flitoLogisticaDocumentos).where(inArray(flitoLogisticaDocumentos.id, ids))
    .orderBy(flitoLogisticaDocumentos.id).for('update');
}

async function desvincularActa(exec: DbOrTx, documentoIds: string[]): Promise<void> {
  if (!documentoIds.length) return;
  await exec.update(flitoLogisticaDocumentos)
    .set({ actaId: null, updatedAt: new Date() })
    .where(inArray(flitoLogisticaDocumentos.id, documentoIds));
}

function exigirPropia(ctx: LogisticaCtx, mensajeroId: number | null, accion: string): void {
  if (!ctx.operaAjenas && mensajeroId !== ctx.userId) {
    throw new LogisticaError(`Solo puedes ${accion} tus propios viajes`, 403);
  }
}

async function regenerarPdf(actaId: string, que: string): Promise<void> {
  try { await generarActaPdf(actaId); }
  catch (e) { log.warn({ actaId, err: (e as Error).message }, `no se pudo regenerar el PDF del acta tras ${que}`); }
}

/**
 * `registrado` → `en_ruta`. Firma de Operaciones opcional (sin cédula). Reusa el permiso
 * `logistica.actas.despachar`.
 */
export async function despacharTraslado(
  trasladoId: string, datos: DespachoTrasladoInput, ctx: LogisticaCtx,
): Promise<ResultadoCicloTraslado> {
  const firma = datos.firmaEntrega?.trim();
  const firmaKey = firma
    ? await uploadEntityDocument('flito-logistica-firmas-entrega', trasladoId, 'firma-entrega.png', bufDesdeDataUrl(firma), 'image/png')
    : null;
  const res = await db.transaction(async (tx) => {
    const t = await cargarTraslado(tx, trasladoId);
    if (t.estado !== 'registrado') throw new TrasladoEstadoNoAdmisibleError(t.estado, 'despachar');
    const acta = await actaDeTraslado(tx, t.id);
    const lineas = await lineasDe(tx, t.id);
    const docs = await docsDe(tx, lineas.map((l) => l.documentoId));
    const ahora = new Date();
    const nombre = datos.entregaNombre?.trim() || ctx.username;
    if (firmaKey) {
      await tx.insert(flitoLogisticaActaFirmas).values({
        id: randomUUID(), actaId: acta.id, rol: 'entrega', nombre,
        documentoCifrado: null, documentoUltimos: null, firmaStorageKey: firmaKey, usuarioId: ctx.userId,
      });
    }
    await tx.update(flitoLogisticaActas).set({
      estado: EstadoActaLogistica.DESPACHADA, mensajeroId: datos.mensajeroId,
      firmaEntregaStorageKey: firmaKey, entregaNombre: nombre, updatedAt: ahora,
    }).where(eq(flitoLogisticaActas.id, acta.id));
    await tx.update(flitoLogisticaTraslados).set({
      estado: 'en_ruta', mensajeroId: datos.mensajeroId, updatedAt: ahora,
    }).where(eq(flitoLogisticaTraslados.id, t.id));
    if (lineas.length) {
      await tx.update(flitoLogisticaTrasladoLts).set({ estado: 'en_ruta' })
        .where(and(eq(flitoLogisticaTrasladoLts.trasladoId, t.id), eq(flitoLogisticaTrasladoLts.estado, 'registrado')));
    }
    for (const d of docs) {
      await transicionar(tx, d, EstadoDocumentoLogistica.DESPACHADO, ctx, {
        tipo: 'despachado', trasladoId: t.id, actaId: acta.id, destino: t.destino,
        payload: { trasladoId: t.id, actaId: acta.id },
      });
    }
    return { documentos: docs.length, trasladoId: t.id, estado: 'en_ruta' as const, actaId: acta.id };
  });
  await regenerarPdf(res.actaId, 'despacho');
  return { documentos: res.documentos, trasladoId: res.trasladoId, estado: res.estado };
}

function partirLineas(
  lineas: LineaMin[], input: EntregaTrasladoInput,
): { entregadas: LineaMin[]; devueltas: LineaMin[] } {
  const enRuta = lineas.filter((l) => l.estado === 'en_ruta');
  const idsRuta = new Set(enRuta.map((l) => l.documentoId));
  const devIds = new Set(input.ltsDevueltas ?? []);
  const entIds = input.ltsEntregadas ? new Set(input.ltsEntregadas) : null;
  if ([...devIds].some((id) => !idsRuta.has(id))) throw new TrasladoLtsNoCoincidenError();
  if (entIds && [...entIds].some((id) => !idsRuta.has(id))) throw new TrasladoLtsNoCoincidenError();
  if (entIds && [...devIds].some((id) => entIds.has(id))) throw new TrasladoLtsNoCoincidenError();
  if (entIds) {
    const cubiertos = new Set([...entIds, ...devIds]);
    if (cubiertos.size !== idsRuta.size) throw new TrasladoLtsNoCoincidenError();
    return {
      entregadas: enRuta.filter((l) => entIds.has(l.documentoId)),
      devueltas: enRuta.filter((l) => devIds.has(l.documentoId)),
    };
  }
  return {
    entregadas: enRuta.filter((l) => !devIds.has(l.documentoId)),
    devueltas: enRuta.filter((l) => devIds.has(l.documentoId)),
  };
}

/**
 * `en_ruta` → `entregado` (si ≥1 línea entregada) o se rechaza si no hay entregadas.
 * Cada línea: `entregado` (cobra, C2.5) o `devuelto` (no cobra; LT vuelve a clasificado/en_flit).
 * Cédula del receptor: cifrada; no se escribe en claro en el acta.
 */
export async function entregarTraslado(
  trasladoId: string, datos: EntregaTrasladoInput, ctx: LogisticaCtx,
): Promise<ResultadoCicloTraslado> {
  if (!datos.receptorNombre?.trim() || !datos.receptorDocumento?.trim()) {
    throw new LogisticaError('La entrega requiere nombre y documento del receptor (RN-03)');
  }
  if (!datos.firma?.trim()) throw new LogisticaError('La entrega requiere la firma del receptor (RN-03)');

  const firmaKey = await uploadEntityDocument(
    'flito-logistica-firmas', trasladoId, 'firma.png', bufDesdeDataUrl(datos.firma), 'image/png',
  );
  const fotoKey = datos.foto?.trim()
    ? await uploadEntityDocument('flito-logistica-evidencia', trasladoId, 'evidencia.jpg', bufDesdeDataUrl(datos.foto), 'image/jpeg')
    : null;

  const res = await db.transaction(async (tx) => {
    const t = await cargarTraslado(tx, trasladoId);
    if (t.estado !== 'en_ruta') throw new TrasladoEstadoNoAdmisibleError(t.estado, 'entregar');
    const acta = await actaDeTraslado(tx, t.id);
    exigirPropia(ctx, t.mensajeroId ?? acta.mensajeroId, 'entregar');
    const lineas = await lineasDe(tx, t.id);
    const { entregadas, devueltas } = partirLineas(lineas, datos);
    if (entregadas.length === 0) throw new EntregaSinEntregadasError();
    const docs = await docsDe(tx, lineas.map((l) => l.documentoId));
    const porId = new Map(docs.map((d) => [d.id, d]));
    const ahora = new Date();
    const firmaId = randomUUID();
    const prot = protegerDocumento(datos.receptorDocumento, firmaId);
    await tx.insert(flitoLogisticaActaFirmas).values({
      id: firmaId, actaId: acta.id, rol: 'recibe', nombre: datos.receptorNombre.trim(),
      documentoCifrado: prot.cifrado, documentoUltimos: prot.ultimos, firmaStorageKey: firmaKey,
      lat: datos.lat ?? null, lng: datos.lng ?? null,
    });
    const estadoTraslado = 'entregado';
    await tx.update(flitoLogisticaActas).set({
      estado: EstadoActaLogistica.ENTREGADA, receptorNombre: datos.receptorNombre.trim(),
      firmaStorageKey: firmaKey, fotoStorageKey: fotoKey,
      entregadoLat: datos.lat ?? null, entregadoLng: datos.lng ?? null, entregadoEn: ahora, updatedAt: ahora,
    }).where(eq(flitoLogisticaActas.id, acta.id));
    await tx.update(flitoLogisticaTraslados).set({ estado: estadoTraslado, updatedAt: ahora })
      .where(eq(flitoLogisticaTraslados.id, t.id));
    if (entregadas.length) {
      await tx.update(flitoLogisticaTrasladoLts).set({ estado: 'entregado' })
        .where(inArray(flitoLogisticaTrasladoLts.id, entregadas.map((l) => l.id)));
    }
    if (devueltas.length) {
      await tx.update(flitoLogisticaTrasladoLts).set({ estado: 'devuelto' })
        .where(inArray(flitoLogisticaTrasladoLts.id, devueltas.map((l) => l.id)));
    }
    for (const l of entregadas) {
      const d = porId.get(l.documentoId);
      if (d) {
        await transicionar(tx, d, EstadoDocumentoLogistica.ENTREGADO, ctx, {
          tipo: 'entregado', trasladoId: t.id, actaId: acta.id, destino: t.destino,
          lat: datos.lat, lng: datos.lng, payload: { trasladoId: t.id, actaId: acta.id },
        });
      }
    }
    const idsDev = devueltas.map((l) => l.documentoId);
    await desvincularActa(tx, idsDev);
    const destDev = estadoTrasRegreso(t.origen);
    for (const l of devueltas) {
      const d = porId.get(l.documentoId);
      if (d) {
        await transicionar(tx, d, destDev, ctx, {
          tipo: 'devuelto', trasladoId: t.id, actaId: acta.id, destino: t.destino,
          payload: { trasladoId: t.id, actaId: acta.id, linea: 'devuelto' },
        });
      }
    }
    return {
      documentos: docs.length, trasladoId: t.id, estado: estadoTraslado, actaId: acta.id,
      entregados: entregadas.length, devueltos: devueltas.length, firmaId,
    };
  });
  await regenerarPdf(res.actaId, 'entrega');
  const { actaId: _a, ...out } = res;
  return out;
}

/** Devolución de TODO el viaje en ruta. LT vuelve a clasificado / en_flit. Precio intacto. */
export async function devolverTraslado(
  trasladoId: string, motivo: string, ctx: LogisticaCtx,
): Promise<ResultadoCicloTraslado> {
  const m = motivo?.trim();
  if (!m) throw new LogisticaError('La devolución requiere motivo (RN-04)');
  return db.transaction(async (tx) => {
    const t = await cargarTraslado(tx, trasladoId);
    if (t.estado !== 'en_ruta') throw new TrasladoEstadoNoAdmisibleError(t.estado, 'devolver');
    const acta = await actaDeTraslado(tx, t.id);
    exigirPropia(ctx, t.mensajeroId ?? acta.mensajeroId, 'registrar devoluciones de');
    const lineas = await lineasDe(tx, t.id);
    const enRuta = lineas.filter((l) => l.estado === 'en_ruta');
    const docs = await docsDe(tx, enRuta.map((l) => l.documentoId));
    const ahora = new Date();
    await tx.update(flitoLogisticaActas).set({
      estado: EstadoActaLogistica.DEVUELTA, motivoDevolucion: m, updatedAt: ahora,
    }).where(eq(flitoLogisticaActas.id, acta.id));
    await tx.update(flitoLogisticaTraslados).set({ estado: 'devuelto', updatedAt: ahora })
      .where(eq(flitoLogisticaTraslados.id, t.id));
    if (enRuta.length) {
      await tx.update(flitoLogisticaTrasladoLts).set({ estado: 'devuelto' })
        .where(inArray(flitoLogisticaTrasladoLts.id, enRuta.map((l) => l.id)));
    }
    await desvincularActa(tx, docs.map((d) => d.id));
    const dest = estadoTrasRegreso(t.origen);
    for (const d of docs) {
      await transicionar(tx, d, dest, ctx, {
        tipo: 'devuelto', motivo: m, trasladoId: t.id, actaId: acta.id, destino: t.destino,
        payload: { trasladoId: t.id, actaId: acta.id },
      });
    }
    return { documentos: docs.length, trasladoId: t.id, estado: 'devuelto', devueltos: docs.length };
  });
}

/** Solo `registrado` → `anulado`. Línea `anulado`, precio intacto, LT a clasificado/en_flit. */
export async function anularTraslado(
  trasladoId: string, motivo: string, ctx: LogisticaCtx,
): Promise<ResultadoCicloTraslado> {
  const m = motivo?.trim();
  if (!m) throw new LogisticaError('La anulación requiere motivo');
  return db.transaction(async (tx) => {
    const t = await cargarTraslado(tx, trasladoId);
    if (t.estado !== 'registrado') throw new TrasladoEstadoNoAdmisibleError(t.estado, 'anular');
    const acta = await actaDeTraslado(tx, t.id);
    const lineas = await lineasDe(tx, t.id);
    const docs = await docsDe(tx, lineas.map((l) => l.documentoId));
    const ahora = new Date();
    await tx.update(flitoLogisticaTraslados).set({ estado: 'anulado', updatedAt: ahora })
      .where(eq(flitoLogisticaTraslados.id, t.id));
    if (lineas.length) {
      await tx.update(flitoLogisticaTrasladoLts).set({ estado: 'anulado' })
        .where(eq(flitoLogisticaTrasladoLts.trasladoId, t.id));
    }
    await desvincularActa(tx, docs.map((d) => d.id));
    const dest = estadoTrasRegreso(t.origen);
    for (const d of docs) {
      await transicionar(tx, d, dest, ctx, {
        tipo: 'anulado', motivo: m, trasladoId: t.id, actaId: acta.id, destino: t.destino,
        payload: { trasladoId: t.id, actaId: acta.id },
      });
    }
    return { documentos: docs.length, trasladoId: t.id, estado: 'anulado' };
  });
}

/**
 * Si la LT tiene una línea `entregado` viva, la pasa a `anulado` (precio intacto) y deja evento
 * tipificado `reversa`. El destino del documento lo elige el caller (contrato vigente de `reversar`).
 */
export async function anularLineaEntregadaSiHay(
  exec: DbOrTx, documentoId: string, ctx: LogisticaCtx, motivo: string, estadoDestino: TEstadoDoc,
): Promise<boolean> {
  const [linea] = await exec.select({
    id: flitoLogisticaTrasladoLts.id, trasladoId: flitoLogisticaTrasladoLts.trasladoId,
    estado: flitoLogisticaTrasladoLts.estado, precio: flitoLogisticaTrasladoLts.precio,
  }).from(flitoLogisticaTrasladoLts)
    .where(and(
      eq(flitoLogisticaTrasladoLts.documentoId, documentoId),
      eq(flitoLogisticaTrasladoLts.estado, 'entregado'),
    )).limit(1).for('update');
  if (!linea) return false;
  await exec.update(flitoLogisticaTrasladoLts).set({ estado: 'anulado' })
    .where(eq(flitoLogisticaTrasladoLts.id, linea.id));
  const [d] = await exec.select({ id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado })
    .from(flitoLogisticaDocumentos).where(eq(flitoLogisticaDocumentos.id, documentoId)).limit(1);
  if (d) {
    await transicionar(exec, d, estadoDestino, ctx, {
      tipo: 'reversa', motivo, origen: 'usuario', trasladoId: linea.trasladoId,
      payload: { trasladoId: linea.trasladoId, lineaId: linea.id },
    });
  }
  return true;
}

/** Resolución AC8: acta de cliente con `trasladoId` → el ciclo corre sobre el traslado. */
export async function trasladoIdDeActaCliente(exec: DbOrTx, actaId: string): Promise<string | null> {
  const [a] = await exec.select({
    id: flitoLogisticaActas.id, punto: flitoLogisticaActas.punto, trasladoId: flitoLogisticaActas.trasladoId,
  }).from(flitoLogisticaActas).where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!a) throw new LogisticaError('Acta no encontrada', 404);
  return a.punto === 'cliente' && a.trasladoId ? a.trasladoId : null;
}
