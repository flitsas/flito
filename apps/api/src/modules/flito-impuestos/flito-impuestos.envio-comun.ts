// FLITO Impuestos — piezas comunes del envío del comprobante de pago a FLIT 2 y a FLIT 1 (HU #13268 y
// HU #13310; ADR-0020 y ADR-0021). Diseño `docs/diseno/feature-13309-envio-comprobante-flit1.md` §7.1.
// Outbox `flito_impuesto_envios_flit2` (una fila por impuesto); desde la 0221 cada fila lleva su
// `destino` y cada destino tiene su ciclo propio (`envio-flit2.service.ts`, `envio-flit1.service.ts`).
//
// RN-01 Disparo (outbox). `programarEnvioComprobante(tx, impuestoId)` se llama DENTRO de la transacción
//   del pago y solo escribe la fila: el pago no espera a nadie. Fuente `flit2` → destino `flit2`; fuente
//   `flit` → destino `flit1`; otra → nada (`sin_destino`). Elige el soporte (AC2 de #13268) y aplica la
//   tabla de transiciones en un solo `INSERT … ON CONFLICT DO UPDATE … WHERE`. El destino se fija al crear
//   la fila y el `ON CONFLICT` no lo cambia. Toda reapertura limpia las columnas de FLIT 1
//   (`archivo_flit1_id`, `ultimo_paso`): soporte distinto → se reempieza desde el paso 1.
// RN-02 Sin retroactivo. Solo `programarEnvioComprobante` CREA filas, y solo desde un camino a `pagado`.
// RN-07 Desenlace. `escribir` = `UPDATE … WHERE id AND version = tomada`: si la fila se reprogramó
//   mientras tanto, el desenlace viejo no la pisa (queda dicho en auditoría).
// RN-09 Lectura (AC10). `envioDeImpuesto` → `{ envioComprobante, envioFlit2 }` en UNA consulta; cada uno
//   null si no hay fila o el destino no corresponde a la fuente actual del trámite.

import type { Readable } from 'stream';
import type { Request } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  EstadoEnvioFlit2, TipoSoporte, type DestinoEnvioComprobante, type EnvioComprobante, type EnvioComprobanteFlit2,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { auditLogs, flitoImpuestoEnviosFlit2, flitoImpuestos, flitoSoportes, flitoTramites } from '../../db/schema.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { getEntityDocumentStream } from '../../services/storage.js';
import { RECURSO_IMPUESTO } from './flito-impuestos.pii.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Escritor = Tx | typeof db;

const T = flitoImpuestoEnviosFlit2;

export type Cambios = Partial<typeof T.$inferInsert>;
/** Toda salida de `en_espera` limpia ambas columnas (lo exige el CHECK de la 0219). */
export const SALE_DE_ESPERA: Cambios = { syncVersionEspera: null, enEsperaDesde: null };

/** Error de dominio del envío (no sale a HTTP: lo traduce el ciclo a un desenlace). */
export class EnvioComprobanteError extends Error {
  constructor(public codigo: string, message: string) {
    super(message);
    this.name = 'EnvioComprobanteError';
  }
}

const ETIQUETA: Record<DestinoEnvioComprobante, string> = { flit1: 'FLIT 1', flit2: 'FLIT 2' };

/** Destino del envío según la fuente del trámite; null = la fuente no recibe el comprobante. */
export function destinoDeFuente(fuente: string | null | undefined): DestinoEnvioComprobante | null {
  if (fuente === 'flit2') return 'flit2';
  if (fuente === 'flit') return 'flit1';
  return null;
}

// ── AC2 (#13268): elección del comprobante ───────────────────────────────────────────────────────

export interface SoporteCandidato { id: string; tipo: string; subidoEn: Date }

/**
 * Pura: el recibo de pago más reciente; si no hay, el recibo de caja más reciente; el recibo de
 * liquidación (sin marca de agua) NUNCA. Los descartados no llegan aquí (los filtra la consulta).
 */
export function elegirDeSoportes(soportes: SoporteCandidato[]): string | null {
  const masReciente = (tipo: string): SoporteCandidato | undefined =>
    soportes.filter((s) => s.tipo === tipo).sort((a, b) => b.subidoEn.getTime() - a.subidoEn.getTime())[0];
  return (masReciente(TipoSoporte.RECIBO_IMPUESTO) ?? masReciente(TipoSoporte.RECIBO_CAJA_IMPUESTO))?.id ?? null;
}

