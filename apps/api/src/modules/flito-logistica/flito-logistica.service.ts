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

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  EstadoActaLogistica, EstadoDocumentoLogistica, ESTADO_ACTA_LOGISTICA_LABEL,
  ESTADO_DOCUMENTO_LOGISTICA_LABEL, parseLicenciaTransito, puedeEntrarEnActa,
  type EstadoDocumentoLogistica as TEstadoDoc,
} from '@operaciones/shared-types';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { db } from '../../db/client.js';
import {
  clients, flitoCompradores, flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaEventos,
  flitoLogisticaIdempotencia, flitoProveedoresLogistica, flitoTramites, organismosTransitoConfig,
  users, vehicles,
} from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { getEntityDocumentStream, presignedGetEntityDocument, uploadEntityDocument } from '../../services/storage.js';

const log = loggerFor('flito-logistica');

export interface LogisticaCtx { userId: number; username: string; role: string }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

const LT = 'licencia_transito' as const;
const ESTADO_PENDIENTE = 'pendiente'; // trámite aprobado aún sin LT escaneada (estado sintético de la consola)
const normPlaca = (s: string): string => s.toUpperCase().replace(/[\s-]/g, '');
const aprobadoSql = sql`lower(${flitoTramites.flitEstado}) = 'aprobado'`;

