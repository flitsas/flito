// FLITO — desbloqueo excepcional de la autogestión, por trámite (HU #10980).
//
// Una compañía que autogestiona un concepto no aparece en las colas de FLITO. Pero a veces pide que
// FLITO le gestione N trámites puntuales —Renting autogestiona y aun así encarga unos cuantos— y
// cambiarle la bandera a toda la compañía sería mentir sobre los otros cientos.
//
// Lo importante, y lo que hace que esto NO sea una bandera que filtra: cuando la compañía
// autogestiona, el registro NO EXISTE. El sync se salta la creación de `flito_soat` /
// `flito_impuestos`. Así que desbloquear es CREAR el registro que faltaba y marcarlo.
//
// Dónde va la marca:
//   soat / impuesto — en el propio registro creado. Las colas consultan `flito_soat → clients` sin
//                     pasar por `flito_tramites`, así que una marca en el trámite sería invisible.
//   logistica       — no tiene registro propio; su frontera resuelve por EXISTS sobre la tabla de
//                     excepciones.
//
// Dos consecuencias que hay que mirar de frente:
//   1. El SOAT es por VIN, no por trámite. Desbloquear uno crea el SOAT del vehículo, y ese SOAT
//      sirve a todos los trámites que compartan VIN. Es inherente al modelo, no algo que el diseño
//      pueda evitar; se advierte en la UI.
//   2. Crear un impuesto en 'pendiente' devuelve el trámite de «listo para entregar» a bloqueado en
//      la compuerta. Es correcto —ahora sí falta pagar ese impuesto— pero cambia lo que ve
//      Operaciones, así que también se advierte.

import { and, eq, isNull } from 'drizzle-orm';
import { EstadoImpuesto, EstadoSoat } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  auditLogs, clients, flitoExcepcionesAutogestion, flitoImpuestos, flitoSoat, flitoTramites, vehicles,
} from '../../db/schema.js';
import { modalidadVigente } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-excepciones');

export const CONCEPTO_EXCEPCION = { SOAT: 'soat', IMPUESTO: 'impuesto', LOGISTICA: 'logistica' } as const;
export type ConceptoExcepcion = (typeof CONCEPTO_EXCEPCION)[keyof typeof CONCEPTO_EXCEPCION];

const CONCEPTOS: readonly string[] = Object.values(CONCEPTO_EXCEPCION);
export const esConceptoExcepcion = (v: unknown): v is ConceptoExcepcion =>
  typeof v === 'string' && CONCEPTOS.includes(v);

/** Mínimo del motivo, igual que el que ya exige el cambio de modalidad de un organismo (CA-04). */
export const MOTIVO_MINIMO = 5;

export class ExcepcionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface ExcepcionCtx { userId: number; username: string }

export interface ExcepcionDto {
  id: string; tramiteId: string; concepto: ConceptoExcepcion; motivo: string;
  creadoEn: string; creadoPorNombre: string | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function auditEnTx(tx: Tx, ctx: ExcepcionCtx, resourceId: string, detail: string): Promise<void> {
  await tx.insert(auditLogs).values({
    userId: ctx.userId, userEmail: ctx.username, action: 'update',
    resource: 'flito_excepcion_autogestion', resourceId, detail,
  });
}

interface FilaTramite {
  tramiteId: string; idFlit: string; vin: string | null; vehiculoId: number | null;
  companiaId: number | null; organismoCodigo: string | null; soatId: string | null;
  soatAutogestionable: boolean | null; impuestosAutogestionable: boolean | null;
  logisticaAutogestionable: boolean | null;
  valorImpuestoLiquidado: string | null;
}

async function cargarTramite(tramiteId: string): Promise<FilaTramite> {
  const [f] = await db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    vin: vehicles.vin,
    vehiculoId: flitoTramites.vehiculoId,
    companiaId: flitoTramites.companiaId,
    organismoCodigo: flitoTramites.organismoCodigo,
    soatId: flitoTramites.soatId,
    soatAutogestionable: clients.soatAutogestionable,
    impuestosAutogestionable: clients.impuestosAutogestionable,
    logisticaAutogestionable: clients.logisticaAutogestionable,
    valorImpuestoLiquidado: flitoTramites.valorImpuestoLiquidado,
  }).from(flitoTramites)
    // El VIN vive en el vehículo, no en el trámite: es la llave del SOAT (RN-01).
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .where(eq(flitoTramites.id, tramiteId)).limit(1);

  if (!f) throw new ExcepcionError(404, 'El trámite no existe');
  return f;
}

/** ¿La compañía autogestiona ESE concepto? Si no, no hay nada que desbloquear. */
function autogestiona(f: FilaTramite, concepto: ConceptoExcepcion): boolean {
  if (concepto === CONCEPTO_EXCEPCION.SOAT) return f.soatAutogestionable === true;
  if (concepto === CONCEPTO_EXCEPCION.IMPUESTO) return f.impuestosAutogestionable === true;
  return f.logisticaAutogestionable === true;
}

