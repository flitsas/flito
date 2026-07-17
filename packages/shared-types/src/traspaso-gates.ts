/**
 * TRAM-TRASPASO-P0 — gates unificados paso × validación (paridad CEA `puedeAvanzar`).
 * Fuente única para sidebar, Continuar y checks server-side complementarios.
 */

import {
  extractPartesTraspasoFromTramite,
  normalizarDocumentoTraspaso,
  type TraspasoParteMin,
} from './traspaso-partes.js';

export const TRASPASO_TOTAL_PASOS = 6;

export interface TraspasoPreflightCheck {
  key: string;
  status: string;
}

export interface TraspasoPreflightSnapshot {
  overall?: string;
  checks?: TraspasoPreflightCheck[];
}

export interface TraspasoRuntSnapshot {
  documento?: string;
  tipoDoc?: string;
  consultado?: boolean;
}

export interface TraspasoForzarContinuar {
  at?: string;
  userId?: number;
  motivo?: string;
}

export interface TraspasoBiometriaSnapshot {
  vendedor: boolean;
  comprador: boolean;
}

export interface TraspasoGateContext {
  /** Paso UI o persistido (1–6). */
  pasoActual?: number;
  targetPaso: number;
  tramiteId?: number | null;
  vehiculo?: unknown;
  comprador?: unknown;
  preflight?: TraspasoPreflightSnapshot | null;
  pazSalvoImpuesto?: { verificado?: boolean } | null;
  biometria?: TraspasoBiometriaSnapshot | null;
  forzarContinuar?: boolean;
}

