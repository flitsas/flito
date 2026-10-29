/**
 * HU #14112 (C1.5, ADR-0030 C8a, Ley 1581) — cifra el legado de cédulas en claro
 * (`flito_logistica_actas.receptor_documento` y `contacto_documento`) con el helper
 * `protegerDocumento` (AES-256-GCM, AAD = id de la firma) y vacía las columnas en claro.
 *
 * Destino del cifrado (modelo C1.3, sin migración):
 *   - receptor → `flito_logistica_acta_firmas` rol=`recibe`
 *   - contacto → `flito_logistica_acta_firmas` rol=`entrega` (Operaciones no lleva cédula;
 *     el slot vacío conserva el snapshot de contacto sin columna TEXT nueva)
 *
 * IDEMPOTENTE: el SELECT solo trae filas con cédula en claro; la 2.ª corrida no escribe.
 * Nunca loguea cédulas ni nombres — solo ids de acta y contadores.
 *
 * Uso:
 *   cd apps/api
 *   npm run logistica:cifrar-cedulas            # cifra
 *   npm run logistica:cifrar-cedulas -- --dry   # cuenta sin escribir
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { limpiarDocumento, protegerDocumento } from '../modules/flito-logistica/flito-logistica.cifrado.js';

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const BATCH = 200;

export interface ActaEnClaro {
  id: string;
  receptor_documento: string | null;
  receptor_nombre: string | null;
  contacto_documento: string | null;
  contacto_nombre: string | null;
  firma_storage_key: string | null;
  firma_entrega_storage_key: string | null;
  entrega_nombre: string | null;
  entregado_en: Date | string | null;
  recibe_firma_id: string | null;
  recibe_cifrado: string | null;
  entrega_firma_id: string | null;
  entrega_cifrado: string | null;
}

export interface FirmaPlan {
  firmaId: string;
  rol: 'recibe' | 'entrega';
  crear: boolean;
  cifrado: string;
  ultimos: string;
  nombre: string;
  firmaKey: string;
  firmadoEn: Date | string | null;
}

export interface PlanActa {
  actaId: string;
  firmas: FirmaPlan[];
}

function filasDe<T>(r: unknown): T[] {
  if (r == null) return [];
  if (Array.isArray(r)) return r as T[];
  const wrapped = r as { rows?: T[] };
  return wrapped.rows ?? [];
}

function texto(v: string | null | undefined): string {
  return (v ?? '').trim();
}

async function fetchBatch(): Promise<ActaEnClaro[]> {
  const r = await db.execute<ActaEnClaro>(sql`
    SELECT a.id,
           a.receptor_documento, a.receptor_nombre,
           a.contacto_documento, a.contacto_nombre,
           a.firma_storage_key, a.firma_entrega_storage_key,
           a.entrega_nombre, a.entregado_en,
           fr.id AS recibe_firma_id, fr.documento_cifrado AS recibe_cifrado,
           fe.id AS entrega_firma_id, fe.documento_cifrado AS entrega_cifrado
      FROM flito_logistica_actas a
      LEFT JOIN flito_logistica_acta_firmas fr ON fr.acta_id = a.id AND fr.rol = 'recibe'
      LEFT JOIN flito_logistica_acta_firmas fe ON fe.acta_id = a.id AND fe.rol = 'entrega'
     WHERE (a.receptor_documento IS NOT NULL AND btrim(a.receptor_documento) <> '')
        OR (a.contacto_documento IS NOT NULL AND btrim(a.contacto_documento) <> '')
     ORDER BY a.id ASC
     LIMIT ${BATCH}
  `);
  return filasDe<ActaEnClaro>(r);
}

/** Arma el plan de cifrado de una acta. No escribe. No incluye el valor en claro. */
export function planActa(row: ActaEnClaro): PlanActa {
  const firmas: FirmaPlan[] = [];
  const receptor = texto(row.receptor_documento);
  const contacto = texto(row.contacto_documento);
  const firmadoEn = row.entregado_en ?? null;

  if (receptor && limpiarDocumento(receptor)) {
    const crear = !row.recibe_firma_id;
    const firmaId = row.recibe_firma_id ?? randomUUID();
    if (!row.recibe_cifrado) {
      const prot = protegerDocumento(receptor, firmaId);
      firmas.push({
        firmaId, rol: 'recibe', crear, cifrado: prot.cifrado, ultimos: prot.ultimos,
        nombre: texto(row.receptor_nombre) || 'Sin registrar',
        firmaKey: row.firma_storage_key ?? '',
        firmadoEn,
      });
    }
  }

  if (contacto && limpiarDocumento(contacto)) {
    const crear = !row.entrega_firma_id;
    const firmaId = row.entrega_firma_id ?? randomUUID();
    if (!row.entrega_cifrado) {
      const prot = protegerDocumento(contacto, firmaId);
      firmas.push({
        firmaId, rol: 'entrega', crear, cifrado: prot.cifrado, ultimos: prot.ultimos,
        nombre: texto(row.contacto_nombre) || texto(row.entrega_nombre) || 'Sin registrar',
        firmaKey: row.firma_entrega_storage_key ?? '',
        firmadoEn,
      });
    }
  }

  return { actaId: row.id, firmas };
}

