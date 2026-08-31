// FLITO Impuestos (HTTP). Porta packages/server/src/impuestos/impuestos.controlador.ts. Montado en
// /api/flito/impuestos; coexiste con /api/tramites del grande.
//
// Fase 4 P1: factura de venta (precondición del envío). Cola/envío (P2) y recibos (P3) llegan después.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { historialDe } from '../../shared/historial/estado-historial.js';
import { sendExcel } from '../../shared/utils/excel.js';
import {
  COLUMNAS_COLA_EXPORT, ExportColaDemasiadoGrandeError, exportColaLimiter,
} from '../../shared/export/cola-flito-excel.js';
import {
  CAMPOS_PII_IMPUESTO_EXPORT, registrarAccesoImpuesto,
} from './flito-impuestos.pii.js';
import {
  CAMPOS_PII_ZIP_SOPORTES, comprobarTopeRegistrosZip, emitirZipSoportes, nombrePlacaOrganismo,
  resolverEntradasZip, tipoPorBytes, ZipError, zipSoportesLimiter,
} from '../../shared/soportes/soportes-zip.js';
import {
  construirFilasExportImpuestos, nombreArchivoExportImpuestos,
} from './flito-impuestos.export.service.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { EstadoImpuesto, ResultadoCertificacion, TipoSoporteZip } from '@operaciones/shared-types';
import { ImpuestoError, type ArchivoSubido, type ImpuestoCtx } from './flito-factura-venta.service.js';
import { certificacionVigenteConAcceso, certificarImpuesto, certificarLote } from './certificacion.service.js';
import { construirCertificadoPdf } from './certificado-pdf.js';
import {
  asumirEnOperaciones, colaImpuestos, devolverAlGestor, facetasColaImpuestos, detalleImpuesto, enviarAlGestor,
  facturaVentaFlitConAcceso, reactivar, rechazar, registrosZipImpuestos, reversar,
} from './flito-impuestos.service.js';
import { soportesDeImpuesto } from '../../shared/soportes/soportes-consulta.js';
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

/**
 * GET /:id/factura-venta — ver/descargar la factura de venta (viene de FLIT, S3).
 *
 * La API sirve el fichero en vez de redirigir a la URL prefirmada, y esa es la diferencia entre un
 * PDF y un archivo sin extensión. S3 entrega el objeto como `binary/octet-stream` y con el id de
 * S3 por nombre: el navegador guardaba «a3f9c1…» sin extensión, que no abre con doble clic y hay
 * que renombrar a mano. Al pasar por aquí ponemos las dos cosas que faltaban —`application/pdf` y
 * un nombre con `.pdf`— y el archivo se descarga como lo que es.
 *
 * El tipo se decide por los bytes, no por lo que diga el origen: si el fichero empieza por `%PDF`
 * es un PDF aunque venga rotulado como octet-stream, y si resulta ser una imagen se sirve como
 * imagen en vez de mentir con un `.pdf` que ningún visor podría abrir.
 *
 * **El NOMBRE cambia en la HU #11910: `PLACA-ORGANISMO.<ext>`, no `factura-venta-<idFlit>.pdf`.**
 * El AC5 pide ese nombre «también en la descarga individual», y el motivo es de conciliación: quien
 * baja un ZIP y luego una factura suelta acaba con dos convenciones en la misma carpeta y no puede
 * emparejarlas. El id de FLIT sale del nombre —no es lo que la operación usa para cuadrar— y con él
 * se va el único texto libre del origen que llegaba a una cabecera HTTP; lo que entra ahora está
 * normalizado a `[A-Z0-9-]` por `nombrePlacaOrganismo`.
 *
 * Operaciones o gestor de impuestos (respeta la frontera del gestor). Integración FLIT.
 */
