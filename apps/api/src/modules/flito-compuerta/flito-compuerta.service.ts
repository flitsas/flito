// FLITO Compuerta de entrega (Fase 5 P2). Porta packages/server/src/compuerta/compuerta.servicio.ts.
//
// Dos precisiones del FEATURE_IMPUESTOS §10 que definen el diseño:
//   1. "Resuelto" no es "pagado": un trámite exento por configuración está resuelto sin pagar (CA-12).
//   2. La compuerta HABILITA, no ejecuta: `evaluar`/`listar` nunca escriben; el paso a Entregado es un
//      acto explícito de Operaciones que además REVALIDA (entre pintar la pantalla y hacer clic, un
//      SOAT pudo reversarse). RETENIDO no resuelve (CA-13, "el peor de los dos errores", §6.1).

import { and, eq } from 'drizzle-orm';
import {
  CampoImpuesto, CampoSoat, EstadoImpuesto, EstadoSoat, EstadoTramiteFlito,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoImpuestos, flitoSoat, flitoTramites, vehicles,
} from '../../db/schema.js';
import { getFlitAdapter } from '../flito-sync/flit.adapter.js';
import type { FlitPort } from '../flito-sync/flit.port.js';

export interface CompuertaCtx { userId: number; username: string; role: string }

export class CompuertaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'CompuertaError';
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface Veredicto {
  soatResuelto: boolean;
  soatDetalle: string;
  impuestosResueltos: boolean;
  impuestosDetalle: string;
  /** Lo que costó cada cosa, si ya se pagó. null = "no lleva / no pagó", NO cero (base del 4x1000). */
  valorSoat: number | null;
  valorImpuesto: number | null;
  /** Fechas leídas por OCR, para verlas al entregar (§9.3). null si no hay documento leído. */
  fechaExpedicionSoat: string | null;
  vigenciaDesdeSoat: string | null;
  vigenciaHastaSoat: string | null;
  fechaExpedicionImpuesto: string | null;
  habilitado: boolean;
}

export interface CompuertaDto extends Veredicto {
  tramiteId: string;
  idFlit: string;
  placa: string | null;
  companiaNombre: string;
  estadoTramite: string | null;
}

// Fila cruda del trámite con todo lo que la regla del §10 necesita, ya cargado por join.
interface FilaCompuerta {
  tramiteId: string;
  idFlit: string;
  estadoTramite: string | null;
  placa: string | null;
  companiaNombre: string;
  soatAutogestionable: boolean;
  impuestosAutogestionable: boolean;
  soatEstado: string | null;
  soatValorPagado: string | null;
  soatExtraccion: unknown;
  impuestoEstado: string | null;
  impuestoValorPagado: string | null;
  impuestoMarcadoPorDiferencia: boolean | null;
  impuestoExtraccion: unknown;
}

function proyeccion() {
  return db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    estadoTramite: flitoTramites.estado,
    createdAt: flitoTramites.createdAt,
    placa: vehicles.plate,
    companiaNombre: clients.name,
    soatAutogestionable: clients.soatAutogestionable,
    impuestosAutogestionable: clients.impuestosAutogestionable,
    soatEstado: flitoSoat.estado,
    soatValorPagado: flitoSoat.valorPagado,
    soatExtraccion: flitoSoat.extraccion,
    impuestoEstado: flitoImpuestos.estado,
    impuestoValorPagado: flitoImpuestos.valorPagado,
    impuestoMarcadoPorDiferencia: flitoImpuestos.marcadoPorDiferencia,
    impuestoExtraccion: flitoImpuestos.extraccion,
  }).from(flitoTramites)
    .innerJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id));
}

function leer(extraccion: unknown, campo: string): string | null {
  const e = extraccion as Record<string, { valor: string | null } | undefined> | null | undefined;
  return e?.[campo]?.valor ?? null;
}

/**
 * La regla del §10, sobre una fila ya cargada. Función pura y reutilizable por el módulo unificado de
 * Trámites (P3) para pintar "listo para entregar" sin duplicar la regla.
 *
 * La asimetría SOAT/Impuestos es intencional: Impuestos tiene estado `No aplica` para la exención;
 * SOAT no lo tiene y la exención se representa con el interruptor de la compañía.
 */
