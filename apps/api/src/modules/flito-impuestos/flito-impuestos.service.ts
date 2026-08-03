// FLITO Impuestos — workflow (cola, envío al gestor, estados). Porta la parte de gestión de
// packages/server/src/impuestos/impuestos.servicio.ts sobre drizzle. La carga de factura de venta
// (precondición) vive en flito-factura-venta.service.ts; la carga de recibos → Pagado llega en P3.
//
// Dos fronteras innegociables, como en SOAT: compañías que autogestionan quedan fuera SIEMPRE
// (CA-05), y un gestor de impuestos solo ve SU organismo (CA-10) — atadura = users.transito_codigo,
// leída de BD (§9.3), nunca el JWT. El gestor NUNCA ve los Pendiente.

import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoCompradores, flitoImpuestos, flitoSoportes, flitoTramites,
  organismosTransitoConfig, users, vehicles,
} from '../../db/schema.js';
import { aIso } from '../../shared/utils/fecha-rango.js';
import { registrarCambio, registrarCambios } from '../../shared/historial/estado-historial.js';
import { ANS_OPERATIVO, EstadoImpuesto, ESTADO_IMPUESTO_LABEL } from '@operaciones/shared-types';
import { ImpuestoError, type ImpuestoCtx } from './flito-factura-venta.service.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lo único que ve un gestor de impuestos. Pendiente NO está: su trabajo arranca al recibir el envío. */
const ESTADOS_VISIBLES_GESTOR: readonly EstadoImpuesto[] = [EstadoImpuesto.SOLICITADO, EstadoImpuesto.PAGADO];

const esGestor = (ctx: ImpuestoCtx) => ctx.role === 'gestor_impuestos';

/**
 * Quién entra en la cola: lo de las compañías que NO autogestionan, más lo que se desbloqueó
 * excepcionalmente (HU #10980). `COALESCE` porque la bandera del cliente es nullable.
 */
const FRONTERA_AUTOGESTION_IMP = sql`(NOT COALESCE(${clients.impuestosAutogestionable}, false)
  OR ${flitoImpuestos.excepcionAutogestion})`;

export interface ImpuestoColaItem {
  id: string; tramiteId: string; idFlit: string; placa: string | null; vin: string;
  /** Vehículo y datos del trámite, homologados con las demás tablas. */
  marca: string | null; linea: string | null;
  tipoTramite: string | null; fechaAprobacion: string | null; fechaCreacion: string | null;
  estado: EstadoImpuesto; compradorNombre: string | null; compradorDocumento: string | null;
  companiaNombre: string; organismoCodigo: string; organismoNombre: string | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  tieneFacturaVenta: boolean; enviadoPorNombre: string | null; enviadoEn: string | null;
  /** Fecha de pago. Ya se leía de BD para el detalle; la cola la necesita para el orden cronológico. */
  pagadoEn: string | null;
  estancado: boolean; motivoRechazo: string | null; creadoEn: string;
  /** true = lo gestiona Operaciones por contingencia (HU #11155), no el gestor del organismo. */
  gestionOperaciones: boolean;
}

const SELECT_COLA = {
  id: flitoImpuestos.id, tramiteId: flitoImpuestos.tramiteId, idFlit: flitoTramites.idFlit,
  // Homologación con las demás tablas (tipo, aprobación, creación, vehículo). El impuesto SÍ es por
  // trámite, así que aquí no hay la ambigüedad que tiene el SOAT.
  tipoTramite: flitoTramites.tipoTramite,
  fechaAprobacion: flitoTramites.fechaAprobacion,
  // La fecha de FLIT y no `created_at`, que es cuándo el sync ingirió la fila.
  fechaCreacion: sql<Date | null>`COALESCE(${flitoTramites.fechaCreacionFlit}, ${flitoTramites.createdAt})`,
  marca: vehicles.brand, linea: vehicles.model,
  estado: flitoImpuestos.estado, organismoCodigo: flitoImpuestos.organismoCodigo,
  valorLiquidado: flitoImpuestos.valorLiquidado, valorPagado: flitoImpuestos.valorPagado,
  marcadoPorDiferencia: flitoImpuestos.marcadoPorDiferencia, facturaVentaFlitId: flitoTramites.facturaVentaFlitId,
  gestionOperaciones: flitoImpuestos.gestionOperaciones,
  enviadoEn: flitoImpuestos.enviadoEn, pagadoEn: flitoImpuestos.pagadoEn,
  motivoRechazo: flitoImpuestos.motivoRechazo, createdAt: flitoImpuestos.createdAt,
  placa: vehicles.plate, vin: vehicles.vin, companiaNombre: clients.name,
  organismoNombre: organismosTransitoConfig.alias, organismoSla: organismosTransitoConfig.flitoSlaHoras,
  enviadoPorNombre: users.name,
} as const;