/** Error de negocio con estado HTTP sugerido (lo traduce la ruta). */
export class LogisticaError extends Error {
  constructor(message: string, readonly status = 400, readonly extra?: unknown) { super(message); }
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

/** Decodifica un dataURL (o base64 pelado) a Buffer. */
function bufDesdeDataUrl(dataUrl: string): Buffer {
  const b64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  return Buffer.from(b64, 'base64');
}

// ── Escaneo de la LT (mensajero en el organismo) ─────────────────────────────

export interface ResultadoEscaneo {
  resultado: 'recogido' | 'novedad' | 'duplicado' | 'sin_match' | 'no_gestionable';
  documentoId?: string;
  placa: string; vin: string;
  idFlit?: string; numeroLicencia?: string; propietarioNombre?: string | null; motivo?: string | null;
}

/**
 * Registra la recogida de una LT desde su código PDF417. Empareja por PLACA contra un trámite
 * aprobado (la placa es la llave; el VIN valida el resto). Coincide → documento 'recogido' + auto
 * clasificación (CA-03). VIN distinto → 'novedad' con motivo (RN-04). Sin trámite → 'sin_match' (no
 * persiste). Idempotente por (trámite, tipo): re-escanear la misma LT no duplica. El n.º de LT no
 * viaja en el código: llega por `numeroLt` (manual ahora, OCR después).
 */
export async function escanearLt(rawValue: string, numeroLt: string | null, evidencia: { lat?: string | null; lng?: string | null }, ctx: LogisticaCtx): Promise<ResultadoEscaneo> {
  const p = parseLicenciaTransito(rawValue);
  if (!p) throw new LogisticaError('No se pudo leer el código de la licencia. Reintenta el escaneo.');
  const placa = normPlaca(p.placa);
  const vin = p.vin.toUpperCase();

  const [t] = await db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit, organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId, companiaNit: flitoTramites.companiaNit,
    vehiculoId: flitoTramites.vehiculoId, vin: vehicles.vin,
    autogestionable: clients.logisticaAutogestionable,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .where(and(aprobadoSql, sql`upper(replace(${vehicles.plate}, '-', '')) = ${placa}`))
    .limit(1);

  if (!t) return { resultado: 'sin_match', placa, vin, motivo: 'No hay ningún trámite aprobado con esta placa.' };
  // Parametrización por compañía (RN-05): si la compañía autogestiona su logística, FLITO no la gestiona.
  if (t.autogestionable) return { resultado: 'no_gestionable', placa, vin, idFlit: t.idFlit, motivo: 'La logística de esta compañía es autogestionada por el cliente; FLITO no la gestiona.' };
  if (!t.companiaId) return { resultado: 'sin_match', placa, vin, idFlit: t.idFlit, motivo: 'El trámite de esta placa aún no tiene compañía FLITO asignada.' };
  if (!t.organismoCodigo) return { resultado: 'sin_match', placa, vin, idFlit: t.idFlit, motivo: 'El trámite de esta placa no tiene organismo emparejado.' };

  const vinCoincide = vin === (t.vin ?? '').toUpperCase();
  const estado = vinCoincide ? EstadoDocumentoLogistica.RECOGIDO : EstadoDocumentoLogistica.NOVEDAD;
  const motivo = vinCoincide ? null : `El VIN del código (${vin}) no coincide con el del trámite (${t.vin ?? '—'}).`;

  const salida = await db.transaction(async (tx) => {
    const [creado] = await tx.insert(flitoLogisticaDocumentos).values({
      tramiteId: t.tramiteId, tipo: LT, estado,
      organismoCodigo: t.organismoCodigo!, companiaId: t.companiaId, companiaNit: t.companiaNit,
      vehiculoId: t.vehiculoId, identificador: placa,
      numeroLicencia: p.numeroLicencia, numeroLt: numeroLt?.trim() || null,
      propietarioNombre: p.propietarioNombre, propietarioDocumento: p.propietarioDocumento,
      combustible: p.combustible, motivo,
      flitRaw: { raw: rawValue, parsed: { ...p, fotoBase64: p.fotoBase64 ? '<jpeg>' : null } },
    }).onConflictDoNothing({ target: [flitoLogisticaDocumentos.tramiteId, flitoLogisticaDocumentos.tipo] })
      .returning({ id: flitoLogisticaDocumentos.id });

    if (!creado) {
      // Ya se había escaneado esta LT (idempotente). Completa el n.º de LT si ahora sí llegó.
      const [existente] = await tx.select({ id: flitoLogisticaDocumentos.id })
        .from(flitoLogisticaDocumentos)
        .where(and(eq(flitoLogisticaDocumentos.tramiteId, t.tramiteId), eq(flitoLogisticaDocumentos.tipo, LT))).limit(1);
      if (numeroLt?.trim() && existente) {
        await tx.update(flitoLogisticaDocumentos).set({ numeroLt: numeroLt.trim(), updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, existente.id));
      }
      return { documentoId: existente?.id, duplicado: true };
    }

    await tx.insert(flitoLogisticaEventos).values({
      documentoId: creado.id, estadoAnterior: null, estadoNuevo: estado, actorId: ctx.userId,
      lat: evidencia.lat ?? null, lng: evidencia.lng ?? null, motivo, origen: 'usuario',
    });
    // Clasificación automática: la empresa destino ya vive en el trámite (CA-03), si el VIN cuadra.
    if (vinCoincide && t.companiaId) {
      await transicionar(tx, { id: creado.id, estado }, EstadoDocumentoLogistica.CLASIFICADO, ctx, { origen: 'api' });
    }
    return { documentoId: creado.id, duplicado: false };
  });

  // Foto del propietario embebida en el código (best-effort, fuera de la transacción).
  if (salida.documentoId && !salida.duplicado && p.fotoBase64) {
    try {
      const key = await uploadEntityDocument('flito-logistica-lt-fotos', salida.documentoId, 'foto.jpg', Buffer.from(p.fotoBase64, 'base64'), 'image/jpeg');
      await db.update(flitoLogisticaDocumentos).set({ fotoStorageKey: key }).where(eq(flitoLogisticaDocumentos.id, salida.documentoId));
    } catch (e) { log.warn({ err: (e as Error).message }, 'no se pudo guardar la foto de la LT'); }
  }

  const resultado: ResultadoEscaneo['resultado'] = salida.duplicado ? 'duplicado' : (vinCoincide ? 'recogido' : 'novedad');
  return { resultado, documentoId: salida.documentoId, placa, vin, idFlit: t.idFlit, numeroLicencia: p.numeroLicencia, propietarioNombre: p.propietarioNombre, motivo };
}

// ── Listado de la consola: trámites APROBADOS + su estado logístico ──────────

export interface TramiteFila {
  tramiteId: string; idFlit: string;
  placa: string | null; vin: string | null; propietario: string | null;
  companiaId: number | null; companiaNombre: string | null; companiaNit: string | null;
  organismoCodigo: string | null; organismoNombre: string | null;
  docId: string | null; estado: string; estadoLabel: string;
  numeroLicencia: string | null; numeroLt: string | null;
  actaId: string | null; motivo: string | null; actualizadoEn: string | null;
}
export interface FiltrosLogistica {
  buscar?: string; estados?: string[]; empresas?: string[]; organismos?: string[];
  actas?: string[]; page?: number; pageSize?: number;
}
export interface ListadoLogistica { items: TramiteFila[]; total: number; page: number; pageSize: number }

function proyeccionTramites() {
  return db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit,
    placa: vehicles.plate, vin: vehicles.vin,
    propietarioTramite: flitoCompradores.nombreCompleto,
    companiaId: flitoTramites.companiaId, companiaNombre: clients.name, companiaNit: flitoTramites.companiaNit,
    organismoCodigo: flitoTramites.organismoCodigo, organismoNombre: organismosTransitoConfig.alias,
    docId: flitoLogisticaDocumentos.id, estadoDoc: flitoLogisticaDocumentos.estado,
    numeroLicencia: flitoLogisticaDocumentos.numeroLicencia, numeroLt: flitoLogisticaDocumentos.numeroLt,
    propietarioLt: flitoLogisticaDocumentos.propietarioNombre,
    actaId: flitoLogisticaDocumentos.actaId, motivo: flitoLogisticaDocumentos.motivo,
    actualizadoEn: flitoLogisticaDocumentos.updatedAt,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoCompradores, and(eq(flitoCompradores.tramiteId, flitoTramites.id), eq(flitoCompradores.orden, 0)))
    .leftJoin(flitoLogisticaDocumentos, and(eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id), eq(flitoLogisticaDocumentos.tipo, LT)));
}
type FilaCruda = Awaited<ReturnType<ReturnType<typeof proyeccionTramites>['where']>>[number];