router.get('/:id/factura-venta', OPS_O_GESTOR, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const factura = await facturaVentaFlitConAcceso(req.params.id, ctx);
  if (!factura) { res.status(404).json({ error: 'El trámite no tiene factura de venta en FLIT' }); return; }
  const url = await getFlitAdapter().obtenerUrlFactura(factura.facturaId);
  if (!url) { res.status(404).json({ error: 'La factura de venta no está disponible en FLIT' }); return; }

  const upstream = await fetch(url).catch(() => null);
  if (!upstream || !upstream.ok) { res.status(502).json({ error: 'No se pudo descargar la factura de venta desde FLIT' }); return; }
  const cuerpo = Buffer.from(await upstream.arrayBuffer());

  const { contentType, extension } = tipoPorBytes(cuerpo);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(cuerpo.length));
  // `inline` para que el visor de la aplicación lo pinte; el nombre es el que usa el navegador al
  // guardarlo, así que lleva extensión pase lo que pase.
  const base = nombrePlacaOrganismo(factura.placa, factura.organismoAlias, factura.organismoCodigo);
  res.setHeader('Content-Disposition', `inline; filename="${base}.${extension}"`);
  res.send(cuerpo);
});

/**
 * POST /soportes/zip — factura de venta y/o recibo de impuesto de los marcados, en UN ZIP (AC3).
 *
 * ── Sustituye a `POST /facturas-venta/zip`, que se RETIRA ────────────────────────────────────────
 *
 * Aquella ruta se queda sin llamadores con esta HU y no se conserva «por si acaso»: exportaba
 * facturas con datos personales sin cuota, sin rastro en `pii_access_log` y con un `catch {}` mudo
 * que hacía desaparecer documentos sin dejar constancia. Dejarla viva sería mantener abierta la
 * puerta que esta HU cierra. Un cliente que la llame recibe 404.
 *
 * ── `tipos` es del usuario, y `.strict()` importa ────────────────────────────────────────────────
 *
 * El AC3 dice «factura de venta / comprobante de pago / ambos → UN ZIP», así que el vocabulario es
 * de dos valores y el cuerpo los lleva. `.strict()` porque un campo mal escrito —`tipo` en
 * singular— se ignoraría en silencio y el usuario recibiría un archivo con otra cosa dentro
 * creyendo que pidió lo que marcó.
 *
 * **`recibo_impuesto` NO es un alias de la columna `tipo`**: resuelve a
 * `recibo_impuesto_sin_marca_agua` con caída a `recibo_impuesto` (ver `soportes-zip.ts`). Hoy el
 * único productor es `flito-recibos.service.ts`, que escribe siempre el marcado, así que **el camino
 * real es la caída** — la preferencia está para cuando el limpio exista.
 *
 * ── Roles: `OPS_O_GESTOR`, no `LECTURA` ─────────────────────────────────────────────────────────
 *
 * `LECTURA` incluye `auditor`, y el AC7 dice que auditoría no descarga. 403.
 */
const zipSoportesSchema = z.object({
  // Sin `.max()`: el tope se comprueba con `comprobarTopeRegistrosZip`, que responde con
  // `codigo` propio. Un `.max()` aquí daría un 400 de Zod indistinguible de un cuerpo roto.
  ids: z.array(z.string().uuid()).min(1),
  tipos: z.array(z.enum([TipoSoporteZip.FACTURA_VENTA, TipoSoporteZip.RECIBO_IMPUESTO]))
    .min(1).max(2),
}).strict();

