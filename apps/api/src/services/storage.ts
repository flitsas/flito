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
      useSSL: env.S3_USE_SSL, // configurable: HTTPS para S3 externo, HTTP para MinIO local (S3_USE_SSL=false)
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
// Esta función conserva el nombre del cliente dentro de la clave, y NO es un olvido del Bug #11694:
// su clave nunca sale a una URL. La descarga es `GET /api/fleet/documents/:id/download`, que resuelve
// `archivoStorageKey` desde la base por id del documento y hace `pipe` del stream; no interviene
// `firmarDescargaEntidad`, que es quien mete la clave en el query string. Sin ese vector no hay nada
// que cerrar aquí, y volverla opaca obligaría a mover también el nombre a `Content-Disposition` desde
// otra fuente. Si algún día se le firma la descarga, esto pasa a ser el mismo defecto.
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

// ── Cómo se nombra el objeto en el almacenamiento (Bug #11694) ───────────────
//
// La clave del objeto viaja ENTERA en el query string del enlace firmado (`/api/files?key=…`, ver
// `firmarDescargaEntidad` más abajo). Todo lo que se meta dentro acaba en los logs de acceso de
// nginx, en el historial del navegador y en la cabecera `Referer` de la siguiente navegación. Y el
// nombre del archivo lo escribe el cliente: es texto libre y trae placas, cédulas o NIT dentro más
// veces de las que parece («comprobante-ABC123.pdf»). Por eso el nombre del cliente NO entra en la
// clave — se sustituye por un UUID.
//
// Es el mismo riesgo que la HU #11678 mitigó por el otro lado (no copiar `originalname` al `detail`
// de la bitácora) y que `nombreEnAlmacen` de conciliación resolvió para su propio flujo; esto lo
// generaliza al helper que comparten los ~15 puntos de carga del monorepo.
//
// El nombre original NO se pierde: cada flujo lo guarda en su columna —`flito_soportes.
// nombre_archivo`, `driver_documents.archivo_filename`, …— y es esa columna la que pinta la UI y la
// que fija el `Content-Disposition` de las descargas. Lo que cambia es solo la clave del objeto.
//
// Solo aplica a claves NUEVAS: reescribir las existentes exigiría migración más copia de objetos en
// MinIO, y no desharía lo ya escrito en los logs. Las viejas (`<ts>_<hash>_<nombre>`) tienen que
// seguir descargándose: ni la firma ni la ruta de descarga asumen formato de clave.

/** Extensión de respaldo por tipo real cuando el nombre del cliente no trae una utilizable. */
const EXTENSION_POR_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/zip': 'zip',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

/**
 * Las únicas extensiones que pueden salir del nombre del cliente. Conjunto CERRADO, derivado de la
 * tabla de arriba —más `jpeg`, que es extensión real aunque no sea el valor canónico de su mime—.
 */
const EXTENSIONES_CONOCIDAS = new Set<string>([...Object.values(EXTENSION_POR_MIME), 'jpeg']);

/**
 * La extensión con la que se guarda el objeto. Manda el MIME; el nombre del cliente es el último
 * recurso y solo si cae dentro de `EXTENSIONES_CONOCIDAS`.
 *
 * No es un adorno: `GET /api/files` cae en `tipoPorExtension(key)` cuando MinIO no devuelve
 * metadata de content-type, y `transito-config` sirve el logo con `contentTypeFromKey(key)`. Sin
 * extensión ambas descargas se servirían como `octet-stream`.
 *
 * **Por qué el mime va primero y es de confianza aquí:** los siete puntos de carga lo validan
 * contra una lista blanca antes de llamar (`drivers/documents`, `fleet/documents`, `flito-bolsas`,
 * `laft/audit-plan`, `laft/officer`, `pesv/diagnostico-evidencias`, `transito-config`), y bolsas,
 * conciliación y PESV además corren `checkMagicNumber` sobre los bytes. El nombre, en cambio, es
 * texto libre.
 *
 * **Y por qué NO se filtra por forma:** lo que va tras el último punto no es «la extensión», es lo
 * que el cliente haya escrito ahí. Una placa colombiana (`ABC123`, `WGY45F`) y una cédula o un NIT
 * caben enteros dentro de «alfanumérico y corto»: `comprobante.ABC123` daba la extensión `abc123`,
 * la placa volvía a la clave y de ahí al `?key=` del enlace firmado. Es decir, el hueco que este
 * Bug cierra seguía abierto justo para la clase de nombre que persigue. Un conjunto cerrado que
 * controlamos nosotros es lo único que lo cierra.
 */
function extensionDe(filename: string, mime: string): string {
  const porMime = EXTENSION_POR_MIME[mime.split(';')[0].trim().toLowerCase()];
  if (porMime) return porMime;
  const ultima = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONES_CONOCIDAS.has(ultima) ? ultima : 'bin';
}

/** Nombre del objeto en el almacenamiento: opaco por construcción. Nunca el que subió el usuario. */
export function nombreOpaco(filename: string, mime: string): string {
  return `${crypto.randomUUID()}.${extensionDe(filename, mime)}`;
}

