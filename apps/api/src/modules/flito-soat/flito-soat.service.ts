// FLITO — SOAT (lógica). Portado de packages/server/src/soat/soat.servicio.ts sobre el
// stack del grande, operando sobre la tabla flito_soat (que la sincronización ya puebla).
// COEXISTE con el módulo legacy modules/soat (soat_requests): shadow-run, sin tocarlo.
//
// Fase 2: workflow completo (cola, envío atómico, estados, aislamiento). La carga de factura
// (única vía a Pagado, RN-03) depende del OCR y llega en la Fase 3 (marcarPagado se exporta
// para ese uso). Las reglas caras: 3 fronteras de la cola (CA-01/CA-09), envío atómico (CA-04),
// aislamiento 404-no-403 (CA-09), RN-05/RN-06.

import { createHash } from 'crypto';
import JSZip from 'jszip';
import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs,
  clients,
  flitoCompradores,
  flitoProveedoresSoat,
  flitoRevisiones,
  flitoSoat,
  flitoSoportes,
  flitoTramites,
  organismosTransitoConfig,
  users,
  vehicles,
} from '../../db/schema.js';
import {
  CampoSoat,
  CAMPOS_SOAT_EXTRAIDOS_SIN_EXIGIR,
  ESTADO_SOAT_LABEL,
  ESTADOS_SOAT_VISIBLES_GESTOR,
  EstadoSoat,
  FlujoRevision,
  MotivoRevision,
  TipoPropiedad,
  type ExtraccionSoat,
} from '@operaciones/shared-types';
import { extraerFacturaSoat, placaDesdeNombre, type DocumentoAAnalizar } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';

export interface SoatCtx {
  userId: number;
  username: string;
  role: string;
  proveedorSoatId: string | null;
}

/**
 * Resuelve la atadura de visibilidad del gestor desde la BD (no del JWT): §9.3. Un cambio de
 * proveedor de un gestor surte efecto sin re-emitir token. Para el resto de roles es null.
 */
export async function contextoSoat(user: { sub: number; username: string; role: string }): Promise<SoatCtx> {
  let proveedorSoatId: string | null = null;
  if (user.role === 'proveedor') {
    const [u] = await db.select({ p: users.flitoProveedorSoatId }).from(users).where(eq(users.id, user.sub)).limit(1);
    proveedorSoatId = u?.p ?? null;
  }
  return { userId: user.sub, username: user.username, role: user.role, proveedorSoatId };
}

const esGestor = (ctx: SoatCtx) => ctx.role === 'proveedor';

// ───────────────────────────── Cola (3 fronteras) ───────────────────────────

export interface SoatColaItem {
  id: string;
  vin: string;
  placa: string | null;
  marca: string | null;
  linea: string | null;
  estado: EstadoSoat;
  tipoPropiedad: TipoPropiedad;
  esMultiplePropietario: boolean;
  companiaNombre: string;
  organismoNombre: string | null;
  proveedorSoatId: string | null;
  proveedorSoatNombre: string | null;
  compradores: Array<{ nombreCompleto: string; numeroDocumento: string; orden: number; porcentajeParticipacion: number | null }>;
  tramitesFlit: string[];
  enviadoPorNombre: string | null;
  enviadoEn: string | null;
  valorPagado: number | null;
  estancado: boolean;
  motivoRechazo: string | null;
  creadoEn: string;
}

/**
 * Cola de SOAT con las 3 fronteras innegociables:
 *   1. Compañías que autogestionan SOAT se excluyen SIEMPRE (CA-01) — filtro en la consulta.
 *   2. Un gestor solo ve lo de su proveedor (CA-09) — filtro aquí, no en la UI.
 *   3. Un gestor NUNCA ve los Pendiente — se intersecta lo pedido con lo permitido.
 */
