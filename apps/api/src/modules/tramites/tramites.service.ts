// TRAM-12a (cierra TODO #9) — capa de servicio del módulo trámites.
//
// Concentra la lógica de negocio que vivía en `tramites.routes.ts`: CRUD,
// transiciones de estado validadas y orquestación de generación de FUR (CEA, vía
// el cliente resiliente de TRAM-10). Las rutas quedan delgadas: parseo Zod →
// servicio → respuesta HTTP. NO cambia contratos públicos (status, shapes).
//
// El servicio usa el mismo `db` (drizzle) que las rutas y preserva el orden de
// llamadas, de modo que los tests de ruta existentes siguen pasando.

import path from 'path';
import fs from 'fs';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { eq, and, sql, inArray, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramitesDigitales, tramitesDocumentos, tramitesHistorial, tramitesValidaciones } from '../../db/schema.js';
import { requestWithRetry, upstreamHttpStatus, UpstreamError } from '../../shared/upstream.js';
import { tramFurRequestTotal, tramDocGenTotal } from '../../shared/metrics.js';
import { env } from '../../config/env.js';
import { maskName } from '../../shared/utils/pii.js';
import { loggerFor } from '../../shared/logger.js';
import { VALID_ESTADOS, VALID_TRANSITIONS, isValidTransition, type TramiteEstado } from './tramites.state.js';
import { getEstadosForEtapa } from './embudo.js';
import { createdInRangeCondition, type FechaRango } from '../../shared/utils/fecha-rango.js';
import {
  computeChecklistWithOverride,
  extractOrganismoCodigoFromVehiculo,
  extractPartesTraspasoFromTramite,
  forzarContinuarActivo,
  isValidTipologia,
  mensajePartesTraspasoDuplicadas,
  normalizarDocumentoTraspaso,
  partesTraspasoDuplicadas,
  type ChecklistResultado,
} from '@operaciones/shared-types';
import { resolveChecklistOverride } from './transito-checklist-overrides.js';
import { validateTraspasoSimitComprador } from './traspaso-simit-gate.js';
import { assertTraspasoPatch, gateFurTraspaso, loadBiometriaTraspaso, pasoTraspasoCompleto, validateTraspasoComercial, validateTraspasoFurBiometria } from './traspaso-gates.js';
import {
  clasificarPatchTraspaso,
  detectarModificacionPasosCerradosTraspaso,
  maxPasoTraspasoAlcanzable,
} from '@operaciones/shared-types';
import { getLatestPreflight } from './preflight.js';
import { normalizeVin } from '../vehicles/vehiculo-historial.js';
import {
  assertVinDisponibleMatriculaInicial,
  findVinMatriculaInicialConflict,
  isMatriculaInicial,
  TramiteVinConflictError,
} from './tramites.vin-policy.js';
import {
  formatRadicado, puedeTransicionarStt,
  type TramiteModalidadEntrada, type TramiteWorkflowEvent,
} from '@operaciones/shared-types';

export { TramiteVinConflictError } from './tramites.vin-policy.js';

// Re-export de la máquina de estados (pura, en tramites.state.ts) para que los
// consumidores existentes (rutas) sigan importando desde el servicio.
export { VALID_ESTADOS, VALID_TRANSITIONS, isValidTransition };
export type { TramiteEstado };
// Re-export del catálogo de tipologías (A5) para uso desde las rutas.
export {
  TRAMITE_TIPOLOGIAS, getTipologia, isValidTipologia, computeChecklist, computeChecklistWithOverride,
} from '@operaciones/shared-types';
export type { ChecklistResultado };

const log = loggerFor('tramite.service');

type TramiteRow = typeof tramitesDigitales.$inferSelect;

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------
export interface ListTramitesResult {
  items: TramiteRow[];
  total: number;
}

function listTramitesConditions(opts: { estado?: string; etapa?: string; search?: string; rango?: FechaRango; modalidadEntrada?: TramiteModalidadEntrada }) {
  const conditions: any[] = [];
  const rangoCond = opts.rango ? createdInRangeCondition(tramitesDigitales.createdAt, opts.rango) : null;
  if (rangoCond) conditions.push(rangoCond);
  if (opts.modalidadEntrada) {
    conditions.push(eq(tramitesDigitales.modalidadEntrada, opts.modalidadEntrada));
  }
  const etapaEstados = opts.etapa ? getEstadosForEtapa(opts.etapa) : null;
  if (etapaEstados && etapaEstados.length > 0) {
    conditions.push(inArray(tramitesDigitales.estado, etapaEstados as TramiteEstado[]));
  } else if (opts.estado && (VALID_ESTADOS as readonly string[]).includes(opts.estado)) {
    conditions.push(eq(tramitesDigitales.estado, opts.estado as any));
  }
  if (opts.search) {
    conditions.push(sql`(${tramitesDigitales.vin} ILIKE ${'%' + opts.search + '%'} OR ${tramitesDigitales.placa} ILIKE ${'%' + opts.search + '%'})`);
  }
  return conditions;
}

/** Lista paginada; orden por updatedAt DESC (mismo criterio que GET /tramites/embudo). */
export async function listTramites(opts: { estado?: string; etapa?: string; search?: string; rango?: FechaRango; modalidadEntrada?: TramiteModalidadEntrada; limit: number; offset: number }): Promise<ListTramitesResult> {
  const conditions = listTramitesConditions(opts);
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  let itemsQuery = db.select().from(tramitesDigitales);
  let countQuery = db.select({ count: sql<number>`count(*)::int` }).from(tramitesDigitales);
  if (whereClause) {
    itemsQuery = itemsQuery.where(whereClause) as typeof itemsQuery;
    countQuery = countQuery.where(whereClause) as typeof countQuery;
  }

  const [items, countRows] = await Promise.all([
    itemsQuery.orderBy(desc(tramitesDigitales.updatedAt)).limit(opts.limit).offset(opts.offset),
    countQuery,
  ]);

  return { items, total: countRows[0]?.count ?? 0 };
}

export async function getTramiteWithDocs(id: number): Promise<(TramiteRow & { archivos: unknown[] }) | null> {
  const [t] = await db.select().from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
  if (!t) return null;
  const archivos = await db.select().from(tramitesDocumentos).where(eq(tramitesDocumentos.tramiteId, id));
  return { ...t, archivos };
}

// ---------------------------------------------------------------------------
// Checklist por tipología (A5)
// ---------------------------------------------------------------------------

