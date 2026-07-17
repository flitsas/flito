// Storage helper dedicado para reportes LAFT (bucket separado de fotos/documentos
// generales por aislamiento de blast radius: si una credencial S3 se rota, el ROS
// no se mezcla con fleet docs ni biometría).
//
// Bucket: operaciones-laft-reportes. Path convention: ROS/<rosId>/<ts>_<artefacto>.
// Idempotencia: el caller puede reusar la misma key para sobreescribir cuando regenera
// un export — putObject hace overwrite atómico en MinIO.

import { Client } from 'minio';
import { env } from '../../../config/env.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-storage');
export const LAFT_BUCKET = 'operaciones-laft-reportes';

let client: Client | null = null;
function getClient(): Client {
  if (!client) {
    client = new Client({
      endPoint: env.S3_ENDPOINT,
      port: parseInt(env.S3_PORT, 10),
      useSSL: true,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    });
  }
  return client;
}

let bucketEnsured = false;
export async function ensureLaftBucket(): Promise<void> {
  if (bucketEnsured) return;
  const c = getClient();
  const exists = await c.bucketExists(LAFT_BUCKET);
  if (!exists) {
    await c.makeBucket(LAFT_BUCKET, 'us-east-1');
    log.info({ bucket: LAFT_BUCKET }, 'bucket creado');
  }
  bucketEnsured = true;
}

export async function putRosExportObject(
  key: string,
  data: Uint8Array | Buffer | string,
  contentType: string,
): Promise<void> {
  await ensureLaftBucket();
  const buf = typeof data === 'string'
    ? Buffer.from(data, 'utf8')
    : data instanceof Buffer ? data : Buffer.from(data);
  await getClient().putObject(LAFT_BUCKET, key, buf, buf.length, { 'Content-Type': contentType });
}

export async function getRosExportStream(key: string) {
  await ensureLaftBucket();
  return getClient().getObject(LAFT_BUCKET, key);
}

export function rosExportKey(rosId: number, kind: 'pdf' | 'csv'): string {
  // Key estable por (rosId, kind): regeneraciones sobrescriben el blob anterior.
  // Esto es deliberado — el SHA-256 en BD detecta cambios y la versión histórica
  // queda en BD vía sirel_payload + auditoría.
  const ext = kind === 'pdf' ? 'pdf' : 'csv';
  return `ROS/${rosId}/borrador-sirel.${ext}`;
}