/**
 * Desbloquea un concepto para un trámite concreto: crea el registro que la autogestión impidió y lo
 * marca como excepción.
 */
export async function desbloquear(
  tramiteId: string, concepto: ConceptoExcepcion, motivo: string, ctx: ExcepcionCtx,
): Promise<ExcepcionDto> {
  const razon = motivo.trim();
  if (razon.length < MOTIVO_MINIMO) {
    throw new ExcepcionError(400, `El motivo es obligatorio (mínimo ${MOTIVO_MINIMO} caracteres): queda en la auditoría del desbloqueo.`);
  }

  const f = await cargarTramite(tramiteId);
  if (f.companiaId === null) throw new ExcepcionError(400, 'El trámite no tiene compañía asociada');
  if (!autogestiona(f, concepto)) {
    // No es un error del sistema: es que no hacía falta. Decirlo evita crear una excepción inútil
    // que después nadie sabe por qué está.
    throw new ExcepcionError(400, `La compañía no autogestiona ${concepto}: FLITO ya lo gestiona y no hay nada que desbloquear.`);
  }

  const [yaHay] = await db.select({ id: flitoExcepcionesAutogestion.id })
    .from(flitoExcepcionesAutogestion)
    .where(and(
      eq(flitoExcepcionesAutogestion.tramiteId, tramiteId),
      eq(flitoExcepcionesAutogestion.concepto, concepto),
      isNull(flitoExcepcionesAutogestion.revocadoEn),
    )).limit(1);
  if (yaHay) throw new ExcepcionError(409, 'Ese concepto ya está desbloqueado para este trámite');

  return db.transaction(async (tx) => {
    let detalleRegistro = '';

    if (concepto === CONCEPTO_EXCEPCION.SOAT) {
      detalleRegistro = await crearSoatExcepcional(tx, f, ctx);
    } else if (concepto === CONCEPTO_EXCEPCION.IMPUESTO) {
      detalleRegistro = await crearImpuestoExcepcional(tx, f, ctx);
    } else {
      // Logística no tiene registro propio: la excepción por sí sola abre la frontera.
      detalleRegistro = 'La logística se habilita por la excepción; no crea registro propio.';
    }

    const [e] = await tx.insert(flitoExcepcionesAutogestion).values({
      tramiteId, concepto, motivo: razon, creadoPorId: ctx.userId,
    }).returning();

    await auditEnTx(tx, ctx, tramiteId,
      `Desbloqueo excepcional de ${concepto} en ${f.idFlit}: ${razon} ${detalleRegistro}`);
    log.info({ tramiteId, idFlit: f.idFlit, concepto }, 'Autogestión desbloqueada excepcionalmente');

    return {
      id: e.id, tramiteId, concepto, motivo: razon,
      creadoEn: e.createdAt.toISOString(), creadoPorNombre: ctx.username,
    };
  });
}

/**
 * Crea el SOAT que la autogestión impidió. Si el VIN ya tiene uno —otro trámite del mismo vehículo
 * ya se desbloqueó—, se marca el existente en vez de duplicar: el SOAT es por VIN (RN-01).
 */
async function crearSoatExcepcional(tx: Tx, f: FilaTramite, ctx: ExcepcionCtx): Promise<string> {
  // Sin VIN no hay llave con la que buscar ni con la que crear: el SOAT se ancla al vehículo.
  if (f.vin === null) throw new ExcepcionError(400, 'El trámite no tiene VIN: el SOAT se ancla al vehículo');
  const [existente] = await tx.select().from(flitoSoat).where(eq(flitoSoat.vin, f.vin)).limit(1);

  if (existente) {
    await tx.update(flitoSoat).set({ excepcionAutogestion: true, updatedAt: new Date() })
      .where(eq(flitoSoat.id, existente.id));
    if (f.soatId !== existente.id) {
      await tx.update(flitoTramites).set({ soatId: existente.id, updatedAt: new Date() })
        .where(eq(flitoTramites.id, f.tramiteId));
    }
    await auditEnTx(tx, ctx, existente.id, `SOAT existente del VIN ${f.vin} marcado como excepción.`);
    return `El VIN ya tenía SOAT (${existente.estado}): se marcó como excepción en vez de duplicarlo.`;
  }

  if (f.vin === null || f.vehiculoId === null || f.organismoCodigo === null) {
    throw new ExcepcionError(400, 'El trámite no tiene VIN, vehículo u organismo resueltos: no se puede crear el SOAT');
  }

  const [soat] = await tx.insert(flitoSoat).values({
    vin: f.vin, vehiculoId: f.vehiculoId, estado: EstadoSoat.PENDIENTE,
    companiaId: f.companiaId!, organismoCodigo: f.organismoCodigo,
    proveedorSoatId: null, proveedorSobrescrito: false, excepcionAutogestion: true,
  }).returning();
  await tx.update(flitoTramites).set({ soatId: soat.id, updatedAt: new Date() })
    .where(eq(flitoTramites.id, f.tramiteId));
  await auditEnTx(tx, ctx, soat.id, `SOAT creado por excepción para VIN ${f.vin}.`);
  return `SOAT creado en Pendiente. Al ser por VIN, cubre a todos los trámites del vehículo ${f.vin}.`;
}

