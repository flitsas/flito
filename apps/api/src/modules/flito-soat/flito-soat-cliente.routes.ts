// FLITO — SOAT, canal Cliente (HTTP). Feature #11912, HU #11914 (alta), #11915 (revisión) y
// #11935 (alta sin RUNT bloqueante). Montado en `/api/flito/soat`, junto al router del módulo.
// Contrato: ADR-0008 §6; el alta ya no espera a Kyverum (ADR-0009).
//
// ── Por qué un router aparte y montado en la MISMA base ──────────────────────────────────────────
//
// La base es la misma porque el recurso es el mismo (`flito_soat`) y porque el aislamiento por
// compañía tiene que seguir pasando por `contextoSoat()`. El archivo es otro por el techo de líneas
// de `flito-soat.routes.ts` y, sobre todo, porque aquí vive el CICLO ENTERO del canal —radicar,
// validar, rechazar y subsanar— y tenerlo junto es lo que permite leer de una vez quién puede hacer
// qué, con su rate limit, su validación de MIME real y su auditoría a la vista.
//
// Que dos de esas rutas sean del `admin` y no del `cliente` no las saca de aquí: `POST /:id/validar`
// y `POST /:id/rechazar-solicitud` solo aplican a filas con `origen = 'cliente'` y no existen para
// el resto del módulo. Repartirlas entre los dos archivos por el rol que las llama dejaría el ciclo
// contado a medias en cada uno.
//
// No hay colisión de rutas con el router del módulo: sus patrones de segundo nivel son literales
// (`enviar`, `facturas`, `:id/rechazar`, `:id/factura`…) y ninguno casa con los de aquí —`/cliente`,
// `/cliente/preconsulta`, `/causales-rechazo`, `/:id/validar`, `/:id/rechazar-solicitud` y
// `PATCH /:id/solicitud`—. Ojo con el par `:id/rechazar` (allí) y `:id/rechazar-solicitud` (aquí):
// son segmentos LITERALES distintos y Express no los confunde, pero se parecen lo bastante como para
// que convenga decirlo. El montaje va ANTES en `app.ts` para que, si algún día se añadiera un patrón
// que sí casara, gane el específico.
//
// ── PII: nada identificable en la URL (AGENTS.md §14, AC5) ──────────────────────────────────────
//
// Placa, VIN y documento del propietario viajan SIEMPRE en el cuerpo. Por eso la preconsulta es un
// `POST` y no un `GET` con parámetros, aunque no escriba nada: un `GET /preconsulta?placa=…` deja la
// placa en el log de acceso de nginx, en el historial del navegador y en el `Referer`. Las rutas de
// la #11915 siguen el mismo criterio: la observación del rechazo y los datos del propietario van en
// el cuerpo, y en la URL solo queda el uuid del SOAT, que es opaco (AGENTS.md §14 lo permite).
//
// **Deuda que esta HU NO cierra, dicho aquí para que no se dé por hecha.** El ADR-0008 §6 asignaba a
// la #11915 mover el `GET /?buscar=` de la cola a `POST /buscar` —ese término se compara contra
// placa, VIN, nombre y documento del propietario, así que es cuasi-PII en la query—. No entra en
// ningún AC de esta HU y no se ha hecho: sigue siendo deuda PREEXISTENTE (no la introduce este
// canal), ahora sin dueño asignado. Ver el HANDOFF de la HU.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { soatClienteLimiter } from '../../shared/middleware/rateLimiter.js';
import { TIPOS_DOCUMENTO_RUNT } from '@operaciones/shared-types';
import { contextoSoat } from './flito-soat.service.js';
import { registrarAccesoRuntCliente } from './flito-soat.pii.js';
import {
  crearSolicitud, listarCausalesRechazo, preconsulta, rechazarSolicitud, SolicitudSoatError,
  subsanarSolicitud, validarSolicitud, type ArchivoSolicitud,
} from './flito-soat-cliente.service.js';

const router = Router();
router.use(authMiddleware);

