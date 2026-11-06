/**
 * Backfill PII fotos en `tramites_validaciones` a MinIO/S3.
 *
 * Las 3 columnas (foto_rostro, foto_cedula_frontal, foto_cedula_reverso) eran `text`
 * con base64 dentro. Este script:
 *   1) Detecta el formato de cada valor (S3 key | base64 plano | otro).
 *   2) Si es base64 sin cifrar, lo sube a MinIO.
 *   3) Reemplaza el valor de la columna por la storage key.
 *
 * Idempotente: si ya está en S3 (prefijo `validaciones/`), salta. Si no se puede
 * decodear, salta (no pisa BD con basura). Sin --commit no escribe nada.
 * El formato cifrado viejo ya no se descifra (HU #14273): se reporta y se salta.
 *
 * Uso:
 *   cd apps/api
 *   tsx scripts/backfill-fotos-s3.ts --dry-run    # solo reporta
 *   tsx scripts/backfill-fotos-s3.ts --commit     # ejecuta UPDATEs y uploads
 */

import { db } from '../db/client.js';
import { tramitesValidaciones } from '../db/schema.js';
import { uploadPhoto, ensureBucket } from '../services/storage.js';
import { isNotNull, or, eq } from 'drizzle-orm';
import { clasificarFoto } from '../modules/tramites/identidad.fotos.js';

const COMMIT = process.argv.includes('--commit');
const DRY = !COMMIT;

async function migrateField(
  rowId: number,
  tramiteId: number,
  tipo: 'rostro' | 'frontal' | 'reverso',
  val: string | null,
): Promise<string | null> {
  const kind = clasificarFoto(val);
  if (kind === 'vacio') return null;
  if (kind === 'storage_key') {
    console.log(`[skip] row=${rowId} tramite=${tramiteId} tipo=${tipo}: already S3 (${val!.slice(0, 40)})`);
    return val;
  }
  if (kind === 'nuevo') {
    // Ya recifrado por flito-recifrar-biometria: este backfill no lo mueve a S3.
    console.log(`[skip] row=${rowId} tramite=${tramiteId} tipo=${tipo}: formato nuevo`);
    return val;
  }
  if (kind === 'desconocido') {
    console.warn(`[warn] row=${rowId} tramite=${tramiteId} tipo=${tipo}: format unknown (len=${val!.length})`);
    return val;
  }
  if (kind === 'viejo') {
    console.warn(`[warn] row=${rowId} tramite=${tramiteId} tipo=${tipo}: formato viejo, no se puede descifrar; se salta`);
    return val;
  }
  // data_uri o base64_plano: subir tal cual (uploadPhoto strip el prefijo data: si existe)
  const b64 = val!;
  if (DRY) {
    console.log(`[dry ] row=${rowId} tramite=${tramiteId} tipo=${tipo}: would upload (${kind}, ${b64.length}B)`);
    return val;
  }
  const key = await uploadPhoto(tramiteId, tipo, b64);
  console.log(`[ok  ] row=${rowId} tramite=${tramiteId} tipo=${tipo}: ${kind} → ${key}`);
  return key;
}

async function main() {
  console.log(`Modo: ${COMMIT ? 'COMMIT (escribe BD y S3)' : 'DRY-RUN (no escribe)'}`);
  await ensureBucket();
  const rows = await db.select().from(tramitesValidaciones).where(or(
    isNotNull(tramitesValidaciones.fotoRostro),
    isNotNull(tramitesValidaciones.fotoCedulaFrontal),
    isNotNull(tramitesValidaciones.fotoCedulaReverso),
  ));
  console.log(`Filas con al menos una foto: ${rows.length}`);

  let touched = 0;
  for (const r of rows) {
    const newRostro = await migrateField(r.id, r.tramiteId, 'rostro', r.fotoRostro);
    const newFront = await migrateField(r.id, r.tramiteId, 'frontal', r.fotoCedulaFrontal);
    const newRev = await migrateField(r.id, r.tramiteId, 'reverso', r.fotoCedulaReverso);

    const changed =
      newRostro !== r.fotoRostro || newFront !== r.fotoCedulaFrontal || newRev !== r.fotoCedulaReverso;
    if (changed && COMMIT) {
      await db.update(tramitesValidaciones).set({
        fotoRostro: newRostro,
        fotoCedulaFrontal: newFront,
        fotoCedulaReverso: newRev,
      }).where(eq(tramitesValidaciones.id, r.id));
      touched++;
      console.log(`[updt] row=${r.id} tramite=${r.tramiteId}: BD actualizada`);
    }
  }

  console.log(`\nDone. Filas tocadas: ${touched}/${rows.length}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
