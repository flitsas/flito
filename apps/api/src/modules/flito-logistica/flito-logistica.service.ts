// FLITO Logística (Fase 1) — trazabilidad del documento físico y consola de Operaciones.
//
// La unidad es el DOCUMENTO individual (RN-01); actas y rutas son agrupaciones sobre él. El alta de
// documentos la dispara el sync de FLIT cuando el trámite llega a 'Aprobado' (registrarDocumentosDesdeFlit).
// El ciclo Generado→Recogido→Clasificado→En acta→Despachado→Entregado (+ Novedad/Devuelto) se gobierna
// aquí. Cada transición deja un evento (CA-07: actor, hora, ubicación). Ojo con el vocabulario (§9.7):
// el 'entregado' de logística ≠ EstadoTramiteFlito.ENTREGADO (compuerta SOAT+Impuestos).

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  EstadoActaLogistica, EstadoDocumentoLogistica, ESTADO_ACTA_LOGISTICA_LABEL,
  ESTADO_DOCUMENTO_LOGISTICA_LABEL, TIPO_DOCUMENTO_LOGISTICA_LABEL, puedeEntrarEnActa,
  type EstadoDocumentoLogistica as TEstadoDoc, type TipoDocumentoLogistica,
} from '@operaciones/shared-types';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { db } from '../../db/client.js';
import {
  clients, flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaEventos, flitoProveedoresLogistica,
  flitoTramites, organismosTransitoConfig, users, vehicles,
} from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { presignedGetEntityDocument, uploadEntityDocument } from '../../services/storage.js';

const log = loggerFor('flito-logistica');

export interface LogisticaCtx { userId: number; username: string; role: string }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

/** Error de negocio con estado HTTP sugerido (lo traduce la ruta). */
export class LogisticaError extends Error {
  constructor(message: string, readonly status = 400, readonly extra?: unknown) { super(message); }
}

// ── Alta desde el sync de FLIT ──────────────────────────────────────────────

export interface DocumentoGeneradoInput { tipo: TipoDocumentoLogistica; identificador?: string | null; raw?: unknown }

/**
 * Registra los documentos que el organismo emitió para un trámite (estado 'generado'). La invoca el
 * sync cuando el trámite pasa a 'Aprobado'. RN-05: si la compañía autogestiona logística, no entran.
 * Idempotente: un documento físico por (trámite, tipo) — una re-sincronización no duplica (RN-06).
 * Devuelve cuántos documentos NUEVOS se crearon.
 */
export async function registrarDocumentosDesdeFlit(
  exec: DbOrTx,
  args: {
    tramiteId: string; organismoCodigo: string; companiaId: number | null; companiaNit: string | null;
    vehiculoId: number; logisticaAutogestionable: boolean; documentos: DocumentoGeneradoInput[];
  },
): Promise<number> {
  if (args.logisticaAutogestionable) return 0; // RN-05
  let creados = 0;
  for (const doc of args.documentos) {
    const [creado] = await exec.insert(flitoLogisticaDocumentos).values({
      tramiteId: args.tramiteId, tipo: doc.tipo, estado: EstadoDocumentoLogistica.GENERADO,
      organismoCodigo: args.organismoCodigo, companiaId: args.companiaId, companiaNit: args.companiaNit,
      vehiculoId: args.vehiculoId, identificador: doc.identificador ?? null, flitRaw: doc.raw ?? null,
    }).onConflictDoNothing({ target: [flitoLogisticaDocumentos.tramiteId, flitoLogisticaDocumentos.tipo] })
      .returning({ id: flitoLogisticaDocumentos.id });
    if (creado) {
      creados += 1;
      await exec.insert(flitoLogisticaEventos).values({
        documentoId: creado.id, estadoAnterior: null, estadoNuevo: EstadoDocumentoLogistica.GENERADO,
        actorId: null, origen: 'api',
      });
    }
  }
  return creados;
}

// ── Transición genérica (deja evento; sostiene CA-07/RN-04/RN-07) ────────────

interface DocMin { id: string; estado: string }
interface TransOpts { motivo?: string | null; lat?: string | null; lng?: string | null; origen?: 'api' | 'usuario' }

async function transicionar(exec: DbOrTx, doc: DocMin, estadoNuevo: TEstadoDoc, ctx: LogisticaCtx, opts: TransOpts = {}): Promise<void> {
  const set: Record<string, unknown> = { estado: estadoNuevo, updatedAt: new Date() };
  if (opts.motivo !== undefined) set.motivo = opts.motivo;
  await exec.update(flitoLogisticaDocumentos).set(set).where(eq(flitoLogisticaDocumentos.id, doc.id));
  await exec.insert(flitoLogisticaEventos).values({
    documentoId: doc.id, estadoAnterior: doc.estado, estadoNuevo, actorId: ctx.userId,
    lat: opts.lat ?? null, lng: opts.lng ?? null, motivo: opts.motivo ?? null, origen: opts.origen ?? 'usuario',
  });
}

