// FLITO sync — estado de la conexión con FLIT 2 (HU #13097, Feature #13060, Épica #12736).
// Contrato: `docs/ux/hu-13098-estado-conexion-flit2.md` § «Contrato propuesto».
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Lectura liviana: la fila vigente de acceso, la fila única de lectura y un COUNT sobre el
//        índice parcial de la 0216. Nunca llama a FLIT 2 (la UI la consulta cada 2 minutos).
// RN-02  Sin configurar (`FLIT2_BASE_URL`/`FLIT2_ENC_KEY` ausentes → 'ambiente'; sin fila activa →
//        'sin_acceso'): `alerta = false` y `problema = null`. 'ambiente' manda sobre 'sin_acceso'
//        porque sin llave ni siquiera se puede guardar el acceso.
// RN-03  Un solo `problema`, con precedencia rechazado > bloqueado > lectura. Un bloqueo cuyo
//        `bloqueado_hasta` ya pasó no es problema. `lectura_concurrente` y `sin_acceso` tampoco.
// RN-04  `alerta` = configurado && (rechazado || bloqueado || ahora − (última exitosa ?? alta del
//        acceso) ≥ 30 min). Una lectura exitosa la apaga porque renueva `ultima_exitosa_en`.
// RN-05  Nada sensible sale: la consulta no selecciona `client_id`, cipher, cursores ni motivos crudos;
//        el motivo de rechazo se normaliza a una lista cerrada y el código de lectura solo pasa si
//        tiene forma de código (snake_case); cualquier otro texto se sustituye por `flit2_respuesta`.
// RN-06  (HU #13188) `automatica`: pulso de la lectura programada de ESTE proceso (`flit2-programa.ts`),
//        siempre presente aunque `configurado=false`. `generadoEn` = el mismo `ahora` de la alerta;
//        con el programa apagado `intervaloMs` y `proximaEn` van en null. Nada sensible: dos booleanos,
//        un entero y dos horas.
// RN-07  (HU #13237) `habilitada` / `motivoDeshabilitada`: el maestro del ambiente (`FLIT2_SYNC_CRON`)
//        gana sobre el interruptor de la pantalla (`flito_sync_interruptor`, fila flit2). Con
//        `habilitada=false`, `alerta=false`: un apagado intencional no es una falla (decisión del hilo
//        sobre el riesgo 1 del diseño). El `problema` se sigue informando tal cual.

import { count, eq, sql } from 'drizzle-orm';
import type {
  Flit2EstadoConexion, Flit2EstadoProblema, Flit2RechazoMotivo,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoSyncFlit2Acceso, flitoSyncFlit2Lectura, flitoTramites } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { leerPrograma, type EstadoPrograma } from './flit2-programa.js';
import { fuenteHabilitada, habilitacionDe } from './flito-sync-interruptor.service.js';

/** Umbral de la alerta (AC5). */
export const UMBRAL_ALERTA_MS = 30 * 60_000;

/** Códigos de lectura que no describen un problema de la conexión (RN-03). */
const CODIGOS_NO_PROBLEMA = new Set(['lectura_concurrente', 'sin_acceso']);

/** Forma de un código RFC 7807 / nuestro: snake_case corto. Todo lo demás es texto crudo (RN-05). */
const FORMA_CODIGO = /^[a-z][a-z0-9_]{0,39}$/;

/** Lo que el servicio necesita de la fila vigente de acceso. */
export interface AccesoParaEstado {
  createdAt: Date;
  rechazadoEn: Date | null;
  rechazoMotivo: string | null;
  bloqueadoHasta: Date | null;
}

/** Lo que el servicio necesita de la fila de lectura. */
export interface LecturaParaEstado {
  ultimaExitosaEn: Date | null;
  ultimoIntentoEn: Date | null;
  ultimoErrorCodigo: string | null;
  atrasada: boolean;
  piiEnmascaradaDesde: Date | null;
}