function fromCola() {
  return db.select(SELECT_COLA).from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(users, eq(flitoImpuestos.enviadoPorId, users.id));
}

type FilaCola = Awaited<ReturnType<ReturnType<typeof fromCola>['where']>>[number];

export interface FiltrosColaImpuestos {
  estados?: EstadoImpuesto[];
  buscar?: string;
  /** Multiselect. Vacío = sin acotar. En impuestos el equivalente al proveedor es el organismo. */
  companias?: number[];
  organismos?: string[];
  /** Rangos yyyy-mm-dd, inclusivos por día. */
  solicitadoDesde?: string; solicitadoHasta?: string;
  pagadoDesde?: string; pagadoHasta?: string;
  /** true = solo lo que superó el SLA de su organismo. */
  estancado?: boolean;
  page?: number; pageSize?: number;
}

export interface ColaImpuestosPaginada {
  items: ImpuestoColaItem[]; total: number; page: number; pageSize: number;
}

/**
 * «Estancado» en SQL, para poder filtrar y contar por él. Misma regla que `estaEstancado()` aplica
 * en JavaScript al ensamblar la fila: si una cambia, la otra debe cambiar con ella.
 *
 * `make_interval` y no concatenar texto: `sla || ' hours'` deja el tipo del parámetro ambiguo.
 */
const EXPR_ESTANCADO_IMP = sql`(${flitoImpuestos.estado} = ${EstadoImpuesto.SOLICITADO}
  AND ${flitoImpuestos.enviadoEn} IS NOT NULL
  AND CASE WHEN ${flitoImpuestos.gestionOperaciones}
        THEN ${flitoImpuestos.enviadoEn} < NOW() - make_interval(hours => ${ANS_OPERATIVO.SIN_GESTION_HORAS})
        ELSE ${organismosTransitoConfig.flitoSlaHoras} IS NOT NULL
             AND ${flitoImpuestos.enviadoEn} < NOW() - make_interval(hours => ${organismosTransitoConfig.flitoSlaHoras})
      END)`;

/**
 * Condiciones de la cola, compartidas por la página y el conteo. `null` = la frontera del gestor
 * hace que no pueda ver nada, que no es lo mismo que «sin filtros».
 */
function condicionesColaImpuestos(ctx: ImpuestoCtx, f: FiltrosColaImpuestos): SQL[] | null {
  const conds = [FRONTERA_AUTOGESTION_IMP];

  if (esGestor(ctx)) {
    if (!ctx.transitoCodigo) return null; // sin organismo no hay frontera → nada
    conds.push(eq(flitoImpuestos.organismoCodigo, ctx.transitoCodigo));
    const visibles = f.estados?.length ? f.estados.filter((e) => ESTADOS_VISIBLES_GESTOR.includes(e)) : [EstadoImpuesto.SOLICITADO];
    if (visibles.length === 0) return null;
    conds.push(inArray(flitoImpuestos.estado, visibles));
  } else if (f.estados?.length) {
    conds.push(inArray(flitoImpuestos.estado, f.estados));
  }

  const termino = f.buscar?.trim();
  if (termino) {
    const patron = `%${termino.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${termino.toUpperCase()}%`;
    conds.push(or(
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`EXISTS (SELECT 1 FROM ${flitoCompradores} fc WHERE fc.tramite_id = ${flitoTramites.id}
            AND (UPPER(fc.nombre_completo) LIKE ${patronTexto} OR fc.numero_documento LIKE ${patronTexto}))`,
    )!);
  }

  if (f.companias?.length) conds.push(inArray(flitoImpuestos.companiaId, f.companias));
  if (f.organismos?.length) conds.push(inArray(flitoImpuestos.organismoCodigo, f.organismos));

  // Rangos inclusivos por día: `hasta` suma un día para no dejar fuera esa jornada.
  if (f.solicitadoDesde) conds.push(sql`${flitoImpuestos.enviadoEn} >= ${f.solicitadoDesde}::date`);
  if (f.solicitadoHasta) conds.push(sql`${flitoImpuestos.enviadoEn} < (${f.solicitadoHasta}::date + INTERVAL '1 day')`);
  if (f.pagadoDesde) conds.push(sql`${flitoImpuestos.pagadoEn} >= ${f.pagadoDesde}::date`);
  if (f.pagadoHasta) conds.push(sql`${flitoImpuestos.pagadoEn} < (${f.pagadoHasta}::date + INTERVAL '1 day')`);

  if (f.estancado) conds.push(EXPR_ESTANCADO_IMP);

  return conds;
}

