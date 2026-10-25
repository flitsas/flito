// FLITO — backfill de los comprobantes de pago aplicados ANTES del corte (HU #13910, HU-E, Feature #13887,
// ADR-0029 D12 / Q4).
//
// El gancho `descontarComprobante` (HU #13902 / #13909) solo descuenta lo aplicado desde
// `FLITO_BOLSAS_CORTE_COMPROBANTES`. Lo aplicado antes y liquidado después no lo descontaría nadie: este
// script cierra ese hueco con el MISMO gancho (`{ backfill: true }`), así que usa las mismas llaves
// (`salida:…` en compañía, `consumo:…` en tránsito), las mismas omisiones (`cubierto_por_liquidacion`,
// `cubierto_por_conciliacion`, `sin_bolsa`, `inactiva`, …) y es idempotente por llave.
//
// Reglas:
//   RN-B1 Sin corte configurado termina con error ANTES de leer o escribir nada (AC5).
//   RN-B2 Candidatos: `flito_comprobantes` en `aplicado`, `es_pago`, con trámite y concepto, cuyo día en
//         Colombia de `aplicado_en` es < corte. Los dos alcances (compañía y tránsito) los decide el gancho.
//   RN-B3 Una transacción POR comprobante, con el orden de locks del gancho (RN-C9): comprobante → trámite
//         → bolsa compañía → bolsa tránsito. Un fallo deshace solo ese comprobante (ninguno queda a medias)
//         y detiene el proceso; al volver a ejecutar sigue con los pendientes sin duplicar (AC7).
//   RN-B4 Movimiento fechado el día de ejecución; el periodo es el imputable vigente (`periodoImputable`:
//         si el mes está cerrado va al primero abierto). Autor = `--usuario` (registrado_por) y observación
//         `NOTA_BACKFILL`.
//   RN-B5 Simulación por defecto: el MISMO camino dentro de una tx que se deshace, así el reporte de la
//         simulación es exactamente lo que `--apply` escribiría. `--apply` hace commit.
//   RN-B6 Ley 1581: el reporte y los logs llevan solo ids (comprobante, bolsa, movimiento), concepto,
//         valor y motivo. Nunca placa, VIN, NIT ni nombres (ni el de la bolsa ni el del usuario).
//
//   npx tsx src/scripts/flito-bolsas-backfill-comprobantes.ts --usuario=<id>           → simulación
//   npx tsx src/scripts/flito-bolsas-backfill-comprobantes.ts --usuario=<id> --apply   → aplica
//
// Runbook: docs/arquitectura/runbook-hu-13910-backfill-corte.md.

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { EstadoComprobante, type ConceptoCosto, type DescuentoBolsaDto } from '@operaciones/shared-types';
import { db } from '../db/client.js';
import { flitoBolsasUnicasMovimientos, flitoComprobantes, flitoTramites, users } from '../db/schema.js';
import { loggerFor } from '../shared/logger.js';
import { TZ_COLOMBIA } from '../shared/utils/fecha-rango.js';
import { corteVigente, descontarComprobante } from '../modules/flito-bolsas/flito-bolsas.descuento.js';
import type { CtxUsuario, Tx } from '../modules/flito-bolsas/flito-bolsas.libro.js';

const log = loggerFor('flito-bolsas-backfill-comprobantes');

export const NOTA_BACKFILL = 'Backfill corte comprobantes (ADR-0029)';

/** RN-B1: el mensaje que ve quien lo ejecuta sin corte. */
export class SinCorteError extends Error {
  constructor() {
    super('Falta la fecha de corte: configure FLITO_BOLSAS_CORTE_COMPROBANTES (AAAA-MM-DD) antes de ejecutar el backfill');
  }
}

export class UsuarioInvalidoError extends Error {
  constructor() {
    super('Falta --usuario=<id> con el id de un usuario existente (queda como registrado_por de los movimientos)');
  }
}

/** Una línea del reporte: un alcance de un comprobante. Solo ids, concepto, valor y motivo (RN-B6). */
export interface LineaReporte {
  comprobanteId: string;
  alcance: string;
  bolsaId: string | null;
  concepto: string;
  valor: number;
  /** `descontado` = movimiento nuevo (o que se crearía en simulación); `ya_descontado` = existía. */
  resultado: 'descontado' | 'ya_descontado' | 'omitido';
  motivo: string | null;
  movimientoId: string | null;
  /** El saldo quedó en negativo (D11): no bloquea, se informa. */
  negativo: boolean;
}

export interface ReporteBackfill {
  corte: string;
  apply: boolean;
  comprobantes: number;
  lineas: LineaReporte[];
}

type Descontar = typeof descontarComprobante;