function construirCondiciones(f: FiltrosLogistica): SQL[] {
  // Solo compañías cuya logística gestiona FLITO (parametrización por compañía, RN-05): las
  // autogestionadas por el cliente no entran al módulo. La condición exige compañía conocida
  // (NULL en el flag → compañía sin emparejar → también queda fuera).
  const conds: SQL[] = [aprobadoSql, eq(clients.logisticaAutogestionable, false)];
  const termino = f.buscar?.trim();
  if (termino) {
    const patron = `%${termino.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${termino.toUpperCase()}%`;
    conds.push(or(
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
    )!);
  }
  if (f.estados?.length) {
    const otros = f.estados.filter((e) => e !== ESTADO_PENDIENTE);
    const parts: SQL[] = [];
    if (f.estados.includes(ESTADO_PENDIENTE)) parts.push(sql`${flitoLogisticaDocumentos.id} is null`);
    if (otros.length) parts.push(inArray(flitoLogisticaDocumentos.estado, otros as TEstadoDoc[]));
    if (parts.length) conds.push(parts.length === 1 ? parts[0] : or(...parts)!);
  }
  if (f.empresas?.length) conds.push(inArray(flitoTramites.companiaNit, f.empresas));
  if (f.organismos?.length) conds.push(inArray(flitoTramites.organismoCodigo, f.organismos));
  if (f.actas?.length) conds.push(inArray(flitoLogisticaDocumentos.actaId, f.actas));
  return conds;
}

