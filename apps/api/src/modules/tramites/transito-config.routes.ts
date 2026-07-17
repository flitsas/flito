import { Router, Request, Response, NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  deleteEntityDocument,
  getEntityDocumentStream,
  uploadEntityDocument,
} from '../../services/storage.js';
import {
  getOrganismoConfig,
  getOrganismoLogoStorageKey,
  isValidLogoUrl,
  listOrganismosConfig,
  setOrganismoLogoStorageKey,
  upsertOrganismoConfig,
} from './transito-config.js';
import { isKnownOrganismoCodigo } from '@operaciones/shared-types';
import {
  checklistOverrideSchema,
  getChecklistOverride,
  upsertChecklistOverride,
} from './transito-checklist-overrides.js';

/**
 * TRAM-MT-02 — Config por organismo (alias, logo, activo).
 * - GET list/detail: admin; transito solo su codigo en detail.
 * - PUT: admin only.
 */
const router = Router();
router.use(authMiddleware);

const putSchema = z.object({
  alias: z.string().max(120).nullable().optional(),
  logoUrl: z.string().max(500).nullable().optional(),
  activo: z.boolean().optional(),
}).strict();

// TRAM-MT-02 Fase 2b — subida de logo a MinIO.
const LOGO_MAX_BYTES = 512 * 1024; // 512 KB
const LOGO_MIME = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
]);
const LOGO_PREFIX = 'transito/organismos';

const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
}).single('file');

// Wrapper: traduce errores de multer (p.ej. LIMIT_FILE_SIZE) a 400 en vez de 500.
function handleLogoUpload(req: Request, res: Response, next: NextFunction): void {
  uploadLogo(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'El logo supera el máximo de 512 KB'
        : 'Archivo inválido';
      res.status(400).json({ error: msg });
      return;
    }
    if (err) {
      res.status(400).json({ error: 'No se pudo procesar el archivo' });
      return;
    }
    next();
  });
}

/** Content-Type a partir de la extensión de la key (las subimos con extensión canónica). */
function contentTypeFromKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

