// FLITO — Dr. Flit (Feature #13695). HU #13803: autorización de tratamiento de datos (Ley 1581).
// HU #13804: radicar el caso de soporte como Bug en FLIT - SOPORTE y devolver solo su número.
// Montado en `/api/flito/dr-flit` SIN `conAlcance`. Diseño: docs/diseno/feature-13695-dr-flit-soporte.md
// (contrato, D3) y ADR-0026.
//
//   GET  /autorizacion?finalidad=soporte|ia  — estado de la autorización VIGENTE del propio usuario,
//                                              texto vigente y disponibilidad del soporte. Con
//                                              `finalidad=ia` añade `ia: { disponible, cupo }` (HU #13854).
//   POST /autorizacion                       — registra la aceptación (201 nueva · 200 ya existía).
//   POST /casos-soporte                      — radica el caso (201 nuevo · 200 repetido). Dos formas:
//                                              · `application/json` = `CasoSoporteDrFlit` sin adjuntos
//                                                (HU-2; se mantiene para no romper clientes).
//                                              · `multipart/form-data` (HU-3, #13805): parte de texto
//                                                `caso` = el mismo JSON, y 0..DRFLIT_ADJUNTOS_MAX partes
//                                                de archivo `adjuntos` (o `adjuntos[]`), PNG/JPG/PDF de
//                                                hasta DRFLIT_ADJUNTO_MAX_MB cada una. Reintento = la
//                                                misma petición con la misma clave.
//                                              Errores de adjuntos (sin nombre ni contenido del archivo):
//                                                400 `adjunto-invalido` { adjunto: { indice, motivo } }
//                                                413 `adjunto-muy-grande` { adjunto, limite.maxBytesArchivo }
//                                                413 `adjuntos-limite` { limite.maxArchivos }
//   POST /chat                               — HU #13856 (IA-4): chat con IA. Sub-router en
//                                              `dr-flit-chat.routes.ts` (RN-DRF-CH1..CH3), montado tras
//                                              el `authMiddleware` de RN-DRF-R1.
//
// ── Frontera por enlace (ADR-0024, D3) ──────────────────────────────────────────────────────────
// Dr. Flit es un panel de sesión: sus rutas solo leen o escriben datos DEL PROPIO usuario (`sub` del
// token; nunca un id en la ruta ni en el cuerpo). Por eso no se declara un módulo de frontera: las
// rutas están en `RUTAS_TRANSVERSALES` (`shared/middleware/frontera-enlace.ts`) y así las alcanzan
// todos los enlaces: Corredor SOAT (`proveedor`), Corredor Impuestos (`organismos_transito`) y, desde la
// HU #13941 (decisión de David del 2026-10-24), también la compañía (`cliente`): Dr. Flit no excluye por
// tipo de usuario ni por enlace (se retiró `rechazarEnlaceCompania`). La frontera de los datos de negocio
// no cambia: la consulta de gestión usa los POST /buscar de cada módulo, que siguen bajo `conAlcance`.
//
// ── Quién lo usa: el permiso «Dr. Flit» (HU #13941) ─────────────────────────────────────────────
// Ítem `pagina.flito_dr_flit` (General) con cuatro acciones; cada ruta exige la suya en
// `dr-flit.funciones.ts` (RN-DRF-F1..F3): IA (`drflit.ia.usar`), soporte (`drflit.soporte.radicar`), y la
// IA además «Ver los manuales» (`drflit.manuales.ver`, sonda en el servicio, AC5).
//
// RN-DRF-R1  Toda ruta: authMiddleware → función de Dr. Flit de la ruta (403 drflit-funcion-no-habilitada).
//            /autorizacion la decide por `finalidad`, DESPUÉS de Zod (`ia` → IA, `soporte` → soporte).
// RN-DRF-R2  El único query param (`finalidad`) es un enum sin PII (AGENTS.md §14).
// RN-DRF-R3  Los 400 no repiten el valor recibido: mensajes propios, `campo` es la ruta, nunca el valor.
// RN-DRF-R4  Nada de esta ruta se loguea con datos del usuario (IP y user agent van solo a la tabla).
// RN-DRF-R5  POST /casos-soporte: exigirSoporteDrFlit (403) → drflitCasosLimiter → exigirSoporteDisponible (503) →
//            exigirAutorizacionVigente('soporte') (403 `autorizacion-requerida`, sin llamar a ADO) → Zod →
//            servicio. El chat usa la misma guarda con `'ia'`, que responde 428 (HU #13856).
// RN-DRF-R7  multer (HU #13805) va DESPUÉS de las guardas y del limiter: no se parsea el cuerpo de
//            quien no puede radicar. `memoryStorage` (nada a disco ni a MinIO), `limits` (files,
//            fileSize, fields=1, fieldSize) y un `fileFilter` que solo descarta lo obvio (ni tipo
//            declarado ni extensión admitidos). El MIME REAL lo verifica el servicio por bytes. Un
//            rechazo nombra el archivo por POSICIÓN (0-based) y nunca por su nombre (AC4).
// RN-DRF-R6  Ninguna respuesta lleva URLs, `_links` ni mensajes de ADO: solo `{ numero, repetido }` o
//            el copy propio de `CasoSoporteError`. Un error que no es propio sigue al errorHandler.
// Las reglas del servicio están en `dr-flit.service.ts` (A1..A4) y `dr-flit-casos.service.ts` (S1..S5).
import { isIP } from 'node:net';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  AREAS_SOPORTE, FINALIDADES_DRFLIT, FRECUENCIAS_SOPORTE, LIMITES_CASO_SOPORTE,
  PARTE_ADJUNTOS_MULTIPART, PARTE_CASO_MULTIPART, PRIORIDADES_SOPORTE,
  type CasoSoporteDrFlit, type ErrorAdjuntoDrFlit, type EstadoAutorizacionDrFlit, type FinalidadDrFlit,
} from '@operaciones/shared-types';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { drflitCasosLimiter } from '../../shared/middleware/rateLimiter.js';
import {
  ADJUNTOS_DRFLIT, ambienteDespliegue, etiquetaAmbiente, iaDisponible, soporteDisponible,
} from './dr-flit.config.js';
import { consultarCupoIa } from './dr-flit-ia.cupo.js';
import {
  AutorizacionDrFlitError, aceptarAutorizacion, estadoAutorizacion, repoAutorizaciones, textoVigente, versionVigente,
} from './dr-flit.service.js';
import {
  AdjuntoInvalidoError, CasoSoporteError, mensajeAdjuntoRechazado, radicarCaso, type AdjuntoCaso,
} from './dr-flit-casos.service.js';
import { crearRouterChat } from './dr-flit-chat.routes.js';
import {
  exigirSoporteDrFlit, FUNCION_DE_FINALIDAD, responderFuncionNoHabilitada, tieneFuncionDrFlitPorFinalidad,
} from './dr-flit.funciones.js';

