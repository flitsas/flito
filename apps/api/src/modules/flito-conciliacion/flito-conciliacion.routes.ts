// FLITO Conciliación — fronteras HTTP de /api/flito/conciliacion (Feature #11623, HU #11676).
//
// Sólo Administración y Financiera (CF-08, AC9). `proveedor` NO entra en este router bajo ningún
// concepto: darle acceso a una boleta sería darle las pólizas y los valores de vehículos de otros
// clientes. Su lectura del comprobante va por una ruta suya en `/api/flito/soat` (ADR-0006 §7.5),
// que es la HU #11678.
//
// ── Dónde viaja la PII (regla 14 de AGENTS.md, ADR-0006 §7.5) ────────────────────────────────────
//
//   · Los identificadores del path son uuid OPACOS. Ni la póliza ni la placa aparecen jamás en un
//     path ni en una query string, ni aquí ni en el router de la web.
//   · La póliza NO es un parámetro de entrada de ningún endpoint: entra dentro del `.xlsx`, en el
//     cuerpo de un multipart. No hay «buscar por póliza» en este Feature, y si lo hubiera sería un
//     POST con la póliza en el cuerpo.
//   · La placa y la póliza SÍ salen en el cuerpo de las respuestas del cuadre —quien concilia
//     necesita reconocer el vehículo—, y por eso esas tres lecturas declaran `logPiiAccess`.
//   · El listado NO devuelve ni póliza ni placa (`BoletaResumenDto` no las tiene), así que no
//     registra acceso a PII: un registro con `campos_accedidos` que nadie accedió ensucia el log y
//     hace más difícil responder la pregunta que el log existe para responder.
//   · La columna «Nombre» del Excel no se lee, no se guarda y no se devuelve (AC11).

import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  type BoletaDetalleDto, CodigoErrorConciliacion, COMPROBANTE_MAX_BYTES, COMPROBANTE_MIMES,
  CONCILIACION_MAX_BYTES, EstadoBoleta,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import rateLimit from 'express-rate-limit';
import { checkMagicNumber } from '../pesv/magic-number.js';
import { deleteEntityDocument, uploadEntityDocument } from '../../services/storage.js';
import { ExcelBoletaError } from './flito-conciliacion.excel.js';
import { registrarAccesoBoleta } from './flito-conciliacion.pii.js';
import { conciliarBoleta } from './flito-conciliacion.conciliar.service.js';
import {
  descargaComprobante, destinoComprobante, nombreEnAlmacen, registrarComprobante,
} from './flito-conciliacion.comprobante.service.js';
import {
  cargarBoleta, ConciliacionError, descartarBoleta, detalleBoleta, listarBoletas, recruzarBoleta,
} from './flito-conciliacion.service.js';

const router = Router();
router.use(authMiddleware);

/** CF-08: la conciliación mueve dinero de terceros. Roles de `USER_ROLES`, nada inventado. */
const CONCILIACION = requireRole('admin', 'financiera');

/** El .xlsx del portal. Un xlsx es un zip, así que el MIME declarado no prueba nada por sí solo. */
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** El rechazo del `fileFilter`, con su propio tipo para no tener que mirarle el texto al error. */
class TipoNoPermitidoError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  // `fileSize` acota el archivo; el resto acota el FORMULARIO. Sin `fields`/`parts`, un multipart
  // con decenas de miles de campos de texto lo parsea busboy ENTERO —y lo guarda en `req.body`—
  // antes de que `cargaSchema.strict()` llegue a decir que sobran. La carga manda tres partes:
  // el archivo, `companiaId` y `fechaPago`. Ocho campos y diez partes son margen de sobra.
  limits: {
    fileSize: CONCILIACION_MAX_BYTES,
    files: 1,
    fields: 8,
    parts: 10,
    fieldSize: 1024,
    fieldNameSize: 64,
  },
  // Sin este filtro, el content-type que declara el cliente viaja intacto hasta el parser. El
  // olfateo real de los bytes va después, en el handler: multer no puede hacerlo porque necesita el
  // buffer completo (AGENTS.md 17).
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === MIME_XLSX) cb(null, true);
    // El MIME rechazado NO se devuelve: es una cadena que escribe el cliente, y devolverla es
    // hacerle de eco a un dato ajeno en una respuesta que otro puede acabar pintando.
    else cb(new TipoNoPermitidoError('tipo no permitido'));
  },
});