export async function cola(ctx: SoatCtx, estados?: EstadoSoat[], buscar?: string): Promise<SoatColaItem[]> {
  const conds = [eq(clients.soatAutogestionable, false)];

  if (esGestor(ctx)) {
    if (!ctx.proveedorSoatId) return []; // sin proveedor no hay frontera que aplicar → nada
    conds.push(eq(flitoSoat.proveedorSoatId, ctx.proveedorSoatId));
    const visibles = estados?.length
      ? estados.filter((e) => (ESTADOS_SOAT_VISIBLES_GESTOR as readonly string[]).includes(e))
      : [EstadoSoat.SOLICITADO];
    if (visibles.length === 0) return [];
    conds.push(inArray(flitoSoat.estado, visibles));
  } else if (estados?.length) {
    conds.push(inArray(flitoSoat.estado, estados));
  }

  const termino = buscar?.trim();
  if (termino) {
    const term = termino.toUpperCase();
    const termNoSep = `%${term.replace(/[\s-]/g, '')}%`;
    const termTexto = `%${term}%`;
    conds.push(
      or(
        sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${termNoSep}`,
        sql`UPPER(${vehicles.vin}) LIKE ${termNoSep}`,
        sql`EXISTS (SELECT 1 FROM ${flitoTramites} ft JOIN ${flitoCompradores} fc ON fc.tramite_id = ft.id
              WHERE ft.soat_id = ${flitoSoat.id}
                AND (UPPER(fc.nombre_completo) LIKE ${termTexto} OR fc.numero_documento LIKE ${termTexto}))`,
      )!,
    );
  }

  const rows = await db
    .select({
      id: flitoSoat.id,
      vin: flitoSoat.vin,
      estado: flitoSoat.estado,
      proveedorSoatId: flitoSoat.proveedorSoatId,
      enviadoEn: flitoSoat.enviadoEn,
      pagadoEn: flitoSoat.pagadoEn,
      valorPagado: flitoSoat.valorPagado,
      motivoRechazo: flitoSoat.motivoRechazo,
      createdAt: flitoSoat.createdAt,
      placa: vehicles.plate,
      marca: vehicles.brand,
      linea: vehicles.model,
      companiaNombre: clients.name,
      organismoNombre: organismosTransitoConfig.alias,
      proveedorSoatNombre: flitoProveedoresSoat.nombre,
      proveedorSlaHoras: flitoProveedoresSoat.slaHoras,
      enviadoPorNombre: users.name,
    })
    .from(flitoSoat)
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .innerJoin(organismosTransitoConfig, eq(flitoSoat.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .leftJoin(users, eq(flitoSoat.enviadoPorId, users.id))
    .where(and(...conds))
    .orderBy(asc(flitoSoat.createdAt)); // prioridad por antigüedad

  return ensamblarCola(rows);
}

type ColaRow = {
  id: string; vin: string; estado: string; proveedorSoatId: string | null; enviadoEn: Date | null;
  pagadoEn: Date | null; valorPagado: string | null; motivoRechazo: string | null; createdAt: Date;
  placa: string | null; marca: string | null; linea: string | null; companiaNombre: string;
  organismoNombre: string | null; proveedorSoatNombre: string | null; proveedorSlaHoras: number | null;
  enviadoPorNombre: string | null;
};

async function ensamblarCola(rows: ColaRow[]): Promise<SoatColaItem[]> {
  const ids = rows.map((r) => r.id);
  const tramites = ids.length
    ? await db.select({ id: flitoTramites.id, soatId: flitoTramites.soatId, idFlit: flitoTramites.idFlit, tipoPropiedad: flitoTramites.tipoPropiedad })
        .from(flitoTramites).where(inArray(flitoTramites.soatId, ids))
    : [];
  const tramiteIds = tramites.map((t) => t.id);
  const compradores = tramiteIds.length
    ? await db.select().from(flitoCompradores).where(inArray(flitoCompradores.tramiteId, tramiteIds)).orderBy(asc(flitoCompradores.orden))
    : [];

  const compsPorTramite = new Map<string, typeof compradores>();
  for (const c of compradores) {
    const arr = compsPorTramite.get(c.tramiteId) ?? [];
    arr.push(c); compsPorTramite.set(c.tramiteId, arr);
  }
  const tramitesPorSoat = new Map<string, typeof tramites>();
  for (const t of tramites) {
    if (!t.soatId) continue;
    const arr = tramitesPorSoat.get(t.soatId) ?? [];
    arr.push(t); tramitesPorSoat.set(t.soatId, arr);
  }

  return rows.map((r) => {
    const ts = tramitesPorSoat.get(r.id) ?? [];
    const comps = ts.flatMap((t) => compsPorTramite.get(t.id) ?? []).sort((a, b) => a.orden - b.orden);
    const esMultiple = ts.some((t) => t.tipoPropiedad === TipoPropiedad.MULTIPLE_PROPIETARIO);
    return {
      id: r.id, vin: r.vin, placa: r.placa, marca: r.marca, linea: r.linea,
      estado: r.estado as EstadoSoat,
      tipoPropiedad: esMultiple ? TipoPropiedad.MULTIPLE_PROPIETARIO : TipoPropiedad.UNICO_PROPIETARIO,
      esMultiplePropietario: esMultiple,
      companiaNombre: r.companiaNombre,
      organismoNombre: r.organismoNombre,
      proveedorSoatId: r.proveedorSoatId,
      proveedorSoatNombre: r.proveedorSoatNombre,
      compradores: comps.map((c) => ({ nombreCompleto: c.nombreCompleto, numeroDocumento: c.numeroDocumento, orden: c.orden, porcentajeParticipacion: c.porcentajeParticipacion === null ? null : Number(c.porcentajeParticipacion) })),
      tramitesFlit: ts.map((t) => t.idFlit),
      enviadoPorNombre: r.enviadoPorNombre,
      enviadoEn: r.enviadoEn ? r.enviadoEn.toISOString() : null,
      valorPagado: r.valorPagado === null ? null : Number(r.valorPagado),
      estancado: estaEstancado(r.estado, r.enviadoEn, r.proveedorSlaHoras),
      motivoRechazo: r.motivoRechazo,
      creadoEn: r.createdAt.toISOString(),
    };
  });
}

/** SLA del proveedor vencido. Sin SLA configurado no hay estancamiento posible. */
function estaEstancado(estado: string, enviadoEn: Date | null, slaHoras: number | null): boolean {
  if (estado !== EstadoSoat.SOLICITADO || !slaHoras || !enviadoEn) return false;
  return (Date.now() - enviadoEn.getTime()) / 3_600_000 > slaHoras;
}

// ───────────────────────────── Detalle + acceso (404-no-403) ────────────────

/**
 * Busca un SOAT aplicando la frontera del gestor. Devuelve NULL (→ 404), no 403, cuando el
 * registro es de otro proveedor, autogestionado, o en un estado no visible para el gestor:
 * CA-09 dice que el gestor no obtiene datos ajenos "ni consultando por ID directo", y un 403
 * ya es un dato (confirma que el id existe).
 */
export async function buscarConAcceso(id: string, ctx: SoatCtx): Promise<typeof flitoSoat.$inferSelect | null> {
  const [soat] = await db
    .select({ soat: flitoSoat, soatAutogestionable: clients.soatAutogestionable })
    .from(flitoSoat)
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .where(eq(flitoSoat.id, id))
    .limit(1);
  if (!soat) return null;
  if (soat.soatAutogestionable) return null;
  if (esGestor(ctx)) {
    if (soat.soat.proveedorSoatId !== ctx.proveedorSoatId) return null;
    if (!(ESTADOS_SOAT_VISIBLES_GESTOR as readonly string[]).includes(soat.soat.estado)) return null;
  }
  return soat.soat;
}

export async function detalle(id: string, ctx: SoatCtx): Promise<(SoatColaItem & { extraccion: unknown; pagadoEn: string | null }) | null> {
  const soat = await buscarConAcceso(id, ctx); // valida la frontera del gestor (404-no-403)
  if (!soat) return null;

  const rows = await db
    .select({
      id: flitoSoat.id, vin: flitoSoat.vin, estado: flitoSoat.estado, proveedorSoatId: flitoSoat.proveedorSoatId,
      enviadoEn: flitoSoat.enviadoEn, pagadoEn: flitoSoat.pagadoEn, valorPagado: flitoSoat.valorPagado,
      motivoRechazo: flitoSoat.motivoRechazo, createdAt: flitoSoat.createdAt,
      placa: vehicles.plate, marca: vehicles.brand, linea: vehicles.model,
      companiaNombre: clients.name, organismoNombre: organismosTransitoConfig.alias,
      proveedorSoatNombre: flitoProveedoresSoat.nombre, proveedorSlaHoras: flitoProveedoresSoat.slaHoras,
      enviadoPorNombre: users.name,
    })
    .from(flitoSoat)
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .innerJoin(organismosTransitoConfig, eq(flitoSoat.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .leftJoin(users, eq(flitoSoat.enviadoPorId, users.id))
    .where(eq(flitoSoat.id, id))
    .limit(1);

  const [item] = await ensamblarCola(rows);
  if (!item) return null;
  return { ...item, extraccion: soat.extraccion, pagadoEn: soat.pagadoEn ? soat.pagadoEn.toISOString() : null };
}

// ───────────────────────────── Envío atómico (CA-04) ────────────────────────

export interface ResultadoEnvio { enviados: string[]; yaEnviados: string[] }

/**
 * Envía SOAT al gestor: Pendiente → En adquisición. Solo Operaciones. La atomicidad es
 * obligatoria (CA-04): con dos usuarios despachando la misma cola, leer-luego-escribir deja
 * que ambos envíen el mismo registro. `SELECT ... FOR UPDATE OF s SKIP LOCKED` hace que el
 * segundo no vea la fila que el primero bloqueó. El proveedor se fija en el mismo movimiento.
 */
export async function enviarAlGestor(ids: string[], ctx: SoatCtx, proveedorSoatId?: string): Promise<ResultadoEnvio> {
  if (ids.length === 0) return { enviados: [], yaEnviados: [] };

  const enviados = await db.transaction(async (tx) => {
    // FOR UPDATE OF flito_soat SKIP LOCKED: el segundo usuario que envíe el mismo registro no
    // ve la fila que el primero bloqueó (CA-04). Solo bloquea flito_soat (no clients).
    const locked = await tx
      .select({ id: flitoSoat.id })
      .from(flitoSoat)
      .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
      .where(and(
        inArray(flitoSoat.id, ids),
        eq(flitoSoat.estado, EstadoSoat.PENDIENTE),
        eq(clients.soatAutogestionable, false),
      ))
      .for('update', { of: flitoSoat, skipLocked: true });
    const idsEnviados = locked.map((r) => r.id);
    if (idsEnviados.length === 0) return [];

    await tx.update(flitoSoat).set({
      estado: EstadoSoat.SOLICITADO,
      enviadoPorId: ctx.userId,
      enviadoEn: new Date(),
      updatedAt: new Date(),
      ...(proveedorSoatId ? { proveedorSoatId, proveedorSobrescrito: true } : {}),
    }).where(inArray(flitoSoat.id, idsEnviados));

    return idsEnviados;
  });

  return { enviados, yaEnviados: ids.filter((id) => !enviados.includes(id)) };
}

// ───────────────────────────── Rechazo / reactivación / reversa / proveedor ──

export class SoatError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Rechazo del proveedor (CA-08). Solo desde En adquisición; motivo obligatorio. */
export async function rechazar(id: string, motivo: string, ctx: SoatCtx): Promise<typeof flitoSoat.$inferSelect> {
  const soat = await buscarConAcceso(id, ctx);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado !== EstadoSoat.SOLICITADO) throw new SoatError(400, 'Solo se puede rechazar un SOAT en adquisición');
  if (!motivo?.trim()) throw new SoatError(400, 'El motivo del rechazo es obligatorio');
  const [updated] = await db.update(flitoSoat)
    .set({ estado: EstadoSoat.CON_NOVEDAD, motivoRechazo: motivo.trim(), updatedAt: new Date() })
    .where(eq(flitoSoat.id, id)).returning();
  return updated;
}

/** Devuelve un SOAT rechazado a la cola (CA-08). Solo Operaciones, solo desde Rechazado. */
export async function reactivar(id: string, motivo: string): Promise<typeof flitoSoat.$inferSelect> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado !== EstadoSoat.CON_NOVEDAD) {
    throw new SoatError(400, `Solo un SOAT rechazado vuelve a Pendiente. Este está en "${ESTADO_SOAT_LABEL[soat.estado as EstadoSoat]}".`);
  }
  if (!motivo?.trim()) throw new SoatError(400, 'El motivo de la corrección es obligatorio');
  const [updated] = await db.update(flitoSoat)
    .set({ estado: EstadoSoat.PENDIENTE, enviadoPorId: null, enviadoEn: null, motivoRechazo: null, updatedAt: new Date() })
    .where(eq(flitoSoat.id, id)).returning();
  return updated;
}

/**
 * Reversa de un estado por Operaciones (RN-06). Pagado es terminal, pero terminal no es
 * inmutable: solo Operaciones lo mueve, con justificación (≥5) y rastro. Reversar un pagado es
 * lo único que devuelve un VIN a la cola, por eso no está en ningún camino automático.
 */
export async function reversar(id: string, estadoDestino: EstadoSoat, motivo: string): Promise<typeof flitoSoat.$inferSelect> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (!motivo?.trim() || motivo.trim().length < 5) throw new SoatError(400, 'La reversa exige un motivo que explique el porqué');
  if (soat.estado === estadoDestino) throw new SoatError(400, 'El SOAT ya está en ese estado');

  const limpiar = estadoDestino === EstadoSoat.PENDIENTE
    ? { enviadoPorId: null, enviadoEn: null, pagadoEn: null, valorPagado: null, motivoRechazo: null }
    : {};
  const [updated] = await db.update(flitoSoat)
    .set({ estado: estadoDestino, ...limpiar, updatedAt: new Date() })
    .where(eq(flitoSoat.id, id)).returning();
  return updated;
}

/**
 * Cambio de proveedor sobre un registro puntual (RN-05). Exige reversar a Pendiente antes de
 * cambiar el proveedor de un registro en adquisición: el proveedor determina la estrategia de
 * flujo, y cambiarlo a media adquisición dejaría el registro con un gestor sin acceso.
 */
export async function cambiarProveedor(id: string, proveedorSoatId: string, motivo: string): Promise<{ soat: typeof flitoSoat.$inferSelect; anterior: string | null }> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado === EstadoSoat.SOLICITADO) {
    throw new SoatError(400, 'RN-05: para cambiar el proveedor de un SOAT en adquisición, primero hay que reversarlo a Pendiente con justificación.');
  }
  if (!motivo?.trim()) throw new SoatError(400, 'El motivo del cambio de proveedor es obligatorio');
  const [prov] = await db.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat).where(eq(flitoProveedoresSoat.id, proveedorSoatId)).limit(1);
  if (!prov) throw new SoatError(404, 'El proveedor no existe');

  const anterior = soat.proveedorSoatId;
  const [updated] = await db.update(flitoSoat)
    .set({ proveedorSoatId, proveedorSobrescrito: true, updatedAt: new Date() })
    .where(eq(flitoSoat.id, id)).returning();
  return { soat: updated, anterior };
}

// ═══════════════════════ Carga de factura → Pagado (Fase 3, RN-03) ═══════════
// La factura validada por OCR es la ÚNICA vía a `Pagado` (RN-03): no hay marca manual. El estado es
// consecuencia del soporte, no de un clic. Porta packages/server/src/soat/soat.servicio.ts sobre el
// motor OCR Anthropic (modules/flito-ocr) y el storage S3/MinIO.

export interface ArchivoSubido {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** Campos que sí bloquean el avance a Pagado. Vigencia/expedición NO están (D-7): se leen sin exigir. */
const CAMPOS_REQUERIDOS_SOAT: readonly CampoSoat[] = [
  CampoSoat.NUMERO_POLIZA, CampoSoat.VALOR_TOTAL, CampoSoat.ASEGURADORA,
];

const normalizarLlave = (v: string | null | undefined): string => (v ?? '').toUpperCase().replace(/[\s-]/g, '');

export interface Veredicto { aprobada: boolean; motivo?: MotivoRevision; detalle?: string }

/**
 * Decide si la extracción alcanza para cerrar sin humano. Tres condiciones EN ORDEN, porque el
 * motivo cambia el mensaje y la acción: (1) que haya llave leída, (2) que la llave cruce con ESTE
 * registro, (3) que la llave y los campos requeridos superen el umbral. Compara `confianza` numérica
 * contra el umbral (no el flag `confiable`), para que reevaluar con otro umbral —el del proveedor en
 * la carga masiva— dé el resultado correcto. RN-04/CA-06.
 */
export function evaluarExtraccionSoat(
  extraccion: ExtraccionSoat,
  esperado: { vin: string; placa: string | null },
  umbral: number,
): Veredicto {
  const placa = extraccion[CampoSoat.PLACA];
  const vin = extraccion[CampoSoat.VIN];

  if (!placa?.valor && !vin?.valor) {
    return { aprobada: false, motivo: MotivoRevision.SIN_LLAVE_DE_CRUCE,
      detalle: 'La factura no permitió leer ni placa ni VIN, así que no se puede saber a qué vehículo pertenece.' };
  }

  const placaCruza = !!placa?.valor && normalizarLlave(placa.valor) === normalizarLlave(esperado.placa);
  const vinCruza = !!vin?.valor && normalizarLlave(vin.valor) === normalizarLlave(esperado.vin);
  if (!placaCruza && !vinCruza) {
    return { aprobada: false, motivo: MotivoRevision.LLAVE_NO_CRUZA,
      detalle: `La factura dice placa "${placa?.valor ?? '—'}" / VIN "${vin?.valor ?? '—'}", pero el registro es placa ${esperado.placa ?? '—'} / VIN ${esperado.vin}.` };
  }

  const llaveConfiable = (placaCruza && placa!.confianza >= umbral) || (vinCruza && vin!.confianza >= umbral);
  const dudosos = CAMPOS_REQUERIDOS_SOAT.filter((c) => {
    const e = extraccion[c];
    return !e || e.valor === null || e.confianza < umbral;
  });

  if (!llaveConfiable || dudosos.length > 0) {
    const faltantes = dudosos.length > 0 ? dudosos.join(', ') : 'la llave de cruce';
    return { aprobada: false, motivo: MotivoRevision.CONFIANZA_INSUFICIENTE,
      detalle: `La lectura no superó el umbral de ${umbral} en: ${faltantes}.` };
  }
  return { aprobada: true };
}

// Tx de drizzle (mismo truco de tipado que flito-sync: no hay alias exportado).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const TIPO_FACTURA_SOAT = 'factura_soat';

/** Bitácora en la MISMA tx que el cambio, con la identidad del actor. Trazabilidad atómica del pago. */
async function auditEnTx(tx: Tx, ctx: SoatCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({
    userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_soat', resourceId, detail,
  });
}

/**
 * Lleva el SOAT a `Pagado` dentro de una tx. Es el ÚNICO punto que escribe `pagado` (RN-03): revalida
 * que exista factura (belt-and-suspenders CA-11), copia el valor DESDE la factura (no de un cálculo)
 * y registra en bitácora qué campos no exigidos pasaron sin ser confiables (D-7), por si mañana se
 * quiere alertar sobre pólizas por vencer.
 */
async function pagarEnTx(tx: Tx, soatId: string, vin: string, estadoAnterior: EstadoSoat, extraccion: ExtraccionSoat, ctx: SoatCtx, soporteId: string | null): Promise<void> {
  const [{ n }] = await tx.select({ n: count() }).from(flitoSoportes)
    .where(and(eq(flitoSoportes.soatId, soatId), eq(flitoSoportes.tipo, TIPO_FACTURA_SOAT), eq(flitoSoportes.descartado, false)));
  if (Number(n) === 0) throw new SoatError(400, 'No se puede marcar pagado un SOAT sin factura cargada');

  const valorTotal = extraccion[CampoSoat.VALOR_TOTAL]?.valor ?? null;
  await tx.update(flitoSoat).set({
    estado: EstadoSoat.PAGADO,
    extraccion,
    valorPagado: valorTotal, // numeric acepta el string ya normalizado a pesos enteros
    pagadoEn: new Date(),
    motivoRechazo: null,
    updatedAt: new Date(),
  }).where(eq(flitoSoat.id, soatId));

  const noExigidosSinLeer = CAMPOS_SOAT_EXTRAIDOS_SIN_EXIGIR.filter((c) => !extraccion[c]?.confiable);
  await auditEnTx(tx, ctx, soatId,
    `Pago confirmado por factura (${estadoAnterior}→pagado). Valor ${valorTotal ?? '—'}, ` +
    `póliza ${extraccion[CampoSoat.NUMERO_POLIZA]?.valor ?? '—'}, aseguradora ${extraccion[CampoSoat.ASEGURADORA]?.valor ?? '—'}` +
    `${soporteId ? `, soporte ${soporteId}` : ''}. VIN ${vin}.` +
    (noExigidosSinLeer.length ? ` No exigidos sin leer: ${noExigidosSinLeer.join(', ')}.` : ''));
}

/**
 * Marca pagado un SOAT desde una extracción ya validada, en su propia tx. Exportada (§9.2) para usos
 * fuera de la carga directa; la carga usa `pagarEnTx` para hacer soporte+pago atómicos.
 */
export async function marcarPagado(soatId: string, extraccion: ExtraccionSoat, ctx: SoatCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const [soat] = await tx.select().from(flitoSoat).where(eq(flitoSoat.id, soatId)).limit(1);
    if (!soat) throw new SoatError(404, 'El SOAT no existe');
    const [sop] = await tx.select({ id: flitoSoportes.id }).from(flitoSoportes)
      .where(and(eq(flitoSoportes.soatId, soatId), eq(flitoSoportes.tipo, TIPO_FACTURA_SOAT), eq(flitoSoportes.descartado, false)))
      .orderBy(desc(flitoSoportes.subidoEn)).limit(1);
    await pagarEnTx(tx, soat.id, soat.vin, soat.estado as EstadoSoat, extraccion, ctx, sop?.id ?? null);
  });
}

// Datos de un SOAT necesarios para leer y archivar su factura: llave, compañía (carpeta S3) y umbral.
interface DatosCarga {
  soatId: string; vin: string; placa: string | null; estado: EstadoSoat;
  companiaId: number; document: string | null; carpeta: string | null; umbralOcr: string | null;
}

async function datosCargaPorId(id: string): Promise<DatosCarga | null> {
  const [r] = await db.select({
    soatId: flitoSoat.id, vin: flitoSoat.vin, estado: flitoSoat.estado, placa: vehicles.plate,
    companiaId: clients.id, document: clients.document, carpeta: clients.flitoCarpetaStorage,
    umbralOcr: flitoProveedoresSoat.umbralOcr,
  }).from(flitoSoat)
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .where(eq(flitoSoat.id, id)).limit(1);
  return r ? { ...r, estado: r.estado as EstadoSoat } : null;
}

/** Duplicado por hash (CA-08): un mismo archivo no se concilia dos veces. */
async function facturaDuplicada(hash: string): Promise<boolean> {
  const [dup] = await db.select({ id: flitoSoportes.id }).from(flitoSoportes)
    .where(and(eq(flitoSoportes.hash, hash), eq(flitoSoportes.tipo, TIPO_FACTURA_SOAT), eq(flitoSoportes.descartado, false))).limit(1);
  return !!dup;
}

/** Sube la factura a S3 y devuelve su storage_key. Va ANTES de tocar la BD (CA-11). */
async function archivarFactura(datos: DatosCarga, archivo: ArchivoSubido): Promise<string> {
  const carpeta = carpetaDe({ id: datos.companiaId, document: datos.document, flitoCarpetaStorage: datos.carpeta }, 'soat/facturas');
  return uploadEntityDocument(carpeta, datos.soatId, archivo.originalname, archivo.buffer, archivo.mimetype);
}

// Persiste soporte + (pago | revisión) en una sola tx. `aprobada` decide el desenlace.
async function persistirCarga(datos: DatosCarga, archivo: ArchivoSubido, hash: string, storageKey: string, extraccion: ExtraccionSoat, veredicto: Veredicto, ctx: SoatCtx): Promise<void> {
  await db.transaction(async (tx) => {
    const [soporte] = await tx.insert(flitoSoportes).values({
      tipo: TIPO_FACTURA_SOAT, nombreArchivo: archivo.originalname, contentType: archivo.mimetype,
      storageKey, hash, tamanoBytes: archivo.size, soatId: datos.soatId,
      subidoPorId: ctx.userId, subidoPorNombre: ctx.username,
    }).returning({ id: flitoSoportes.id });

    if (veredicto.aprobada) {
      await pagarEnTx(tx, datos.soatId, datos.vin, datos.estado, extraccion, ctx, soporte.id);
    } else {
      // El SOAT se queda En adquisición (CA-06): el documento existe, pero ningún dato del OCR se da
      // por válido sin confirmación humana (RN-04). Los gestores no resuelven esta cola (RN-05).
      await tx.insert(flitoRevisiones).values({
        modulo: FlujoRevision.SOAT, motivo: veredicto.motivo!, detalle: veredicto.detalle!,
        registroId: datos.soatId, soporteId: soporte.id,
        placaSugerida: extraccion[CampoSoat.PLACA]?.valor ?? null,
        extraccion, resuelto: false,
      });
      await auditEnTx(tx, ctx, datos.soatId, `OCR a revisión (${veredicto.motivo}): ${veredicto.detalle} Soporte ${soporte.id}.`);
    }
  });
}

/**
 * Carga de la factura de un SOAT puntual. Única vía a `Pagado` (RN-03). Se LEE y VERIFICA antes de
 * guardar: si la factura no corresponde a este SOAT (sin llave o llave que contradice), se descarta
 * sin archivarla — sería un comprobante de otro vehículo colgado del registro equivocado.
 */
export async function cargarFactura(id: string, archivo: ArchivoSubido, ctx: SoatCtx): Promise<Awaited<ReturnType<typeof detalle>>> {
  const soat = await buscarConAcceso(id, ctx); // frontera del gestor (404-no-403)
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado !== EstadoSoat.SOLICITADO) {
    throw new SoatError(400, `Solo se puede cargar factura de un SOAT en adquisición. Este está en "${ESTADO_SOAT_LABEL[soat.estado as EstadoSoat]}".`);
  }

  const datos = await datosCargaPorId(id);
  if (!datos) throw new SoatError(404, 'El SOAT no existe');

  const umbral = umbralPara(datos.umbralOcr);
  const extraccion = await extraerFacturaSoat(docDe(archivo, umbral));
  const veredicto = evaluarExtraccionSoat(extraccion, { vin: datos.vin, placa: datos.placa }, umbral);

  if (!veredicto.aprobada && (veredicto.motivo === MotivoRevision.SIN_LLAVE_DE_CRUCE || veredicto.motivo === MotivoRevision.LLAVE_NO_CRUZA)) {
    throw new SoatError(400, `${veredicto.detalle} No corresponde a este SOAT, así que no se guardó.`);
  }

  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  if (await facturaDuplicada(hash)) {
    throw new SoatError(409, 'Esta factura ya fue cargada antes (mismo archivo). No se concilia dos veces.');
  }

  const storageKey = await archivarFactura(datos, archivo);
  await persistirCarga(datos, archivo, hash, storageKey, extraccion, veredicto, ctx);

  return detalle(soat.id, ctx);
}

const docDe = (archivo: ArchivoSubido, umbral: number): DocumentoAAnalizar => ({
  nombreArchivo: archivo.originalname, contentType: archivo.mimetype, contenido: archivo.buffer, umbral,
});

// ─────────────────────────── Carga masiva ────────────────────────────────────

export interface ItemCarga { archivo: string; placa: string | null; soatId: string | null; detalle: string }
export interface ResultadoCargaMasiva {
  pagados: ItemCarga[]; enRevision: ItemCarga[]; duplicados: ItemCarga[]; noAsociados: ItemCarga[];
}

/**
 * SOAT en adquisición que cruce por placa o VIN, respetando la frontera del gestor. Devuelve también
 * lo necesario para archivar (compañía) y el umbral del proveedor.
 */
async function buscarEnAdquisicion(placa: string | null, vin: string | null, ctx: SoatCtx): Promise<DatosCarga | null> {
  if (!placa && !vin) return null;
  const llave: ReturnType<typeof sql>[] = [];
  if (placa) llave.push(sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) = ${normalizarLlave(placa)}`);
  if (vin) llave.push(sql`UPPER(${vehicles.vin}) = ${normalizarLlave(vin)}`);

  const conds = [
    eq(flitoSoat.estado, EstadoSoat.SOLICITADO),
    eq(clients.soatAutogestionable, false),
    or(...llave)!,
  ];
  if (esGestor(ctx)) {
    if (!ctx.proveedorSoatId) return null;
    conds.push(eq(flitoSoat.proveedorSoatId, ctx.proveedorSoatId));
  }

  const [r] = await db.select({
    soatId: flitoSoat.id, vin: flitoSoat.vin, estado: flitoSoat.estado, placa: vehicles.plate,
    companiaId: clients.id, document: clients.document, carpeta: clients.flitoCarpetaStorage,
    umbralOcr: flitoProveedoresSoat.umbralOcr,
  }).from(flitoSoat)
    .innerJoin(vehicles, eq(flitoSoat.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoSoat.companiaId, clients.id))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .where(and(...conds)).limit(1);
  return r ? { ...r, estado: r.estado as EstadoSoat } : null;
}

/**
 * Carga masiva de comprobantes. El gestor sube varios PDF/imágenes —o un ZIP— sin clasificar nada:
 * el OCR lee placa/VIN (o la placa del nombre del archivo como respaldo, §8.4) y cada comprobante se
 * cruza SOLO con un SOAT en adquisición. Los que cruzan y superan el umbral pasan a Pagado; los que
 * no, a revisión. Un comprobante que no cruza con ningún SOAT NO va a revisión (no hay contra qué
 * compararlo): se informa y no se guarda. Un archivo que falla no afecta a los demás.
 */
export async function cargarFacturasMasivo(archivos: ArchivoSubido[], ctx: SoatCtx): Promise<ResultadoCargaMasiva> {
  const res: ResultadoCargaMasiva = { pagados: [], enRevision: [], duplicados: [], noAsociados: [] };
  const expandidos = await expandir(archivos);

  for (const archivo of expandidos) {
    try {
      const hash = createHash('sha256').update(archivo.buffer).digest('hex');
      if (await facturaDuplicada(hash)) {
        res.duplicados.push({ archivo: archivo.originalname, placa: null, soatId: null, detalle: 'Ya cargada antes (mismo archivo).' });
        continue;
      }

      const extraccion = await extraerFacturaSoat(docDe(archivo, umbralPara(null)));
      const placaLeida = extraccion[CampoSoat.PLACA]?.valor ?? placaDesdeNombre(archivo.originalname);
      const vinLeido = extraccion[CampoSoat.VIN]?.valor ?? null;

      const datos = await buscarEnAdquisicion(placaLeida, vinLeido, ctx);
      if (!datos) {
        res.noAsociados.push({ archivo: archivo.originalname, placa: placaLeida, soatId: null,
          detalle: 'No cruza con ningún SOAT en adquisición. No se guardó.' });
        continue;
      }

      const umbral = umbralPara(datos.umbralOcr);
      const veredicto = evaluarExtraccionSoat(extraccion, { vin: datos.vin, placa: datos.placa }, umbral);
      const storageKey = await archivarFactura(datos, archivo);
      await persistirCarga(datos, archivo, hash, storageKey, extraccion, veredicto, ctx);

      const item: ItemCarga = { archivo: archivo.originalname, placa: datos.placa, soatId: datos.soatId, detalle: veredicto.aprobada ? 'Pagado.' : (veredicto.detalle ?? 'En revisión.') };
      (veredicto.aprobada ? res.pagados : res.enRevision).push(item);
    } catch (e) {
      const msg = e instanceof SoatError ? e.message : 'Error procesando el archivo.';
      res.noAsociados.push({ archivo: archivo.originalname, placa: null, soatId: null, detalle: msg });
    }
  }
  return res;
}

/** Un ZIP es una caja: se abre y se procesa cada archivo que trae (PDF/imagen). */
async function expandir(archivos: ArchivoSubido[]): Promise<ArchivoSubido[]> {
  const salida: ArchivoSubido[] = [];
  for (const archivo of archivos) {
    const esZip = archivo.mimetype.includes('zip') || archivo.originalname.toLowerCase().endsWith('.zip');
    if (!esZip) { salida.push(archivo); continue; }

    const zip = await JSZip.loadAsync(archivo.buffer);
    for (const entrada of Object.values(zip.files)) {
      if (entrada.dir) continue;
      if (entrada.name.startsWith('__MACOSX/')) continue;
      const base = entrada.name.split('/').pop() || entrada.name;
      if (base.startsWith('.')) continue;
      const buffer = Buffer.from(await entrada.async('nodebuffer'));
      const lower = base.toLowerCase();
      const mimetype = lower.endsWith('.pdf') ? 'application/pdf'
        : /\.(jpg|jpeg)$/.test(lower) ? 'image/jpeg'
        : lower.endsWith('.png') ? 'image/png'
        : 'application/octet-stream';
      salida.push({ originalname: base, mimetype, buffer, size: buffer.length });
    }
  }
  return salida;
}