/** Cola de impuestos con las dos fronteras (CA-05 autogestión, CA-10 organismo del gestor). */
export async function colaImpuestos(ctx: ImpuestoCtx, f: FiltrosColaImpuestos = {}): Promise<ColaImpuestosPaginada> {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(f.pageSize ?? 50)));

  const conds = condicionesColaImpuestos(ctx, f);
  if (conds === null) return { items: [], total: 0, page, pageSize };
  const where = and(...conds);

  const [countRows, rows] = await Promise.all([
    db.select({ total: sql<number>`count(*)::int` }).from(flitoImpuestos)
      .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
      .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
      .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
      .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo))
      .leftJoin(users, eq(flitoImpuestos.enviadoPorId, users.id))
      .where(where),
    // Desempate por id: sin él, dos impuestos creados en el mismo instante pueden salir en dos
    // páginas o en ninguna.
    fromCola().where(where).orderBy(asc(flitoImpuestos.createdAt), asc(flitoImpuestos.id))
      .limit(pageSize).offset((page - 1) * pageSize),
  ]);

  return {
    items: await ensamblar(rows),
    total: Number(countRows[0]?.total ?? 0),
    page,
    pageSize,
  };
}

export interface FacetasColaImpuestos {
  companias: { id: number; nombre: string }[];
  organismos: { codigo: string; nombre: string | null }[];
}

/**
 * Valores disponibles para los filtros, sobre el universo que el usuario PUEDE ver: a un gestor no
 * se le ofrece filtrar por un organismo ajeno, porque eso ya le contaría que existe.
 */
export async function facetasColaImpuestos(ctx: ImpuestoCtx): Promise<FacetasColaImpuestos> {
  const conds = condicionesColaImpuestos(ctx, {});
  if (conds === null) return { companias: [], organismos: [] };
  const where = and(...conds);

  // Los mismos joins que la cola: las facetas tienen que ofrecer exactamente los valores que
  // producen resultados, no los de la tabla entera. Se repiten en cada consulta en vez de
  // factorizarlos porque un helper genérico pierde el tipo de la proyección.
  const [companias, organismos] = await Promise.all([
    db.selectDistinct({ id: clients.id, nombre: clients.name }).from(flitoImpuestos)
      .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
      .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
      .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
      .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo))
      .where(where),
    db.selectDistinct({ codigo: organismosTransitoConfig.codigo, nombre: organismosTransitoConfig.alias }).from(flitoImpuestos)
      .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
      .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
      .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
      .innerJoin(organismosTransitoConfig, eq(flitoImpuestos.organismoCodigo, organismosTransitoConfig.codigo))
      .where(where),
  ]);

  return {
    companias: companias.sort((a, b) => a.nombre.localeCompare(b.nombre)),
    organismos: organismos.sort((a, b) => (a.nombre ?? '').localeCompare(b.nombre ?? '')),
  };
}