/**
 * Carga masiva → `rateLimiter` propio (AGENTS.md 18). Diez por minuto y por usuario: una carga
 * legítima cruza hasta 500 filas contra la base, y nadie carga diez boletas en un minuto a mano.
 */
const cargaLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-conciliacion-carga'),
  store: makeStore('rl:flito-conciliacion-carga:'),
  message: { error: 'Vas muy rápido. Espera un minuto antes de cargar otra boleta.' },
});

/**
 * La conciliación también lleva el suyo (AGENTS.md 18), y por un motivo distinto al de la carga: no
 * es el tamaño de la entrada, es lo que la petición HACE. Abre una transacción con hasta 500 asientos
 * EN SERIE y mantiene bloqueada la fila de la bolsa del cliente todo ese rato, así que una ráfaga
 * —doble clic nervioso, un reintento automático, un script— no solo repite trabajo: serializa a todo
 * el que quiera tocar esa bolsa, incluido el sellado de cualquier liquidación de ese cliente.
 *
 * Diez por minuto y por usuario, el mismo número que la carga: nadie concilia diez boletas a mano en
 * un minuto, y las repeticiones sobre la MISMA boleta ya mueren en el 409 sin tocar un saldo.
 */
const conciliarLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-conciliacion-conciliar'),
  store: makeStore('rl:flito-conciliacion-conciliar:'),
  message: { error: 'Vas muy rápido. Espera un minuto antes de conciliar otra boleta.' },
});

/**
 * Los motivos de multer, en castellano y escritos por NOSOTROS.
 *
 * El cuerpo de la respuesta no repite nada que venga del cliente —ni el MIME, ni el nombre del
 * archivo, ni el del campo—: lo que sale es este diccionario, indexado por el código de multer.
 */
const MOTIVO_MULTER: Record<string, string> = {
  LIMIT_FILE_SIZE: `El archivo pesa más de ${Math.round(CONCILIACION_MAX_BYTES / (1024 * 1024))} MB.`,
  LIMIT_FILE_COUNT: 'Sube un solo archivo.',
  LIMIT_UNEXPECTED_FILE: 'El archivo tiene que venir en el campo «archivo».',
  LIMIT_FIELD_COUNT: 'El formulario trae demasiados campos.',
  LIMIT_PART_COUNT: 'El formulario trae demasiadas partes.',
  LIMIT_FIELD_KEY: 'El formulario trae un campo con un nombre demasiado largo.',
  LIMIT_FIELD_VALUE: 'El formulario trae un campo demasiado largo.',
};

const MOTIVO_TIPO = 'El archivo tiene que ser el .xlsx que descargas del portal.';

/**
 * Envuelve a multer para que sus rechazos —tipo no permitido, archivo por encima de 10 MB, un
 * formulario con más partes de las que la carga acepta— salgan como 400 con su motivo y no como el
 * 500 genérico del error handler (AC7). Mismo envoltorio que `flito-bolsas.routes.ts`.
 */
function recibirExcel(req: Request, res: Response, next: (e?: unknown) => void): void {
  upload.single('archivo')(req, res, (err: unknown) => {
    if (err) {
      let error = 'Archivo inválido';
      if (err instanceof TipoNoPermitidoError) error = MOTIVO_TIPO;
      else if (err instanceof multer.MulterError) error = MOTIVO_MULTER[err.code] ?? error;
      res.status(400).json({ error, codigo: CodigoErrorConciliacion.ARCHIVO_INVALIDO });
      return;
    }
    next();
  });
}

/**
 * Traduce los errores de dominio a HTTP. Todo lo demás sube al error handler: un fallo de la base no
 * se disfraza de error de negocio.
 */
