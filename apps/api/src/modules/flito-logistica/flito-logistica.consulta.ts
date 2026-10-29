// FLITO Logística — consultas de la consola, actas y ruta del mensajero (HU #14108, ADR-0030 §11).

import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  EstadoActaLogistica, EstadoDocumentoLogistica, ESTADO_ACTA_LOGISTICA_LABEL,
  ESTADO_DOCUMENTO_LOGISTICA_LABEL, ESTADO_LOGISTICA_SIMPLE_LABEL, EstadoLogisticaSimple,
  simplificarEstadoLogistica, tipoEventoEfectivo,
  type CompaniaCerrableLogistica, type EstadoDocumentoLogistica as TEstadoDoc,
  type EstadoLogisticaSimple as TEstadoSimple,
  type HitoLineaTiempoLogistica, type LineaTiempoLogistica,
} from '@operaciones/shared-types';
import { precioTrasladoDe } from './flito-logistica-precios.js';
import { db } from '../../db/client.js';
import {
  clients, flitoCompradores, flitoLogisticaActas, flitoLogisticaDocumentos, flitoLogisticaEventos,
  flitoLogisticaMotivosLlegada, flitoTramites, organismosTransitoConfig, users, vehicles,
} from '../../db/schema.js';
import { usuariosConFuncion } from '../../shared/permisos-efectivos.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { condicionActasLogistica, condicionDocumentosLogistica, condicionTramitesLogistica } from './flito-logistica.alcance.js';
import { LT, LogisticaError, aprobadoSql, type LogisticaCtx } from './flito-logistica.base.js';

const ESTADO_PENDIENTE = 'pendiente'; // trámite aprobado aún sin LT escaneada (estado sintético de la consola)
// Estados internos que agrupa cada estado SIMPLE (para traducir filtros de la consola). 'pendiente' se
// resuelve aparte (documento nulo o 'generado'), por eso no aparece aquí.
const ESTADOS_INTERNOS_POR_SIMPLE: Record<TEstadoSimple, TEstadoDoc[]> = {
  pendiente: [EstadoDocumentoLogistica.GENERADO],
  registrada: [EstadoDocumentoLogistica.RECOGIDO, EstadoDocumentoLogistica.CLASIFICADO, EstadoDocumentoLogistica.EN_ACTA],
  en_flit: [EstadoDocumentoLogistica.EN_FLIT],
  despachada: [EstadoDocumentoLogistica.DESPACHADO],
  entregada: [EstadoDocumentoLogistica.ENTREGADO],
  novedad: [EstadoDocumentoLogistica.NOVEDAD, EstadoDocumentoLogistica.DEVUELTO],
};

// ── Listado de la consola: trámites APROBADOS + su estado logístico ──────────

export interface TramiteFila {
  tramiteId: string; idFlit: string;
  placa: string | null; vin: string | null; propietario: string | null;
  companiaId: number | null; companiaNombre: string | null; companiaNit: string | null;
  organismoCodigo: string | null; organismoNombre: string | null;
  docId: string | null; estado: string; estadoLabel: string;
  estadoSimple: TEstadoSimple; estadoSimpleLabel: string;
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
    // Los filtros llegan en el vocabulario SIMPLE (5 estados); se traducen a los estados internos.
    const parts: SQL[] = [];
    // «Pendiente de recogida» = sin documento (aún no escaneada) o documento en 'generado'.
    if (f.estados.includes(EstadoLogisticaSimple.PENDIENTE)) {
      parts.push(or(sql`${flitoLogisticaDocumentos.id} is null`, eq(flitoLogisticaDocumentos.estado, EstadoDocumentoLogistica.GENERADO))!);
    }
    const internos = f.estados
      .filter((e) => e !== EstadoLogisticaSimple.PENDIENTE)
      .flatMap((e) => ESTADOS_INTERNOS_POR_SIMPLE[e as TEstadoSimple] ?? []);
    if (internos.length) parts.push(inArray(flitoLogisticaDocumentos.estado, internos));
    if (parts.length) conds.push(parts.length === 1 ? parts[0] : or(...parts)!);
  }
  if (f.empresas?.length) conds.push(inArray(flitoTramites.companiaNit, f.empresas));
  if (f.organismos?.length) conds.push(inArray(flitoTramites.organismoCodigo, f.organismos));
  if (f.actas?.length) conds.push(inArray(flitoLogisticaDocumentos.actaId, f.actas));
  return conds;
}