/**
 * Solo el `cliente`. Ni siquiera el `admin`: radicar es un acto de la compañía —la solicitud queda
 * atada a `users.compania_id` y firmada con el nombre de quien la radica—, y un admin no tiene
 * compañía, así que su alta acabaría en `SIN_COMPANIA`. Que lo diga `requireRole` y no un error a
 * mitad de camino hace explícito de quién es este canal.
 *
 * Es la SEGUNDA cerradura: la primera es `RUTAS_PERMITIDAS_CLIENTE` (`shared/middleware/
 * canal-cliente.ts`), que niega por defecto todo lo que no esté inscrito allí. Las dos hacen falta
 * y en sentidos opuestos: aquella impide que el `cliente` alcance el resto de la API, esta impide
 * que el resto de los roles alcance el canal.
 */
const CANAL_CLIENTE = requireRole('cliente');

/**
 * La revisión es de Operaciones y de nadie más (AC4).
 *
 * **`proveedor` y `cliente` quedan fuera por ENUMERACIÓN, no por exclusión.** `requireRole` es una
 * lista blanca: nombrar a `admin` deja fuera a los doce roles restantes, incluido el que se invente
 * el mes que viene. La forma tentadora —`requireRole` con todos menos dos, o un `if (role ===
 * 'proveedor') return 403`— es la lista negra que el ADR-0008 §4 acaba de sacar del router de la web,
 * y se rompe en silencio con el primer rol nuevo.
 *
 * `auditor` tampoco está, y es deliberado: auditoría observa, no ejecuta acciones.
 *
 * Para el `cliente` hay ADEMÁS una segunda cerradura: `RUTAS_PERMITIDAS_CLIENTE` no inscribe estas
 * dos rutas, así que su petición ni siquiera llega hasta aquí. Las dos hacen falta y en sentidos
 * opuestos — aquella impide que el rol alcance el resto de la API; esta, que el resto de los roles
 * alcance la acción.
 */
const REVISION_OPERACIONES = requireRole('admin');

/**
 * El adjunto: UN archivo, campo `facturaVenta`, 15 MB como el resto del módulo.
 *
 * El `fileFilter` mira el mime DECLARADO y no basta —se falsifica renombrando el archivo—: el filtro
 * de verdad es `verificarPdfReal()` en el servicio, que olfatea los bytes. Este de aquí solo evita
 * cargar en memoria 15 MB de algo que ya se sabe que no se va a aceptar.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

function manejarError(res: Response, e: unknown): void {
  if (e instanceof SolicitudSoatError) {
    // El `codigo` viaja JUNTO al mensaje, no en su lugar: el mensaje es para la persona y el código
    // para la pantalla (AC2, AC3, AC4). `error` sigue siendo una CADENA, como en todo el repo —el
    // cliente HTTP de la web lo lee así para el toast—, y lo que el caso necesite además va en
    // claves hermanas (`propia`, `id`, `estado` del 409 de RN-01), nunca anidado dentro de `error`.
    res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.datos ?? {}) });
    return;
  }
  throw e;
}

/** Placa y VIN, normalizados en el servicio. Longitudes de columna: `vehicles.plate`/`vin`. */
const vehiculoSchema = z.object({
  placa: z.string().trim().min(4, 'La placa es obligatoria').max(10),
  vin: z.string().trim().min(5, 'El VIN es obligatorio').max(17),
});

/** Mismo criterio que el alta: PII en el cuerpo, nunca en la URL. Sin ellos la pasarela no consulta. */
const documentoSchema = z.object({
  tipoDocumento: z.enum(TIPOS_DOCUMENTO_RUNT),
  numeroDocumento: z.string().trim().min(4, 'El documento del propietario es obligatorio').max(30),
});

const preconsultaSchema = vehiculoSchema.merge(documentoSchema);

/**
 * POST /cliente/preconsulta — paso 1: qué dice el RUNT de este vehículo.
 *
 * Recibe placa, VIN **y documento** (Bug #11927): la pasarela Kyverum exige el documento cuando va
 * la placa. Sin `tipoDocumento`/`numeroDocumento` es 400, no 503. No escribe nada, pero **sí deja
 * rastro de acceso a datos personales**: devuelve la placa, el VIN y, cuando el RUNT lo trae, el
 * nombre del propietario. Es una consulta a un registro nacional sobre un vehículo que puede no ser
 * de quien pregunta, y quien pregunta es una empresa tercera.
 */
