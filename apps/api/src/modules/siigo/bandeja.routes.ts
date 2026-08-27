// Siigo — la bandeja de fallidos (HU #11340, Feature #11244). Montado en /api/siigo/bandeja.
//
// SEIS DECISIONES QUE SE LEEN EN EL ROUTER Y NO EN UN COMENTARIO SUELTO
//
//   1. **Los filtros con cuasi-PII van en el CUERPO, nunca en la query** (AGENTS.md §14). La lista de
//      clientes identifica titulares, y una URL es el peor sitio donde dejar eso: la escribe entera
//      el access log del proxy, la guarda el historial del navegador y viaja en el `Referer` de la
//      petición siguiente — tres registros fuera de la retención del módulo y del `pii_access_log`
//      que la Ley 1581 exige. La paginación sí va en la query: no identifica a nadie. Es el patrón
//      de `flito-comparendos.routes.ts` (`POST /registros/buscar`), y por eso `/buscar` responde
//      **200**: no crea nada.
//   2. **El ambiente sale de `env.SIIGO_AMBIENTE` y NUNCA del cuerpo.** Los esquemas son `.strict()`
//      para que intentarlo dé un 400 ruidoso en vez de ignorarse: un campo ignorado deja a quien
//      llama convencido de que se le hizo caso.
//   3. **Ni un `requireRole` nuevo, ni una constante de permisos nueva.** `ACCIONES_SIIGO` ya trae
//      `consultar`, `reintentar`, `reenviar_correo`, `marcar_fallido` y `reactivar` con sus filas de
//      roles; el slug de página `siigo_operacion` ya existe y ya lo tienen `financiera` y `auditor`.
//      Esta historia no crea permisos: los consume. Las guardas van como middleware ANTES del
//      handler —nunca dentro— para que una ruta que se olvide de una se note leyendo el `router.<verbo>`.
//   4. **`auditor` ve la bandeja y no ejecuta nada** (AC7). No es una línea de este archivo: es
//      `ROLES_POR_ACCION`, donde `consultar` incluye a auditoría y el resto no. Auditar es mirar.
//   5. **Dos endpoints de reintento y no uno.** El de emisión encola y vuelve en milisegundos → 202,
//      porque cuando contesta la factura todavía no existe. El de correo llama a Siigo dentro de la
//      petición y gasta cuota → 200, porque el acta ya existe. Uno solo tendría que mentir sobre uno
//      de los dos códigos y compartir un tope que para el correo es peligroso (100 correos).
//   6. **El limitador va ANTES de la guarda**, igual que en `envio-correo.routes.ts` y por lo mismo
//      (deuda del PR #194, cerrada en la HU #11299): `exigirAccionSiigo` escribe una fila
//      `permiso_denegado` en `siigo_operaciones` por cada 403, y esa tabla es append-only por
//      disparador. Con la guarda delante, un autenticado sin permiso podía meterle las ~500 filas
//      que le permitiera `apiLimiter` en una bitácora que nadie puede podar.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  SIIGO_BANDEJA_FUENTES, SIIGO_BANDEJA_MOTIVOS_DESCARTE, SIIGO_BANDEJA_NOTA_MAX,
  SIIGO_BANDEJA_PAGINA_MAX, SIIGO_BANDEJA_TOPE_REENVIO, SIIGO_BANDEJA_TOPE_REINTENTO,
} from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { authMiddleware } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { frenoConRastro, makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { loggerFor } from '../../shared/logger.js';
import { exigirAccionSiigo, registrarAccionSiigo } from './siigo.permisos.js';
import { CAMPOS_PII_BANDEJA, registrarAccesoCliente } from './siigo.pii.js';
import { consultarBandeja, resumenBandeja } from './siigo.bandeja.service.js';
import {
  descartarCaso, reactivarCaso, reenviarCorreo, reintentarEmision, SiigoBandejaError,
} from './siigo.bandeja-acciones.service.js';
import { SiigoColaError } from './facturacion.cola.service.js';
import { SiigoIntegracionFrenadaError } from './siigo.freno.service.js';
import { detalleTecnico } from './siigo.redaccion.js';

const router = Router();
router.use(authMiddleware);

const log = loggerFor('siigo-bandeja');

/** Mirar la bandeja es lectura, y la lectura sí llega hasta auditoría (AC7). */
const LECTURA = exigirAccionSiigo('consultar');
const REINTENTO = exigirAccionSiigo('reintentar');
const CORREO = exigirAccionSiigo('reenviar_correo');
const DESCARTE = exigirAccionSiigo('marcar_fallido');
const REACTIVACION = exigirAccionSiigo('reactivar');

/** La pantalla refresca y quien concilia pagina: el techo de consulta es el del resto del módulo. */
const consultaLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: userOrIpKey('siigo-bandeja-consulta'),
  message: { error: 'Demasiadas consultas seguidas. Espera un momento.' },
  handler: frenoConRastro('siigo-bandeja-consulta'),
  store: makeStore('rl:siigo-bandeja-consulta:'),
});