export interface EntradaEstado {
  ambienteListo: boolean;
  acceso: AccesoParaEstado | null;
  lectura: LecturaParaEstado | null;
  tramitesEnmascarados: number;
  programa: EstadoPrograma;
  /** HU #13237: `FLIT2_SYNC_CRON`. Ausente = true (los llamadores previos a la HU no lo pasan). */
  maestro?: boolean;
  /** HU #13237: interruptor de FLIT 2 encendido. Ausente = true. */
  interruptorFlit2?: boolean;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** `rechazo_motivo` de la 0214 → lista cerrada de la UI. */
export function normalizarMotivoRechazo(motivo: string | null): Flit2RechazoMotivo {
  if (motivo === 'invalid_client') return 'credenciales';
  if (motivo === 'secret_rotation_required') return 'cambio_clave';
  return 'otro';
}

/** Solo códigos con forma de código; el texto crudo nunca sale (RN-05). */
export function codigoPublico(codigo: string): string {
  return FORMA_CODIGO.test(codigo) ? codigo : 'flit2_respuesta';
}

function problemaDe(
  acceso: AccesoParaEstado, lectura: LecturaParaEstado | null, ahora: Date,
): Flit2EstadoProblema | null {
  if (acceso.rechazadoEn) {
    return {
      tipo: 'rechazado', codigo: null, motivo: normalizarMotivoRechazo(acceso.rechazoMotivo),
      en: iso(acceso.rechazadoEn), hasta: null,
    };
  }
  if (acceso.bloqueadoHasta && acceso.bloqueadoHasta.getTime() > ahora.getTime()) {
    // La 0214 no guarda el inicio del bloqueo: la hora del hecho es el último intento de lectura, que la
    // lectura anota al recibir el 423/429 del pase (RN-23 de flit2-lectura.service.ts, Bug #13198).
    return {
      tipo: 'bloqueado', codigo: null, motivo: null,
      en: iso(lectura?.ultimoIntentoEn), hasta: iso(acceso.bloqueadoHasta),
    };
  }
  const codigo = lectura?.ultimoErrorCodigo ?? null;
  if (codigo && !CODIGOS_NO_PROBLEMA.has(codigo)) {
    return { tipo: 'lectura', codigo: codigoPublico(codigo), motivo: null, en: iso(lectura?.ultimoIntentoEn), hasta: null };
  }
  return null;
}

/** Composición pura (reloj inyectado): toda la lógica de la HU, sin base. */
export function componerEstado(e: EntradaEstado, ahora: Date): Flit2EstadoConexion {
  const motivoSinConfigurar = !e.ambienteListo ? 'ambiente' : e.acceso ? null : 'sin_acceso';
  const configurado = motivoSinConfigurar === null;
  const l = e.lectura;
  const habilitacion = habilitacionDe(e.maestro ?? true, e.interruptorFlit2 ?? true);

  let problema: Flit2EstadoProblema | null = null;
  let alerta = false;
  if (configurado && e.acceso) {
    problema = problemaDe(e.acceso, l, ahora);
    const referencia = l?.ultimaExitosaEn ?? e.acceso.createdAt;
    const sinLecturaDemasiado = ahora.getTime() - referencia.getTime() >= UMBRAL_ALERTA_MS;
    alerta = sinLecturaDemasiado || problema?.tipo === 'rechazado' || problema?.tipo === 'bloqueado';
  }
  // RN-07: apagada a propósito no es una falla.
  if (!habilitacion.habilitada) alerta = false;

  return {
    configurado,
    motivoSinConfigurar,
    ultimaExitosaEn: iso(l?.ultimaExitosaEn),
    ultimoIntentoEn: iso(l?.ultimoIntentoEn),
    atrasada: l?.atrasada ?? false,
    alerta,
    problema,
    piiEnmascarada: { tramites: e.tramitesEnmascarados, desde: iso(l?.piiEnmascaradaDesde) },
    automatica: {
      activa: e.programa.activa,
      intervaloMs: e.programa.activa ? e.programa.intervaloMs : null,
      proximaEn: e.programa.activa ? iso(e.programa.proximaEn) : null,
      enCurso: e.programa.enCurso,
      generadoEn: ahora.toISOString(),
    },
    ...habilitacion,
  };
}

/** `GET /estado`: dos filas únicas y un COUNT (RN-01). Proyecciones explícitas (RN-05). */
export async function obtenerEstadoConexion(reloj: () => Date = () => new Date()): Promise<Flit2EstadoConexion> {
  const [accesos, lecturas, conteo, interruptorFlit2] = await Promise.all([
    db.select({
      createdAt: flitoSyncFlit2Acceso.createdAt,
      rechazadoEn: flitoSyncFlit2Acceso.rechazadoEn,
      rechazoMotivo: flitoSyncFlit2Acceso.rechazoMotivo,
      bloqueadoHasta: flitoSyncFlit2Acceso.bloqueadoHasta,
    }).from(flitoSyncFlit2Acceso).where(eq(flitoSyncFlit2Acceso.activo, true)).limit(1),
    db.select({
      ultimaExitosaEn: flitoSyncFlit2Lectura.ultimaExitosaEn,
      ultimoIntentoEn: flitoSyncFlit2Lectura.ultimoIntentoEn,
      ultimoErrorCodigo: flitoSyncFlit2Lectura.ultimoErrorCodigo,
      atrasada: flitoSyncFlit2Lectura.atrasada,
      piiEnmascaradaDesde: flitoSyncFlit2Lectura.piiEnmascaradaDesde,
    }).from(flitoSyncFlit2Lectura).where(eq(flitoSyncFlit2Lectura.id, 1)).limit(1),
    // `WHERE flit2_pii_enmascarada` a secas: coincide con el predicado del índice parcial de la 0216.
    db.select({ n: count() }).from(flitoTramites).where(sql`${flitoTramites.flit2PiiEnmascarada}`),
    fuenteHabilitada('flit2'),
  ]);

  return componerEstado({
    ambienteListo: Boolean(env.FLIT2_BASE_URL && env.FLIT2_ENC_KEY),
    acceso: accesos[0] ?? null,
    lectura: lecturas[0] ?? null,
    tramitesEnmascarados: Number(conteo[0]?.n ?? 0),
    programa: leerPrograma(),
    maestro: Boolean(env.FLIT2_SYNC_CRON),
    interruptorFlit2,
  }, reloj());
}
