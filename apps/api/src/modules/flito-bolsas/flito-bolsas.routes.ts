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
  bolsaDe, BolsaError, bolsaSimbolicaDe, cerrarPeriodo, cierresDe, corregirMovimiento, extractoDe,
  movimientosDe, registrarMovimientoManual, registrarPagoOrganismo, registrarRecarga,
  saldoConsolidado,
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
//
// El encabezado `Idempotency-Key` también es OBLIGATORIO. El libro es append-only: un doble clic o
// un reintento de red acreditarían el dinero dos veces y la única corrección posible sería otro
// movimiento. Se exige en vez de aceptarlo opcional porque un opcional solo protege a quien lo
// manda, y aquí lo que hay que proteger es el saldo del cliente. Reenviar la misma clave devuelve
// 200 con el movimiento original; una recarga nueva devuelve 201.
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

  const clave = claveIdempotencia(req);
  if (clave === null) {
    res.status(400).json({ error: 'Falta el encabezado Idempotency-Key' });
    return;
  }

  const ctx = { userId: req.user?.sub ?? null, nombre: req.user?.username ?? 'sistema' };
  let storageKey: string | null = null;
  try {
    const companiaId = companiaIdDe(req);
    const invalido = await checkMagicNumber(req.file.buffer, req.file.mimetype, MIMES_SOPORTE);
    if (invalido) { res.status(400).json({ error: invalido }); return; }

    storageKey = await subirComprobante(companiaId, req.file);
    const { movimiento, saldo, duplicado } = await registrarRecarga(
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
        claveIdempotencia: clave,
      },
      ctx,
    );

    if (duplicado) {
      // El reenvío no acreditó nada, así que su comprobante sobra: el movimiento original conserva
      // el suyo. Sin esto, cada reintento dejaría una copia del archivo en el almacenamiento.
      await deleteEntityDocument(storageKey).catch(() => undefined);
      res.status(200).json({ movimiento, saldo, duplicado: true });
      return;
    }

    await audit(req, {
      action: 'create', resource: 'flito_bolsa_movimiento', resourceId: movimiento.id,
      detail: `Recarga de ${movimiento.valor} en la bolsa de la compañía ${companiaId}: saldo ${saldo}`,
    });
    res.status(201).json({ movimiento, saldo, duplicado: false });
  } catch (e) {
    // El objeto ya está en el almacenamiento pero la transacción del dinero no cuajó: sin esto
    // quedaría un archivo huérfano de hasta 15 MB por cada recarga fallida.
    if (storageKey) await deleteEntityDocument(storageKey).catch(() => undefined);
    fallo(res, e);
  }
});

/**
 * Clave del encabezado `Idempotency-Key`, o `null` si falta o viene vacía. Se acota a 120 caracteres
 * porque el prefijo y el id de compañía deben caber junto a ella en `varchar(200)`.
 */
function claveIdempotencia(req: Request): string | null {
  const bruto = req.get('Idempotency-Key');
  if (typeof bruto !== 'string') return null;
  const clave = bruto.trim();
  if (clave.length === 0 || clave.length > 120) return null;
  return clave;
}

// GET /organismos/:organismoCodigo — estado de cuenta (bolsa simbólica) del organismo.
// Antes de /:companiaId por la misma razón que /consolidado: «organismos» no es un id de compañía.
router.get('/organismos/:organismoCodigo', BOLSAS, async (req: Request, res: Response) => {
  res.json(await bolsaSimbolicaDe(req.params.organismoCodigo));
});

// POST /organismos/:organismoCodigo/pagos — pago de FLIT al organismo (multipart, soporte opcional).
//
// El soporte es OPCIONAL aquí, a diferencia de las recargas: un pago a un organismo puede registrarse
// el mismo día en que se ordena la transferencia, antes de que llegue el comprobante del banco.
const pagoOrganismoSchema = z.object({
  valor: z.coerce
    .number({ invalid_type_error: 'El valor del pago debe ser mayor que cero' })
    .positive({ message: 'El valor del pago debe ser mayor que cero' }),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  observacion: z.string().trim().max(1000).optional(),
});

