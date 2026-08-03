// FLITO Impuestos (HTTP). Porta packages/server/src/impuestos/impuestos.controlador.ts. Montado en
// /api/flito/impuestos; coexiste con /api/tramites del grande.
//
// Fase 4 P1: factura de venta (precondición del envío). Cola/envío (P2) y recibos (P3) llegan después.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { historialDe } from '../../shared/historial/estado-historial.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { EstadoImpuesto, ResultadoCertificacion } from '@operaciones/shared-types';
import { ImpuestoError, type ArchivoSubido, type ImpuestoCtx } from './flito-factura-venta.service.js';
import { certificacionVigenteConAcceso, certificarImpuesto, certificarLote } from './certificacion.service.js';
import { construirCertificadoPdf } from './certificado-pdf.js';
import {
  asumirEnOperaciones, colaImpuestos, devolverAlGestor, facetasColaImpuestos, detalleImpuesto, enviarAlGestor,
  facturaVentaFlitIdConAcceso, reactivar, rechazar, reversar,
} from './flito-impuestos.service.js';
import { cargarRecibos } from './flito-recibos.service.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import { getFlitAdapter } from '../flito-sync/flit.adapter.js';

const router = Router();
router.use(authMiddleware);

const OPERACIONES = requireRole('admin');
const LECTURA = requireRole('admin', 'gestor_impuestos', 'auditor');
const OPS_O_GESTOR = requireRole('admin', 'gestor_impuestos');
const ESTADOS = ['pendiente', 'solicitado', 'con_novedad', 'pagado'] as const;

const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'application/zip', 'application/x-zip-compressed'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    const ok = MIMES.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip');
    if (ok) cb(null, true); else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

const aArchivo = (f: Express.Multer.File): ArchivoSubido => ({ originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer, size: f.size });

/**
 * Contexto del gestor de impuestos: la atadura de visibilidad por organismo vive en
 * users.transito_codigo (§9.3), leída de BD, no del JWT. Para el resto de roles es null.
 */
export async function contextoImpuesto(user: { sub: number; username: string; role: string }): Promise<ImpuestoCtx> {
  let transitoCodigo: string | null = null;
  if (user.role === 'gestor_impuestos') {
    const [u] = await db.select({ t: users.transitoCodigo }).from(users).where(eq(users.id, user.sub)).limit(1);
    transitoCodigo = u?.t ?? null;
  }
  return { userId: user.sub, username: user.username, role: user.role, transitoCodigo };
}

function handleError(res: Response, e: unknown): void {
  if (e instanceof ImpuestoError) { res.status(e.status).json({ error: e.message }); return; }
  if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// GET /:id/factura-venta — ver/descargar la factura de venta (viene de FLIT, S3). Redirige a la URL
// prefirmada. Operaciones o gestor de impuestos (respeta la frontera del gestor). Integración FLIT.
router.get('/:id/factura-venta', OPS_O_GESTOR, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const facturaId = await facturaVentaFlitIdConAcceso(req.params.id, ctx);
  if (!facturaId) { res.status(404).json({ error: 'El trámite no tiene factura de venta en FLIT' }); return; }
  const url = await getFlitAdapter().obtenerUrlFactura(facturaId);
  if (!url) { res.status(404).json({ error: 'La factura de venta no está disponible en FLIT' }); return; }
  res.redirect(url);
});

// POST /facturas-venta/zip — descarga varias facturas de venta en un zip. Operaciones o gestor.
const zipSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });
router.post('/facturas-venta/zip', OPS_O_GESTOR, async (req: Request, res: Response) => {
  const parsed = zipSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const ctx = await contextoImpuesto(req.user!);
  const flit = getFlitAdapter();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="facturas-venta.zip"');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => { try { res.destroy(); } catch { /* ya cerrado */ } });
  archive.pipe(res);

  let incluidas = 0;
  for (const id of parsed.data.ids) {
    try {
      const facturaId = await facturaVentaFlitIdConAcceso(id, ctx);
      if (!facturaId) continue;
      const url = await flit.obtenerUrlFactura(facturaId);
      if (!url) continue;
      const r = await fetch(url);
      if (!r.ok) continue;
      archive.append(Buffer.from(await r.arrayBuffer()), { name: `${facturaId}.pdf` });
      incluidas += 1;
    } catch { /* omitir la factura fallida, no tumbar el zip */ }
  }
  await audit(req, { action: 'export', resource: 'flito_impuesto', detail: `Descarga zip de facturas de venta: ${incluidas}/${parsed.data.ids.length}` });
  await archive.finalize();
});

