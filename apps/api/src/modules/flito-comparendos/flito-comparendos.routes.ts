// FLITO comparendos — frontera HTTP de los catálogos (Feature #11492 17a, HU #11497), del token
// SIMIT (HU #11498), de la sincronización (HU #11500) y de la lectura del consolidado (HU #11502).
//
// Base: `/api/flito/comparendos`. Aquí solo se valida, se traduce y se deja rastro; las reglas de
// negocio y todo el acceso a datos viven en `flito-comparendos.service.ts` (RN-01..RN-06), en
// `flito-comparendos.token.service.ts` (RN-07..RN-10), en `flito-comparendos.sync.service.ts`
// (RN-15..RN-24) y en `flito-comparendos.registros.service.ts` (RN-31..RN-34), en sus cabeceras.
// Este módulo NO es el gate SIMIT del traspaso ni el pre-vuelo: ver ADR-0001.
//
// Lo que falta de la superficie del Feature —el PATCH de gestión (causal/observación) y el export—
// es de 17b y se añadirá sobre este mismo router. Toda lectura que devuelva datos personales deja
// rastro con `registrarAccesoComparendos` (HU #11511, Ley 1581 art. 17) y sale con
// `Cache-Control: no-store`.
//
// **Los filtros de identidad no viajan en la URL** (AGENTS.md §14): buscar por NIT o por placa es
// `POST /registros/buscar` con esos dos valores en el CUERPO. La query solo lleva lo que no
// identifica a nadie —estado, número de comparendo, paginación— y el `:id` del path es un UUID
// opaco, que la norma admite explícitamente.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { COMPARENDOS_REGISTROS_LIMIT_MAX } from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { ComparendosError } from './flito-comparendos.errors.js';
import {
  actualizarCausal,
  actualizarMunicipio,
  actualizarNit,
  crearCausal,
  crearMunicipio,
  crearNit,
  eliminarNit,
  listarCausales,
  listarMunicipios,
  listarNits,
  normalizarCodigoFuente,
  normalizarNit,
} from './flito-comparendos.service.js';
import { guardarTokenSimit, obtenerMetaTokenSimit } from './flito-comparendos.token.service.js';
import {
  listarEventos,
  listarRegistros,
  obtenerRegistro,
  type FiltroRegistros,
} from './flito-comparendos.registros.service.js';
import {
  CAMPOS_PII_REGISTRO,
  CAMPOS_PII_SYNC_RUN,
  RECURSO_REGISTROS,
  RECURSO_SYNC_RUN,
  registrarAccesoComparendos,
} from './flito-comparendos.pii.js';
import {
  ejecutarSync,
  listarSyncRuns,
  obtenerSyncRun,
} from './flito-comparendos.sync.service.js';

const router = Router();

// Los dos guardas van a nivel de ROUTER y no ruta por ruta. El CF-12 fusionó `operaciones` en
// `admin`, así que no hay en este módulo ni una sola ruta con un rol distinto ni una lectura
// abierta a `auditor`: la parametrización decide a qué NITs se les consulta la deuda de tránsito y
// eso no es información de consulta general. Puesto aquí, la próxima ruta que alguien añada nace
// protegida en vez de depender de que se acuerde del guard.
router.use(authMiddleware);
router.use(requireRole('admin'));

// ─────────────────────────────── Utilidades del borde ───────────────────────────────────────────

/**
 * Traduce el error de dominio a HTTP y deja pasar lo demás.
 *
 * Lo que no sea `ComparendosError` se relanza a propósito: `express-async-errors` lo lleva al
 * manejador global, que responde 500 y lo registra. Convertir aquí cualquier excepción en un 400
 * escondería fallos reales detrás de un mensaje de validación.
 */
function fallo(res: Response, e: unknown): void {
  if (e instanceof ComparendosError) {
    res.status(e.status).json({ error: e.message, codigo: e.codigo });
    return;
  }
  throw e;
}

function datosInvalidos(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: 'Datos inválidos', details: error.flatten() });
}

// ─────────────────────────────── Limitadores de escritura ──────────────────────────────────────
//
// Van sobre rutas concretas y después de los guardas del router: quien no pasa `authMiddleware` o
// `requireRole` ni siquiera consume cuota, así que un 401 en bucle no puede agotarle el cupo a un
// administrador legítimo. `userOrIpKey` cuenta por usuario cuando lo hay (y por IP normalizada a
// /64 cuando no), de modo que dos administradores no se pisan la cuota entre sí.