function aFila(f: FilaCruda): TramiteFila {
  const estado = f.estadoDoc ?? ESTADO_PENDIENTE;
  const estadoSimple = simplificarEstadoLogistica(f.estadoDoc);
  return {
    tramiteId: f.tramiteId, idFlit: f.idFlit,
    placa: f.placa, vin: f.vin, propietario: f.propietarioLt ?? f.propietarioTramite,
    companiaId: f.companiaId, companiaNombre: f.companiaNombre, companiaNit: f.companiaNit,
    organismoCodigo: f.organismoCodigo, organismoNombre: f.organismoNombre,
    docId: f.docId, estado,
    estadoLabel: f.estadoDoc ? (ESTADO_DOCUMENTO_LOGISTICA_LABEL[f.estadoDoc as TEstadoDoc] ?? f.estadoDoc) : 'Pendiente de recogida',
    estadoSimple, estadoSimpleLabel: ESTADO_LOGISTICA_SIMPLE_LABEL[estadoSimple],
    numeroLicencia: f.numeroLicencia, numeroLt: f.numeroLt,
    actaId: f.actaId, motivo: f.motivo,
    actualizadoEn: f.actualizadoEn ? f.actualizadoEn.toISOString() : null,
  };
}

export async function listar(filtros: FiltrosLogistica = {}, alcance: AlcanceResuelto = { enlace: 'ninguno' }): Promise<ListadoLogistica> {
  const page = Math.max(1, Math.floor(filtros.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(filtros.pageSize ?? 50)));
  const conds = construirCondiciones(filtros);
  const porAlcance = condicionTramitesLogistica(alcance); // HU #13426: página y COUNT
  if (porAlcance) conds.push(porAlcance);

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
  tipo: string | null;
}
/** Bitácora de la LT (CA-07): cada transición con actor, hora y ubicación. */
export async function eventos(documentoId: string): Promise<EventoDocumento[]> {
  const rows = await db.select({
    id: flitoLogisticaEventos.id, estadoAnterior: flitoLogisticaEventos.estadoAnterior,
    estadoNuevo: flitoLogisticaEventos.estadoNuevo, actorNombre: users.name,
    lat: flitoLogisticaEventos.lat, lng: flitoLogisticaEventos.lng, motivo: flitoLogisticaEventos.motivo,
    origen: flitoLogisticaEventos.origen, creadoEn: flitoLogisticaEventos.createdAt,
    tipo: flitoLogisticaEventos.tipo,
  }).from(flitoLogisticaEventos)
    .leftJoin(users, eq(flitoLogisticaEventos.actorId, users.id))
    .where(eq(flitoLogisticaEventos.documentoId, documentoId))
    .orderBy(desc(flitoLogisticaEventos.createdAt));
  return rows.map((r) => ({ ...r, tipo: tipoEventoEfectivo(r.tipo, r.estadoNuevo), creadoEn: r.creadoEn.toISOString() }));
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

// ── Facetas para los filtros de la consola ───────────────────────────────────

export interface FacetasLogistica {
  estados: string[];
  empresas: Array<{ nit: string; nombre: string | null }>;
  organismos: Array<{ codigo: string; nombre: string | null }>;
  companiasCerrables: CompaniaCerrableLogistica[];
  mensajeros: Array<{ id: number; nombre: string }>;
}

type DocCerrableRow = {
  documentoId: string; placa: string | null; numeroLt: string | null; idFlit: string | null;
  companiaId: number | null; nombre: string | null;
};

function agruparCerrables(rows: DocCerrableRow[]): CompaniaCerrableLogistica[] {
  const porCompania = new Map<number, CompaniaCerrableLogistica>();
  for (const r of rows) {
    if (r.companiaId == null) continue;
    let g = porCompania.get(r.companiaId);
    if (!g) {
      g = { companiaId: r.companiaId, nombre: r.nombre, disponibles: 0, precioEntregaCliente: null, precioEntregaFlit: null, lts: [] };
      porCompania.set(r.companiaId, g);
    }
    g.lts.push({ documentoId: r.documentoId, placa: r.placa, numeroLt: r.numeroLt, idFlit: r.idFlit });
    g.disponibles = g.lts.length;
  }
  return [...porCompania.values()];
}

/** Función que deja operar actas de otros (HU #13425). Sin ella, cada usuario solo opera las suyas. */
export const FUNCION_OPERAR_AJENAS = 'logistica.actas.operar_ajenas';

/**
 * Candidatos a mensajero de un acta (HU #13425): usuarios activos que entregan actas y NO operan las
 * ajenas — hoy, exactamente los del rol `mensajero` —, decidido por sus funciones efectivas.
 */
async function mensajerosAsignables(): Promise<Array<{ id: number; nombre: string }>> {
  const ids = await usuariosConFuncion('logistica.actas.entregar', { sin: FUNCION_OPERAR_AJENAS });
  if (ids.length === 0) return [];
  return db.select({ id: users.id, nombre: users.name }).from(users)
    .where(and(inArray(users.id, ids), isNull(users.deletedAt)));
}

export async function facetas(alcance: AlcanceResuelto = { enlace: 'ninguno' }): Promise<FacetasLogistica> {
  // Todas las facetas se restringen a compañías gestionadas por FLITO (logisticaAutogestionable = false).
  // HU #13426 (AC7): y al alcance del enlace; los mensajeros (personal de FLITO) no se listan a una compañía.
  const gestionable = and(eq(clients.logisticaAutogestionable, false), condicionTramitesLogistica(alcance))!;
  const gestionableDocs = and(eq(clients.logisticaAutogestionable, false), condicionDocumentosLogistica(alcance))!;
  const [empresas, organismos, docsCerrables, mensajeros] = await Promise.all([
    db.selectDistinct({ nit: flitoTramites.companiaNit, nombre: clients.name })
      .from(flitoTramites).leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
      .where(and(aprobadoSql, gestionable, sql`${flitoTramites.companiaNit} is not null`)),
    db.selectDistinct({ codigo: flitoTramites.organismoCodigo, nombre: organismosTransitoConfig.alias })
      .from(flitoTramites)
      .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
      .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
      .where(and(aprobadoSql, gestionable, sql`${flitoTramites.organismoCodigo} is not null`)),
    db.select({
      documentoId: flitoLogisticaDocumentos.id,
      placa: flitoLogisticaDocumentos.identificador,
      numeroLt: flitoLogisticaDocumentos.numeroLt,
      idFlit: flitoTramites.idFlit,
      companiaId: flitoLogisticaDocumentos.companiaId,
      nombre: clients.name,
    }).from(flitoLogisticaDocumentos)
      .leftJoin(clients, eq(flitoLogisticaDocumentos.companiaId, clients.id))
      .leftJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id))
      .where(and(
        eq(flitoLogisticaDocumentos.estado, EstadoDocumentoLogistica.CLASIFICADO),
        gestionableDocs,
        sql`${flitoLogisticaDocumentos.companiaId} is not null`,
      )),
    // HU #13425: asignable = quien entrega actas y NO opera las ajenas (hoy: el rol mensajero), leído
    // de sus funciones efectivas y no del nombre del rol.
    alcance.enlace === 'ninguno' ? mensajerosAsignables() : Promise.resolve([]),
  ]);
  const grupos = agruparCerrables(docsCerrables);
  const ahora = new Date();
  // Misma `ahora` para cliente y FLIT. Orden por compañía: cliente (i*2), luego flit (i*2+1).
  const precios = await Promise.all(grupos.flatMap((g) => [
    precioTrasladoDe(g.companiaId, 'cliente', ahora),
    precioTrasladoDe(g.companiaId, 'flit', ahora),
  ]));
  for (let i = 0; i < grupos.length; i++) {
    const cliente = precios[i * 2];
    const flit = precios[i * 2 + 1];
    grupos[i]!.precioEntregaCliente = cliente == null ? null : cliente.valor;
    grupos[i]!.precioEntregaFlit = flit == null ? null : flit.valor;
  }
  return {
    // Vocabulario SIMPLE (5 estados) para los filtros de la consola.
    estados: [EstadoLogisticaSimple.PENDIENTE, EstadoLogisticaSimple.REGISTRADA,
      EstadoLogisticaSimple.DESPACHADA, EstadoLogisticaSimple.ENTREGADA, EstadoLogisticaSimple.NOVEDAD],
    empresas: empresas.filter((e): e is { nit: string; nombre: string | null } => !!e.nit),
    organismos: organismos.filter((o): o is { codigo: string; nombre: string | null } => !!o.codigo),
    companiasCerrables: grupos,
    mensajeros,
  };
}

