// TRAM-INNOV-B3 — orquestación de firma electrónica de compraventa.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramitesDigitales, tramiteParticipantes, tramiteFirmas } from '../../db/schema.js';
import { emitEvento } from '../tramites/eventos.js';
import { hayContratoCompraventa } from '../tramites/tramites.service.js';
import { getFirmaProvider } from './factory.js';
import type { FirmaProvider } from './provider.js';
import type { FirmaResumen, FirmaRol } from '@operaciones/shared-types';

export const DOC_TIPO_DEFAULT = 'compraventa';
const ROLES_VALIDOS: readonly FirmaRol[] = ['comprador', 'vendedor'];
const ESTADOS_ACTIVOS = ['pendiente_envio', 'enviada', 'firmada'];

export interface FirmaRow {
  id: number;
  tramiteId: number;
  rol: string;
  docTipo: string;
  proveedor: string;
  envelopeId: string | null;
  estado: string;
  pdfPath: string | null;
  sha256: string | null;
  solicitadoAt: Date;
  firmadoAt: Date | null;
}

export type SolicitarCode =
  | 'not_found' | 'tipologia_invalida' | 'rol_invalido' | 'participante_sin_email' | 'duplicada' | 'contrato_requerido';

export type SolicitarResult =
  | { ok: true; firma: FirmaRow; signUrl: string }
  | { ok: false; code: SolicitarCode; message: string };

export async function solicitarFirma(opts: {
  tramiteId: number;
  rol: string;
  docTipo?: string;
  userId: number | null;
  provider?: FirmaProvider;
}): Promise<SolicitarResult> {
  const docTipo = opts.docTipo || DOC_TIPO_DEFAULT;

  if (!ROLES_VALIDOS.includes(opts.rol as FirmaRol)) {
    return { ok: false, code: 'rol_invalido', message: 'Rol debe ser comprador o vendedor.' };
  }
  const rol = opts.rol as FirmaRol;

  const [t] = await db.select({ id: tramitesDigitales.id, tipologiaCodigo: tramitesDigitales.tipologiaCodigo, modalidad: tramitesDigitales.modalidadEntrada })
    .from(tramitesDigitales).where(eq(tramitesDigitales.id, opts.tramiteId)).limit(1);
  if (!t) return { ok: false, code: 'not_found', message: 'Trámite no encontrado.' };

  // MVP: solo traspaso_standard.
  if (t.tipologiaCodigo !== 'traspaso_standard') {
    return { ok: false, code: 'tipologia_invalida', message: 'La firma de compraventa solo aplica a traspaso estándar.' };
  }

  // TRAM-TRASPASO-F2: en modalidad traspaso, la firma exige contrato de compraventa
  // (generado o subido). Matrícula/otros flujos no se gatean.
  if (t.modalidad === 'traspaso' && !(await hayContratoCompraventa(opts.tramiteId))) {
    return { ok: false, code: 'contrato_requerido', message: 'Genera o sube el contrato de compraventa antes de solicitar la firma.' };
  }

  const [part] = await db.select().from(tramiteParticipantes)
    .where(and(eq(tramiteParticipantes.tramiteId, opts.tramiteId), eq(tramiteParticipantes.rol, rol)))
    .limit(1);
  if (!part || !part.email) {
    return { ok: false, code: 'participante_sin_email', message: `No hay ${rol} con email registrado en el trámite.` };
  }

  // Idempotencia: no duplicar una firma activa (refuerza el índice parcial único).
  const [activa] = await db.select({ id: tramiteFirmas.id }).from(tramiteFirmas)
    .where(and(
      eq(tramiteFirmas.tramiteId, opts.tramiteId),
      eq(tramiteFirmas.rol, rol),
      eq(tramiteFirmas.docTipo, docTipo),
      inArray(tramiteFirmas.estado, ESTADOS_ACTIVOS),
    )).limit(1);
  if (activa) {
    return { ok: false, code: 'duplicada', message: `Ya hay una solicitud de firma activa para el ${rol}.` };
  }

  const provider = opts.provider ?? getFirmaProvider();
  const created = await provider.crearSolicitud({
    tramiteId: opts.tramiteId, rol, docTipo,
    firmante: { nombre: part.nombre, email: part.email },
  });

  const [firma] = await db.insert(tramiteFirmas).values({
    tramiteId: opts.tramiteId,
    participanteId: part.id,
    rol,
    docTipo,
    proveedor: provider.nombre,
    envelopeId: created.envelopeId,
    estado: 'enviada',
    metadata: { signUrl: created.signUrl },
    createdBy: opts.userId,
  }).returning();

  await emitEvento({
    tramiteId: opts.tramiteId, tipo: 'firma_solicitada',
    actorUserId: opts.userId, payload: { rol, docTipo, proveedor: provider.nombre, envelopeId: created.envelopeId },
  });

  return { ok: true, firma: firma as FirmaRow, signUrl: created.signUrl };
}

export async function listarFirmas(tramiteId: number): Promise<FirmaRow[]> {
  const rows = await db.select().from(tramiteFirmas)
    .where(eq(tramiteFirmas.tramiteId, tramiteId))
    .orderBy(desc(tramiteFirmas.solicitadoAt));
  return rows as FirmaRow[];
}

/** Resumen rol+estado para el check de pre-vuelo (shared-types). */
export async function getFirmaResumen(tramiteId: number): Promise<FirmaResumen[]> {
  const rows = await db.select({ rol: tramiteFirmas.rol, estado: tramiteFirmas.estado })
    .from(tramiteFirmas).where(eq(tramiteFirmas.tramiteId, tramiteId));
  return rows
    .filter((r) => r.rol === 'comprador' || r.rol === 'vendedor')
    .map((r) => ({ rol: r.rol as FirmaRol, estado: r.estado as FirmaResumen['estado'] }));
}

export type CompletarResult =
  | { ok: true; firma: FirmaRow }
  | { ok: false; code: 'envelope_no_encontrado'; message: string };

/** Completa (firmada/rechazada) una firma por envelopeId — usado por el webhook. */
export async function completarFirma(opts: {
  envelopeId: string;
  resultado: 'firmada' | 'rechazada';
  pdfPath?: string | null;
  sha256?: string | null;
}): Promise<CompletarResult> {
  const [firma] = await db.select().from(tramiteFirmas)
    .where(eq(tramiteFirmas.envelopeId, opts.envelopeId)).limit(1);
  if (!firma) return { ok: false, code: 'envelope_no_encontrado', message: 'envelopeId desconocido.' };

  const [updated] = await db.update(tramiteFirmas).set({
    estado: opts.resultado,
    firmadoAt: opts.resultado === 'firmada' ? new Date() : null,
    pdfPath: opts.pdfPath ?? firma.pdfPath,
    sha256: opts.sha256 ?? firma.sha256,
  }).where(eq(tramiteFirmas.id, firma.id)).returning();

  await emitEvento({
    tramiteId: firma.tramiteId,
    tipo: opts.resultado === 'firmada' ? 'firma_completada' : 'firma_rechazada',
    payload: { rol: firma.rol, docTipo: firma.docTipo, proveedor: firma.proveedor, envelopeId: opts.envelopeId },
    docHash: opts.sha256 ?? null,
  });

  return { ok: true, firma: updated as FirmaRow };
}
