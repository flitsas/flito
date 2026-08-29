// FLITO Trámites unificado (Fase 5 P3). Porta packages/server/src/tramites/tramites.servicio.ts.
//
// Una sola tabla centrada en el trámite que reemplaza las colas separadas de SOAT e Impuestos y la
// compuerta. NO duplica lógica de negocio: cada acción resuelve tramiteId → soatId/impuestoId y DELEGA
// en el servicio dueño de la regla (SOAT/Impuestos para el envío al gestor, Compuerta para el veredicto
// y la entrega). Aquí solo vive el mapeo y el reporte agregado.

import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  EstadoImpuesto, EstadoTramiteFlito, ESTADOS_TRAMITE_FLITO_TERMINADOS,
  ANS_OPERATIVO, type AlertaOperativa,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoCompradores, flitoExcepcionesAutogestion, flitoImpuestos, flitoLogisticaDocumentos, flitoProveedoresSoat, flitoSoat,
  flitoTramiteHistorial, flitoTramites, organismosTransitoConfig, users, vehicles,
} from '../../db/schema.js';
import { flitoDerechosTramite } from '../../db/schema.js';
import { decidir, entregar as entregarCompuerta } from '../flito-compuerta/flito-compuerta.service.js';
import { enviarAlGestor as enviarSoat } from '../flito-soat/flito-soat.service.js';
import { enviarAlGestor as enviarImpuestos } from '../flito-impuestos/flito-impuestos.service.js';

export interface TramitesCtx { userId: number; username: string; role: string }

// Ni proveedor ni compañía: el actor de Gestión Trámites es Operaciones, así que este contexto no
// activa la frontera del gestor ni la del canal Cliente (Feature #11912).
const soatCtx = (ctx: TramitesCtx) => ({ userId: ctx.userId, username: ctx.username, role: ctx.role, proveedorSoatId: null, companiaId: null });
const impuestoCtx = (ctx: TramitesCtx) => ({ userId: ctx.userId, username: ctx.username, role: ctx.role, transitoCodigo: null });

export interface Comprador {
  nombreCompleto: string; numeroDocumento: string; correo: string | null; celular: string | null;
  direccion: string | null; orden: number; porcentajeParticipacion: string | null;
}
export interface FilaSoat {
  id: string; estado: string; proveedorSoatId: string | null; proveedorSoatNombre: string | null;
  valorPagado: number | null; enviadoEn: string | null; pagadoEn: string | null;
  estancado: boolean; motivoRechazo: string | null;
}
export interface FilaImpuesto {
  id: string; estado: string; tieneFacturaVenta: boolean; coincidenciaFacturaVenta: number | null;
  valorLiquidado: number | null; valorPagado: number | null; marcadoPorDiferencia: boolean;
  enviadoEn: string | null; pagadoEn: string | null; estancado: boolean; motivoRechazo: string | null;
}
/**
 * Semáforo de gestión FLITO del trámite (lo que le falta a FLITO por resolver):
 *   autogestionada — la empresa autogestiona SOAT e impuestos → FLITO no gestiona (gris).
 *   rojo   — ni SOAT ni impuesto resueltos.
 *   amarillo — uno de los dos resuelto.
 *   verde  — ambos resueltos (listo para entregar).
 * "Resuelto" = pagado o no_aplica (mismo criterio que la compuerta).
 */
export type SemaforoTramite = 'autogestionada' | 'rojo' | 'amarillo' | 'verde';

export interface TramiteFila {
  tramiteId: string; idFlit: string;
  semaforo: SemaforoTramite;
  /** Estado crudo de FLIT (todos los estados se muestran). */
  estado: string;
  /** true solo si el estado FLIT es 'Asignado' → habilita SOAT/impuestos. */
  asignado: boolean;
  tipoTramite: string | null; ciudad: string | null; fechaAprobacion: string | null;
  /**
   * Fecha en que el trámite nació en FLIT, con `created_at` de FLITO como respaldo cuando el
   * reporte no la trae. Es la base del orden cronológico y de los indicadores de antigüedad.
   */
  fechaCreacion: string | null;
  /** Valor real del derecho de tránsito (HU #10953). null = aún sin recibo → la UI muestra el estimado. */
  derechoTramiteValor: number | null;
  companiaNombre: string | null; empresaExiste: boolean; empresaNit: string | null;
  organismoNombre: string | null; secretariaEmparejada: boolean; transitoNombre: string | null;
  facturaVentaFlitId: string | null;
  vehiculo: { vin: string | null; placa: string | null; marca: string | null; linea: string | null; tipoVehiculo: string | null };
  compradorPrincipal: Comprador | null; compradores: Comprador[];
  soat: FilaSoat | null; soatAutogestionado: boolean; impuesto: FilaImpuesto | null; impuestosAutogestionado: boolean;
  soatResuelto: boolean; impuestosResueltos: boolean; listoParaEntregar: boolean;
  valorSoat: number | null; valorImpuesto: number | null; sincronizadoEn: string;
  /** Tracking logístico de la LT. null si no aplica (no aprobado, sin empresa o empresa autogestiona). */
  logistica: { estado: string } | null;
  /**
   * Conceptos desbloqueados excepcionalmente pese a que la compañía los autogestiona (HU #10980).
   * Vacío en la inmensa mayoría de filas.
   */
  excepcionesAutogestion: string[];
}

export interface HistorialItem {
  id: string; campo: string; valorAnterior: string | null; valorNuevo: string | null;
  origen: string; usuarioNombre: string | null; creadoEn: string;
}