function fallo(res: Response, e: unknown): void {
  if (e instanceof ConciliacionError) {
    res.status(e.estado).json({ error: e.message, codigo: e.codigo, ...e.extra });
    return;
  }
  if (e instanceof ExcelBoletaError) {
    // Todo lo que el parser rechaza es «este archivo no sirve» → 400, incluido el exceso de filas:
    // el AC7 los agrupa a todos en el mismo desenlace y el cuerpo lleva el `codigo` que distingue el
    // caso. (El ADR-0006 §7.1 proponía 422 para `demasiadas_filas`; ver la nota de la HU.)
    res.status(400).json({ error: e.message, codigo: e.codigo, ...e.extra });
    return;
  }
  throw e;
}

/**
 * Un solo desenlace para todos los `catch` del router: primero el rastro de PII, luego el HTTP.
 *
 * El orden importa. `fallo` puede volver a lanzar —lo hace con todo lo que no es un error de
 * dominio— y en ese caso el error sube al handler de Express; si el registro fuera después, un fallo
 * de base que arrastrara datos personales saldría sin rastro. Registrar primero cuesta, en el camino
 * normal, una comprobación de tipo que devuelve enseguida.
 */
async function falloConRastro(req: Request, res: Response, e: unknown): Promise<void> {
  await registrarAccesoDelRechazo(req, e);
  fallo(res, e);
}

function ctxDe(req: Request): { userId: number | null; nombre: string } {
  return { userId: req.user?.sub ?? null, nombre: req.user?.username ?? 'desconocido' };
}

const uuidSchema = z.string().uuid();

function idDe(req: Request): string {
  const parsed = uuidSchema.safeParse(req.params.id);
  if (!parsed.success) {
    throw new ConciliacionError(
      404, CodigoErrorConciliacion.BOLETA_NO_EXISTE, 'Esa boleta no existe o se descartó.',
    );
  }
  return parsed.data;
}

// ── POST /boletas — cargar el Excel del portal y cruzarlo ────────────────────
//
// No mueve dinero: deja la boleta en `cargada` con su cuadre resuelto (AC1).

const cargaSchema = z.object({
  companiaId: z.coerce.number().int().positive(),
  fechaPago: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha de pago debe ser AAAA-MM-DD'),
}).strict();

router.post('/boletas', CONCILIACION, cargaLimiter, recibirExcel, async (req: Request, res: Response) => {
  const archivo = req.file;
  if (!archivo) {
    res.status(400).json({
      error: 'Falta el archivo de la boleta.', codigo: CodigoErrorConciliacion.ARCHIVO_INVALIDO,
    });
    return;
  }

  const campos = cargaSchema.safeParse(req.body);
  if (!campos.success) {
    res.status(400).json({
      error: campos.error.issues[0]?.message ?? 'Datos de la carga inválidos',
      codigo: CodigoErrorConciliacion.FECHA_INVALIDA,
    });
    return;
  }

  // El MIME declarado ya pasó el `fileFilter`; esto mira los BYTES. Un `.exe` renombrado a `.xlsx`
  // llega hasta aquí con el content-type correcto y muere en esta línea (AC7).
  const motivo = await checkMagicNumber(archivo.buffer, archivo.mimetype, [MIME_XLSX]);
  if (motivo) {
    res.status(400).json({ error: motivo, codigo: CodigoErrorConciliacion.ARCHIVO_INVALIDO });
    return;
  }

  try {
    const boleta = await cargarBoleta(
      { nombre: archivo.originalname, buffer: archivo.buffer },
      { ...campos.data, maxFilas: env.CONCILIACION_MAX_FILAS },
      ctxDe(req),
    );
    // La respuesta lleva pólizas y placas: queda rastro de quién las vio, y se espera a que esté
    // escrito antes de responder (AC10).
    await registrarAccesoBoleta(req, {
      accion: 'read', referencia: boleta.referencia, lineas: boleta.lineas.length,
    });
    // Y la bitácora de CAMBIOS, que es otra cosa: quién cargó qué boleta (AC9). Sin póliza ni placa
    // en el detalle — el conteo por resultado no identifica a nadie.
    await audit(req, {
      action: 'create',
      resource: 'flito_conciliacion_boleta',
      resourceId: boleta.id,
      detail: `Boleta ${boleta.referencia} · cliente ${boleta.companiaId} · ${boleta.filas} líneas · `
        + `${boleta.sinCuadrar} sin cuadrar`,
    });
    res.status(201).json(boleta);
  } catch (e) {
    await falloConRastro(req, res, e);
  }
});

