// Certificación de impuesto sin trámite. Sub-router de impuestos, en archivo propio para el inventario.
// La puerta es `impuestos.certificacion_directa.gestionar`, no el rol.
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { CARGA_MASIVA_MAX_BYTES_ARCHIVO } from '@operaciones/shared-types';
import { audit } from '../../shared/middleware/audit.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { exigirFuncion } from '../../shared/middleware/exigir-funcion.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { loggerFor } from '../../shared/logger.js';
import { ImpuestoError, type ArchivoSubido, type ImpuestoCtx } from './flito-factura-venta.service.js';
import { construirCertificadoDirectoPdf } from './certificado-directo-pdf.js';
import { registrarAccesoImpuesto } from './flito-impuestos.pii.js';
import {
  actualizarCertificacionDirecta, bytesFacturaCertificacionDirecta, catalogoCertificacionDirecta,
  consultarRuntCertificacionDirecta, crearCertificacionDirecta, datosCertificadoDirecto,
  detalleCertificacionDirecta, listarCertificacionDirecta, sugerirDesdeFactura,
} from './flito-impuestos.certificacion-directa.service.js';

type Contexto = (user: NonNullable<Request['user']>) => Promise<ImpuestoCtx>;

const log = loggerFor('flito-impuestos.certificacion-directa');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CARGA_MASIVA_MAX_BYTES_ARCHIVO, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('La factura de venta debe ser un PDF'));
  },
});

const consultaLimiter = rateLimit({
  windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey('imp-cert-directa:'), store: makeStore('rl:imp-cert-directa:'),
  message: { error: 'Demasiadas consultas al RUNT. Espera un minuto.' },
});

// Topes por usuario y minuto (referencia vecina: análisis 10, recibo-reemplazo 30). La extracción llama al OCR
// de Anthropic (costo por llamada); la subida solo escribe a MinIO, por eso su tope es más laxo.
const extraerLimiter = rateLimit({
  windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey('imp-cert-directa-extraer:'), store: makeStore('rl:imp-cert-directa-extraer:'),
  message: { error: 'Demasiadas solicitudes. Espera un minuto.' },
});

const subidaLimiter = rateLimit({
  windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: userOrIpKey('imp-cert-directa-subida:'), store: makeStore('rl:imp-cert-directa-subida:'),
  message: { error: 'Demasiadas solicitudes. Espera un minuto.' },
});

/** Llega por multipart: ausente, vacío o solo espacios es «no diligenciado» y se guarda null. */
const opcional = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

const datosSchema = z.object({
  organismoCodigo: z.string().trim().min(1).max(5),
  placa: z.string().trim().min(1).max(10),
  documentoPropietario: opcional(30),
  nombrePropietario: opcional(200),
  vin: z.string().trim().min(1).max(17),
  marca: z.string().trim().min(1).max(60),
  linea: z.string().trim().min(1).max(80),
  anio: z.string().trim().regex(/^\d{4}$/),
  color: z.string().trim().min(1).max(60),
  cilindrada: z.string().trim().min(1).max(20),
});

function archivoDe(file: Express.Multer.File | undefined): ArchivoSubido | null {
  if (!file) return null;
  return { originalname: 'factura.pdf', mimetype: file.mimetype, buffer: file.buffer, size: file.size };
}

function recibirPdf(req: Request, res: Response, next: (e?: unknown) => void): void {
  upload.single('factura')(req, res, (err: unknown) => {
    if (!err) { next(); return; }
    const msg = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
      ? 'El archivo supera el tamaño máximo permitido'
      : 'La factura de venta debe ser un PDF';
    res.status(400).json({ error: msg });
  });
}

function fallar(res: Response, e: unknown): void {
  if (e instanceof ImpuestoError) { res.status(e.status).json({ error: e.message }); return; }
  log.error({ name: e instanceof Error ? e.name : 'error' }, 'certificacion directa');
  res.status(500).json({ error: 'No se pudo completar la operación' });
}