/** Historial de cambios de un trámite (auditoría campo por campo). Más reciente primero. */
export async function historial(tramiteId: string): Promise<HistorialItem[]> {
  const rows = await db.select({
    id: flitoTramiteHistorial.id, campo: flitoTramiteHistorial.campo,
    valorAnterior: flitoTramiteHistorial.valorAnterior, valorNuevo: flitoTramiteHistorial.valorNuevo,
    origen: flitoTramiteHistorial.origen, usuarioNombre: users.name, creadoEn: flitoTramiteHistorial.createdAt,
  }).from(flitoTramiteHistorial)
    .leftJoin(users, eq(flitoTramiteHistorial.usuarioId, users.id))
    .where(eq(flitoTramiteHistorial.tramiteId, tramiteId))
    .orderBy(desc(flitoTramiteHistorial.createdAt));
  return rows.map((r) => ({ ...r, creadoEn: r.creadoEn.toISOString() }));
}

// ── Creación de trámites DEMO (pruebas de Logística) ─────────────────────────

export interface DatosTramiteDemo {
  placa: string; vin: string; propietarioNombre: string; propietarioDocumento?: string | null;
  marca?: string | null; linea?: string | null; modelo?: number | null;
  companiaId: number; organismoCodigo: string; transitoNombre?: string | null; idFlit?: string | null;
  /** Estado crudo de FLIT (Aprobado, Asignado, …). Por defecto 'Aprobado' (habilita Logística). */
  flitEstado?: string | null;
}

// El `estado` interno es enum; solo estos 5 estados crudos mapean (igual que estadoEnumDesdeFlit del sync).
type EstadoInternoTramite = 'asignado' | 'entregado' | 'aprobado' | 'anulado' | 'rechazado';
const ESTADOS_INTERNOS: readonly EstadoInternoTramite[] = ['asignado', 'entregado', 'aprobado', 'anulado', 'rechazado'];

/**
 * Crea un trámite DEMO en estado 'Aprobado' (vehículo + trámite + comprador) para probar Logística sin
 * depender del sync de FLIT. La empresa debe existir y NO autogestionar logística, y el organismo debe
 * estar configurado, para que la LT haga match por placa+VIN. Valida VIN/idFlit únicos.
 */
export async function crearTramiteDemo(datos: DatosTramiteDemo, ctx: TramitesCtx): Promise<{ tramiteId: string; idFlit: string; placa: string }> {
  const placa = datos.placa.trim().toUpperCase().replace(/[\s-]/g, '');
  const vin = datos.vin.trim().toUpperCase().replace(/\s/g, '');
  const propietario = datos.propietarioNombre.trim();
  if (!placa || !vin || !propietario) throw new Error('Placa, VIN y propietario son obligatorios');
  if (vin.length !== 17) throw new Error('El VIN debe tener 17 caracteres');

  const [dupVin] = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.vin, vin)).limit(1);
  if (dupVin) throw new Error(`Ya existe un vehículo con el VIN ${vin}`);
  const [comp] = await db.select({ id: clients.id, nit: clients.document, autog: clients.logisticaAutogestionable })
    .from(clients).where(eq(clients.id, datos.companiaId)).limit(1);
  if (!comp) throw new Error('La empresa seleccionada no existe');
  if (comp.autog) throw new Error('Esa empresa autogestiona su logística: FLITO no la gestiona (elige otra o desactiva la bandera)');
  const [org] = await db.select({ codigo: organismosTransitoConfig.codigo, alias: organismosTransitoConfig.alias })
    .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, datos.organismoCodigo)).limit(1);
  if (!org) throw new Error('El organismo seleccionado no existe');

  const idFlit = (datos.idFlit?.trim() || `DEMO-${placa}`).toUpperCase();
  const [dupId] = await db.select({ id: flitoTramites.id }).from(flitoTramites).where(eq(flitoTramites.idFlit, idFlit)).limit(1);
  if (dupId) throw new Error(`Ya existe un trámite con id ${idFlit}`);

  const flitEstado = datos.flitEstado?.trim() || 'Aprobado';
  const n = flitEstado.toLowerCase();
  const estadoInterno: EstadoInternoTramite | null = ESTADOS_INTERNOS.includes(n as EstadoInternoTramite) ? (n as EstadoInternoTramite) : null;
  const fechaAprobacion = (n === 'aprobado' || n === 'entregado') ? new Date() : null;

  return db.transaction(async (tx) => {
    const [v] = await tx.insert(vehicles).values({
      vin, plate: placa, ownerName: propietario, ownerDocument: datos.propietarioDocumento?.trim() || null,
      brand: datos.marca?.trim() || null, model: datos.linea?.trim() || null, year: datos.modelo ?? null, clientId: comp.id,
    }).returning({ id: vehicles.id });
    const [t] = await tx.insert(flitoTramites).values({
      idFlit, estado: estadoInterno, flitEstado, tipoTramite: 'Matricula', ciudad: org.alias,
      tipoPropiedad: 'unico_propietario', companiaId: comp.id, companiaNit: comp.nit,
      organismoCodigo: org.codigo, transitoNombreFlit: datos.transitoNombre?.trim() || org.alias,
      vehiculoId: v.id, fechaAprobacion, sincronizadoEn: new Date(),
    }).returning({ id: flitoTramites.id });
    await tx.insert(flitoCompradores).values({
      tramiteId: t.id, nombreCompleto: propietario, numeroDocumento: datos.propietarioDocumento?.trim() || 'N/A', orden: 0,
    });
    return { tramiteId: t.id, idFlit, placa };
  });
}

export interface ResultadoCrearEmpresa { companiaId: number; yaExistia: boolean; revinculados: number }

/**
 * Crea la empresa (cliente) de un trámite cuya compañía FLIT no existía aún y la re-vincula: fija
 * `companiaId` en todos los trámites de ese NIT que estaban sin compañía, dejándolos accionables sin
 * esperar a un nuevo sync. El cambio queda en el historial con origen 'usuario'. Idempotente: si ya
 * existe un cliente con ese NIT, lo reutiliza (yaExistia) y solo re-vincula los pendientes.
 */