/** Tipos de documento ya subidos al trámite (para auto-marcar ítems del checklist). */
async function uploadedDocTipos(tramiteId: number): Promise<string[]> {
  const rows = await db.select({ tipo: tramitesDocumentos.tipo }).from(tramitesDocumentos).where(eq(tramitesDocumentos.tramiteId, tramiteId));
  return rows.map((r) => r.tipo);
}

export type ChecklistForTramite =
  | { ok: true; checklist: ChecklistResultado | null }
  | { ok: false; code: 'not_found' };

/** Estado computado del checklist de un trámite (tipología + organismo + manual + documentos). */
export async function getChecklistForTramite(id: number): Promise<ChecklistForTramite> {
  const [t] = await db.select({
    tipologiaCodigo: tramitesDigitales.tipologiaCodigo,
    checklistEstado: tramitesDigitales.checklistEstado,
    vehiculo: tramitesDigitales.vehiculo,
    organismoCodigo: tramitesDigitales.organismoCodigo,
  }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1) as any;
  if (!t) return { ok: false, code: 'not_found' };
  if (!t.tipologiaCodigo) return { ok: true, checklist: null };
  const docTipos = await uploadedDocTipos(id);
  const organismo = t.organismoCodigo ?? extractOrganismoCodigoFromVehiculo(t.vehiculo);
  const override = await resolveChecklistOverride(organismo, t.tipologiaCodigo);
  return {
    ok: true,
    checklist: computeChecklistWithOverride(t.tipologiaCodigo, t.checklistEstado || {}, docTipos, override),
  };
}

// ---------------------------------------------------------------------------
// Creación
// ---------------------------------------------------------------------------
export interface CreateTramiteInput {
  vin?: string; placa?: string; vehiculo?: unknown; tipologiaCodigo?: string | null;
  // TRAM-TRASPASO-F1: modalidad de entrada (default matricula_inicial).
  modalidadEntrada?: TramiteModalidadEntrada;
  // LOTE-PLUS-02: prefill de comprador (lote CSV con comprador_doc/nombre).
  comprador?: { documento: string; nombre?: string; tipoDoc?: string };
  // LOTE-PLUS-05: prefill vendedor en JSONB vehiculo._vendedor (TRAM-TIPO-01).
  vendedor?: { documento: string; nombre?: string; tipoDoc?: string };
}

/** Genera el siguiente radicado TD-YYYY-NNNNN (secuencia atómica). */
async function generarRadicado(): Promise<string> {
  const rows = await db.execute<{ seq: string }>(sql`SELECT nextval('tramite_radicado_seq') AS seq`);
  const row = (Array.isArray(rows) ? rows[0] : (rows as any).rows?.[0]) as { seq: string } | undefined;
  return formatRadicado(Number(row?.seq ?? 1), new Date().getFullYear());
}

export async function createTramite(input: CreateTramiteInput, userId: number): Promise<TramiteRow> {
  const esTraspaso = input.modalidadEntrada === 'traspaso';
  const vinNorm = input.vin ? normalizeVin(input.vin) : null;
  if (!esTraspaso) {
    // Matrícula inicial exige VIN (clave de unicidad). El traspaso es placa-first.
    if (!vinNorm) throw new Error('VIN requerido para matrícula inicial');
    if (isMatriculaInicial(input)) {
      await assertVinDisponibleMatriculaInicial(vinNorm);
    }
  }
  const comprador = input.comprador?.documento
    ? { documento: input.comprador.documento, nombre: input.comprador.nombre ?? null, tipoDoc: input.comprador.tipoDoc ?? 'CC' }
    : null;
  let vehiculo = (input.vehiculo as Record<string, unknown> | null) ?? null;
  if (input.vendedor?.documento) {
    vehiculo = {
      ...(vehiculo ?? {}),
      _vendedor: {
        documento: input.vendedor.documento,
        nombre: input.vendedor.nombre ?? '',
        tipoDoc: input.vendedor.tipoDoc ?? 'CC',
      },
    };
  }
  // TRAM-TRASPASO-F1: el traspaso nace radicado (TD-) con bitácora workflow;
  // la matrícula inicial conserva su flujo (borrador, sin radicado).
  const numeroRadicado = esTraspaso ? await generarRadicado() : null;
  const estadoInicial = esTraspaso ? ('radicado' as const) : ('borrador' as const);
  const workflow: TramiteWorkflowEvent[] = esTraspaso
    ? [{ de: null, a: 'radicado', usuario: String(userId), timestamp: new Date().toISOString(), nota: '' }]
    : [];

  try {
    const [tramite] = await db.insert(tramitesDigitales).values({
      vin: vinNorm,
      placa: input.placa || null,
      vehiculo: vehiculo as any,
      comprador: comprador as any,                      // LOTE-PLUS-02: prefill
      // TRAM-TRASPASO-F1.5: el traspaso nace con tipología traspaso_standard
      // (activa checklist + firma B3 + journey de partes). B4: tipología en lote.
      tipologiaCodigo: input.tipologiaCodigo || (esTraspaso ? 'traspaso_standard' : null),
      modalidadEntrada: input.modalidadEntrada || 'matricula_inicial',
      numeroRadicado,
      workflow: workflow as any,
      estado: estadoInicial, paso: 1,
      creadoPor: userId, updatedAt: new Date(),
    }).returning();
    return tramite;
  } catch (e: unknown) {
    const pg = e as { code?: string };
    if (!esTraspaso && vinNorm && isMatriculaInicial(input) && pg?.code === '23505') {
      const conflict = await findVinMatriculaInicialConflict(vinNorm);
      if (conflict) throw new TramiteVinConflictError(conflict);
    }
    throw e;
  }
}

// TRAM-TRASPASO-F1 — transición de estado STT del traspaso + append a workflow.
export type TransicionResult =
  | { ok: true; estado: string; numeroRadicado: string | null }
  | { ok: false; code: 'not_found' | 'no_traspaso' | 'transicion_invalida' | 'organismo_forbidden' | 'biometria_gate'; message: string };