/**
 * El de las acciones. Mucho más estrecho: cada petición puede reencolar cien lotes, y todo lo que
 * entre en la cola acabará saliendo a Siigo contra una cuota de 100 peticiones por minuto compartida
 * con todo lo demás. Un cliente en bucle no produciría facturas duplicadas —lo impiden los índices y
 * el reclamo de clave— pero sí llenaría la cola de trabajo que tardaría horas en vaciarse.
 */
const accionLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyGenerator: userOrIpKey('siigo-bandeja-accion'),
  message: { error: 'Demasiadas acciones seguidas. Espera un momento antes de volver a intentarlo.' },
  handler: frenoConRastro('siigo-bandeja-accion'),
  store: makeStore('rl:siigo-bandeja-accion:'),
});

/**
 * El reenvío de correo tiene el SUYO, y más bajo todavía.
 *
 * Es la única rama que sale a la red desde esta pantalla: veinte facturas por petición y treinta
 * peticiones por cuarto de hora acotan lo que un solo usuario puede hacerle llegar al buzón de los
 * clientes. Es el mismo techo que `envio-correo.routes.ts`, que es la otra puerta al mismo envío.
 */
const correoLimiter = rateLimit({
  windowMs: 900_000,
  max: 30,
  keyGenerator: userOrIpKey('siigo-bandeja-correo'),
  message: { error: 'Demasiados reenvíos seguidos. Espera unos minutos.' },
  handler: frenoConRastro('siigo-bandeja-correo'),
  store: makeStore('rl:siigo-bandeja-correo:'),
});

// ── Esquemas ────────────────────────────────────────────────────────────────

/** Paginación: no identifica a nadie, así que viaja en la query y se comparte entre `/buscar` y `/resumen`. */
const paginacionSchema = z.object({
  limite: z.coerce.number().int().min(1).max(SIIGO_BANDEJA_PAGINA_MAX).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
}).strict();

/**
 * Los filtros. **`clientes` es la razón de que esto sea un POST**: identifica titulares.
 *
 * `antiguedadDias*` se acota a dos años. No es una restricción de negocio: sin tope, un valor
 * absurdo llega a un `interval` de la consulta y produce una fecha fuera de rango que revienta en el
 * motor, con la sentencia y sus parámetros dentro del error.
 */
const filtrosSchema = z.object({
  fuentes: z.array(z.enum(SIIGO_BANDEJA_FUENTES)).min(1).max(SIIGO_BANDEJA_FUENTES.length).optional(),
  codigos: z.array(z.string().trim().min(1).max(80)).min(1).max(40).optional(),
  clientes: z.array(z.number().int().positive()).min(1).max(200).optional(),
  antiguedadDiasMin: z.number().int().min(0).max(730).optional(),
  antiguedadDiasMax: z.number().int().min(0).max(730).optional(),
  incluirDescartados: z.boolean().optional(),
}).strict();

const reintentoSchema = z.object({
  facturaIds: z.array(z.string().uuid()).min(1).max(SIIGO_BANDEJA_TOPE_REINTENTO),
}).strict();

const reenvioSchema = z.object({
  facturaIds: z.array(z.string().uuid()).min(1).max(SIIGO_BANDEJA_TOPE_REENVIO),
}).strict();

/**
 * AC5 — el motivo es OBLIGATORIO y sale de un catálogo CERRADO.
 *
 * **`z.enum(SIIGO_BANDEJA_MOTIVOS_DESCARTE)` es el punto donde la decisión de Habeas Data se hace
 * efectiva.** Sin esto, la pantalla pintaría unos radios contra un servidor que acepta texto libre y
 * la decisión se saltaría con un `curl`: un NIT tecleado a mano acabaría en `siigo_operaciones`, que
 * prohíbe UPDATE y DELETE, y los derechos de rectificación y supresión (Ley 1581, art. 8) dejarían de
 * poder ejercerse sobre ese dato para siempre. El catálogo vive en `@operaciones/shared-types` y es
 * literalmente el mismo array que consume la pantalla: no hay dos listas que puedan separarse.
 *
 * La nota es opcional y corta —también forma parte de la decisión—. **Zod aquí NO la redacta**: solo
 * limita su longitud y le quita los espacios. Quien la deja apta para una tabla WORM es
 * `normalizarNota` en el servicio, que le pasa `sanearMensaje` (volcados de SQL) y
 * `redactarPIIEnTextoLibre` (la cédula o el nombre que teclea una persona) antes del INSERT. Decirlo
 * así importa: la versión anterior de este párrafo afirmaba que el servicio «la vuelve a sanear», y
 * quien lo leyera daba por cubierta una redacción de PII que no existía en ninguna de las dos capas.
 */