router.post('/organismos/:organismoCodigo/pagos', BOLSAS, recibirSoporte, async (req: Request, res: Response) => {
  const parsed = pagoOrganismoSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
    return;
  }

  const ctx = { userId: req.user?.sub ?? null, nombre: req.user?.username ?? 'sistema' };
  let storageKey: string | null = null;
  try {
    if (req.file) {
      const invalido = await checkMagicNumber(req.file.buffer, req.file.mimetype, MIMES_SOPORTE);
      if (invalido) { res.status(400).json({ error: invalido }); return; }
      storageKey = await uploadEntityDocument(
        `organismos/${req.params.organismoCodigo}/pagos`,
        req.params.organismoCodigo, req.file.originalname, req.file.buffer, req.file.mimetype,
      );
    }

    const { id, saldoPendiente } = await registrarPagoOrganismo(
      req.params.organismoCodigo,
      {
        valor: parsed.data.valor,
        fecha: parsed.data.fecha,
        observacion: parsed.data.observacion ?? null,
        soporte: req.file && storageKey ? {
          nombreArchivo: req.file.originalname,
          contentType: req.file.mimetype,
          storageKey,
          hash: createHash('sha256').update(req.file.buffer).digest('hex'),
          tamanoBytes: req.file.size,
        } : null,
      },
      ctx,
    );
    await audit(req, {
      action: 'create', resource: 'flito_organismo_pago', resourceId: id,
      detail: `Pago de ${parsed.data.valor} al organismo ${req.params.organismoCodigo}: pendiente ${saldoPendiente}`,
    });
    res.status(201).json({ id, saldoPendiente });
  } catch (e) {
    if (storageKey) await deleteEntityDocument(storageKey).catch(() => undefined);
    fallo(res, e);
  }
});

// GET /:companiaId/extracto — saldo con el consumo desglosado por organismo y por concepto.
router.get('/:companiaId/extracto', BOLSAS, async (req: Request, res: Response) => {
  const parsed = filtroSchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Filtros inválidos' }); return; }
  try {
    res.json(await extractoDe(companiaIdDe(req), parsed.data.periodo));
  } catch (e) { fallo(res, e); }
});

// POST /:companiaId/movimientos-manuales — contingencia registrada por Financiera (multipart).
//
// La evidencia es obligatoria, igual que en las recargas: un movimiento de dinero que una persona
// decide sin dejar respaldo no es auditable, y el Feature la exige entre los campos de todo
// movimiento manual (§5).
const manualSchema = z.object({
  tipo: z.enum(['entrada', 'salida']),
  valor: z.coerce
    .number({ invalid_type_error: 'El valor del movimiento debe ser mayor que cero' })
    .positive({ message: 'El valor del movimiento debe ser mayor que cero' }),
  motivo: z.string().trim().min(5, { message: 'Indica el motivo del movimiento' }).max(1000),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  concepto: z.enum(['derecho', 'soat', 'impuesto', 'tramite_digital', 'logistica']).optional(),
  organismoCodigo: z.string().trim().max(5).optional(),
});

