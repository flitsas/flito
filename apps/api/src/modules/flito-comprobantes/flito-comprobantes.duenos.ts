// Comprobantes universales (Épica #12245, Feature #12606, ADR-0018 §4) — HU #12630: los DUEÑOS del pago.
//
// D1 («una verdad por concepto»): aplicar un comprobante como pago de SOAT, impuesto o derecho produce
// EXACTAMENTE lo mismo que resolver hoy la revisión OCR de ese concepto, porque escribe el mismo código:
//   · SOAT     → `aplicarFacturaSoat` de revisiones (que llama `marcarPagado`: historial, audit, RN-03).
//   · impuesto → `conciliar` de recibos (estado, valor_pagado, marcado_por_diferencia, historial).
//   · derecho  → `registrarDesdeRevision` de derechos (con `derechoDeTramite` ANTES, AC3).
// Aquí no se escribe `flito_soat.estado`, `flito_impuestos.estado` ni una fila de derecho: mutantes AC1..AC3.
//
// Las GUARDAS (AC4) leen el estado real del destino (no el `admite` cacheado del candidato) y responden
// 409 `ya_pagado` / `destino_no_admite` con `puedeAdjuntar` (D6) ANTES de que `aplicar` suba nada a S3.
//
// Transacciones: `conciliar` recibe la `tx` del comprobante y escribe DENTRO. `marcarPagado` y
// `registrar` (derechos) abren su propia `db.transaction` y necesitan VER el soporte ya atado (`soat_id`
// + `factura_soat`, o la fila del hijo), así que SOAT y derecho corren TRAS el commit de la tx del
// comprobante (patrón de `resolverSoat` / `resolverDerecho` en revisiones, que hacen exactamente eso).
//
// Ningún log lleva contenido leído (Habeas Data).

import { eq } from 'drizzle-orm';
import {
  CodigoErrorComprobante, ConceptoCosto, ESTADO_IMPUESTO_LABEL, ESTADO_SOAT_LABEL, EstadoImpuesto, EstadoSoat,
  TipoDocumentoComprobante, TipoSoporte, type CampoExtraido, type ExtraccionDerechoTramite, type ExtraccionImpuesto, type ExtraccionSoat,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestos, flitoSoat, flitoTramites } from '../../db/schema.js';
