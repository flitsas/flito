import { Client } from 'minio';
import { env } from '../config/env.js';
import crypto from 'crypto';
import { loggerFor } from '../shared/logger.js';

const log = loggerFor('storage');

const BUCKET = 'operaciones-biometrics';

let minioClient: Client | null = null;

function getClient(): Client {
  if (!minioClient) {
    // Las credenciales son requeridas por env.ts (fallar boot si faltan).
    // No usar fallbacks hardcoded — mantienen secretos en el repo aunque sean código muerto.
    minioClient = new Client({
      endPoint: env.S3_ENDPOINT,
      port: parseInt(env.S3_PORT),
      useSSL: true,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    });
  }
  return minioClient;
}

export async function ensureBucket() {
  const client = getClient();
  const exists = await client.bucketExists(BUCKET);
  if (!exists) await client.makeBucket(BUCKET, 'us-east-1');
}

export async function uploadPhoto(tramiteId: number, tipo: string, b64: string): Promise<string> {
  const client = getClient();
  const clean = b64.replace(/^data:image\/[a-z]+;base64,/, '');
  const buf = Buffer.from(clean, 'base64');
  const hash = crypto.randomBytes(8).toString('hex');
  const key = `validaciones/${tramiteId}/${tipo}_${hash}.jpg`;
  await client.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': 'image/jpeg' });
  return key;
}

export async function getPhoto(key: string): Promise<string> {
  const client = getClient();
  const chunks: Buffer[] = [];
  const stream = await client.getObject(BUCKET, key);
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve('data:image/jpeg;base64,' + buf.toString('base64'));
    });
    stream.on('error', reject);
  });
}

export async function deletePhoto(key: string): Promise<void> {
  const client = getClient();
  await client.removeObject(BUCKET, key);
}

// Documentos genéricos de flota (PDF/JPG/PNG). Bucket compartido, key con prefijo "fleet/".
export async function uploadFleetDocument(vehicleId: number, filename: string, buf: Buffer, mime: string): Promise<string> {
  const client = getClient();
  const exists = await client.bucketExists(BUCKET);
  if (!exists) await client.makeBucket(BUCKET, 'us-east-1');
  const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100);
  const hash = crypto.randomBytes(6).toString('hex');
  const key = `fleet/documents/${vehicleId}/${Date.now()}_${hash}_${safeName}`;
  await client.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': mime });
  return key;
}

export async function getFleetDocumentStream(key: string) {
  const client = getClient();
  return client.getObject(BUCKET, key);
}

export async function deleteFleetDocument(key: string): Promise<void> {
  const client = getClient();
  try { await client.removeObject(BUCKET, key); } catch (e) { log.warn({ err: e, key }, 'delete fleet doc failed'); }
}

// Genérico para cualquier entidad — usar para documentos de conductor, evidencias de incidente, etc.
// Llave: <prefix>/<entityId>/<timestamp>_<hash>_<safeName>.
export async function uploadEntityDocument(
  prefix: string,
  entityId: number | string,
  filename: string,
  buf: Buffer,
  mime: string,
): Promise<string> {
  const client = getClient();
  const exists = await client.bucketExists(BUCKET);
  if (!exists) await client.makeBucket(BUCKET, 'us-east-1');
  const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100);
  const hash = crypto.randomBytes(6).toString('hex');
  const safePrefix = prefix.replace(/[^A-Za-z0-9_/-]+/g, '_');
  const key = `${safePrefix}/${entityId}/${Date.now()}_${hash}_${safeName}`;
  await client.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': mime });
  return key;
}

export async function getEntityDocumentStream(key: string) {
  const client = getClient();
  return client.getObject(BUCKET, key);
}

export async function deleteEntityDocument(key: string): Promise<void> {
  const client = getClient();
  try { await client.removeObject(BUCKET, key); } catch (e) { log.warn({ err: e, key }, 'delete entity doc failed'); }
}

// Presigned URL temporal (ADR-PESV-002). TTL en segundos, default 300 = 5 min.
// Audit + pii_access_log DEBEN registrarse ANTES de devolver la URL al cliente.
// Stat: validamos que el objeto exista y obtenemos size+contentType (fallback si no hay metadata).
export async function presignedGetEntityDocument(key: string, ttlSeconds = 300): Promise<string> {
  const client = getClient();
  return client.presignedGetObject(BUCKET, key, ttlSeconds);
}

export async function statEntityDocument(key: string): Promise<{ size: number; contentType: string | null } | null> {
  const client = getClient();
  try {
    const stat = await client.statObject(BUCKET, key);
    return {
      size: stat.size,
      contentType: (stat.metaData?.['content-type'] as string | undefined) ?? null,
    };
  } catch (e) {
    log.warn({ err: e, key }, 'stat entity doc failed');
    return null;
  }
}
