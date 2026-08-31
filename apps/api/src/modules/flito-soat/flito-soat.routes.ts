// FLITO — SOAT (HTTP). Portado de packages/server/src/soat/soat.controlador.ts. Opera sobre
// flito_soat; coexiste con el módulo legacy /api/soat (soat_requests). Montado en /api/flito/soat.
//
// Fase 3: carga de factura (POST /:id/factura, POST /facturas) — única vía a Pagado (RN-03),
// sobre el motor OCR Anthropic (modules/flito-ocr) y storage S3.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { historialDe } from '../../shared/historial/estado-historial.js';
import { soportesDeSoat } from '../../shared/soportes/soportes-consulta.js';
import { sendExcel } from '../../shared/utils/excel.js';
import {
  COLUMNAS_COLA_EXPORT, ExportColaDemasiadoGrandeError,
} from '../../shared/export/cola-flito-excel.js';
import { CAMPOS_PII_SOAT_EXPORT, registrarAccesoSoat } from './flito-soat.pii.js';
import { EstadoSoat } from '@operaciones/shared-types';
import {
  asumirEnOperaciones, cambiarProveedor, cargarFactura, cargarFacturasMasivo, cola, contextoSoat,
  devolverAlGestor, facetasCola, detalle, enviarAlGestor,
  reactivar, rechazar, reversar, SoatError, type ArchivoSubido,
} from './flito-soat.service.js';
import {
  construirFilasExportSoat, nombreArchivoExportSoat,
} from './flito-soat.export.service.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';

const router = Router();
router.use(authMiddleware);

const MIMES_FACTURA = ['application/pdf', 'image/jpeg', 'image/png', 'application/zip', 'application/x-zip-compressed'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    // Un ZIP puede venir con mimetype genérico; se acepta por extensión y se valida su contenido al expandir.
    const ok = MIMES_FACTURA.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.zip');
    if (ok) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

const aArchivo = (f: Express.Multer.File): ArchivoSubido => ({
  originalname: f.originalname, mimetype: f.mimetype, buffer: f.buffer, size: f.size,
});

// `cliente` entra en LECTURA y en NINGUNA de las otras dos constantes (Feature #11912): ve la cola,
// el detalle, el historial y los soportes —siempre acotados a su compañía por `contextoSoat()` →
// `condicionesCola()` / `buscarConAcceso()`— y no puede mover nada. Las acciones de su canal
// (radicar, subsanar) son rutas propias en un módulo aparte y llegan en la HU #11914.
const LECTURA = requireRole('admin', 'proveedor', 'auditor', 'cliente');
const OPERACIONES = requireRole('admin');
const OPS_O_GESTOR = requireRole('admin', 'proveedor');

// Los estados que el filtro de la cola acepta.
//
// Los dos del canal Cliente entran en la HU #11915, que es la que da al admin una cola de revisión.
// **Sin ellos aquí, añadir la pill solo en la interfaz falla EN SILENCIO y en la peor dirección**:
// un estado desconocido se ignora —no da 400, por la filosofía de «un filtro roto no tumba la
// pantalla de quien trabaja»—, así que el admin pulsa «Pendiente de revisión», el filtro se descarta
// y la cola le devuelve TODO presentándoselo como el resultado del filtro. En una pantalla de
// revisión, ver de más creyendo que se ve de menos es el modo de fallo que hay que evitar primero.
const ESTADOS = [
  EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD,
  EstadoSoat.PENDIENTE_REVISION, EstadoSoat.RECHAZADA,
] as const;

function handleError(res: Response, e: unknown): void {
  if (e instanceof SoatError) { res.status(e.status).json({ error: e.message }); return; }
  if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
  throw e;
}

// Tras una mutación devolvemos el detalle; si el actor ya no puede verlo (p.ej. el gestor tras
// rechazar: el registro sale de su bandeja), devolvemos una confirmación mínima en vez de null.
async function responderDetalle(res: Response, ctx: Awaited<ReturnType<typeof contextoSoat>>, soat: { id: string; estado: string; motivoRechazo: string | null }): Promise<void> {
  const d = await detalle(soat.id, ctx);
  res.json(d ?? { id: soat.id, estado: soat.estado, motivoRechazo: soat.motivoRechazo });
}

// Helpers de parseo. Filosofía: un valor desconocido se IGNORA, no devuelve 400 — un filtro roto
// no debe tumbar la pantalla de quien está trabajando.
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const lista = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
};
const numeros = (v: unknown): number[] | undefined => {
  const l = lista(v)?.map(Number).filter((n) => Number.isFinite(n));
  return l?.length ? l : undefined;
};
/** Solo yyyy-mm-dd: el valor entra en un cast a `date` y no puede ser texto libre. */
const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const fecha = (v: unknown): string | undefined => {
  const s = str(v);
  return s && FORMATO_FECHA.test(s) ? s : undefined;
};