export async function crearEmpresaDesdeTramite(
  nombre: string, nit: string, autogestion: { soat: boolean; impuestos: boolean; logistica: boolean }, ctx: TramitesCtx,
): Promise<ResultadoCrearEmpresa> {
  const doc = nit.trim();
  // Mismo criterio que la unicidad de `clients.routes.ts` (HU #11292). Con `eq(document, doc)` a
  // secas, un cliente guardado como `' 900789123'` —típico de un import antiguo— no se encontraba y
  // este flujo insertaba un segundo cliente con el mismo NIT. En Siigo los dos serían el mismo
  // tercero y el segundo pisaría al primero; aquí, además, el duplicado nace sin la marca de
  // conflicto que sí puso la migración 0132 a los preexistentes, así que parece limpio.
  const docCliente = doc.toUpperCase();
  const [existente] = await db.select({ id: clients.id }).from(clients)
    .where(sql`trim(upper(${clients.document})) = ${docCliente}`).limit(1);
  let companiaId: number;
  let yaExistia = false;
  if (existente) { companiaId = existente.id; yaExistia = true; }
  else {
    const [creada] = await db.insert(clients)
      .values({
        name: nombre.trim(), document: docCliente, documentType: 'NIT',
        soatAutogestionable: autogestion.soat, impuestosAutogestionable: autogestion.impuestos,
        logisticaAutogestionable: autogestion.logistica,
      })
      .returning({ id: clients.id });
    companiaId = creada.id;
  }
  const pendientes = await db.select({ id: flitoTramites.id }).from(flitoTramites)
    .where(and(eq(flitoTramites.companiaNit, doc), sql`${flitoTramites.companiaId} is null`));
  if (pendientes.length > 0) {
    const ids = pendientes.map((t) => t.id);
    await db.update(flitoTramites).set({ companiaId }).where(inArray(flitoTramites.id, ids));
    await db.insert(flitoTramiteHistorial).values(ids.map((tid) => ({
      tramiteId: tid, campo: 'compania_id', valorAnterior: null, valorNuevo: String(companiaId),
      origen: 'usuario', usuarioId: ctx.userId,
    })));
  }
  return { companiaId, yaExistia, revinculados: pendientes.length };
}

export interface TramiteReferencia { tramiteId: string; idFlit: string; placa: string | null }
export interface ResultadoSolicitudSoat { enviados: number; yaEnviados: number; autogestionados: number; sinRegistro: number }
export interface ResultadoSolicitudImpuestos { enviados: number; yaEnviados: number; noEnviables: number }
export interface ResultadoSolicitudAmbos { soat: ResultadoSolicitudSoat; impuestos: ResultadoSolicitudImpuestos }
export interface ResultadoEntrega { entregados: number; noHabilitados: Array<{ tramiteId: string; idFlit: string; placa: string; motivo: string }> }

// Filtros y paginación del listado (todo se resuelve en SQL: el cliente ya no trae todo a memoria).
export interface FiltrosListado {
  buscar?: string; estados?: string[]; transitos?: string[]; ciudades?: string[];
  empresas?: string[]; soat?: string[]; impuesto?: string[];
  /** Autogestión de la empresa: 'si' = autogestiona SOAT E impuestos; 'no' = FLITO gestiona al menos uno. */
  autogestion?: 'si' | 'no';
  /**
   * Orden cronológico por fecha de creación. 'antiguos' primero es el orden de trabajo del gestor
   * (lo que lleva más tiempo esperando se atiende antes); 'recientes' es el default histórico.
   */
  orden?: OrdenListado;
  /** Alerta operativa del tablero. Excluyentes entre sí: un botón, un valor. */
  alerta?: AlertaOperativa;
  /**
   * Dos rangos independientes, ambos inclusivos por día (HU #11026). El de creación mide contra la
   * fecha de FLIT, no contra `created_at`: esta última es cuándo el sync ingirió la fila, y en la
   * carga masiva inicial todos los históricos comparten el mismo día.
   */
  creadoDesde?: string; creadoHasta?: string;
  aprobadoDesde?: string; aprobadoHasta?: string;
  page?: number; pageSize?: number;
}

export const ORDENES_LISTADO = ['recientes', 'antiguos'] as const;
export type OrdenListado = (typeof ORDENES_LISTADO)[number];
export const esOrdenListado = (v: unknown): v is OrdenListado =>
  typeof v === 'string' && (ORDENES_LISTADO as readonly string[]).includes(v);
export interface ListadoTramites { items: TramiteFila[]; total: number; page: number; pageSize: number }
export interface FacetasTramites { estados: string[]; tramites: string[]; ciudades: string[]; transitos: string[] }