// ── GET /boletas — bandeja ───────────────────────────────────────────────────
//
// Los filtros van en la query porque NINGUNO es PII: id de cliente, estado y fechas. La póliza y la
// placa no son filtros de este endpoint y no pueden serlo (regla 14).

const listadoSchema = z.object({
  companiaId: z.coerce.number().int().positive().optional(),
  estado: z.enum([EstadoBoleta.CARGADA, EstadoBoleta.CONCILIADA, EstadoBoleta.DESCARTADA]).optional(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().datetime().optional(),
  limite: z.coerce.number().int().positive().optional(),
}).strict();

router.get('/boletas', CONCILIACION, async (req: Request, res: Response) => {
  const filtro = listadoSchema.safeParse(req.query);
  if (!filtro.success) {
    res.status(400).json({ error: filtro.error.issues[0]?.message ?? 'Filtro inválido' });
    return;
  }
  try {
    res.json(await listarBoletas(filtro.data));
  } catch (e) {
    await falloConRastro(req, res, e);
  }
});

// ── GET /boletas/:id — el cuadre ─────────────────────────────────────────────

router.get('/boletas/:id', CONCILIACION, async (req: Request, res: Response) => {
  try {
    const boleta = await detalleBoleta(idDe(req));
    await registrarAccesoBoleta(req, {
      accion: 'read', referencia: boleta.referencia, lineas: boleta.lineas.length,
    });
    res.json(boleta);
  } catch (e) {
    await falloConRastro(req, res, e);
  }
});

// ── POST /boletas/:id/recruzar — volver a cruzar contra el estado de hoy ─────
//
// AC5. No toca el archivo ni el hash. 409 si la boleta ya está conciliada o descartada.

const vacioSchema = z.object({}).strict();

function cuerpoVacio(req: Request, res: Response): boolean {
  const parsed = vacioSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Esta acción no recibe datos en el cuerpo.' });
    return false;
  }
  return true;
}

router.post('/boletas/:id/recruzar', CONCILIACION, async (req: Request, res: Response) => {
  if (!cuerpoVacio(req, res)) return;
  try {
    const id = idDe(req);
    const { detalle, cambiadas } = await recruzarBoleta(id);
    await registrarAccesoBoleta(req, {
      accion: 'read', referencia: detalle.referencia, lineas: detalle.lineas.length,
    });
    await audit(req, {
      action: 'update',
      resource: 'flito_conciliacion_boleta',
      resourceId: id,
      detail: `Re-cruce de ${detalle.referencia} · ${cambiadas} líneas cambiaron · `
        + `${detalle.sinCuadrar} sin cuadrar`,
    });
    res.json(detalle);
  } catch (e) {
    await falloConRastro(req, res, e);
  }
});

/**
 * Deja rastro cuando el que entrega datos personales es un RECHAZO, no una respuesta feliz.
 *
 * El 409 `boleta_incompleta` devuelve el cuadre entero —hasta 500 pólizas y placas de terceros— para
 * que la pantalla repinte la tabla con los motivos de hoy. Que sea un error no lo hace menos una
 * lectura: la Ley 1581 pregunta «¿quién vio mis datos?», no «¿con qué código HTTP los vio?». Sin
 * esto, el único camino del módulo que entrega el cuadre sin registrarlo sería justamente el que
 * ocurre cuando algo va mal, que es cuando más se mira.
 *
 * Se decide por la FORMA del cuerpo y no por el código de error: cualquier `ConciliacionError` que
 * lleve una boleta con líneas queda auditado, así que el próximo rechazo al que se le añada un
 * detalle no se escapa por olvido. `logPiiAccess` es best-effort —atrapa su propio error— así que
 * esperar aquí no puede convertir un 409 en un 500.
 *
 * **Se llama desde TODOS los `catch` del router y no solo desde el de `conciliar`** (observación del
 * gate de la HU #11677, resuelta en la #11678). Hoy `boleta_incompleta` es el único rechazo que
 * devuelve el cuadre, así que en los demás caminos es un `return` inmediato que no cuesta nada; el
 * punto es que la garantía deje de depender de acordarse. La forma correcta de añadir mañana un
 * rechazo con detalle es no tener que tocar nada aquí.
 */