/**
 * `PUT` del token: 10 por minuto y usuario.
 *
 * Configurar el token es un gesto humano que ocurre una vez y se repite cuando el proveedor lo
 * rota. Un límite estrecho es lo que convierte este endpoint en un mal sitio para probar valores a
 * ciegas —cada intento cifra, abre transacción y escribe una fila de historial—, y de paso acota lo
 * que puede hacer una sesión de administrador robada antes de que salte el ruido en auditoría.
 */
const tokenLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-comparendos-token'),
  message: { error: 'Demasiadas actualizaciones del token SIMIT, espere 1 minuto' },
  store: makeStore('rl:flito-comparendos-token:'),
});

/**
 * Alta de NITs monitoreados: 30 por minuto y usuario.
 *
 * Lo pidió el gate de seguridad de la HU #11497 y no es un límite de higiene: cada NIT del catálogo
 * multiplica las llamadas que el sync hace contra Verifik en CADA corrida, así que dar de alta
 * cientos de NITs en un bucle no llena una tabla, agota la cuota contratada con el proveedor y deja
 * el módulo sin sincronizar para todos. Más holgado que el del token porque cargar el catálogo
 * inicial a mano es un caso real; 30/min sigue haciendo imposible el bucle.
 */
const altaNitLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-comparendos-nit'),
  message: { error: 'Demasiadas altas de NIT, espere 1 minuto' },
  store: makeStore('rl:flito-comparendos-nit:'),
});

/**
 * `POST /sync`: 4 corridas por minuto y usuario.
 *
 * El más estrecho de los tres, y con diferencia el que más protege: cada corrida son
 * `NITs × (1 + municipios activos)` peticiones a los proveedores, hechas de verdad y contra una
 * cuota que se paga. Con 20 NITs y 8 municipios, una sola corrida son 180 llamadas; un doble clic
 * impaciente en la pantalla las duplica. El 409 de `sync_en_curso` ya impide el solapamiento, pero
 * no impide encadenar corridas seguidas — eso lo hace este límite.
 */
const syncLimiter = rateLimit({
  windowMs: 60_000,
  max: 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-comparendos-sync'),
  message: { error: 'Demasiadas sincronizaciones seguidas, espere 1 minuto' },
  store: makeStore('rl:flito-comparendos-sync:'),
});

/**
 * Lectura del consolidado: 60 peticiones por minuto y usuario.
 *
 * Es el único limitador del módulo que protege una LECTURA, y no está aquí por coste de cómputo
 * —una página es un SELECT con `LIMIT`— sino por lo que se lee: cada página son hasta
 * `COMPARENDOS_REGISTROS_LIMIT_MAX` filas con NIT y placa, y paginar en bucle es exactamente la
 * forma de vaciar un módulo de datos personales sin lanzar un solo error.
 *
 * **Este límite no corta el bucle: le pone precio.** Multiplicado por el tamaño de página, el techo
 * real es 60 × 50 = **3 000 NITs y placas por minuto y usuario** —180 000 a la hora—, así que quien
 * tenga una sesión de administrador válida puede vaciar el módulo si le dedica tiempo. Lo que hace
 * este limitador es que ese vaciado tarde y quede escrito: el registro de acceso (Ley 1581 art. 17)
 * anota cada página con su usuario, su hora y sus filtros, y 3 000 filas por minuto son un rastro
 * imposible de confundir con una pantalla que pagina a mano. Bajar el tope de página de 200 a 50
 * dividió ese techo por cuatro sin quitarle nada al uso real (una tabla no muestra 200 filas).
 */
const registrosLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-comparendos-registros'),
  message: { error: 'Demasiadas consultas de comparendos seguidas, espere 1 minuto' },
  store: makeStore('rl:flito-comparendos-registros:'),
});

const idSchema = z.string().uuid();

/**
 * Identificador de la ruta. Un id que ni siquiera es un UUID no llega a la base: `uuid` es un tipo
 * en PostgreSQL y la comparación reventaría con un 22P02 (un 500) en lugar de decir qué pasa.
 */
function leerId(req: Request, res: Response): string | null {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) { res.status(400).json({ error: 'Identificador inválido' }); return null; }
  return parsed.data;
}

// ─────────────────────────────── NITs monitoreados (CF-01) ──────────────────────────────────────

/**
 * El NIT se normaliza ANTES de medirlo (puntos y espacios fuera, ver `normalizarNit`), y por eso es
 * un `transform` encadenado a un `pipe` y no un simple `min/max`: «900.123.456» son 12 caracteres
 * escritos y 9 de NIT, y rechazarlo por longitud sería rechazarlo por la puntuación.
 */