// ── Listado de actas (panel de despacho/entrega) ─────────────────────────────

// HU #14109: `companiaId` es NULL solo en el acta de organismo (multi-compañía).
export interface ActaFila {
  id: string; companiaId: number | null; companiaNombre: string | null; estado: string; estadoLabel: string;
  mensajeroId: number | null; mensajeroNombre: string | null; documentos: number;
  receptorNombre: string | null; entregadoEn: string | null; creadoEn: string;
  /** Destino del acta (`flito_logistica_actas.punto`). HU #14123. */
  punto: 'organismo' | 'flit' | 'cliente';
  /** Viaje que originó el acta. Null en actas anteriores al viaje. No se omite. */
  trasladoId: string | null;
}
export async function listarActas(alcance: AlcanceResuelto = { enlace: 'ninguno' }): Promise<ActaFila[]> {
  const rows = await db.select({
    id: flitoLogisticaActas.id, companiaId: flitoLogisticaActas.companiaId, companiaNombre: clients.name,
    estado: flitoLogisticaActas.estado, mensajeroId: flitoLogisticaActas.mensajeroId, mensajeroNombre: users.name,
    receptorNombre: flitoLogisticaActas.receptorNombre, entregadoEn: flitoLogisticaActas.entregadoEn,
    creadoEn: flitoLogisticaActas.createdAt, punto: flitoLogisticaActas.punto, trasladoId: flitoLogisticaActas.trasladoId,
    documentos: sql<number>`(select count(*)::int from flito_logistica_documentos d where d.acta_id = ${flitoLogisticaActas.id})`,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .leftJoin(users, eq(flitoLogisticaActas.mensajeroId, users.id))
    // HU #13426 (alcance) + HU #14110 (ADR-0030 §17.1): el acta de organismo se consulta aparte (GET /recogidas/…).
    .where(condicionActasLogistica(alcance) ?? ne(flitoLogisticaActas.punto, 'organismo')) // con enlace la condición ya excluye 'organismo'
    .orderBy(desc(flitoLogisticaActas.createdAt));
  return rows.map((r) => ({
    ...r,
    punto: r.punto as ActaFila['punto'],
    trasladoId: r.trasladoId ?? null,
    estadoLabel: ESTADO_ACTA_LOGISTICA_LABEL[r.estado as keyof typeof ESTADO_ACTA_LOGISTICA_LABEL] ?? r.estado,
    entregadoEn: r.entregadoEn ? r.entregadoEn.toISOString() : null,
    creadoEn: r.creadoEn.toISOString(),
  }));
}

// ── Ruta del mensajero (PWA de campo, CA-11) ─────────────────────────────────

export interface RutaDocumento { id: string; placa: string | null; idFlit: string | null; numeroLt: string | null }
export interface RutaEntrega {
  actaId: string; companiaNombre: string | null; direccionEntrega: string | null;
  contactoNombre: string | null; documentos: RutaDocumento[];
  /** El `punto` del acta, expuesto como destino. El WHERE ya excluye `organismo`. */
  destino: 'cliente' | 'flit';
  trasladoId: string | null;
}
export interface MiRuta { entregas: RutaEntrega[] }

/**
 * Ruta del mensajero: entregas (actas 'despachada'). La RECOGIDA ya no es una lista pre-cargada:
 * ocurre escaneando la LT en el organismo (POST /escanear). Un mensajero solo ve SUS actas (CA-11);
 * admin ve todas (seguimiento).
 */
export async function miRuta(ctx: LogisticaCtx): Promise<MiRuta> {
  const soloMias = !ctx.operaAjenas;
  const actaCond = soloMias
    ? and(eq(flitoLogisticaActas.estado, EstadoActaLogistica.DESPACHADA), ne(flitoLogisticaActas.punto, 'organismo'), eq(flitoLogisticaActas.mensajeroId, ctx.userId))
    : and(eq(flitoLogisticaActas.estado, EstadoActaLogistica.DESPACHADA), ne(flitoLogisticaActas.punto, 'organismo'));
  const actas = await db.select({
    actaId: flitoLogisticaActas.id, companiaNombre: clients.name,
    direccionEntrega: flitoLogisticaActas.direccionEntrega, contactoNombre: flitoLogisticaActas.contactoNombre,
    punto: flitoLogisticaActas.punto, trasladoId: flitoLogisticaActas.trasladoId,
  }).from(flitoLogisticaActas)
    .leftJoin(clients, eq(flitoLogisticaActas.companiaId, clients.id))
    .where(actaCond);

  const entregas: RutaEntrega[] = [];
  for (const a of actas) {
    const docs = await db.select({
      id: flitoLogisticaDocumentos.id, placa: vehicles.plate, idFlit: flitoTramites.idFlit, numeroLt: flitoLogisticaDocumentos.numeroLt,
    }).from(flitoLogisticaDocumentos)
      .leftJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id)) // leftJoin: tramite_id NULLABLE (LT pendiente, ADR-0030 §17.5)
      .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
      .where(eq(flitoLogisticaDocumentos.actaId, a.actaId));
    entregas.push({
      actaId: a.actaId, companiaNombre: a.companiaNombre, direccionEntrega: a.direccionEntrega, contactoNombre: a.contactoNombre,
      destino: a.punto as RutaEntrega['destino'], trasladoId: a.trasladoId ?? null, documentos: docs,
    });
  }
  return { entregas };
}