const descarteSchema = z.object({
  fuente: z.enum(SIIGO_BANDEJA_FUENTES),
  refId: z.string().uuid(),
  motivo: z.enum(SIIGO_BANDEJA_MOTIVOS_DESCARTE),
  nota: z.string().trim().max(SIIGO_BANDEJA_NOTA_MAX).optional(),
}).strict();

const reactivacionSchema = z.object({
  fuente: z.enum(SIIGO_BANDEJA_FUENTES),
  refId: z.string().uuid(),
}).strict();

function datosInvalidos(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: 'Datos inválidos', details: error.flatten() });
}

// ── AC1 — consultar ─────────────────────────────────────────────────────────

/**
 * `POST /buscar` — la bandeja, filtrada y paginada. **200: no crea nada.**
 *
 * El registro de acceso PII va DESPUÉS de la consulta y con `await`: `filas` no se sabe antes, y un
 * rastro que se pierde porque el proceso murió entre la respuesta y el INSERT no es un rastro. La
 * respuesta entrega la razón social del cliente, así que la lectura toca datos de terceros y el
 * art. 17 de la Ley 1581 pide dejar constancia; el NIT no sale, y por eso `campos` solo declara
 * `name` —declarar de más señalaría a quien solo vio nombres—.
 *
 * Sin cuerpo es una búsqueda sin filtros de identidad, no un error: `req.body` puede ni existir si el
 * cliente no manda `Content-Type`.
 */
router.post('/buscar', consultaLimiter, LECTURA, async (req: Request, res: Response) => {
  const query = paginacionSchema.safeParse(req.query);
  if (!query.success) { datosInvalidos(res, query.error); return; }
  const cuerpo = filtrosSchema.safeParse(req.body ?? {});
  if (!cuerpo.success) { datosInvalidos(res, cuerpo.error); return; }

  const pagina = await consultarBandeja({
    ambiente: env.SIIGO_AMBIENTE, ...query.data, ...cuerpo.data,
  });

  await registrarAccesoCliente(req, {
    accion: 'search',
    campos: CAMPOS_PII_BANDEJA,
    // Los casos entregados, no los clientes distintos: es lo que de verdad salió por el cable.
    filas: pagina.items.length,
    filtros: cuerpo.data as Record<string, unknown>,
  });

  res.set('Cache-Control', 'no-store');
  res.json(pagina);
});

/**
 * `GET /resumen` — cuántos casos hay, de qué tipo y a quién le tocan.
 *
 * **Es un GET y a propósito**, aunque `/buscar` sea POST: aquí no viajan filtros de identidad —el
 * resumen es de toda la bandeja del ambiente— y un GET es idempotente, cacheable de negociar y
 * reintentable. El `.strict()` de la paginación convierte un `?clientes=` en un 400, así que no hay
 * forma de colar identidad por esta puerta; la búsqueda filtrada es la otra ruta.
 *
 * No devuelve ni un nombre ni un identificador de cliente: son conteos por fuente, responsable y
 * código. Por eso NO deja registro de acceso PII — un log que afirmara que alguien leyó identidades
 * que nunca salieron de la base es tan inservible como uno que falta (mismo criterio que
 * `CAMPOS_PII_RESUMEN`).
 */
router.get('/resumen', consultaLimiter, LECTURA, async (req: Request, res: Response) => {
  const query = paginacionSchema.safeParse(req.query);
  if (!query.success) { datosInvalidos(res, query.error); return; }

  res.set('Cache-Control', 'no-store');
  res.json(await resumenBandeja({ ambiente: env.SIIGO_AMBIENTE }));
});

// ── AC2, AC3 y AC4 — reintentar ─────────────────────────────────────────────

