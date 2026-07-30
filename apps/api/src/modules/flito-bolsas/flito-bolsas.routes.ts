// FLITO — bolsas prepago del cliente (HTTP). Montado en /api/flito/bolsas.
//
// La bolsa es dinero: solo Administración y Financiera la ven y la mueven (Feature #11120 §9).
// A diferencia de la liquidación, aquí NO se abre lectura a auditoría — el Feature es explícito en
// que ningún otro rol accede a los movimientos crudos, y el consolidado para los demás roles llega
// como reporte en una HU posterior.

import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { clients } from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { carpetaDe } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { checkMagicNumber } from '../pesv/magic-number.js';
import { deleteEntityDocument, uploadEntityDocument } from '../../services/storage.js';
import {
  bolsaDe, BolsaError, movimientosDe, registrarRecarga, saldoConsolidado,
} from './flito-bolsas.service.js';

const router = Router();
router.use(authMiddleware);

const BOLSAS = requireRole('admin', 'financiera');

/**
 * El comprobante de una recarga es un PDF o una imagen del soporte bancario. La lista blanca la
 * comparten los módulos hermanos que suben soportes (derechos, impuestos, SOAT).
 */
const MIMES_SOPORTE = ['application/pdf', 'image/jpeg', 'image/png'] as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  // Sin este filtro, el content-type que declara el cliente viaja intacto hasta el almacenamiento y
  // hasta `flito_soportes`, y quien luego descargue el archivo lo recibiría con ese tipo. Un .html
  // subido como tal se convertiría en XSS almacenado en el mismo origen que la app.
  fileFilter: (_req, file, cb) => {
    if ((MIMES_SOPORTE as readonly string[]).includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

/**
 * Envuelve a multer para que sus rechazos —tipo no permitido, archivo por encima de 15 MB— salgan
 * como 400 con el motivo, y no como el 500 genérico del error handler. Quien sube un comprobante
 * equivocado necesita saber qué pasó, no un «error interno».
 */
function recibirSoporte(req: Request, res: Response, next: (e?: unknown) => void): void {
  upload.single('soporte')(req, res, (err: unknown) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Soporte inválido' });
      return;
    }
    next();
  });
}

/** BolsaError es de negocio; lo demás sube al error handler. */
function fallo(res: Response, e: unknown): void {
  if (e instanceof BolsaError) {
    res.status(e.estado).json({ error: e.message });
    return;
  }
  throw e;
}

function companiaIdDe(req: Request): number {
  const id = Number(req.params.companiaId);
  if (!Number.isInteger(id) || id <= 0) throw new BolsaError('Compañía inválida');
  return id;
}

// GET /consolidado — saldo agregado de todas las bolsas. Antes de /:companiaId para que
// «consolidado» no se lea como un id de compañía.
router.get('/consolidado', BOLSAS, async (_req: Request, res: Response) => {
  res.json(await saldoConsolidado());
});

// GET /:companiaId — bolsa y saldo del cliente.
router.get('/:companiaId', BOLSAS, async (req: Request, res: Response) => {
  try {
    const bolsa = await bolsaDe(companiaIdDe(req));
    // Sin bolsa no es un error: es un cliente que todavía no ha recibido su primera recarga.
    if (!bolsa) { res.status(404).json({ error: 'El cliente aún no tiene bolsa' }); return; }
    res.json(bolsa);
  } catch (e) { fallo(res, e); }
});

// GET /:companiaId/movimientos — libro de la bolsa.
const filtroSchema = z.object({
  periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  limite: z.coerce.number().int().positive().max(500).optional(),
});
router.get('/:companiaId/movimientos', BOLSAS, async (req: Request, res: Response) => {
  const parsed = filtroSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Filtros inválidos' }); return; }
  try {
    res.json(await movimientosDe(companiaIdDe(req), parsed.data));
  } catch (e) { fallo(res, e); }
});

// POST /:companiaId/recargas — registra una recarga con su soporte (multipart).
//
// El soporte es obligatorio: una entrada de dinero sin comprobante no es auditable, y el Feature lo
// exige entre los campos de toda entrada (§2.1).
const recargaSchema = z.object({
  // `invalid_type_error` para que un valor no numérico devuelva el mensaje de negocio y no el
  // «Expected number, received nan» de zod, que es lo que acabaría viendo el operador.
  valor: z.coerce
    .number({ invalid_type_error: 'El valor de la recarga debe ser mayor que cero' })
    .positive({ message: 'El valor de la recarga debe ser mayor que cero' }),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  observacion: z.string().trim().max(1000).optional(),
});

router.post('/:companiaId/recargas', BOLSAS, recibirSoporte, async (req: Request, res: Response) => {
  const parsed = recargaSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'Datos inválidos';
    res.status(400).json({ error: msg });
    return;
  }
  if (!req.file) { res.status(400).json({ error: 'Adjunta el soporte de la recarga' }); return; }

  const ctx = { userId: req.user?.sub ?? null, nombre: req.user?.username ?? 'sistema' };
  let storageKey: string | null = null;
  try {
    const companiaId = companiaIdDe(req);
    const invalido = await checkMagicNumber(req.file.buffer, req.file.mimetype, MIMES_SOPORTE);
    if (invalido) { res.status(400).json({ error: invalido }); return; }

    storageKey = await subirComprobante(companiaId, req.file);
    const { movimiento, saldo } = await registrarRecarga(
      companiaId,
      {
        valor: parsed.data.valor,
        fecha: parsed.data.fecha,
        observacion: parsed.data.observacion ?? null,
        soporte: {
          nombreArchivo: req.file.originalname,
          contentType: req.file.mimetype,
          storageKey,
          hash: createHash('sha256').update(req.file.buffer).digest('hex'),
          tamanoBytes: req.file.size,
        },
      },
      ctx,
    );

    await audit(req, {
      action: 'create', resource: 'flito_bolsa_movimiento', resourceId: movimiento.id,
      detail: `Recarga de ${movimiento.valor} en la bolsa de la compañía ${companiaId}: saldo ${saldo}`,
    });
    res.status(201).json({ movimiento, saldo });
  } catch (e) {
    // El objeto ya está en el almacenamiento pero la transacción del dinero no cuajó: sin esto
    // quedaría un archivo huérfano de hasta 15 MB por cada recarga fallida.
    if (storageKey) await deleteEntityDocument(storageKey).catch(() => undefined);
    fallo(res, e);
  }
});

/** Sube el comprobante al almacenamiento. El registro en `flito_soportes` lo hace el servicio. */
async function subirComprobante(companiaId: number, archivo: Express.Multer.File): Promise<string> {
  const [compania] = await db
    .select({ id: clients.id, document: clients.document, flitoCarpetaStorage: clients.flitoCarpetaStorage })
    .from(clients)
    .where(eq(clients.id, companiaId))
    .limit(1);
  if (!compania) throw new BolsaError('La compañía no existe', 404);

  return uploadEntityDocument(
    carpetaDe(compania, 'bolsas-recargas'),
    companiaId, archivo.originalname, archivo.buffer, archivo.mimetype,
  );
}

export default router;
