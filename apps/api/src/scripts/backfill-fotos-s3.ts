/**
 * Backfill PII fotos en `tramites_validaciones` a MinIO/S3.
 *
 * Las 3 columnas (foto_rostro, foto_cedula_frontal, foto_cedula_reverso) eran `text`
 * con base64 dentro o cifrado AES-GCM legacy. Este script:
 *   1) Detecta el formato de cada valor (S3 key | encrypted legacy | base64 plano).
 *   2) Si NO está en S3, descifra (si aplica) y sube a MinIO.
 *   3) Reemplaza el valor de la columna por la storage key.
 *
 * Idempotente: si ya está en S3 (prefijo `validaciones/`), salta. Si no se puede
 * decodear, salta (no pisa BD con basura). Sin --commit no escribe nada.
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
import crypto from 'crypto';
import { env } from '../config/env.js';

const COMMIT = process.argv.includes('--commit');
const DRY = !COMMIT;

type Kind = 's3' | 'legacy_enc' | 'plain_b64' | 'data_uri' | 'empty' | 'unknown';

function classify(val: string | null): Kind {
  if (!val) return 'empty';
  if (val.startsWith('validaciones/')) return 's3';
  if (val.startsWith('data:image/')) return 'data_uri';
  // Formato legacy de identidad.routes.ts encryptPII: <ivHex>:<tagHex>:<b64>.
  if (/^[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:/.test(val)) return 'legacy_enc';
  // Heurística base64: >100 chars y solo caracteres del alfabeto base64.
  if (val.length > 100 && /^[A-Za-z0-9+/=]+$/.test(val.slice(0, 200))) return 'plain_b64';
  return 'unknown';
}

function decryptLegacy(ct: string): string | null {
  try {
    const [ivHex, tagHex, data] = ct.split(':');
    if (!ivHex || !tagHex || !data) return null;
    const key = crypto.scryptSync(env.PII_ENC_KEY, 'kyverum-pii-salt', 32);
    const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    dec.setAuthTag(Buffer.from(tagHex, 'hex'));
    return dec.update(data, 'base64', 'utf8') + dec.final('utf8');
  } catch {
    return null;
  }
}

async function migrateField(
  rowId: number,
  tramiteId: number,
  tipo: 'rostro' | 'frontal' | 'reverso',
  val: string | null,
): Promise<string | null> {
  const kind = classify(val);
  if (kind === 'empty') return null;
  if (kind === 's3') {
    console.log(`[skip] row=${rowId} tramite=${tramiteId} tipo=${tipo}: already S3 (${val!.slice(0, 40)})`);
    return val;
  }
  if (kind === 'unknown') {
    console.warn(`[warn] row=${rowId} tramite=${tramiteId} tipo=${tipo}: format unknown (len=${val!.length}, prefix=${val!.slice(0, 30)})`);
    return val;
  }
  let b64: string | null = null;
  if (kind === 'legacy_enc') {
    b64 = decryptLegacy(val!);
    if (!b64) {
      console.warn(`[warn] row=${rowId} tramite=${tramiteId} tipo=${tipo}: legacy_enc decrypt failed`);
      return val;
    }
  } else {
    // data_uri o plain_b64: subir tal cual (uploadPhoto strip el prefijo data: si existe)
    b64 = val!;
  }
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