export async function transicionarEstadoStt(opts: {
  tramiteId: number; estado: string; nota?: string; userId: number; username: string;
  actorRole?: string; transitoCodigo?: string | null;
}): Promise<TransicionResult> {
  const [t] = await db.select({
    estado: tramitesDigitales.estado,
    modalidad: tramitesDigitales.modalidadEntrada,
    radicado: tramitesDigitales.numeroRadicado,
    workflow: tramitesDigitales.workflow,
    organismoCodigo: tramitesDigitales.organismoCodigo,
    vehiculo: tramitesDigitales.vehiculo,
    comprador: tramitesDigitales.comprador,
    furGenerado: tramitesDigitales.furGenerado,
  }).from(tramitesDigitales).where(eq(tramitesDigitales.id, opts.tramiteId)).limit(1);
  if (!t) return { ok: false, code: 'not_found', message: 'Trámite no encontrado' };
  if (t.modalidad !== 'traspaso') return { ok: false, code: 'no_traspaso', message: 'Las transiciones STT solo aplican a traspaso' };
  if (opts.actorRole === 'transito' && opts.transitoCodigo && t.organismoCodigo && t.organismoCodigo !== opts.transitoCodigo) {
    return { ok: false, code: 'organismo_forbidden', message: 'Este traspaso pertenece a otro organismo de tránsito' };
  }
  if (!puedeTransicionarStt(t.estado, opts.estado)) {
    return { ok: false, code: 'transicion_invalida', message: `Transición ${t.estado} → ${opts.estado} no permitida` };
  }

  // Paridad CEA: cerrar gestión (radicado|subsanacion → en_validacion) exige biométrica dual aprobada.
  if (opts.estado === 'en_validacion' && (t.estado === 'radicado' || t.estado === 'subsanacion')) {
    const bioGate = await validateTraspasoFurBiometria(opts.tramiteId, t.vehiculo, {
      vehiculo: t.vehiculo,
      comprador: t.comprador,
      estado: t.estado,
      furGenerado: t.furGenerado,
    });
    if (!bioGate.ok) {
      return { ok: false, code: 'biometria_gate', message: bioGate.message || 'Biometría pendiente' };
    }
  }

  // Paridad CEA P0: STT no avanza a En trámite sin biométrica dual aprobada (cubre
  // legacy ya en en_validacion sin biometría — sin excepción por FUR regenerado).
  if (opts.estado === 'en_tramite') {
    const bio = await loadBiometriaTraspaso(opts.tramiteId, { vehiculo: t.vehiculo, comprador: t.comprador });
    const gate = gateFurTraspaso(t.vehiculo, bio);
    if (!gate.ok) {
      return {
        ok: false,
        code: 'biometria_gate',
        message: 'La identidad biométrica de vendedor y comprador no está aprobada. Mueva el trámite a Subsanación para que el gestor CEA la complete.',
      };
    }
  }

  const wf = Array.isArray(t.workflow) ? (t.workflow as TramiteWorkflowEvent[]) : [];
  wf.push({ de: t.estado, a: opts.estado, usuario: opts.username, timestamp: new Date().toISOString(), nota: opts.nota || '' });

  const setPayload: Record<string, any> = { estado: opts.estado as any, workflow: wf as any, updatedAt: new Date() };
  // CEA: al pasar a En trámite, el operador STT queda asignado si nadie lo tomó antes.
  if (opts.estado === 'en_tramite') {
    const veh = (t.vehiculo || {}) as Record<string, unknown>;
    const stt = (veh._stt || {}) as Record<string, unknown>;
    if (!stt.asignadoA && opts.username) {
      setPayload.vehiculo = { ...veh, _stt: { ...stt, asignadoA: opts.username } };
    }
  }

  await db.update(tramitesDigitales)
    .set(setPayload)
    .where(eq(tramitesDigitales.id, opts.tramiteId));

  return { ok: true, estado: opts.estado, numeroRadicado: t.radicado };
}

// ---------------------------------------------------------------------------
// Edición + transiciones
// ---------------------------------------------------------------------------
export interface PatchTramiteInput {
  paso?: number; estado?: TramiteEstado;
  vehiculo?: unknown; comprador?: unknown; documentos?: unknown; validacionIdentidad?: unknown;
  notas?: string; placa?: string;
  // TRAM-INNOV A5
  tipologiaCodigo?: string | null;
  checklistEstado?: Record<string, boolean>;
}

export type PatchResult =
  | { ok: true; updated: TramiteRow }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'invalid_transition'; from: string; to: string }
  | { ok: false; code: 'conflict' }
  | { ok: false; code: 'checklist_incompleto'; faltan: string[]; tipologia: string }
  | { ok: false; code: 'organismo_requerido' }
  | { ok: false; code: 'simit_gate'; message: string }
  | { ok: false; code: 'partes_duplicadas'; message: string }
  | { ok: false; code: 'paso_gate'; message: string }
  | { ok: false; code: 'comercial_gate'; message: string }
  | { ok: false; code: 'paso_cerrado'; message: string }
  | { ok: false; code: 'identidad_requerida'; message: string }
  | { ok: false; code: 'gestion_cerrada'; message: string };

function mergeVehiculoTraspaso(existing: unknown, patch: unknown): Record<string, unknown> {
  const ex = (existing || {}) as Record<string, unknown>;
  const pa = (patch || {}) as Record<string, unknown>;
  const merged = { ...ex, ...pa };
  if (ex._vendedor || pa._vendedor) {
    merged._vendedor = { ...(ex._vendedor as object || {}), ...(pa._vendedor as object || {}) };
  }
  if (ex._comprador || pa._comprador) {
    merged._comprador = { ...(ex._comprador as object || {}), ...(pa._comprador as object || {}) };
  }
  if (ex._comercial || pa._comercial) {
    merged._comercial = { ...(ex._comercial as object || {}), ...(pa._comercial as object || {}) };
  }
  if (ex._stt || pa._stt) {
    merged._stt = { ...(ex._stt as object || {}), ...(pa._stt as object || {}) };
  }
  return merged;
}