export interface OpcionesDocumento {
  /**
   * Formato LEGADO: conserva el nombre saneado del cliente dentro de la clave (Bug #11694).
   *
   * Existe por UN flujo: las evidencias del autodiagnóstico PESV
   * (`pesv/diagnostico-evidencia`). Ese módulo no guarda el nombre en ninguna columna —solo tiene
   * `pesv_diagnostico_items.evidencia_keys text[]`— y lo recupera PARSEANDO la clave, en tres
   * sitios: `evidenciaPublic` (lista del diagnóstico), `decodeFilename` (respuesta del enlace
   * temporal) y el nombre de cada entrada del ZIP de exportación. Con la clave opaca los tres
   * pasarían a enseñar un UUID.
   *
   * Darle su fuente exige una columna nueva y eso es una decisión de alcance que no se toma aquí.
   * Mientras tanto se queda como estaba, explícito y localizado, en vez de degradar su pantalla en
   * silencio. NO usar en flujos nuevos: quien tenga dónde guardar el nombre, que lo guarde.
   *
   * ⚠️ ESTA EXCEPCIÓN RETIENE EL AGUJERO, y no se lee así a simple vista. `evidenciaTemporal`
   * (`diagnostico-evidencias.routes.ts`) firma la descarga con `presignedGetEntityDocument`, que es
   * `firmarDescargaEntidad`: la clave —con el nombre del cliente dentro— viaja entera en el
   * `?key=` del enlace. O sea que para las evidencias del autodiagnóstico el vector del Bug #11694
   * sigue abierto, y se acepta a sabiendas hasta que exista la columna.
   *
   * No confundir con la excepción de `uploadFleetDocument` (arriba): aquella está CERRADA —su
   * clave nunca sale a una URL—. Las dos se parecen y solo una es inocua.
   */
  conservarNombreEnClave?: boolean;
}

// Genérico para cualquier entidad — usar para documentos de conductor, evidencias de incidente, etc.
// Llave: <prefix>/<entityId>/<timestamp>_<uuid>.<ext> (ver el bloque de arriba).
export async function uploadEntityDocument(
  prefix: string,
  entityId: number | string,
  filename: string,
  buf: Buffer,
  mime: string,
  opciones: OpcionesDocumento = {},
): Promise<string> {
  const client = getClient();
  const exists = await client.bucketExists(BUCKET);
  if (!exists) await client.makeBucket(BUCKET, 'us-east-1');
  const sufijo = opciones.conservarNombreEnClave
    ? `${crypto.randomBytes(6).toString('hex')}_${filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100)}`
    : nombreOpaco(filename, mime);
  const safePrefix = prefix.replace(/[^A-Za-z0-9_/-]+/g, '_');
  // `entityId` se sanea como el prefijo, y ADEMÁS sin `/`: es un segmento, no una ruta. No todos los
  // llamadores lo controlan —`flito-bolsas` pasa `req.params.bolsaId` crudo y sube ANTES de tocar la
  // BD, así que nada lo obliga a ser un UUID—, y Express ya decodificó cualquier `%2F`. Con
  // `..%2F..%2Fpesv` la clave llegaba a llevar `../..` dentro; no es traversal de disco (es una
  // clave de objeto del mismo bucket) pero escribía en prefijos no previstos.
  //
  // Efecto colateral asumido: `transito-config` pasa `<codigo>/logo` a propósito, y ahora se aplana
  // a `<codigo>_logo`. No rompe nada —la clave se guarda en `logo_storage_key` y solo se lee su
  // extensión—, pero los logos nuevos se disponen distinto de los viejos en el bucket.
  const safeEntityId = String(entityId).replace(/[^A-Za-z0-9_-]+/g, '_');
  const key = `${safePrefix}/${safeEntityId}/${Date.now()}_${sufijo}`;
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

// URL de descarga temporal firmada por NOSOTROS, servida por la API (GET /api/files).
//
// No se usa la URL prefirmada nativa de MinIO porque firma con el endpoint del cliente
// (p. ej. el hostname interno `minio:9000`), inalcanzable desde el navegador. En su lugar la
// API sirve el archivo (sí alcanza a MinIO internamente) validando un token HMAC con expiración.
// URL RELATIVA a propósito: el navegador la resuelve contra su origen → nginx `/api/` → API.
const DOWNLOAD_SECRET = env.DOWNLOAD_TOKEN_SECRET ?? env.JWT_SECRET;

/** Firma una URL de descarga (`/api/files?...`) válida por `ttlSeconds`. */
export function firmarDescargaEntidad(key: string, ttlSeconds = 300): string {
  const exp = Date.now() + ttlSeconds * 1000;
  const sig = crypto.createHmac('sha256', DOWNLOAD_SECRET).update(`file:${key}:${exp}`).digest('hex');
  const params = new URLSearchParams({ key, exp: String(exp), sig });
  return `/api/files?${params.toString()}`;
}

/** Valida el token de una URL de descarga (firma + expiración). */
export function verificarDescargaEntidad(key: string, exp: string, sig: string): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
  const esperado = crypto.createHmac('sha256', DOWNLOAD_SECRET).update(`file:${key}:${expNum}`).digest('hex');
  const a = Buffer.from(sig); const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Compat: mantiene la firma previa (Promise<string>). TTL en segundos, default 300 = 5 min.
export async function presignedGetEntityDocument(key: string, ttlSeconds = 300): Promise<string> {
  return firmarDescargaEntidad(key, ttlSeconds);
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
