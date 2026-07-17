// EPIC TRAM-INNOV · A1 — Pre-vuelo SOAT · SIMIT · RUNT (semáforo de requisitos).
//
// FLIT es preparador/orquestador: este pre-vuelo es "mejor esfuerzo" con las
// integraciones existentes (RUNT vía CEA). NO es validación legal automática ni
// sustituye la radicación en el organismo. El semáforo de comparendos es
// informativo (no bloquea sin decisión humana).
//
// Diseño: la derivación de checks es PURA (testeable sin red) en
// `derivePreflightChecks`; la orquestación de IO (consultas RUNT + persistencia)
// vive en `computePreflight` (rutas la invocan).

import { eq, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tramitePreflight, tramitesDigitales } from '../../db/schema.js';
import { consultarVehiculoRunt, consultarPersonaRunt } from '../runt/runt.service.js';
import { consultarSimit } from '../integraciones/integraciones.service.js';
import { tramPreflightComputedTotal } from '../../shared/metrics.js';
import { loggerFor } from '../../shared/logger.js';
import { screenParte, docLast4, type LaftScreening, type LaftStatus } from './laft-screening.js';
import { emitEvento } from './eventos.js';
import { getFirmaResumen } from '../firma/firma.service.js';
import { getPreflightAction, derivaFirmaCompraventaCheck, impuestoIndicaPazSalvo, type PreflightAction } from '@operaciones/shared-types';

const log = loggerFor('tramite.preflight');

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';
export type OverallStatus = 'green' | 'yellow' | 'red';

export interface PreflightCheck {
  key: string;
  label: string;
  status: CheckStatus;
  source: string;
  message: string;
  // TRAM-INNOV-PRE-02: CTA canónica server-driven (la web la consume tal cual).
  action?: PreflightAction | null;
}

export interface PreflightResult {
  overall: OverallStatus;
  checks: PreflightCheck[];
}

const ISO_NOW = () => new Date();