// Tras una mutación devolvemos el detalle; si el actor ya no puede verlo, confirmación mínima.
async function responderDetalle(res: Response, ctx: ImpuestoCtx, imp: { id: string; estado: string; motivoRechazo: string | null }): Promise<void> {
  const d = await detalleImpuesto(imp.id, ctx);
  res.json(d ?? { id: imp.id, estado: imp.estado, motivoRechazo: imp.motivoRechazo });
}

// Helpers de parseo. Un valor desconocido se IGNORA, no devuelve 400: un filtro roto no debe
// tumbar la pantalla de quien está trabajando.
const texto = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = texto(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};
const numeros = (v: unknown): number[] | undefined => {
  const l = lista(v)?.map(Number).filter((n) => Number.isFinite(n));
  return l?.length ? l : undefined;
};
/** Solo yyyy-mm-dd: el valor entra en un cast a `date` y no puede ser texto libre. */
const fecha = (v: unknown): string | undefined => {
  const s = texto(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
};

// GET / — cola con las 2 fronteras, filtrada y paginada.
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const estadoRaw = typeof req.query.estado === 'string' ? req.query.estado : undefined;
  const estados = estadoRaw
    ? estadoRaw.split(',').map((s) => s.trim()).filter((s): s is EstadoImpuesto => (ESTADOS as readonly string[]).includes(s))
    : undefined;
  const buscar = typeof req.query.buscar === 'string' ? req.query.buscar : undefined;
  res.json(await colaImpuestos(ctx, {
    estados, buscar,
    companias: numeros(req.query.companias),
    organismos: lista(req.query.organismos),
    // Un valor desconocido se ignora, como el resto de filtros: uno roto no tumba la pantalla.
    gestion: req.query.gestion === 'operaciones' || req.query.gestion === 'organismo' ? req.query.gestion : undefined,
    solicitadoDesde: fecha(req.query.solicitadoDesde), solicitadoHasta: fecha(req.query.solicitadoHasta),
    pagadoDesde: fecha(req.query.pagadoDesde), pagadoHasta: fecha(req.query.pagadoHasta),
    estancado: req.query.estancado === 'si',
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 50,
  }));
});

// GET /facetas — valores disponibles para los filtros, acotados a lo que el gestor puede ver.
// Antes de `/:id` para que «facetas» no se interprete como un identificador.
router.get('/facetas', LECTURA, async (req: Request, res: Response) => {
  res.json(await facetasColaImpuestos(await contextoImpuesto(req.user!)));
});

// GET /:id — detalle (404-no-403 para el gestor ajeno)
router.get('/:id', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const d = await detalleImpuesto(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El impuesto no existe' }); return; }
  res.json(d);
});

// GET /:id/historial — cambios de estado, del más reciente al más antiguo.
//
// Pasa por `detalleImpuesto()` antes de leer el historial: es lo que aplica la frontera del gestor
// (CA-10). Ir directo a la tabla dejaría que un gestor leyera la historia de otro organismo.
router.get('/:id/historial', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const d = await detalleImpuesto(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El impuesto no existe' }); return; }
  res.json(await historialDe('impuesto', req.params.id));
});

/**
 * POST /:id/certificar — contrasta el vehículo contra el RUNT y, si cuadra, deja el impuesto
 * certificado (HU #11165). Operaciones o gestor.
 *
 * Cinco desenlaces con código propio en el cuerpo, porque el gestor actúa distinto ante cada uno:
 *
 *   200 certificado                       → verificado, ya puede descargar el certificado
 *   409 con_diferencias                   → hay un dato malo; corregir y reintentar
 *   409 no_elegible                       → no aplica (estado, o falta placa/documento)
 *   409 traspaso_en_sincronizacion        → el RUNT aún no reconoce al propietario; esperar
 *   502 error_servicio                    → el RUNT no respondió; reintentar más tarde
 *
 * Los tres 409 comparten código HTTP porque todos son «el registro no está como para certificar
 * ahora», pero el campo `code` los separa sin ambigüedad: la interfaz NO debe distinguirlos por el
 * texto del mensaje.
 */