const router = Router();

router.use(authMiddleware);

const MSG_FINALIDAD = 'La finalidad debe ser «soporte» o «ia».';
const finalidadSchema = z.enum(FINALIDADES_DRFLIT, { error: MSG_FINALIDAD });
const consultaSchema = z.object({ finalidad: finalidadSchema });
const aceptarSchema = z.object({
  finalidad: finalidadSchema,
  version: z.string({ error: 'La versión de la autorización es obligatoria.' })
    .min(1).max(40),
}).strict();

const MAX_USER_AGENT = 300;

function origenDe(req: Request): { ip: string | null; userAgent: string | null } {
  const ip = typeof req.ip === 'string' && isIP(req.ip) ? req.ip : null;
  const ua = req.get('user-agent');
  return { ip, userAgent: ua ? ua.slice(0, MAX_USER_AGENT) : null };
}

/** 400 sin eco del valor: el código según el campo, el mensaje propio del esquema. */
function responderInvalido(res: Response, error: z.ZodError): void {
  const issue = error.issues[0];
  const campo = issue?.path.join('.') || null;
  if (campo === 'finalidad') {
    res.status(400).json({ error: MSG_FINALIDAD, codigo: 'finalidad-invalida' });
    return;
  }
  const mensaje = issue?.code === 'unrecognized_keys' ? 'La solicitud trae campos no permitidos.'
    : campo === 'version' ? 'La versión de la autorización es obligatoria.' : 'Solicitud inválida.';
  res.status(400).json({ error: mensaje, codigo: 'campo-invalido', ...(campo ? { campo } : {}) });
}