const nitSchema = z.string()
  .transform(normalizarNit)
  .pipe(z.string()
    .min(5, 'El NIT debe tener entre 5 y 20 caracteres')
    .max(20, 'El NIT debe tener entre 5 y 20 caracteres')
    // Solo dígitos, con guion opcional para el DV. Restringir el alfabeto es lo que impide que un
    // valor con `&`, `=` o `#` acabe interpolado en la URL saliente a Verifik/UTS: lo que se guarda
    // aquí viaja literal a los proveedores en la HU #11500, así que la puerta se cierra en el
    // catálogo, que es donde entra el dato. NO prejuzga si el DV se envía o no — eso lo cierra el
    // spike #11501.
    .regex(/^\d+(-\d)?$/, 'El NIT admite solo dígitos, con guion opcional para el dígito de verificación'));

const crearNitSchema = z.object({
  nit: nitSchema,
  // Sin caracteres de control: el alias se concatena literal al `detail` de la bitácora, y un `\n`
  // parte visualmente una entrada de auditoría en dos para quien la lea.
  alias: z.string().max(120).regex(/^[^\r\n\t]*$/, 'El alias no admite saltos de línea ni tabulaciones').nullable().optional(),
  activo: z.boolean().optional(),
});

// Sin `nit`: no se edita (RN-02). Un cuerpo vacío es un 400 y no un no-op silencioso — quien lo
// manda cree que cambió algo, y responderle 200 lo confirmaría en falso.
const actualizarNitSchema = z.object({
  alias: z.string().max(120).nullable().optional(),
  activo: z.boolean().optional(),
}).refine((d) => d.alias !== undefined || d.activo !== undefined, { message: 'Nada que actualizar' });

router.get('/nits', async (_req: Request, res: Response) => {
  res.json(await listarNits());
});

router.post('/nits', altaNitLimiter, async (req: Request, res: Response) => {
  const parsed = crearNitSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }
  try {
    const creado = await crearNit(parsed.data, req.user?.sub ?? null);
    // El NIT va completo en la bitácora. `audit_logs` no es un log de aplicación sino el registro de
    // quién tocó la parametrización, y el NIT ES la identidad del recurso: sin él, un alta y una
    // baja del catálogo serían dos líneas indistinguibles. Lo que no se hace en ningún caso es
    // sacarlo por `pino` — este módulo no escribe NITs en el log de la aplicación.
    await audit(req, {
      action: 'create', resource: 'flito_comparendos_nit', resourceId: creado.id,
      detail: `NIT monitoreado ${creado.nit}${creado.alias ? ` (${creado.alias})` : ''}`,
    });
    res.status(201).json(creado);
  } catch (e) { fallo(res, e); }
});

router.patch('/nits/:id', async (req: Request, res: Response) => {
  const id = leerId(req, res);
  if (id === null) return;
  const parsed = actualizarNitSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }
  try {
    const actualizado = await actualizarNit(id, parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_comparendos_nit', resourceId: id,
      detail: `NIT ${actualizado.nit}: activo=${actualizado.activo}, alias=${actualizado.alias ?? '—'}`,
    });
    res.json(actualizado);
  } catch (e) { fallo(res, e); }
});

/**
 * Baja DURA, y solo mientras el NIT no haya traído nada (RN-05).
 *
 * La baja normal es `PATCH { activo: false }`: conserva el histórico y se puede deshacer. Esta
 * existe para el caso de un NIT mal escrito que nunca llegó a sincronizarse, donde desactivarlo
 * dejaría basura para siempre en una pantalla de parametrización.
 */
router.delete('/nits/:id', async (req: Request, res: Response) => {
  const id = leerId(req, res);
  if (id === null) return;
  try {
    const eliminado = await eliminarNit(id);
    await audit(req, {
      action: 'delete', resource: 'flito_comparendos_nit', resourceId: id,
      detail: `NIT ${eliminado.nit} eliminado del catálogo de monitoreo (sin comparendos registrados)`,
    });
    res.status(204).end();
  } catch (e) { fallo(res, e); }
});

// ─────────────────────────────── Municipios fuente (CF-02) ──────────────────────────────────────