router.post('/:id/certificar', OPS_O_GESTOR, async (req: Request, res: Response) => {
  try {
    const ctx = await contextoImpuesto(req.user!);
    const r = await certificarImpuesto(req.params.id, ctx);

    switch (r.resultado) {
      case ResultadoCertificacion.CERTIFICADO:
        await audit(req, {
          action: 'update', resource: 'flito_impuesto', resourceId: req.params.id,
          detail: `Certificado contra RUNT (placa ${r.certificacion.placaConsultada})`,
        });
        res.json({ code: r.resultado, certificacion: r.certificacion });
        return;

      case ResultadoCertificacion.CON_DIFERENCIAS:
        res.status(409).json({
          code: r.resultado,
          error: 'Los datos del registro no coinciden con lo que reporta el RUNT.',
          campos: r.campos,
          diferenciasBloqueantes: r.diferenciasBloqueantes,
        });
        return;

      case ResultadoCertificacion.NO_ELEGIBLE:
        res.status(409).json({ code: r.resultado, error: r.mensaje, motivo: r.motivo });
        return;

      case ResultadoCertificacion.TRASPASO_EN_SINCRONIZACION:
        res.status(409).json({ code: r.resultado, error: r.mensaje });
        return;

      case ResultadoCertificacion.ERROR_SERVICIO:
        res.status(502).json({ code: r.resultado, error: r.mensaje });
        return;
    }
  } catch (e) { handleError(res, e); }
});

/**
 * POST /certificar — certificación MASIVA de los registros seleccionados (HU #11166).
 *
 * Siempre 200 cuando el lote es admisible: el desenlace vive POR REGISTRO, no en el código HTTP. Un
 * lote donde nueve certifican y uno falla no es «un error», y devolver 4xx por el que falló
 * escondería los nueve que sí quedaron.
 *
 * El tope se valida en el borde con el mismo número que conoce la interfaz
 * (`TOPE_LOTE_CERTIFICACION` en shared-types), y ahí sí es 400: pedir 40 registros no es un lote que
 * salió regular, es una petición que no se debe intentar.
 *
 * Ojo con el orden de las rutas: `/certificar` se registra DESPUÉS de `/:id/certificar`, pero no
 * colisionan porque tienen distinto número de segmentos.
 */
const certificarLoteSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
router.post('/certificar', OPS_O_GESTOR, async (req: Request, res: Response) => {
  const parsed = certificarLoteSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'No se seleccionó ningún impuesto.' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const resultados = await certificarLote(parsed.data.ids, ctx);

    const certificados = resultados.filter((r) => r.resultado === ResultadoCertificacion.CERTIFICADO);
    if (certificados.length > 0) {
      await audit(req, {
        action: 'update', resource: 'flito_impuesto',
        resourceId: certificados.map((r) => r.id).join(','),
        detail: `Certificación masiva contra RUNT: ${certificados.length}/${resultados.length}`,
      });
    }
    res.json({ total: resultados.length, certificados: certificados.length, resultados });
  } catch (e) { handleError(res, e); }
});

/**
 * GET /:id/certificado — certificado PDF de la verificación contra el RUNT (HU #11167).
 *
 * Se genera EN CALIENTE y no se almacena (RN-11): ni fila en `flito_soportes` ni objeto en S3. Los
 * bytes salen de la certificación persistida, así que descargarlo NO vuelve a consultar el RUNT —que
 * se cobra por consulta en modo directo— y dos descargas del mismo certificado dicen exactamente lo
 * mismo, salvo la hora de generación.
 *
 * 409 y no 404 cuando el impuesto existe pero no está certificado: el registro está ahí, lo que falta
 * es el paso previo. El 404 queda para lo que de verdad no es accesible.
 */
router.get('/:id/certificado', OPS_O_GESTOR, async (req: Request, res: Response) => {
  try {
    const ctx = await contextoImpuesto(req.user!);
    const cert = await certificacionVigenteConAcceso(req.params.id, ctx);
    if (!cert) {
      res.status(409).json({ error: 'El impuesto no tiene una certificación vigente.', code: 'sin_certificacion' });
      return;
    }

    const pdf = await construirCertificadoPdf({
      placaConsultada: cert.placaConsultada,
      documentoConsultado: cert.documentoConsultado,
      tipoDocPropietario: cert.tipoDocPropietario,
      propietarioNombre: cert.propietarioNombre,
      campos: cert.campos,
      certificadoPorNombre: cert.certificadoPorNombre,
      certificadoEn: new Date(cert.createdAt),
      generadoPor: ctx.username,
      generadoEn: new Date(),
    });

    // Auditar ANTES de escribir la respuesta: `audit` se traga sus errores, pero si algo se cayera
    // después de mandar los bytes ya no habría forma de dejar rastro de una descarga que sí ocurrió.
    await audit(req, {
      action: 'export', resource: 'flito_impuesto', resourceId: req.params.id,
      detail: `Descarga del certificado RUNT (placa ${cert.placaConsultada}, certificación ${cert.id})`,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificado-runt-${cert.placaConsultada}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (e) { handleError(res, e); }
});

// POST /enviar — Pendiente → En gestión, atómico (CA-04). Solo Operaciones.
const enviarSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  // Sin XOR, a diferencia de SOAT: aquí no hay proveedor con el que competir, el destinatario
  // sale del organismo. La contingencia es solo una marca más sobre el mismo envío.
  gestionOperaciones: z.boolean().optional(),
});
router.post('/enviar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = enviarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const ctx = await contextoImpuesto(req.user!);
  const { ids, gestionOperaciones } = parsed.data;
  const resultado = await enviarAlGestor(ids, ctx, gestionOperaciones);
  if (resultado.enviados.length > 0) {
    const destino = gestionOperaciones ? 'gestión de Operaciones' : 'gestor del organismo';
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: resultado.enviados.join(','), detail: `Enviados a ${destino}: ${resultado.enviados.length} (pendiente→en_gestion)` });
  }
  res.json(resultado);
});