async function ensamblar(rows: FilaCola[]): Promise<ImpuestoColaItem[]> {
  const tramiteIds = [...new Set(rows.map((r) => r.tramiteId))];
  const compradores = tramiteIds.length
    ? await db.select().from(flitoCompradores).where(inArray(flitoCompradores.tramiteId, tramiteIds)).orderBy(asc(flitoCompradores.orden))
    : [];
  const principalPorTramite = new Map<string, typeof compradores[number]>();
  for (const c of compradores) if (!principalPorTramite.has(c.tramiteId)) principalPorTramite.set(c.tramiteId, c);

  return rows.map((r) => {
    const p = principalPorTramite.get(r.tramiteId);
    return {
      id: r.id, tramiteId: r.tramiteId, idFlit: r.idFlit, placa: r.placa, vin: r.vin ?? '',
      marca: r.marca, linea: r.linea,
      tipoTramite: r.tipoTramite,
      fechaAprobacion: aIso(r.fechaAprobacion),
      fechaCreacion: aIso(r.fechaCreacion),
      estado: r.estado as EstadoImpuesto,
      compradorNombre: p?.nombreCompleto ?? null, compradorDocumento: p?.numeroDocumento ?? null,
      companiaNombre: r.companiaNombre, organismoCodigo: r.organismoCodigo, organismoNombre: r.organismoNombre,
      valorLiquidado: r.valorLiquidado === null ? null : Number(r.valorLiquidado),
      valorPagado: r.valorPagado === null ? null : Number(r.valorPagado),
      marcadoPorDiferencia: r.marcadoPorDiferencia, tieneFacturaVenta: r.facturaVentaFlitId !== null,
      enviadoPorNombre: r.enviadoPorNombre, enviadoEn: r.enviadoEn ? r.enviadoEn.toISOString() : null,
      pagadoEn: r.pagadoEn ? r.pagadoEn.toISOString() : null,
      estancado: estaEstancado(r.estado, r.enviadoEn, r.gestionOperaciones, r.organismoSla),
      gestionOperaciones: r.gestionOperaciones,
      motivoRechazo: r.motivoRechazo, creadoEn: r.createdAt.toISOString(),
    };
  });
}

/**
 * Gemelo en JavaScript de `EXPR_ESTANCADO_IMP`. Conviven porque la píldora se pinta desde la fila ya
 * ensamblada y el filtro tiene que ocurrir en la consulta; si una cambia, la otra debe cambiar con
 * ella o la píldora dice una cosa y el conteo otra.
 *
 * Ojo: hasta la HU #11155 estas dos NO coincidían —el SQL medía contra el ANS del organismo y esto
 * contra el global— pese a que el comentario afirmaba lo contrario. Ahora las dos aplican el mismo
 * criterio: el ANS global de Operaciones cuando la contingencia está activa, y el del organismo
 * cuando lo gestiona su gestor. Un organismo sin ANS configurado nunca marca a su gestor, pero sí
 * marca lo que asumió Operaciones: el retraso deja de esconderse por una parametrización que falta.
 */
export function estaEstancado(estado: string, enviadoEn: Date | null, gestionOperaciones: boolean, slaOrganismo: number | null): boolean {
  if (estado !== EstadoImpuesto.SOLICITADO || !enviadoEn) return false;
  const horas = gestionOperaciones ? ANS_OPERATIVO.SIN_GESTION_HORAS : slaOrganismo;
  if (horas === null) return false;
  return (Date.now() - enviadoEn.getTime()) / 3_600_000 > horas;
}

/**
 * Busca un impuesto aplicando la frontera del gestor. 404-no-403 (un 403 ya confirma que el id
 * existe): registro autogestionado, de otro organismo, o en estado no visible → null.
 */
