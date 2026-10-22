// FLITO Impuestos — cola del envío del comprobante de pago a FLIT 2: toma y pausa global (HU #13268,
// Feature #13267, ADR-0020). Diseño `docs/diseno/feature-13267-envio-comprobante-flit2.md` §7.
//
// RN-03 Toma. UNA sola sentencia (CTE `FOR UPDATE OF e SKIP LOCKED` + `UPDATE … RETURNING`), calco de
//   `tomarLote` de Siigo: el candado de fila y el arrendamiento (`tomado_en`) se escriben juntos, así
//   que dos procesos no se llevan la misma fila. Elegibles: `pendiente` con su cita vencida, o
//   `en_espera` con el sondeo de 24 h vencido o despertada por el feed (`sync_version` del trámite
//   mayor que la guardada ∧ `flit_estado` en un estado que admite el adjunto). Solo impuestos
//   `pagado` de trámites `flit2`: uno reversado fuera de `pagado` espera sin gastar intentos.
// RN-05 Pausa global. Se persiste en `system_locks` con la clave `PAUSA_ENVIO_FLIT2_CLAVE` (global
//   entre procesos; sin tabla nueva). La fila vencida NO se borra al vencer: marca que el siguiente
//   ciclo es de sondeo (lote 1). La borra el ciclo de sondeo cuyo desenlace no fue otra pausa.
//
// Fechas en `db.execute`: texto ISO con `::timestamptz` (postgres.js no serializa un `Date` crudo).

import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoImpuestoEnviosFlit2, systemLocks } from '../../db/schema.js';
import { EstadoImpuesto } from '@operaciones/shared-types';
import { estadoDesdeFlit2 } from '../flito-sync/flit2-mapeo.js';
import { ESTADOS_FLIT2_ADMITEN_ADJUNTO } from '../flito-sync/flit2-adjuntos.js';

/** Lote por ciclo de 60 s: ≤ 50/min frente a 120/min por client_id compartidos con el feed y la factura. */
export const LOTE_ENVIO_FLIT2 = 50;
/** Arrendamiento: una fila tomada por un proceso que murió vuelve a la cola pasado este plazo. */
export const ARRENDAMIENTO_ENVIO_FLIT2_MIN = 5;
/**
 * Pausa global ante `pausa` (404 sin cuerpo, 403 insufficient_scope, 400 invalid_tipo). Rango
 * acordado con FLIT 2: 15-30 min (D-7). El 404 sin cuerpo SÍ gasta cuota: una petición cada 20 min.
 */
export const PAUSA_ENVIO_FLIT2_MS = 20 * 60_000;
/** Pausa ante un error del pase sin `hasta` propio (sin acceso, rechazado, no responde…). */
export const PAUSA_PASE_ENVIO_FLIT2_MS = 15 * 60_000;
export const PAUSA_ENVIO_FLIT2_CLAVE = 'flito-impuestos-envio-flit2:pausa';

/**
 * `flit_estado` (grafía capitalizada que escribe el feed) de los estados que admiten el adjunto.
 * Derivado de `estadoDesdeFlit2`, NUNCA escrito a mano: si el feed cambia la grafía, esto la sigue.
 */
export const FLIT_ESTADOS_ADMITEN_ADJUNTO: readonly string[] =
  ESTADOS_FLIT2_ADMITEN_ADJUNTO.map((c) => estadoDesdeFlit2(c).flitEstado);

export interface FilaEnvioTomada {
  id: string;
  impuestoId: string;
  soporteId: string | null;
  intentos: number;
  version: number;
  estado: string;
  enEsperaDesde: Date | null;
  idFlit2: string;
  syncVersion: number | null;
}