export async function patchTramite(id: number, d: PatchTramiteInput, userId: number, opts?: { actorRole?: string }): Promise<PatchResult> {
  const actorRole = opts?.actorRole ?? 'admin';
  let estadoAnterior: string | undefined;
  let current: { estado: string; tipologiaCodigo: string | null; checklistEstado: Record<string, boolean> | null; vehiculo: unknown; modalidad?: string; modalidadEntrada?: string; comprador?: unknown; paso?: number } | undefined;
  /** Vehículo persistido en BD (traspaso) — base para merge server-side al PATCH parcial. */
  let traspasoVehiculoBase: unknown | undefined;

  const mutaExpediente = d.vehiculo !== undefined || d.comprador !== undefined || d.paso !== undefined
    || d.checklistEstado !== undefined || d.tipologiaCodigo !== undefined;
  const patchSttSolo = clasificarPatchTraspaso(d) === 'stt_datos';
  if (mutaExpediente) {
    const gateExp = await assertTraspasoPatch(id, actorRole, d);
    if (!gateExp.ok) {
      if (gateExp.code === 'not_found') return { ok: false, code: 'not_found' };
      return { ok: false, code: 'gestion_cerrada', message: gateExp.message };
    }
  }

  // TRAM-TRASPASO-P0: gates al avanzar paso (preflight, RUNT, SIMIT, comercial) — no aplica a PATCH _stt.
  // El merge server-side del JSONB vehiculo SÍ aplica siempre: un PATCH solo `_stt`
  // jamás debe sobrescribir _vendedor/_comprador/_comercial (causa raíz trámite 27).
  if (d.paso !== undefined || d.vehiculo !== undefined || d.comprador !== undefined) {
    const [row] = await db.select({
      modalidad: tramitesDigitales.modalidadEntrada,
      comprador: tramitesDigitales.comprador,
      vehiculo: tramitesDigitales.vehiculo,
      paso: tramitesDigitales.paso,
    }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
    if (row?.modalidad === 'traspaso') {
      traspasoVehiculoBase = row.vehiculo;
      const vehEfectivo = d.vehiculo !== undefined ? mergeVehiculoTraspaso(row.vehiculo, d.vehiculo) : row.vehiculo;
      const compEfectivo = d.comprador !== undefined ? d.comprador : row.comprador;
      const forzar = forzarContinuarActivo(vehEfectivo);
      const pazSalvo = (vehEfectivo as { _pazSalvoImpuesto?: { verificado?: boolean } })?._pazSalvoImpuesto;

      if (!patchSttSolo && d.paso !== undefined && d.paso >= 4) {
        const gate = validateTraspasoSimitComprador(vehEfectivo, compEfectivo);
        if (!gate.ok && !forzar) return { ok: false, code: 'simit_gate', message: gate.message };
      }

      if (!patchSttSolo && d.paso !== undefined && d.paso >= 6) {
        const comGate = validateTraspasoComercial(vehEfectivo);
        if (!comGate.ok) return { ok: false, code: 'comercial_gate', message: comGate.message || 'Datos comerciales incompletos' };
      }

      if (!patchSttSolo) {
        const preflight = await getLatestPreflight(id);
        const maxPaso = maxPasoTraspasoAlcanzable({
          tramiteId: id,
          vehiculo: vehEfectivo,
          comprador: compEfectivo,
          preflight: preflight || undefined,
          pazSalvoImpuesto: pazSalvo,
          forzarContinuar: forzar,
        });
        if (d.vehiculo !== undefined || d.comprador !== undefined) {
          const cerrado = detectarModificacionPasosCerradosTraspaso(maxPaso, d.vehiculo, d.comprador, { pasoPatch: d.paso });
          if (!cerrado.ok) {
            return { ok: false, code: 'paso_cerrado', message: cerrado.message || 'Paso cerrado' };
          }
        }

        if (d.paso !== undefined && d.paso > (row.paso ?? 1)) {
          for (let p = 1; p < d.paso; p++) {
            const stepGate = pasoTraspasoCompleto(p, {
              tramiteId: id,
              vehiculo: vehEfectivo,
              comprador: compEfectivo,
              preflight: preflight || undefined,
              pazSalvoImpuesto: pazSalvo,
              forzarContinuar: forzar,
            });
            if (!stepGate.ok) {
              return { ok: false, code: 'paso_gate', message: stepGate.message || 'No puede avanzar de paso' };
            }
          }
        }

        if (d.vehiculo !== undefined) {
          const mergedCheck = mergeVehiculoTraspaso(row.vehiculo, d.vehiculo) as { _comercial?: { valorVenta?: number } };
          if (mergedCheck._comercial && (Number(mergedCheck._comercial.valorVenta) || 0) <= 0) {
            return { ok: false, code: 'comercial_gate', message: 'Valor de venta comercial debe ser mayor a cero' };
          }
        }
      }
    }
  }

  // Cargamos también la tipología/checklist actuales: necesarios para el gate de
  // envío a tránsito (A5) sin un SELECT adicional. Trámites previos devuelven
  // undefined en estas columnas → no se gatilla el gate (retrocompat).
  if (!patchSttSolo && (d.vehiculo !== undefined || d.comprador !== undefined)) {
    const [row] = await db.select({
      modalidad: tramitesDigitales.modalidadEntrada,
      vehiculo: tramitesDigitales.vehiculo,
      comprador: tramitesDigitales.comprador,
    }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
    if (!row) return { ok: false, code: 'not_found' };
    if (row.modalidad === 'traspaso') {
      const vehEfectivo = d.vehiculo !== undefined ? mergeVehiculoTraspaso(row.vehiculo, d.vehiculo) : row.vehiculo;
      const compEfectivo = d.comprador !== undefined ? d.comprador : row.comprador;
      const { vendedor, comprador } = extractPartesTraspasoFromTramite({ vehiculo: vehEfectivo, comprador: compEfectivo });
      const dupMsg = mensajePartesTraspasoDuplicadas(partesTraspasoDuplicadas(vendedor, comprador));
      if (dupMsg) return { ok: false, code: 'partes_duplicadas', message: dupMsg };
    }
  }

  if (d.estado !== undefined) {
    [current] = await db.select({
      estado: tramitesDigitales.estado,
      tipologiaCodigo: tramitesDigitales.tipologiaCodigo,
      checklistEstado: tramitesDigitales.checklistEstado,
      vehiculo: tramitesDigitales.vehiculo,
      comprador: tramitesDigitales.comprador,
      modalidadEntrada: tramitesDigitales.modalidadEntrada,
    }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1) as any;
    if (!current) return { ok: false, code: 'not_found' };
    if (!isValidTransition(current.estado, d.estado)) return { ok: false, code: 'invalid_transition', from: current.estado, to: d.estado };
    estadoAnterior = current.estado;

    // Gate A5: al enviar a tránsito, exigir obligatorios completos si hay tipología
    // elegida y STRICT está activo. La tipología/checklist efectivos consideran lo
    // que venga en este mismo PATCH (override) o lo persistido.
    if (d.estado === 'enviado_transito' && env.TRAMITE_STRICT_CHECKLIST) {
      const tipologia = d.tipologiaCodigo !== undefined ? d.tipologiaCodigo : current?.tipologiaCodigo;
      if (isValidTipologia(tipologia)) {
        const checklistEstado = d.checklistEstado !== undefined ? d.checklistEstado : (current?.checklistEstado || {});
        const vehiculoEfectivo = d.vehiculo !== undefined ? d.vehiculo : current?.vehiculo;
        const organismoCodigo = extractOrganismoCodigoFromVehiculo(vehiculoEfectivo);
        const docTipos = await uploadedDocTipos(id);
        const override = await resolveChecklistOverride(organismoCodigo, tipologia);
        const res = computeChecklistWithOverride(tipologia, checklistEstado, docTipos, override);
        if (res && !res.completo) {
          return { ok: false, code: 'checklist_incompleto', faltan: res.faltanObligatorios, tipologia: res.codigo };
        }
      }
    }

    // TRAM-MT-01: al enviar a tránsito, persistir organismo_codigo desde vehiculo._orgTransito.
    if (d.estado === 'enviado_transito') {
      const vehiculoEfectivo = d.vehiculo !== undefined ? d.vehiculo : current?.vehiculo;
      const organismoCodigo = extractOrganismoCodigoFromVehiculo(vehiculoEfectivo);
      if (!organismoCodigo) return { ok: false, code: 'organismo_requerido' };
    }

    // Gate server-side de identidad (M1): en matrícula inicial NO permitir enviar a
    // tránsito sin la biométrica del comprador aprobada. Antes solo lo validaba el
    // cliente (todoListo); un request directo podía enviar un expediente sin identidad.
    // (Traspaso tiene su propio gate biométrico dual en otra ruta.)
    if (d.estado === 'enviado_transito' && current?.modalidadEntrada !== 'traspaso') {
      const compradorEfectivo = d.comprador !== undefined ? d.comprador : current?.comprador;
      if (!(await compradorIdentidadAprobada(id, compradorEfectivo))) {
        return { ok: false, code: 'identidad_requerida', message: 'La identidad biométrica del comprador no está aprobada. Complete la validación antes de enviar a tránsito.' };
      }
    }
  }

  const setData: Record<string, any> = { updatedAt: new Date() };
  if (d.paso !== undefined) setData.paso = d.paso;
  if (d.estado !== undefined) setData.estado = d.estado;
  if (d.estado === 'enviado_transito') {
    const vehiculoEfectivo = d.vehiculo !== undefined ? d.vehiculo : current?.vehiculo;
    const organismoCodigo = extractOrganismoCodigoFromVehiculo(vehiculoEfectivo);
    if (organismoCodigo) setData.organismoCodigo = organismoCodigo;
  }
  if (d.vehiculo !== undefined) {
    setData.vehiculo = traspasoVehiculoBase !== undefined
      ? mergeVehiculoTraspaso(traspasoVehiculoBase, d.vehiculo)
      : d.vehiculo;
    const organismoCodigo = extractOrganismoCodigoFromVehiculo(setData.vehiculo);
    if (organismoCodigo) setData.organismoCodigo = organismoCodigo;
  }
  if (d.comprador !== undefined) setData.comprador = d.comprador;
  if (d.documentos !== undefined) setData.documentos = d.documentos;
  if (d.validacionIdentidad !== undefined) setData.validacionIdentidad = d.validacionIdentidad;
  if (d.notas !== undefined) setData.notas = d.notas;
  if (d.placa !== undefined) setData.placa = d.placa;
  if (d.tipologiaCodigo !== undefined) setData.tipologiaCodigo = d.tipologiaCodigo;
  if (d.checklistEstado !== undefined) setData.checklistEstado = d.checklistEstado;

  const whereConditions = [eq(tramitesDigitales.id, id)];
  if (d.estado !== undefined && estadoAnterior) {
    whereConditions.push(eq(tramitesDigitales.estado, estadoAnterior as any));
  }
  const [updated] = await db.update(tramitesDigitales).set(setData).where(and(...whereConditions)).returning();
  if (!updated) return { ok: false, code: 'conflict' };

  if (d.estado !== undefined && estadoAnterior !== undefined) {
    await db.insert(tramitesHistorial).values({
      tramiteId: id, estadoAnterior, estadoNuevo: d.estado,
      usuarioId: userId, detalle: `Paso: ${updated.paso}`,
    }).catch(() => {});
  }
  return { ok: true, updated };
}

// ---------------------------------------------------------------------------
// Generación de FUR (orquestación CEA, resiliente — TRAM-10)
// ---------------------------------------------------------------------------
export type FurResult =
  | { ok: true; pdf: Buffer; placa: string | null }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'biometria_gate'; status: number; error: string }
  | { ok: false; code: 'fur_upstream'; status: number; error: string; upstreamStatus: number }
  | { ok: false; code: 'fur_timeout' | 'fur_network'; status: number; error: string };

/**
 * TRAM-F3 — sellos de firma electrónica avanzada de las partes (biométrica
 * aprobada). Se envían a CEA como `firmantes` para estampar el contrato/FUR
 * (CEA es agnóstico del system-of-record: usa el override del payload).
 */
export async function getSellosFirma(tramiteId: number): Promise<Array<{ parte: string; nombre: string; documento: string; tipoDoc: string; email: string; firma_serie: string; firma_hash: string | null; firma_timestamp: string | null }>> {
  const rows = await db.select({
    parte: tramitesValidaciones.parte, nombre: tramitesValidaciones.nombre,
    documento: tramitesValidaciones.documento, tipoDoc: tramitesValidaciones.tipoDoc,
    email: tramitesValidaciones.email, firmaSerie: tramitesValidaciones.firmaSerie,
    firmaHash: tramitesValidaciones.firmaHash, firmaTimestamp: tramitesValidaciones.firmaTimestamp,
  }).from(tramitesValidaciones)
    .where(and(eq(tramitesValidaciones.tramiteId, tramiteId), eq(tramitesValidaciones.estado, 'aprobado')));
  return rows
    .filter((r) => r.firmaSerie && r.parte)
    .map((r) => ({
      parte: String(r.parte).toUpperCase(),
      nombre: r.nombre || '', documento: r.documento || '', tipoDoc: r.tipoDoc || 'CC', email: r.email || '',
      firma_serie: r.firmaSerie as string, firma_hash: r.firmaHash, firma_timestamp: r.firmaTimestamp ? (r.firmaTimestamp as Date).toISOString() : null,
    }));
}

/** Matrícula inicial: ¿la identidad del COMPRADOR (única parte) está aprobada? */
async function compradorIdentidadAprobada(tramiteId: number, comprador: unknown): Promise<boolean> {
  const doc = normalizarDocumentoTraspaso((comprador as { documento?: string } | null)?.documento);
  if (!doc) return false;
  const rows = await db.select({ documento: tramitesValidaciones.documento })
    .from(tramitesValidaciones)
    .where(and(eq(tramitesValidaciones.tramiteId, tramiteId), eq(tramitesValidaciones.estado, 'aprobado')));
  return rows.some((r) => normalizarDocumentoTraspaso(r.documento) === doc);
}

export async function generarFur(id: number, org: { orgNombre?: string; orgCiudad?: string; orgCodigo?: string }): Promise<FurResult> {
  const [tramite] = await db.select().from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
  if (!tramite) return { ok: false, code: 'not_found' };

  const v = (tramite.vehiculo || {}) as any;
  // El gate biométrico de traspaso exige AMBAS partes (vendedor + comprador). En
  // matrícula inicial NO hay vendedor, así que ese gate fallaba siempre (409). Para
  // matrícula la única parte es el comprador: basta su identidad aprobada.
  if (tramite.modalidadEntrada === 'traspaso') {
    const bioGate = await validateTraspasoFurBiometria(id, v, {
      vehiculo: tramite.vehiculo,
      comprador: tramite.comprador,
      estado: tramite.estado,
      furGenerado: tramite.furGenerado,
    });
    if (!bioGate.ok) {
      return { ok: false, code: 'biometria_gate', status: 409, error: bioGate.message || 'Biometría pendiente' };
    }
  } else if (!tramite.furGenerado && !(await compradorIdentidadAprobada(id, tramite.comprador))) {
    return { ok: false, code: 'biometria_gate', status: 409, error: 'La identidad del comprador no está aprobada. Complete la validación biométrica antes de generar el FUR.' };
  }

  const c = (tramite.comprador || {}) as any;
  const firmantes = await getSellosFirma(id);
  const payload = {
    tramiteId: id,
    firmantes,
    vehiculo: { placa: tramite.placa || v.placa, marca: v.marca, linea: v.linea, modelo: v.modelo, color: v.color, clase: v.claseVehiculo || v.clase, claseVehiculo: v.claseVehiculo || v.clase, cilindraje: v.cilindraje, combustible: v.tipoCombustible || v.combustible, tipoCombustible: v.tipoCombustible, servicio: v.tipoServicio, tipoServicio: v.tipoServicio, carroceria: v.tipoCarroceria || v.carroceria, tipoCarroceria: v.tipoCarroceria, vin: tramite.vin, numMotor: v.numMotor, numChasis: v.numChasis, numSerie: v.numSerie },
    comprador: { nombre: c.nombre, tipoDoc: c.tipoDoc || 'CC', documento: c.documento, direccion: c.direccion, ciudad: c.ciudad, telefono: c.telefono },
    vendedor: {},
    orgVehiculoNombre: org.orgNombre || v.organismoTransito || '',
    orgVehiculoCiudad: org.orgCiudad || '',
    orgVehiculoCodigo: org.orgCodigo || '',
    regrabado: { motor: v.esRegrabadoMotor || 'NO', chasis: v.esRegrabadoChasis || 'NO', serie: v.esRegrabadoSerie || 'NO' },
  };

  log.info({ tramiteId: id, placa: tramite.placa, org: payload.orgVehiculoNombre ? maskName(String(payload.orgVehiculoNombre)) : null }, 'generando FUR');

  const markFurError = (reason: string) =>
    db.update(tramitesDigitales)
      .set({ furError: reason.slice(0, 500), furErrorAt: new Date(), updatedAt: new Date() })
      .where(eq(tramitesDigitales.id, id)).catch(() => {});

  const { useLocalPdf } = await import('./docs/mode.js');
  const tplPath = path.join(process.cwd(), 'apps/api/templates/ftrunt.pdf');
  const canLocalFur = useLocalPdf() && fs.existsSync(tplPath);
  if (canLocalFur) {
    try {
      const { generarFurPdf } = await import('./docs/pdf-fur.js');
      const buffer = await generarFurPdf(payload);
      db.update(tramitesDigitales).set({ furGenerado: true, furError: null, furErrorAt: null, updatedAt: new Date() }).where(eq(tramitesDigitales.id, id)).catch(() => {});
      await marcarDocGenerado(id, v, { furAt: new Date().toISOString() });
      await persistTramiteDocumento(id, 'otro', buffer, `FUR_${tramite.placa || id}.pdf`).catch(() => {});
      tramFurRequestTotal.inc({ result: 'success' });
      return { ok: true, pdf: buffer, placa: tramite.placa };
    } catch (err) {
      const msg = (err as Error)?.message || 'Error generando FUR';
      await markFurError(msg.slice(0, 500));
      tramFurRequestTotal.inc({ result: 'network' });
      return { ok: false, code: 'fur_network', status: 502, error: 'No se pudo generar el FUR. Reintenta en unos minutos.' };
    }
  }

  if (useLocalPdf() && !fs.existsSync(tplPath)) {
    log.warn({ tramiteId: id }, 'Plantilla FTRUNT ausente — fallback a proxy CEA');
  }

  const body = JSON.stringify(payload);
  try {
    const resp = await requestWithRetry({
      url: 'https://cea.kyverum.com/api/transitos/ftrunt-internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': env.RUNT_INTERNAL_KEY, 'Content-Length': String(Buffer.byteLength(body)) },
      body, timeoutMs: 30_000, retries: 2,
    });

    if (resp.statusCode !== 200) {
      await markFurError(`CEA FUR HTTP ${resp.statusCode}`);
      tramFurRequestTotal.inc({ result: 'upstream_error' });
      return {
        ok: false, code: 'fur_upstream',
        status: upstreamHttpStatus({ statusCode: resp.statusCode }),
        error: 'El servicio de generación de FUR (CEA) no está disponible. Reintenta en unos minutos.',
        upstreamStatus: resp.statusCode,
      };
    }

    db.update(tramitesDigitales).set({ furGenerado: true, furError: null, furErrorAt: null, updatedAt: new Date() }).where(eq(tramitesDigitales.id, id)).catch(() => {});
    await marcarDocGenerado(id, v, { furAt: new Date().toISOString() });
    await persistTramiteDocumento(id, 'otro', resp.buffer, `FUR_${tramite.placa || id}.pdf`).catch(() => {});
    tramFurRequestTotal.inc({ result: 'success' });
    return { ok: true, pdf: resp.buffer, placa: tramite.placa };
  } catch (err) {
    const kind: 'timeout' | 'network' = err instanceof UpstreamError ? err.kind : 'network';
    await markFurError(kind === 'timeout' ? 'FUR timeout (CEA)' : `FUR error de red (CEA): ${(err as Error)?.message ?? ''}`.slice(0, 500));
    tramFurRequestTotal.inc({ result: kind });
    log.warn({ tramiteId: id, kind }, 'FUR falló tras reintentos');
    return {
      ok: false, code: `fur_${kind}`,
      status: upstreamHttpStatus({ kind }),
      error: kind === 'timeout'
        ? 'La generación de FUR superó el tiempo de espera. Reintenta en unos minutos.'
        : 'No se pudo contactar el servicio de FUR (CEA). Reintenta en unos minutos.',
    };
  }
}