/** Igual que el NIT: se normaliza y luego se mide, porque el valor guardado es el normalizado. */
const codigoFuenteSchema = z.string()
  .transform(normalizarCodigoFuente)
  .pipe(z.string()
    .min(2, 'El código de fuente no puede estar vacío')
    .max(40, 'El código de fuente admite hasta 40 caracteres')
    // Mismo motivo que en el NIT, y aquí más directo: este valor es literalmente el `?fuente=` de la
    // llamada a UTS (RN-03). Un `BELLO&token=` guardado hoy sería inyección de parámetros el día que
    // la HU #11499 construya la URL. Se permite el espacio porque hay municipios de varias palabras
    // («SANTA FE DE ANTIOQUIA»); lo que se veta son los metacaracteres de URL.
    .regex(/^[A-Z0-9 _-]+$/, 'El código de fuente admite letras, dígitos, espacio, guion y guion bajo'));

const crearMunicipioSchema = z.object({
  codigoFuente: codigoFuenteSchema,
  nombre: z.string().trim().min(1, 'El nombre no puede estar vacío').max(80).optional(),
  activo: z.boolean().optional(),
});

// Sin `codigoFuente`: es el valor que viaja a UTS y no se edita (RN-03).
const actualizarMunicipioSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre no puede estar vacío').max(80).optional(),
  activo: z.boolean().optional(),
}).refine((d) => d.nombre !== undefined || d.activo !== undefined, { message: 'Nada que actualizar' });

router.get('/municipios', async (_req: Request, res: Response) => {
  res.json(await listarMunicipios());
});

router.post('/municipios', async (req: Request, res: Response) => {
  const parsed = crearMunicipioSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }
  try {
    const creado = await crearMunicipio(parsed.data);
    await audit(req, {
      action: 'create', resource: 'flito_comparendos_municipio', resourceId: creado.id,
      detail: `Municipio fuente ${creado.codigoFuente} (${creado.nombre})`,
    });
    res.status(201).json(creado);
  } catch (e) { fallo(res, e); }
});

router.patch('/municipios/:id', async (req: Request, res: Response) => {
  const id = leerId(req, res);
  if (id === null) return;
  const parsed = actualizarMunicipioSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }
  try {
    const actualizado = await actualizarMunicipio(id, parsed.data);
    await audit(req, {
      action: 'update', resource: 'flito_comparendos_municipio', resourceId: id,
      detail: `Municipio ${actualizado.codigoFuente}: activo=${actualizado.activo}, nombre=${actualizado.nombre}`,
    });
    res.json(actualizado);
  } catch (e) { fallo(res, e); }
});

// ─────────────────────────────── Causales de gestión (CF-04) ────────────────────────────────────

// `orden` es SMALLINT en la base: el tope no es un capricho, es el del tipo. Sin él, un 40000 sería
// un 500 desde PostgreSQL en vez de un 400 explicando qué se admite.
const ORDEN_MAXIMO = 32767;

const crearCausalSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre no puede estar vacío').max(120),
  activo: z.boolean().optional(),
  orden: z.number().int().min(0).max(ORDEN_MAXIMO).optional(),
});

const actualizarCausalSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre no puede estar vacío').max(120).optional(),
  activo: z.boolean().optional(),
  orden: z.number().int().min(0).max(ORDEN_MAXIMO).optional(),
}).refine(
  (d) => d.nombre !== undefined || d.activo !== undefined || d.orden !== undefined,
  { message: 'Nada que actualizar' },
);

router.get('/causales', async (_req: Request, res: Response) => {
  res.json(await listarCausales());
});

router.post('/causales', async (req: Request, res: Response) => {
  const parsed = crearCausalSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }
  try {
    const creada = await crearCausal(parsed.data);
    await audit(req, {
      action: 'create', resource: 'flito_comparendos_causal', resourceId: creada.id,
      detail: `Causal de gestión "${creada.nombre}" (orden ${creada.orden})`,
    });
    res.status(201).json(creada);
  } catch (e) { fallo(res, e); }
});

router.patch('/causales/:id', async (req: Request, res: Response) => {
  const id = leerId(req, res);
  if (id === null) return;
  const parsed = actualizarCausalSchema.safeParse(req.body);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }
  try {
    const actualizada = await actualizarCausal(id, parsed.data);
    await audit(req, {
      action: 'update', resource: 'flito_comparendos_causal', resourceId: id,
      detail: `Causal "${actualizada.nombre}": activa=${actualizada.activo}, orden=${actualizada.orden}`,
    });
    res.json(actualizada);
  } catch (e) { fallo(res, e); }
});

// ─────────────────────────────── Token SIMIT (CF-03) ────────────────────────────────────────────