/**
 * La misma regla que `fecha()`, para los esquemas `zod` del export.
 *
 * Comparten el regex y no una copia: el motivo por el que la cadena está acotada —entra en un cast a
 * `date`— es el mismo en los dos sitios, y dos expresiones separadas se relajarían por su cuenta.
 * Lo que cambia es qué se hace con un valor malo: el listado lo IGNORA (un filtro roto no tumba la
 * pantalla de quien trabaja) y el export lo rechaza con 400, porque un rango silenciosamente
 * descartado produciría un archivo mucho mayor del que el usuario cree estar pidiendo.
 */
const fechaSchema = z.string().regex(FORMATO_FECHA, 'La fecha debe ser yyyy-mm-dd');

// GET / — cola con las 3 fronteras, filtrada y paginada.
//
// Deja rastro en `pii_access_log` (Ley 1581 art. 17, AGENTS.md §16): cada fila trae el nombre y la
// CÉDULA del propietario, y desde el Feature #11912 quien barre esta lista puede ser una empresa
// tercera. El registro va DESPUÉS de la consulta y con `await`, como en `clients.routes.ts`:
// `filas` no se sabe antes, y esperar cuesta una inserción best-effort a cambio de que el rastro
// esté escrito antes de que la respuesta salga.
router.get('/', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const estados = lista(req.query.estado)
    ?.filter((s): s is EstadoSoat => (ESTADOS as readonly string[]).includes(s));
  const pagina = await cola(ctx, {
    estados, buscar: str(req.query.buscar),
    companias: numeros(req.query.companias),
    organismos: lista(req.query.organismos),
    proveedores: lista(req.query.proveedores),
    // Un valor desconocido se ignora, como el resto de filtros: un filtro roto no tumba la pantalla.
    gestion: req.query.gestion === 'operaciones' || req.query.gestion === 'proveedor' ? req.query.gestion : undefined,
    solicitadoDesde: fecha(req.query.solicitadoDesde), solicitadoHasta: fecha(req.query.solicitadoHasta),
    pagadoDesde: fecha(req.query.pagadoDesde), pagadoHasta: fecha(req.query.pagadoHasta),
    // El rango nuevo de la HU #11909, con el MISMO helper `fecha()` que los otros dos: el valor
    // entra en un cast a `date` y no puede ser texto libre. Va también aquí y no solo en el export
    // porque el archivo tiene que ser «lo que estoy viendo»: si la pantalla no supiera filtrar por
    // creación, el usuario no podría estar viendo lo que se descarga.
    creadoDesde: fecha(req.query.creadoDesde), creadoHasta: fecha(req.query.creadoHasta),
    estancado: req.query.estancado === 'si',
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 50,
  });
  await registrarAccesoSoat(req, { accion: 'search', filas: pagina.items.length });
  res.json(pagina);
});

/**
 * Cuota del export: 5 por minuto y usuario, en una BOLSA SEPARADA de la de la cola.
 *
 * Separada a propósito: con una compartida, gastar los cinco exports dejaría a la pantalla sin poder
 * paginar —el usuario vería romperse la tabla por haber descargado— y, al revés, un visor abierto
 * que pagina le comería la cuota al export sin que nada lo explicara. Dos gestos distintos, dos
 * presupuestos.
 *
 * **Un 422 consume cuota igual que un 200, y no es un descuido**: `express-rate-limit` cuenta la
 * petición al entrar, antes del handler. Si el export demasiado grande saliera gratis, sondear el
 * tamaño de un filtro —«¿cuántos SOAT tiene esta compañía?»— sería ilimitado, que es justo la
 * pregunta que el 422 evita responder.
 *
 * `userOrIpKey` y no la IP pelada: varios usuarios de Operaciones salen por la misma IP corporativa,
 * y frenar por IP castigaría a la oficina entera por lo que hace una cuenta.
 */
const exportLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-soat-export'),
  message: { error: 'Demasiados exports seguidos, espera 1 minuto' },
  store: makeStore('rl:flito-soat-export:'),
});

/**
 * Campos del filtro de la cola, en un esquema único del que se DERIVA el del export.
 *
 * `page`, `pageSize` y `cursor` están aquí para poder RESTARLOS abajo: el `.omit()` es lo que
 * convierte `{"page": 2}` en un 400 en vez de en un parámetro ignorado en silencio, y aceptarlo
 * callando dejaría creer que se descargó «la página 2» de algo. Es el mismo mecanismo que usa el
 * export de comparendos con su `registrosQueryCampos`.
 *
 * `cursor` no lo usa esta cola —pagina por offset— y se declara igualmente: si mañana migra a
 * cursor, el export tiene que seguir rechazándolo, y el sitio donde eso se decide es este.
 */
const colaFiltrosCampos = z.object({
  estados: z.array(z.enum(ESTADOS)).optional(),
  buscar: z.string().trim().min(1).optional(),
  companias: z.array(z.number().int().positive()).optional(),
  organismos: z.array(z.string().trim().min(1)).optional(),
  proveedores: z.array(z.string().uuid()).optional(),
  gestion: z.enum(['operaciones', 'proveedor']).optional(),
  // El mismo `yyyy-mm-dd` que exige el helper `fecha()` del listado: el valor entra en un cast a
  // `date` y no puede ser texto libre.
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
 * `buscar` casa contra placa, VIN, nombre y cédula del propietario (`condicionesCola`), así que el
 * filtro genérico de esta cola ES un dato personal y no puede viajar en la URL: AGENTS.md §14 lo
 * prohíbe porque una query string acaba en los logs de nginx, en el historial del navegador y en el
 * `Referer`. Y van TODOS en el cuerpo, no repartidos como en comparendos: repartir obliga a decidir
 * caso a caso qué campo es identificativo, y esa decisión se equivoca una vez y ya está publicada.
 * **No existe variante GET de este endpoint** — un `router.get` aquí devolvería la cédula a la URL
 * sin romper ningún otro test.
 *
 * ── El rol: `OPS_O_GESTOR`, no `LECTURA` ────────────────────────────────────────────────────────
 *
 * `LECTURA` incluye `auditor` y `cliente`. Un archivo con la cédula, el correo y la dirección de los
 * titulares no se le entrega a una empresa tercera (el `cliente`, Feature #11912) por el hecho de
 * que pueda ver la cola de sus propios trámites en pantalla: ver una fila con su propietario y
 * descargar el padrón entero en un fichero reenviable son dos gestos distintos. `auditor` queda
 * fuera por lo mismo, y ninguno de los dos lo pide la HU. Los dos reciben 403.
 *
 * ── Orden de la respuesta ───────────────────────────────────────────────────────────────────────
 *
 * Validar → consultar (con el tope dentro) → `await` del rastro PII → cabeceras → archivo. El rastro
 * va ANTES del primer byte (Ley 1581 art. 17): esta petición vale hasta
 * `FLITO_COLA_EXPORT_MAX_FILAS` cédulas, correos y direcciones, y perder su constancia por un fallo
 * a mitad del archivo no es aceptable. `Cache-Control: no-store` antes de `sendExcel` porque lo que
 * sale no se guarda en ningún intermedio.
 */
router.post('/export', OPS_O_GESTOR, exportLimiter, async (req: Request, res: Response) => {
  const parsed = exportSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtro inválido', details: parsed.error.flatten() });
    return;
  }
  const filtros = parsed.data;
  const ctx = await contextoSoat(req.user!);

  try {
    // Aquí se decide el 422: si el filtro se pasa del tope, esto lanza y no hay filas que escribir.
    const filas = await construirFilasExportSoat(ctx, filtros);

    // `filas` = las REALMENTE entregadas. No el tope, no lo pedido: el registro tiene que decir qué
    // se llevó alguien, y un número inflado ensucia el dato con el que se recalibra el tope.
    await registrarAccesoSoat(req, {
      accion: 'export',
      campos: CAMPOS_PII_SOAT_EXPORT,
      filas: filas.length,
    });

    res.set('Cache-Control', 'no-store');
    await sendExcel(res, nombreArchivoExportSoat(), COLUMNAS_COLA_EXPORT, filas);
  } catch (e) {
    // Si el fallo llega con la respuesta ya empezada —el archivo se estaba escribiendo—, responder
    // reventaría con ERR_HTTP_HEADERS_SENT y taparía la causa real. Se relanza al manejador global,
    // que sabe cerrar una respuesta a medias.
    if (res.headersSent) throw e;

    if (e instanceof ExportColaDemasiadoGrandeError) {
      // **El export que choca con el tope también deja rastro**, y no por simetría: la consulta ya
      // CORRIÓ —`tope + 1` filas con su cédula entraron en el proceso— y lo único que no ocurrió es
      // la entrega. Sin esta línea, el `pii_access_log` quedaría amputado justo en la cola que
      // ADR-0004 promete mirar para recalibrar el tope: concluiría que casi nadie se le acerca
      // precisamente porque los que lo pasan son invisibles.
      //
      // `accion: 'search'` y no `'export'`: no se exportó nada, y contarlo como export estropearía
      // los agregados de `/api/privacy/pii-access/stats`. `filas: 0` es literal, y el conteo real ni
      // se sabe ni se sabrá —el `tope + 1` existe para no calcularlo—, así que esta fila tampoco
      // revela cuántos SOAT tiene el filtro.
      await registrarAccesoSoat(req, {
        accion: 'search',
        campos: CAMPOS_PII_SOAT_EXPORT,
        filas: 0,
        resultado: e.codigo,
      });
      // El 422 se emite AQUÍ y no en `handleError`: `SoatError` solo lleva `status` + `message` y su
      // manejador responde `{ error }` sin `codigo`. La pantalla decide por `codigo` —«acota el
      // filtro» frente a «revisa lo que escribiste»— y colgarlo de `SoatError` obligaría a cambiar
      // el sobre de error de todos los demás endpoints del módulo para servir a este.
      res.status(e.status).json({ error: e.message, codigo: e.codigo });
      return;
    }

    handleError(res, e);
  }
});

// GET /facetas — valores disponibles para los filtros, acotados a lo que el usuario puede ver.
// Va antes de `/:id` para que «facetas» no se interprete como un identificador.
router.get('/facetas', LECTURA, async (req: Request, res: Response) => {
  res.json(await facetasCola(await contextoSoat(req.user!)));
});

// GET /:id — detalle (404-no-403 para el gestor ajeno)
router.get('/:id', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const d = await detalle(req.params.id, ctx);
  // El 404 NO se registra, y la diferencia importa: un id que no existe —o que está fuera de la
  // frontera— no entregó datos de nadie. Anotarlo llenaría el registro de accesos que no ocurrieron.
  if (!d) { res.status(404).json({ error: 'El SOAT no existe' }); return; }
  await registrarAccesoSoat(req, { accion: 'read', soatId: req.params.id, filas: 1 });
  res.json(d);
});

// GET /:id/historial — cambios de estado, del más reciente al más antiguo.
//
// Pasa por `detalle()` antes de leer el historial y no directo a la tabla: es lo que aplica la
// frontera del gestor. Sin ese paso, un proveedor podría leer la historia de un SOAT de otro
// consultando su id, que es exactamente lo que el 404-no-403 del detalle evita.
router.get('/:id/historial', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const d = await detalle(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El SOAT no existe' }); return; }
  // Al `cliente` se le sirve la línea de tiempo SIN el empleado que la movió (dato personal de un
  // trabajador) y SIN el motivo (texto libre escrito para lectores internos, que además arrastraba
  // el importe pagado y el uuid del proveedor). El porqué de cada recorte, en `OpcionesHistorial`.
  res.json(await historialDe('soat', req.params.id, { lectorExterno: ctx.role === 'cliente' }));
});

/**
 * GET /:id/soportes — los comprobantes cargados de este SOAT, con su enlace firmado.
 *
 * Quien mira un SOAT pagado quiere ver la factura que lo pagó sin salir del detalle: hasta ahora
 * el archivo se cargaba desde aquí y solo se podía consultar desde el reporte de costos, al que
 * el gestor del proveedor ni siquiera entra.
 *
 * Pasa por `detalle()` antes de leer los soportes, por lo mismo que el historial: es ese paso el
 * que aplica la frontera del gestor, y sin él un proveedor podría leer los documentos de un SOAT
 * ajeno consultando su id.
 *
 * **El rol viaja a la consulta, y no es decoración (HU #11678, AC5).** `detalle()` resuelve la
 * PERTENENCIA —de quién es este SOAT— pero solo para el gestor: `buscarConAcceso` no filtra nada
 * cuando el rol es `auditor`. Desde que esta lista incluye el comprobante del pago PSE de la boleta,
 * eso son dos preguntas distintas: «¿es tuyo este SOAT?» la responde `detalle()`, y «¿tienes derecho
 * a ESTE bloque?» la responde `soportesDeSoat` con el rol. Auditoría sigue viendo todo lo demás.
 *
 * **Y desde la HU #11916 viaja también el ESTADO, que es la tercera pregunta** («¿ya hay algo que
 * enseñar?»): para el `cliente`, la póliza solo sale con el SOAT en `pagado` (AC2/AC3). El estado
 * sale del detalle que acaba de autorizar el acceso y no de una segunda lectura: son el mismo hecho,
 * y dos lecturas podrían discrepar entre sí. Esta ruta sigue sirviendo al canal Cliente sin ninguna
 * entrada nueva en `canal-cliente.ts` — `GET /api/flito/soat/:id/soportes` ya estaba inscrita desde
 * la #11913, y el archivo se descarga por `GET /api/files?…`, que es público y va firmado.
 */
router.get('/:id/soportes', LECTURA, async (req: Request, res: Response) => {
  const ctx = await contextoSoat(req.user!);
  const d = await detalle(req.params.id, ctx);
  if (!d) { res.status(404).json({ error: 'El SOAT no existe' }); return; }
  // Sin caché: una factura cargada hace un minuto tiene que salir sin recargar la pantalla.
  res.set('Cache-Control', 'no-store');
  res.json(await soportesDeSoat(req.params.id, { rol: ctx.role, estadoSoat: d.estado }));
});

// POST /enviar — Pendiente → En adquisición, atómico (CA-04). Solo Operaciones.
//
// Hay que nombrar un destino, y solo uno: un proveedor, o Operaciones. El proveedor se volvió
// obligatorio en la HU #10979 porque omitirlo dejaba el SOAT en la cola de nadie y sin ANS con el
// que medirlo. Ese riesgo sigue vigente, así que la contingencia (HU #11152) no relaja la regla:
// añade el otro destino, también explícito. Marcar los dos —o ninguno— es un 400, porque un envío
// sin dueño claro es justo lo que ninguna de las dos HU quiere.
const enviarSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  proveedorSoatId: z.string().uuid().optional(),
  gestionOperaciones: z.boolean().optional(),
}).refine(
  (d) => Boolean(d.proveedorSoatId) !== Boolean(d.gestionOperaciones),
  { message: 'Elige el proveedor al que se envía, o marca que lo gestiona Operaciones. Una de las dos, no ambas.' },
);
router.post('/enviar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = enviarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { ids, proveedorSoatId, gestionOperaciones } = parsed.data;
  const ctx = await contextoSoat(req.user!);
  const resultado = await enviarAlGestor(ids, ctx, { proveedorSoatId, gestionOperaciones });
  if (resultado.enviados.length > 0) {
    const destino = gestionOperaciones ? 'gestión de Operaciones' : `proveedor ${proveedorSoatId}`;
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: resultado.enviados.join(','), detail: `Enviados a ${destino}: ${resultado.enviados.length} (pendiente→en_adquisicion)` });
  }
  res.json(resultado);
});