export async function buscarConAcceso(id: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect | null> {
  const [row] = await db.select({ imp: flitoImpuestos, dentroDeFrontera: FRONTERA_AUTOGESTION_IMP })
    .from(flitoImpuestos).innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
    .where(eq(flitoImpuestos.id, id)).limit(1);
  if (!row) return null;
  // La misma frontera que la cola: el desbloqueo excepcional vale en todo el flujo, no solo para
  // aparecer en la lista (HU #11021).
  if (!row.dentroDeFrontera) return null;
  if (esGestor(ctx)) {
    if (row.imp.organismoCodigo !== ctx.transitoCodigo) return null;
    if (!ESTADOS_VISIBLES_GESTOR.includes(row.imp.estado as EstadoImpuesto)) return null;
  }
  return row.imp;
}

/**
 * Id de la factura de venta (S3 de FLIT) de un impuesto, respetando la frontera del gestor (404-no-403).
 * Devuelve null si el impuesto no es accesible o su trámite aún no trae factura. Integración FLIT.
 */
export async function facturaVentaFlitIdConAcceso(id: string, ctx: ImpuestoCtx): Promise<string | null> {
  const imp = await buscarConAcceso(id, ctx);
  if (!imp) return null;
  const [t] = await db.select({ facturaVentaFlitId: flitoTramites.facturaVentaFlitId })
    .from(flitoTramites).where(eq(flitoTramites.id, imp.tramiteId)).limit(1);
  return t?.facturaVentaFlitId ?? null;
}

export interface ImpuestoDetalle extends ImpuestoColaItem {
  extraccion: unknown; extraccionFacturaVenta: unknown; pagadoEn: string | null;
  soportes: Array<{ id: string; tipo: string; nombreArchivo: string; subidoEn: string }>;
}

export async function detalleImpuesto(id: string, ctx: ImpuestoCtx): Promise<ImpuestoDetalle | null> {
  const imp = await buscarConAcceso(id, ctx); // frontera (404-no-403)
  if (!imp) return null;
  const rows = await fromCola().where(eq(flitoImpuestos.id, id)).limit(1);
  const [item] = await ensamblar(rows);
  if (!item) return null;
  const soportes = await db.select({ id: flitoSoportes.id, tipo: flitoSoportes.tipo, nombreArchivo: flitoSoportes.nombreArchivo, subidoEn: flitoSoportes.subidoEn })
    .from(flitoSoportes).where(and(eq(flitoSoportes.impuestoId, id), eq(flitoSoportes.descartado, false))).orderBy(asc(flitoSoportes.subidoEn));
  return {
    ...item, extraccion: imp.extraccion, extraccionFacturaVenta: imp.extraccionFacturaVenta,
    pagadoEn: imp.pagadoEn ? imp.pagadoEn.toISOString() : null,
    soportes: soportes.map((s) => ({ ...s, subidoEn: s.subidoEn.toISOString() })),
  };
}

async function auditEnTx(tx: Tx, ctx: ImpuestoCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({ userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_impuesto', resourceId, detail });
}

export interface ResultadoEnvio { enviados: string[]; yaEnviados: string[] }

/**
 * Envía impuestos al gestor del organismo: Pendiente → En gestión. Solo Operaciones. Atómico
 * (CA-04): con dos usuarios despachando la misma cola, FOR UPDATE OF flito_impuestos SKIP LOCKED
 * evita que ambos manden el mismo registro. Solo cuenta con factura de venta cargada (estado
 * PENDIENTE ya lo garantiza: sin_factura no llega aquí).
 */
export async function enviarAlGestor(ids: string[], ctx: ImpuestoCtx, gestionOperaciones = false): Promise<ResultadoEnvio> {
  if (ids.length === 0) return { enviados: [], yaEnviados: [] };
  const enviados = await db.transaction(async (tx) => {
    const locked = await tx.select({ id: flitoImpuestos.id }).from(flitoImpuestos)
      .innerJoin(clients, eq(flitoImpuestos.companiaId, clients.id))
      .where(and(inArray(flitoImpuestos.id, ids), eq(flitoImpuestos.estado, EstadoImpuesto.PENDIENTE), FRONTERA_AUTOGESTION_IMP))
      .for('update', { of: flitoImpuestos, skipLocked: true });
    const idsEnviados = locked.map((r) => r.id);
    if (idsEnviados.length === 0) return [];
    const ahora = new Date();
    await tx.update(flitoImpuestos).set({
      estado: EstadoImpuesto.SOLICITADO, enviadoPorId: ctx.userId, enviadoEn: ahora, updatedAt: ahora,
      // A diferencia de SOAT no hay XOR que validar: sin proveedor con el que competir, la
      // contingencia es solo una marca más sobre el mismo envío.
      ...(gestionOperaciones
        ? { gestionOperaciones: true, gestionOperacionesPorId: ctx.userId, gestionOperacionesEn: ahora }
        : {}),
    }).where(inArray(flitoImpuestos.id, idsEnviados));
    const destino = gestionOperaciones ? 'gestión de Operaciones' : 'gestor';
    for (const id of idsEnviados) await auditEnTx(tx, ctx, id, `Envío a ${destino} (pendiente→solicitado).`);
    await registrarCambios(tx, idsEnviados.map((iid) => ({
      concepto: 'impuesto' as const, registroId: iid,
      estadoAnterior: EstadoImpuesto.PENDIENTE, estadoNuevo: EstadoImpuesto.SOLICITADO,
      motivo: gestionOperaciones ? 'Envío a gestión de Operaciones' : 'Envío al gestor',
      usuarioId: ctx.userId, usuarioEmail: ctx.username,
    })));
    return idsEnviados;
  });
  return { enviados, yaEnviados: ids.filter((id) => !enviados.includes(id)) };
}

// ────────────── Traspaso de gestión: Operaciones ↔ gestor del organismo (HU #11155) ──────────────

/** Mientras el impuesto está en gestión y sin pagar. Igual que en SOAT. */
const ESTADOS_TRASPASO_IMP: readonly EstadoImpuesto[] = [EstadoImpuesto.SOLICITADO, EstadoImpuesto.CON_NOVEDAD];

function noAdmiteTraspasoImp(estado: EstadoImpuesto): ImpuestoError {
  if (estado === EstadoImpuesto.PAGADO) {
    return new ImpuestoError(400, 'Este impuesto ya está pagado: su gestión no se traspasa. Si hay que rehacerlo, primero reversarlo con justificación.');
  }
  return new ImpuestoError(400, `Este impuesto aún no se ha enviado a gestión (está en "${ESTADO_IMPUESTO_LABEL[estado]}").`);
}

function exigirMotivoImp(motivo: string, accion: string): string {
  const limpio = motivo?.trim() ?? '';
  if (limpio.length < 5) throw new ImpuestoError(400, `${accion} exige un motivo que explique el porqué`);
  return limpio;
}

/**
 * Operaciones asume la gestión de un impuesto. No cambia el estado ni toca `enviadoEn` —el tiempo
 * que lleva esperando es el que es— y el organismo se conserva: el impuesto se paga ante él aunque
 * lo tramite otro. Lo que cambia es quién lo trabaja, y con ello el ANS contra el que se mide.
 */
export async function asumirEnOperaciones(id: string, motivo: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect> {
  const [imp] = await db.select().from(flitoImpuestos).where(eq(flitoImpuestos.id, id)).limit(1);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  const limpio = exigirMotivoImp(motivo, 'Asumir la gestión en Operaciones');
  if (imp.gestionOperaciones) throw new ImpuestoError(400, 'Este impuesto ya lo gestiona Operaciones');
  if (!ESTADOS_TRASPASO_IMP.includes(imp.estado as EstadoImpuesto)) throw noAdmiteTraspasoImp(imp.estado as EstadoImpuesto);

  const ahora = new Date();
  return db.transaction(async (tx) => {
    const [u] = await tx.update(flitoImpuestos).set({
      gestionOperaciones: true, gestionOperacionesMotivo: limpio,
      gestionOperacionesPorId: ctx.userId, gestionOperacionesEn: ahora, updatedAt: ahora,
    }).where(eq(flitoImpuestos.id, id)).returning();
    await auditEnTx(tx, ctx, id, `Gestión asumida por Operaciones (organismo ${imp.organismoCodigo}): ${limpio}`);
    await registrarCambio(tx, {
      concepto: 'impuesto', registroId: id,
      estadoAnterior: imp.estado as EstadoImpuesto, estadoNuevo: imp.estado as EstadoImpuesto,
      motivo: `Gestión asumida por Operaciones: ${limpio}`,
      usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return u;
  });
}

/**
 * Devuelve el impuesto al gestor de su organismo. A diferencia de SOAT no recibe destinatario: el
 * organismo nunca cambió, así que quitar la marca ya lo devuelve a quien le corresponde.
 */
export async function devolverAlGestor(id: string, motivo: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect> {
  const [imp] = await db.select().from(flitoImpuestos).where(eq(flitoImpuestos.id, id)).limit(1);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  const limpio = exigirMotivoImp(motivo, 'Devolver la gestión al gestor del organismo');
  if (!imp.gestionOperaciones) throw new ImpuestoError(400, 'Este impuesto no lo gestiona Operaciones: no hay nada que devolver');
  if (!ESTADOS_TRASPASO_IMP.includes(imp.estado as EstadoImpuesto)) throw noAdmiteTraspasoImp(imp.estado as EstadoImpuesto);

  const ahora = new Date();
  return db.transaction(async (tx) => {
    const [u] = await tx.update(flitoImpuestos).set({
      gestionOperaciones: false, gestionOperacionesMotivo: null,
      gestionOperacionesPorId: null, gestionOperacionesEn: null, updatedAt: ahora,
    }).where(eq(flitoImpuestos.id, id)).returning();
    await auditEnTx(tx, ctx, id, `Gestión devuelta al gestor del organismo ${imp.organismoCodigo}: ${limpio}`);
    await registrarCambio(tx, {
      concepto: 'impuesto', registroId: id,
      estadoAnterior: imp.estado as EstadoImpuesto, estadoNuevo: imp.estado as EstadoImpuesto,
      motivo: `Gestión devuelta al gestor del organismo: ${limpio}`,
      usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return u;
  });
}

/** Rechazo del gestor. Solo desde En gestión; motivo obligatorio. */
export async function rechazar(id: string, motivo: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect> {
  const imp = await buscarConAcceso(id, ctx);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  if (imp.estado !== EstadoImpuesto.SOLICITADO) throw new ImpuestoError(400, 'Solo se puede rechazar un impuesto en gestión');
  if (!motivo?.trim()) throw new ImpuestoError(400, 'El motivo del rechazo es obligatorio');
  return db.transaction(async (tx) => {
    const [u] = await tx.update(flitoImpuestos).set({ estado: EstadoImpuesto.CON_NOVEDAD, motivoRechazo: motivo.trim(), updatedAt: new Date() }).where(eq(flitoImpuestos.id, id)).returning();
    await auditEnTx(tx, ctx, id, `Rechazo (solicitado→con_novedad): ${motivo.trim()}`);
    await registrarCambio(tx, {
      concepto: 'impuesto', registroId: id,
      estadoAnterior: imp.estado, estadoNuevo: EstadoImpuesto.CON_NOVEDAD,
      motivo: `Rechazo: ${motivo.trim()}`, usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return u;
  });
}

/** Devuelve un impuesto rechazado a la cola. Solo Operaciones, solo desde Rechazado. */
export async function reactivar(id: string, motivo: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect> {
  const [imp] = await db.select().from(flitoImpuestos).where(eq(flitoImpuestos.id, id)).limit(1);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  if (imp.estado !== EstadoImpuesto.CON_NOVEDAD) throw new ImpuestoError(400, `Solo un impuesto rechazado vuelve a Pendiente. Este está en "${ESTADO_IMPUESTO_LABEL[imp.estado as EstadoImpuesto]}".`);
  if (!motivo?.trim()) throw new ImpuestoError(400, 'El motivo de la corrección es obligatorio');
  return db.transaction(async (tx) => {
    const [u] = await tx.update(flitoImpuestos).set({ estado: EstadoImpuesto.PENDIENTE, enviadoPorId: null, enviadoEn: null, motivoRechazo: null, updatedAt: new Date() }).where(eq(flitoImpuestos.id, id)).returning();
    await auditEnTx(tx, ctx, id, `Reactivación (rechazado→pendiente): ${motivo.trim()}`);
    await registrarCambio(tx, {
      concepto: 'impuesto', registroId: id,
      estadoAnterior: imp.estado, estadoNuevo: EstadoImpuesto.PENDIENTE,
      motivo: `Reactivación: ${motivo.trim()}`, usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return u;
  });
}

/** Reversa manual por Operaciones. Motivo ≥5. Reversar a Pendiente limpia envío/pago/marca. */
export async function reversar(id: string, estadoDestino: EstadoImpuesto, motivo: string, ctx: ImpuestoCtx): Promise<typeof flitoImpuestos.$inferSelect> {
  const [imp] = await db.select().from(flitoImpuestos).where(eq(flitoImpuestos.id, id)).limit(1);
  if (!imp) throw new ImpuestoError(404, 'El impuesto no existe');
  if (!motivo?.trim() || motivo.trim().length < 5) throw new ImpuestoError(400, 'La reversa exige un motivo que explique el porqué');
  if (imp.estado === estadoDestino) throw new ImpuestoError(400, 'El impuesto ya está en ese estado');
  const limpiar = estadoDestino === EstadoImpuesto.PENDIENTE
    ? { enviadoPorId: null, enviadoEn: null, pagadoEn: null, motivoRechazo: null, marcadoPorDiferencia: false }
    : {};
  return db.transaction(async (tx) => {
    const [u] = await tx.update(flitoImpuestos).set({ estado: estadoDestino, ...limpiar, updatedAt: new Date() }).where(eq(flitoImpuestos.id, id)).returning();
    await auditEnTx(tx, ctx, id, `Reversa ${imp.estado}→${estadoDestino}: ${motivo.trim()}`);
    await registrarCambio(tx, {
      concepto: 'impuesto', registroId: id,
      estadoAnterior: imp.estado, estadoNuevo: estadoDestino,
      motivo: `Reversa: ${motivo.trim()}`, usuarioId: ctx.userId, usuarioEmail: ctx.username,
    });
    return u;
  });
}

// Reexport para las rutas.
export { ImpuestoError };