import { aplicarFacturaSoat } from '../flito-revisiones/flito-revisiones.service.js';
import { candidatoPorImpuestoId, conciliar, remarcarConfiable, type Candidato } from '../flito-impuestos/flito-recibos.service.js';
import { derechoDeTramite, registrarDesdeRevision, TIPO_SOPORTE_DERECHO } from '../flito-derechos/flito-derechos.service.js';
import { umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import type { Tx } from '../finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js';
import { ComprobanteError, type ComprobanteCtx } from './flito-comprobantes.service.js';

/** `db` fuera de la tx (guarda previa a S3) o la `tx` (guarda bajo el bloqueo): ambos saben `select`. */
type Lector = Pick<typeof db, 'select'>;

export type ConceptoConDueno = typeof ConceptoCosto.SOAT | typeof ConceptoCosto.IMPUESTO | typeof ConceptoCosto.DERECHO;

/** Los conceptos cuyo pago tiene dueño en esta HU; los honorarios siguen por el eslabón hasta HU-3. */
export const CONCEPTOS_CON_DUENO: readonly ConceptoCosto[] = [ConceptoCosto.SOAT, ConceptoCosto.IMPUESTO, ConceptoCosto.DERECHO];

export function tieneDueno(concepto: ConceptoCosto): concepto is ConceptoConDueno {
  return CONCEPTOS_CON_DUENO.includes(concepto);
}

/** Lo que la guarda averiguó del destino y `aplicar` necesita para atar el soporte y pagar. */
export interface DestinoPago {
  concepto: ConceptoConDueno;
  /** La FK que lleva el soporte aplicado (`derecho_id` la pone el propio dueño al registrar). */
  fk: { soatId?: string; impuestoId?: string };
  /** El `tipo` del soporte aplicado: `pagarEnTx` (SOAT) y el ZIP (impuestos) lo exigen. */
  tipoSoporte: string;
  /** Solo impuesto: el `Candidato` que `conciliar` necesita. */
  candidato: Candidato | null;
}

// ─────────────────────────── Errores (D6) ────────────────────────────────────

const yaPagado = (detalle: string) =>
  new ComprobanteError(409, CodigoErrorComprobante.YA_PAGADO, 'Ese destino ya está pagado', { detalle, puedeAdjuntar: true });
const noAdmite = (detalle: string, puedeAdjuntar: boolean) =>
  new ComprobanteError(409, CodigoErrorComprobante.DESTINO_NO_ADMITE, 'El destino no admite este pago', { detalle, puedeAdjuntar });

// ─────────────────────────── Guardas por concepto (AC4) ──────────────────────

/** SOAT: `flito_tramites.soat_id` (no único: un SOAT sirve a N trámites) y el estado REAL de `flito_soat`. */
async function guardaSoat(lector: Lector, tramiteId: string): Promise<DestinoPago> {
  const [f] = await lector.select({ soatId: flitoTramites.soatId, soatEstado: flitoSoat.estado }).from(flitoTramites)
    .leftJoin(flitoSoat, eq(flitoSoat.id, flitoTramites.soatId)).where(eq(flitoTramites.id, tramiteId)).limit(1);
  if (!f?.soatId) throw noAdmite('Ese trámite no tiene un SOAT que atar', false);
  if (f.soatEstado === EstadoSoat.PAGADO) throw yaPagado('Ese SOAT ya está pagado');
  if (f.soatEstado !== EstadoSoat.SOLICITADO) {
    throw noAdmite(`El SOAT no está en adquisición (${ESTADO_SOAT_LABEL[f.soatEstado as EstadoSoat] ?? f.soatEstado ?? '—'})`, true);
  }
  return { concepto: ConceptoCosto.SOAT, fk: { soatId: f.soatId }, tipoSoporte: TipoSoporte.FACTURA_SOAT, candidato: null };
}

/** Impuesto: la fila de `flito_impuestos` del trámite y su estado REAL; el candidato de `conciliar` sale de recibos. */
async function guardaImpuesto(lector: Lector, tramiteId: string, tipoDocumento: string | null): Promise<DestinoPago> {
  const [i] = await lector.select({ id: flitoImpuestos.id, estado: flitoImpuestos.estado }).from(flitoImpuestos)
    .where(eq(flitoImpuestos.tramiteId, tramiteId)).limit(1);
  if (!i) throw noAdmite('Ese trámite no tiene un impuesto que atar', false);
  if (i.estado === EstadoImpuesto.PAGADO) throw yaPagado('Ese impuesto ya está pagado');
  if (i.estado !== EstadoImpuesto.SOLICITADO) {
    throw noAdmite(`El impuesto no está en gestión (${ESTADO_IMPUESTO_LABEL[i.estado as EstadoImpuesto] ?? i.estado})`, true);
  }
  const candidato = await candidatoPorImpuestoId(i.id);
  if (!candidato) throw noAdmite('Ese impuesto no tiene organismo o compañía con los que conciliar', false);
  const tipoSoporte = tipoDocumento === TipoDocumentoComprobante.RECIBO_CAJA_IMPUESTO ? TipoSoporte.RECIBO_CAJA_IMPUESTO : TipoSoporte.RECIBO_IMPUESTO;
  return { concepto: ConceptoCosto.IMPUESTO, fk: { impuestoId: i.id }, tipoSoporte, candidato };
}

/**
 * Derecho: `derechoDeTramite` ANTES de todo (AC3: el 400 de `DerechoError` «ya tiene registrado» nunca
 * llega a la persona; aquí es 409 `ya_pagado`), y el trámite tiene que estar `aprobado` en FLIT.
 */
async function guardaDerecho(lector: Lector, tramiteId: string): Promise<DestinoPago> {
  if (await derechoDeTramite(tramiteId)) throw yaPagado('Ese trámite ya tiene registrado su derecho de tránsito');
  const [t] = await lector.select({ flitEstado: flitoTramites.flitEstado }).from(flitoTramites).where(eq(flitoTramites.id, tramiteId)).limit(1);
  if (!t) throw new ComprobanteError(404, CodigoErrorComprobante.NO_ENCONTRADO, 'El trámite no existe');
  if ((t.flitEstado ?? '').toLowerCase() !== 'aprobado') {
    throw noAdmite('El derecho de tránsito solo se registra sobre un trámite aprobado en FLIT', true);
  }
  return { concepto: ConceptoCosto.DERECHO, fk: {}, tipoSoporte: TIPO_SOPORTE_DERECHO, candidato: null };
}

/**
 * La guarda del destino para un pago (AC4). Se llama DOS veces desde `aplicar`: con `db` antes de subir
 * nada a S3 (el 409 no deja objeto huérfano) y con la `tx` bajo el bloqueo del trámite (la carrera con
 * otro pago del mismo destino se pierde aquí, no en el dueño).
 */
export async function comprobarDestinoPago(lector: Lector, tramiteId: string, concepto: ConceptoConDueno, tipoDocumento: string | null): Promise<DestinoPago> {
  if (concepto === ConceptoCosto.SOAT) return guardaSoat(lector, tramiteId);
  if (concepto === ConceptoCosto.IMPUESTO) return guardaImpuesto(lector, tramiteId, tipoDocumento);
  return guardaDerecho(lector, tramiteId);
}

// ─────────────────────────── Escrituras del dueño ────────────────────────────

export interface PagoArgs {
  tramiteId: string;
  soporteAplicadoId: string;
  /** La extracción del extractor especializado, ya confirmada por la persona; `{}` si no la hubo. */
  extraccionDestino: Record<string, CampoExtraido>;
  motivo: string | null;
  /** La fecha de pago leída (universal `fechaPago`), o `null` → «hoy» (patrón de la carga masiva). */
  fechaPago: Date | null;
  ctx: ComprobanteCtx;
}

/**
 * Dentro de la tx del comprobante: solo el impuesto (`conciliar` recibe la `tx`). Devuelve lo que
 * `conciliar` calculó; `null` para los otros dueños. El umbral: el usuario de comprobantes no es gestor
 * de organismo (`organismos: []`), así que aplica el de Operaciones —lo mismo que `umbralDelCandidato`
 * hace en recibos para quien no es gestor—.
 */
export async function pagarEnTx(tx: Tx, destino: DestinoPago, a: PagoArgs): Promise<{ valorPagado: string | null; marcadoPorDiferencia: boolean } | null> {
  if (destino.concepto !== ConceptoCosto.IMPUESTO || !destino.candidato) return null;
  const extraccion = remarcarConfiable(a.extraccionDestino as ExtraccionImpuesto, umbralPara(null));
  return conciliar(tx, destino.candidato, extraccion, a.soporteAplicadoId, { ...a.ctx, organismos: [] }, a.fechaPago ?? new Date());
}

/**
 * Tras el commit: SOAT (`aplicarFacturaSoat` → `marcarPagado`, con `SoatCtx` sin proveedor ni compañía)
 * y derecho (`registrarDesdeRevision`, que ata `derecho_id` al soporte). Abren su propia tx y leen el
 * soporte que la tx del comprobante acaba de escribir.
 */
export async function pagarTrasCommit(destino: DestinoPago, a: PagoArgs): Promise<void> {
  const motivo = a.motivo ?? 'Trámite sugerido por el cruce del comprobante';
  if (destino.concepto === ConceptoCosto.SOAT) {
    await aplicarFacturaSoat(a.soporteAplicadoId, destino.fk.soatId!, a.extraccionDestino as ExtraccionSoat, motivo, a.ctx);
  } else if (destino.concepto === ConceptoCosto.DERECHO) {
    await registrarDesdeRevision(a.tramiteId, a.extraccionDestino as ExtraccionDerechoTramite, a.soporteAplicadoId, a.ctx);
  }
}