/**
 * El token entra por aquí UNA vez y no vuelve a salir (ADR-0002).
 *
 * `max(2048)` no es un número redondo cualquiera: los JWT de Verifik rondan el kilobyte y 2 KB deja
 * margen sin admitir un cuerpo que solo puede ser un intento de llenar la tabla. `min(1)` porque
 * una cadena vacía cifra igual de bien que un token y dejaría la integración rota con un
 * `configurado: true` mintiendo en la pantalla.
 *
 * Sin `.trim()` deliberadamente: recortar un secreto es adivinar. Si el proveedor emitiera un token
 * con espacios significativos, un trim silencioso lo rompería y el fallo aparecería mucho después,
 * en un 401 del proveedor que nadie ataría a este endpoint.
 */
const tokenSimitSchema = z.object({
  token: z.string().min(1, 'El token no puede estar vacío').max(2048, 'El token admite hasta 2048 caracteres'),
});

/**
 * `GET` — metadatos y nada más: `configurado`, cuándo, quién y bajo qué versión de llave.
 *
 * No hay ninguna variante de esta ruta que devuelva el token, ni enmascarado ni por un prefijo. No
 * lleva limitador: es una lectura sin secreto y la pantalla de configuración la pide en cada carga.
 */
router.get('/config/token-simit', async (_req: Request, res: Response) => {
  res.json(await obtenerMetaTokenSimit());
});

/**
 * `PUT` — cifra y rota. Responde exactamente lo mismo que el `GET`, nunca un eco del token.
 *
 * Es `PUT` y no `POST` porque el recurso es uno solo y la operación es idempotente en su efecto
 * observable: mandar dos veces el mismo token deja la misma configuración (con dos filas de
 * historial, que es el rastro que CF-03 quiere).
 */
router.put('/config/token-simit', tokenLimiter, async (req: Request, res: Response) => {
  const parsed = tokenSimitSchema.safeParse(req.body);
  // `flatten()` devuelve los MENSAJES de las reglas, nunca el valor que se validó: un token
  // demasiado largo no vuelve al cliente dentro del detalle del error.
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  try {
    const { id, meta } = await guardarTokenSimit(parsed.data.token, req.user?.sub ?? null);
    // Ni el token ni un fragmento suyo en el detalle: un prefijo sigue siendo material de la
    // credencial, y `audit_logs` se consulta y se exporta. Lo que queda escrito es QUÉ cambió y
    // bajo qué llave — quién y cuándo los pone el propio middleware.
    await audit(req, {
      action: 'update',
      resource: 'flito_comparendos_token',
      resourceId: String(id),
      detail: `Token SIMIT actualizado (keyVersion=${meta.keyVersion})`,
    });
    res.json(meta);
  } catch (e) { fallo(res, e); }
});

// ─────────────────────────────── Sincronización (CF-05, CF-06) ──────────────────────────────────

/**
 * Cuerpo de `POST /sync`. Todo opcional: sin `nits` se sincronizan todos los activos (AC1).
 *
 * `nits` reutiliza el MISMO `nitSchema` del alta del catálogo, y no una versión relajada: el valor
 * viaja literal a los proveedores, así que el alfabeto se cierra también aquí. Que un NIT esté bien
 * escrito no significa que se monitoree — de eso se ocupa el servicio, que responde 400
 * `nits_filtro_invalido` nombrando los que no están activos.
 *
 * El tope de 200 no es el tamaño del catálogo: es lo que impide que un cuerpo con diez mil NITs
 * obligue a normalizarlos y consultarlos antes de poder rechazarlos.
 */
const syncSchema = z.object({
  nits: z.array(nitSchema).max(200, 'Como máximo 200 NITs por corrida').optional(),
// `.strict()` y no el laissez-faire de Zod por defecto: `{ "nit": "900123456" }` —singular, el error
// de dedo más fácil de cometer— pasaría como cuerpo vacío y dispararía un sync GLOBAL cuando quien
// lo mandó pedía UN NIT. Con el catálogo entero detrás, esa confusión se paga en cuota del proveedor
// y en minutos de espera. Mejor un 400 que diga que la clave no existe.
}).strict();

/**
 * Dispara la sincronización y responde con el resultado completo (AC1).
 *
 * Síncrono a propósito (ADR-0001 §7): no hay 202 ni polling en 17a. Lo que evita el corte del nginx
 * (~120 s) es el pool de llamadas municipales del servicio, no devolver antes de tiempo.
 *
 * Los estados de error los traduce `fallo` desde el código del error de dominio: 409
 * `sync_en_curso`, 400 sin NITs o con filtro inválido, 503 `token_no_configurado` /
 * `modo_simulado_en_produccion` / `mapa_homologacion_vacio`. Aquí no se decide ninguno.
 */
