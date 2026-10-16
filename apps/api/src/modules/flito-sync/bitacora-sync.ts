// FLITO — Bitácora de la sincronización (HU #13626). Diseño: `docs/diseno/hu-13626-bitacora-cambios-sync.md`.
//
// Cada trámite que FLIT 1 o FLIT 2 crea o cambia deja UNA entrada en `audit_logs` (`flito_tramite`,
// `userEmail` 'sistema'), escrita dentro de la transacción del trámite. Las dos fuentes pasan por la
// MISMA función (`registrarBitacoraSync`) y producen la misma forma; solo cambia la etiqueta de fuente.
//
// RN-B1  `detail` = `[<fuente>] <tipo> · radicado <R> · <diferencias> · aplicado`. Tipo: «creación»,
//        «cambio de estado» (si cambió `flit_estado`, aunque cambien otros campos) o «cambio de datos».
// RN-B2  Campos comparados: lista cerrada (`CAMPOS_TRAMITE_BITACORA` + compradores). `sincronizadoEn`,
//        `flitRaw`, `syncVersion` y el resto no cuentan: una actualización sin diferencias no deja entrada.
// RN-B3  PII (placa y datos de persona del comprador): la entrada dice «cambió <campo>», nunca el valor.
//        Las diferencias PII no llevan valores, y el formateador tampoco los escribiría (`CAMPOS_PII`).
// RN-B4  Compradores emparejados por `orden` y normalizados como la huella de FLIT 2 (porcentaje numeric
//        '60.00' = 60; '' = null), para no dejar un «cambió …» falso en cada relectura. Uno que entra o
//        sale solo cambia el conteo.
//
// HU #13627 — fallos. Un trámite cuya escritura lanza (y su transacción se revierte) deja igualmente una
// entrada, escrita FUERA de esa transacción con `db`:
// RN-B5  `detail` = `[<fuente>] fallo · radicado <R> · error <Clase|código> · falló`. El error se resume
//        en su código (`code` de pg/Node, `codigo` de los errores de FLITO) o en el nombre de su clase;
//        nunca el mensaje, que puede llevar cédulas, correos o placas (AC3). Ni en la Bitácora ni en el log.
// RN-B6  Deduplicación: si la última entrada `flito_tramite` de ese radicado y fuente ya es ese mismo
//        «falló» (mismo código), no se escribe otra. FLIT 2 frena la lectura en el ítem que falla y lo
//        reintenta en cada corrida: sin esto, la Bitácora tendría una entrada idéntica cada 5 minutos.
// RN-B7  `resourceId` = UUID del trámite si ya existía; null si era nuevo (el radicado va en el detalle).
// RN-B8  Si escribir la entrada falla, no se propaga: la corrida sigue y queda un log sin PII (AC5).
//
// No importa de `flito-sync.service.ts` (que la importa a ella): sin ciclo.

import { and, desc, eq, like } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { auditLogs, flitoTramites } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-sync-bitacora');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type FuenteBitacora = 'FLIT 1' | 'FLIT 2';

/** Una diferencia. Las de campos PII no llevan `antes`/`despues` (RN-B3). */
export interface Diferencia {
  campo: string;
  /** `orden + 1` del comprador, si la diferencia es de un comprador. */
  comprador?: number;
  antes?: string | null;
  despues?: string | null;
}

/** Campos del trámite, en el orden en que se listan. Las 7 primeras claves son las del historial (AC8). */
export const CAMPOS_TRAMITE_BITACORA = [
  { clave: 'flit_estado', etiqueta: 'estado' },
  { clave: 'factura_venta_flit_id', etiqueta: 'factura' },
  { clave: 'fecha_aprobacion', etiqueta: 'fecha de aprobación' },
  { clave: 'compania_id', etiqueta: 'compañía' },
  { clave: 'organismo_codigo', etiqueta: 'organismo' },
  { clave: 'tipo_tramite', etiqueta: 'tipo de trámite' },
  { clave: 'ciudad', etiqueta: 'ciudad' },
  { clave: 'plate_complete', etiqueta: 'placa' },
] as const;

/** Claves de `registrarDiferencias` (historial): las de siempre, sin la placa (AC8). */
const CLAVES_HISTORIAL = CAMPOS_TRAMITE_BITACORA.map((c) => c.clave).filter((c) => c !== 'plate_complete');

const CAMPOS_COMPRADOR = [
  { clave: 'numero_documento', etiqueta: 'documento', prop: 'numeroDocumento' },
  { clave: 'nombre_completo', etiqueta: 'nombre', prop: 'nombreCompleto' },
  { clave: 'correo', etiqueta: 'correo', prop: 'correo' },
  { clave: 'celular', etiqueta: 'celular', prop: 'celular' },
  { clave: 'direccion', etiqueta: 'dirección', prop: 'direccion' },
] as const;