const motivoSchema = z.object({ motivo: z.string().min(1, 'El motivo es obligatorio') });

// POST /:id/rechazar — rechazo del proveedor (CA-08). Operaciones o gestor.
router.post('/:id/rechazar', OPS_O_GESTOR, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await rechazar(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Rechazo: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/reactivar — Rechazado → Pendiente (CA-08). Solo Operaciones.
router.post('/:id/reactivar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = motivoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'El motivo es obligatorio' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await reactivar(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Reactivación (rechazado→pendiente): ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/reversar — reversa manual (RN-06). Solo Operaciones, motivo ≥5.
//
// El enum NO gana los dos estados del canal Cliente aunque `ESTADOS` (arriba) sí los tenga: son dos
// preguntas distintas y confundirlas es lo que abre la puerta. Aquella lista dice «por qué estados se
// puede FILTRAR»; esta dice «a qué estados se puede REVERSAR», y el ADR-0008 §8 prohíbe
// `pendiente_revision` como destino. La defensa de verdad está en `reversar()`, que además comprueba
// el estado de PARTIDA: este `z.enum` protege una ruta, y el servicio protege la regla.
const reversarSchema = z.object({
  estadoDestino: z.enum([EstadoSoat.PENDIENTE, EstadoSoat.SOLICITADO, EstadoSoat.PAGADO, EstadoSoat.CON_NOVEDAD]),
  motivo: z.string().min(5, 'La reversa exige un motivo que explique el porqué'),
});
router.post('/:id/reversar', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = reversarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await reversar(req.params.id, parsed.data.estadoDestino, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Reversa → ${parsed.data.estadoDestino}: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/proveedor — cambio de proveedor (RN-05). Solo Operaciones.
const cambiarProveedorSchema = z.object({ proveedorSoatId: z.string().uuid(), motivo: z.string().min(1) });
router.post('/:id/proveedor', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = cambiarProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const { soat, anterior } = await cambiarProveedor(req.params.id, parsed.data.proveedorSoatId, parsed.data.motivo);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Cambio de proveedor ${anterior ?? '—'} → ${parsed.data.proveedorSoatId}: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/asumir-operaciones y POST /:id/devolver-gestor — traspaso de gestión por contingencia
// (HU #11153). Solo Operaciones, motivo ≥5 como en la reversa: es la misma clase de decisión, una
// excepción que alguien tendrá que poder explicar después.
//
// Son el ÚNICO camino sancionado para la contingencia sobre un SOAT ya enviado. `/:id/proveedor`
// sigue prohibiendo el salto de proveedor a proveedor En adquisición (RN-05) y no se toca: aquello
// reasigna entre terceros, esto retira el caso de los terceros.
const traspasoSchema = z.object({
  motivo: z.string().min(5, 'El traspaso de gestión exige un motivo que explique el porqué'),
});
router.post('/:id/asumir-operaciones', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = traspasoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await asumirEnOperaciones(req.params.id, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Gestión asumida por Operaciones (proveedor de origen ${soat.proveedorSoatId ?? '—'}): ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

const devolverSchema = traspasoSchema.extend({ proveedorSoatId: z.string().uuid() });
router.post('/:id/devolver-gestor', OPERACIONES, async (req: Request, res: Response) => {
  const parsed = devolverSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const soat = await devolverAlGestor(req.params.id, parsed.data.proveedorSoatId, parsed.data.motivo, ctx);
    await audit(req, { action: 'update', resource: 'flito_soat', resourceId: soat.id, detail: `Gestión devuelta al proveedor ${parsed.data.proveedorSoatId}: ${parsed.data.motivo.trim()}` });
    await responderDetalle(res, ctx, soat);
  } catch (e) { handleError(res, e); }
});

// POST /:id/factura — carga de UNA factura de un SOAT puntual. Única vía a Pagado (RN-03).
// Operaciones o el gestor del proveedor. Campo de archivo: "archivo".
router.post('/:id/factura', OPS_O_GESTOR, upload.single('archivo'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'Falta el archivo de la factura' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const d = await cargarFactura(req.params.id, aArchivo(req.file), ctx);
    await audit(req, { action: 'upload', resource: 'flito_soat', resourceId: req.params.id, detail: `Carga de factura SOAT: ${req.file.originalname}` });
    res.json(d ?? { id: req.params.id });
  } catch (e) { handleError(res, e); }
});

// POST /facturas — carga MASIVA (varios archivos o un ZIP). El OCR enruta cada comprobante a un SOAT
// en adquisición; los que cruzan y superan el umbral se pagan, el resto va a revisión (CA-06).
router.post('/facturas', OPS_O_GESTOR, upload.array('archivos', 50), async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'No se adjuntó ningún archivo' }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const resultado = await cargarFacturasMasivo(files.map(aArchivo), ctx);
    await audit(req, { action: 'upload', resource: 'flito_soat', detail: `Carga masiva SOAT: ${resultado.pagados.length} pagados, ${resultado.enRevision.length} en revisión, ${resultado.duplicados.length} duplicados, ${resultado.noAsociados.length} sin asociar` });
    res.json(resultado);
  } catch (e) { handleError(res, e); }
});

export default router;