export function decidir(f: FilaCompuerta): Veredicto {
  let soatResuelto: boolean;
  let soatDetalle: string;
  if (f.soatAutogestionable) {
    soatResuelto = true;
    soatDetalle = 'La compañía autogestiona su SOAT';
  } else if (!f.soatEstado) {
    soatResuelto = false;
    soatDetalle = 'El trámite aún no tiene registro de SOAT';
  } else if (f.soatEstado === EstadoSoat.PAGADO) {
    soatResuelto = true;
    soatDetalle = 'SOAT pagado con factura validada';
  } else {
    soatResuelto = false;
    soatDetalle = `SOAT en estado "${f.soatEstado}"`;
  }

  // La exención de impuestos ya no es un estado: si FLITO gestiona (compañía no autogestiona +
  // organismo requiere_gestion) el sync crea el registro; si es autogestionado, NO hay registro. Así,
  // "sin registro" = exento (resuelto), y con registro sólo resuelve cuando está Pagado.
  let impuestosResueltos: boolean;
  let impuestosDetalle: string;
  if (!f.impuestoEstado) {
    impuestosResueltos = true;
    impuestosDetalle = f.impuestosAutogestionable
      ? 'La compañía autogestiona sus impuestos'
      : 'El organismo autogestiona sus impuestos';
  } else if (f.impuestoEstado === EstadoImpuesto.PAGADO) {
    impuestosResueltos = true;
    impuestosDetalle = f.impuestoMarcadoPorDiferencia
      ? 'Impuesto pagado, marcado para revisión por diferencia de valor'
      : 'Impuesto pagado y conciliado';
  } else {
    impuestosResueltos = false;
    impuestosDetalle = `Impuesto en estado "${f.impuestoEstado}"`;
  }

  return {
    soatResuelto,
    soatDetalle,
    impuestosResueltos,
    impuestosDetalle,
    valorSoat: f.soatEstado === EstadoSoat.PAGADO && f.soatValorPagado !== null ? Number(f.soatValorPagado) : null,
    valorImpuesto: f.impuestoEstado === EstadoImpuesto.PAGADO && f.impuestoValorPagado !== null ? Number(f.impuestoValorPagado) : null,
    fechaExpedicionSoat: leer(f.soatExtraccion, CampoSoat.FECHA_EXPEDICION),
    vigenciaDesdeSoat: leer(f.soatExtraccion, CampoSoat.VIGENCIA_DESDE),
    vigenciaHastaSoat: leer(f.soatExtraccion, CampoSoat.VIGENCIA_HASTA),
    fechaExpedicionImpuesto: leer(f.impuestoExtraccion, CampoImpuesto.FECHA_PAGO),
    habilitado: soatResuelto && impuestosResueltos && f.estadoTramite === EstadoTramiteFlito.ASIGNADO,
  };
}

function aDto(f: FilaCompuerta): CompuertaDto {
  return {
    tramiteId: f.tramiteId,
    idFlit: f.idFlit,
    placa: f.placa,
    companiaNombre: f.companiaNombre,
    estadoTramite: f.estadoTramite,
    ...decidir(f),
  };
}

/** Evalúa un trámite. Nunca escribe. 404 si no existe. */
export async function evaluar(tramiteId: string): Promise<CompuertaDto> {
  const [f] = await proyeccion().where(eq(flitoTramites.id, tramiteId)).limit(1);
  if (!f) throw new CompuertaError(404, 'El trámite no existe');
  return aDto(f);
}

/** Trámites en Asignado con su veredicto, para el tablero de Operaciones. */
export async function listar(soloHabilitados = false): Promise<CompuertaDto[]> {
  const rows = await proyeccion()
    .where(eq(flitoTramites.estado, EstadoTramiteFlito.ASIGNADO))
    .orderBy(flitoTramites.createdAt);
  const evaluados = rows.map(aDto);
  return soloHabilitados ? evaluados.filter((e) => e.habilitado) : evaluados;
}

/**
 * Ejecuta el paso a Entregado. Solo Operaciones, y solo si la compuerta lo habilita. Se REVALIDA aquí
 * en vez de confiar en el tablero. La marca en FLIT va antes de persistir localmente (como el original).
 */
export async function entregar(tramiteId: string, ctx: CompuertaCtx, flit: FlitPort = getFlitAdapter()): Promise<CompuertaDto> {
  const [f] = await proyeccion().where(eq(flitoTramites.id, tramiteId)).limit(1);
  if (!f) throw new CompuertaError(404, 'El trámite no existe');
  const veredicto = decidir(f);
  if (!veredicto.habilitado) {
    throw new CompuertaError(400,
      `El trámite no está habilitado para entrega. SOAT: ${veredicto.soatDetalle}. Impuestos: ${veredicto.impuestosDetalle}.`);
  }

  await flit.marcarEntregado(f.idFlit);

  await db.transaction(async (tx) => {
    await tx.update(flitoTramites)
      .set({ estado: EstadoTramiteFlito.ENTREGADO, updatedAt: new Date() })
      .where(eq(flitoTramites.id, tramiteId));
    await tx.insert(auditLogs).values({
      userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'flito_tramite', resourceId: tramiteId,
      detail: `Entrega confirmada (asignado→entregado). FLIT ${f.idFlit}. SOAT: ${veredicto.soatDetalle}. Impuestos: ${veredicto.impuestosDetalle}.`,
    });
  });

  return evaluar(tramiteId);
}

/**
 * Reemplazo de los `@OnEvent('soat.pagado'|'impuestos.pagado'|'impuestos.no_aplica')` por llamada
 * directa (§4.4): SOAT/Impuestos invocan esto tras resolver una condición. No entrega nada — solo deja
 * constancia (actor sistema) de que la compuerta quedó habilitada. La entrega la confirma Operaciones.
 * Idempotente y sin efecto funcional sobre la entrega (que revalida igual).
 */
export async function registrarHabilitaciones(carga: { soatId?: string; tramiteId?: string }, exec: Tx | typeof db = db): Promise<void> {
  if (!carga.tramiteId && !carga.soatId) return;
  const cond = carga.tramiteId
    ? eq(flitoTramites.id, carga.tramiteId)
    : eq(flitoTramites.soatId, carga.soatId!);
  const rows = await proyeccion().where(and(eq(flitoTramites.estado, EstadoTramiteFlito.ASIGNADO), cond));

  for (const f of rows) {
    const veredicto = decidir(f);
    if (!veredicto.habilitado) continue;
    await exec.insert(auditLogs).values({
      userId: null, userEmail: 'sistema', action: 'update', resource: 'flito_tramite', resourceId: f.tramiteId,
      detail: `Compuerta habilitada. FLIT ${f.idFlit}. SOAT: ${veredicto.soatDetalle}. Impuestos: ${veredicto.impuestosDetalle}. ` +
        'La compuerta habilita; la entrega la confirma Operaciones.',
    });
  }
}