/** Campos cuyo valor nunca se escribe en la Bitácora (RN-B3). */
export const CAMPOS_PII: ReadonlySet<string> = new Set([
  'plate_complete', 'numero_documento', 'nombre_completo', 'correo', 'celular', 'direccion',
]);

const ETIQUETAS: Record<string, string> = {
  ...Object.fromEntries(CAMPOS_TRAMITE_BITACORA.map((c) => [c.clave, c.etiqueta])),
  ...Object.fromEntries(CAMPOS_COMPRADOR.map((c) => [c.clave, c.etiqueta])),
  porcentaje_participacion: 'participación',
  compradores: 'compradores',
};

/** Lo que `vistaTramite` lee: una fila de `flito_tramites` o los valores que arma una fuente. */
export interface TramiteComparable {
  flitEstado?: string | null;
  facturaVentaFlitId?: string | null;
  fechaAprobacion?: Date | null;
  companiaId?: number | null;
  organismoCodigo?: string | null;
  tipoTramite?: string | null;
  ciudad?: string | null;
  plateComplete?: string | null;
}

export type VistaTramite = Record<string, string | null>;

/** Vista comparable del trámite (misma normalización que el historial de siempre, más la placa). */
export function vistaTramite(t: TramiteComparable): VistaTramite {
  return {
    flit_estado: t.flitEstado ?? null,
    factura_venta_flit_id: t.facturaVentaFlitId ?? null,
    fecha_aprobacion: t.fechaAprobacion ? t.fechaAprobacion.toISOString() : null,
    compania_id: t.companiaId == null ? null : String(t.companiaId),
    organismo_codigo: t.organismoCodigo ?? null,
    tipo_tramite: t.tipoTramite ?? null,
    ciudad: t.ciudad ?? null,
    plate_complete: t.plateComplete ?? null,
  };
}

/** La vista con solo las 7 claves del historial, en su orden (para `registrarDiferencias`, AC8). */
export function vistaHistorial(v: VistaTramite): VistaTramite {
  return Object.fromEntries(CLAVES_HISTORIAL.map((k) => [k, v[k] ?? null]));
}

export function diferenciasTramite(antes: VistaTramite, despues: VistaTramite): Diferencia[] {
  const out: Diferencia[] = [];
  for (const { clave } of CAMPOS_TRAMITE_BITACORA) {
    const a = antes[clave] ?? null;
    const b = despues[clave] ?? null;
    if (a === b) continue;
    out.push(CAMPOS_PII.has(clave) ? { campo: clave } : { campo: clave, antes: a, despues: b });
  }
  return out;
}

/** Comprador comparable: lo guardado (porcentaje numeric en texto) o lo mapeado de la fuente. */
export interface CompradorComparable {
  orden: number;
  numeroDocumento: string | null;
  nombreCompleto: string | null;
  correo: string | null;
  celular: string | null;
  direccion: string | null;
  porcentajeParticipacion: string | number | null;
}

const texto = (v: string | null | undefined): string | null => (v == null || v === '' ? null : v);
const pct = (v: string | number | null | undefined): string | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : String(n);
};

/** Diferencias de compradores emparejados por `orden` (RN-B4). */
export function diferenciasCompradores(guardados: CompradorComparable[], nuevos: CompradorComparable[]): Diferencia[] {
  const out: Diferencia[] = [];
  if (guardados.length !== nuevos.length) {
    out.push({ campo: 'compradores', antes: String(guardados.length), despues: String(nuevos.length) });
  }
  const porOrden = new Map(guardados.map((c) => [c.orden, c]));
  for (const n of [...nuevos].sort((a, b) => a.orden - b.orden)) {
    const g = porOrden.get(n.orden);
    if (!g) continue; // entra un comprador: solo el conteo
    const comprador = n.orden + 1;
    for (const c of CAMPOS_COMPRADOR) {
      if (texto(g[c.prop]) !== texto(n[c.prop])) out.push({ campo: c.clave, comprador });
    }
    const pa = pct(g.porcentajeParticipacion);
    const pb = pct(n.porcentajeParticipacion);
    if (pa !== pb) out.push({ campo: 'porcentaje_participacion', comprador, antes: pa, despues: pb });
  }
  return out;
}