/** Parsea una fecha RUNT (dd/MM/yyyy o ISO) a Date, o null si no se puede. */
function parseFecha(v: unknown): Date | null {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function firstSoat(soat: unknown): Record<string, unknown> | null {
  if (!soat) return null;
  if (Array.isArray(soat)) return (soat[0] as Record<string, unknown>) || null;
  if (typeof soat === 'object') return soat as Record<string, unknown>;
  return null;
}

/** ¿La respuesta de comparendos indica comparendos pendientes? */
function tieneComparendos(multas: unknown): boolean | null {
  if (multas == null) return null;
  if (Array.isArray(multas)) return multas.length > 0;
  if (typeof multas === 'object') {
    const m = multas as Record<string, unknown>;
    const flag = String(m.tieneMultas ?? '').toLowerCase();
    if (flag === 'si' || flag === 'sí' || flag === 'true') return true;
    if (flag === 'no' || flag === 'false') return false;
    const total = Number(m.totalMultas ?? m.valorTotal ?? 0);
    if (Number.isFinite(total) && total > 0) return true;
    if (m.tieneMultas !== undefined || m.valorTotal !== undefined || m.totalMultas !== undefined) return false;
  }
  return null;
}

export interface DerivePreflightInput {
  /** Respuesta de consultarVehiculoRunt (o null si falló/no consultado). */
  vehiculoResp?: { ok?: boolean; data?: any } | null;
  /** Respuesta de comparendos del comprador (consultarPersonaRunt) o null. */
  compradorResp?: { ok?: boolean; persona?: any; multas?: any } | null;
  /** Respuesta de comparendos del vendedor o null. */
  vendedorResp?: { ok?: boolean; persona?: any; multas?: any } | null;
  /** Documentos provistos (para distinguir "no consultado" de "sin comparendos"). */
  compradorDoc?: string;
  vendedorDoc?: string;
  // TRAM-F3: SIMIT real (proxy CEA) por parte y por placa. Tiene precedencia sobre
  // los `multas` que pueda traer RUNT. Cada uno null si no se consultó.
  simitComprador?: { ok?: boolean; total?: number; totalMonto?: number } | null;
  simitVendedor?: { ok?: boolean; total?: number; totalMonto?: number } | null;
  simitPlaca?: { ok?: boolean; total?: number; totalMonto?: number } | null;
  placa?: string;
}

const fmtCOP = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

/**
 * Deriva los checks del pre-vuelo a partir de respuestas RUNT ya obtenidas.
 * PURA: sin red, sin BD. El overall se calcula sobre los checks DETERMINADOS
 * (no `unknown`): cualquier `fail` → red; si no, cualquier `warn` → yellow; si
 * todos los determinados son `ok` → green (los `unknown` se muestran pero no
 * impiden el verde, para que el pre-vuelo sea alcanzable sin todas las fuentes).
 */
export function derivePreflightChecks(input: DerivePreflightInput): PreflightResult {
  const checks: PreflightCheck[] = [];
  const vData = input.vehiculoResp?.ok ? (input.vehiculoResp.data || {}) : null;

  // --- SOAT ---
  {
    const soat = firstSoat(vData?.soat);
    if (!vData) {
      checks.push({ key: 'soat', label: 'SOAT vigente', status: 'unknown', source: 'RUNT', message: 'No se pudo consultar el vehículo en RUNT.' });
    } else if (!soat) {
      checks.push({ key: 'soat', label: 'SOAT vigente', status: 'unknown', source: 'RUNT', message: 'RUNT no reporta póliza SOAT para el vehículo.' });
    } else {
      const estado = String(soat.estadoSoat ?? soat.estado ?? '').toLowerCase();
      const vence = parseFecha(soat.fechaVencimSoat ?? soat.fechaVencimiento);
      const vigentePorEstado = estado.includes('vigente') && !estado.includes('no vigente');
      const vigentePorFecha = vence ? vence.getTime() >= ISO_NOW().getTime() : null;
      if (vigentePorFecha === false || estado.includes('no vigente') || estado.includes('vencid')) {
        checks.push({ key: 'soat', label: 'SOAT vigente', status: 'fail', source: 'RUNT', message: `SOAT vencido${vence ? ` (venció ${soat.fechaVencimSoat ?? ''})` : ''}. Requiere renovación antes de matricular.` });
      } else if (vigentePorEstado || vigentePorFecha === true) {
        checks.push({ key: 'soat', label: 'SOAT vigente', status: 'ok', source: 'RUNT', message: `SOAT vigente${vence ? ` hasta ${soat.fechaVencimSoat ?? ''}` : ''}.` });
      } else {
        checks.push({ key: 'soat', label: 'SOAT vigente', status: 'unknown', source: 'RUNT', message: 'No se pudo determinar la vigencia del SOAT.' });
      }
    }
  }

  // --- RTM (revisión técnico-mecánica) ---
  {
    const rtmVence = parseFecha(vData?.fechaVencimientoRtm ?? vData?.fechaVencimRtm ?? vData?.rtmVencimiento);
    if (!vData) {
      checks.push({ key: 'rtm', label: 'Revisión técnico-mecánica', status: 'unknown', source: 'RUNT', message: 'No se pudo consultar el vehículo en RUNT.' });
    } else if (rtmVence) {
      const ok = rtmVence.getTime() >= ISO_NOW().getTime();
      checks.push({ key: 'rtm', label: 'Revisión técnico-mecánica', status: ok ? 'ok' : 'fail', source: 'RUNT', message: ok ? 'RTM vigente.' : 'RTM vencida.' });
    } else {
      checks.push({ key: 'rtm', label: 'Revisión técnico-mecánica', status: 'unknown', source: 'RUNT', message: 'RUNT no reporta RTM (puede no aplicar según antigüedad).' });
    }
  }

  // --- Comparendos SIMIT (comprador / vendedor) — semáforo informativo ---
  // Precedencia: SIMIT real (proxy CEA) > multas RUNT.
  for (const rol of ['comprador', 'vendedor'] as const) {
    const resp = rol === 'comprador' ? input.compradorResp : input.vendedorResp;
    const simit = rol === 'comprador' ? input.simitComprador : input.simitVendedor;
    const docProvisto = rol === 'comprador' ? input.compradorDoc : input.vendedorDoc;
    const label = `Comparendos ${rol}`;
    if (!docProvisto) {
      checks.push({ key: `comparendos_${rol}`, label, status: 'unknown', source: 'SIMIT', message: `Documento del ${rol} no provisto.` });
      continue;
    }
    if (simit && simit.ok) {
      const total = Number(simit.total) || 0;
      if (total > 0) {
        checks.push({ key: `comparendos_${rol}`, label, status: 'warn', source: 'SIMIT', message: `El ${rol} registra ${total} comparendo(s) (${fmtCOP(Number(simit.totalMonto) || 0)}). Verificar paz y salvo antes de radicar.` });
      } else {
        checks.push({ key: `comparendos_${rol}`, label, status: 'ok', source: 'SIMIT', message: `Sin comparendos SIMIT del ${rol}.` });
      }
      continue;
    }
    if (!resp || resp.ok === false) {
      checks.push({ key: `comparendos_${rol}`, label, status: 'unknown', source: 'SIMIT/RUNT', message: `No se pudo consultar comparendos del ${rol}.` });
      continue;
    }
    const tiene = tieneComparendos(resp.multas);
    if (tiene === true) {
      checks.push({ key: `comparendos_${rol}`, label, status: 'warn', source: 'SIMIT/RUNT', message: `El ${rol} registra comparendos. Verificar paz y salvo antes de radicar.` });
    } else if (tiene === false) {
      checks.push({ key: `comparendos_${rol}`, label, status: 'ok', source: 'SIMIT/RUNT', message: `Sin comparendos pendientes del ${rol}.` });
    } else {
      checks.push({ key: `comparendos_${rol}`, label, status: 'unknown', source: 'SIMIT/RUNT', message: `Respuesta de comparendos del ${rol} no concluyente.` });
    }
  }

  // --- Comparendos SIMIT por placa (vehículo) ---
  {
    const label = 'Comparendos del vehículo (placa)';
    if (!input.placa) {
      checks.push({ key: 'comparendos_placa', label, status: 'unknown', source: 'SIMIT', message: 'Placa no provista.' });
    } else if (input.simitPlaca && input.simitPlaca.ok) {
      const total = Number(input.simitPlaca.total) || 0;
      if (total > 0) {
        checks.push({ key: 'comparendos_placa', label, status: 'warn', source: 'SIMIT', message: `La placa registra ${total} comparendo(s) (${fmtCOP(Number(input.simitPlaca.totalMonto) || 0)}).` });
      } else {
        checks.push({ key: 'comparendos_placa', label, status: 'ok', source: 'SIMIT', message: 'Sin comparendos SIMIT asociados a la placa.' });
      }
    } else {
      checks.push({ key: 'comparendos_placa', label, status: 'unknown', source: 'SIMIT', message: 'No se pudo consultar comparendos de la placa.' });
    }
  }

  // --- Inscripción RUNT de las partes (flag) ---
  {
    const estadoPersona = input.compradorResp?.persona?.estadoPersona;
    if (!input.compradorDoc) {
      checks.push({ key: 'inscripcion_runt', label: 'Inscripción RUNT del comprador', status: 'unknown', source: 'RUNT', message: 'Documento del comprador no provisto.' });
    } else if (input.compradorResp?.ok && estadoPersona) {
      const activo = String(estadoPersona).toLowerCase().includes('activ');
      checks.push({ key: 'inscripcion_runt', label: 'Inscripción RUNT del comprador', status: activo ? 'ok' : 'warn', source: 'RUNT', message: `Estado en RUNT: ${estadoPersona}.` });
    } else {
      checks.push({ key: 'inscripcion_runt', label: 'Inscripción RUNT del comprador', status: 'unknown', source: 'RUNT', message: 'No se pudo verificar la inscripción del comprador en RUNT.' });
    }
  }

  // --- Impuesto vehicular (placeholder; se enriquece en computePreflight si hay trámite traspaso) ---
  checks.push({
    key: 'impuesto_vehicular',
    label: 'Impuesto vehicular al día',
    status: 'unknown',
    source: 'Operaciones',
    message: 'Consulte impuesto vehicular o registre paz y salvo manual/documento.',
  });

  // Overall sobre los checks determinados.
  const determinados = checks.filter((c) => c.status !== 'unknown');
  let overall: OverallStatus;
  if (determinados.some((c) => c.status === 'fail')) overall = 'red';
  else if (determinados.some((c) => c.status === 'warn')) overall = 'yellow';
  else overall = 'green';

  // TRAM-INNOV-PRE-02: adjuntar la CTA canónica a cada check (server-driven).
  for (const c of checks) c.action = getPreflightAction(c.key, c.status);

  return { overall, checks };
}

/** LaftStatus → estado de check del pre-vuelo. */
function laftStatusToCheck(s: LaftStatus): CheckStatus {
  return s === 'green' ? 'ok' : s === 'yellow' ? 'warn' : s === 'red' ? 'fail' : 'unknown';
}

/**
 * TRAM-INNOV-PRE-02: checks LAFT SINTÉTICOS (con CTA) a partir del screening.
 * Informativos (NO alteran `overall` — B6); se anexan tras computar el semáforo.
 * PURA: testeable sin red.
 */
export function deriveLaftChecks(
  laftComprador: LaftScreening | null | undefined,
  laftVendedor: LaftScreening | null | undefined,
): PreflightCheck[] {
  const out: PreflightCheck[] = [];
  for (const [rol, screen] of [['comprador', laftComprador], ['vendedor', laftVendedor]] as const) {
    if (!screen) continue;
    const status = laftStatusToCheck(screen.status);
    const key = `laft_${rol}`;
    const message = screen.matches > 0
      ? `${screen.matches} coincidencia(s) en listas restrictivas${screen.topSignal ? ` · ${screen.topSignal}` : ''}. Revisión humana (HITL) en LAFT.`
      : 'Sin coincidencias significativas en listas restrictivas.';
    out.push({ key, label: `Listas restrictivas · ${rol}`, status, source: 'LAFT', message, action: getPreflightAction(key, status) });
  }
  return out;
}

/** Enriquece check impuesto desde JSONB vehiculo (todos los traspasos con datos persistidos). */
export function deriveImpuestoVehicularCheck(vehiculo: unknown): PreflightCheck {
  const v = (vehiculo && typeof vehiculo === 'object') ? vehiculo as Record<string, unknown> : {};
  const paz = v._pazSalvoImpuesto as { verificado?: boolean; metodo?: string } | undefined;
  if (paz?.verificado) {
    const metodo = paz.metodo === 'upload' ? 'documento' : paz.metodo === 'consulta' ? 'consulta gobernación' : 'manual';
    return {
      key: 'impuesto_vehicular',
      label: 'Impuesto vehicular al día',
      status: 'ok',
      source: 'Operaciones',
      message: `Paz y salvo registrado (${metodo}).`,
    };
  }
  const consulta = v._impuestoConsulta as { fuente?: string; datos?: Record<string, unknown> } | undefined;
  const datos = consulta?.datos;
  if (datos && impuestoIndicaPazSalvo(datos)) {
    return {
      key: 'impuesto_vehicular',
      label: 'Impuesto vehicular al día',
      status: 'ok',
      source: consulta?.fuente || 'Operaciones',
      message: `Impuesto al día según consulta (${String(datos.estadoPago ?? 'OK')}).`,
    };
  }
  if (datos && typeof datos.totalPagar === 'number' && datos.totalPagar > 0) {
    return {
      key: 'impuesto_vehicular',
      label: 'Impuesto vehicular al día',
      status: 'warn',
      source: consulta?.fuente || 'Operaciones',
      message: `Deuda vigente: $${Number(datos.totalPagar).toLocaleString('es-CO')}. Suba paz y salvo o confirme manualmente.`,
    };
  }
  if (consulta?.fuente) {
    return {
      key: 'impuesto_vehicular',
      label: 'Impuesto vehicular al día',
      status: 'unknown',
      source: consulta.fuente,
      message: 'Consulta realizada — confirme paz y salvo manual o suba documento.',
    };
  }
  return {
    key: 'impuesto_vehicular',
    label: 'Impuesto vehicular al día',
    status: 'unknown',
    source: 'Operaciones',
    message: 'Consulte impuesto vehicular o registre paz y salvo manual/documento.',
  };
}

export interface ComputePreflightInput {
  vin?: string;
  placa?: string;
  compradorDoc?: string;
  compradorTipoDoc?: string;
  compradorNombre?: string;
  vendedorDoc?: string;
  vendedorTipoDoc?: string;
  vendedorNombre?: string;
  tramiteId?: number;
}

export interface PreflightSnapshot extends PreflightResult {
  id: number | null;
  vin: string | null;
  placa: string | null;
  createdAt: string;
  // B6: screening LAFT informativo (NO altera `overall`; semáforo aparte).
  laftComprador?: LaftScreening | null;
  laftVendedor?: LaftScreening | null;
}

/** Nombre completo a partir de la respuesta RUNT de persona (fallback de screening). */
function nombreDesdePersona(resp: any): string | undefined {
  const p = resp?.persona;
  if (!p) return undefined;
  const n = [p.nombres, p.apellidos].filter(Boolean).join(' ').trim();
  return n || undefined;
}

/**
 * Orquesta el pre-vuelo: consulta RUNT (vehículo + personas, en paralelo, con
 * degradación elegante), deriva el semáforo, persiste el snapshot y emite la
 * métrica. Nunca lanza por fallo de integración (cada fuente caída → unknown).
 */
const PREFLIGHT_IO_MS = 25_000;
const PREFLIGHT_IO_OPTS = { skipCeaFallback: true } as const;

function preflightIoTimeout<T>(promise: Promise<T>, label: string): Promise<T | null> {
  return Promise.race([
    promise.catch((e) => { log.warn({ err: (e as Error)?.message, label }, 'preflight io error'); return null; }),
    new Promise<null>((resolve) => {
      setTimeout(() => { log.warn({ label }, 'preflight io timeout'); resolve(null); }, PREFLIGHT_IO_MS);
    }),
  ]);
}

export async function computePreflight(input: ComputePreflightInput, userId: number | null): Promise<PreflightSnapshot> {
  const docVehiculo = input.compradorDoc || input.vendedorDoc;
  const wantVehiculo = !!(input.vin || (input.placa && docVehiculo));
  const safeSimit = (filtro?: string) =>
    filtro
      ? preflightIoTimeout(consultarSimit(filtro, PREFLIGHT_IO_OPTS), `simit:${filtro.slice(0, 4)}`)
      : Promise.resolve(null);
  const [vehiculoResp, compradorResp, vendedorResp, simitComprador, simitVendedor, simitPlaca] = await Promise.all([
    wantVehiculo
      ? preflightIoTimeout(
        consultarVehiculoRunt(input.placa, input.vin, docVehiculo, input.compradorTipoDoc || input.vendedorTipoDoc, PREFLIGHT_IO_OPTS),
        'runt:vehiculo',
      )
      : Promise.resolve(null),
    input.compradorDoc
      ? preflightIoTimeout(consultarPersonaRunt(input.compradorDoc, input.compradorTipoDoc, PREFLIGHT_IO_OPTS), 'runt:comprador')
      : Promise.resolve(null),
    input.vendedorDoc
      ? preflightIoTimeout(consultarPersonaRunt(input.vendedorDoc, input.vendedorTipoDoc, PREFLIGHT_IO_OPTS), 'runt:vendedor')
      : Promise.resolve(null),
    safeSimit(input.compradorDoc),
    safeSimit(input.vendedorDoc),
    safeSimit(input.placa),
  ]);

  const result = derivePreflightChecks({
    vehiculoResp: vehiculoResp as any,
    compradorResp: compradorResp as any,
    vendedorResp: vendedorResp as any,
    compradorDoc: input.compradorDoc,
    vendedorDoc: input.vendedorDoc,
    simitComprador: simitComprador as any,
    simitVendedor: simitVendedor as any,
    simitPlaca: simitPlaca as any,
    placa: input.placa,
  });

  tramPreflightComputedTotal.inc({ result: result.overall });

  // B6: screening LAFT (listas restrictivas) — INFORMATIVO, no altera `overall`.
  // Nombre: el provisto o el de RUNT como fallback. Solo si hay documento.
  const [laftComprador, laftVendedor] = await Promise.all([
    screenParte(input.compradorDoc, input.compradorNombre ?? nombreDesdePersona(compradorResp)),
    screenParte(input.vendedorDoc, input.vendedorNombre ?? nombreDesdePersona(vendedorResp)),
  ]);

  // TRAM-INNOV-PRE-02: anexar checks LAFT sintéticos (con CTA). Tras el overall →
  // informativos, no alteran el semáforo (B6).
  result.checks.push(...deriveLaftChecks(laftComprador, laftVendedor));

  // TRAM-INNOV-B3 + TRAM-TRASPASO-P1: checks por trámite (firma, impuesto) — todos los traspasos.
  if (input.tramiteId) {
    try {
      const [tr] = await db.select({
        tip: tramitesDigitales.tipologiaCodigo,
        modalidad: tramitesDigitales.modalidadEntrada,
        vehiculo: tramitesDigitales.vehiculo,
      }).from(tramitesDigitales).where(eq(tramitesDigitales.id, input.tramiteId)).limit(1);

      if (tr?.modalidad === 'traspaso') {
        const impCheck = deriveImpuestoVehicularCheck(tr.vehiculo);
        impCheck.action = getPreflightAction(impCheck.key, impCheck.status);
        const impIdx = result.checks.findIndex((c) => c.key === 'impuesto_vehicular');
        if (impIdx >= 0) result.checks[impIdx] = impCheck;
      }

      if (tr?.tip === 'traspaso_standard') {
        const firmas = await getFirmaResumen(input.tramiteId);
        const check = derivaFirmaCompraventaCheck({ tipologiaCodigo: tr.tip, firmas });
        if (check) result.checks.push(check);
      }
    } catch (e: any) { log.warn({ err: e?.message }, 'preflight traspaso checks'); }
  }

  // Evento A2 (sin cédulas: solo status + matches + últimos 4 del doc).
  if (input.tramiteId && (laftComprador || laftVendedor)) {
    emitEvento({
      tramiteId: input.tramiteId,
      tipo: 'laft_screening',
      actorUserId: userId,
      payload: {
        comprador: laftComprador ? { status: laftComprador.status, matches: laftComprador.matches, docLast4: docLast4(input.compradorDoc) } : null,
        vendedor: laftVendedor ? { status: laftVendedor.status, matches: laftVendedor.matches, docLast4: docLast4(input.vendedorDoc) } : null,
      },
    });
  }

  let id: number | null = null;
  let createdAt = ISO_NOW();
  try {
    const [row] = await db.insert(tramitePreflight).values({
      tramiteId: input.tramiteId ?? null,
      vin: input.vin ?? null,
      placa: input.placa ?? null,
      compradorDoc: input.compradorDoc ?? null,
      vendedorDoc: input.vendedorDoc ?? null,
      checks: result.checks as any,
      overallStatus: result.overall,
      createdBy: userId ?? null,
    }).returning({ id: tramitePreflight.id, createdAt: tramitePreflight.createdAt });
    id = row?.id ?? null;
    if (row?.createdAt) createdAt = row.createdAt;
  } catch (e: any) {
    log.warn({ err: e?.message }, 'no se pudo persistir snapshot de pre-vuelo');
  }

  return { id, ...result, vin: input.vin ?? null, placa: input.placa ?? null, createdAt: createdAt.toISOString(), laftComprador, laftVendedor };
}

/** Último snapshot de pre-vuelo de un trámite (o null si no hay). */
export async function getLatestPreflight(tramiteId: number): Promise<PreflightSnapshot | null> {
  const [row] = await db.select().from(tramitePreflight)
    .where(eq(tramitePreflight.tramiteId, tramiteId))
    .orderBy(desc(tramitePreflight.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    overall: row.overallStatus as OverallStatus,
    checks: (row.checks as PreflightCheck[]) || [],
    vin: row.vin,
    placa: row.placa,
    createdAt: (row.createdAt as Date).toISOString(),
  };
}