router.post('/cliente/preconsulta', CANAL_CLIENTE, soatClienteLimiter, async (req: Request, res: Response) => {
  const parsed = preconsultaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const resultado = await preconsulta(
      parsed.data.placa, parsed.data.vin, parsed.data.numeroDocumento, parsed.data.tipoDocumento, ctx,
    );
    await registrarAccesoRuntCliente(req, { conPropietario: resultado.propietario !== null });
    res.json(resultado);
  } catch (e) { manejarError(res, e); }
});

/**
 * El cuerpo del alta. Llega como `multipart/form-data`, así que TODO campo es texto: no hay booleanos
 * ni números que Zod pueda coaccionar, y los campos opcionales llegan como cadena vacía cuando el
 * formulario los deja sin llenar — de ahí el `.transform` que los pasa a `null`.
 *
 * Marca, línea, modelo, clase, servicio, cilindraje y organismo NO están aquí, y esa ausencia es el
 * AC1: salen del RUNT y no se teclean. Aceptarlos «por comodidad del formulario» permitiría radicar
 * una solicitud con los datos que a uno le apetezca y con un organismo que decide a qué proveedor
 * acaba yendo el caso.
 */
const vacioANull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const altaSchema = vehiculoSchema.merge(documentoSchema).extend({
  nombreCompleto: z.string().trim().min(3, 'El nombre del propietario es obligatorio').max(200),
  correo: z.preprocess(vacioANull, z.string().trim().email('El correo no es válido').max(150).nullable().optional()),
  celular: z.preprocess(vacioANull, z.string().trim().max(30).nullable().optional()),
  direccion: z.preprocess(vacioANull, z.string().trim().max(300).nullable().optional()),
});

/**
 * POST /cliente — crear ES enviar (AC1). Sin borrador.
 *
 * `upload.single` corre DESPUÉS del rate limit a propósito: el limitador tiene que frenar antes de
 * que el proceso cargue 15 MB en memoria, no después.
 */
router.post('/cliente', CANAL_CLIENTE, soatClienteLimiter, upload.single('facturaVenta'), async (req: Request, res: Response) => {
  const parsed = altaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  if (!req.file) { res.status(400).json({ error: 'Falta la factura de venta (PDF)' }); return; }

  const { placa, vin, tipoDocumento, numeroDocumento, nombreCompleto, correo, celular, direccion } = parsed.data;
  const archivo: ArchivoSolicitud = {
    originalname: req.file.originalname, mimetype: req.file.mimetype,
    buffer: req.file.buffer, size: req.file.size,
  };

  try {
    const ctx = await contextoSoat(req.user!);
    const creada = await crearSolicitud(
      { placa, vin, propietario: { tipoDocumento, numeroDocumento, nombreCompleto, correo, celular, direccion } },
      archivo, ctx,
    );
    // El `detail` NO lleva placa, VIN ni documento, y no es una omisión: `audit_logs` es una tabla
    // append-only que se exporta y se lee entera, y el patrón contrario ya existe en el repo
    // (`runt.routes.ts` escribe la placa en su bitácora). El `resourceId` es el uuid del SOAT, que
    // es opaco y basta para reconstruir el caso desde la fila.
    await audit(req, {
      action: 'create', resource: 'flito_soat', resourceId: creada.id,
      detail: `Alta de solicitud SOAT del canal Cliente (origen=cliente, estado=${creada.estado})`,
    });
    res.status(201).json(creada);
  } catch (e) { manejarError(res, e); }
});

// ═════════════════ Revisión del admin, rechazo y subsanación (HU #11915) ═════

/**
 * GET /causales-rechazo — el catálogo que ofrece el formulario del rechazo (AC2).
 *
 * **Solo `admin`, y esa es una desviación consciente del ADR-0008 §6, que lo abría también a
 * `cliente`.** Con el diseño que cerró el `ux-agent`, el Cliente recibe el NOMBRE de su causal ya
 * resuelto dentro de su propio detalle (`solicitud.causalNombre`), así que no necesita el catálogo
 * para nada; y el catálogo completo —qué otras cosas rechaza FLITO— es información de la operación.
 * Una entrada menos en la allowlist del canal es una decisión de exposición menos que justificar.
 *
 * Sin PII: son cinco cadenas de negocio y sus identificadores. No deja rastro en `pii_access_log`
 * por lo mismo que no lo dejan el historial ni los soportes — no proyecta ninguna columna de nadie.
 */