export interface OpcionesBackfill {
  apply: boolean;
  usuarioId: number;
  /** Acota el recorrido a estos comprobantes (re-ejecución dirigida y pruebas). Sin él, todos los candidatos. */
  comprobanteIds?: string[];
  /** Inyectable para las pruebas (AC7); por defecto el gancho real. */
  descontar?: Descontar;
}

/** Señal interna para deshacer la tx de la simulación (RN-B5). */
class Simulacion extends Error {
  constructor() { super('simulación: se deshace'); }
}

/** RN-B2: candidatos, en orden de aplicación (determinista para poder retomar). */
async function candidatos(corte: string, ids?: string[]): Promise<string[]> {
  const C = flitoComprobantes;
  const filas = await db.select({ id: C.id }).from(C).where(and(
    eq(C.estado, EstadoComprobante.APLICADO),
    eq(C.esPago, true),
    isNotNull(C.tramiteId),
    isNotNull(C.concepto),
    isNotNull(C.aplicadoEn),
    sql`(${C.aplicadoEn} AT TIME ZONE ${TZ_COLOMBIA})::date < ${corte}::date`,
    ids ? inArray(C.id, ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000']) : undefined,
  )).orderBy(asc(C.aplicadoEn), asc(C.id));
  return filas.map((f) => f.id);
}

async function ctxDe(usuarioId: number): Promise<CtxUsuario> {
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) throw new UsuarioInvalidoError();
  const [u] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, usuarioId)).limit(1);
  if (!u) throw new UsuarioInvalidoError();
  return { userId: u.id, nombre: u.username };
}

interface Procesado {
  concepto: string;
  valor: number;
  resultado: DescuentoBolsaDto | null;
  previos: Set<string>;
  /** El comprobante dejó de ser candidato entre la lectura y el lock. */
  descartado: boolean;
}

/** RN-B3: un comprobante, en su tx, con locks comprobante → trámite antes del gancho. */
async function procesar(id: string, corte: string, ctx: CtxUsuario, o: OpcionesBackfill): Promise<Procesado> {
  const descontar = o.descontar ?? descontarComprobante;
  let concepto = '';
  let valor = 0;
  const ejecutar = async (tx: Tx): Promise<{ resultado: DescuentoBolsaDto | null; previos: Set<string>; descartado: boolean }> => {
    const C = flitoComprobantes;
    const [c] = await tx.select({
      id: C.id, tramiteId: C.tramiteId, concepto: C.concepto, esPago: C.esPago, valor: C.valor, estado: C.estado,
      aplicadoEn: C.aplicadoEn,
      dia: sql<string>`(${C.aplicadoEn} AT TIME ZONE ${TZ_COLOMBIA})::date::text`,
    }).from(C).where(eq(C.id, id)).for('update').limit(1);
    concepto = c?.concepto ?? '';
    valor = Number(c?.valor ?? 0);
    if (!c || c.estado !== EstadoComprobante.APLICADO || !c.esPago || !c.tramiteId || !c.concepto || !c.aplicadoEn || c.dia >= corte) {
      return { resultado: null, previos: new Set(), descartado: true };
    }
    await tx.select({ id: flitoTramites.id }).from(flitoTramites).where(eq(flitoTramites.id, c.tramiteId)).for('update').limit(1);
    const previos = new Set((await tx.select({ id: flitoBolsasUnicasMovimientos.id }).from(flitoBolsasUnicasMovimientos)
      .where(eq(flitoBolsasUnicasMovimientos.comprobanteId, id))).map((m) => m.id));
    const resultado = await descontar(tx, {
      comprobanteId: c.id, tramiteId: c.tramiteId, concepto: c.concepto as ConceptoCosto, esPago: true,
      valor: c.valor, aplicadoEn: c.aplicadoEn,
    }, ctx, { backfill: true, observacion: NOTA_BACKFILL });
    return { resultado, previos, descartado: false };
  };

  if (o.apply) return { concepto, valor, ...await db.transaction(ejecutar) };
  // RN-B5: el mismo camino, deshecho al final.
  let r = undefined as Awaited<ReturnType<typeof ejecutar>> | undefined; // asignada dentro del callback
  try {
    await db.transaction(async (tx) => { r = await ejecutar(tx); throw new Simulacion(); });
  } catch (e) {
    if (!(e instanceof Simulacion) || !r) throw e;
  }
  return { concepto, valor, ...r! };
}

