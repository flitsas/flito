// Épica #14707 (ADR-0049 §3, D3/D6/D9) — el SOAT de un trámite muerto M. El SOAT es del VIN, no del trámite: N
// trámites pueden compartirlo (`flito_tramites.soat_id`). S = el SOAT de M; V = los OTROS trámites VIVOS ligados a S,
// en orden (created_at, id) (índice `idx_flito_tramites_soat_orden`).
//
//   | S del canal Cliente (`origen='cliente'`)       | No se toca: no lo originó ningún trámite (decisión cerrada 4).        |
//   | S ya `descartado`                              | Nada (idempotente).                                                    |
//   | S abierto y V no vacío (D3b)                   | Sigue vivo. D9: compañía/organismo ← los del vivo más antiguo, si      |
//   |                                                | difieren (cada uno solo si el del vivo no es NULL), con auditoría.     |
//   | S abierto y V vacío (D3c)                      | `descartado`; si estaba `solicitado`, aviso a `enviado_por_id` (D6).   |
//   | S `pagado` originado por M (D3a)               | `descartado`, SALVO que un vivo de V ya lo consumiera (`entregado`/    |
//   |                                                | `aprobado` o `fecha_aprobacion`): se conserva y se audita (decisión    |
//   |                                                | cerrada 1). Los vivos se desligan (`soat_id = NULL`, con historial) y  |
//   |                                                | arrancan SOAT nuevo EN ESTA tx si cumplen las condiciones (FLIT 2 es   |
//   |                                                | incremental: no volvería a leer un trámite que no cambió).             |
//   | S `pagado` originado por otro o sin originador | No se toca.                                                            |
//
// El originador es la columna `tramite_origen_id` (0318), no «el ligado más antiguo»: esa regla cambia en cuanto D3a
// desliga vivos y no separa el canal Cliente. El `soat_id` de M se conserva (historia).
// Logs y auditoría: radicado e ids, nunca VIN ni placa.
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { EstadoSoat, EstadoTramiteFlito } from '@operaciones/shared-types';
import { flitoSoat, flitoTramiteHistorial, flitoTramites } from '../../db/schema.js';
import { registrarCambio } from '../../shared/historial/estado-historial.js';
import { TRAMITE_VIVO } from '../../shared/tramite-vigente.js';
import { registrarAvisoSolicitudRetirada } from '../flito-avisos/flito-avisos.escritura.js';
import { auditSistema, motivoHistorial, type ContextoDescarte, type FilaTramite, type Tx } from './descarte-comun.js';

export interface ResultadoDescarteSoat {
  /** El SOAT que se descartó en esta llamada (para D11), o null. */
  soatDescartadoId: string | null;
  /** Vivos desligados por D3a (sus comprobantes de SOAT se liberan siempre). */
  vivosDesligados: string[];
}

const NADA: ResultadoDescarteSoat = { soatDescartadoId: null, vivosDesligados: [] };

/** ¿El vivo ya consumió el SOAT pagado? (decisión cerrada 1). */
export const consumioSoat = (v: Pick<FilaTramite, 'estado' | 'fechaAprobacion'>): boolean =>
  v.estado === EstadoTramiteFlito.ENTREGADO || v.estado === EstadoTramiteFlito.APROBADO || v.fechaAprobacion !== null;

type SoatBloqueado = Pick<typeof flitoSoat.$inferSelect,
  'id' | 'vin' | 'estado' | 'origen' | 'tramiteOrigenId' | 'enviadoPorId' | 'companiaId' | 'organismoCodigo'>;

async function marcarDescartado(tx: Tx, s: SoatBloqueado, c: ContextoDescarte): Promise<void> {
  const ahora = new Date();
  await tx.update(flitoSoat).set({
    estado: EstadoSoat.DESCARTADO, descartadoEn: ahora, motivoDescarte: c.motivo, descartadoPorTramiteId: c.tramite.id, updatedAt: ahora,
  }).where(eq(flitoSoat.id, s.id));
  await registrarCambio(tx, {
    concepto: 'soat', registroId: s.id, estadoAnterior: s.estado, estadoNuevo: EstadoSoat.DESCARTADO,
    motivo: motivoHistorial(c.tramite.idFlit, c.motivo, 'el SOAT'), origen: 'sistema',
  });
  c.r.soats += 1;
  if (c.o.avisar && s.estado === EstadoSoat.SOLICITADO && s.enviadoPorId !== null) {
    const creado = await registrarAvisoSolicitudRetirada(tx, {
      usuarioId: s.enviadoPorId, concepto: 'soat', registroId: s.id, tramiteId: c.tramite.id, motivo: c.motivo,
    });
    if (creado) c.r.avisos += 1;
  }
}

