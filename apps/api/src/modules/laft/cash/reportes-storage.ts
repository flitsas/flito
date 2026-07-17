import { Client } from 'minio';
import crypto from 'crypto';
import { env } from '../../../config/env.js';
import { loggerFor } from '../../../shared/logger.js';

const log = loggerFor('laft-reportes-storage');

// Bucket dedicado para reportes UIAF LAFT. Lo separamos del bucket de
// biometrías por dos razones:
//   1) Retención distinta — Ley 1121/2006 obliga 10 años para reportes UIAF;
//      las biometrías tienen retención más corta.
//   2) Auditoría — al ser un bucket dedicado, los accesos S3 quedan claramente
//      asociados a tráfico de cumplimiento (separación de funciones ISO A.5.3).
//
// Si el bucket no existe en arranque, lo creamos (idempotente). En producción
// el bucket vive en MinIO con versioning + object-lock (90d/20a/5a según
// memoria del PO; se aplica vía mc admin policy fuera de este código).
const BUCKET = 'operaciones-laft-reportes';

let client: Client | null = null;

function getClient(): Client {
  if (client) return client;
  client = new Client({
    endPoint: env.S3_ENDPOINT,
    port: parseInt(env.S3_PORT, 10),
    useSSL: true,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
  });
  return client;
}

async function ensureBucket(): Promise<void> {
  const c = getClient();
  const exists = await c.bucketExists(BUCKET);
  if (!exists) {
    log.info({ bucket: BUCKET }, 'creando bucket LAFT reportes');
    await c.makeBucket(BUCKET, 'us-east-1');
  }
}

export interface UploadReporteOpts {
  tipo: 'RTE' | 'AROS' | 'ROS';
  anio: number;
  /** Mes 1-12 para RTE, undefined para AROS. */
  mes?: number;
  /** Trimestre 1-4 para AROS, undefined para RTE. */
  trimestre?: number;
  formato: 'CSV' | 'PDF' | 'XML';
  body: Buffer;
}

export interface UploadReporteResult {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

export async function uploadReporte(opts: UploadReporteOpts): Promise<UploadReporteResult> {
  await ensureBucket();
  const sha256 = crypto.createHash('sha256').update(opts.body).digest('hex');
  const ext = opts.formato.toLowerCase();
  const periodo = opts.tipo === 'RTE'
    ? `${opts.anio}/${String(opts.mes ?? 0).padStart(2, '0')}`
    : `${opts.anio}/Q${opts.trimestre ?? 0}`;
  const storageKey = `${opts.tipo}/${periodo}/${opts.tipo}-${opts.anio}${opts.tipo === 'RTE' ? '-' + String(opts.mes).padStart(2, '0') : '-Q' + opts.trimestre}.${ext}`;
  const c = getClient();
  await c.putObject(BUCKET, storageKey, opts.body, opts.body.length, {
    'Content-Type': opts.formato === 'CSV' ? 'text/csv; charset=utf-8'
      : opts.formato === 'PDF' ? 'application/pdf'
      : 'application/xml',
    'X-Amz-Meta-Sha256': sha256,
    'X-Amz-Meta-Tipo': opts.tipo,
  });
  return { storageKey, sha256, sizeBytes: opts.body.length };
}

export async function downloadReporte(storageKey: string): Promise<Buffer> {
  const c = getClient();
  const stream = await c.getObject(BUCKET, storageKey);
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    stream.on('data', (c2: Buffer) => chunks.push(c2));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