export async function elegirComprobante(escritor: Escritor, impuestoId: string): Promise<string | null> {
  const filas = await escritor.select({ id: flitoSoportes.id, tipo: flitoSoportes.tipo, subidoEn: flitoSoportes.subidoEn })
    .from(flitoSoportes)
    .where(and(
      eq(flitoSoportes.impuestoId, impuestoId),
      eq(flitoSoportes.descartado, false),
      inArray(flitoSoportes.tipo, [TipoSoporte.RECIBO_IMPUESTO, TipoSoporte.RECIBO_CAJA_IMPUESTO]),
    ));
  return elegirDeSoportes(filas as SoporteCandidato[]);
}

export async function fuenteDelImpuesto(escritor: Escritor, impuestoId: string): Promise<string | null> {
  const [f] = await escritor.select({ fuente: flitoTramites.fuente })
    .from(flitoImpuestos).innerJoin(flitoTramites, eq(flitoTramites.id, flitoImpuestos.tramiteId))
    .where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  return f?.fuente ?? null;
}

// ── RN-01: programación dentro de la tx del pago ────────────────────────────────────────────────

/**
 * RN-01. Dentro de la `tx` del pago. Devuelve qué hizo (para el test y la traza), sin lanzar por
 * reglas: un trámite cuya fuente no recibe el comprobante es un no-op silencioso.
 */
export async function programarEnvioComprobante(
  tx: Escritor, impuestoId: string, ahora: Date = new Date(),
): Promise<'sin_destino' | 'sin_comprobante' | 'programado'> {
  const destino = destinoDeFuente(await fuenteDelImpuesto(tx, impuestoId));
  if (!destino) return 'sin_destino';
  const soporteId = await elegirComprobante(tx, impuestoId);
  if (!soporteId) {
    // Sin error ni intentos. Si la fila ya existía (cualquier estado), no se toca.
    await tx.insert(T).values({ impuestoId, destino, estado: EstadoEnvioFlit2.SIN_COMPROBANTE, soporteId: null })
      .onConflictDoNothing({ target: T.impuestoId });
    return 'sin_comprobante';
  }
  const reabre = sql`${T.estado} IN ('sin_comprobante','enviado')`;
  await tx.insert(T).values({
    impuestoId, destino, estado: EstadoEnvioFlit2.PENDIENTE, soporteId, intentos: 0, proximoIntentoEn: ahora,
  }).onConflictDoUpdate({
    target: T.impuestoId,
    set: {
      // sin_comprobante → pendiente; enviado con OTRO soporte → pendiente desde cero (D-2 de ADR-0020).
      estado: sql`CASE WHEN ${reabre} THEN 'pendiente' ELSE ${T.estado} END`,
      soporteId: sql`excluded.soporte_id`,
      intentos: sql`CASE WHEN ${T.estado} = 'enviado' THEN 0 ELSE ${T.intentos} END`,
      version: sql`CASE WHEN ${T.estado} = 'enviado' THEN ${T.version} + 1 ELSE ${T.version} END`,
      proximoIntentoEn: sql`CASE WHEN ${reabre} THEN excluded.proximo_intento_en ELSE ${T.proximoIntentoEn} END`,
      // Toda rama del WHERE implica soporte distinto o sin_comprobante: FLIT 1 reempieza desde el paso 1.
      archivoFlit1Id: null,
      ultimoPaso: null,
      updatedAt: sql`now()`,
    },
    // Tabla de transiciones RN-01: lo que no está aquí (enviado con el mismo soporte,
    // ya_cargado_gestor, error, o el mismo soporte en pendiente/en_espera) no se toca.
    where: sql`${T.estado} = 'sin_comprobante'
      OR (${T.estado} IN ('pendiente','en_espera') AND ${T.soporteId} IS DISTINCT FROM excluded.soporte_id)
      OR (${T.estado} = 'enviado' AND ${T.soporteEnviadoId} IS DISTINCT FROM excluded.soporte_id)`,
  });
  return 'programado';
}

// ── RN-09 / AC10: lectura para el detalle ───────────────────────────────────────────────────────

export interface FilaLecturaEnvio {
  fuente: string | null;
  /** Ausente en lecturas previas a la 0221 (se trata como el destino de la fuente). */
  destino?: string | null;
  estado: EnvioComprobanteFlit2['estado'] | null;
  intentos: number | null;
  ultimoIntentoEn: Date | null;
}

/** Pura (AC10): null si no hay fila o el destino no corresponde a la fuente actual del trámite. */
export function envioDesdeFila(f: FilaLecturaEnvio | undefined): EnvioComprobante | null {
  if (!f || !f.estado) return null;
  const destino = destinoDeFuente(f.fuente);
  if (!destino || (f.destino != null && f.destino !== destino)) return null;
  return {
    destino, estado: f.estado, intentos: Number(f.intentos) || 0,
    ultimoIntentoEn: f.ultimoIntentoEn ? new Date(f.ultimoIntentoEn).toISOString() : null,
  };
}