router.get('/autorizacion', async (req: Request, res: Response) => {
  const q = consultaSchema.safeParse(req.query);
  if (!q.success) { responderInvalido(res, q.error); return; }
  const { finalidad } = q.data;
  if (!(await tieneFuncionDrFlitPorFinalidad(req, finalidad))) { responderFuncionNoHabilitada(res, FUNCION_DE_FINALIDAD[finalidad]); return; }
  const estado = await estadoAutorizacion(req.user!.sub, finalidad);
  const ambiente = ambienteDespliegue();
  const cuerpo: EstadoAutorizacionDrFlit = {
    finalidad,
    autorizado: estado.autorizado,
    versionVigente: estado.versionVigente,
    textoVigente: textoVigente(finalidad),
    aceptadaEn: estado.aceptadaEn ? estado.aceptadaEn.toISOString() : null,
    soporte: {
      disponible: soporteDisponible(),
      ambiente,
      ambienteEtiqueta: etiquetaAmbiente(ambiente),
      adjuntos: ADJUNTOS_DRFLIT,
    },
  };
  // HU #13854 (AC6/AC7): solo con `finalidad=ia`; `soporte` no cambia. Cupo del propio usuario (`sub`).
  if (finalidad === 'ia') {
    const disponible = iaDisponible();
    cuerpo.ia = { disponible, cupo: disponible ? await consultarCupoIa(req.user!.sub) : null };
  }
  res.json(cuerpo);
});

router.post('/autorizacion', async (req: Request, res: Response) => {
  const b = aceptarSchema.safeParse(req.body ?? {});
  if (!b.success) { responderInvalido(res, b.error); return; }
  if (!(await tieneFuncionDrFlitPorFinalidad(req, b.data.finalidad))) {
    responderFuncionNoHabilitada(res, FUNCION_DE_FINALIDAD[b.data.finalidad]);
    return;
  }
  try {
    const { nueva, id, aceptada } = await aceptarAutorizacion(req.user!.sub, b.data.finalidad, b.data.version, origenDe(req));
    if (nueva) {
      await audit(req, {
        action: 'create', resource: 'drflit_autorizacion', resourceId: String(id),
        detail: `finalidad=${aceptada.finalidad} version=${aceptada.version}`,
      });
    }
    res.status(nueva ? 201 : 200).json(aceptada);
  } catch (e) {
    if (e instanceof AutorizacionDrFlitError) {
      res.status(409).json({ error: e.message, codigo: e.codigo });
      return;
    }
    throw e;
  }
});

// ── HU #13804: POST /casos-soporte ──────────────────────────────────────────────────────────────

/** Mensaje propio por campo (AC3): nunca el de Zod, que en un enum incluye `received`. */
export const MENSAJES_CAMPO_CASO: Readonly<Record<string, string>> = Object.freeze({
  claveIdempotencia: 'Falta la clave del envío. Recargue el asistente e intente de nuevo.',
  contacto: 'Faltan los datos de contacto.',
  'contacto.nombre': `Escriba su nombre (máximo ${LIMITES_CASO_SOPORTE.nombre.max} caracteres).`,
  'contacto.correo': 'Escriba un correo válido, por ejemplo nombre@empresa.com.',
  'contacto.telefono': `El teléfono solo admite números, espacios, +, ( ) y guiones (máximo ${LIMITES_CASO_SOPORTE.telefono.max}).`,
  area: 'Elija el área del caso.',
  titulo: `Escriba un título de ${LIMITES_CASO_SOPORTE.titulo.min} a ${LIMITES_CASO_SOPORTE.titulo.max} caracteres.`,
  detalle: `Describa el caso con ${LIMITES_CASO_SOPORTE.detalle.min} a ${LIMITES_CASO_SOPORTE.detalle.max} caracteres.`,
  resultadoEsperado: `Escriba el resultado esperado (máximo ${LIMITES_CASO_SOPORTE.resultadoEsperado.max} caracteres).`,
  frecuencia: 'Elija con qué frecuencia ocurre: Siempre, A veces o Solo una vez.',
  prioridad: 'Elija la prioridad: Alta, Media o Baja.',
});