function lineasDe(id: string, p: Procesado): LineaReporte[] {
  const base = { comprobanteId: id, concepto: p.concepto, valor: p.valor };
  if (p.descartado) return [{ ...base, alcance: '-', bolsaId: null, resultado: 'omitido', motivo: 'ya_no_es_candidato', movimientoId: null, negativo: false }];
  const r = p.resultado;
  if (!r) throw new SinCorteError(); // el corte se apagó a mitad de ejecución
  if (r.movimientos.length === 0 && r.omitidos.length === 0) {
    return [{ ...base, alcance: '-', bolsaId: null, resultado: 'omitido', motivo: 'sin_valor', movimientoId: null, negativo: false }];
  }
  return [
    ...r.movimientos.map((m): LineaReporte => ({
      ...base, alcance: m.alcance, bolsaId: m.bolsaId, valor: m.valor,
      resultado: p.previos.has(m.movimientoId) ? 'ya_descontado' : 'descontado', motivo: null,
      movimientoId: m.movimientoId, negativo: m.saldoResultante < 0,
    })),
    ...r.omitidos.map((om): LineaReporte => ({
      ...base, alcance: om.alcance, bolsaId: null, resultado: 'omitido', motivo: om.motivo, movimientoId: null, negativo: false,
    })),
  ];
}

/**
 * Recorre los candidatos y devuelve el reporte. Sin `apply` no escribe (RN-B5). Un error en un comprobante
 * se propaga tras deshacer SOLO ese comprobante; los anteriores ya quedaron con su commit (RN-B3).
 */
export async function ejecutarBackfillComprobantes(o: OpcionesBackfill): Promise<ReporteBackfill> {
  const corte = corteVigente();
  if (corte === null) throw new SinCorteError(); // RN-B1: antes de cualquier lectura
  const ctx = await ctxDe(o.usuarioId);
  const ids = await candidatos(corte, o.comprobanteIds);
  log.info({ corte, apply: o.apply, candidatos: ids.length }, 'Backfill de comprobantes antes del corte: inicio');
  const reporte: ReporteBackfill = { corte, apply: o.apply, comprobantes: ids.length, lineas: [] };
  for (const id of ids) {
    let p: Procesado;
    try {
      p = await procesar(id, corte, ctx, o);
    } catch (e) {
      log.error({ comprobanteId: id, err: e instanceof Error ? e.message : String(e) }, 'Backfill de comprobantes: falló un comprobante (deshecho)');
      throw e;
    }
    const lineas = lineasDe(id, p);
    reporte.lineas.push(...lineas);
    for (const l of lineas) {
      if (l.resultado === 'descontado') log.info({ comprobanteId: id, bolsaId: l.bolsaId, movimientoId: o.apply ? l.movimientoId : null, apply: o.apply }, 'Backfill: descuento');
    }
  }
  log.info({ corte, apply: o.apply, lineas: reporte.lineas.length }, 'Backfill de comprobantes antes del corte: fin');
  return reporte;
}

const pesos = (n: number): string => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });

/** El texto del reporte (RN-B6: solo ids, concepto, valor y motivo). */
export function formatearReporte(r: ReporteBackfill): string[] {
  const salida: string[] = [];
  const nuevos = r.lineas.filter((l) => l.resultado === 'descontado');
  salida.push(`Backfill de comprobantes antes del corte ${r.corte} — ${r.apply ? 'APLICANDO' : 'SIMULACIÓN (no escribe)'}`);
  salida.push('─'.repeat(78));
  salida.push(`Comprobantes candidatos: ${r.comprobantes}. Descuentos ${r.apply ? 'asentados' : 'que se asentarían'}: ${nuevos.length} por ${pesos(nuevos.reduce((a, l) => a + l.valor, 0))}`);
  for (const l of r.lineas) {
    const bolsa = l.bolsaId ?? '-';
    const detalle = l.resultado === 'omitido' ? `omitido: ${l.motivo}` : `${l.resultado}${l.negativo ? ' (saldo negativo)' : ''}`;
    salida.push(`  · comprobante ${l.comprobanteId} | ${l.alcance} | bolsa ${bolsa} | ${l.concepto} | ${pesos(l.valor)} | ${detalle}`);
  }
  if (r.lineas.length === 0) salida.push('Nada por descontar.');
  return salida;
}

function argUsuario(argv: string[]): number {
  const v = argv.find((a) => a.startsWith('--usuario='))?.split('=')[1];
  return v ? Number(v) : Number.NaN;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const reporte = await ejecutarBackfillComprobantes({ apply, usuarioId: argUsuario(process.argv) });
  for (const linea of formatearReporte(reporte)) console.log(linea);
  console.log(apply ? '\nBackfill aplicado.\n' : '\nSimulación. Revísela y vuelva a ejecutar con --apply para escribir.\n');
}

// Solo como script: importarlo desde un test no debe disparar el backfill ni `process.exit`.
if (process.argv[1]?.includes('flito-bolsas-backfill-comprobantes')) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