router.get('/causales-rechazo', REVISION_OPERACIONES, async (_req: Request, res: Response) => {
  res.json(await listarCausalesRechazo());
});

/**
 * El destino de la validación: uno y solo uno. Calcado del `refine` de `POST /enviar`, del que es
 * literalmente el mismo problema — a dónde va el SOAT cuando entra en la cola del gestor.
 */
const validarSchema = z.object({
  proveedorSoatId: z.string().uuid().optional(),
  gestionOperaciones: z.boolean().optional(),
}).refine(
  (d) => Boolean(d.proveedorSoatId) !== Boolean(d.gestionOperaciones),
  { message: 'Elige el proveedor al que se envía, o marca que la gestiona Operaciones. Una de las dos, no ambas.' },
);

/**
 * POST /:id/validar — AC1: `pendiente_revision` → `solicitado`, el MISMO estado al que llega un SOAT
 * de trámite cuando Operaciones lo envía al gestor.
 *
 * No lleva rate limit del canal (`soatClienteLimiter`) y no es un olvido: ese limitador es por
 * usuario y existe para frenar a un principal EXTERNO que consulta el RUNT y sube archivos de 15 MB.
 * Aquí el actor es un empleado despachando una cola, y veinte validaciones en quince minutos es un
 * día de trabajo normal, no un abuso.
 */
router.post('/:id/validar', REVISION_OPERACIONES, async (req: Request, res: Response) => {
  const parsed = validarSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const r = await validarSolicitud(req.params.id, parsed.data, ctx);
    const destino = parsed.data.gestionOperaciones ? 'gestión de Operaciones' : `proveedor ${parsed.data.proveedorSoatId}`;
    await audit(req, {
      action: 'update', resource: 'flito_soat', resourceId: r.id,
      detail: `Solicitud del canal Cliente validada (pendiente_revision→solicitado), destino ${destino}`,
    });
    res.json(r);
  } catch (e) { manejarError(res, e); }
});

/**
 * El cuerpo del rechazo. Las DOS obligatorias (AC2), y la observación con LONGITUD MÍNIMA.
 *
 * `min(5)` y no `min(1)`: la observación es lo único que le dice al Cliente qué corregir —la causal
 * es un valor de catálogo, igual para todos los rechazos que la usen—, y un punto o una «x» pasan un
 * `min(1)` dejando al Cliente exactamente donde estaba. Es el mismo umbral que la reversa y el
 * traspaso de gestión ya exigen a su motivo, por la misma razón: son las decisiones que alguien
 * tendrá que poder explicar después.
 *
 * El tope de 500 es el que la pantalla cuenta («0/500»). La columna es `text` y no lo impone, así
 * que lo impone esto: sin límite, el campo que el Cliente lee entero puede llegarle con diez mil
 * caracteres.
 */
const rechazoSchema = z.object({
  causalId: z.string().uuid('Elige una causal del catálogo'),
  observacion: z.string().trim()
    .min(5, 'La observación es demasiado corta. Dile al cliente qué tiene que corregir, en una frase.')
    .max(500),
});

/**
 * POST /:id/rechazar-solicitud — AC2: `pendiente_revision` → `rechazada`, con causal Y observación.
 *
 * **Se llama `rechazar-solicitud` y no `rechazar` porque `POST /:id/rechazar` ya existe y es OTRA
 * COSA**: el rechazo del GESTOR, que lleva a `con_novedad` y escribe `flito_soat.motivo_rechazo`.
 * Otro actor, otro estado destino y otra audiencia; reusar el nombre o la columna mezclaría los dos
 * en el historial de una fila que puede pasar por ambos (ADR-0008 §6).
 *
 * El `detail` de la bitácora lleva el uuid de la causal y NO la observación: esa la escribe una
 * persona sobre un caso concreto y puede nombrar al propietario o su documento, y `audit_logs` es
 * una tabla append-only que se exporta entera (AGENTS.md §14). Vive en su columna, con proyección.
 */
