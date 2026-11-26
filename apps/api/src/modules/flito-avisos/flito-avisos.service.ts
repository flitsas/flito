// FLITO avisos — lectura, «visto» y purga (Épica #14707, ADR-0049 §7, diseño §3.3). La escritura vive en
// `flito-avisos.escritura.ts` (la llama el descarte, dentro de su transacción).
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-AV1  Cada usuario ve SOLO sus avisos (`usuario_id` = el del token). Nunca hay un parámetro de usuario.
// RN-AV2  La lectura trae los NO vistos, del más reciente al más antiguo (desempate por id), como mucho
//         `MAX_AVISOS_USUARIO`, y el conteo total de no vistos. La placa y el radicado se resuelven con JOIN
//         al leer (el aviso solo guarda referencias, Ley 1581): la placa es la del trámite (RN-13585-P) y, si
//         el aviso no tiene trámite, la del vehículo del SOAT.
// RN-AV3  «Visto» marca la lista EXACTA de ids que la pantalla mostró (no «todos»: un retiro que llegó después
//         de pintar el aviso no se oculta). Idempotente: un aviso ya visto conserva su `visto_en`. Un id ajeno o
//         inexistente se ignora en silencio: la respuesta solo cuenta lo propio que cambió, sin decir qué no
//         existe (no es un oráculo de pertenencia).
// RN-AV4  Purga (cron diario): se borran los VISTOS con `visto_en` de hace más de 90 días y los NO VISTOS con
//         `creado_en` de hace más de 180. Frontera inclusiva. Lotes acotados por corrida.
//
// Logs: conteos e ids de usuario; nunca la placa.
import { and, count, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  MAX_AVISOS_USUARIO, type AvisoUsuarioDto, type AvisosUsuarioRespuesta, type MotivoDescarte, type TipoAvisoUsuario,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoAvisosUsuario, flitoTramites } from '../../db/schema.js';

const A = flitoAvisosUsuario;

/** RN-AV4. */
export const DIAS_PURGA_VISTOS = 90;
export const DIAS_PURGA_NO_VISTOS = 180;
/** Filas por sentencia de purga (RN-AV4): el atraso de un primer encendido se drena en pocas corridas. */
export const LOTE_PURGA_AVISOS = 5000;

const DIA_MS = 24 * 60 * 60 * 1000;

/** RN-AV2: la placa del trámite; si el aviso no tiene trámite, la del vehículo del SOAT descartado. */
const PLACA = sql<string | null>`COALESCE(${flitoTramites.plateComplete},
  (SELECT v.plate FROM vehicles v WHERE v.id = ${flitoTramites.vehiculoId}),
  (SELECT v.plate FROM flito_soat s JOIN vehicles v ON v.id = s.vehiculo_id
     WHERE ${A.concepto} = 'soat' AND s.id = ${A.registroId}))`;

const aIso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/** RN-AV1/RN-AV2: los avisos no vistos del usuario y su conteo total. */
export async function listarAvisosNoVistos(usuarioId: number): Promise<AvisosUsuarioRespuesta> {
  const propiosNoVistos = and(eq(A.usuarioId, usuarioId), isNull(A.vistoEn))!;
  const [filas, [total]] = await Promise.all([
    db.select({
      id: A.id, tipo: A.tipo, concepto: A.concepto, motivo: A.motivo, creadoEn: A.creadoEn, vistoEn: A.vistoEn,
      idFlit: flitoTramites.idFlit, placa: PLACA,
    }).from(A)
      .leftJoin(flitoTramites, eq(flitoTramites.id, A.tramiteId))
      .where(propiosNoVistos)
      .orderBy(desc(A.creadoEn), desc(A.id))
      .limit(MAX_AVISOS_USUARIO),
    db.select({ n: count() }).from(A).where(propiosNoVistos),
  ]);
  const avisos: AvisoUsuarioDto[] = filas.map((f) => ({
    id: f.id,
    tipo: f.tipo as TipoAvisoUsuario,
    concepto: f.concepto,
    motivo: f.motivo as MotivoDescarte,
    idFlit: f.idFlit ?? null,
    placa: f.placa ?? null,
    creadoEn: aIso(f.creadoEn)!,
    vistoEn: aIso(f.vistoEn),
  }));
  return { avisos, noVistos: Number(total?.n ?? 0) };
}

/**
 * RN-AV3: marca como vistos los avisos PROPIOS y aún no vistos de la lista. Devuelve cuántos cambiaron. Los ajenos,
 * los inexistentes y los ya vistos no cambian ni se distinguen entre sí.
 */
export async function marcarAvisosVistos(usuarioId: number, ids: readonly string[], ahora: Date = new Date()): Promise<number> {
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return 0;
  const filas = await db.update(A).set({ vistoEn: ahora })
    .where(and(eq(A.usuarioId, usuarioId), inArray(A.id, unicos), isNull(A.vistoEn)))
    .returning({ id: A.id });
  return filas.length;
}

export interface ResultadoPurgaAvisos { vistos: number; noVistos: number }

/** RN-AV4: una corrida de la purga. `ahora` inyectable para el test. */
export async function purgarAvisos(o: { ahora?: Date; lote?: number } = {}): Promise<ResultadoPurgaAvisos> {
  const ahora = o.ahora ?? new Date();
  const lote = o.lote ?? LOTE_PURGA_AVISOS;
  const limiteVistos = new Date(ahora.getTime() - DIAS_PURGA_VISTOS * DIA_MS);
  const limiteNoVistos = new Date(ahora.getTime() - DIAS_PURGA_NO_VISTOS * DIA_MS);

  const idsVistos = db.select({ id: A.id }).from(A)
    .where(and(sql`${A.vistoEn} IS NOT NULL`, lte(A.vistoEn, limiteVistos))).limit(lote);
  const vistos = await db.delete(A).where(inArray(A.id, idsVistos)).returning({ id: A.id });

  const idsNoVistos = db.select({ id: A.id }).from(A)
    .where(and(isNull(A.vistoEn), lte(A.creadoEn, limiteNoVistos))).limit(lote);
  const noVistos = await db.delete(A).where(inArray(A.id, idsNoVistos)).returning({ id: A.id });

  return { vistos: vistos.length, noVistos: noVistos.length };
}