router.post('/soportes/zip', OPS_O_GESTOR, zipSoportesLimiter, async (req: Request, res: Response) => {
  const parsed = zipSoportesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const ctx = await contextoImpuesto(req.user!);

  try {
    comprobarTopeRegistrosZip(parsed.data.ids);
    const registros = await registrosZipImpuestos(parsed.data.ids, ctx);
    const entradas = await resolverEntradasZip(registros, parsed.data.tipos);

    // ANTES del primer byte, y esto es la deuda que la HU #11909 dejó abierta en este endpoint: el
    // zip de facturas auditaba con `audit()` pero NO llamaba a `registrarAccesoImpuesto`, así que un
    // lote de cien facturas con los datos del titular dentro no dejaba una sola línea del artículo 17.
    await registrarAccesoImpuesto(req, {
      accion: 'export',
      archivo: 'zip_soportes',
      campos: CAMPOS_PII_ZIP_SOPORTES,
      filas: entradas.length,
    });
    await audit(req, {
      action: 'export', resource: 'flito_impuesto',
      detail: `Descarga zip de soportes (${parsed.data.tipos.join(', ')}): ${entradas.length} documento(s)`,
    });

    await emitirZipSoportes(res, entradas);
  } catch (e) {
    if (res.headersSent) throw e;
    if (e instanceof ZipError) {
      res.status(e.status).json({ error: e.message, codigo: e.codigo });
      return;
    }
    handleError(res, e);
  }
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
const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fecha = (v: unknown): string | undefined => {
  const s = texto(v);
  return s && FORMATO_FECHA.test(s) ? s : undefined;
};

/**
 * La misma regla que `fecha()`, para los esquemas `zod` del export (HU #11909).
 *
 * Comparten el regex y no una copia. Lo que cambia es qué se hace con un valor malo: el listado lo
 * IGNORA (un filtro roto no tumba la pantalla de quien trabaja) y el export lo rechaza con 400,
 * porque un rango silenciosamente descartado produciría un archivo mucho mayor del que el usuario
 * cree estar pidiendo.
 */
const fechaSchema = z.string().regex(FORMATO_FECHA, 'La fecha debe ser yyyy-mm-dd');

// GET / — cola con las 2 fronteras, filtrada y paginada.
//
// Deja rastro en `pii_access_log` desde la HU #11909 (Ley 1581 art. 17, AGENTS.md §16): cada fila
// trae el nombre y la CÉDULA del propietario, y este módulo no registraba NINGUNA lectura —`grep -c
// logPiiAccess` sobre sus ocho archivos daba 0—. Se cierra aquí y no solo en el export para no dejar
// la ruta interactiva sin rastro mientras la de al lado lo escribe todo. Va DESPUÉS de la consulta y
// con `await`, como en SOAT: `filas` no se sabe antes.
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const estadoRaw = typeof req.query.estado === 'string' ? req.query.estado : undefined;
  const estados = estadoRaw
    ? estadoRaw.split(',').map((s) => s.trim()).filter((s): s is EstadoImpuesto => (ESTADOS as readonly string[]).includes(s))
    : undefined;
  const buscar = typeof req.query.buscar === 'string' ? req.query.buscar : undefined;
  const pagina = await colaImpuestos(ctx, {
    estados, buscar,
    companias: numeros(req.query.companias),
    organismos: lista(req.query.organismos),
    // Un valor desconocido se ignora, como el resto de filtros: uno roto no tumba la pantalla.
    gestion: req.query.gestion === 'operaciones' || req.query.gestion === 'organismo' ? req.query.gestion : undefined,
    solicitadoDesde: fecha(req.query.solicitadoDesde), solicitadoHasta: fecha(req.query.solicitadoHasta),
    pagadoDesde: fecha(req.query.pagadoDesde), pagadoHasta: fecha(req.query.pagadoHasta),
    // El rango nuevo de la HU #11909, con el MISMO helper que los otros dos. Va también aquí y no
    // solo en el export porque el archivo tiene que ser «lo que estoy viendo»: sin este filtro en la
    // pantalla, el usuario no podría estar viendo lo que se descarga.
    creadoDesde: fecha(req.query.creadoDesde), creadoHasta: fecha(req.query.creadoHasta),
    estancado: req.query.estancado === 'si',
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 50,
  });
  await registrarAccesoImpuesto(req, { accion: 'search', filas: pagina.items.length });
  res.json(pagina);
});