// POST /:id/asumir-operaciones y POST /:id/devolver-gestor — traspaso por contingencia (HU #11155).
// Solo Operaciones, motivo ≥5 como la reversa. El de devolver NO recibe destinatario: el organismo
// nunca cambió, así que quitar la marca ya lo devuelve a quien le corresponde.
const traspasoSchema = z.object({
  motivo: z.string().min(5, 'El traspaso de gestión exige un motivo que explique el porqué'),
});
for (const [ruta, accion, etiqueta] of [
  ['asumir-operaciones', asumirEnOperaciones, 'Gestión asumida por Operaciones'],
  ['devolver-gestor', devolverAlGestor, 'Gestión devuelta al gestor del organismo'],
] as const) {
  router.post(`/:id/${ruta}`, OPERACIONES, async (req: Request, res: Response) => {
    const parsed = traspasoSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
    try {
      const ctx = await contextoImpuesto(req.user!);
      const imp = await accion(req.params.id, parsed.data.motivo, ctx);
      await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: imp.id, detail: `${etiqueta}: ${parsed.data.motivo.trim()}` });
      await responderDetalle(res, ctx, imp);
    } catch (e) { handleError(res, e); }
  });
}

const motivoSchema = z.object({ motivo: z.string().min(1, 'El motivo es obligatorio') });

// POST /:id/rechazar — rechazo del gestor. Operaciones o gestor.
router.post('/:id/rechazar', OPS_O_GESTOR, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const imp = await rechazar(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: imp.id, detail: `Rechazo: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, imp);
  } catch (e) { handleError(res, e); }
});

// POST /:id/reactivar — Rechazado → Pendiente. Solo Operaciones.
router.post('/:id/reactivar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const imp = await reactivar(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: imp.id, detail: `Reactivación (rechazado→pendiente): ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, imp);
  } catch (e) { handleError(res, e); }
});

// POST /:id/reversar — reversa manual. Solo Operaciones, motivo ≥5.
const reversarSchema = z.object({
  estadoDestino: z.enum([EstadoImpuesto.PENDIENTE, EstadoImpuesto.SOLICITADO, EstadoImpuesto.CON_NOVEDAD, EstadoImpuesto.PAGADO]),
  motivo: z.string().min(5, 'La reversa exige un motivo que explique el porqué'),
});
router.post('/:id/reversar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = reversarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoImpuesto(req.user!);
    const imp = await reversar(req.params.id, parsed.data.estadoDestino, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_impuesto', resourceId: imp.id, detail: `Reversa → ${parsed.data.estadoDestino}: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, imp);
  } catch (e) { handleError(res, e); }
});

// POST /recibos — carga MASIVA de recibos de pago → Pagado (con/sin marca de agua). Operaciones o
// gestor. `sinMarcaDeAgua` (campo del form) es el defecto para archivos sueltos; en ZIP la copia se
// deduce de la carpeta.
router.post('/recibos', OPS_O_GESTOR, upload.array('archivos', 50), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo' }); return; }
  const sinMarca = req.body?.sinMarcaDeAgua === 'true' || req.body?.sinMarcaDeAgua === true;
  try {
    const ctx = await contextoImpuesto(req.user!);
    const resultado = await cargarRecibos(files.map(aArchivo), sinMarca, ctx);
    await audit(req, { action: 'upload', resource: 'flito_impuesto', detail: `Carga masiva recibos: ${resultado.conciliados.length} conciliados, ${resultado.enRevision.length} en revisión, ${resultado.complementos.length} complementos, ${resultado.duplicados.length} duplicados, ${resultado.noAsociados.length} sin asociar` });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

export default router;