export interface TraspasoGateResult {
  ok: boolean;
  code?: string;
  message?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailTraspasoValido(email?: string | null): boolean {
  const e = (email || '').trim();
  return Boolean(e && EMAIL_RE.test(e));
}

export function extractForzarContinuarTraspaso(vehiculo: unknown): TraspasoForzarContinuar | null {
  const fc = (vehiculo as { _forzarContinuar?: TraspasoForzarContinuar } | null)?._forzarContinuar;
  return fc?.at ? fc : null;
}

export function forzarContinuarActivo(vehiculo: unknown): boolean {
  return Boolean(extractForzarContinuarTraspaso(vehiculo));
}

export function preflightBloqueaTraspaso(
  preflight: TraspasoPreflightSnapshot | null | undefined,
  forzar = false,
): boolean {
  if (forzar) return false;
  return preflight?.overall === 'red';
}

export function impuestoGateBloqueaTraspaso(
  preflight: TraspasoPreflightSnapshot | null | undefined,
  pazSalvo: { verificado?: boolean } | null | undefined,
  forzar = false,
): boolean {
  if (forzar) return false;
  const unknown = preflight?.checks?.some((c) => c.key === 'impuesto_vehicular' && c.status === 'unknown');
  if (!unknown) return false;
  return !pazSalvo?.verificado;
}

export function runtParteConsultado(
  vehiculo: unknown,
  key: '_runtVendedor' | '_runtComprador',
  documento?: string | null,
): boolean {
  const runt = ((vehiculo || {}) as Record<string, unknown>)[key] as TraspasoRuntSnapshot | undefined;
  if (!runt?.consultado) return false;
  const doc = normalizarDocumentoTraspaso(documento);
  if (!doc) return false;
  return normalizarDocumentoTraspaso(runt.documento) === doc;
}

export function simitCompradorGateBloquea(
  vehiculo: unknown,
  comprador: unknown,
  forzar = false,
): TraspasoGateResult {
  if (forzar) return { ok: true };
  const veh = (vehiculo || {}) as { _simitComprador?: { documento?: string; consultado?: boolean; total?: number } };
  const comp = (comprador || {}) as { documento?: string };
  const doc = String(comp.documento || '').trim();
  if (!doc) return { ok: false, code: 'comprador_doc', message: 'Documento del comprador requerido' };
  const simit = veh._simitComprador;
  if (!simit?.consultado) {
    return { ok: false, code: 'simit_pendiente', message: 'Consulta SIMIT del comprador obligatoria antes de continuar' };
  }
  if (normalizarDocumentoTraspaso(simit.documento) !== normalizarDocumentoTraspaso(doc)) {
    return { ok: false, code: 'simit_doc', message: 'La consulta SIMIT no corresponde al documento del comprador' };
  }
  if ((simit.total ?? 0) > 0) {
    return { ok: false, code: 'simit_multas', message: 'El comprador tiene comparendos SIMIT pendientes' };
  }
  return { ok: true };
}

export function validateTraspasoComercial(vehiculo: unknown): TraspasoGateResult {
  const com = ((vehiculo || {}) as { _comercial?: { valorVenta?: number } })._comercial;
  const vv = Number(com?.valorVenta) || 0;
  if (vv <= 0) {
    return { ok: false, code: 'comercial_valor', message: 'Ingresa un valor de venta mayor a cero antes de continuar' };
  }
  return { ok: true };
}

export function biometriaAmbasAprobadas(biometria?: TraspasoBiometriaSnapshot | null): boolean {
  return Boolean(biometria?.vendedor && biometria?.comprador);
}

function parteMinCompleta(p: TraspasoParteMin & { nombre?: string | null }): boolean {
  return Boolean(p.nombre?.trim() && p.documento?.trim() && emailTraspasoValido(p.email));
}

/** Paso N (1–6) completado → puede avanzar a N+1. */
export function pasoTraspasoCompleto(paso: number, ctx: Omit<TraspasoGateContext, 'targetPaso'>): TraspasoGateResult {
  const forzar = ctx.forzarContinuar ?? forzarContinuarActivo(ctx.vehiculo);
  const { vendedor, comprador } = extractPartesTraspasoFromTramite({
    vehiculo: ctx.vehiculo,
    comprador: ctx.comprador,
  });

  switch (paso) {
    case 1:
      if (!ctx.tramiteId) {
        return { ok: false, code: 'sin_radicado', message: 'Radica el trámite antes de continuar' };
      }
      return { ok: true };
    case 2:
      if (preflightBloqueaTraspaso(ctx.preflight, forzar)) {
        return { ok: false, code: 'preflight_red', message: 'Hay bloqueos críticos (SOAT/RTM). Subsana antes de continuar' };
      }
      if (impuestoGateBloqueaTraspaso(ctx.preflight, ctx.pazSalvoImpuesto, forzar)) {
        return { ok: false, code: 'impuesto_pendiente', message: 'Confirma paz y salvo de impuesto vehicular antes de continuar' };
      }
      return { ok: true };
    case 3:
      if (!parteMinCompleta(vendedor)) {
        return { ok: false, code: 'vendedor_incompleto', message: 'Completa nombre, documento y email del vendedor' };
      }
      if (!runtParteConsultado(ctx.vehiculo, '_runtVendedor', vendedor.documento)) {
        return { ok: false, code: 'runt_vendedor', message: 'Consulta RUNT del vendedor antes de continuar' };
      }
      return { ok: true };
    case 4: {
      if (!parteMinCompleta(comprador)) {
        return { ok: false, code: 'comprador_incompleto', message: 'Completa nombre, documento y email del comprador' };
      }
      if (!runtParteConsultado(ctx.vehiculo, '_runtComprador', comprador.documento)) {
        return { ok: false, code: 'runt_comprador', message: 'Consulta RUNT del comprador antes de continuar' };
      }
      const simit = simitCompradorGateBloquea(ctx.vehiculo, comprador, forzar);
      if (!simit.ok) return simit;
      return { ok: true };
    }
    case 5:
      return validateTraspasoComercial(ctx.vehiculo);
    case 6:
      return { ok: true };
    default:
      return { ok: false, code: 'paso_invalido', message: 'Paso inválido' };
  }
}

/** Máximo paso alcanzable según datos (1–6). */
export function maxPasoTraspasoAlcanzable(ctx: Omit<TraspasoGateContext, 'targetPaso'>): number {
  if (!ctx.tramiteId) return 1;
  for (let p = 1; p <= TRASPASO_TOTAL_PASOS; p++) {
    if (!pasoTraspasoCompleto(p, ctx).ok) return p;
  }
  return TRASPASO_TOTAL_PASOS;
}

/** Claves JSONB vehiculo/comprador asociadas a cada paso (para bloqueo post-validación). */
export const TRASPASO_PASO_VEH_KEYS: Readonly<Record<number, readonly string[]>> = {
  2: ['_pazSalvoImpuesto', '_impuestoConsulta'],
  3: ['_vendedor', '_runtVendedor'],
  4: ['_comprador', '_runtComprador', '_simitComprador'],
  5: ['_comercial'],
};

/** Paso ya validado y cerrado → solo lectura en UI; PATCH bloqueado en backend. */
export function pasoTraspasoSoloLectura(paso: number, ctx: Omit<TraspasoGateContext, 'targetPaso'>): boolean {
  if (!ctx.tramiteId || paso < 1 || paso > TRASPASO_TOTAL_PASOS) return false;
  const max = maxPasoTraspasoAlcanzable(ctx);
  return paso < max;
}

/** Rechaza PATCH que modifique datos de pasos ya cerrados (< maxPasoTraspasoAlcanzable). */
export function detectarModificacionPasosCerradosTraspaso(
  maxPasoEditable: number,
  vehPatch: unknown,
  compradorPatch?: unknown,
  opts?: { pasoPatch?: number },
): TraspasoGateResult {
  const pa = (vehPatch || {}) as Record<string, unknown>;
  const paso6Docs = opts?.pasoPatch === 6;
  for (let p = 2; p < maxPasoEditable && p <= TRASPASO_TOTAL_PASOS; p++) {
    const keys = TRASPASO_PASO_VEH_KEYS[p] ?? [];
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(pa, k)) continue;
      if (paso6Docs && p === 2 && k === '_pazSalvoImpuesto') continue;
      return {
        ok: false,
        code: 'paso_cerrado',
        message: `El paso ${p} está cerrado. No puedes modificar datos ya validados.`,
      };
    }
  }
  if (compradorPatch !== undefined && maxPasoEditable > 4) {
    return {
      ok: false,
      code: 'paso_cerrado',
      message: 'El paso 4 (comprador) está cerrado. No puedes modificar datos ya validados.',
    };
  }
  return { ok: true };
}