/**
 * La cuota del export vive en `shared/export/cola-flito-excel.ts` y es **la MISMA que la de la cola
 * de SOAT**: 5 por minuto y usuario para las dos juntas.
 *
 * **Aquí decía lo contrario** —«separada también de la del export de SOAT: son dos colas y dos
 * pantallas»— y era el error que encontró el gate de seguridad de esta HU: ese argumento choca de
 * frente con el que sostiene `FLITO_COLA_EXPORT_MAX_FILAS`, que es UNA sola perilla para las dos
 * colas porque «el presupuesto que se reparte es el del PROCESO, y el proceso es uno». Un
 * presupuesto de heap y dos bolsas de peticiones que lo llenan no puede ser correcto a la vez.
 *
 * ADR-0004 midió que cinco exports simultáneos al tope suman +239 MB de los 262 que hay hasta el
 * `max_memory_restart` de PM2, y el limitador cuenta por MINUTO y no en vuelo: una sola sesión puede
 * tener los cinco construyéndose a la vez. Con dos bolsas serían diez. Además, cuota × tope ES el
 * techo de extracción de datos personales del módulo (10 000 filas/min/usuario con una bolsa, 20 000
 * con dos), y cada fila de esta hoja lleva cédula, correo, teléfono y dirección del titular.
 *
 * Lo que se paga: quien acaba de bajar cinco archivos de SOAT espera al minuto para el sexto de
 * Impuestos. Es el intercambio correcto — el recurso racionado es el heap, no la pantalla.
 *
 * Sigue siendo una bolsa APARTE de la del listado: gastar los exports no puede dejar sin paginar a
 * quien está trabajando, ni al revés. Lo que se unificó son las dos bolsas NUEVAS entre sí.
 */

/**
 * Campos del filtro de la cola, en un esquema único del que se DERIVA el del export.
 *
 * `page`, `pageSize` y `cursor` están aquí para poder RESTARLOS abajo: el `.omit()` es lo que
 * convierte `{"page": 2}` en un 400 en vez de en un parámetro ignorado en silencio, y aceptarlo
 * callando dejaría creer que se descargó «la página 2» de algo.
 *
 * Sin `proveedores`: en Impuestos el equivalente al proveedor es el organismo, y ese filtro ya está.
 * `gestion` es `operaciones | organismo`, no `operaciones | proveedor`.
 */
const colaFiltrosCampos = z.object({
  estados: z.array(z.enum(ESTADOS)).optional(),
  buscar: z.string().trim().min(1).optional(),
  companias: z.array(z.number().int().positive()).optional(),
  organismos: z.array(z.string().trim().min(1)).optional(),
  gestion: z.enum(['operaciones', 'organismo']).optional(),
  solicitadoDesde: fechaSchema.optional(), solicitadoHasta: fechaSchema.optional(),
  pagadoDesde: fechaSchema.optional(), pagadoHasta: fechaSchema.optional(),
  creadoDesde: fechaSchema.optional(), creadoHasta: fechaSchema.optional(),
  estancado: z.boolean().optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
  cursor: z.string().optional(),
});

/**
 * Cuerpo de `POST /export`: el filtro de la cola menos la paginación, y `.strict()`.
 *
 * `.strict()` con más motivo que en una query cualquiera: `{"organismo": "05001"}` —en singular— se
 * ignoraría en silencio y devolvería la cola ENTERA a quien pidió la de un organismo. En un archivo
 * de datos personales, un filtro mal escrito tiene que ser un 400 y no un export de más.
 */
const exportSchema = colaFiltrosCampos
  .omit({ page: true, pageSize: true, cursor: true })
  .strict();