async function registrarAccesoDelRechazo(req: Request, e: unknown): Promise<void> {
  if (!(e instanceof ConciliacionError)) return;
  const boleta = e.extra.boleta as BoletaDetalleDto | undefined;
  if (!boleta || !Array.isArray(boleta.lineas)) return;
  await registrarAccesoBoleta(req, {
    accion: 'read', referencia: boleta.referencia, lineas: boleta.lineas.length,
  });
}

// ── POST /boletas/:id/conciliar — AQUÍ SALE EL DINERO ───────────────────────
//
// La única ruta del módulo que mueve un peso (HU #11677, CF-03). Cuerpo vacío y `.strict()`: no
// recibe importes ni ids — todo lo que decide cuánto sale viene de la base, dentro de la transacción.
//
// **No lleva `Idempotency-Key`** y no le hace falta. La idempotencia del dinero la dan las llaves de
// los dos libros (`salida:soat:<id>` y `consumo:soat:<id>`, con sus índices únicos) y el `FOR UPDATE`
// sobre la boleta; un segundo POST responde 409 `boleta_ya_conciliada` sin tocar ningún saldo (AC6).
//
// Los tres desenlaces de negocio son 409 y se distinguen por `codigo`, que es lo que la pantalla
// lee: `boleta_incompleta` (alguna línea dejó de cuadrar, AC2), `boleta_ya_conciliada` (AC6) y
// `boleta_descartada`.
//
// **Nota de contrato:** el ADR-0006 §7.3 y docs/ux proponían **422** para `boleta_incompleta`. El AC2
// de la HU pide **409**, y es el AC el que manda. Los dos cuerpos son idénticos —traen la boleta con
// el cuadre ya actualizado, para que la tabla se repinte con lo que hay hoy—, así que lo único que
// cambia en la pantalla es el número que compara.

router.post('/boletas/:id/conciliar', CONCILIACION, conciliarLimiter, async (req: Request, res: Response) => {
  if (!cuerpoVacio(req, res)) return;
  try {
    const id = idDe(req);
    const resultado = await conciliarBoleta(id, ctxDe(req));
    // La respuesta lleva las líneas con placa y póliza: mismo rastro que las demás lecturas.
    await registrarAccesoBoleta(req, {
      accion: 'read',
      referencia: resultado.boleta.referencia,
      lineas: resultado.boleta.lineas.length,
    });
    // AC8: quién concilió, qué boleta y por cuánto. Sin póliza ni placa — el total y el conteo no
    // identifican a nadie, y desde `resourceId` se llega a todo lo demás con control de acceso.
    await audit(req, {
      action: 'update',
      resource: 'flito_conciliacion_boleta',
      resourceId: id,
      detail: `Boleta ${resultado.boleta.referencia} conciliada · ${resultado.soatConciliados} SOAT `
        + `· total ${resultado.totalConciliado} · salió de la bolsa del cliente `
        + `${resultado.cliente.descontado} · ${resultado.adoptados.length} ya descontados al liquidar`,
    });
    res.json(resultado);
  } catch (e) {
    await falloConRastro(req, res, e);
  }
});

// ── POST /boletas/:id/descartar — sacarla de la bandeja y liberar el hash ────
//
// AC6. Es un UPDATE de estado y no un DELETE: una boleta es un documento contable. 409 si ya está
// conciliada. La respuesta es el RESUMEN, sin líneas: no lleva ni póliza ni placa, así que tampoco
// registro de acceso a PII.

router.post('/boletas/:id/descartar', CONCILIACION, async (req: Request, res: Response) => {
  if (!cuerpoVacio(req, res)) return;
  try {
    const id = idDe(req);
    const boleta = await descartarBoleta(id);
    await audit(req, {
      action: 'update',
      resource: 'flito_conciliacion_boleta',
      resourceId: id,
      detail: `Boleta ${boleta.referencia} descartada · el archivo vuelve a poder cargarse`,
    });
    res.json(boleta);
  } catch (e) {
    await falloConRastro(req, res, e);
  }
});

