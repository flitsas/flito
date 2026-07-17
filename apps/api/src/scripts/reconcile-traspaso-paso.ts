/**
 * TRAM-TRASPASO-P0 — reconcilia columna `paso` en traspasos legacy vs gates P0.
 *
 * Idempotente: solo actualiza filas donde paso persistido ≠ paso canónico.
 *
 * Uso (desde apps/api, requiere DATABASE_URL):
 *   npm run traspaso:reconcile-paso              # dry-run (default)
 *   npm run traspaso:reconcile-paso -- --execute
 *   npm run traspaso:reconcile-paso -- --id=21
 *   npm run traspaso:reconcile-paso -- --limit=50
 */

import { and, desc, eq } from 'drizzle-orm';
import {
  hintReconciliacionPasoTraspaso,
  reconciliarPasoTraspasoBD,
  type TraspasoPreflightSnapshot,
} from '@operaciones/shared-types';
import { db } from '../db/client.js';
import { tramitePreflight, tramitesDigitales } from '../db/schema.js';

const EXECUTE = process.argv.includes('--execute');
const idArg = process.argv.find((a) => a.startsWith('--id='));
const SINGLE_ID = idArg ? Number(idArg.split('=')[1]) : null;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 500) : 500;

interface Row {
  id: number;
  paso: number;
  numeroRadicado: string | null;
  estado: string;
  vehiculo: unknown;
  comprador: unknown;
}

interface ChangeRow {
  id: number;
  radicado: string | null;
  estado: string;
  pasoActual: number;
  pasoNuevo: number;
  hint: string;
}

async function latestPreflight(tramiteId: number): Promise<TraspasoPreflightSnapshot | null> {
  const [row] = await db.select({
    overall: tramitePreflight.overallStatus,
    checks: tramitePreflight.checks,
  }).from(tramitePreflight)
    .where(eq(tramitePreflight.tramiteId, tramiteId))
    .orderBy(desc(tramitePreflight.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    overall: row.overall ?? undefined,
    checks: (row.checks as TraspasoPreflightSnapshot['checks']) ?? [],
  };
}

async function fetchTraspasos(): Promise<Row[]> {
  if (SINGLE_ID) {
    const rows = await db.select({
      id: tramitesDigitales.id,
      paso: tramitesDigitales.paso,
      numeroRadicado: tramitesDigitales.numeroRadicado,
      estado: tramitesDigitales.estado,
      vehiculo: tramitesDigitales.vehiculo,
      comprador: tramitesDigitales.comprador,
    }).from(tramitesDigitales).where(eq(tramitesDigitales.id, SINGLE_ID)).limit(1);
    return rows as Row[];
  }

  const rows = await db.select({
    id: tramitesDigitales.id,
    paso: tramitesDigitales.paso,
    numeroRadicado: tramitesDigitales.numeroRadicado,
    estado: tramitesDigitales.estado,
    vehiculo: tramitesDigitales.vehiculo,
    comprador: tramitesDigitales.comprador,
  }).from(tramitesDigitales)
    .where(eq(tramitesDigitales.modalidadEntrada, 'traspaso'))
    .orderBy(tramitesDigitales.id)
    .limit(LIMIT);
  return rows as Row[];
}

/** Compare-and-set: solo actualiza si paso no cambió desde el scan (evita pisar edición concurrente). */
async function applyChange(row: ChangeRow): Promise<boolean> {
  const updated = await db.update(tramitesDigitales)
    .set({ paso: row.pasoNuevo, updatedAt: new Date() })
    .where(and(
      eq(tramitesDigitales.id, row.id),
      eq(tramitesDigitales.paso, row.pasoActual),
    ))
    .returning({ id: tramitesDigitales.id });
  return updated.length > 0;
}

async function main(): Promise<void> {
  const rows = await fetchTraspasos();
  if (!rows.length) {
    console.log('reconcile-traspaso-paso: sin trámites traspaso para evaluar');
    return;
  }

  const changes: ChangeRow[] = [];
  for (const row of rows) {
    const veh = row.vehiculo ?? {};
    const pazSalvo = (veh as { _pazSalvoImpuesto?: { verificado?: boolean } })._pazSalvoImpuesto;
    const preflight = await latestPreflight(row.id);
    const pasoNuevo = reconciliarPasoTraspasoBD({
      tramiteId: row.id,
      vehiculo: veh,
      comprador: row.comprador,
      preflight,
      pazSalvoImpuesto: pazSalvo,
    });
    if (pasoNuevo === row.paso) continue;
    changes.push({
      id: row.id,
      radicado: row.numeroRadicado,
      estado: row.estado,
      pasoActual: row.paso,
      pasoNuevo,
      hint: hintReconciliacionPasoTraspaso(row.paso, pasoNuevo, veh),
    });
  }

  console.log(`reconcile-traspaso-paso mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} scanned=${rows.length} changes=${changes.length}`);
  for (const c of changes) {
    console.log(
      `  id=${c.id} radicado=${c.radicado ?? '—'} estado=${c.estado} paso ${c.pasoActual}→${c.pasoNuevo} (${c.hint})`,
    );
  }

  if (!changes.length) {
    console.log('OK: todos los pasos ya están alineados con gates.');
    return;
  }

  if (!EXECUTE) {
    console.log('Dry-run: re-ejecuta con --execute para aplicar.');
    return;
  }

  let applied = 0;
  let skipped = 0;
  for (const c of changes) {
    const ok = await applyChange(c);
    if (ok) applied++;
    else skipped++;
  }
  console.log(`Aplicados ${applied} update(s) en tramites_digitales.paso`);
  if (skipped > 0) {
    console.log(`Omitidos ${skipped} (paso cambió desde el scan — re-ejecuta dry-run)`);
  }
}

main().catch((err) => {
  console.error('reconcile-traspaso-paso FAILED:', err);
  process.exit(1);
});