const texto = (l: { min: number; max: number }) => z.string().trim().min(Math.max(l.min, 1)).max(l.max);
const L = LIMITES_CASO_SOPORTE;
const casoSchema: z.ZodType<CasoSoporteDrFlit> = z.object({
  claveIdempotencia: z.string().guid(),
  contacto: z.object({
    nombre: texto(L.nombre),
    correo: z.string().trim().min(L.correo.min).max(L.correo.max).email(),
    telefono: z.string().trim().max(L.telefono.max).regex(/^[0-9+() -]*$/).optional()
      .transform((v) => (v ? v : undefined)),
  }).strict(),
  area: z.enum(AREAS_SOPORTE),
  titulo: texto(L.titulo),
  detalle: texto(L.detalle),
  resultadoEsperado: texto(L.resultadoEsperado),
  frecuencia: z.enum(FRECUENCIAS_SOPORTE),
  prioridad: z.enum(PRIORIDADES_SOPORTE),
}).strict() as z.ZodType<CasoSoporteDrFlit>;

/** 400 `campo-invalido` sin eco del valor (AC3): `campo` es la ruta, el mensaje es propio. */
function responderCasoInvalido(res: Response, error: z.ZodError): void {
  const issue = error.issues[0];
  if (!issue || issue.code === 'unrecognized_keys') {
    res.status(400).json({ error: 'La solicitud trae campos no permitidos.', codigo: 'campo-invalido' });
    return;
  }
  const campo = issue.path.join('.');
  const mensaje = MENSAJES_CAMPO_CASO[campo] ?? MENSAJES_CAMPO_CASO[String(issue.path[0])] ?? 'Solicitud inválida.';
  res.status(400).json({ error: mensaje, codigo: 'campo-invalido', ...(campo ? { campo } : {}) });
}

/** 503 `soporte-no-disponible` si el cliente de ADO no está configurado. */
export function exigirSoporteDisponible(_req: Request, res: Response, next: NextFunction): void {
  if (!soporteDisponible()) {
    res.status(503).json({
      error: 'El soporte desde Dr. Flit no está disponible en este momento.', codigo: 'soporte-no-disponible',
    });
    return;
  }
  next();
}

/**
 * Rechazo sin la autorización VIGENTE de la finalidad. `soporte` → 403 (HU #13804, AC2, sin cambios);
 * `ia` → 428 (HU #13856, AC2: el panel muestra el consentimiento y reintenta). Mismo `codigo`.
 */
const RECHAZO_SIN_AUTORIZACION: Readonly<Record<FinalidadDrFlit, { status: 403 | 428; error: string }>> = Object.freeze({
  soporte: { status: 403, error: 'Para radicar un caso primero debe aceptar la autorización de tratamiento de datos.' },
  ia: { status: 428, error: 'Para usar la IA de Dr. Flit primero debe aceptar la autorización de tratamiento de datos.' },
});

/** Guarda de autorización VIGENTE (versión actual) de `finalidad`. Deja su id en `res.locals.autorizacionId`. */
export function exigirAutorizacionVigente(finalidad: FinalidadDrFlit) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const fila = await repoAutorizaciones.buscar(req.user!.sub, finalidad, versionVigente(finalidad));
      if (!fila) {
        const { status, error } = RECHAZO_SIN_AUTORIZACION[finalidad];
        res.status(status).json({ error, codigo: 'autorizacion-requerida' });
        return;
      }
      res.locals.autorizacionId = fila.id;
      next();
    } catch (e) {
      next(e);
    }
  };
}