export default function certificacionDirectaRouter(_ctx: Contexto): Router {
  const router = Router();
  router.use(authMiddleware);

  router.get('/certificacion-directa/catalogo', exigirFuncion('impuestos.certificacion_directa.gestionar'), async (_req, res) => {
    res.json(await catalogoCertificacionDirecta());
  });

  router.post('/certificacion-directa/extraer', exigirFuncion('impuestos.certificacion_directa.gestionar'), extraerLimiter, recibirPdf, async (req, res) => {
    const archivo = archivoDe(req.file);
    if (!archivo) { res.status(400).json({ error: 'Falta la factura de venta' }); return; }
    try { res.json(await sugerirDesdeFactura(archivo)); } catch (e) { fallar(res, e); }
  });

  router.get('/certificacion-directa', exigirFuncion('impuestos.certificacion_directa.gestionar'), async (req, res) => {
    res.json(await listarCertificacionDirecta(req));
  });

  router.post('/certificacion-directa', exigirFuncion('impuestos.certificacion_directa.gestionar'), subidaLimiter, recibirPdf, async (req, res) => {
    const parsed = datosSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Revisa los datos del formulario' }); return; }
    const archivo = archivoDe(req.file);
    if (!archivo) { res.status(400).json({ error: 'Falta la factura de venta' }); return; }
    try { res.status(201).json(await crearCertificacionDirecta(parsed.data, archivo, req.user!.sub)); }
    catch (e) { fallar(res, e); }
  });

  router.get('/certificacion-directa/:id/factura', exigirFuncion('impuestos.certificacion_directa.gestionar'), async (req, res) => {
    try {
      const { bytes, placa } = await bytesFacturaCertificacionDirecta(req.params.id, req);
      const nombre = `factura-${placa.replace(/[^A-Za-z0-9]/g, '')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      res.send(bytes);
    } catch (e) { fallar(res, e); }
  });

  router.get('/certificacion-directa/:id/certificado', exigirFuncion('impuestos.certificacion_directa.gestionar'), async (req, res) => {
    try {
      const { fila, snapshot, organismo } = await datosCertificadoDirecto(req.params.id);
      const pdf = await construirCertificadoDirectoPdf({
        placa: fila.placa, vin: fila.vin, documento: fila.documentoPropietario,
        nombrePropietario: fila.nombrePropietario, organismo,
        // De lo congelado, no de la fila: un certificado anterior tiene documento y se consultó por VIN.
        modalidadConsulta: snapshot.modalidadConsulta ?? 'vin',
        campos: snapshot.campos, registroRunt: snapshot.registroRunt,
        certificadoPorNombre: fila.certificadoPorNombre ?? 'FLITO',
        certificadoEn: fila.certificadoEn!, generadoPor: req.user!.username, generadoEn: new Date(),
      });
      await registrarAccesoImpuesto(req, {
        accion: 'export', impuestoId: fila.id, filas: 1, archivo: 'certificado_runt',
        campos: ['placa', 'vin', 'documento_propietario', 'nombre_propietario'],
      });
      const nombre = `certificado-runt-${fila.placa.replace(/[^A-Za-z0-9]/g, '')}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      res.send(pdf);
    } catch (e) { fallar(res, e); }
  });

  router.post('/certificacion-directa/:id/consultar', exigirFuncion('impuestos.certificacion_directa.gestionar'), consultaLimiter, async (req, res) => {
    try {
      const { fila, modalidad } = await consultarRuntCertificacionDirecta(req.params.id, {
        userId: req.user!.sub, username: req.user!.username,
      });
      // Cada consulta manda datos del titular a un tercero: queda quién la ordenó. Sin placa, documento, nombre ni VIN.
      await audit(req, {
        action: 'update', resource: 'flito_impuesto', resourceId: req.params.id,
        detail: `Consulta RUNT sin trámite (modalidad ${modalidad}, estado ${fila.estado})`,
      });
      res.json(fila);
    } catch (e) { fallar(res, e); }
  });

  router.get('/certificacion-directa/:id', exigirFuncion('impuestos.certificacion_directa.gestionar'), async (req, res) => {
    try { res.json(await detalleCertificacionDirecta(req.params.id, req)); } catch (e) { fallar(res, e); }
  });

  router.patch('/certificacion-directa/:id', exigirFuncion('impuestos.certificacion_directa.gestionar'), subidaLimiter, recibirPdf, async (req, res) => {
    const parsed = datosSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Revisa los datos del formulario' }); return; }
    try {
      res.json(await actualizarCertificacionDirecta(req.params.id, parsed.data, archivoDe(req.file)));
    } catch (e) { fallar(res, e); }
  });

  return router;
}
