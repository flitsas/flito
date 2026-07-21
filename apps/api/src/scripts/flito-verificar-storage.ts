// FLITO — Fase 7 (endurecimiento): verificación de integridad del storage de soportes.
//
// Cada fila de flito_soportes (factura SOAT, recibo de impuesto, factura de venta) apunta a un
// objeto en MinIO por su storage_key, con tamaño y hash sha256 registrados al subir. Este script
// comprueba que cada objeto EXISTE y que su tamaño coincide; con --deep además descarga el objeto y
// recalcula el sha256 para detectar corrupción. Es SOLO LECTURA: no escribe ni borra nada.
//
//   npx tsx src/scripts/flito-verificar-storage.ts           → existencia + tamaño (rápido)
//   npx tsx src/scripts/flito-verificar-storage.ts --deep     → además verifica hash (descarga)
//   npx tsx src/scripts/flito-verificar-storage.ts --limit=100
//
// Código de salida ≠ 0 si hay algún problema (apto para cron/CI).

import { createHash } from 'crypto';
import { asc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { flitoSoportes } from '../db/schema.js';
import { getEntityDocumentStream, statEntityDocument } from '../services/storage.js';

const DEEP = process.argv.includes('--deep');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0') || undefined;

type Problema = 'FALTANTE' | 'TAMANO' | 'HASH' | 'ERROR';

interface Hallazgo {
  problema: Problema; id: string; tipo: string; storageKey: string; detalle: string;
}

async function sha256DeStorage(key: string): Promise<string> {
  const stream = await getEntityDocumentStream(key);
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main(): Promise<void> {
  const base = db.select({
    id: flitoSoportes.id, tipo: flitoSoportes.tipo, storageKey: flitoSoportes.storageKey,
    hash: flitoSoportes.hash, tamanoBytes: flitoSoportes.tamanoBytes,
  }).from(flitoSoportes).orderBy(asc(flitoSoportes.subidoEn));
  const soportes = LIMIT ? await base.limit(LIMIT) : await base;

  console.log(`FLITO · verificación de storage — ${soportes.length} soporte(s)${DEEP ? ' · modo profundo (hash)' : ''}`);

  const hallazgos: Hallazgo[] = [];
  let ok = 0;

  for (const s of soportes) {
    try {
      const stat = await statEntityDocument(s.storageKey);
      if (!stat) {
        hallazgos.push({ problema: 'FALTANTE', id: s.id, tipo: s.tipo, storageKey: s.storageKey, detalle: 'El objeto no existe en el storage.' });
        continue;
      }
      if (stat.size !== s.tamanoBytes) {
        hallazgos.push({ problema: 'TAMANO', id: s.id, tipo: s.tipo, storageKey: s.storageKey, detalle: `Tamaño esperado ${s.tamanoBytes}, en storage ${stat.size}.` });
        continue;
      }
      if (DEEP) {
        const real = await sha256DeStorage(s.storageKey);
        if (real !== s.hash) {
          hallazgos.push({ problema: 'HASH', id: s.id, tipo: s.tipo, storageKey: s.storageKey, detalle: `Hash esperado ${s.hash}, calculado ${real}.` });
          continue;
        }
      }
      ok += 1;
    } catch (e) {
      hallazgos.push({ problema: 'ERROR', id: s.id, tipo: s.tipo, storageKey: s.storageKey, detalle: (e as Error).message });
    }
  }

  const porTipo = (p: Problema) => hallazgos.filter((h) => h.problema === p).length;
  console.log('\nResumen:');
  console.log(`  OK:        ${ok}`);
  console.log(`  Faltantes: ${porTipo('FALTANTE')}`);
  console.log(`  Tamaño:    ${porTipo('TAMANO')}`);
  if (DEEP) console.log(`  Hash:      ${porTipo('HASH')}`);
  console.log(`  Errores:   ${porTipo('ERROR')}`);

  if (hallazgos.length > 0) {
    console.log('\nDetalle de hallazgos:');
    for (const h of hallazgos) {
      console.log(`  [${h.problema}] ${h.tipo} ${h.id} — ${h.storageKey}\n           ${h.detalle}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\n✓ Todos los soportes íntegros.');
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  console.error('Fallo la verificación:', e);
  process.exit(2);
});