router.get('/organismos-config', requireRole('admin'), async (_req: Request, res: Response) => {
  try {
    res.json(await listOrganismosConfig());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/organismos-config/:codigo', requireRole('admin', 'transito'), async (req: Request, res: Response) => {
  try {
    const codigo = req.params.codigo.trim();
    const user = req.user!;

    if (user.role === 'transito') {
      const mine = user.transitoCodigo?.trim();
      if (!mine || mine !== codigo) {
        res.status(403).json({ error: 'Sin permisos para este organismo' });
        return;
      }
    }

    const row = await getOrganismoConfig(codigo);
    if (!row) {
      res.status(400).json({ error: 'Código de organismo inválido' });
      return;
    }
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get(
  '/organismos-config/:codigo/checklist/:tipologia',
  requireRole('admin', 'transito'),
  async (req: Request, res: Response) => {
    try {
      const codigo = req.params.codigo.trim();
      const tipologia = req.params.tipologia.trim();
      const user = req.user!;

      if (user.role === 'transito') {
        const mine = user.transitoCodigo?.trim();
        if (!mine || mine !== codigo) {
          res.status(403).json({ error: 'Sin permisos para este organismo' });
          return;
        }
      }

      const row = await getChecklistOverride(codigo, tipologia);
      if (!row) {
        res.status(400).json({ error: 'Organismo o tipología inválidos' });
        return;
      }
      res.json(row);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put(
  '/organismos-config/:codigo/checklist/:tipologia',
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const codigo = req.params.codigo.trim();
      const tipologia = req.params.tipologia.trim();
      const parsed = checklistOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
        return;
      }

      try {
        const updated = await upsertChecklistOverride(codigo, tipologia, parsed.data);
        if (!updated) {
          res.status(400).json({ error: 'Organismo o tipología inválidos' });
          return;
        }
        await audit(req, {
          action: 'update',
          resource: 'organismo_checklist_override',
          resourceId: `${codigo}:${tipologia}`,
          detail: 'Override checklist organismo actualizado',
        });
        res.json(updated);
      } catch (err: any) {
        res.status(400).json({ error: err.message || 'Override inválido' });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  },
);

router.put('/organismos-config/:codigo', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const codigo = req.params.codigo.trim();
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
      return;
    }

    const { alias, logoUrl, activo } = parsed.data;
    if (logoUrl != null && logoUrl !== '' && !isValidLogoUrl(logoUrl)) {
      res.status(400).json({ error: 'URL de logo inválida (use https:// o ruta /...)' });
      return;
    }

    const updated = await upsertOrganismoConfig(codigo, { alias, logoUrl, activo });
    if (!updated) {
      res.status(400).json({ error: 'Código de organismo inválido' });
      return;
    }

    await audit(req, {
      action: 'update',
      resource: 'organismo_transito_config',
      resourceId: codigo,
      detail: 'Config organismo actualizada',
    });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET logo subido — sirve la imagen (admin, o transito de su propio organismo).
router.get(
  '/organismos-config/:codigo/logo',
  requireRole('admin', 'transito'),
  async (req: Request, res: Response) => {
    try {
      const codigo = req.params.codigo.trim();
      const user = req.user!;
      if (user.role === 'transito') {
        const mine = user.transitoCodigo?.trim();
        if (!mine || mine !== codigo) {
          res.status(403).json({ error: 'Sin permisos para este organismo' });
          return;
        }
      }

      const key = await getOrganismoLogoStorageKey(codigo);
      if (!key) {
        res.status(404).json({ error: 'El organismo no tiene logo subido' });
        return;
      }

      const stream = await getEntityDocumentStream(key);
      res.setHeader('Content-Type', contentTypeFromKey(key));
      res.setHeader('Cache-Control', 'private, max-age=300');
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      stream.pipe(res);
    } catch (e: any) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  },
);

// POST logo — sube/reemplaza (admin). Multipart `file`.
router.post(
  '/organismos-config/:codigo/logo',
  requireRole('admin'),
  handleLogoUpload,
  async (req: Request, res: Response) => {
    try {
      const codigo = req.params.codigo.trim();
      if (!isKnownOrganismoCodigo(codigo)) {
        res.status(400).json({ error: 'Código de organismo inválido' });
        return;
      }
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'Falta el archivo del logo (campo "file")' });
        return;
      }
      const ext = LOGO_MIME.get(file.mimetype);
      if (!ext) {
        res.status(400).json({ error: 'Formato no permitido (use png, jpeg, webp o svg)' });
        return;
      }

      const prevKey = await getOrganismoLogoStorageKey(codigo);
      const key = await uploadEntityDocument(
        LOGO_PREFIX, `${codigo}/logo`, `logo.${ext}`, file.buffer, file.mimetype,
      );
      await setOrganismoLogoStorageKey(codigo, key);
      // Borra el anterior solo tras persistir la nueva key (evita dejar al organismo sin logo).
      if (prevKey && prevKey !== key) await deleteEntityDocument(prevKey);

      await audit(req, {
        action: 'update',
        resource: 'organismo_transito_config',
        resourceId: codigo,
        detail: 'Logo de organismo subido',
      });
      const updated = await getOrganismoConfig(codigo);
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  },
);

// DELETE logo subido (admin). No toca la URL externa legacy.
router.delete(
  '/organismos-config/:codigo/logo',
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const codigo = req.params.codigo.trim();
      if (!isKnownOrganismoCodigo(codigo)) {
        res.status(400).json({ error: 'Código de organismo inválido' });
        return;
      }
      const key = await getOrganismoLogoStorageKey(codigo);
      if (key) {
        await setOrganismoLogoStorageKey(codigo, null);
        await deleteEntityDocument(key);
        await audit(req, {
          action: 'update',
          resource: 'organismo_transito_config',
          resourceId: codigo,
          detail: 'Logo de organismo eliminado',
        });
      }
      const updated = await getOrganismoConfig(codigo);
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  },
);

export default router;