async function aplicarFirma(tx: { execute: typeof db.execute }, actaId: string, f: FirmaPlan): Promise<void> {
  if (f.crear) {
    await tx.execute(sql`
      INSERT INTO flito_logistica_acta_firmas
        (id, acta_id, rol, nombre, documento_cifrado, documento_ultimos, firma_storage_key, firmado_en)
      VALUES
        (${f.firmaId}::uuid, ${actaId}::uuid, ${f.rol}, ${f.nombre}, ${f.cifrado}, ${f.ultimos}, ${f.firmaKey},
         COALESCE(${f.firmadoEn}::timestamptz, now()))
      ON CONFLICT (acta_id, rol) DO UPDATE
        SET documento_cifrado = COALESCE(flito_logistica_acta_firmas.documento_cifrado, EXCLUDED.documento_cifrado),
            documento_ultimos = COALESCE(flito_logistica_acta_firmas.documento_ultimos, EXCLUDED.documento_ultimos)
      WHERE flito_logistica_acta_firmas.documento_cifrado IS NULL
    `);
  } else {
    await tx.execute(sql`
      UPDATE flito_logistica_acta_firmas
         SET documento_cifrado = ${f.cifrado},
             documento_ultimos = ${f.ultimos}
       WHERE id = ${f.firmaId}::uuid
         AND documento_cifrado IS NULL
    `);
  }
}

async function vaciarClaro(tx: { execute: typeof db.execute }, actaId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE flito_logistica_actas
       SET receptor_documento = NULL,
           contacto_documento = NULL,
           updated_at = now()
     WHERE id = ${actaId}::uuid
       AND (
         (receptor_documento IS NOT NULL AND btrim(receptor_documento) <> '')
         OR (contacto_documento IS NOT NULL AND btrim(contacto_documento) <> '')
       )
  `);
}

async function applyBatch(planes: PlanActa[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const p of planes) {
      for (const f of p.firmas) await aplicarFirma(tx, p.actaId, f);
      await vaciarClaro(tx, p.actaId);
    }
  });
}

export async function contarEnClaro(): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM flito_logistica_actas
     WHERE (receptor_documento IS NOT NULL AND btrim(receptor_documento) <> '')
        OR (contacto_documento IS NOT NULL AND btrim(contacto_documento) <> '')
  `);
  const rows = filasDe<{ n: number }>(r);
  return Number(rows[0]?.n ?? 0);
}

export interface Stats {
  total: number;
  cifradas: number;
  firmasEscritas: number;
  enClaroAlFinal: number;
}

export async function run(): Promise<Stats> {
  const stats: Stats = { total: 0, cifradas: 0, firmasEscritas: 0, enClaroAlFinal: -1 };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await fetchBatch();
    if (batch.length === 0) break;

    const planes: PlanActa[] = [];
    for (const row of batch) {
      stats.total++;
      const plan = planActa(row);
      planes.push(plan);
      stats.firmasEscritas += plan.firmas.length;
    }

    if (DRY) {
      stats.cifradas += planes.length;
    } else if (planes.length > 0) {
      await applyBatch(planes);
      stats.cifradas += planes.length;
    }

    if (stats.total % 100 === 0 || stats.total === batch.length) {
      // eslint-disable-next-line no-console
      console.log(`[progress] vistas=${stats.total} cifradas=${stats.cifradas} firmas=${stats.firmasEscritas}${DRY ? ' (DRY)' : ''}`);
    }
  }

  stats.enClaroAlFinal = DRY ? stats.total : await contarEnClaro();
  return stats;
}

const argv1 = process.argv[1] ?? '';
const isDirectRun = (
  process.env.VITEST !== 'true' &&
  process.env.NODE_ENV !== 'test' &&
  (argv1.endsWith('flito-logistica-cifrar-cedulas-historicas.ts') || argv1.endsWith('flito-logistica-cifrar-cedulas-historicas.js'))
);

if (isDirectRun) {
  // eslint-disable-next-line no-console
  console.log(`[start] cifrar cédulas históricas flito_logistica_actas ${DRY ? '(DRY-RUN)' : '(LIVE)'}`);
  run().then((s) => {
    // eslint-disable-next-line no-console
    console.log(`[done] total=${s.total} cifradas=${s.cifradas} firmas=${s.firmasEscritas} en_claro=${s.enClaroAlFinal}`);
    process.exit(s.enClaroAlFinal === 0 || DRY ? 0 : 2);
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[error]', e instanceof Error ? e.message : 'fallo');
    process.exit(1);
  });
}

export { fetchBatch, applyBatch };