function proyeccion() {
  return db.select({
    // Campos que consume decidir() (compuerta) — mismos nombres que FilaCompuerta.
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    estadoTramite: flitoTramites.estado,
    placa: vehicles.plate,
    companiaNombre: clients.name,
    soatAutogestionable: clients.soatAutogestionable,
    impuestosAutogestionable: clients.impuestosAutogestionable,
    logisticaAutogestionable: clients.logisticaAutogestionable,
    logisticaDocEstado: flitoLogisticaDocumentos.estado,
    soatEstado: flitoSoat.estado,
    soatExcepcion: flitoSoat.excepcionAutogestion,
    soatValorPagado: flitoSoat.valorPagado,
    soatExtraccion: flitoSoat.extraccion,
    impuestoEstado: flitoImpuestos.estado,
    impuestoValorPagado: flitoImpuestos.valorPagado,
    impuestoMarcadoPorDiferencia: flitoImpuestos.marcadoPorDiferencia,
    impuestoExtraccion: flitoImpuestos.extraccion,
    // HU #10953: valor real del derecho de tránsito leído del recibo del organismo. Null mientras
    // ese trámite no tenga recibo cargado; la UI cae entonces al estimado.
    derechoValor: flitoDerechosTramite.valor,
    // Integración FLIT (Fase 8): estado crudo, datos del reporte y emparejamientos.
    flitEstado: flitoTramites.flitEstado,
    tipoTramite: flitoTramites.tipoTramite,
    ciudad: flitoTramites.ciudad,
    companiaId: flitoTramites.companiaId,
    companiaNit: flitoTramites.companiaNit,
    transitoNombreFlit: flitoTramites.transitoNombreFlit,
    facturaVentaFlitId: flitoTramites.facturaVentaFlitId,
    fechaAprobacion: flitoTramites.fechaAprobacion,
    fechaCreacionFlit: flitoTramites.fechaCreacionFlit,
    creadoEn: flitoTramites.createdAt,
    // Extras de presentación.
    sincronizadoEn: flitoTramites.sincronizadoEn,
    organismoAlias: organismosTransitoConfig.alias,
    organismoCodigo: flitoTramites.organismoCodigo,
    vin: vehicles.vin,
    marca: vehicles.brand,
    linea: vehicles.model,
    tipoVehiculo: vehicles.tipoVehiculo,
    soatId: flitoSoat.id,
    soatProveedorId: flitoSoat.proveedorSoatId,
    soatProveedorNombre: flitoProveedoresSoat.nombre,
    soatSlaHoras: flitoProveedoresSoat.slaHoras,
    soatEnviadoEn: flitoSoat.enviadoEn,
    soatPagadoEn: flitoSoat.pagadoEn,
    soatMotivoRechazo: flitoSoat.motivoRechazo,
    impuestoId: flitoImpuestos.id,
    impuestoExtraccionFacturaVenta: flitoImpuestos.extraccionFacturaVenta,
    impuestoValorLiquidado: flitoImpuestos.valorLiquidado,
    impuestoEnviadoEn: flitoImpuestos.enviadoEn,
    impuestoPagadoEn: flitoImpuestos.pagadoEn,
    // SLA del organismo del trámite. Es el mismo que el del impuesto (ambos salen del organismo
    // resuelto al sincronizar), así que se aprovecha el join que ya existe en vez de añadir otro.
    impuestoSlaHoras: organismosTransitoConfig.flitoSlaHoras,
    impuestoMotivoRechazo: flitoImpuestos.motivoRechazo,
  }).from(flitoTramites)
    // leftJoin (no inner): compañía y secretaría pueden faltar (empresa inexistente / sin emparejar);
    // el trámite se muestra igual, con su indicador. El vehículo siempre existe (se upserta por VIN).
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    // Estado logístico de la LT (tracking): a lo sumo una por trámite (unique tramite+tipo).
    .leftJoin(flitoLogisticaDocumentos, and(eq(flitoLogisticaDocumentos.tramiteId, flitoTramites.id), eq(flitoLogisticaDocumentos.tipo, 'licencia_transito')));
}

type FilaCruda = Awaited<ReturnType<ReturnType<typeof proyeccion>['where']>>[number];

/**
 * Solicitado hace más de lo que aguanta el SLA. Sirve igual a SOAT (SLA del proveedor) y a impuestos
 * (SLA del organismo): ambos usan el mismo estado 'solicitado' y la misma cuenta desde `enviadoEn`.
 * Sin SLA configurado no hay estancamiento posible.
 */
function estancadoPorAns(estado: string | null, enviadoEn: Date | null): boolean {
  if (estado !== 'solicitado' || !enviadoEn) return false;
  return (Date.now() - enviadoEn.getTime()) / 3_600_000 > ANS_OPERATIVO.SIN_GESTION_HORAS;
}