/**
 * `POST /reintentar` — reencola las emisiones fallidas. **202, y no 201 ni 200.**
 *
 * Cuando esta ruta contesta no existe ninguna factura nueva: lo que existe es una fila de cola. Un
 * 201 con `Location` prometería un documento que quizá nunca llegue a emitirse, y quien integre lo
 * iría a buscar.
 *
 * **No llama a Siigo** (AC4). La emisión —y con ella el reclamo de clave que impide la doble
 * factura— la hace después el trabajador. Ver la cabecera de `siigo.bandeja-acciones.service.ts`.
 *
 * Responde 202 con el desglose entero también cuando no se encoló ni una: un 4xx global por una
 * factura descartada obligaría a operar la bandeja de una en una, y el AC3 dice explícitamente que
 * lo descartado se informa, no que tumbe la operación.
 */
router.post('/reintentar', accionLimiter, REINTENTO, async (req: Request, res: Response) => {
  const parsed = reintentoSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  let salida;
  try {
    salida = await reintentarEmision({
      // AQUÍ, y en ningún otro sitio. El cuerpo no participa en esta línea.
      ambiente: env.SIIGO_AMBIENTE,
      facturaIds: parsed.data.facturaIds,
      usuarioId: req.user?.sub ?? null,
    });
  } catch (e) { fallo(res, e); return; }

  const r = salida.resumen;
  await rastro(req, 'reintentar', {
    resource: 'siigo_cola_facturacion',
    resourceId: parsed.data.facturaIds.join(','),
    entidadId: parsed.data.facturaIds.length === 1 ? parsed.data.facturaIds[0]! : null,
    statusHttp: 202,
    codigo: `encolados=${r.encolados};descartados=${r.descartados}`,
    detalle: `Reintento desde la bandeja (${salida.ambiente}): ${r.total} facturas · `
      + `${r.encolados} encoladas · ${r.yaEstaban} ya estaban · ${r.descartados} descartadas`,
  });
  res.status(202).json(salida);
});

/**
 * `POST /reenviar-correo` — reenvía la factura al cliente. **200, y con motivo.**
 *
 * A diferencia del reintento de emisión, aquí la llamada a Siigo ocurre DENTRO de la petición y el
 * acta ya existe cuando esto contesta: 200 dice la verdad y 202 no. Y por eso el tope es 20 y no 100,
 * y tiene su propio limitador de quince minutos.
 */
router.post('/reenviar-correo', correoLimiter, CORREO, async (req: Request, res: Response) => {
  const parsed = reenvioSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  let salida;
  try {
    salida = await reenviarCorreo({
      ambiente: env.SIIGO_AMBIENTE,
      facturaIds: parsed.data.facturaIds,
      usuarioId: req.user?.sub ?? null,
    });
  } catch (e) { fallo(res, e); return; }

  const r = salida.resumen;
  await rastro(req, 'reenviar_correo', {
    resource: 'siigo_factura_envios',
    resourceId: parsed.data.facturaIds.join(','),
    entidadId: parsed.data.facturaIds.length === 1 ? parsed.data.facturaIds[0]! : null,
    statusHttp: 200,
    codigo: `enviados=${r.enviados};descartados=${r.descartados}`,
    // Cuántas facturas y cómo les fue; nunca a qué direcciones. El acta es el registro autorizado
    // para guardar las direcciones y el único que se puede purgar por un derecho de supresión.
    detalle: `Reenvío de correo desde la bandeja (${salida.ambiente}): ${r.total} facturas · `
      + `${r.enviados} enviadas · ${r.descartados} sin enviar`,
  });
  res.json(salida);
});

// ── AC5 y AC6 — darlo por perdido y resucitarlo ─────────────────────────────

/**
 * `POST /descartar` — AC5. Exige motivo del catálogo cerrado; deja de reintentarse; queda escrito
 * quién y cuándo en una tabla que nadie puede editar ni borrar.
 */
router.post('/descartar', accionLimiter, DESCARTE, async (req: Request, res: Response) => {
  const parsed = descarteSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  let salida;
  try {
    salida = await descartarCaso({
      ambiente: env.SIIGO_AMBIENTE,
      ...parsed.data,
      usuarioId: req.user?.sub ?? null,
    });
  } catch (e) { fallo(res, e); return; }

  await rastro(req, 'marcar_fallido', {
    resource: 'siigo_cola_facturacion',
    resourceId: salida.facturaId,
    entidadId: salida.colaId ?? salida.refId,
    statusHttp: 200,
    codigo: parsed.data.motivo,
    // El código del motivo, NO la nota: la nota ya está en la bitácora del módulo, saneada y
    // recortada, y copiarla a `audit_logs` abriría una segunda copia que ninguna purga alcanza.
    detalle: `Caso «${salida.fuente}» dado por perdido · motivo ${parsed.data.motivo}`,
  });
  res.json(salida);
});

