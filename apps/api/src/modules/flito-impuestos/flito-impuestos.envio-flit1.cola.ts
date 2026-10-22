// FLITO Impuestos — cola del envío del comprobante de pago a FLIT 1: toma y pausa global (HU #13310,
// Feature #13309, ADR-0021). Diseño `docs/diseno/feature-13309-envio-comprobante-flit1.md` §7.3.
// Copia deliberada de la cola FLIT 2 (≈ 25 líneas de pausa) en lugar de parametrizarla: AC8 pide no
// tocar el comportamiento de FLIT 2, y cada destino se pausa sin frenar al otro.
//
// RN-F1-03 Toma. UNA sola sentencia (CTE `FOR UPDATE OF e SKIP LOCKED` + `UPDATE … RETURNING`). Elegibles:
//   `destino = 'flit1'`, `pendiente` con su cita vencida, impuesto `pagado` de un trámite `fuente = 'flit'`.
//   Sin rama `en_espera` (el CHECK de la 0221 la prohíbe a FLIT 1). `id_flit` NO se exige en la toma: un
//   id nulo o inválido debe acabar en `error` (AC2), no esperar para siempre.
// RN-F1-05 Pausa global propia en `system_locks` (`PAUSA_ENVIO_FLIT1_CLAVE`): vencida = el siguiente ciclo
//   es de sondeo (lote 1); la borra el sondeo cuyo desenlace no fue otra pausa.
//
// Fechas en `db.execute`: texto ISO con `::timestamptz` (postgres.js no serializa un `Date` crudo).

import { eq, sql } from 'drizzle-orm';
import { EstadoImpuesto } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { systemLocks } from '../../db/schema.js';

/** Lote por ciclo de 60 s (el paso 2 sube hasta 20 MB: lote menor que el de FLIT 2). */
export const LOTE_ENVIO_FLIT1 = 20;
/** Arrendamiento: una fila tomada por un proceso que murió vuelve a la cola pasado este plazo. */
export const ARRENDAMIENTO_ENVIO_FLIT1_MIN = 5;
/** Pausa global de configuración (A-1/A-2): una petición de sondeo cada 20 min (calco de ADR-0020 §4). */
export const PAUSA_ENVIO_FLIT1_MS = 20 * 60_000;
export const PAUSA_ENVIO_FLIT1_CLAVE = 'flito-impuestos-envio-flit1:pausa';

export interface FilaEnvioFlit1Tomada {
  id: string;
  impuestoId: string;
  soporteId: string | null;
  intentos: number;
  version: number;
  estado: string;
  idFlit: string | null;
  archivoFlit1Id: string | null;
}

function filasDe(r: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(r)) return r as Array<Record<string, unknown>>;
  const rows = (r as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

const textoONull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export interface EntradaTomaEnvioFlit1 { limite: number; tomadoPor: string; ahora: Date }

/** RN-F1-03. Exportada para el test (se asierta sobre el SQL renderizado: el mock no evalúa el WHERE). */
export function sentenciaTomaEnviosFlit1(entrada: EntradaTomaEnvioFlit1) {
  const ahora = entrada.ahora.toISOString();
  const corte = new Date(entrada.ahora.getTime() - ARRENDAMIENTO_ENVIO_FLIT1_MIN * 60_000).toISOString();
  return sql`
    WITH candidatas AS (
      SELECT e.id
        FROM flito_impuesto_envios_flit2 e
        JOIN flito_impuestos i ON i.id = e.impuesto_id
        JOIN flito_tramites t ON t.id = i.tramite_id
       WHERE i.estado = ${EstadoImpuesto.PAGADO}
         AND e.destino = 'flit1' AND t.fuente = 'flit'
         AND (e.tomado_en IS NULL OR e.tomado_en < ${corte}::timestamptz)
         AND e.estado = 'pendiente' AND e.proximo_intento_en <= ${ahora}::timestamptz
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
    RETURNING c.id, c.impuesto_id, c.soporte_id, c.intentos, c.version, c.estado, c.archivo_flit1_id, t.id_flit
  `;
}

export async function tomarLoteEnviosFlit1(entrada: EntradaTomaEnvioFlit1): Promise<FilaEnvioFlit1Tomada[]> {
  if (entrada.limite <= 0) return [];
  const r = await db.execute(sentenciaTomaEnviosFlit1(entrada));
  return filasDe(r).map((f) => ({
    id: String(f.id),
    impuestoId: String(f.impuesto_id),
    soporteId: textoONull(f.soporte_id),
    intentos: Number(f.intentos) || 0,
    version: Number(f.version) || 1,
    estado: String(f.estado),
    idFlit: textoONull(f.id_flit),
    archivoFlit1Id: textoONull(f.archivo_flit1_id),
  }));
}

export interface PausaEnvioFlit1 { hasta: Date; codigo: string | null }

export async function leerPausaEnvioFlit1(): Promise<PausaEnvioFlit1 | null> {
  const [f] = await db.select({ hasta: systemLocks.expiresAt, codigo: systemLocks.acquiredBy })
    .from(systemLocks).where(eq(systemLocks.lockName, PAUSA_ENVIO_FLIT1_CLAVE)).limit(1);
  return f ? { hasta: f.hasta, codigo: f.codigo ?? null } : null;
}

/** Pone (o renueva) la pausa global hasta `hasta`. `codigo` sin PII ni URL (queda en `acquired_by`). */
export async function pausarEnvioFlit1(codigo: string, hasta: Date, ahora: Date): Promise<void> {
  await db.insert(systemLocks).values({
    lockName: PAUSA_ENVIO_FLIT1_CLAVE, acquiredAt: ahora, acquiredBy: codigo.slice(0, 100), expiresAt: hasta,
  }).onConflictDoUpdate({
    target: systemLocks.lockName,
    set: { acquiredAt: ahora, acquiredBy: codigo.slice(0, 100), expiresAt: hasta },
  });
}

export async function quitarPausaEnvioFlit1(): Promise<void> {
  await db.delete(systemLocks).where(eq(systemLocks.lockName, PAUSA_ENVIO_FLIT1_CLAVE));
}