// ── Listado y trazabilidad (consola de Operaciones, CA-07) ───────────────────

export interface DocumentoFila {
  id: string; tramiteId: string; idFlit: string;
  tipo: string; tipoLabel: string; estado: string; estadoLabel: string;
  organismoCodigo: string; organismoNombre: string | null;
  companiaId: number | null; companiaNombre: string | null; companiaNit: string | null;
  placa: string | null; vin: string | null; identificador: string | null;
  actaId: string | null; motivo: string | null; creadoEn: string; actualizadoEn: string;
}
export interface FiltrosLogistica {
  buscar?: string; estados?: string[]; tipos?: string[]; empresas?: string[]; organismos?: string[];
  actas?: string[]; page?: number; pageSize?: number;
}
export interface ListadoLogistica { items: DocumentoFila[]; total: number; page: number; pageSize: number }

function proyeccion() {
  return db.select({
    id: flitoLogisticaDocumentos.id,
    tramiteId: flitoLogisticaDocumentos.tramiteId,
    idFlit: flitoTramites.idFlit,
    tipo: flitoLogisticaDocumentos.tipo,
    estado: flitoLogisticaDocumentos.estado,
    organismoCodigo: flitoLogisticaDocumentos.organismoCodigo,
    organismoNombre: organismosTransitoConfig.alias,
    companiaId: flitoLogisticaDocumentos.companiaId,
    companiaNombre: clients.name,
    companiaNit: flitoLogisticaDocumentos.companiaNit,
    placa: vehicles.plate,
    vin: vehicles.vin,
    identificador: flitoLogisticaDocumentos.identificador,
    actaId: flitoLogisticaDocumentos.actaId,
    motivo: flitoLogisticaDocumentos.motivo,
    creadoEn: flitoLogisticaDocumentos.createdAt,
    actualizadoEn: flitoLogisticaDocumentos.updatedAt,
  }).from(flitoLogisticaDocumentos)
    .innerJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoLogisticaDocumentos.companiaId, clients.id))
    .leftJoin(organismosTransitoConfig, eq(flitoLogisticaDocumentos.organismoCodigo, organismosTransitoConfig.codigo));
}
type FilaCruda = Awaited<ReturnType<ReturnType<typeof proyeccion>['where']>>[number];

function construirCondiciones(f: FiltrosLogistica): SQL[] {
  const conds: SQL[] = [];
  const termino = f.buscar?.trim();
  if (termino) {
    const patron = `%${termino.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${termino.toUpperCase()}%`;
    conds.push(or(
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
      sql`UPPER(COALESCE(${flitoLogisticaDocumentos.identificador}, '')) LIKE ${patron}`,
    )!);
  }
  if (f.estados?.length) conds.push(inArray(flitoLogisticaDocumentos.estado, f.estados as TEstadoDoc[]));
  if (f.tipos?.length) conds.push(inArray(flitoLogisticaDocumentos.tipo, f.tipos as Array<(typeof flitoLogisticaDocumentos.tipo.enumValues)[number]>));
  if (f.empresas?.length) conds.push(inArray(flitoLogisticaDocumentos.companiaNit, f.empresas));
  if (f.organismos?.length) conds.push(inArray(flitoLogisticaDocumentos.organismoCodigo, f.organismos));
  if (f.actas?.length) conds.push(inArray(flitoLogisticaDocumentos.actaId, f.actas));
  return conds;
}

function aFila(f: FilaCruda): DocumentoFila {
  return {
    id: f.id, tramiteId: f.tramiteId, idFlit: f.idFlit,
    tipo: f.tipo, tipoLabel: TIPO_DOCUMENTO_LOGISTICA_LABEL[f.tipo as TipoDocumentoLogistica] ?? f.tipo,
    estado: f.estado, estadoLabel: ESTADO_DOCUMENTO_LOGISTICA_LABEL[f.estado as TEstadoDoc] ?? f.estado,
    organismoCodigo: f.organismoCodigo, organismoNombre: f.organismoNombre,
    companiaId: f.companiaId, companiaNombre: f.companiaNombre, companiaNit: f.companiaNit,
    placa: f.placa, vin: f.vin, identificador: f.identificador,
    actaId: f.actaId, motivo: f.motivo,
    creadoEn: f.creadoEn.toISOString(), actualizadoEn: f.actualizadoEn.toISOString(),
  };
}