// ── Detalle del acta (CA-13: filas del acta + bitácora + firmas) ─────────────

export interface ActaLinea { id: string; placa: string | null; secretaria: string | null; propietario: string | null; numeroLicencia: string | null; numeroLt: string | null; estado: string; estadoLabel: string; idFlit: string | null }
export interface ActaEvento { id: string; documentoId: string; placa: string | null; estadoAnterior: string | null; estadoNuevo: string; actorNombre: string | null; motivo: string | null; origen: string; creadoEn: string; tipo: string | null }
export interface ActaDetalle {
  /** 'organismo' | 'flit' | 'cliente' (HU #14110: el acta de organismo se completa con firmas y líneas en la ruta). */
  punto?: string;
  acta: ActaFila; tienePdf: boolean; firmaEntrega: boolean; firmaRecibe: boolean; entregaNombre: string | null;
  documentos: ActaLinea[]; bitacora: ActaEvento[];
}

export async function actaDetalle(actaId: string): Promise<ActaDetalle> {
  const [cab] = await db.select({
    id: flitoLogisticaActas.id, companiaId: flitoLogisticaActas.companiaId, companiaNombre: clients.name,
    estado: flitoLogisticaActas.estado, mensajeroId: flitoLogisticaActas.mensajeroId, mensajeroNombre: users.name,
    receptorNombre: flitoLogisticaActas.receptorNombre, entregadoEn: flitoLogisticaActas.entregadoEn,
    creadoEn: flitoLogisticaActas.createdAt, pdfStorageKey: flitoLogisticaActas.pdfStorageKey,
    trasladoId: flitoLogisticaActas.trasladoId,
    firmaEntregaKey: flitoLogisticaActas.firmaEntregaStorageKey, entregaNombre: flitoLogisticaActas.entregaNombre,
    firmaRecibeKey: flitoLogisticaActas.firmaStorageKey, punto: flitoLogisticaActas.punto,
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
    .leftJoin(flitoTramites, eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id)) // leftJoin: tramite_id NULLABLE (LT pendiente, ADR-0030 §17.5)
    .innerJoin(vehicles, eq(flitoLogisticaDocumentos.vehiculoId, vehicles.id))
    .leftJoin(organismosTransitoConfig, eq(flitoLogisticaDocumentos.organismoCodigo, organismosTransitoConfig.codigo))
    .where(eq(flitoLogisticaDocumentos.actaId, actaId));

  const bitacora = await db.select({
    id: flitoLogisticaEventos.id, documentoId: flitoLogisticaEventos.documentoId, placa: vehicles.plate,
    estadoAnterior: flitoLogisticaEventos.estadoAnterior, estadoNuevo: flitoLogisticaEventos.estadoNuevo,
    actorNombre: users.name, motivo: flitoLogisticaEventos.motivo, origen: flitoLogisticaEventos.origen,
    creadoEn: flitoLogisticaEventos.createdAt, tipo: flitoLogisticaEventos.tipo,
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
    punto: cab.punto as ActaFila['punto'], trasladoId: cab.trasladoId ?? null,
  };
  return {
    ...(cab.punto ? { punto: cab.punto } : {}),
    acta, tienePdf: cab.pdfStorageKey !== null,
    firmaEntrega: cab.firmaEntregaKey !== null, firmaRecibe: cab.firmaRecibeKey !== null, entregaNombre: cab.entregaNombre,
    documentos: docs.map((d) => ({
      id: d.id, placa: d.placa, secretaria: d.secretaria, propietario: d.propietario,
      numeroLicencia: d.numeroLicencia, numeroLt: d.numeroLt,
      estado: d.estado, estadoLabel: ESTADO_DOCUMENTO_LOGISTICA_LABEL[d.estado as TEstadoDoc] ?? d.estado, idFlit: d.idFlit,
    })),
    bitacora: bitacora.map((e) => ({ ...e, tipo: tipoEventoEfectivo(e.tipo, e.estadoNuevo), creadoEn: e.creadoEn.toISOString() })),
  };
}

// ── Línea de tiempo (HU #14124) ──────────────────────────────────────────────
// Lectura del recorrido de UNA LT. No toca `tipoEventoEfectivo` ni el mapa de estados.
// El payload solo se lee aquí, para resolver `motivoLlegadaId`; no sale en el DTO.

const UUID_TEXTO = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * Motivo del hito: la columna `motivo` si trae texto. Si viene vacía y `payload.motivoLlegadaId`
 * es un uuid del catálogo, el nombre (aunque el motivo esté inactivo). Id que no resuelve → null.
 * El cast va detrás del formato: un jsonb sucio no puede convertirse en 22P02. La nota libre no sale.
 */
function motivoDeHito(): SQL<string | null> {
  const idTexto = sql`${flitoLogisticaEventos.payload}->>'motivoLlegadaId'`;
  const idUuid = sql`CASE WHEN (${idTexto}) ~ ${UUID_TEXTO} THEN (${idTexto})::uuid ELSE NULL END`;
  return sql<string | null>`CASE
    WHEN btrim(coalesce(${flitoLogisticaEventos.motivo}, '')) <> '' THEN ${flitoLogisticaEventos.motivo}
    ELSE (
      SELECT ${flitoLogisticaMotivosLlegada.nombre}
      FROM ${flitoLogisticaMotivosLlegada}
      WHERE ${flitoLogisticaMotivosLlegada.id} = (${idUuid})
      LIMIT 1
    )
  END`;
}

async function hitosDe(documentoId: string): Promise<HitoLineaTiempoLogistica[]> {
  const rows = await db.select({
    id: flitoLogisticaEventos.id,
    tipo: flitoLogisticaEventos.tipo,
    fecha: flitoLogisticaEventos.createdAt,
    actorNombre: users.name,
    destino: flitoLogisticaEventos.destino,
    motivo: motivoDeHito(),
    estadoNuevo: flitoLogisticaEventos.estadoNuevo,
  }).from(flitoLogisticaEventos)
    .leftJoin(users, eq(flitoLogisticaEventos.actorId, users.id))
    .where(eq(flitoLogisticaEventos.documentoId, documentoId))
    .orderBy(desc(flitoLogisticaEventos.createdAt));
  return rows.map((r) => ({
    id: r.id,
    tipo: tipoEventoEfectivo(r.tipo, r.estadoNuevo),
    fecha: r.fecha.toISOString(),
    actorNombre: r.actorNombre,
    destino: r.destino,
    motivo: r.motivo,
    estadoNuevo: r.estadoNuevo,
  }));
}

/** Eventos de esa LT, también si sigue pendiente de trámite (`tramiteId` null). */
export async function lineaTiempoDocumento(documentoId: string): Promise<LineaTiempoLogistica> {
  const [doc] = await db.select({
    id: flitoLogisticaDocumentos.id,
    tramiteId: flitoLogisticaDocumentos.tramiteId,
  }).from(flitoLogisticaDocumentos)
    .where(and(eq(flitoLogisticaDocumentos.id, documentoId), eq(flitoLogisticaDocumentos.tipo, LT)))
    .limit(1);
  if (!doc) throw new LogisticaError('La LT no existe', 404);
  return { documentoId: doc.id, tramiteId: doc.tramiteId, hitos: await hitosDe(doc.id) };
}

/** La LT `licencia_transito` de ese trámite. Sin LT todavía: 200 con hitos vacíos. */
export async function lineaTiempoTramite(tramiteId: string): Promise<LineaTiempoLogistica> {
  const [row] = await db.select({
    tramiteId: flitoTramites.id,
    documentoId: flitoLogisticaDocumentos.id,
  }).from(flitoTramites)
    .leftJoin(flitoLogisticaDocumentos, and(
      eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id),
      eq(flitoLogisticaDocumentos.tipo, LT),
    ))
    .where(eq(flitoTramites.id, tramiteId))
    .limit(1);
  if (!row) throw new LogisticaError('El trámite no existe', 404);
  if (!row.documentoId) return { documentoId: null, tramiteId: row.tramiteId, hitos: [] };
  return { documentoId: row.documentoId, tramiteId: row.tramiteId, hitos: await hitosDe(row.documentoId) };
}