/** D9: el SOAT abierto compartido toma compañía/organismo del vivo más antiguo, si difieren. */
async function heredar(tx: Tx, s: SoatBloqueado, vivo: FilaTramite, c: ContextoDescarte): Promise<void> {
  const compania = vivo.companiaId !== null && vivo.companiaId !== s.companiaId ? vivo.companiaId : null;
  const organismo = vivo.organismoCodigo !== null && vivo.organismoCodigo !== s.organismoCodigo ? vivo.organismoCodigo : null;
  if (compania === null && organismo === null) return;
  await tx.update(flitoSoat).set({
    ...(compania !== null ? { companiaId: compania } : {}),
    ...(organismo !== null ? { organismoCodigo: organismo } : {}),
    updatedAt: new Date(),
  }).where(eq(flitoSoat.id, s.id));
  c.r.soatsHeredados += 1;
  await auditSistema(tx, {
    resource: 'flito_soat', resourceId: s.id,
    detail: `D9 (Épica 14707): el trámite ${c.tramite.idFlit} ${c.motivo} en FLIT; el SOAT sigue con el trámite vivo ${vivo.idFlit}`
      + ` y toma su ${[compania !== null ? 'compañía' : null, organismo !== null ? 'organismo' : null].filter(Boolean).join(' y ')}.`,
  });
}

/** D3a: desliga los vivos del SOAT pagado descartado (con historial) y los rearranca si cumplen las condiciones. */
async function desligarYRearrancar(tx: Tx, s: SoatBloqueado, vivos: FilaTramite[], c: ContextoDescarte): Promise<string[]> {
  if (vivos.length === 0) return [];
  const ids = vivos.map((v) => v.id);
  await tx.update(flitoTramites).set({ soatId: null, updatedAt: new Date() }).where(inArray(flitoTramites.id, ids));
  await tx.insert(flitoTramiteHistorial).values(ids.map((tramiteId) => ({
    tramiteId, campo: 'soat_id', valorAnterior: s.id, valorNuevo: null, origen: 'sistema', usuarioId: null,
  })));
  for (const v of vivos) {
    if (await c.o.rearrancar(tx, { ...v, soatId: null }, s.vin)) c.r.vivosRearrancados += 1;
  }
  return ids;
}

export async function descartarSoat(tx: Tx, c: ContextoDescarte): Promise<ResultadoDescarteSoat> {
  if (!c.tramite.soatId) return NADA;
  const [s] = await tx.select({
    id: flitoSoat.id, vin: flitoSoat.vin, estado: flitoSoat.estado, origen: flitoSoat.origen, tramiteOrigenId: flitoSoat.tramiteOrigenId,
    enviadoPorId: flitoSoat.enviadoPorId, companiaId: flitoSoat.companiaId, organismoCodigo: flitoSoat.organismoCodigo,
  }).from(flitoSoat).where(eq(flitoSoat.id, c.tramite.soatId)).for('update').limit(1);
  if (!s || s.origen === 'cliente' || s.estado === EstadoSoat.DESCARTADO) return NADA;

  const vivos = await tx.select().from(flitoTramites)
    .where(and(eq(flitoTramites.soatId, s.id), ne(flitoTramites.id, c.tramite.id), TRAMITE_VIVO()))
    .orderBy(asc(flitoTramites.createdAt), asc(flitoTramites.id));

  if (s.estado !== EstadoSoat.PAGADO) {
    if (vivos.length > 0) { await heredar(tx, s, vivos[0], c); return NADA; } // D3b + D9
    await marcarDescartado(tx, s, c); // D3c
    return { soatDescartadoId: s.id, vivosDesligados: [] };
  }

  if (s.tramiteOrigenId !== c.tramite.id) return NADA; // pagado de otro origen: no se toca
  const consumidor = vivos.find(consumioSoat);
  if (consumidor) {
    c.r.soatsConservados += 1;
    await auditSistema(tx, {
      resource: 'flito_soat', resourceId: s.id,
      detail: `D3a (Épica 14707): el trámite ${c.tramite.idFlit} ${c.motivo} en FLIT originó este SOAT pagado; se conserva porque el trámite vivo ${consumidor.idFlit} ya lo consumió.`,
    });
    return NADA;
  }
  await marcarDescartado(tx, s, c);
  const vivosDesligados = await desligarYRearrancar(tx, s, vivos, c);
  return { soatDescartadoId: s.id, vivosDesligados };
}
