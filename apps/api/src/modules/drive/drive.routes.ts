import { Router, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { listFiles, listFolders, downloadFile, searchFiles } from '../../services/googleDrive.js';
import { env } from '../../config/env.js';

const router = Router();
router.use(authMiddleware, requireRole('admin'));

const ROOT_FOLDER = env.GOOGLE_DRIVE_FOLDER_ID || '';

// GET / — Listar archivos de la carpeta raíz o subfolder
router.get('/', async (req: Request, res: Response) => {
  try {
    const folderId = (req.query.folder as string) || ROOT_FOLDER;
    if (!folderId) { res.status(400).json({ error: 'GOOGLE_DRIVE_FOLDER_ID no configurado' }); return; }

    const [files, folders] = await Promise.all([
      listFiles(folderId),
      listFolders(folderId),
    ]);

    res.json({ ok: true, folderId, folders, files });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /search — Buscar archivos
router.get('/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string) || '';
    if (!q || q.length < 2) { res.status(400).json({ error: 'Query mínimo 2 caracteres' }); return; }
    const folderId = (req.query.folder as string) || ROOT_FOLDER;
    const files = await searchFiles(folderId, q);
    res.json({ ok: true, files });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /download/:fileId — Descargar archivo
router.get('/download/:fileId', async (req: Request, res: Response) => {
  try {
    const { buffer, name, mimeType } = await downloadFile(req.params.fileId);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buffer);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /preview/:fileId — Preview como base64 para el frontend
router.get('/preview/:fileId', async (req: Request, res: Response) => {
  try {
    const { buffer, mimeType } = await downloadFile(req.params.fileId);
    const b64 = buffer.toString('base64');
    res.json({ ok: true, data: `data:${mimeType};base64,${b64}`, mimeType });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