function coincidenciaDe(extraccion: unknown): number | null {
  if (!extraccion || typeof extraccion !== 'object') return null;
  const confianzas = Object.values(extraccion as Record<string, { confianza?: number } | undefined>)
    .filter((c): c is { confianza: number } => Boolean(c) && typeof c!.confianza === 'number')
    .map((c) => c.confianza);
  return confianzas.length ? Math.min(...confianzas) : null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function aFila(f: FilaCruda, compradores: Comprador[]): TramiteFila {
  // decidir() (compuerta) exige autogestión booleana; sin compañía emparejada, se asume false.
  const veredicto = decidir({ ...f, soatAutogestionable: f.soatAutogestionable ?? false, impuestosAutogestionable: f.impuestosAutogestionable ?? false, companiaNombre: f.companiaNombre ?? '' });
  const orden = [...compradores].sort((a, b) => a.orden - b.orden);
  const principal = orden[0] ?? null;
  const asignado = (f.flitEstado ?? '').trim().toLowerCase() === 'asignado';
  // Semáforo de gestión: gris si la empresa autogestiona SOAT e impuestos; si no, rojo/amarillo/verde
  // según cuántos de los dos estén resueltos (pagado o no_aplica, según la compuerta).
  const autogestionadaTotal = (f.soatAutogestionable ?? false) && (f.impuestosAutogestionable ?? false);
  const semaforo: SemaforoTramite = autogestionadaTotal ? 'autogestionada'
    : (veredicto.soatResuelto && veredicto.impuestosResueltos) ? 'verde'
      : (veredicto.soatResuelto || veredicto.impuestosResueltos) ? 'amarillo'
        : 'rojo';
  return {
    tramiteId: f.tramiteId,
    idFlit: f.idFlit,
    // El listado la rellena en una tanda aparte; el detalle de un trámite suelto no la necesita.
    excepcionesAutogestion: [],
    semaforo,
    estado: f.flitEstado ?? f.estadoTramite ?? '—',
    asignado,
    tipoTramite: f.tipoTramite,
    ciudad: f.ciudad,
    fechaAprobacion: f.fechaAprobacion ? f.fechaAprobacion.toISOString() : null,
    // Respaldo a created_at: los trámites anteriores a que FLIT empezara a reportar fechaCreacion
    // no la tienen, y quedarse sin fecha los dejaría fuera de todo orden e indicador.
    fechaCreacion: (f.fechaCreacionFlit ?? f.creadoEn)?.toISOString() ?? null,
    // Valor real del derecho; null = todavía no hay recibo y la UI muestra el estimado.
    derechoTramiteValor: f.derechoValor === null ? null : Number(f.derechoValor),
    companiaNombre: f.companiaNombre,
    empresaExiste: f.companiaId !== null,
    empresaNit: f.companiaNit,
    organismoNombre: f.transitoNombreFlit ?? f.organismoAlias,
    secretariaEmparejada: f.organismoCodigo !== null,
    transitoNombre: f.transitoNombreFlit,
    facturaVentaFlitId: f.facturaVentaFlitId,
    vehiculo: { vin: f.vin, placa: f.placa, marca: f.marca, linea: f.linea, tipoVehiculo: f.tipoVehiculo },
    compradorPrincipal: principal,
    compradores: orden,
    soat: f.soatId ? {
      id: f.soatId, estado: f.soatEstado!, proveedorSoatId: f.soatProveedorId, proveedorSoatNombre: f.soatProveedorNombre,
      valorPagado: num(f.soatValorPagado), enviadoEn: f.soatEnviadoEn ? f.soatEnviadoEn.toISOString() : null,
      pagadoEn: f.soatPagadoEn ? f.soatPagadoEn.toISOString() : null,
      estancado: estancadoPorAns(f.soatEstado, f.soatEnviadoEn), motivoRechazo: f.soatMotivoRechazo,
    } : null,
    soatAutogestionado: f.soatAutogestionable ?? false,
    impuesto: f.impuestoId ? {
      id: f.impuestoId, estado: f.impuestoEstado!, tieneFacturaVenta: f.facturaVentaFlitId !== null,
      coincidenciaFacturaVenta: coincidenciaDe(f.impuestoExtraccionFacturaVenta),
      valorLiquidado: num(f.impuestoValorLiquidado), valorPagado: num(f.impuestoValorPagado),
      marcadoPorDiferencia: f.impuestoMarcadoPorDiferencia ?? false,
      enviadoEn: f.impuestoEnviadoEn ? f.impuestoEnviadoEn.toISOString() : null,
      pagadoEn: f.impuestoPagadoEn ? f.impuestoPagadoEn.toISOString() : null,
      estancado: estancadoPorAns(f.impuestoEstado, f.impuestoEnviadoEn),
      motivoRechazo: f.impuestoMotivoRechazo,
    } : null,
    impuestosAutogestionado: f.impuestosAutogestionable ?? false,
    soatResuelto: veredicto.soatResuelto,
    impuestosResueltos: veredicto.impuestosResueltos,
    listoParaEntregar: veredicto.habilitado,
    valorSoat: veredicto.valorSoat,
    valorImpuesto: veredicto.valorImpuesto,
    sincronizadoEn: f.sincronizadoEn.toISOString(),
    // Logística: aplica solo a trámites aprobados de compañías que FLITO gestiona. 'pendiente' = aún
    // sin recoger (LT no escaneada); si ya hay LT, su estado real de la cadena.
    logistica: ((f.flitEstado ?? '').trim().toLowerCase() === 'aprobado' && f.companiaId !== null && !(f.logisticaAutogestionable ?? false))
      ? { estado: f.logisticaDocEstado ?? 'pendiente' }
      : null,
  };
}

/**
 * Traduce una alerta operativa a SQL (Feature #10942 §5.2).
 *
 * Se exporta para que el tablero cuente EXACTAMENTE lo mismo que devuelve el listado: si cada uno
 * escribiera su propio predicado, la tarjeta diría 12 y la tabla mostraría 9, y nadie sabría cuál
 * de los dos miente.
 *
 * Ojo con los joins: `soat_sin_gestion` depende de `flito_proveedores_soat` y
 * `impuesto_sin_gestion` de `organismos_transito_config`. Toda consulta que use estas condiciones
 * debe incluirlos, o Postgres falla con «missing FROM-clause entry».
 */
/**
 * Estados de FLIT en los que el trámite ya está en manos del organismo, esperando su aprobación.
 *
 * El ciclo real es: Borrador → Enviado a OT → Asignado → Entregado → **Aprobado**, siendo Aprobado
 * el estado objetivo, el último. Los estados pueden retroceder: un trámite Entregado que se Rechaza
 * se subsana y vuelve a Entregado para nueva revisión. Por eso Rechazado también cuenta: un
 * rechazado sin subsanar es justo el cuello de botella que la alerta debe destapar.
 *
 * Antes esto era una lista de EXCLUSIÓN —todo lo que no estuviera Aprobado, Anulado o Abortado—,
 * pensada para que un estado nuevo del catálogo abierto de FLIT apareciera en la alerta en vez de
 * desaparecer en silencio. El efecto real era el contrario del que Operaciones necesita: metía
 * Borradores y Asignados, que todavía no han llegado al organismo y cuya demora no es suya. La
 * alerta mide demora DEL ORGANISMO, así que la lista pasa a ser de inclusión.
 *
 * En minúsculas y sin espacios, como se comparan. `sql.join` con parámetros individuales, no un
 * array de JS: `= ANY(${array})` falla en tiempo de ejecución con «op ANY/ALL (array) requires
 * array on right side», y ningún test con drizzle mockeado lo detecta.
 */
const ESTADOS_ESPERANDO_APROBACION = ['entregado', 'rechazado'] as const;
const sqlEstadosEsperandoAprobacion = () =>
  sql.join(ESTADOS_ESPERANDO_APROBACION.map((e) => sql`${e}`), sql`, `);

export function condicionAlerta(alerta: AlertaOperativa): SQL {
  // Antigüedad del trámite: la fecha de FLIT, con la de ingesta como respaldo.
  const nacimiento = sql`COALESCE(${flitoTramites.fechaCreacionFlit}, ${flitoTramites.createdAt})`;
  // make_interval en vez de concatenar texto: `$1 || ' days'` deja el tipo del parámetro ambiguo.
  // ANS único de gestión: el mismo retraso se pinta igual venga del proveedor que venga (HU #11024).
  const horasSinGestion = ANS_OPERATIVO.SIN_GESTION_HORAS;

  switch (alerta) {
    case 'borrador_5d': {
      // Cuándo entró a Borrador, según el historial. Un trámite que NACIÓ en Borrador y nunca
      // cambió no tiene fila de historial (solo se registra en UPDATE), de ahí el COALESCE.
      const entroABorrador = sql`COALESCE((
        SELECT MAX(${flitoTramiteHistorial.createdAt})
          FROM ${flitoTramiteHistorial}
         WHERE ${flitoTramiteHistorial.tramiteId} = ${flitoTramites.id}
           AND ${flitoTramiteHistorial.campo} = 'flit_estado'
           AND LOWER(TRIM(COALESCE(${flitoTramiteHistorial.valorNuevo}, ''))) = 'borrador'
      ), ${nacimiento})`;
      return sql`LOWER(TRIM(COALESCE(${flitoTramites.flitEstado}, ''))) = 'borrador'
        AND ${entroABorrador} < NOW() - make_interval(days => ${ANS_OPERATIVO.BORRADOR_DIAS})`;
    }
    case 'sin_aprobar_ans':
      // Solo lo que está en manos del organismo: Entregado (esperando revisión) y Rechazado
      // (devuelto y aún sin subsanar).
      //
      // Ya no se filtra además por `fecha_aprobacion IS NULL`. Ese guardia existía para compensar la
      // lista de exclusión; con la de inclusión no aporta nada y sí puede quitar de la vista un
      // trámite que se aprobó y luego retrocedió a Entregado —conserva su fecha de aprobación pero
      // vuelve a estar esperando—, que es precisamente uno de los que hay que destapar.
      return sql`LOWER(TRIM(COALESCE(${flitoTramites.flitEstado}, ''))) IN (${sqlEstadosEsperandoAprobacion()})
        AND ${nacimiento} < NOW() - make_interval(days => ${ANS_OPERATIVO.SIN_APROBAR_DIAS})`;
    case 'soat_sin_gestion':
      return sql`${flitoSoat.estado} = 'solicitado' AND ${flitoSoat.enviadoEn} IS NOT NULL
        AND ${flitoSoat.enviadoEn} < NOW() - make_interval(hours => ${horasSinGestion})`;
    case 'impuesto_sin_gestion':
      return sql`${flitoImpuestos.estado} = 'solicitado' AND ${flitoImpuestos.enviadoEn} IS NOT NULL
        AND ${flitoImpuestos.enviadoEn} < NOW() - make_interval(hours => ${horasSinGestion})`;
  }
}

// Traduce los filtros del listado a condiciones SQL. `buscar` es una búsqueda global (id FLIT, placa,
// VIN, nombre/documento del comprador; placa/VIN toleran guiones).
//
// La maestra muestra los trámites en TODOS los estados (Feature #10940 §3.1). Antes arrancaba con
// `notInArray(estado, TERMINADOS)`, que además de esconder anulados y rechazados a propósito escondía
// en silencio los que no tienen equivalente en el enum interno: `estado` es nullable y
// `NULL NOT IN (...)` evalúa a NULL, no a true, así que Borrador y Enviado a OT desaparecían del
// listado, del contador y de las facetas sin que nada lo delatara.
function construirCondiciones(f: FiltrosListado): SQL[] {
  const conds: SQL[] = [];

  const termino = f.buscar?.trim();
  if (termino) {
    const patron = `%${termino.toUpperCase().replace(/[\s-]/g, '')}%`;
    const patronTexto = `%${termino.toUpperCase()}%`;
    const compradorMatch = db.select({ id: flitoCompradores.tramiteId }).from(flitoCompradores)
      .where(or(
        sql`UPPER(${flitoCompradores.nombreCompleto}) LIKE ${patronTexto}`,
        sql`UPPER(${flitoCompradores.numeroDocumento}) LIKE ${patronTexto}`,
      ));
    conds.push(or(
      sql`UPPER(${flitoTramites.idFlit}) LIKE ${patronTexto}`,
      sql`UPPER(REPLACE(${vehicles.plate}, '-', '')) LIKE ${patron}`,
      sql`UPPER(${vehicles.vin}) LIKE ${patron}`,
      inArray(flitoTramites.id, compradorMatch),
    )!);
  }
  // Filtros multiselect: cualquiera de los valores seleccionados coincide (IN).
  if (f.estados?.length) conds.push(inArray(flitoTramites.flitEstado, f.estados));
  if (f.ciudades?.length) conds.push(inArray(flitoTramites.ciudad, f.ciudades));
  // Tránsito por el nombre mostrado (el Transito crudo de FLIT; alias solo como respaldo).
  if (f.transitos?.length) {
    conds.push(or(...f.transitos.map((t) => sql`COALESCE(${flitoTramites.transitoNombreFlit}, ${organismosTransitoConfig.alias}) = ${t}`))!);
  }
  // Empresa gestora: multiselect por NIT de la CompaniaGestora (el trámite guarda el NIT crudo).
  if (f.empresas?.length) conds.push(inArray(flitoTramites.companiaNit, f.empresas));
  // Autogestión: mismo criterio que el semáforo 'autogestionada' (SOAT E impuestos autogestionados).
  // 'no' incluye trámites sin empresa emparejada (flags NULL → no autogestiona).
  if (f.autogestion === 'si' || f.autogestion === 'no') {
    const ambos = sql`COALESCE(${clients.soatAutogestionable}, false) AND COALESCE(${clients.impuestosAutogestionable}, false)`;
    conds.push(f.autogestion === 'si' ? ambos : sql`NOT (${ambos})`);
  }
  // Los valores llegan como texto libre del cliente; se castean al enum de la columna (drizzle es estricto).
  if (f.soat?.length) conds.push(inArray(flitoSoat.estado, f.soat as Array<(typeof flitoSoat.estado.enumValues)[number]>));
  if (f.impuesto?.length) conds.push(inArray(flitoImpuestos.estado, f.impuesto as Array<(typeof flitoImpuestos.estado.enumValues)[number]>));
  if (f.alerta) conds.push(condicionAlerta(f.alerta));
  // Inclusivos por día: `<= hasta::date + 1 day` en vez de `<= hasta`, que dejaría fuera todo lo
  // ocurrido ese mismo día después de medianoche.
  const nacimiento = sql`COALESCE(${flitoTramites.fechaCreacionFlit}, ${flitoTramites.createdAt})`;
  if (f.creadoDesde) conds.push(sql`${nacimiento} >= ${f.creadoDesde}::date`);
  if (f.creadoHasta) conds.push(sql`${nacimiento} < ${f.creadoHasta}::date + INTERVAL '1 day'`);
  if (f.aprobadoDesde) conds.push(sql`${flitoTramites.fechaAprobacion} >= ${f.aprobadoDesde}::date`);
  if (f.aprobadoHasta) conds.push(sql`${flitoTramites.fechaAprobacion} < ${f.aprobadoHasta}::date + INTERVAL '1 day'`);
  return conds;
}

/**
 * Listado paginado de la tabla unificada. Filtros y paginación se resuelven EN SQL (LIMIT/OFFSET +
 * COUNT); el cliente ya no descarga todos los trámites. Devuelve la página + el total para paginar.
 */
export async function listar(filtros: FiltrosListado = {}): Promise<ListadoTramites> {
  const page = Math.max(1, Math.floor(filtros.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(filtros.pageSize ?? 50)));
  const conds = construirCondiciones(filtros);

  // Total con los mismos joins que gobiernan los filtros (todos 1-0..1 → count(distinct) exacto).
  const countRows = await db.select({ total: sql<number>`count(distinct ${flitoTramites.id})::int` })
    .from(flitoTramites)
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    // El proveedor entra aquí porque la alerta `soat_sin_gestion` lo necesita para su SLA. Sin este
    // join, filtrar por esa alerta rompería el COUNT con «missing FROM-clause entry».
    .leftJoin(flitoProveedoresSoat, eq(flitoSoat.proveedorSoatId, flitoProveedoresSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .where(and(...conds));
  const total = Number(countRows[0]?.total ?? 0);

  // Se ordena por la fecha de FLIT con created_at de respaldo, igual que la columna que se muestra:
  // ordenar por un valor distinto del que el usuario lee es una fuente segura de desconcierto.
  // El desempate por id evita que dos trámites con la misma fecha bailen entre páginas.
  const clave = sql`COALESCE(${flitoTramites.fechaCreacionFlit}, ${flitoTramites.createdAt})`;
  const orden = filtros.orden === 'antiguos'
    ? [asc(clave), asc(flitoTramites.id)]
    : [desc(clave), desc(flitoTramites.id)];

  const rows = await proyeccion().where(and(...conds))
    .orderBy(...orden).limit(pageSize).offset((page - 1) * pageSize);
  if (rows.length === 0) return { items: [], total, page, pageSize };

  const ids = rows.map((r) => r.tramiteId);
  const compradoresRows = await db.select({
    tramiteId: flitoCompradores.tramiteId, nombreCompleto: flitoCompradores.nombreCompleto,
    numeroDocumento: flitoCompradores.numeroDocumento, correo: flitoCompradores.correo,
    celular: flitoCompradores.celular, direccion: flitoCompradores.direccion,
    orden: flitoCompradores.orden, porcentajeParticipacion: flitoCompradores.porcentajeParticipacion,
  }).from(flitoCompradores).where(inArray(flitoCompradores.tramiteId, ids));

  const porTramite = new Map<string, Comprador[]>();
  for (const c of compradoresRows) {
    // Nullable desde el Feature #11912: `flito_compradores` cuelga del trámite O del SOAT del canal
    // Cliente. La consulta ya filtró por trámite, así que aquí no cae ninguna fila del canal.
    if (!c.tramiteId) continue;
    const lista = porTramite.get(c.tramiteId) ?? [];
    lista.push({
      nombreCompleto: c.nombreCompleto, numeroDocumento: c.numeroDocumento, correo: c.correo,
      celular: c.celular, direccion: c.direccion, orden: c.orden, porcentajeParticipacion: c.porcentajeParticipacion,
    });
    porTramite.set(c.tramiteId, lista);
  }

  // Excepciones de autogestión vigentes (HU #10980), en una tanda: la fila necesita saber qué se
  // desbloqueó para pintar el chip y ofrecer revocar. Logística no tiene registro propio, así que
  // esta es la única forma de saberlo.
  const excRows = await db.select({
    tramiteId: flitoExcepcionesAutogestion.tramiteId,
    concepto: flitoExcepcionesAutogestion.concepto,
  }).from(flitoExcepcionesAutogestion)
    .where(and(
      inArray(flitoExcepcionesAutogestion.tramiteId, ids),
      isNull(flitoExcepcionesAutogestion.revocadoEn),
    ));

  const excPorTramite = new Map<string, string[]>();
  for (const e of excRows) {
    const lista = excPorTramite.get(e.tramiteId) ?? [];
    lista.push(e.concepto);
    excPorTramite.set(e.tramiteId, lista);
  }

  return {
    items: rows.map((r) => ({
      ...aFila(r, porTramite.get(r.tramiteId) ?? []),
      excepcionesAutogestion: excPorTramite.get(r.tramiteId) ?? [],
    })),
    total, page, pageSize,
  };
}

/**
 * Valores distintos para poblar los dropdowns de filtro (el cliente ya no ve el dataset completo).
 *
 * Sin exclusión de estados, en espejo del listado: si la tabla muestra los trámites en todos los
 * estados, ofrecer un desplegable que no incluye Borrador ni los terminados deja al usuario sin
 * forma de filtrar justo lo que sí está viendo.
 */
export async function facetas(): Promise<FacetasTramites> {
  const [estados, tramites, ciudades, transitos] = await Promise.all([
    db.selectDistinct({ v: flitoTramites.flitEstado }).from(flitoTramites).where(sql`${flitoTramites.flitEstado} is not null`),
    db.selectDistinct({ v: flitoTramites.tipoTramite }).from(flitoTramites).where(sql`${flitoTramites.tipoTramite} is not null`),
    db.selectDistinct({ v: flitoTramites.ciudad }).from(flitoTramites).where(sql`${flitoTramites.ciudad} is not null`),
    db.selectDistinct({ v: sql<string | null>`COALESCE(${flitoTramites.transitoNombreFlit}, ${organismosTransitoConfig.alias})` })
      .from(flitoTramites).leftJoin(organismosTransitoConfig, eq(flitoTramites.organismoCodigo, organismosTransitoConfig.codigo)),
  ]);
  const vals = (rows: { v: string | null }[]) => rows.map((r) => r.v).filter((v): v is string => !!v).sort();
  return { estados: vals(estados), tramites: vals(tramites), ciudades: vals(ciudades), transitos: vals(transitos) };
}

/**
 * Solicita SOAT: envía al gestor los seleccionados fijando el proveedor. Deduplica por SOAT — dos
 * trámites del mismo VIN comparten registro (RN-01), así que se envía una sola vez.
 */
export async function solicitarSoat(tramiteIds: string[], proveedorSoatId: string, ctx: TramitesCtx): Promise<ResultadoSolicitudSoat> {
  const tramites = await db.select({
    soatId: flitoTramites.soatId, soatAutogestionable: clients.soatAutogestionable,
  }).from(flitoTramites)
    .innerJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .where(inArray(flitoTramites.id, tramiteIds));

  let autogestionados = 0;
  let sinRegistro = 0;
  const soatIds = new Set<string>();
  for (const t of tramites) {
    if (t.soatAutogestionable) { autogestionados += 1; continue; }
    if (!t.soatId) { sinRegistro += 1; continue; }
    soatIds.add(t.soatId);
  }

  // Desde Gestión Trámites el proveedor sigue siendo obligatorio: la contingencia (HU #11152) se
  // opera desde el módulo SOAT, que es donde se ve de quién se retoma cada registro. Aquí solo se
  // adapta la forma de la llamada, sin cambiar el comportamiento.
  const { enviados, yaEnviados } = await enviarSoat([...soatIds], soatCtx(ctx), { proveedorSoatId });
  return { enviados: enviados.length, yaEnviados: yaEnviados.length, autogestionados, sinRegistro };
}

/**
 * Solicita impuestos: envía los que ya tienen factura de venta (Pendiente) y reporta los que aún no la
 * tienen o no aplican, en vez de bloquear toda la acción.
 */
export async function solicitarImpuestos(tramiteIds: string[], ctx: TramitesCtx): Promise<ResultadoSolicitudImpuestos> {
  const tramites = await db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit, placa: vehicles.plate,
    impuestoId: flitoImpuestos.id, impuestoEstado: flitoImpuestos.estado,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .where(inArray(flitoTramites.id, tramiteIds));

  const enviables: string[] = [];
  let noEnviables = 0;
  for (const t of tramites) {
    // Sin registro de impuesto = autogestionado (exento); solo 'pendiente' es enviable al gestor.
    if (t.impuestoId && t.impuestoEstado === EstadoImpuesto.PENDIENTE) enviables.push(t.impuestoId);
    else noEnviables += 1;
  }

  const { enviados, yaEnviados } = await enviarImpuestos(enviables, impuestoCtx(ctx));
  return { enviados: enviados.length, yaEnviados: yaEnviados.length, noEnviables };
}

export async function solicitarAmbos(tramiteIds: string[], proveedorSoatId: string, ctx: TramitesCtx): Promise<ResultadoSolicitudAmbos> {
  return {
    soat: await solicitarSoat(tramiteIds, proveedorSoatId, ctx),
    impuestos: await solicitarImpuestos(tramiteIds, ctx),
  };
}

/**
 * Entrega en lote. Reutiliza la compuerta, que revalida cada trámite y solo ejecuta los habilitados;
 * los demás se reportan con su motivo. Un fallo no aborta el lote.
 */
export async function entregar(tramiteIds: string[], ctx: TramitesCtx): Promise<ResultadoEntrega> {
  let entregados = 0;
  const noHabilitados: ResultadoEntrega['noHabilitados'] = [];
  for (const tramiteId of tramiteIds) {
    try {
      await entregarCompuerta(tramiteId, { userId: ctx.userId, username: ctx.username, role: ctx.role });
      entregados += 1;
    } catch (error) {
      const [t] = await db.select({ idFlit: flitoTramites.idFlit, placa: vehicles.plate })
        .from(flitoTramites).innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
        .where(eq(flitoTramites.id, tramiteId)).limit(1);
      noHabilitados.push({
        tramiteId, idFlit: t?.idFlit ?? tramiteId, placa: t?.placa ?? '—',
        motivo: error instanceof Error ? error.message : 'No habilitado',
      });
    }
  }
  return { entregados, noHabilitados };
}