export async function listar(filtros: FiltrosLogistica = {}): Promise<ListadoLogistica> {
  const page = Math.max(1, Math.floor(filtros.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(filtros.pageSize ?? 50)));
  const conds = construirCondiciones(filtros);

  const countRows = await db.select({ total: sql<number>`count(*)::int` })
    .from(flitoLogisticaDocumentos)
    .innerJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .where(conds.length ? and(...conds) : undefined);
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await proyeccion().where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(flitoLogisticaDocumentos.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  return { items: rows.map(aFila), total, page, pageSize };
}

export interface EventoDocumento {
  id: string; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null;
  lat: string | null; lng: string | null; motivo: string | null; origen: string; creadoEn: string;
}
/** Bitácora completa de un documento (CA-07): cada transición con actor, hora y ubicación. */
export async function eventos(documentoId: string): Promise<EventoDocumento[]> {
  const rows = await db.select({
    id: flitoLogisticaEventos.id, estadoAnterior: flitoLogisticaEventos.estadoAnterior,
    estadoNuevo: flitoLogisticaEventos.estadoNuevo, actorNombre: users.name,
    lat: flitoLogisticaEventos.lat, lng: flitoLogisticaEventos.lng, motivo: flitoLogisticaEventos.motivo,
    origen: flitoLogisticaEventos.origen, creadoEn: flitoLogisticaEventos.createdAt,
  }).from(flitoLogisticaEventos)
    .leftJoin(users, eq(flitoLogisticaEventos.actorId, users.id))
    .where(eq(flitoLogisticaEventos.documentoId, documentoId))
    .orderBy(desc(flitoLogisticaEventos.createdAt));
  return rows.map((r) => ({ ...r, creadoEn: r.creadoEn.toISOString() }));
}

export interface DocumentoDetalle extends DocumentoFila { eventos: EventoDocumento[] }
export async function documentoDetalle(id: string): Promise<DocumentoDetalle> {
  const [row] = await proyeccion().where(eq(flitoLogisticaDocumentos.id, id)).limit(1);
  if (!row) throw new LogisticaError('Documento no encontrado', 404);
  return { ...aFila(row), eventos: await eventos(id) };
}

// ── Acciones de campo (recogida, novedad) ────────────────────────────────────

async function cargarDocumentos(exec: DbOrTx, ids: string[]): Promise<Array<{ id: string; estado: string; tramiteId: string }>> {
  if (ids.length === 0) return [];
  return exec.select({ id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado, tramiteId: flitoLogisticaDocumentos.tramiteId })
    .from(flitoLogisticaDocumentos).where(inArray(flitoLogisticaDocumentos.id, ids));
}

export interface ResultadoRecogida { recogidos: number; clasificados: number; omitidos: number }

/**
 * Verifica la recogida en campo: los documentos 'generado' pasan a 'recogido' y, al sincronizar, se
 * clasifican automáticamente asignando su empresa destino desde el trámite (CA-03, sin Excel). Los
 * faltantes se reportan por separado con registrarNovedad (CA-02). Registra ubicación si se provee (RN-07).
 */
export async function recoger(documentoIds: string[], evidencia: { lat?: string | null; lng?: string | null }, ctx: LogisticaCtx): Promise<ResultadoRecogida> {
  return db.transaction(async (tx) => {
    const docs = await cargarDocumentos(tx, documentoIds);
    let recogidos = 0; let clasificados = 0; let omitidos = 0;
    for (const d of docs) {
      if (d.estado !== EstadoDocumentoLogistica.GENERADO) { omitidos += 1; continue; }
      await transicionar(tx, d, EstadoDocumentoLogistica.RECOGIDO, ctx, { lat: evidencia.lat, lng: evidencia.lng });
      recogidos += 1;
      // Clasificación automática: la empresa destino ya existe en el trámite (CA-03).
      const [tramite] = await tx.select({ companiaId: flitoTramites.companiaId, companiaNit: flitoTramites.companiaNit })
        .from(flitoTramites).where(eq(flitoTramites.id, d.tramiteId)).limit(1);
      if (tramite?.companiaId) {
        await tx.update(flitoLogisticaDocumentos).set({ companiaId: tramite.companiaId, companiaNit: tramite.companiaNit }).where(eq(flitoLogisticaDocumentos.id, d.id));
        await transicionar(tx, { id: d.id, estado: EstadoDocumentoLogistica.RECOGIDO }, EstadoDocumentoLogistica.CLASIFICADO, ctx, { origen: 'api' });
        clasificados += 1;
      }
    }
    return { recogidos, clasificados, omitidos };
  });
}

/** Novedad (faltante/dañado/inconsistente). Motivo obligatorio; bloquea el avance (RN-04, CA-02). */
export async function registrarNovedad(documentoId: string, motivo: string, ctx: LogisticaCtx): Promise<void> {
  const m = motivo?.trim();
  if (!m) throw new LogisticaError('La novedad requiere motivo');
  await db.transaction(async (tx) => {
    const [d] = await cargarDocumentos(tx, [documentoId]);
    if (!d) throw new LogisticaError('Documento no encontrado', 404);
    await transicionar(tx, d, EstadoDocumentoLogistica.NOVEDAD, ctx, { motivo: m });
  });
}

// ── Actas (cerrar lote, despachar, entregar, devolver) ───────────────────────

/** Proveedor logístico por defecto (Fase 1: la primera mensajería propia activa), o null si no hay. */
async function proveedorPorDefecto(exec: DbOrTx): Promise<string | null> {
  const [prov] = await exec.select({ id: flitoProveedoresLogistica.id }).from(flitoProveedoresLogistica)
    .where(and(eq(flitoProveedoresLogistica.activo, true), eq(flitoProveedoresLogistica.estrategia, 'pwa_propia')))
    .limit(1);
  return prov?.id ?? null;
}

export interface ResultadoCerrarLote { actaId: string; documentos: number }

/**
 * Cierra el lote de una empresa y genera un acta con sus documentos 'clasificado' (CA-04, una por
 * empresa). Respeta la parametrización de entregas parciales (CA-08/09): si la compañía es "Solo
 * completo" y quedan documentos pendientes (no clasificados), no se genera y se informa qué falta.
 */
export async function cerrarLote(companiaId: number, ctx: LogisticaCtx): Promise<ResultadoCerrarLote> {
  const res = await db.transaction(async (tx) => {
    const [compania] = await tx.select({
      id: clients.id, nombre: clients.name, permiteParcial: clients.logisticaPermiteParcial,
      direccion: clients.address, contactoNombre: clients.name, contactoDoc: clients.document,
    }).from(clients).where(eq(clients.id, companiaId)).limit(1);
    if (!compania) throw new LogisticaError('Compañía no encontrada', 404);

    // Documentos de esta empresa aún no despachados (excluye terminales y ya en acta).
    const docs = await tx.select({ id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado })
      .from(flitoLogisticaDocumentos)
      .where(and(
        eq(flitoLogisticaDocumentos.companiaId, companiaId),
        inArray(flitoLogisticaDocumentos.estado, [
          EstadoDocumentoLogistica.GENERADO, EstadoDocumentoLogistica.RECOGIDO,
          EstadoDocumentoLogistica.CLASIFICADO, EstadoDocumentoLogistica.NOVEDAD,
          EstadoDocumentoLogistica.DEVUELTO,
        ] as TEstadoDoc[]),
      ));

    const listos = docs.filter((d) => puedeEntrarEnActa(d.estado as TEstadoDoc));
    const pendientes = docs.filter((d) => !puedeEntrarEnActa(d.estado as TEstadoDoc));
    if (listos.length === 0) throw new LogisticaError('No hay documentos clasificados para esta empresa', 400, { pendientes: pendientes.length });
    // CA-09: "Solo completo" no genera si hay pendientes; informa cuántos faltan.
    if (!compania.permiteParcial && pendientes.length > 0) {
      throw new LogisticaError(`La compañía es "Solo completo": faltan ${pendientes.length} documento(s) por clasificar`, 409, { faltantes: pendientes.length, disponibles: listos.length });
    }

    // Enruta a un proveedor logístico (Fase 1: mensajería propia por defecto, §6).
    const proveedorId = await proveedorPorDefecto(tx);
    const [acta] = await tx.insert(flitoLogisticaActas).values({
      companiaId, estado: EstadoActaLogistica.GENERADA, permiteParcial: compania.permiteParcial,
      proveedorLogisticaId: proveedorId,
      direccionEntrega: compania.direccion, contactoNombre: compania.contactoNombre, contactoDocumento: compania.contactoDoc,
    }).returning({ id: flitoLogisticaActas.id });

    for (const d of listos) {
      await tx.update(flitoLogisticaDocumentos).set({ actaId: acta.id, updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, d.id));
      await transicionar(tx, d, EstadoDocumentoLogistica.EN_ACTA, ctx);
    }
    return { actaId: acta.id, documentos: listos.length };
  });
  // PDF BASE del acta, fuera de la transacción (best-effort; no rompe el cierre si storage falla).
  // El PDF FIRMADO (con firma + evidencia del receptor) es de la Fase 2 (PWA).
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

/** Despacha el acta a un mensajero: los documentos pasan a 'despachado' y aparecen en su ruta (CA-05). */
export async function despachar(actaId: string, mensajeroId: number, ctx: LogisticaCtx): Promise<{ documentos: number }> {
  return db.transaction(async (tx) => {
    const acta = await cargarActa(tx, actaId);
    if (acta.estado !== EstadoActaLogistica.GENERADA) throw new LogisticaError(`El acta no se puede despachar en estado "${acta.estado}"`);
    await tx.update(flitoLogisticaActas).set({ estado: EstadoActaLogistica.DESPACHADA, mensajeroId, updatedAt: new Date() }).where(eq(flitoLogisticaActas.id, actaId));
    const docs = await docsDeActa(tx, actaId);
    for (const d of docs) await transicionar(tx, d, EstadoDocumentoLogistica.DESPACHADO, ctx);
    return { documentos: docs.length };
  });
}

export interface EntregaInput { receptorNombre: string; receptorDocumento: string; lat?: string | null; lng?: string | null }

/**
 * Entrega con recepción. RN-03: ningún documento pasa a 'entregado' sin identidad del receptor. En la
 * Fase 1 (consola) se registra la recepción; la firma digital + evidencia estructurada (foto/GPS) y el
 * cierre en el momento son de la Fase 2 (PWA). CA-11: un mensajero solo entrega sus propias actas.
 */
export async function entregar(actaId: string, datos: EntregaInput, ctx: LogisticaCtx): Promise<{ documentos: number }> {
  if (!datos.receptorNombre?.trim() || !datos.receptorDocumento?.trim()) throw new LogisticaError('La entrega requiere nombre y documento del receptor (RN-03)');
  return db.transaction(async (tx) => {
    const acta = await cargarActa(tx, actaId);
    if (acta.estado !== EstadoActaLogistica.DESPACHADA) throw new LogisticaError(`El acta no se puede entregar en estado "${acta.estado}"`);
    if (ctx.role === 'mensajero' && acta.mensajeroId !== ctx.userId) throw new LogisticaError('Solo puedes entregar tus propias actas', 403);
    await tx.update(flitoLogisticaActas).set({
      estado: EstadoActaLogistica.ENTREGADA, receptorNombre: datos.receptorNombre.trim(),
      receptorDocumento: datos.receptorDocumento.trim(), entregadoLat: datos.lat ?? null, entregadoLng: datos.lng ?? null,
      entregadoEn: new Date(), updatedAt: new Date(),
    }).where(eq(flitoLogisticaActas.id, actaId));
    const docs = await docsDeActa(tx, actaId);
    for (const d of docs) await transicionar(tx, d, EstadoDocumentoLogistica.ENTREGADO, ctx, { lat: datos.lat, lng: datos.lng });
    return { documentos: docs.length };
  });
}

/** Devolución: el receptor no estaba o rechazó (CA-10). Motivo obligatorio; se reprograma sin re-clasificar. */
export async function registrarDevolucion(actaId: string, motivo: string, ctx: LogisticaCtx): Promise<{ documentos: number }> {
  const m = motivo?.trim();
  if (!m) throw new LogisticaError('La devolución requiere motivo (RN-04)');
  return db.transaction(async (tx) => {
    const acta = await cargarActa(tx, actaId);
    if (acta.estado !== EstadoActaLogistica.DESPACHADA) throw new LogisticaError(`El acta no se puede devolver en estado "${acta.estado}"`);
    if (ctx.role === 'mensajero' && acta.mensajeroId !== ctx.userId) throw new LogisticaError('Solo puedes registrar devoluciones de tus propias actas', 403);
    await tx.update(flitoLogisticaActas).set({ estado: EstadoActaLogistica.DEVUELTA, motivoDevolucion: m, updatedAt: new Date() }).where(eq(flitoLogisticaActas.id, actaId));
    const docs = await docsDeActa(tx, actaId);
    // Quedan 'devuelto': re-programables (se re-despachan sin volver a clasificar).
    for (const d of docs) await transicionar(tx, d, EstadoDocumentoLogistica.DEVUELTO, ctx, { motivo: m });
    return { documentos: docs.length };
  });
}

/**
 * Reversa un estado terminal/avanzado con justificación (RN-08). Solo Operaciones; deja rastro (evento
 * origen 'usuario'). Desvincula el documento del acta para permitir su re-flujo.
 */
export async function reversar(documentoId: string, estadoDestino: TEstadoDoc, motivo: string, ctx: LogisticaCtx): Promise<void> {
  const m = motivo?.trim();
  if (!m) throw new LogisticaError('La reversa requiere justificación (RN-08)');
  await db.transaction(async (tx) => {
    const [d] = await cargarDocumentos(tx, [documentoId]);
    if (!d) throw new LogisticaError('Documento no encontrado', 404);
    await tx.update(flitoLogisticaDocumentos).set({ actaId: null, updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, documentoId));
    await transicionar(tx, d, estadoDestino, ctx, { motivo: m, origen: 'usuario' });
  });
}

// ── Facetas para los filtros de la consola ───────────────────────────────────

export interface FacetasLogistica {
  estados: string[]; tipos: string[];
  empresas: Array<{ nit: string; nombre: string | null }>;
  organismos: Array<{ codigo: string; nombre: string | null }>;
  companiasCerrables: Array<{ companiaId: number; nombre: string | null; disponibles: number }>;
  mensajeros: Array<{ id: number; nombre: string }>;
}
export async function facetas(): Promise<FacetasLogistica> {
  const [empresas, organismos, cerrables, mensajeros] = await Promise.all([
    db.selectDistinct({ nit: flitoLogisticaDocumentos.companiaNit, nombre: clients.name })
      .from(flitoLogisticaDocumentos).leftJoin(clients, eq(flitoLogisticaDocumentos.companiaId, clients.id))
      .where(sql`${flitoLogisticaDocumentos.companiaNit} is not null`),
    db.selectDistinct({ codigo: flitoLogisticaDocumentos.organismoCodigo, nombre: organismosTransitoConfig.alias })
      .from(flitoLogisticaDocumentos).leftJoin(organismosTransitoConfig, eq(flitoLogisticaDocumentos.organismoCodigo, organismosTransitoConfig.codigo)),
    // Compañías con al menos un documento clasificado (candidatas a cerrar lote → generar acta).
    db.select({ companiaId: flitoLogisticaDocumentos.companiaId, nombre: clients.name, disponibles: sql<number>`count(*)::int` })
      .from(flitoLogisticaDocumentos).leftJoin(clients, eq(flitoLogisticaDocumentos.companiaId, clients.id))
      .where(and(eq(flitoLogisticaDocumentos.estado, EstadoDocumentoLogistica.CLASIFICADO), sql`${flitoLogisticaDocumentos.companiaId} is not null`))
      .groupBy(flitoLogisticaDocumentos.companiaId, clients.name),
    db.select({ id: users.id, nombre: users.name }).from(users).where(eq(users.role, 'mensajero')),
  ]);
  return {
    estados: Object.values(EstadoDocumentoLogistica),
    tipos: Object.keys(TIPO_DOCUMENTO_LOGISTICA_LABEL),
    empresas: empresas.filter((e): e is { nit: string; nombre: string | null } => !!e.nit),
    organismos: organismos.filter((o) => !!o.codigo),
    companiasCerrables: cerrables.filter((c): c is { companiaId: number; nombre: string | null; disponibles: number } => c.companiaId !== null),
    mensajeros,
  };
}

// ── Listado de actas (panel de despacho/entrega) ─────────────────────────────

export interface ActaFila {
  id: string; companiaId: number; companiaNombre: string | null; estado: string; estadoLabel: string;
  mensajeroId: number | null; mensajeroNombre: string | null; documentos: number;
  receptorNombre: string | null; entregadoEn: string | null; creadoEn: string;
}
export async function listarActas(): Promise<ActaFila[]> {
  const rows = await db.select({
    id: flitoLogisticaActas.id, companiaId: flitoLogisticaActas.companiaId, companiaNombre: clients.name,
    estado: flitoLogisticaActas.estado, mensajeroId: flitoLogisticaActas.mensajeroId, mensajeroNombre: users.name,
    receptorNombre: flitoLogisticaActas.receptorNombre, entregadoEn: flitoLogisticaActas.entregadoEn,
    creadoEn: flitoLogisticaActas.createdAt,
    documentos: sql<number>`(select count(*)::int from flito_logistica_documentos d where d.acta_id = ${flitoLogisticaActas.id})`,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .leftJoin(users, eq(flitoLogisticaActas.mensajeroId, users.id))
    .orderBy(desc(flitoLogisticaActas.createdAt));
  return rows.map((r) => ({
    ...r,
    estadoLabel: ESTADO_ACTA_LOGISTICA_LABEL[r.estado as keyof typeof ESTADO_ACTA_LOGISTICA_LABEL] ?? r.estado,
    entregadoEn: r.entregadoEn ? r.entregadoEn.toISOString() : null,
    creadoEn: r.creadoEn.toISOString(),
  }));
}

// ── Ruta del mensajero (PWA de campo, CA-11) ─────────────────────────────────

export interface RutaDocumento { id: string; tipo: string; tipoLabel: string; placa: string | null; idFlit: string }
export interface RutaRecogida { organismoCodigo: string; organismoNombre: string | null; documentos: RutaDocumento[] }
export interface RutaEntrega {
  actaId: string; companiaNombre: string | null; direccionEntrega: string | null;
  contactoNombre: string | null; documentos: RutaDocumento[];
}
export interface MiRuta { recogidas: RutaRecogida[]; entregas: RutaEntrega[] }

const docLabel = (tipo: string): string => TIPO_DOCUMENTO_LOGISTICA_LABEL[tipo as TipoDocumentoLogistica] ?? tipo;

/**
 * Ruta del mensajero: recogidas por organismo (documentos 'generado'; §4 excluye la asignación de
 * rutas, así que la recogida es por organismo, no asignada) y entregas (actas 'despachada'). Un
 * mensajero solo ve SUS actas despachadas (CA-11); admin ve todas (para pruebas/seguimiento).
 */
export async function miRuta(ctx: LogisticaCtx): Promise<MiRuta> {
  // Recogidas: documentos aún en el organismo, agrupados por organismo.
  const gen = await db.select({
    id: flitoLogisticaDocumentos.id, tipo: flitoLogisticaDocumentos.tipo, placa: vehicles.plate,
    idFlit: flitoTramites.idFlit, organismoCodigo: flitoLogisticaDocumentos.organismoCodigo,
    organismoNombre: organismosTransitoConfig.alias,
  }).from(flitoLogisticaDocumentos)
    .innerJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .leftJoin(organismosTransitoConfig, eq(flitoLogisticaDocumentos.organismoCodigo, organismosTransitoConfig.codigo))
    .where(eq(flitoLogisticaDocumentos.estado, EstadoDocumentoLogistica.GENERADO));

  const porOrg = new Map<string, RutaRecogida>();
  for (const d of gen) {
    const r = porOrg.get(d.organismoCodigo) ?? { organismoCodigo: d.organismoCodigo, organismoNombre: d.organismoNombre, documentos: [] };
    r.documentos.push({ id: d.id, tipo: d.tipo, tipoLabel: docLabel(d.tipo), placa: d.placa, idFlit: d.idFlit });
    porOrg.set(d.organismoCodigo, r);
  }

  // Entregas: actas despachadas de este mensajero (o todas, si admin/operaciones).
  const soloMias = ctx.role === 'mensajero';
  const actaCond = soloMias
    ? and(eq(flitoLogisticaActas.estado, EstadoActaLogistica.DESPACHADA), eq(flitoLogisticaActas.mensajeroId, ctx.userId))
    : eq(flitoLogisticaActas.estado, EstadoActaLogistica.DESPACHADA);
  const actas = await db.select({
    actaId: flitoLogisticaActas.id, companiaNombre: clients.name,
    direccionEntrega: flitoLogisticaActas.direccionEntrega, contactoNombre: flitoLogisticaActas.contactoNombre,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .where(actaCond);

  const entregas: RutaEntrega[] = [];
  for (const a of actas) {
    const docs = await db.select({
      id: flitoLogisticaDocumentos.id, tipo: flitoLogisticaDocumentos.tipo, placa: vehicles.plate, idFlit: flitoTramites.idFlit,
    }).from(flitoLogisticaDocumentos)
      .innerJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
      .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
      .where(eq(flitoLogisticaDocumentos.actaId, a.actaId));
    entregas.push({
      actaId: a.actaId, companiaNombre: a.companiaNombre, direccionEntrega: a.direccionEntrega,
      contactoNombre: a.contactoNombre,
      documentos: docs.map((d) => ({ id: d.id, tipo: d.tipo, tipoLabel: docLabel(d.tipo), placa: d.placa, idFlit: d.idFlit })),
    });
  }

  return { recogidas: [...porOrg.values()], entregas };
}

// ── Detalle del acta (CA-13: documentos + bitácora del despacho) ─────────────

export interface ActaDocumento { id: string; tipo: string; tipoLabel: string; estado: string; estadoLabel: string; placa: string | null; vin: string | null; idFlit: string }
export interface ActaEvento { id: string; documentoId: string; placa: string | null; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; motivo: string | null; origen: string; creadoEn: string }
export interface ActaDetalle {
  acta: ActaFila; tienePdf: boolean;
  documentos: ActaDocumento[]; bitacora: ActaEvento[];
}

export async function actaDetalle(actaId: string): Promise<ActaDetalle> {
  const [cab] = await db.select({
    id: flitoLogisticaActas.id, companiaId: flitoLogisticaActas.companiaId, companiaNombre: clients.name,
    estado: flitoLogisticaActas.estado, mensajeroId: flitoLogisticaActas.mensajeroId, mensajeroNombre: users.name,
    receptorNombre: flitoLogisticaActas.receptorNombre, entregadoEn: flitoLogisticaActas.entregadoEn,
    creadoEn: flitoLogisticaActas.createdAt, pdfStorageKey: flitoLogisticaActas.pdfStorageKey,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .leftJoin(users, eq(flitoLogisticaActas.mensajeroId, users.id))
    .where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!cab) throw new LogisticaError('Acta no encontrada', 404);

  const docs = await db.select({
    id: flitoLogisticaDocumentos.id, tipo: flitoLogisticaDocumentos.tipo, estado: flitoLogisticaDocumentos.estado,
    placa: vehicles.plate, vin: vehicles.vin, idFlit: flitoTramites.idFlit,
  }).from(flitoLogisticaDocumentos)
    .innerJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .where(eq(flitoLogisticaDocumentos.actaId, actaId));

  const eventos = await db.select({
    id: flitoLogisticaEventos.id, documentoId: flitoLogisticaEventos.documentoId, placa: vehicles.plate,
    estadoAnterior: flitoLogisticaEventos.estadoAnterior, estadoNuevo: flitoLogisticaEventos.estadoNuevo,
    actorNombre: users.name, motivo: flitoLogisticaEventos.motivo, origen: flitoLogisticaEventos.origen,
    creadoEn: flitoLogisticaEventos.createdAt,
  }).from(flitoLogisticaEventos)
    .innerJoin(flitoLogisticaDocumentos, eq(flitoLogisticaEventos.documentoId, flitoLogisticaDocumentos.id))
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .leftJoin(users, eq(flitoLogisticaEventos.actorId, users.id))
    .where(eq(flitoLogisticaDocumentos.actaId, actaId))
    .orderBy(desc(flitoLogisticaEventos.createdAt));

  const acta: ActaFila = {
    id: cab.id, companiaId: cab.companiaId, companiaNombre: cab.companiaNombre,
    estado: cab.estado, estadoLabel: ESTADO_ACTA_LOGISTICA_LABEL[cab.estado as keyof typeof ESTADO_ACTA_LOGISTICA_LABEL] ?? cab.estado,
    mensajeroId: cab.mensajeroId, mensajeroNombre: cab.mensajeroNombre, documentos: docs.length,
    receptorNombre: cab.receptorNombre, entregadoEn: cab.entregadoEn ? cab.entregadoEn.toISOString() : null,
    creadoEn: cab.creadoEn.toISOString(),
  };
  return {
    acta, tienePdf: cab.pdfStorageKey !== null,
    documentos: docs.map((d) => ({
      id: d.id, tipo: d.tipo, tipoLabel: TIPO_DOCUMENTO_LOGISTICA_LABEL[d.tipo as TipoDocumentoLogistica] ?? d.tipo,
      estado: d.estado, estadoLabel: ESTADO_DOCUMENTO_LOGISTICA_LABEL[d.estado as TEstadoDoc] ?? d.estado,
      placa: d.placa, vin: d.vin, idFlit: d.idFlit,
    })),
    bitacora: eventos.map((e) => ({ ...e, creadoEn: e.creadoEn.toISOString() })),
  };
}

// ── PDF base del acta (CA-13). El PDF FIRMADO con evidencia del receptor es Fase 2. ──

/** Genera el PDF base del acta (empresa, dirección, contacto, documentos), lo sube y fija pdfStorageKey. */
export async function generarActaPdf(actaId: string): Promise<string> {
  const [cab] = await db.select({
    id: flitoLogisticaActas.id, companiaNombre: clients.name, direccion: flitoLogisticaActas.direccionEntrega,
    contactoNombre: flitoLogisticaActas.contactoNombre, contactoDoc: flitoLogisticaActas.contactoDocumento,
    creadoEn: flitoLogisticaActas.createdAt,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!cab) throw new LogisticaError('Acta no encontrada', 404);
  const docs = await db.select({
    tipo: flitoLogisticaDocumentos.tipo, placa: vehicles.plate, idFlit: flitoTramites.idFlit,
  }).from(flitoLogisticaDocumentos)
    .innerJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .where(eq(flitoLogisticaDocumentos.actaId, actaId));

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const azul = rgb(0.086, 0.153, 0.267);
  let y = 800;
  const linea = (text: string, opts: { x?: number; size?: number; negrita?: boolean } = {}) => {
    page.drawText(text, { x: opts.x ?? 40, y, size: opts.size ?? 10, font: opts.negrita ? bold : font, color: azul });
    y -= (opts.size ?? 10) + 6;
  };
  linea('Acta de entrega de documentos', { size: 16, negrita: true });
  linea(`Empresa: ${cab.companiaNombre ?? '—'}`);
  linea(`Dirección de entrega: ${cab.direccion ?? '—'}`);
  linea(`Contacto autorizado: ${cab.contactoNombre ?? '—'} ${cab.contactoDoc ?? ''}`);
  linea(`Acta N.º ${actaId}`, { size: 8 });
  linea(`Generada: ${cab.creadoEn.toISOString().slice(0, 16).replace('T', ' ')}`, { size: 8 });
  y -= 8;
  linea(`Documentos (${docs.length})`, { size: 12, negrita: true });
  const maxLineas = Math.max(0, Math.floor((y - 120) / 16));
  docs.slice(0, maxLineas).forEach((d) => {
    linea(`•  ${TIPO_DOCUMENTO_LOGISTICA_LABEL[d.tipo as TipoDocumentoLogistica] ?? d.tipo}  —  ${d.placa ?? '—'}  (${d.idFlit})`, { x: 48 });
  });
  if (docs.length > maxLineas) linea(`… y ${docs.length - maxLineas} documento(s) más`, { x: 48, size: 9 });
  y = 110;
  linea('Recibí a satisfacción los documentos relacionados:', { size: 9 });
  y = 70;
  linea('Nombre: ______________________________    C.C.: ________________', { size: 10 });
  y = 45;
  linea('Firma: ______________________________', { size: 10 });

  const bytes = await pdf.save();
  const key = await uploadEntityDocument('flito-logistica-actas', actaId, `acta-${actaId}.pdf`, Buffer.from(bytes), 'application/pdf');
  await db.update(flitoLogisticaActas).set({ pdfStorageKey: key, updatedAt: new Date() }).where(eq(flitoLogisticaActas.id, actaId));
  return key;
}

/** URL prefirmada para ver/descargar el PDF del acta; lo genera si aún no existe. */
export async function urlActaPdf(actaId: string): Promise<string> {
  const [a] = await db.select({ key: flitoLogisticaActas.pdfStorageKey }).from(flitoLogisticaActas)
    .where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!a) throw new LogisticaError('Acta no encontrada', 404);
  const key = a.key ?? await generarActaPdf(actaId);
  return presignedGetEntityDocument(key, 300);
}

export { ESTADO_ACTA_LOGISTICA_LABEL };