/** Lo que pinta hoy la celda de FLIT 2 (sin cambio de forma): solo destino `flit2`. */
export function envioFlit2DesdeFila(f: FilaLecturaEnvio | undefined): EnvioComprobanteFlit2 | null {
  const e = envioDesdeFila(f);
  if (!e || e.destino !== 'flit2') return null;
  return { estado: e.estado, intentos: e.intentos, ultimoIntentoEn: e.ultimoIntentoEn };
}

export async function envioDeImpuesto(impuestoId: string): Promise<{ envioComprobante: EnvioComprobante | null; envioFlit2: EnvioComprobanteFlit2 | null }> {
  const [f] = await db.select({
    fuente: flitoTramites.fuente, destino: T.destino, estado: T.estado, intentos: T.intentos, ultimoIntentoEn: T.ultimoIntentoEn,
  })
    .from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoTramites.id, flitoImpuestos.tramiteId))
    .leftJoin(T, eq(T.impuestoId, flitoImpuestos.id))
    .where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  return { envioComprobante: envioDesdeFila(f), envioFlit2: envioFlit2DesdeFila(f) };
}

// ── Envío de una fila: soporte, bytes, auditoría ────────────────────────────────────────────────

/** Lectura del comprobante por un proceso sin `Request` (AC9: acceso del sistema). */
export async function registrarLecturaPii(destino: DestinoEnvioComprobante, impuestoId: string, intento: number): Promise<void> {
  const reqSistema = { headers: {}, ip: undefined } as unknown as Request;
  await logPiiAccess(reqSistema, {
    resourceTipo: RECURSO_IMPUESTO,
    resourceId: null, // uuid: no cabe en la columna integer; va en el motivo
    accion: 'read',
    camposAccedidos: ['comprobante_pago_impuesto'],
    motivo: `envio_${destino} (sistema) — intento ${intento} · impuesto ${impuestoId}`,
  });
}

export async function leerBytes(storageKey: string, max: number): Promise<Buffer> {
  const stream = await getEntityDocumentStream(storageKey) as Readable;
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    total += b.length;
    if (total > max) { stream.destroy(); throw new EnvioComprobanteError('file_too_large', 'el objeto supera el límite'); }
    trozos.push(b);
  }
  return Buffer.concat(trozos);
}

export async function auditar(impuestoId: string, detail: string): Promise<void> {
  await db.insert(auditLogs).values({ userId: null, userEmail: 'sistema', action: 'update', resource: 'flito_impuesto', resourceId: impuestoId, detail });
}

export interface FilaVersionada { id: string; impuestoId: string; version: number; soporteId: string | null }

/** RN-07: escribe con guarda de versión; si se reprogramó mientras tanto, lo deja dicho en auditoría. */
export async function escribir(destino: DestinoEnvioComprobante, fila: FilaVersionada, cambios: Cambios, ahora: Date): Promise<boolean> {
  const r = await db.update(T).set({ ...cambios, tomadoPor: null, tomadoEn: null, updatedAt: ahora })
    .where(and(eq(T.id, fila.id), eq(T.version, fila.version))).returning({ id: T.id });
  if (r.length === 0) {
    await auditar(fila.impuestoId, `Envío a ${ETIQUETA[destino]} · desenlace descartado por reprogramación · fila ${fila.id}`);
    return false;
  }
  return true;
}

/** Soporte vigente de la fila: el guardado si sigue vivo y es del impuesto; si no, se re-elige. */
export async function soporteVigente(fila: Pick<FilaVersionada, 'impuestoId' | 'soporteId'>): Promise<{ id: string; storageKey: string } | null> {
  if (fila.soporteId) {
    const [s] = await db.select({ id: flitoSoportes.id, storageKey: flitoSoportes.storageKey, descartado: flitoSoportes.descartado, impuestoId: flitoSoportes.impuestoId })
      .from(flitoSoportes).where(eq(flitoSoportes.id, fila.soporteId)).limit(1);
    if (s && !s.descartado && s.impuestoId === fila.impuestoId) return { id: s.id, storageKey: s.storageKey };
  }
  const otro = await elegirComprobante(db, fila.impuestoId);
  if (!otro) return null;
  const [s] = await db.select({ id: flitoSoportes.id, storageKey: flitoSoportes.storageKey }).from(flitoSoportes).where(eq(flitoSoportes.id, otro)).limit(1);
  return s ?? null;
}