/**
 * `POST /reactivar` — AC6. Lo dado por perdido vuelve, y el marcado anterior sigue en la bitácora.
 *
 * Guarda propia (`reactivar`) y no la de `marcar_fallido`, aunque hoy resuelvan a los mismos roles:
 * esa coincidencia es de hoy, y la pregunta 16 del diseño de la Feature sigue abierta. Deducir el
 * permiso de la acción equivocada es la trampa de «dos definiciones» que el AC6 de la HU #11328 evita
 * para `emitir`; no tiene sentido evitarla allí y caer en ella aquí.
 */
router.post('/reactivar', accionLimiter, REACTIVACION, async (req: Request, res: Response) => {
  const parsed = reactivacionSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  let salida;
  try {
    salida = await reactivarCaso({
      ambiente: env.SIIGO_AMBIENTE,
      ...parsed.data,
      usuarioId: req.user?.sub ?? null,
    });
  } catch (e) { fallo(res, e); return; }

  await rastro(req, 'reactivar', {
    resource: 'siigo_cola_facturacion',
    resourceId: salida.facturaId,
    entidadId: salida.colaId ?? salida.refId,
    statusHttp: 200,
    codigo: salida.resultado,
    detalle: `Caso «${salida.fuente}» resucitado · resultado ${salida.resultado} · `
      + `descarte anterior de ${salida.descarteAnterior?.marcadoEn ?? 'origen desconocido'}`,
  });
  res.json(salida);
});

// ── Rastro y traducción a HTTP ──────────────────────────────────────────────

/**
 * Dos registros y no uno, porque responden a dos preguntas y las hacen dos personas distintas: la
 * auditoría general (`audit_logs`) la consulta cumplimiento —usuario, IP, cuándo—, y la bitácora del
 * módulo (`siigo_operaciones`) la consulta quien diagnostica una emisión, junto al resto de
 * operaciones de la misma factura.
 *
 * **No lanza nunca**, y el `try` no sobra aunque `audit` y `registrarAccionSiigo` ya se traguen sus
 * errores: para cuando esto corre, la cola YA tiene las filas dentro. Un fallo aquí convertido en 500
 * haría creer a quien pulsó que no se hizo nada, y lo normal entonces es volver a pulsar — sobre un
 * trabajo que ya está en marcha.
 */
async function rastro(req: Request, accion: Parameters<typeof registrarAccionSiigo>[1], d: {
  resource: string;
  resourceId: string;
  entidadId: string | null;
  statusHttp: number;
  codigo: string;
  detalle: string;
}): Promise<void> {
  try {
    await audit(req, {
      action: 'update', resource: d.resource, resourceId: d.resourceId, detail: d.detalle,
    });
    await registrarAccionSiigo(req, accion, {
      entidadTipo: 'siigo_cola',
      entidadId: d.entidadId,
      statusHttp: d.statusHttp,
      codigo: d.codigo,
      mensaje: d.detalle,
    });
  } catch (e) {
    // `detalleTecnico` y no `e.message`: quien falla aquí es un INSERT, y desde drizzle 0.45 el
    // mensaje del driver viene envuelto en `Failed query: … params: …`. Hoy esos parámetros son
    // conteos, códigos y UUIDs, pero este es el módulo que escribió el redactor y era el único
    // sitio del código nuevo que se lo saltaba.
    log.error({ err: detalleTecnico(e), accion }, 'rastro de la bandeja fallido');
  }
}

/**
 * Traduce los fallos de dominio a HTTP.
 *
 * `en_proceso` es **409 y no 500**: no está roto nada, es que un trabajador tiene la fila ahora mismo
 * y pisarla sería peor que esperar. El freno es **503 y no 409**: no es que la petición esté mal, es
 * que el servicio de abajo no está disponible y se podrá reintentar cuando alguien lo reactive; un
 * 4xx haría creer a quien integra que tiene que cambiar lo que envía.
 *
 * Lo que no reconoce se relanza: un error inesperado tiene que llegar al manejador global y salir
 * como 500 con su traza, no disfrazarse de rechazo de negocio.
 */
function fallo(res: Response, e: unknown): void {
  if (e instanceof SiigoIntegracionFrenadaError) {
    res.status(503).json({ error: e.message, codigo: 'integracion_frenada', freno: e.estado });
    return;
  }
  if (e instanceof SiigoBandejaError) {
    res.status(e.codigo === 'no_existe' ? 404 : 409).json({ error: e.message, codigo: e.codigo });
    return;
  }
  if (e instanceof SiigoColaError) {
    res.status(e.codigo === 'sin_tramites' ? 400 : 409).json({ error: e.message, codigo: e.codigo });
    return;
  }
  throw e;
}

export default router;