router.post('/sync', syncLimiter, async (req: Request, res: Response) => {
  // `req.body` puede no existir si el cliente no manda cuerpo ni `Content-Type`: un sync global se
  // pide con un POST pelado y eso tiene que funcionar.
  const parsed = syncSchema.safeParse(req.body ?? {});
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  try {
    const resultado = await ejecutarSync({
      nits: parsed.data.nits,
      actorId: req.user?.sub ?? null,
    });

    // La bitácora guarda el ALCANCE y los contadores, no la lista de NITs: en una corrida global son
    // todo el catálogo y no aportan nada que no esté ya en `sync_runs.scope_nits`, que es donde vive
    // el detalle. `resourceId` es el id de la corrida, así que desde la auditoría se llega a él.
    await audit(req, {
      action: 'update',
      resource: 'flito_comparendos_sync',
      resourceId: resultado.runId,
      detail: `Sync ${resultado.estado} (${resultado.resumen?.modo ?? '—'}) sobre ${resultado.scopeNits.length} NIT(s): `
        + `${resultado.resumen?.upserts ?? 0} registros, ${resultado.resumen?.primeraLlegada ?? 0} nuevos, `
        + `${resultado.resumen?.inactivados ?? 0} inactivados, ${resultado.resumen?.reactivados ?? 0} reaparecidos`,
    });

    res.json(resultado);
  } catch (e) { fallo(res, e); }
});