function aFila(f: FilaCruda): TramiteFila {
  const estado = f.estadoDoc ?? ESTADO_PENDIENTE;
  return {
    tramiteId: f.tramiteId, idFlit: f.idFlit,
    placa: f.placa, vin: f.vin, propietario: f.propietarioLt ?? f.propietarioTramite,
    companiaId: f.companiaId, companiaNombre: f.companiaNombre, companiaNit: f.companiaNit,
    organismoCodigo: f.organismoCodigo, organismoNombre: f.organismoNombre,
    docId: f.docId, estado,
    estadoLabel: f.estadoDoc ? (ESTADO_DOCUMENTO_LOGISTICA_LABEL[f.estadoDoc as TEstadoDoc] ?? f.estadoDoc) : 'Pendiente de recogida',
    numeroLicencia: f.numeroLicencia, numeroLt: f.numeroLt,
    actaId: f.actaId, motivo: f.motivo,
    actualizadoEn: f.actualizadoEn ? f.actualizadoEn.toISOString() : null,
  };
}

export async function listar(filtros: FiltrosLogistica = {}): Promise<ListadoLogistica> {
  const page = Math.max(1, Math.floor(filtros.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(filtros.pageSize ?? 50)));
  const conds = construirCondiciones(filtros);

  const countRows = await db.select({ total: sql<number>`count(distinct ${flitoTramites.id})::int` })
    .from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoLogisticaDocumentos, and(eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id), eq(flitoLogisticaDocumentos.tipo, LT)))
    .where(and(...conds));
  const total = Number(countRows[0]?.total ?? 0);

  const rows = await proyeccionTramites().where(and(...conds))
    .orderBy(desc(flitoTramites.fechaAprobacion), desc(flitoTramites.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
  return { items: rows.map(aFila), total, page, pageSize };
}

export interface EventoDocumento {
  id: string; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null;
  lat: string | null; lng: string | null; motivo: string | null; origen: string; creadoEn: string;
}
/** Bitácora de la LT (CA-07): cada transición con actor, hora y ubicación. */
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

export interface TramiteDetalle extends TramiteFila {
  propietarioDocumento: string | null; combustible: string | null; tieneFoto: boolean;
  eventos: EventoDocumento[];
}
/** Detalle de un trámite aprobado + su LT (si ya fue escaneada) + bitácora (CA-07). */
export async function tramiteDetalle(tramiteId: string): Promise<TramiteDetalle> {
  const [row] = await proyeccionTramites().where(eq(flitoTramites.id, tramiteId)).limit(1);
  if (!row) throw new LogisticaError('Trámite no encontrado', 404);
  let extra: { propietarioDocumento: string | null; combustible: string | null; fotoStorageKey: string | null } = { propietarioDocumento: null, combustible: null, fotoStorageKey: null };
  let bitacora: EventoDocumento[] = [];
  if (row.docId) {
    const [d] = await db.select({
      propietarioDocumento: flitoLogisticaDocumentos.propietarioDocumento,
      combustible: flitoLogisticaDocumentos.combustible, fotoStorageKey: flitoLogisticaDocumentos.fotoStorageKey,
    }).from(flitoLogisticaDocumentos).where(eq(flitoLogisticaDocumentos.id, row.docId)).limit(1);
    if (d) extra = d;
    bitacora = await eventos(row.docId);
  }
  return { ...aFila(row), propietarioDocumento: extra.propietarioDocumento, combustible: extra.combustible, tieneFoto: extra.fotoStorageKey !== null, eventos: bitacora };
}

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
 * Respeta la parametrización de entregas parciales (CA-08/09): si la compañía es "Solo completo" y
 * quedan LT pendientes (recogidas con novedad/sin clasificar), no genera y se informa qué falta.
 */
export async function cerrarLote(companiaId: number, ctx: LogisticaCtx): Promise<ResultadoCerrarLote> {
  const res = await db.transaction(async (tx) => {
    const [compania] = await tx.select({
      id: clients.id, nombre: clients.name, permiteParcial: clients.logisticaPermiteParcial,
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
    const pendientes = docs.filter((d) => !puedeEntrarEnActa(d.estado as TEstadoDoc));
    if (listos.length === 0) throw new LogisticaError('No hay LT clasificadas para esta empresa', 400, { pendientes: pendientes.length });
    if (!compania.permiteParcial && pendientes.length > 0) {
      throw new LogisticaError(`La compañía es "Solo completo": faltan ${pendientes.length} LT por resolver`, 409, { faltantes: pendientes.length, disponibles: listos.length });
    }

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
  if (ctx.role === 'mensajero' && acta0.mensajeroId !== ctx.userId) throw new LogisticaError('Solo puedes entregar tus propias actas', 403);

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
    if (ctx.role === 'mensajero' && acta.mensajeroId !== ctx.userId) throw new LogisticaError('Solo puedes registrar devoluciones de tus propias actas', 403);
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

// ── Facetas para los filtros de la consola ───────────────────────────────────

export interface FacetasLogistica {
  estados: string[];
  empresas: Array<{ nit: string; nombre: string | null }>;
  organismos: Array<{ codigo: string; nombre: string | null }>;
  companiasCerrables: Array<{ companiaId: number; nombre: string | null; disponibles: number }>;
  mensajeros: Array<{ id: number; nombre: string }>;
}
export async function facetas(): Promise<FacetasLogistica> {
  // Todas las facetas se restringen a compañías gestionadas por FLITO (logisticaAutogestionable = false).
  const gestionable = eq(clients.logisticaAutogestionable, false);
  const [empresas, organismos, cerrables, mensajeros] = await Promise.all([
    db.selectDistinct({ nit: flitoTramites.companiaNit, nombre: clients.name })
      .from(flitoTramites).leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
      .where(and(aprobadoSql, gestionable, sql`${flitoTramites.companiaNit} is not null`)),
    db.selectDistinct({ codigo: flitoTramites.organismoCodigo, nombre: organismosTransitoConfig.alias })
      .from(flitoTramites)
      .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
      .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
      .where(and(aprobadoSql, gestionable, sql`${flitoTramites.organismoCodigo} is not null`)),
    db.select({ companiaId: flitoLogisticaDocumentos.companiaId, nombre: clients.name, disponibles: sql<number>`count(*)::int` })
      .from(flitoLogisticaDocumentos).leftJoin(clients, eq(flitoLogisticaDocumentos.companiaId, clients.id))
      .where(and(eq(flitoLogisticaDocumentos.estado, EstadoDocumentoLogistica.CLASIFICADO), gestionable, sql`${flitoLogisticaDocumentos.companiaId} is not null`))
      .groupBy(flitoLogisticaDocumentos.companiaId, clients.name),
    db.select({ id: users.id, nombre: users.name }).from(users).where(eq(users.role, 'mensajero')),
  ]);
  return {
    estados: [ESTADO_PENDIENTE, EstadoDocumentoLogistica.RECOGIDO, EstadoDocumentoLogistica.CLASIFICADO,
      EstadoDocumentoLogistica.EN_ACTA, EstadoDocumentoLogistica.DESPACHADO, EstadoDocumentoLogistica.ENTREGADO,
      EstadoDocumentoLogistica.NOVEDAD, EstadoDocumentoLogistica.DEVUELTO],
    empresas: empresas.filter((e): e is { nit: string; nombre: string | null } => !!e.nit),
    organismos: organismos.filter((o): o is { codigo: string; nombre: string | null } => !!o.codigo),
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

export interface RutaDocumento { id: string; placa: string | null; idFlit: string; numeroLt: string | null }
export interface RutaEntrega {
  actaId: string; companiaNombre: string | null; direccionEntrega: string | null;
  contactoNombre: string | null; documentos: RutaDocumento[];
}
export interface MiRuta { entregas: RutaEntrega[] }

/**
 * Ruta del mensajero: entregas (actas 'despachada'). La RECOGIDA ya no es una lista pre-cargada:
 * ocurre escaneando la LT en el organismo (POST /escanear). Un mensajero solo ve SUS actas (CA-11);
 * admin ve todas (seguimiento).
 */
export async function miRuta(ctx: LogisticaCtx): Promise<MiRuta> {
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
      id: flitoLogisticaDocumentos.id, placa: vehicles.plate, idFlit: flitoTramites.idFlit, numeroLt: flitoLogisticaDocumentos.numeroLt,
    }).from(flitoLogisticaDocumentos)
      .innerJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
      .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
      .where(eq(flitoLogisticaDocumentos.actaId, a.actaId));
    entregas.push({ actaId: a.actaId, companiaNombre: a.companiaNombre, direccionEntrega: a.direccionEntrega, contactoNombre: a.contactoNombre, documentos: docs });
  }
  return { entregas };
}

// ── Detalle del acta (CA-13: filas del acta + bitácora + firmas) ─────────────

export interface ActaLinea { id: string; placa: string | null; secretaria: string | null; propietario: string | null; numeroLicencia: string | null; numeroLt: string | null; estado: string; estadoLabel: string; idFlit: string }
export interface ActaEvento { id: string; documentoId: string; placa: string | null; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; motivo: string | null; origen: string; creadoEn: string }
export interface ActaDetalle {
  acta: ActaFila; tienePdf: boolean; firmaEntrega: boolean; firmaRecibe: boolean; entregaNombre: string | null;
  documentos: ActaLinea[]; bitacora: ActaEvento[];
}

export async function actaDetalle(actaId: string): Promise<ActaDetalle> {
  const [cab] = await db.select({
    id: flitoLogisticaActas.id, companiaId: flitoLogisticaActas.companiaId, companiaNombre: clients.name,
    estado: flitoLogisticaActas.estado, mensajeroId: flitoLogisticaActas.mensajeroId, mensajeroNombre: users.name,
    receptorNombre: flitoLogisticaActas.receptorNombre, entregadoEn: flitoLogisticaActas.entregadoEn,
    creadoEn: flitoLogisticaActas.createdAt, pdfStorageKey: flitoLogisticaActas.pdfStorageKey,
    firmaEntregaKey: flitoLogisticaActas.firmaEntregaStorageKey, entregaNombre: flitoLogisticaActas.entregaNombre,
    firmaRecibeKey: flitoLogisticaActas.firmaStorageKey,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .leftJoin(users, eq(flitoLogisticaActas.mensajeroId, users.id))
    .where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!cab) throw new LogisticaError('Acta no encontrada', 404);

  const docs = await db.select({
    id: flitoLogisticaDocumentos.id, estado: flitoLogisticaDocumentos.estado,
    placa: vehicles.plate, secretaria: organismosTransitoConfig.alias,
    propietario: flitoLogisticaDocumentos.propietarioNombre, numeroLicencia: flitoLogisticaDocumentos.numeroLicencia,
    numeroLt: flitoLogisticaDocumentos.numeroLt, idFlit: flitoTramites.idFlit,
  }).from(flitoLogisticaDocumentos)
    .innerJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .leftJoin(organismosTransitoConfig, eq(flitoLogisticaDocumentos.organismoCodigo, organismosTransitoConfig.codigo))
    .where(eq(flitoLogisticaDocumentos.actaId, actaId));

  const bitacora = await db.select({
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
    firmaEntrega: cab.firmaEntregaKey !== null, firmaRecibe: cab.firmaRecibeKey !== null, entregaNombre: cab.entregaNombre,
    documentos: docs.map((d) => ({
      id: d.id, placa: d.placa, secretaria: d.secretaria, propietario: d.propietario,
      numeroLicencia: d.numeroLicencia, numeroLt: d.numeroLt,
      estado: d.estado, estadoLabel: ESTADO_DOCUMENTO_LOGISTICA_LABEL[d.estado as TEstadoDoc] ?? d.estado, idFlit: d.idFlit,
    })),
    bitacora: bitacora.map((e) => ({ ...e, creadoEn: e.creadoEn.toISOString() })),
  };
}

// ── PDF del acta: tabla + dos firmas (entrega Operaciones / recibe receptor) ──

async function embeberFirma(pdf: PDFDocument, key: string): Promise<Awaited<ReturnType<PDFDocument['embedPng']>> | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of await getEntityDocumentStream(key)) chunks.push(c as Buffer);
    return await pdf.embedPng(Buffer.concat(chunks));
  } catch { return null; }
}

/** Genera el PDF del acta (empresa, tabla de LT, dos firmas), lo sube y fija pdfStorageKey (CA-13). */
export async function generarActaPdf(actaId: string): Promise<string> {
  const [cab] = await db.select({
    companiaNombre: clients.name, direccion: flitoLogisticaActas.direccionEntrega,
    contactoNombre: flitoLogisticaActas.contactoNombre, creadoEn: flitoLogisticaActas.createdAt,
    firmaEntregaKey: flitoLogisticaActas.firmaEntregaStorageKey, entregaNombre: flitoLogisticaActas.entregaNombre,
    firmaRecibeKey: flitoLogisticaActas.firmaStorageKey, receptorNombre: flitoLogisticaActas.receptorNombre,
    receptorDocumento: flitoLogisticaActas.receptorDocumento, entregadoEn: flitoLogisticaActas.entregadoEn,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .where(eq(flitoLogisticaActas.id, actaId)).limit(1);
  if (!cab) throw new LogisticaError('Acta no encontrada', 404);

  const docs = await db.select({
    placa: vehicles.plate, secretaria: organismosTransitoConfig.alias, organismoCodigo: flitoLogisticaDocumentos.organismoCodigo,
    propietario: flitoLogisticaDocumentos.propietarioNombre, numeroLicencia: flitoLogisticaDocumentos.numeroLicencia,
    numeroLt: flitoLogisticaDocumentos.numeroLt,
  }).from(flitoLogisticaDocumentos)
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .leftJoin(organismosTransitoConfig, eq(flitoLogisticaDocumentos.organismoCodigo, organismosTransitoConfig.codigo))
    .where(eq(flitoLogisticaDocumentos.actaId, actaId));

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const azul = rgb(0.086, 0.153, 0.267);
  const gris = rgb(0.5, 0.55, 0.6);
  let y = 800;
  const linea = (text: string, opts: { x?: number; size?: number; negrita?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    page.drawText(text, { x: opts.x ?? 40, y, size: opts.size ?? 10, font: opts.negrita ? bold : font, color: opts.color ?? azul });
    y -= (opts.size ?? 10) + 6;
  };
  const clip = (s: string | null, max: number) => { const v = s ?? '—'; return v.length > max ? `${v.slice(0, max - 1)}…` : v; };

  linea('Acta de entrega de licencias de tránsito', { size: 16, negrita: true });
  linea(`Para: ${cab.companiaNombre ?? '—'}`, { size: 12, negrita: true });
  if (cab.direccion) linea(`Dirección de entrega: ${cab.direccion}`, { size: 9 });
  linea(`Acta N.º ${actaId}`, { size: 8, color: gris });
  linea(`Generada: ${cab.creadoEn.toISOString().slice(0, 16).replace('T', ' ')}  ·  ${docs.length} licencia(s)`, { size: 8, color: gris });
  y -= 6;
  linea(`Placas: ${clip(docs.map((d) => d.placa ?? '—').join(', '), 110)}`, { size: 9 });
  y -= 6;

  // Tabla: Placa | Secretaría | Propietario | N.º licencia | N.º LT.
  const cols = [
    { t: 'Placa', x: 40, w: 60 }, { t: 'Secretaría', x: 100, w: 110 }, { t: 'Propietario', x: 210, w: 150 },
    { t: 'N.º licencia', x: 360, w: 100 }, { t: 'N.º LT', x: 460, w: 95 },
  ];
  const filaAlto = 16;
  const dibujarEncabezado = () => {
    page.drawRectangle({ x: 38, y: y - 3, width: 519, height: filaAlto, color: rgb(0.93, 0.95, 0.98) });
    cols.forEach((c) => page.drawText(c.t, { x: c.x + 2, y: y, size: 8, font: bold, color: azul }));
    y -= filaAlto;
  };
  dibujarEncabezado();
  const maxFilas = Math.max(0, Math.floor((y - 150) / filaAlto));
  docs.slice(0, maxFilas).forEach((d) => {
    const vals = [clip(d.placa, 10), clip(d.secretaria ?? d.organismoCodigo, 18), clip(d.propietario, 26), clip(d.numeroLicencia, 15), clip(d.numeroLt, 14)];
    vals.forEach((v, i) => page.drawText(v, { x: cols[i].x + 2, y, size: 8, font, color: azul }));
    page.drawLine({ start: { x: 38, y: y - 3 }, end: { x: 557, y: y - 3 }, thickness: 0.3, color: rgb(0.85, 0.87, 0.9) });
    y -= filaAlto;
  });
  if (docs.length > maxFilas) linea(`… y ${docs.length - maxFilas} licencia(s) más (ver detalle en la consola)`, { x: 40, size: 8, color: gris });

  // Dos firmas: ENTREGA (Operaciones, en consola) y RECIBE (receptor, en campo).
  const firmaEntrega = cab.firmaEntregaKey ? await embeberFirma(pdf, cab.firmaEntregaKey) : null;
  const firmaRecibe = cab.firmaRecibeKey ? await embeberFirma(pdf, cab.firmaRecibeKey) : null;
  const bloqueFirma = async (titulo: string, x: number, img: typeof firmaEntrega, l1: string, l2: string) => {
    if (img) { const dims = img.scale(Math.min(180 / img.width, 46 / img.height)); page.drawImage(img, { x: x + 4, y: 96, width: dims.width, height: dims.height }); }
    page.drawLine({ start: { x, y: 92 }, end: { x: x + 235, y: 92 }, thickness: 0.6, color: azul });
    page.drawText(titulo, { x, y: 78, size: 9, font: bold, color: azul });
    page.drawText(l1, { x, y: 64, size: 8, font, color: azul });
    if (l2) page.drawText(l2, { x, y: 52, size: 8, font, color: gris });
  };
  await bloqueFirma('Entrega (Operaciones)', 40, firmaEntrega,
    cab.entregaNombre ?? '—', firmaEntrega ? '' : 'Pendiente de firma');
  await bloqueFirma('Recibe (cliente)', 320, firmaRecibe,
    cab.receptorNombre ? `${cab.receptorNombre}  C.C. ${cab.receptorDocumento ?? '—'}` : '—',
    cab.entregadoEn ? `Recibido: ${cab.entregadoEn.toISOString().slice(0, 16).replace('T', ' ')}` : (firmaRecibe ? '' : 'Pendiente de firma'));

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

// ── Idempotencia de escrituras offline (RN-06/CA-06) ─────────────────────────

/** Respuesta ya emitida para una clave de idempotencia, o null si es la primera vez. */
export async function buscarIdempotencia(key: string): Promise<{ status: number; body: unknown } | null> {
  const [row] = await db.select({ status: flitoLogisticaIdempotencia.status, response: flitoLogisticaIdempotencia.response })
    .from(flitoLogisticaIdempotencia).where(eq(flitoLogisticaIdempotencia.idempotencyKey, key)).limit(1);
  return row ? { status: row.status, body: row.response } : null;
}

/** Guarda la respuesta de una escritura para deduplicar reenvíos. No pisa si ya existe. */
export async function guardarIdempotencia(key: string, status: number, body: unknown): Promise<void> {
  await db.insert(flitoLogisticaIdempotencia).values({ idempotencyKey: key, status, response: body }).onConflictDoNothing();
}

export { ESTADO_ACTA_LOGISTICA_LABEL };