function filasDe(r: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
  const rows = (r as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

const fecha = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface EntradaTomaEnvio {
  limite: number;
  tomadoPor: string;
  ahora: Date;
}

/** RN-03. Exportada para el test (se asierta sobre el SQL renderizado: el mock no evalúa el WHERE). */
export function sentenciaTomaEnvios(entrada: EntradaTomaEnvio) {
  const ahora = entrada.ahora.toISOString();
  const corte = new Date(entrada.ahora.getTime() - ARRENDAMIENTO_ENVIO_FLIT2_MIN * 60_000).toISOString();
  const admiten = sql.join(FLIT_ESTADOS_ADMITEN_ADJUNTO.map((e) => sql`${e}`), sql`, `);
  return sql`
    WITH candidatas AS (
      SELECT e.id
        FROM flito_impuesto_envios_flit2 e
        JOIN flito_impuestos i ON i.id = e.impuesto_id
        JOIN flito_tramites t ON t.id = i.tramite_id
       WHERE i.estado = ${EstadoImpuesto.PAGADO}
         AND e.destino = 'flit2' AND t.fuente = 'flit2' AND t.id_flit2 IS NOT NULL
         AND (e.tomado_en IS NULL OR e.tomado_en < ${corte}::timestamptz)
         AND (
              (e.estado = 'pendiente' AND e.proximo_intento_en <= ${ahora}::timestamptz)
           OR (e.estado = 'en_espera' AND (
                   e.proximo_intento_en <= ${ahora}::timestamptz
                OR (t.sync_version > e.sync_version_espera AND t.flit_estado IN (${admiten}))))
         )
       ORDER BY e.proximo_intento_en, e.created_at
       LIMIT ${entrada.limite}
       FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE flito_impuesto_envios_flit2 c
       SET tomado_por = ${entrada.tomadoPor},
           tomado_en = ${ahora}::timestamptz,
           updated_at = ${ahora}::timestamptz
      FROM candidatas k, flito_impuestos i, flito_tramites t
     WHERE c.id = k.id AND i.id = c.impuesto_id AND t.id = i.tramite_id
    RETURNING c.id, c.impuesto_id, c.soporte_id, c.intentos, c.version, c.estado, c.en_espera_desde,
              t.id_flit2, t.sync_version
  `;
}

export async function tomarLoteEnvios(entrada: EntradaTomaEnvio): Promise<FilaEnvioTomada[]> {
  if (entrada.limite <= 0) return [];
  const r = await db.execute(sentenciaTomaEnvios(entrada));
  return filasDe(r).map((f) => ({
    id: String(f.id),
    impuestoId: String(f.impuesto_id),
    soporteId: f.soporte_id === null || f.soporte_id === undefined ? null : String(f.soporte_id),
    intentos: Number(f.intentos) || 0,
    version: Number(f.version) || 1,
    estado: String(f.estado),
    enEsperaDesde: fecha(f.en_espera_desde),
    idFlit2: String(f.id_flit2),
    syncVersion: f.sync_version === null || f.sync_version === undefined ? null : Number(f.sync_version),
  }));
}

/** Suelta una fila tomada sin tocar estado ni intentos (corte de ciclo, plazo, pausa). */
export async function liberarEnvio(fila: Pick<FilaEnvioTomada, 'id' | 'version'>): Promise<void> {
  await db.update(flitoImpuestoEnviosFlit2).set({ tomadoPor: null, tomadoEn: null })
    .where(sql`${flitoImpuestoEnviosFlit2.id} = ${fila.id} AND ${flitoImpuestoEnviosFlit2.version} = ${fila.version}`);
}

export interface PausaEnvio { hasta: Date; codigo: string | null }

/** La marca de pausa, vigente o vencida (vencida = el próximo ciclo es de sondeo). */
export async function leerPausaEnvio(): Promise<PausaEnvio | null> {
  const [f] = await db.select({ hasta: systemLocks.expiresAt, codigo: systemLocks.acquiredBy })
    .from(systemLocks).where(eq(systemLocks.lockName, PAUSA_ENVIO_FLIT2_CLAVE)).limit(1);
  return f ? { hasta: f.hasta, codigo: f.codigo ?? null } : null;
}

/** Pone (o renueva) la pausa global hasta `hasta`. `codigo` sin PII (queda en `acquired_by`). */
export async function pausarEnvio(codigo: string, hasta: Date, ahora: Date): Promise<void> {
  await db.insert(systemLocks).values({
    lockName: PAUSA_ENVIO_FLIT2_CLAVE, acquiredAt: ahora, acquiredBy: codigo.slice(0, 100), expiresAt: hasta,
  }).onConflictDoUpdate({
    target: systemLocks.lockName,
    set: { acquiredAt: ahora, acquiredBy: codigo.slice(0, 100), expiresAt: hasta },
  });
}

export async function quitarPausaEnvio(): Promise<void> {
  await db.delete(systemLocks).where(eq(systemLocks.lockName, PAUSA_ENVIO_FLIT2_CLAVE));
}
