// FLITO — SOAT (lógica). Portado de packages/server/src/soat/soat.servicio.ts sobre el
// stack del grande, operando sobre la tabla flito_soat (que la sincronización ya puebla).
// COEXISTE con el módulo legacy modules/soat (soat_requests): shadow-run, sin tocarlo.
//
// Fase 2: workflow completo (cola, envío atómico, estados, aislamiento). La carga de factura
// (única vía a Pagado, RN-03) depende del OCR y llega en la Fase 3 (marcarPagado se exporta
// para ese uso). Las reglas caras: 3 fronteras de la cola (CA-01/CA-09), envío atómico (CA-04),
// aislamiento 404-no-403 (CA-09), RN-05/RN-06.

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients,
  flitoCompradores,
  flitoProveedoresSoat,
  flitoSoat,
  flitoTramites,
  organismosTransitoConfig,
  users,
  vehicles,
} from '../../db/schema.js';
import {
  ESTADO_SOAT_LABEL,
  ESTADOS_SOAT_VISIBLES_GESTOR,
  EstadoSoat,
  TipoPropiedad,
} from '@operaciones/shared-types';

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
      : [EstadoSoat.EN_ADQUISICION];
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
  if (estado !== EstadoSoat.EN_ADQUISICION || !slaHoras || !enviadoEn) return false;
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
      estado: EstadoSoat.EN_ADQUISICION,
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
  if (soat.estado !== EstadoSoat.EN_ADQUISICION) throw new SoatError(400, 'Solo se puede rechazar un SOAT en adquisición');
  if (!motivo?.trim()) throw new SoatError(400, 'El motivo del rechazo es obligatorio');
  const [updated] = await db.update(flitoSoat)
    .set({ estado: EstadoSoat.RECHAZADO, motivoRechazo: motivo.trim(), updatedAt: new Date() })
    .where(eq(flitoSoat.id, id)).returning();
  return updated;
}

/** Devuelve un SOAT rechazado a la cola (CA-08). Solo Operaciones, solo desde Rechazado. */
export async function reactivar(id: string, motivo: string): Promise<typeof flitoSoat.$inferSelect> {
  const [soat] = await db.select().from(flitoSoat).where(eq(flitoSoat.id, id)).limit(1);
  if (!soat) throw new SoatError(404, 'El SOAT no existe');
  if (soat.estado !== EstadoSoat.RECHAZADO) {
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
  if (soat.estado === EstadoSoat.EN_ADQUISICION) {
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