// ── HU #13805: adjuntos en el mismo POST multipart ──────────────────────────────────────────────

const PARTES_ADJUNTO: ReadonlySet<string> = new Set([PARTE_ADJUNTOS_MULTIPART, `${PARTE_ADJUNTOS_MULTIPART}[]`]);
const EXTENSION_ADMITIDA = /\.(png|jpe?g|pdf)$/i;
/** Tope de la parte `caso` (JSON). Holgado frente a `LIMITES_CASO_SOPORTE`, que Zod aplica después. */
export const MAX_BYTES_PARTE_CASO = 64 * 1024;
const MSG_CAMPOS_NO_PERMITIDOS = 'La solicitud trae campos no permitidos.';

/** Una parte de archivo con otro nombre que `adjuntos`: es contrato, no un archivo inválido. */
class ParteNoPermitidaError extends Error {
  constructor() { super(MSG_CAMPOS_NO_PERMITIDOS); this.name = 'ParteNoPermitidaError'; }
}

/** Posición del archivo en curso dentro del multipart: la fija `fileFilter`, la leen los errores. */
const archivosVistos = new WeakMap<object, number>();

const subidaAdjuntos = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: ADJUNTOS_DRFLIT.maxArchivos,
    fileSize: ADJUNTOS_DRFLIT.maxBytesArchivo,
    fields: 1,
    fieldSize: MAX_BYTES_PARTE_CASO,
    fieldNameSize: 32,
  },
  fileFilter: (req, file, cb) => {
    const indice = archivosVistos.get(req) ?? 0;
    archivosVistos.set(req, indice + 1);
    if (!PARTES_ADJUNTO.has(file.fieldname)) { cb(new ParteNoPermitidaError()); return; }
    // Solo lo obvio: ni el tipo declarado ni la extensión son admitidos. El MIME real va en el servicio.
    if ((ADJUNTOS_DRFLIT.tipos as readonly string[]).includes(file.mimetype) || EXTENSION_ADMITIDA.test(file.originalname)) {
      cb(null, true);
      return;
    }
    cb(new AdjuntoInvalidoError(indice, 'tipo-no-permitido'));
  },
}).any();

function responderAdjunto(res: Response, status: 400 | 413, cuerpo: ErrorAdjuntoDrFlit): void {
  res.status(status).json(cuerpo);
}

/** Traduce el error del parseo multipart sin eco de nombres ni valores (RN-DRF-R3, AC4). */
function responderErrorMultipart(res: Response, err: unknown, indice: number): void {
  if (err instanceof AdjuntoInvalidoError) {
    responderAdjunto(res, 400, {
      error: err.message, codigo: 'adjunto-invalido', adjunto: { indice: err.indice, motivo: err.motivo },
    });
    return;
  }
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    const { maxBytesArchivo } = ADJUNTOS_DRFLIT;
    responderAdjunto(res, 413, {
      error: mensajeAdjuntoRechazado(indice, 'muy-grande', maxBytesArchivo), codigo: 'adjunto-muy-grande',
      adjunto: { indice, motivo: 'muy-grande' }, limite: { maxBytesArchivo },
    });
    return;
  }
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT') {
    const { maxArchivos } = ADJUNTOS_DRFLIT;
    responderAdjunto(res, 413, {
      error: maxArchivos === 0 ? 'Este caso no admite adjuntos.' : `Puede adjuntar hasta ${maxArchivos} archivos.`,
      codigo: 'adjuntos-limite', limite: { maxArchivos },
    });
    return;
  }
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FIELD_VALUE') {
    res.status(400).json({ error: 'El caso es demasiado largo.', codigo: 'campo-invalido', campo: PARTE_CASO_MULTIPART });
    return;
  }
  if (err instanceof multer.MulterError || err instanceof ParteNoPermitidaError) {
    res.status(400).json({ error: MSG_CAMPOS_NO_PERMITIDOS, codigo: 'campo-invalido' });
    return;
  }
  // Multipart mal formado (corte del cuerpo, frontera inválida): es del cliente, no un 500.
  res.status(400).json({ error: 'Solicitud inválida.', codigo: 'campo-invalido' });
}

