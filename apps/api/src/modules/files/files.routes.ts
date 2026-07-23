// Descarga de archivos servida por la API con token HMAC firmado (GET /api/files).
//
// Reemplaza las URLs prefirmadas nativas de MinIO, que firman con el endpoint del cliente
// (p. ej. el hostname interno `minio:9000`, inalcanzable desde el navegador). La API sí alcanza a
// MinIO internamente y hace de proxy. PÚBLICA a propósito: el token firmado (con expiración corta)
// ES la autorización, igual que una URL prefirmada; nadie sin el secreto puede generar uno válido.

import { Router, type Request, type Response } from 'express';
import { getEntityDocumentStream, statEntityDocument, verificarDescargaEntidad } from '../../services/storage.js';

const router = Router();

// Content-Type de respaldo por extensión cuando el objeto no trae metadata de MinIO.
function tipoPorExtension(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default: return 'application/octet-stream';
  }
}

router.get('/', async (req: Request, res: Response) => {
  const { key, exp, sig } = req.query;
  if (typeof key !== 'string' || typeof exp !== 'string' || typeof sig !== 'string'
    || !verificarDescargaEntidad(key, exp, sig)) {
    res.status(403).json({ error: 'Enlace de descarga inválido o expirado' });
    return;
  }
  try {
    const meta = await statEntityDocument(key);
    res.setHeader('Content-Type', meta?.contentType || tipoPorExtension(key));
    res.setHeader('Content-Disposition', 'inline'); // ver en el navegador
    res.setHeader('Cache-Control', 'private, max-age=60');
    const stream = await getEntityDocumentStream(key);
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); });
    stream.pipe(res);
  } catch {
    if (!res.headersSent) res.status(404).json({ error: 'Archivo no encontrado' });
  }
});

export default router;