router.post('/:id/rechazar-solicitud', REVISION_OPERACIONES, async (req: Request, res: Response) => {
  const parsed = rechazoSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const r = await rechazarSolicitud(req.params.id, parsed.data, ctx);
    await audit(req, {
      action: 'update', resource: 'flito_soat', resourceId: r.id,
      detail: `Solicitud del canal Cliente rechazada (pendiente_revision→rechazada), causal ${parsed.data.causalId}`,
    });
    res.json(r);
  } catch (e) { manejarError(res, e); }
});

/**
 * El cuerpo de la subsanación: **el propietario, y nada del vehículo** (AC3).
 *
 * Es `altaSchema` MENOS `vehiculoSchema`, y esa resta es la regla: ni `placa` ni `vin` se aceptan.
 * Zod descarta las claves que no declara, así que mandarlas no es un error — simplemente no llegan a
 * ninguna parte, que es el comportamiento correcto: la subsanación no puede cambiar de vehículo.
 * El porqué largo, en `EntradaSubsanacion` del servicio; el corto es que cambiar el VIN convertiría
 * esto en un alta encubierta sobre un vehículo para el que nadie comprobó la RN-01 ni consultó el
 * RUNT, conservando el `id`, el `vehiculo_id` y el organismo del anterior.
 */
const subsanacionSchema = z.object({
  tipoDocumento: z.enum(TIPOS_DOCUMENTO_RUNT),
  numeroDocumento: z.string().trim().min(4, 'El documento del propietario es obligatorio').max(30),
  nombreCompleto: z.string().trim().min(3, 'El nombre del propietario es obligatorio').max(200),
  correo: z.preprocess(vacioANull, z.string().trim().email('El correo no es válido').max(150).nullable().optional()),
  celular: z.preprocess(vacioANull, z.string().trim().max(30).nullable().optional()),
  direccion: z.preprocess(vacioANull, z.string().trim().max(300).nullable().optional()),
});

/**
 * PATCH /:id/solicitud — AC3: el Cliente corrige y reenvía LA MISMA fila, que vuelve a
 * `pendiente_revision`.
 *
 * La ruta que la HU #11914 dejó sin existir: el botón «Reenviar la solicitud» ya está escrito contra
 * ella (`CorreccionSolicitud.tsx`) y hasta hoy respondía 403 —no del router, sino de la allowlist del
 * canal, que niega por defecto lo que no está inscrito—. Entra en `RUTAS_PERMITIDAS_CLIENTE` con su
 * `porque`, junto a las dos del alta.
 *
 * `PATCH` y no `POST` porque es una modificación parcial de un recurso que ya existe, que es
 * exactamente lo que la palabra dice; y el adjunto es OPCIONAL, así que `upload.single` no exige
 * archivo: sin uno nuevo se conserva el que ya estaba cargado.
 *
 * Rate limit del canal, como las otras dos rutas de escritura del `cliente`, y por delante de
 * `upload.single` por lo mismo que en el alta: el freno tiene que actuar antes de que el proceso
 * cargue 15 MB en memoria, no después.
 */
router.patch('/:id/solicitud', CANAL_CLIENTE, soatClienteLimiter, upload.single('facturaVenta'), async (req: Request, res: Response) => {
  const parsed = subsanacionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const { tipoDocumento, numeroDocumento, nombreCompleto, correo, celular, direccion } = parsed.data;
  const archivo: ArchivoSolicitud | null = req.file
    ? { originalname: req.file.originalname, mimetype: req.file.mimetype, buffer: req.file.buffer, size: req.file.size }
    : null;

  try {
    const ctx = await contextoSoat(req.user!);
    const r = await subsanarSolicitud(
      req.params.id,
      { propietario: { tipoDocumento, numeroDocumento, nombreCompleto, correo, celular, direccion } },
      archivo, ctx,
    );
    // Sin placa, sin VIN y sin documento del propietario, igual que el alta: el `resourceId` es el
    // uuid del SOAT, que es opaco y basta para reconstruir el caso desde la fila.
    await audit(req, {
      action: 'update', resource: 'flito_soat', resourceId: r.id,
      detail: `Subsanación de la solicitud del canal Cliente (rechazada→pendiente_revision)${archivo ? ', con factura de venta nueva' : ', sin cambiar la factura'}`,
    });
    res.json(r);
  } catch (e) { manejarError(res, e); }
});

export default router;