/** multer solo si el cuerpo es multipart; un JSON (HU-2) sigue de largo. */
export function recibirAdjuntos(req: Request, res: Response, next: NextFunction): void {
  if (!req.is('multipart/form-data')) { next(); return; }
  subidaAdjuntos(req, res, (err?: unknown) => {
    const indice = Math.max((archivosVistos.get(req) ?? 1) - 1, 0);
    archivosVistos.delete(req);
    if (!err) { next(); return; }
    req.files = undefined; // suelta lo que alcanzó a entrar
    responderErrorMultipart(res, err, indice);
  });
}

/** Cuerpo del caso y adjuntos, del JSON o del multipart. `null` = la parte `caso` falta o no es JSON. */
function leerEntrada(req: Request): { cuerpo: unknown; adjuntos: AdjuntoCaso[] } | null {
  if (!req.is('multipart/form-data')) return { cuerpo: req.body ?? {}, adjuntos: [] };
  const archivos = Array.isArray(req.files) ? req.files : [];
  req.files = undefined;
  const adjuntos = archivos.map((f) => ({ contenido: f.buffer, tipoDeclarado: f.mimetype }));
  const crudo: unknown = (req.body as Record<string, unknown> | undefined)?.[PARTE_CASO_MULTIPART];
  if (typeof crudo !== 'string') return null;
  try {
    return { cuerpo: JSON.parse(crudo) as unknown, adjuntos };
  } catch {
    return null;
  }
}

const ESTADO_CASO: Readonly<Record<CasoSoporteError['codigo'], number>> = Object.freeze({
  'radicacion-en-curso': 409,
  'ado-error': 502,
  'ado-no-disponible': 503,
});

router.post('/casos-soporte', exigirSoporteDrFlit, drflitCasosLimiter, exigirSoporteDisponible, exigirAutorizacionVigente('soporte'), recibirAdjuntos,
  async (req: Request, res: Response) => {
    const entrada = leerEntrada(req);
    if (!entrada) {
      res.status(400).json({
        error: 'Falta el caso o no es un JSON válido.', codigo: 'campo-invalido', campo: PARTE_CASO_MULTIPART,
      });
      return;
    }
    const b = casoSchema.safeParse(entrada.cuerpo);
    if (!b.success) { responderCasoInvalido(res, b.error); return; }
    try {
      const r = await radicarCaso(req, {
        usuarioId: req.user!.sub,
        autorizacionId: res.locals.autorizacionId as number,
        ambiente: ambienteDespliegue(),
        caso: b.data,
        adjuntos: entrada.adjuntos,
      });
      res.status(r.repetido ? 200 : 201).json({ numero: r.numero, repetido: r.repetido });
    } catch (e) {
      if (e instanceof AdjuntoInvalidoError) {
        responderAdjunto(res, 400, {
          error: e.message, codigo: 'adjunto-invalido', adjunto: { indice: e.indice, motivo: e.motivo },
        });
        return;
      }
      if (e instanceof CasoSoporteError) {
        const reintentable = e.codigo === 'ado-error' || e.codigo === 'ado-no-disponible';
        res.status(ESTADO_CASO[e.codigo]).json({
          error: e.message, codigo: e.codigo, ...(reintentable ? { reintentable: true } : {}),
        });
        return;
      }
      throw e;
    }
  });

// ── HU #13856 (IA-4): POST /chat — hereda el `authMiddleware` de arriba; su función la exige el sub-router ──
router.use(crearRouterChat(exigirAutorizacionVigente('ia')));

export default router;