// ── El comprobante del pago PSE ─────────────────────────────────────────────
//
// HU #11678, CF-06. Tres rutas sobre el MISMO recurso —el comprobante de ESTA boleta—, y por eso el
// path lo nombra: `…/boletas/:id/comprobante`. Es la respuesta a la pregunta del AC7: el archivo no
// se sirve por ninguna ruta que resuelva «un soporte cualquiera por su id», sino por una en la que
// el dueño es parte de la dirección y el rol del router ya decidió quién puede mirar esa boleta.
//
//   POST   → sube el primero.       201. 409 `comprobante_ya_existe` si ya hay uno vivo.
//   PUT    → reemplaza.             200. El anterior queda `descartado = true`, no se borra.
//   GET    → firma fresca.          200 `{ url, nombreArchivo, contentType }`. 404 si no hay.
//
// Ninguna de las tres devuelve póliza ni placa —el comprobante es un PDF del banco, y su metadato es
// nombre, tipo, tamaño y fecha—, así que ninguna registra acceso a PII. La que sí lo hace es el
// DETALLE de la boleta, que ya lo hacía y ahora además trae el comprobante (AC2).

/** El comprobante del banco: un PDF o la foto/escaneo del pago. Misma lista que los hermanos. */
const MIMES_COMPROBANTE: readonly string[] = COMPROBANTE_MIMES;

const subidaComprobante = multer({
  storage: multer.memoryStorage(),
  // Un solo archivo y un formulario mínimo: esta petición no lleva campos de texto. Acotar `fields`
  // y `parts` evita que busboy parsee un multipart con miles de campos antes de que nadie lo mire.
  limits: {
    fileSize: COMPROBANTE_MAX_BYTES, files: 1, fields: 2, parts: 4, fieldSize: 1024, fieldNameSize: 64,
  },
  fileFilter: (_req, file, cb) => {
    if (MIMES_COMPROBANTE.includes(file.mimetype)) cb(null, true);
    // El MIME rechazado no se devuelve: es una cadena que escribe el cliente (misma razón que arriba).
    else cb(new TipoNoPermitidoError('tipo no permitido'));
  },
});

const MOTIVO_TIPO_COMPROBANTE = 'El comprobante tiene que ser PDF, JPG o PNG.';

const MOTIVO_MULTER_COMPROBANTE: Record<string, string> = {
  ...MOTIVO_MULTER,
  LIMIT_FILE_SIZE: `El archivo pesa más de ${Math.round(COMPROBANTE_MAX_BYTES / (1024 * 1024))} MB.`,
};

/** Mismo envoltorio que `recibirExcel`: los rechazos de multer salen 400 con motivo, no 500. */
function recibirComprobante(req: Request, res: Response, next: (e?: unknown) => void): void {
  subidaComprobante.single('archivo')(req, res, (err: unknown) => {
    if (err) {
      let error = 'Archivo inválido';
      if (err instanceof TipoNoPermitidoError) error = MOTIVO_TIPO_COMPROBANTE;
      else if (err instanceof multer.MulterError) error = MOTIVO_MULTER_COMPROBANTE[err.code] ?? error;
      res.status(400).json({ error, codigo: CodigoErrorConciliacion.ARCHIVO_INVALIDO });
      return;
    }
    next();
  });
}

/**
 * Una subida de 15 MB por petición merece su propio límite (AGENTS.md 18). Veinte por minuto: el
 * caso real es «me equivoqué de archivo, subo el bueno», no una ráfaga.
 */
const comprobanteLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-conciliacion-comprobante'),
  store: makeStore('rl:flito-conciliacion-comprobante:'),
  message: { error: 'Vas muy rápido. Espera un minuto antes de subir otro comprobante.' },
});