/** Crea el impuesto que la autogestión impidió, en 'pendiente' (listo para enviar al gestor). */
async function crearImpuestoExcepcional(tx: Tx, f: FilaTramite, ctx: ExcepcionCtx): Promise<string> {
  const [existente] = await tx.select().from(flitoImpuestos)
    .where(eq(flitoImpuestos.tramiteId, f.tramiteId)).limit(1);

  if (existente) {
    await tx.update(flitoImpuestos).set({ excepcionAutogestion: true, updatedAt: new Date() })
      .where(eq(flitoImpuestos.id, existente.id));
    await auditEnTx(tx, ctx, existente.id, 'Impuesto existente marcado como excepción.');
    return `El trámite ya tenía impuesto (${existente.estado}): se marcó como excepción.`;
  }

  if (f.organismoCodigo === null) {
    throw new ExcepcionError(400, 'El trámite no tiene organismo resuelto: no se puede crear el impuesto');
  }

  const modalidad = await modalidadVigente(f.organismoCodigo);
  const [impuesto] = await tx.insert(flitoImpuestos).values({
    tramiteId: f.tramiteId, estado: EstadoImpuesto.PENDIENTE, organismoCodigo: f.organismoCodigo,
    companiaId: f.companiaId!, modalidadAplicada: modalidad,
    valorLiquidado: f.valorImpuestoLiquidado, excepcionAutogestion: true,
  }).returning();
  await auditEnTx(tx, ctx, impuesto.id, 'Impuesto creado por excepción, en pendiente.');
  return 'Impuesto creado en Pendiente: el trámite deja de estar listo para entregar hasta que se pague.';
}

/** Deshace un desbloqueo. El registro creado se marca como no excepcional y vuelve a quedar fuera. */
export async function revocar(
  tramiteId: string, concepto: ConceptoExcepcion, motivo: string, ctx: ExcepcionCtx,
): Promise<void> {
  const razon = motivo.trim();
  if (razon.length < MOTIVO_MINIMO) {
    throw new ExcepcionError(400, `El motivo es obligatorio (mínimo ${MOTIVO_MINIMO} caracteres).`);
  }

  const [vigente] = await db.select().from(flitoExcepcionesAutogestion)
    .where(and(
      eq(flitoExcepcionesAutogestion.tramiteId, tramiteId),
      eq(flitoExcepcionesAutogestion.concepto, concepto),
      isNull(flitoExcepcionesAutogestion.revocadoEn),
    )).limit(1);
  if (!vigente) throw new ExcepcionError(404, 'Ese concepto no está desbloqueado para este trámite');

  const f = await cargarTramite(tramiteId);

  await db.transaction(async (tx) => {
    if (concepto === CONCEPTO_EXCEPCION.SOAT && f.soatId) {
      await tx.update(flitoSoat).set({ excepcionAutogestion: false, updatedAt: new Date() })
        .where(eq(flitoSoat.id, f.soatId));
    }
    if (concepto === CONCEPTO_EXCEPCION.IMPUESTO) {
      await tx.update(flitoImpuestos).set({ excepcionAutogestion: false, updatedAt: new Date() })
        .where(eq(flitoImpuestos.tramiteId, tramiteId));
    }
    await tx.update(flitoExcepcionesAutogestion).set({
      revocadoEn: new Date(), revocadoPorId: ctx.userId, revocadoMotivo: razon,
    }).where(eq(flitoExcepcionesAutogestion.id, vigente.id));

    await auditEnTx(tx, ctx, tramiteId, `Revocado el desbloqueo de ${concepto} en ${f.idFlit}: ${razon}`);
  });

  log.info({ tramiteId, concepto }, 'Excepción de autogestión revocada');
}

/** Excepciones vigentes de un trámite, para pintarlas en la fila. */
export async function excepcionesDe(tramiteId: string): Promise<ExcepcionDto[]> {
  const filas = await db.select({
    id: flitoExcepcionesAutogestion.id,
    tramiteId: flitoExcepcionesAutogestion.tramiteId,
    concepto: flitoExcepcionesAutogestion.concepto,
    motivo: flitoExcepcionesAutogestion.motivo,
    createdAt: flitoExcepcionesAutogestion.createdAt,
  }).from(flitoExcepcionesAutogestion)
    .where(and(
      eq(flitoExcepcionesAutogestion.tramiteId, tramiteId),
      isNull(flitoExcepcionesAutogestion.revocadoEn),
    ));

  return filas.map((f) => ({
    id: f.id, tramiteId: f.tramiteId, concepto: f.concepto as ConceptoExcepcion,
    motivo: f.motivo, creadoEn: f.createdAt.toISOString(), creadoPorNombre: null,
  }));
}