function formatear(d: Diferencia): string {
  const etiqueta = ETIQUETAS[d.campo] ?? d.campo;
  const quien = d.comprador === undefined ? '' : ` (comprador ${d.comprador})`;
  if (CAMPOS_PII.has(d.campo)) return `cambió ${etiqueta}${quien}`;
  return `${etiqueta}${quien}: ${d.antes ?? '—'} → ${d.despues ?? '—'}`;
}

export interface EntradaBitacora {
  fuente: FuenteBitacora;
  radicado: string;
  esNuevo: boolean;
  diferencias: Diferencia[];
}

/** Único formateador de la Bitácora del sync (AC7). `null`: actualización sin diferencias, no se escribe. */
export function detalleBitacora({ fuente, radicado, esNuevo, diferencias }: EntradaBitacora): string | null {
  if (esNuevo) return `[${fuente}] creación · radicado ${radicado} · aplicado`;
  if (diferencias.length === 0) return null;
  const tipo = diferencias.some((d) => d.campo === 'flit_estado') ? 'cambio de estado' : 'cambio de datos';
  return `[${fuente}] ${tipo} · radicado ${radicado} · ${diferencias.map(formatear).join('; ')} · aplicado`;
}

/** Escribe la entrada del trámite en `audit_logs` con el `tx` del trámite (si hay algo que contar). */
export async function registrarBitacoraSync(tx: Tx, e: EntradaBitacora & { tramiteId: string }): Promise<void> {
  const detail = detalleBitacora(e);
  if (detail === null) return;
  await tx.insert(auditLogs).values({
    userId: null, userEmail: 'sistema', action: e.esNuevo ? 'create' : 'update',
    resource: 'flito_tramite', resourceId: e.tramiteId, detail,
  });
}

// ── HU #13627: fallos ──────────────────────────────────────────────────────────────────────────────

/** Un código o nombre de clase solo se escribe si es un identificador: nada que pueda ser texto libre. */
const IDENTIFICADOR = /^[A-Za-z0-9_.-]{1,60}$/;
const identificador = (v: unknown): string | null => (typeof v === 'string' && IDENTIFICADOR.test(v) ? v : null);

/**
 * Tipo del error, sin su mensaje (RN-B5): `code` (pg, Node) → `codigo` (errores de FLITO) → `code` de su
 * `cause` (drizzle envuelve el de pg) → nombre de la clase. `desconocido` si nada de eso es un identificador.
 */
export function tipoDeError(e: unknown): string {
  if (e === null || typeof e !== 'object') return 'desconocido';
  const o = e as { code?: unknown; codigo?: unknown; cause?: unknown };
  const causa = o.cause !== null && typeof o.cause === 'object' ? (o.cause as { code?: unknown }).code : undefined;
  return identificador(o.code) ?? identificador(o.codigo) ?? identificador(causa)
    ?? identificador((e as object).constructor?.name) ?? 'desconocido';
}

export interface FalloBitacora {
  fuente: FuenteBitacora;
  radicado: string;
  error: unknown;
}

/** Único formateador de la entrada de fallo (RN-B5). */
export function detalleFalloBitacora({ fuente, radicado, error }: FalloBitacora): string {
  return `[${fuente}] fallo · radicado ${radicado} · error ${tipoDeError(error)} · falló`;
}

/** `%`, `_` y `\` del radicado, literales en el LIKE (el escape por defecto de PostgreSQL es `\`). */
const literalLike = (v: string): string => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Escribe la entrada de fallo con `exec` (el `db`, fuera de la transacción revertida). Nunca lanza (RN-B8).
 * Deduplica contra la última entrada del mismo radicado y fuente (RN-B6).
 */
export async function registrarFalloBitacoraSync(exec: typeof db, f: FalloBitacora): Promise<void> {
  const detail = detalleFalloBitacora(f);
  try {
    const [ultima] = await exec.select({ detail: auditLogs.detail }).from(auditLogs)
      .where(and(
        eq(auditLogs.resource, 'flito_tramite'),
        like(auditLogs.detail, `[${f.fuente}] % · radicado ${literalLike(f.radicado)} · %`),
      ))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(1);
    if (ultima?.detail === detail) return;
    const [tramite] = await exec.select({ id: flitoTramites.id }).from(flitoTramites)
      .where(eq(flitoTramites.idFlit, f.radicado)).limit(1);
    await exec.insert(auditLogs).values({
      userId: null, userEmail: 'sistema', action: 'update',
      resource: 'flito_tramite', resourceId: tramite?.id ?? null, detail,
    });
  } catch (e) {
    log.error({ fuente: f.fuente, radicado: f.radicado, err: tipoDeError(e) }, 'no se pudo registrar el fallo del trámite en la Bitácora');
  }
}