// ---------------------------------------------------------------------------
// TRAM-TRASPASO-F2 — documentos legales (contrato + improntas) vía proxy CEA.
// Mismo patrón que generarFur (ADR-TRAM-F2): endpoints *-internal con x-internal-key.
// ---------------------------------------------------------------------------
const CEA_DOCS_BASE = 'https://cea.kyverum.com/api/transitos';

export type DocResult =
  | { ok: true; pdf: Buffer; contentType: string; hash?: string }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'doc_upstream'; status: number; error: string; upstreamStatus: number }
  | { ok: false; code: 'doc_timeout' | 'doc_network'; status: number; error: string };

async function callCeaDoc(pathSeg: string, payload: unknown, tipo: 'contrato' | 'improntas'):
  Promise<{ ok: true; buffer: Buffer } | { ok: false; status: number; error: string; upstreamStatus?: number; kind?: 'timeout' | 'network' }> {
  const body = JSON.stringify(payload);
  try {
    const resp = await requestWithRetry({
      url: `${CEA_DOCS_BASE}/${pathSeg}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': env.RUNT_INTERNAL_KEY, 'Content-Length': String(Buffer.byteLength(body)) },
      body, timeoutMs: 30_000, retries: 2,
    });
    if (resp.statusCode !== 200) {
      tramDocGenTotal.inc({ tipo, result: 'upstream_error' });
      return { ok: false, status: upstreamHttpStatus({ statusCode: resp.statusCode }), error: 'El servicio de documentos (CEA) no está disponible. Reintenta en unos minutos.', upstreamStatus: resp.statusCode };
    }
    tramDocGenTotal.inc({ tipo, result: 'success' });
    return { ok: true, buffer: resp.buffer };
  } catch (err) {
    const kind: 'timeout' | 'network' = err instanceof UpstreamError ? err.kind : 'network';
    tramDocGenTotal.inc({ tipo, result: kind });
    log.warn({ tipo, kind }, 'documento traspaso falló tras reintentos');
    return { ok: false, status: upstreamHttpStatus({ kind }), error: kind === 'timeout' ? 'La generación del documento superó el tiempo de espera. Reintenta.' : 'No se pudo contactar el servicio de documentos (CEA). Reintenta.', kind };
  }
}

const DOC_TIPOS_PERSIST = new Set(['factura', 'aduana', 'impronta', 'soat', 'certificado_ambiental', 'compraventa', 'acta_remate', 'oficio_judicial', 'declaracion_aduana', 'otro']);

/** Persiste un PDF generado en disco + `tramites_documentos` (reemplaza mismo tipo). */
export async function persistTramiteDocumento(
  tramiteId: number,
  tipo: string,
  buffer: Buffer,
  originalName: string,
): Promise<void> {
  const docTipo = DOC_TIPOS_PERSIST.has(tipo) ? tipo : 'otro';
  const dir = path.join(process.cwd(), 'uploads', 'tramites', String(tramiteId));
  await mkdir(dir, { recursive: true });
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  const filename = `${docTipo}_gen_${Date.now()}_${safeName}`;
  const relPath = `uploads/tramites/${tramiteId}/${filename}`;
  await writeFile(path.join(process.cwd(), relPath), buffer);

  const prev = await db.select().from(tramitesDocumentos)
    .where(and(eq(tramitesDocumentos.tramiteId, tramiteId), eq(tramitesDocumentos.tipo, docTipo)));
  for (const p of prev) {
    const fp = path.resolve(process.cwd(), p.filename);
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (fp.startsWith(uploadsDir)) await unlink(fp).catch(() => {});
    await db.delete(tramitesDocumentos).where(eq(tramitesDocumentos.id, p.id));
  }

  await db.insert(tramitesDocumentos).values({
    tramiteId,
    tipo: docTipo,
    filename: relPath,
    originalName: safeName,
    mimetype: 'application/pdf',
    size: buffer.length,
  });
}

/** Marca metadatos de documentos generados en el JSONB del vehículo (sin DDL). */
async function marcarDocGenerado(id: number, veh: Record<string, unknown>, patch: Record<string, unknown>) {
  const docs = { ...((veh._docs_generados as Record<string, unknown>) || {}), ...patch };
  await db.update(tramitesDigitales)
    .set({ vehiculo: { ...veh, _docs_generados: docs } as any, updatedAt: new Date() })
    .where(eq(tramitesDigitales.id, id)).catch(() => {});
}

export async function generarContrato(id: number, org: { orgNombre?: string; orgCiudad?: string }): Promise<DocResult> {
  const [t] = await db.select().from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
  if (!t) return { ok: false, code: 'not_found' };
  const v = (t.vehiculo || {}) as any;
  const c = (t.comprador || {}) as any;
  const ven = v._vendedor || {};
  // La columna `comprador` (c) es la fuente de verdad: se reemplaza completa en
  // cada guardado del paso 4. Usarla ENTERA, sin gap-fill campo a campo desde el
  // JSONB del vehículo (que conserva datos del comprador anterior tras corregir
  // → contrato Frankenstein). Solo caer al JSONB en trámites legacy sin columna.
  const com = (c && (c.documento || c.nombre)) ? c : (v._comprador || {});
  const comercial = v._comercial || {};
  const firmantes = await getSellosFirma(id);
  const payload = {
    tramiteId: id,
    firmantes,
    vehiculo: { placa: t.placa, marca: v.marca, linea: v.linea, modelo: v.modelo, vin: t.vin, color: v.color, cilindraje: v.cilindraje, numMotor: v.numMotor, numChasis: v.numChasis, numSerie: v.numSerie },
    vendedor: { nombre: ven.nombre, tipoDoc: ven.tipoDoc || 'CC', documento: ven.documento, direccion: ven.direccion, ciudad: ven.ciudad, telefono: ven.telefono },
    comprador: { nombre: com.nombre, tipoDoc: com.tipoDoc || 'CC', documento: com.documento, direccion: com.direccion, ciudad: com.ciudad, telefono: com.telefono },
    valorVenta: Number(comercial.valorVenta) || 0, tasaImpuesto: Number(comercial.tasaImpuesto) || undefined, valorTramite: Number(comercial.valorTramite) || undefined,
    metodoPago: comercial.metodoPago || 'Efectivo', causal: comercial.causal || 'COMPRAVENTA',
    orgNombre: org.orgNombre || '', orgCiudad: org.orgCiudad || '',
  };
  const { useLocalPdf } = await import('./docs/mode.js');
  let pdfBuf: Buffer;
  if (useLocalPdf()) {
    try {
      const { generarContratoPdf } = await import('./docs/pdf-contrato.js');
      pdfBuf = await generarContratoPdf(payload);
      tramDocGenTotal.inc({ tipo: 'contrato', result: 'success' });
    } catch (e: any) {
      tramDocGenTotal.inc({ tipo: 'contrato', result: 'network' });
      return { ok: false, code: 'doc_network', status: 502, error: e?.message || 'No se pudo generar el contrato.' };
    }
  } else {
    const r = await callCeaDoc('contrato-compraventa-internal', payload, 'contrato');
    if (!r.ok) return (r.upstreamStatus !== undefined
      ? { ok: false, code: 'doc_upstream', status: r.status, error: r.error, upstreamStatus: r.upstreamStatus }
      : { ok: false, code: r.kind === 'timeout' ? 'doc_timeout' : 'doc_network', status: r.status, error: r.error });
    pdfBuf = r.buffer;
  }
  await marcarDocGenerado(id, v, { contratoAt: new Date().toISOString() });
  await persistTramiteDocumento(id, 'compraventa', pdfBuf, `Contrato_Compraventa_${t.placa || id}.pdf`).catch(() => {});
  return { ok: true, pdf: pdfBuf, contentType: 'application/pdf' };
}

export async function generarImprontas(id: number, org: { orgNombre?: string; orgCiudad?: string }): Promise<DocResult> {
  const [t] = await db.select().from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
  if (!t) return { ok: false, code: 'not_found' };
  const v = (t.vehiculo || {}) as any;
  const payload = { placa: t.placa || '', marca: v.marca, linea: v.linea, modelo: v.modelo, numMotor: v.numMotor, numChasis: v.numChasis, numSerie: v.numSerie, vin: t.vin || '', orgNombre: org.orgNombre || '', orgCiudad: org.orgCiudad || '' };
  const { useLocalPdf } = await import('./docs/mode.js');
  let pdf: Buffer;
  let hash: string | undefined;
  if (useLocalPdf()) {
    try {
      const { generarImprontasPdf } = await import('./docs/pdf-improntas.js');
      const parsed = await generarImprontasPdf(payload);
      if (!parsed.ok || !parsed.pdf) {
        tramDocGenTotal.inc({ tipo: 'improntas', result: 'network' });
        return { ok: false, code: 'doc_network', status: 502, error: parsed.message || 'No se generaron las improntas.' };
      }
      pdf = Buffer.from(String(parsed.pdf).replace(/^data:application\/pdf;base64,/, ''), 'base64');
      hash = parsed.hash;
      tramDocGenTotal.inc({ tipo: 'improntas', result: 'success' });
    } catch (e: any) {
      tramDocGenTotal.inc({ tipo: 'improntas', result: 'network' });
      return { ok: false, code: 'doc_network', status: 502, error: e?.message || 'No se generaron las improntas.' };
    }
  } else {
    const r = await callCeaDoc('improntas-internal', payload, 'improntas');
    if (!r.ok) return (r.upstreamStatus !== undefined
      ? { ok: false, code: 'doc_upstream', status: r.status, error: r.error, upstreamStatus: r.upstreamStatus }
      : { ok: false, code: r.kind === 'timeout' ? 'doc_timeout' : 'doc_network', status: r.status, error: r.error });
    let parsed: { ok?: boolean; pdf?: string; hash?: string; message?: string };
    try { parsed = JSON.parse(r.buffer.toString('utf8')); }
    catch { return { ok: false, code: 'doc_upstream', status: 502, error: 'Respuesta de improntas inválida.', upstreamStatus: 200 }; }
    if (!parsed.ok || !parsed.pdf) return { ok: false, code: 'doc_upstream', status: 502, error: parsed.message || 'No se generaron las improntas.', upstreamStatus: 200 };
    pdf = Buffer.from(String(parsed.pdf).replace(/^data:application\/pdf;base64,/, ''), 'base64');
    hash = parsed.hash;
  }
  await marcarDocGenerado(id, v, { improntasHash: hash, improntasAt: new Date().toISOString() });
  await persistTramiteDocumento(id, 'impronta', pdf, `Improntas_${t.placa || id}.pdf`).catch(() => {});
  return { ok: true, pdf, contentType: 'application/pdf', hash };
}

/** Gate F2: ¿el trámite tiene contrato de compraventa (generado o subido)? */
export async function hayContratoCompraventa(id: number): Promise<boolean> {
  const [t] = await db.select({ vehiculo: tramitesDigitales.vehiculo }).from(tramitesDigitales).where(eq(tramitesDigitales.id, id)).limit(1);
  const generado = !!((t?.vehiculo as any)?._docs_generados?.contratoAt);
  if (generado) return true;
  const [doc] = await db.select({ id: tramitesDocumentos.id }).from(tramitesDocumentos)
    .where(and(eq(tramitesDocumentos.tramiteId, id), eq(tramitesDocumentos.tipo, 'compraventa'))).limit(1);
  return !!doc;
}