/**
 * POST /export — la cola filtrada, en un `.xlsx` (Feature #11908, HU #11909).
 *
 * ── Por qué POST y por qué TODO el filtro va en el cuerpo ────────────────────────────────────────
 *
 * `buscar` casa contra placa, VIN, id de FLIT, nombre y cédula del propietario
 * (`condicionesColaImpuestos`), así que el filtro genérico de esta cola ES un dato personal y no
 * puede viajar en la URL: AGENTS.md §14 lo prohíbe porque una query string acaba en los logs de
 * nginx, en el historial del navegador y en el `Referer`. **No existe variante GET de este
 * endpoint** — un `router.get` aquí devolvería la cédula a la URL sin romper ningún otro test.
 *
 * ── El rol: `OPS_O_GESTOR`, no `LECTURA` ────────────────────────────────────────────────────────
 *
 * `LECTURA` incluye `auditor`. Un archivo con la cédula, el correo y la dirección de los titulares
 * es otra cosa que una pantalla de consulta, y la HU nombra a admin y gestor. `auditor` recibe 403.
 *
 * ── Orden de la respuesta ───────────────────────────────────────────────────────────────────────
 *
 * Validar → consultar (con el tope dentro) → `await` del rastro PII → cabeceras → archivo. El rastro
 * va ANTES del primer byte: la petición vale hasta `FLITO_COLA_EXPORT_MAX_FILAS` cédulas, correos y
 * direcciones, y perder su constancia por un fallo a mitad del archivo no es aceptable.
 *
 * Va declarada antes que `GET /:id` por costumbre del router; no hay ambigüedad de todas formas —es
 * un POST y no existe `POST /:id` a secas—.
 */
router.post('/export', OPS_O_GESTOR, exportColaLimiter, async (req: Request, res: Response) => {
  const parsed = exportSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtro inválido', details: parsed.error.flatten() });
    return;
  }
  const ctx = await contextoImpuesto(req.user!);

  try {
    // Aquí se decide el 422: si el filtro se pasa del tope, esto lanza y no hay filas que escribir.
    const filas = await construirFilasExportImpuestos(ctx, parsed.data);

    // `filas` = las REALMENTE entregadas. No el tope, no lo pedido.
    await registrarAccesoImpuesto(req, {
      accion: 'export',
      campos: CAMPOS_PII_IMPUESTO_EXPORT,
      filas: filas.length,
    });

    res.set('Cache-Control', 'no-store');
    await sendExcel(res, nombreArchivoExportImpuestos(), COLUMNAS_COLA_EXPORT, filas);
  } catch (e) {
    // Con la respuesta ya empezada, responder reventaría con ERR_HTTP_HEADERS_SENT y taparía la
    // causa real: se relanza al manejador global, que sabe cerrar una respuesta a medias.
    if (res.headersSent) throw e;

    if (e instanceof ExportColaDemasiadoGrandeError) {
      // El export que choca con el tope también deja rastro: la consulta CORRIÓ —`tope + 1` filas
      // con su cédula entraron en el proceso— y lo único que no ocurrió es la entrega. `search` y no
      // `export` porque no se exportó nada; `filas: 0` es literal y no revela cuántas hay.
      await registrarAccesoImpuesto(req, {
        accion: 'search',
        campos: CAMPOS_PII_IMPUESTO_EXPORT,
        filas: 0,
        resultado: e.codigo,
      });
      // El 422 se emite AQUÍ y no en `handleError`: `ImpuestoError` solo lleva `status` + `message`
      // y su manejador responde `{ error }` sin `codigo`. La pantalla decide por `codigo`, y
      // colgarlo de `ImpuestoError` obligaría a cambiar el sobre de error de todos los demás
      // endpoints del módulo para servir a este.
      res.status(e.status).json({ error: e.message, codigo: e.codigo });
      return;
    }

    handleError(res, e);
  }
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
 * GET /:id/soportes — los recibos cargados de este impuesto, con su enlace firmado.
 *
 * El detalle ya decía CUÁNTOS soportes hay y cómo se llaman, pero no daba forma de abrirlos: para
 * ver el recibo que respalda un impuesto pagado había que salir al reporte de costos, al que el
 * gestor del organismo no entra. Misma frontera que el historial —vía `detalleImpuesto()`, CA-10.
 */
router.get('/:id/soportes', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoImpuesto(req.user!);
  const d = await detalleImpuesto(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El impuesto no existe' }); return; }
  // Sin caché: un recibo cargado hace un minuto tiene que salir sin recargar la pantalla.
  res.set('Cache-Control', 'no-store');
  res.json(await soportesDeImpuesto(req.params.id));
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
      vinConsultado: cert.vinConsultado,
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