/** Últimas corridas. `limit` acotado: sin tope, un `?limit=999999` sería un volcado de la tabla. */
const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Las dos lecturas de corridas dejan registro de acceso (HU #11511, Ley 1581 art. 17).
 *
 * No es celo de más: `scope_nits` es la lista de NITs monitoreados y cada paso lleva el suyo, y un
 * NIT de persona natural es un documento de identidad —lo dice el COMMENT de la 0150—. Es la única
 * lectura de datos personales que este módulo expone hoy; `GET /registros` (HU #11502) usará el
 * mismo `registrarAccesoComparendos` con `RECURSO_REGISTROS`.
 */
router.get('/sync/runs', async (req: Request, res: Response) => {
  const parsed = runsQuerySchema.safeParse(req.query);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }
  const runs = await listarSyncRuns(parsed.data.limit);
  await registrarAccesoComparendos(req, {
    recurso: RECURSO_SYNC_RUN,
    accion: 'search',
    campos: [...CAMPOS_PII_SYNC_RUN],
    filas: runs.length,
  });
  res.json(runs);
});

/** Detalle de una corrida con sus `steps[]`: qué fuente falló, con qué código y cuánto tardó (AC4). */
router.get('/sync/runs/:id', async (req: Request, res: Response) => {
  const id = leerId(req, res);
  if (id === null) return;
  try {
    const run = await obtenerSyncRun(id);
    // Después de leer y solo si se leyó: un 404 no es un acceso a datos de nadie, y registrarlo
    // llenaría el log de accesos que no ocurrieron.
    await registrarAccesoComparendos(req, {
      recurso: RECURSO_SYNC_RUN,
      accion: 'read',
      campos: [...CAMPOS_PII_SYNC_RUN],
      filas: run.steps?.length ?? 0,
      referencia: run.runId,
    });
    res.json(run);
  } catch (e) { fallo(res, e); }
});

// ─────────────────────────────── Registros consolidados (CF-09, CF-11) ──────────────────────────
//
// Las cuatro rutas son de SOLO LECTURA y no hay ninguna que escriba un campo de fuente: el CF-09
// pide exactamente eso (RN-04). `POST /registros/buscar` es un POST por dónde viajan sus filtros,
// no por lo que hace: responde 200, no crea nada y no tiene efectos secundarios más allá del
// registro de acceso que deja cualquier lectura de este módulo.
//
// El PATCH de gestión —lo único editable, `causalId` y `observacion`— es de 17b y aquí no existe ni
// como stub: una ruta que acepta un cuerpo y no hace nada es peor que no tenerla.

/**
 * Un filtro que llega vacío es un filtro sin poner, no un filtro que no valida.
 *
 * Vale para los dos bordes y por eso contempla los dos vacíos: `?nit=` en la query (cadena vacía) y
 * `{ "nit": null }` en el cuerpo, que es como un formulario serializa un campo que el usuario
 * borró. Rechazar cualquiera de los dos convertiría «quité el filtro» en un 400.
 */
const vacioEsAusente = <T extends z.ZodTypeAny>(esquema: T) =>
  z.preprocess(
    (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    esquema.optional(),
  );

/**
 * La placa se valida con el alfabeto de lo que un humano escribe («ABC-123», «abc 123») y la
 * normaliza el servicio con el MISMO normalizador con el que se guardó (RN-33). El mínimo de 3 no
 * es cosmético: `placa=A` sería un barrido del parque entero disfrazado de filtro.
 */
const placaFiltroSchema = z.string().trim()
  .min(3, 'La placa debe tener al menos 3 caracteres')
  .max(12)
  .regex(/^[A-Za-z0-9 -]+$/, 'La placa admite letras, dígitos, espacio y guion');

/**
 * Query de lista, compartida por `GET /registros` y `POST /registros/buscar`.
 *
 * Solo lleva lo que NO identifica a una persona: el estado de monitoreo, un fragmento del número de
 * comparendo —un consecutivo del Estado— y la paginación. Es la mitad del contrato que sí puede
 * acabar en un access log sin que eso sea una fuga (AGENTS.md §14).
 *
 * `.strict()` por lo mismo que en `POST /sync`, y aquí pesa más: `?estados=activo` —el error de
 * dedo— se ignoraría en silencio y devolvería un listado más ancho del que se pidió. Es además lo
 * que hace que `GET /registros?nit=900123456` sea un **400** y no una consulta que funciona: el
 * filtro de identidad ya no vive en la query, y quien lo intente tiene que enterarse.
 *
 * `limit` se preprocesa igual que los demás en vez de dejarlo en un `z.coerce` pelado: sin eso,
 * `?limit=` (vacío) era el único parámetro que devolvía 400 mientras `?nit=`, `?q=` o `?estado=`
 * vacíos se tomaban como ausentes. Dos reglas distintas para el mismo gesto —mandar el parámetro
 * sin valor— es justo el tipo de asimetría que un cliente descubre en producción.
 */
const registrosQuerySchema = z.object({
  estado: vacioEsAusente(z.enum(['activo', 'inactivo'])),
  // Mínimo 3 caracteres: `q=1` recorrería la tabla para devolver medio módulo.
  q: vacioEsAusente(z.string().trim().min(3, 'Busca por al menos 3 caracteres del número').max(60)),
  limit: z.preprocess(
    (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    z.coerce.number().int().min(1).max(COMPARENDOS_REGISTROS_LIMIT_MAX)
      .default(COMPARENDOS_REGISTROS_LIMIT_MAX),
  ),
  cursor: vacioEsAusente(z.string().max(200)),
}).strict();

/**
 * Cuerpo de `POST /registros/buscar`: los dos filtros que identifican a alguien.
 *
 * `nit` reutiliza el MISMO esquema del catálogo —se normaliza antes de medirlo y el alfabeto queda
 * cerrado—, así que un valor con `&` o `=` se rechaza aquí igual que en el alta.
 *
 * `.strict()` con más motivo que en la query: `{ "nits": "900123456" }` se ignoraría en silencio y
 * devolvería los comparendos de TODAS las empresas a quien pidió los de una. En un listado de datos
 * personales, un filtro mal escrito tiene que ser un 400.
 */
const registrosBusquedaSchema = z.object({
  nit: vacioEsAusente(nitSchema),
  placa: vacioEsAusente(placaFiltroSchema),
}).strict();

/**
 * Consulta, rastro y respuesta de una página. Lo comparten las dos rutas de listado.
 *
 * Deja registro de acceso ANTES de responder (Ley 1581 art. 17): esta es la lectura masiva del
 * módulo y es justo la que hay que poder reconstruir cuando un titular pregunte quién consultó sus
 * datos. Los filtros van al motivo enmascarados; de eso se ocupa `registrarAccesoComparendos`, no
 * esta función.
 *
 * @throws lo que lance el servicio (cursor inválido); lo traduce el `catch` de cada ruta.
 */
async function entregarPagina(req: Request, res: Response, filtro: FiltroRegistros): Promise<void> {
  const pagina = await listarRegistros(filtro);
  await registrarAccesoComparendos(req, {
    recurso: RECURSO_REGISTROS,
    accion: 'search',
    campos: [...CAMPOS_PII_REGISTRO],
    filas: pagina.items.length,
    filtros: {
      estado: filtro.estado,
      nit: filtro.nit,
      placa: filtro.placa,
      q: filtro.q,
    },
  });
  res.set('Cache-Control', 'no-store');
  res.json(pagina);
}

/**
 * Listado sin filtros de identidad (AC1). **Sigue siendo un GET, y a propósito.**
 *
 * Es la vista por defecto de la pantalla: «los comparendos, los últimos primero». Lo que el §14
 * prohíbe es que la URL cargue con la identidad de alguien, y esta no la lleva —estado, número y
 * cursor no identifican a nadie—, así que convertirla en POST no quitaría ni un dato personal de
 * ningún log y sí perdería lo que un GET da gratis: es idempotente y seguro por definición, se
 * puede reintentar, y cualquiera que lea el router ve de un vistazo qué rutas leen y cuál busca.
 * La búsqueda por NIT o placa es la otra ruta, y no hay forma de hacerla desde aquí: `.strict()`
 * convierte `?nit=` en un 400.
 */
router.get('/registros', registrosLimiter, async (req: Request, res: Response) => {
  const parsed = registrosQuerySchema.safeParse(req.query);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  try {
    await entregarPagina(req, res, parsed.data);
  } catch (e) { fallo(res, e); }
});

/**
 * Búsqueda con filtros de identidad (AC1, AGENTS.md §14).
 *
 * El NIT y la placa van en el cuerpo porque una URL es el peor sitio donde dejar un dato personal:
 * la escribe entera el access log del proxy, la guarda el historial del navegador y viaja en el
 * `Referer` de la petición siguiente — tres registros que no están bajo la retención de 24 meses
 * del módulo ni bajo el `pii_access_log` que la Ley 1581 exige. La paginación y los filtros que no
 * identifican a nadie siguen en la query, compartiendo esquema con el `GET`: que la búsqueda lleve
 * un NIT no cambia cómo se pagina.
 *
 * Responde **200**, no 201: no crea nada. El único efecto de esta ruta fuera de la respuesta es la
 * fila del registro de acceso, que es la misma que deja el `GET`.
 */
router.post('/registros/buscar', registrosLimiter, async (req: Request, res: Response) => {
  const query = registrosQuerySchema.safeParse(req.query);
  if (!query.success) { datosInvalidos(res, query.error); return; }
  // Sin cuerpo es una búsqueda sin filtros de identidad, no un error: `req.body` puede ni existir
  // si el cliente no manda `Content-Type`.
  const cuerpo = registrosBusquedaSchema.safeParse(req.body ?? {});
  if (!cuerpo.success) { datosInvalidos(res, cuerpo.error); return; }

  try {
    await entregarPagina(req, res, { ...query.data, ...cuerpo.data });
  } catch (e) { fallo(res, e); }
});

/**
 * Un comparendo con su timeline (AC1). El 404 lo decide el error de dominio, no esta ruta.
 *
 * Sigue siendo `GET` con el id en el path: el §14 admite explícitamente los identificadores OPACOS
 * —un UUID no dice nada de nadie— y es lo que separa este caso del filtro por NIT.
 */
router.get('/registros/:id', registrosLimiter, async (req: Request, res: Response) => {
  const id = leerId(req, res);
  if (id === null) return;
  try {
    const registro = await obtenerRegistro(id);
    // Después de leer y solo si se leyó, igual que en `/sync/runs/:id`: un 404 no es un acceso a
    // los datos de nadie.
    await registrarAccesoComparendos(req, {
      recurso: RECURSO_REGISTROS,
      accion: 'read',
      campos: [...CAMPOS_PII_REGISTRO],
      filas: 1,
      referencia: registro.id,
    });
    res.set('Cache-Control', 'no-store');
    res.json(registro);
  } catch (e) { fallo(res, e); }
});

/**
 * Timeline suelto (CF-11).
 *
 * **No deja registro de acceso ni sale con `no-store`, y es una decisión, no un olvido:** un evento
 * son `tipo`, la corrida que lo produjo y un `detalle` que por RN-20 no lleva NIT, placa ni nada del
 * proveedor —y desde RN-35 el API lo proyecta por lista blanca, así que tampoco puede llevarlo por
 * accidente—. No hay ningún dato personal en la respuesta: anotar en `pii_access_log` lecturas que
 * no exponen datos personales lo llena de ruido justo hasta el punto en que deja de poder
 * consultarse, y prohibir la caché de algo que no es personal es ceremonia sin efecto.
 *
 * Las dos decisiones cuelgan del mismo hecho, así que se revisan juntas: si 17b enriquece `detalle`
 * con algo del registro (la placa en el evento, por ejemplo), esta ruta pasa a necesitar
 * `registrarAccesoComparendos` con `RECURSO_REGISTROS` **y** la cabecera.
 */
router.get('/registros/:id/eventos', registrosLimiter, async (req: Request, res: Response) => {
  const id = leerId(req, res);
  if (id === null) return;
  try {
    res.json(await listarEventos(id));
  } catch (e) { fallo(res, e); }
});

export default router;