router.post('/:companiaId/movimientos-manuales', BOLSAS, recibirSoporte, async (req: Request, res: Response) => {
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
    return;
  }
  if (!req.file) { res.status(400).json({ error: 'Adjunta la evidencia del movimiento' }); return; }

  const ctx = { userId: req.user?.sub ?? null, nombre: req.user?.username ?? 'sistema' };
  let storageKey: string | null = null;
  try {
    const companiaId = companiaIdDe(req);
    const invalido = await checkMagicNumber(req.file.buffer, req.file.mimetype, MIMES_SOPORTE);
    if (invalido) { res.status(400).json({ error: invalido }); return; }

    storageKey = await subirComprobante(companiaId, req.file);
    const { movimiento, saldo } = await registrarMovimientoManual(
      companiaId,
      {
        tipo: parsed.data.tipo,
        valor: parsed.data.valor,
        motivo: parsed.data.motivo,
        fecha: parsed.data.fecha,
        concepto: parsed.data.concepto ?? null,
        organismoCodigo: parsed.data.organismoCodigo ?? null,
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
      detail: `Movimiento manual (${movimiento.tipo}) de ${movimiento.valor} en la bolsa de la compañía ${companiaId}: saldo ${saldo}`,
    });
    res.status(201).json({ movimiento, saldo });
  } catch (e) {
    if (storageKey) await deleteEntityDocument(storageKey).catch(() => undefined);
    fallo(res, e);
  }
});

// POST /:companiaId/movimientos/:movimientoId/correccion — corrige el valor de un movimiento manual.
//
// No edita la fila original: asienta un ajuste que la referencia. Un movimiento automático se
// rechaza aquí (409) y se corrige con un movimiento manual suelto.
const correccionSchema = z.object({
  valor: z.coerce
    .number({ invalid_type_error: 'El valor corregido debe ser mayor que cero' })
    .positive({ message: 'El valor corregido debe ser mayor que cero' }),
  motivo: z.string().trim().min(5, { message: 'Indica el motivo del movimiento' }).max(1000),
});

router.post('/:companiaId/movimientos/:movimientoId/correccion', BOLSAS, async (req: Request, res: Response) => {
  const parsed = correccionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
    return;
  }
  try {
    const { correccion, saldo } = await corregirMovimiento(
      req.params.movimientoId,
      parsed.data.valor,
      parsed.data.motivo,
      { userId: req.user?.sub ?? null, nombre: req.user?.username ?? 'sistema' },
    );
    await audit(req, {
      action: 'update', resource: 'flito_bolsa_movimiento', resourceId: correccion.id,
      detail: `Corrección del movimiento ${req.params.movimientoId}: saldo ${saldo}`,
    });
    res.status(201).json({ correccion, saldo });
  } catch (e) { fallo(res, e); }
});

// GET /:companiaId/cierres — reportes de cierre del cliente, del más reciente al más antiguo.
router.get('/:companiaId/cierres', BOLSAS, async (req: Request, res: Response) => {
  try {
    res.json(await cierresDe(companiaIdDe(req)));
  } catch (e) { fallo(res, e); }
});

// POST /:companiaId/cierres — cierra un periodo. Congela sus movimientos y sella el reporte.
//
// Es una acción irreversible: no hay endpoint para reabrir. Un periodo cerrado por error se corrige
// con movimientos de ajuste en el periodo abierto (HU #11123), no deshaciendo el cierre, que es
// justo lo que un documento de auditoría no debe permitir.
const cierreSchema = z.object({
  periodo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'El periodo debe tener la forma AAAA-MM' }),
  observaciones: z.string().trim().max(2000).optional(),
});
router.post('/:companiaId/cierres', BOLSAS, async (req: Request, res: Response) => {
  const parsed = cierreSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
    return;
  }
  try {
    const companiaId = companiaIdDe(req);
    const ctx = { userId: req.user?.sub ?? null, nombre: req.user?.username ?? 'sistema' };
    const cierre = await cerrarPeriodo(companiaId, parsed.data.periodo, parsed.data.observaciones ?? null, ctx);
    await audit(req, {
      action: 'create', resource: 'flito_bolsa_cierre', resourceId: cierre.id,
      detail: `Cierre de ${cierre.periodo} para la compañía ${companiaId}: entradas ${cierre.totalEntradas}, salidas ${cierre.totalSalidas}, saldo final ${cierre.saldoFinal}`,
    });
    res.status(201).json(cierre);
  } catch (e) { fallo(res, e); }
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