/**
 * Sube el comprobante y lo registra, sin dejar objetos huérfanos (AC1).
 *
 * El orden es el de `flito-bolsas.routes.ts` L194-250, y las tres etapas están donde están por algo:
 *
 *   1. `checkMagicNumber` mira los BYTES antes de tocar el almacenamiento. El `fileFilter` de multer
 *      solo vio el content-type que declara el cliente, que no prueba nada: un `.exe` renombrado
 *      llega hasta aquí con el MIME correcto y muere en esta línea **sin haber subido nada**.
 *   2. `destinoComprobante` rechaza la boleta que no admite comprobante y la que ya tiene uno,
 *      también antes de subir.
 *   3. Y si aun así el registro falla —una carrera, un 23505, la boleta descartada entre medias—,
 *      el objeto recién subido se borra en el `catch`. Esa es la red que hace que un 400 o un 409
 *      no dejen un archivo de 15 MB colgando en el bucket.
 *
 * Al REEMPLAZAR no se borra el objeto del comprobante anterior: su fila queda `descartado = true` y
 * el archivo sigue siendo la prueba de lo que se adjuntó antes. Borrarlo convertiría un reemplazo en
 * una destrucción de evidencia.
 */
async function subirComprobante(req: Request, res: Response, reemplazar: boolean): Promise<void> {
  const archivo = req.file;
  if (!archivo) {
    res.status(400).json({
      error: 'Falta el archivo del comprobante.', codigo: CodigoErrorConciliacion.ARCHIVO_INVALIDO,
    });
    return;
  }

  const motivo = await checkMagicNumber(archivo.buffer, archivo.mimetype, MIMES_COMPROBANTE);
  if (motivo) {
    res.status(400).json({ error: motivo, codigo: CodigoErrorConciliacion.ARCHIVO_INVALIDO });
    return;
  }

  let storageKey: string | null = null;
  try {
    const id = idDe(req);
    const { prefijo } = await destinoComprobante(id, reemplazar);
    // El nombre del OBJETO se normaliza: el que subió el usuario puede traer una placa dentro y esa
    // clave acaba en el query string del enlace firmado (y de ahí a los logs). El original se
    // conserva íntegro en `flito_soportes.nombre_archivo`, dos líneas más abajo.
    storageKey = await uploadEntityDocument(
      prefijo, id, nombreEnAlmacen(archivo.mimetype), archivo.buffer, archivo.mimetype,
    );
    const comprobante = await registrarComprobante(
      id,
      {
        nombreArchivo: archivo.originalname,
        contentType: archivo.mimetype,
        storageKey,
        hash: createHash('sha256').update(archivo.buffer).digest('hex'),
        tamanoBytes: archivo.size,
      },
      ctxDe(req),
      { reemplazar },
    );
    // AC5: la subida autorizada queda auditada. El detalle NO repite el nombre del archivo, que lo
    // escribe el cliente y puede traer una placa dentro («comprobante-ABC123.pdf»); el nombre ya
    // vive en `flito_soportes` y desde `resourceId` se llega a él con control de acceso.
    await audit(req, {
      action: reemplazar ? 'update' : 'create',
      resource: 'flito_conciliacion_boleta',
      resourceId: id,
      detail: `Comprobante PSE ${reemplazar ? 'reemplazado' : 'adjuntado'} · soporte `
        + `${comprobante.id} · ${comprobante.contentType} · ${comprobante.tamanoBytes} bytes`,
    });
    res.status(reemplazar ? 200 : 201).json(comprobante);
  } catch (e) {
    if (storageKey) await deleteEntityDocument(storageKey).catch(() => undefined);
    await falloConRastro(req, res, e);
  }
}

router.post(
  '/boletas/:id/comprobante', CONCILIACION, comprobanteLimiter, recibirComprobante,
  async (req: Request, res: Response) => { await subirComprobante(req, res, false); },
);

router.put(
  '/boletas/:id/comprobante', CONCILIACION, comprobanteLimiter, recibirComprobante,
  async (req: Request, res: Response) => { await subirComprobante(req, res, true); },
);

// GET — firma FRESCA para abrir el archivo. El detalle ya trae una, pero caduca a los cinco
// minutos: pintarla como href estático deja un enlace muerto en pantalla (docs/ux, «Descargar»).
router.get('/boletas/:id/comprobante', CONCILIACION, async (req: Request, res: Response) => {
  try {
    res.json(await descargaComprobante(idDe(req)));
  } catch (e) {
    await falloConRastro(req, res, e);
  }
});

export default router;