/** Paso UI/BD canónico para persistir tras reconciliación legacy. */
export function reconciliarPasoTraspasoBD(ctx: Omit<TraspasoGateContext, 'targetPaso' | 'pasoActual'>): number {
  return maxPasoTraspasoAlcanzable(ctx);
}

/** Etiqueta legible para logs de backfill paso. */
export function hintReconciliacionPasoTraspaso(
  pasoActual: number,
  pasoNuevo: number,
  vehiculo: unknown,
): string {
  const com = ((vehiculo || {}) as { _comercial?: { valorVenta?: number } })._comercial;
  const hasComercial = Number(com?.valorVenta) > 0;
  if (pasoActual === 5 && pasoNuevo === 4 && !hasComercial) {
    return 'legacy: paso 5 guardaba comprador (ahora paso 4)';
  }
  if (pasoActual === 5 && pasoNuevo === 6 && hasComercial) {
    return 'legacy: paso 5 con comercial persistido (ahora paso 6)';
  }
  if (pasoActual > pasoNuevo) return 'paso BD adelantado respecto a gates';
  if (pasoActual < pasoNuevo) return 'paso BD atrasado respecto a progreso JSONB';
  return 'recalculo gates';
}

/** Puede avanzar desde el paso actual (botón Continuar). */
export function puedeAvanzarDesdePasoTraspaso(
  paso: number,
  ctx: Omit<TraspasoGateContext, 'targetPaso'>,
): TraspasoGateResult {
  return pasoTraspasoCompleto(paso, ctx);
}

/** Puede navegar al paso destino (sidebar). Retroceder siempre permitido si hay trámite. */
export function puedeIrAPasoTraspaso(ctx: TraspasoGateContext): TraspasoGateResult {
  const { targetPaso, pasoActual = 1 } = ctx;
  if (targetPaso < 1 || targetPaso > TRASPASO_TOTAL_PASOS) {
    return { ok: false, code: 'paso_invalido', message: 'Paso inválido' };
  }
  if (targetPaso === 1) return { ok: true };
  if (!ctx.tramiteId) {
    return { ok: false, code: 'sin_tramite', message: 'Radica el trámite primero' };
  }
  if (targetPaso <= pasoActual) return { ok: true };
  for (let p = pasoActual; p < targetPaso; p++) {
    const r = pasoTraspasoCompleto(p, ctx);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Alias corto usado en FE (sidebar + Continuar). */
export function puedeAvanzarTraspaso(ctx: TraspasoGateContext): TraspasoGateResult {
  if (ctx.targetPaso <= (ctx.pasoActual ?? 1)) {
    return puedeIrAPasoTraspaso(ctx);
  }
  const desde = ctx.pasoActual ?? 1;
  const avance = pasoTraspasoCompleto(desde, ctx);
  if (!avance.ok) return avance;
  return puedeIrAPasoTraspaso({ ...ctx, targetPaso: desde + 1 });
}

export function gateFurTraspaso(
  vehiculo: unknown,
  biometria?: TraspasoBiometriaSnapshot | null,
): TraspasoGateResult {
  if (forzarContinuarActivo(vehiculo)) return { ok: true };
  if (!biometriaAmbasAprobadas(biometria)) {
    return {
      ok: false,
      code: 'biometria_pendiente',
      message: 'Valida la biométrica de vendedor y comprador antes de generar el FUR',
    };
  }
  return { ok: true };
}
