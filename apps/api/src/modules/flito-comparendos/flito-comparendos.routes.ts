// FLITO comparendos — frontera HTTP de los catálogos (Feature #11492 17a, HU #11497), del token
// SIMIT (HU #11498), de la sincronización (HU #11500) y de la lectura del consolidado (HU #11502),
// que la HU #11555 (Feature #11495 17b) amplía con los filtros de listado por municipio, fuente y
// causal, y la HU #11557 con el PATCH de gestión — la única escritura sobre un comparendo.
//
// Base: `/api/flito/comparendos`. Aquí solo se valida, se traduce y se deja rastro; las reglas de
// negocio y todo el acceso a datos viven en `flito-comparendos.service.ts` (RN-01..RN-06), en
// `flito-comparendos.token.service.ts` (RN-07..RN-10), en `flito-comparendos.sync.service.ts`
// (RN-15..RN-24), en `flito-comparendos.registros.service.ts` (RN-31..RN-36) y en
// `flito-comparendos.gestion.service.ts` (RN-37..RN-41), en sus cabeceras.
// Este módulo NO es el gate SIMIT del traspaso ni el pre-vuelo: ver ADR-0001.
//
// El export a Excel del consolidado (HU #11558) es `POST /registros/export`, con su propio limitador
// y su propio tope de filas (ADR-0004).
//
// ── Los dos rastros, y a qué respuestas se aplican ────────────────────────────────────────
//
// Toda respuesta que lleve datos personales **de los titulares que este módulo vigila** —NIT
// monitoreado, alias, placa, observación de gestión— sale con `Cache-Control: no-store`, incluidas
// las tres escrituras que devuelven la fila entera: el PATCH de gestión y las dos de `/nits`
// (Bug #11671).
//
// Y toda respuesta que ENTREGUE datos personales **que el cliente no aportó** deja además rastro con
// `registrarAccesoComparendos` (HU #11511, Ley 1581 art. 17). El criterio no es «rastro para las
// lecturas y no para las escrituras»: `PATCH /registros/:id/gestion` y `PATCH /nits/:id` son
// escrituras y las dos registran, porque a quien manda un UUID le devuelven identidades que no
// tecleó. La única que se queda fuera POR DECISIÓN —y no por hueco de los de abajo— es `POST /nits`,
// y por lo contrario: el 201 le devuelve el NIT y el alias que acaba de escribir él mismo —el razonamiento
// entero está en su docstring—.
//
// ── Los dos huecos conocidos, escritos para que no se lean como criterio ──────────────────────
//
//   · `POST /sync`: su respuesta lleva NITs que el cliente no mandó y hoy no deja rastro ni sale con
//     `no-store`. No se cierra por omisión sino por decisión de negocio pendiente (punto 1 del Bug
//     #11671, anotado en el docstring de `GET /nits`).
//   · `GET /config/token-simit`: devuelve `actualizadoPor: { id, nombre }`, y el nombre de una
//     persona natural es dato personal por el art. 3 de la Ley 1581 aunque sea un empleado y no un
//     titular de los que este módulo vigila. Sale sin `no-store` y sin registro de acceso. Queda
//     fuera del alcance del Bug #11671 y se nombra aquí para que la regla de arriba no se lea como
//     si ya cubriera el archivo entero.
//
// **Los filtros de identidad no viajan en la URL** (AGENTS.md §14): buscar por NIT o por placa es
// `POST /registros/buscar` con esos dos valores en el CUERPO. La query solo lleva lo que no
// identifica a nadie —estado, número de comparendo, paginación— y el `:id` del path es un UUID
// opaco, que la norma admite explícitamente.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  COMPARENDOS_OBSERVACION_MAX,
  COMPARENDOS_REGISTROS_LIMIT_MAX,
} from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import { sendExcel } from '../../shared/utils/excel.js';
import {
  ComparendosError,
  ComparendosExportDemasiadoGrandeError,
} from './flito-comparendos.errors.js';
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
import { gestionarComparendo } from './flito-comparendos.gestion.service.js';
import {
  COLUMNAS_EXPORT,
  construirFilasExport,
  nombreArchivoExport,
} from './flito-comparendos.export.service.js';
import {
  CAMPOS_PII_NIT,
  CAMPOS_PII_OBSERVACION,
  CAMPOS_PII_REGISTRO,
  CAMPOS_PII_SYNC_RUN,
  RECURSO_NIT,
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
 *
 * **Ese 3 000 es el techo de ESTA ruta, no el del módulo — y desde la HU #11558 la diferencia
 * importa.** El export a Excel entrega hasta `COMPARENDOS_EXPORT_MAX_FILAS` filas por petición con
 * su propia cuota (`exportLimiter`, 5/min), así que el techo del módulo es la SUMA de los dos y hoy
 * lo domina el export (5 × 2 000 = 10 000 filas por minuto; eran 25 000 hasta que la HU #11651 bajó
 * el tope de 5 000 a 2 000 por memoria del proceso). Dejar escrito aquí «el techo del módulo» sería
 * afirmar un número que dejó de ser cierto. Las dos cotas y por qué se aceptan juntas
 * están en `docs/adr/ADR-0004-flito-comparendos-export-excel-tope.md`, que **complementa** a
 * ADR-0001: no lo enmienda ni lo supersede.
 *
 * **Desde el Bug #11646 los sumandos son tres**, y hasta él este párrafo declaraba un techo falso:
 * el catálogo de NITs y las corridas de sync también devuelven NITs y no tenían cuota ninguna, así
 * que el «techo del módulo» dejaba fuera precisamente las rutas sin límite. El tercer sumando es
 * `lecturasPiiLimiter`, y no mueve el orden de magnitud porque lo que entrega está acotado por el
 * tamaño del catálogo y por el `limit` sin offset de las corridas —el razonamiento entero está en su
 * docstring—: el export lo sigue dominando. Y sigue habiendo una respuesta con NITs fuera de esta
 * cuenta, `POST /sync`; está anotada en el docstring de `GET /nits`.
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

/**
 * Export a Excel: **5 peticiones por minuto y usuario** (HU #11558, ADR-0004 §3).
 *
 * El más estrecho de los limitadores de lectura, y con doce veces menos cuota que el del listado
 * porque cada petición vale cuarenta veces más: una página son 50 filas, un export hasta 2 000. Con
 * estos dos números, 5/min es el multiplicador que deja el techo del export (10 000 filas/minuto) en
 * el mismo orden de magnitud que el de la lectura paginada (3 000) en vez de dos órdenes por encima,
 * que es lo que saldría con la cuota de 60.
 *
 * **Esta cuota es por USUARIO y no hay ninguna global — la HU #11651 lo dejó medido, no supuesto.**
 * Dos administradores distintos lanzan dos exports a la vez y el limitador deja pasar a los dos, así
 * que el consumo de memoria que hay que presupuestar no es el de un export sino el de varios
 * coexistiendo en el heap del mismo proceso. Esa es la razón de que `COMPARENDOS_EXPORT_MAX_FILAS`
 * valga hoy 2 000 y no 5 000; con 5 000, dos exports simultáneos dejaban el proceso a 15 MB del
 * `max_memory_restart` de PM2. Serializar la generación (semáforo en proceso) o escribir el `.xlsx`
 * incremental con `WorkbookWriter` son las dos salidas que quitarían esa dependencia entre el tope y
 * la concurrencia; las dos quedaron fuera del alcance de la #11651 y son decisión del Líder Técnico.
 *
 * **Es una cuota SEPARADA de la de `/registros`, y a propósito** (AC5): con una compartida, gastar
 * los 5 exports dejaría a la pantalla sin poder paginar —el usuario vería la tabla romperse por
 * haber descargado— y, al revés, un visor abierto que pagina normalmente le comería la cuota al
 * export sin que nada lo explicara. Dos gestos distintos, dos presupuestos.
 *
 * **Un 422 consume cuota igual que un 200, y no es un descuido**: `express-rate-limit` cuenta la
 * petición al entrar, antes del handler. Si el export demasiado grande saliera gratis, sondear el
 * tamaño de un filtro —«¿cuántos comparendos tiene este NIT?»— sería ilimitado, que es justo la
 * pregunta que el 422 evita responder.
 *
 * Lo que este límite NO hace: acotar cuánto se lleva alguien AL DÍA. 5/min son 7 200 exports en 24
 * horas; lo que hay contra eso no es esta ventana sino el rastro (`accion='export'` con su `filas`),
 * y el tope diario quedó explícitamente sin resolver en ADR-0004 — es decisión de producto, no un
 * olvido de esta ruta.
 */
const exportLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-comparendos-export'),
  message: { error: 'Demasiados exports seguidos, espere 1 minuto' },
  store: makeStore('rl:flito-comparendos-export:'),
});

/**
 * Las OTRAS lecturas con datos personales —el catálogo de NITs y las corridas de sync—: 60 por
 * minuto y usuario (Bug #11646).
 *
 * Existe porque el criterio del módulo no había llegado a estas tres rutas: devolvían NIT con el
 * único freno del `apiLimiter` general (500/15 min y por IP, compartido con toda la API), que no es
 * una cuota de este dato ni cuenta por usuario.
 *
 * **Bolsa propia y no la de `/registros`**, por el mismo motivo por el que el export tiene la suya
 * (AC5 de la HU #11558): son gestos de pantallas distintas —la parametrización y la consola de
 * sync—, y con una cuota compartida cargar la lista de NITs le comería el presupuesto a quien está
 * paginando la tabla; el usuario vería romperse una pantalla por lo que hizo en otra.
 *
 * **60/min, el mismo número que el listado, pero acotando otra cosa.** Estas dos lecturas devuelven
 * un conjunto de identidades acotado, y NO porque `scope_nits` sea un reflejo del catálogo: no lo
 * es. `eliminarNit` borra en duro y las corridas conservan su alcance histórico, así que
 * `/sync/runs` puede entregar NITs que ya no están en el catálogo — es un conjunto propio, no un
 * subconjunto. Lo que lo acota son dos cotas reales: `runsQuerySchema` topa el `limit` en 100 y
 * **no admite offset**, de modo que no hay manera de caminar el histórico hacia atrás, y lo que
 * quedaría más allá de la retención ya lo ha borrado la purga (RN-26, migración 0152). El catálogo,
 * por su parte, se entrega entero en la primera petición.
 *
 * Con esas dos cotas puestas, lo que compra la cuota no es un tope de filas sino ritmo y ruido: cada
 * petición deja su fila de acceso, y un bucle contra estas rutas es un patrón visible en
 * `pii_access_log` en vez de tráfico indistinguible del normal.
 *
 * Una sola bolsa para las tres y no una por ruta: ninguna es de alta frecuencia, y trocearlas más
 * multiplicaría los sumandos del techo del módulo sin proteger un dato más. Cualquier lectura nueva
 * del módulo que devuelva datos personales y no sea el consolidado va aquí.
 */
const lecturasPiiLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-comparendos-lecturas-pii'),
  message: { error: 'Demasiadas consultas seguidas, espere 1 minuto' },
  store: makeStore('rl:flito-comparendos-lecturas-pii:'),
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

/**
 * El alias del NIT, **un solo campo para el alta y para la edición** (Bug #11671).
 *
 * Veta el salto de línea, el retorno de carro y la tabulación: el alias se concatena literal al
 * `detail` de la bitácora —`audit()` lo inserta tal cual, no lo escapa— y un `\n` parte visualmente
 * una entrada de auditoría en dos para quien la lea. El `textoOpcional` del servicio hace `trim()`,
 * así que un salto al principio o al final se cae solo; el que sobrevive hasta `audit_logs.detail`
 * es el de EN MEDIO, que es justamente el que sirve para fabricar una línea falsa debajo de una
 * verdadera.
 *
 * **No dice «sin caracteres de control», porque no lo es** y decirlo sería la misma clase de
 * afirmación falsa junto al código que este Bug vino a quitar: `\v`, `\f`, `U+2028` y `U+2029`
 * pasan, y los dos últimos pueden partir la línea en un visor que los interprete como separadores.
 * Cerrar eso sería ensanchar la regla y no arreglar lo que hay; queda anotado aquí, no implementado.
 *
 * El byte cero sí se cierra, con el mismo `refine` y por el mismo motivo que
 * `gestionSchema.observacion`: un JSON puede llevarlo (`\u0000`), no cabe en un `varchar` de
 * PostgreSQL y llegaría hasta el driver para salir como un `22021` por el manejador global —un 500—
 * en vez de como el 400 que es. Va en un `refine` y no dentro del `regex` porque un carácter de
 * control dentro de una expresión regular es un aviso de ESLint (`no-control-regex`) que aquí sería
 * ruido: la comprobación es «no lo contiene», que se dice mejor sin regex.
 *
 * **Es compartido porque las dos copias habían divergido**: la regla vivía solo en el alta y
 * `actualizarNitSchema` era un `z.string().max(120)` pelado, de modo que la validación del alta se
 * rodeaba en dos pasos —crear el NIT con un alias limpio y editarlo después con el salto dentro— y
 * el mismo valor acababa igual en la bitácora, solo que por el `detail` del `update`. Un campo y no
 * dos declaraciones equivalentes, porque dos declaraciones equivalentes es exactamente como se
 * separaron la primera vez.
 */
const aliasNitSchema = z.string()
  .max(120)
  .regex(/^[^\r\n\t]*$/, 'El alias no admite saltos de línea ni tabulaciones')
  .refine((v) => !v.includes('\u0000'), 'El alias no admite caracteres nulos')
  .nullable()
  .optional();

const crearNitSchema = z.object({
  nit: nitSchema,
  alias: aliasNitSchema,
  activo: z.boolean().optional(),
});

// Sin `nit`: no se edita (RN-02). Un cuerpo vacío es un 400 y no un no-op silencioso — quien lo
// manda cree que cambió algo, y responderle 200 lo confirmaría en falso.
const actualizarNitSchema = z.object({
  alias: aliasNitSchema,
  activo: z.boolean().optional(),
}).refine((d) => d.alias !== undefined || d.activo !== undefined, { message: 'Nada que actualizar' });

/**
 * El catálogo entero, y por eso es una lectura de datos personales de pleno derecho (Bug #11646).
 *
 * Hasta este arreglo no dejaba rastro, y lo que se perdía no era defensa en profundidad sino la
 * respuesta al art. 17 de la Ley 1581: se podía listar QUIÉNES están monitoreados —el catálogo
 * completo, sin paginar ni filtrar— sin que quedara constancia de quién lo consultó. Las demás
 * LECTURAS del módulo sí lo anotaban.
 *
 * **La cuota que se le añade no protege la confidencialidad, y conviene no confundirse.**
 * `listarNits` no lleva `LIMIT` ni filtro: la petición nº 1 ya entregó el catálogo entero y las 59
 * que quedan de cuota no añaden un solo NIT. Aquí el «ritmo y ruido» de `lecturasPiiLimiter` es
 * literal y **el único control real de esta ruta es el registro de acceso** — de ahí que sea lo que
 * el Bug #11646 vino a poner. Con una salvedad que hay que saber: ese registro es hoy suprimible
 * desde el cliente (Bug #11622 — un `X-Request-Id` que no sea UUID revienta el INSERT con un 22P02
 * que el `catch` best-effort de `logPiiAccess` se traga en silencio), así que mientras aquello siga
 * abierto la constancia que este arreglo promete no está garantizada. No se cierra aquí porque el
 * agujero es del helper compartido, no de esta ruta.
 *
 * **La excepción que queda en el módulo, escrita a propósito: `POST /sync`.** Su respuesta es un
 * `ComparendosSyncResultado` con `scopeNits` y el `nit` de cada paso dentro, y no deja registro de
 * acceso ni sale con `no-store`. Es menos grave —no inocua— por dos motivos, y ninguno es «no es
 * PII»: es un POST, que ningún navegador guarda por heurística de caché, y `audit()` sí anota el
 * actor, el alcance y el `runId`, así que del GESTO queda constancia aunque no del hecho de haber
 * leído esos NITs. Lo que falta por decidir es si la bitácora basta para el art. 17 cuando la
 * lectura es el efecto de una escritura; es otra ruta y otro alcance, y este arreglo se cerró a las
 * tres del Bug #11646.
 *
 * `accion: 'search'` y no `'read'` aunque no haya filtros: `read` es «un recurso concreto» en el
 * vocabulario de `AccesoComparendos`, y esto entrega la lista entera. `filas` es lo que de verdad
 * distingue esta línea del log de una consulta menor, porque aquí no hay ningún otro criterio que
 * anotar: sin filtros ni `:id`, el tamaño ES la lectura.
 */
router.get('/nits', lecturasPiiLimiter, async (req: Request, res: Response) => {
  const nits = await listarNits();
  await registrarAccesoComparendos(req, {
    recurso: RECURSO_NIT,
    accion: 'search',
    campos: [...CAMPOS_PII_NIT],
    filas: nits.length,
  });
  // La lista de a quién se vigila no se queda en el disco del navegador después de cerrar sesión.
  res.set('Cache-Control', 'no-store');
  res.json(nits);
});

/**
 * Alta de un NIT. Devuelve el recurso creado —`nit` y `alias` dentro— y por eso sale con
 * `no-store` desde el Bug #11671.
 *
 * **Solo la cabecera, y no `registrarAccesoComparendos`.** La distinción no es de comodidad: el
 * registro del art. 17 de la Ley 1581 responde a «quién CONSULTÓ mis datos», y aquí el dato no se
 * consulta, ENTRA — los dos campos personales del 201 (`nit` y `alias`) son los que acaba de
 * teclear quien hizo la petición, que ya los tenía delante. Y no hay camino por el que este 201
 * devuelva otra cosa: `crearNit` comprueba el duplicado antes de insertar y responde un 409 en vez
 * de devolver la fila existente, así que el alta nunca revela el alias que otro puso. Del gesto sí
 * queda constancia, y en el registro que le toca: `audit()` anota actor, acción y el NIT completo
 * en `audit_logs`. Meter esta ruta en `pii_access_log` no añadiría un hecho nuevo; llenaría el log
 * de accesos de escrituras y dejaría de poder leerse como «estas son las veces que alguien miró
 * datos ajenos».
 *
 * **El `PATCH` de al lado NO es este caso, y por eso sí registra.** Ahí el cliente manda un UUID
 * opaco y `{alias}` o `{activo}`, y la respuesta le devuelve el `nit` de la fila —que no tecleó y
 * que pudo no haber visto nunca—, más el `alias` guardado si solo cambió `activo`. Es una lectura
 * dentro de una escritura, exactamente lo mismo que `PATCH /registros/:id/gestion`, y las dos se
 * resuelven igual. El criterio del módulo no es «rastro para las lecturas y no para las
 * escrituras», sino rastro para toda respuesta que entregue datos personales que el cliente no
 * aportó; este alta es la única que cae del otro lado.
 *
 * **`POST /sync` cae del mismo lado que el `PATCH` y sigue abierto**: su respuesta lleva NITs que
 * el cliente NO mandó —el catálogo entero cuando la corrida es global—, así que también es una
 * lectura escondida dentro de una escritura. No se cierra aquí porque su punto (el 1 del Bug
 * #11671) está esperando decisión de negocio, no porque el criterio sea distinto.
 */
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
    // El NIT recién dado de alta no se queda en el disco del navegador, igual que no se queda la
    // lista que lo contiene (`GET /nits`).
    res.set('Cache-Control', 'no-store');
    res.status(201).json(creado);
  } catch (e) { fallo(res, e); }
});

/**
 * Edita `alias` y `activo` (RN-02) y devuelve la fila entera, NIT incluido.
 *
 * Deja rastro en los DOS registros, igual que `PATCH /registros/:id/gestion` y por el mismo motivo:
 * `audit()` responde «quién CAMBIÓ qué» y `registrarAccesoComparendos` responde «quién MIRÓ datos
 * personales». Aquí hace falta el segundo porque **la respuesta entrega un NIT que el cliente no
 * aportó**: lo que manda es un UUID opaco y `{alias}` o `{activo}`, y lo que recibe es la fila
 * completa —el `nit`, y también el `alias` guardado cuando solo cambió `activo`—. Que la petición
 * sea una escritura no quita que la respuesta sea una lectura; el alta de al lado no registra
 * justamente porque allí los dos campos personales del cuerpo son los que el cliente acaba de
 * teclear (su docstring lo argumenta).
 *
 * `accion: 'read'` y no un valor de escritura, por lo mismo que en el PATCH de gestión: lo que se
 * anota es que alguien VIO esta fila, y el «quién la cambió» ya lo cuenta `audit()`. `filas: 1` y
 * `referencia: id` porque es un recurso concreto y no un listado.
 *
 * Los dos rastros son best-effort en el mismo sentido —`logPiiAccess` y `audit()` atrapan su propio
 * error y lo dejan en el log de aplicación—, así que ninguno de los dos tumba la edición; se hacen
 * con `await` para que estén escritos antes de que salga la respuesta.
 *
 * **El limitador que le falta está anotado, no puesto**: esta ruta no tiene bolsa propia y, por lo
 * que acaba de decirse, es también un limitador de lectura disfrazado de escritura —quien quisiera
 * leer NITs de uno en uno podría pedirlos por aquí sin gastar la cuota de `lecturasPiiLimiter`—. Es
 * preexistente y no es del Bug #11671.
 */
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
    // La otra mitad: la respuesta le entrega el NIT y el alias de la fila a quien solo mandó su
    // UUID. Ver el docstring — es el mismo caso que el PATCH de gestión, no el del alta.
    await registrarAccesoComparendos(req, {
      recurso: RECURSO_NIT,
      accion: 'read',
      campos: [...CAMPOS_PII_NIT],
      filas: 1,
      referencia: id,
    });
    res.set('Cache-Control', 'no-store');
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
 * NIT de persona natural es un documento de identidad —lo dice el COMMENT de la 0150—. `GET
 * /registros` (HU #11502) usa el mismo `registrarAccesoComparendos` con `RECURSO_REGISTROS`.
 *
 * **Y por eso mismo las dos salen con `no-store` y con cuota desde el Bug #11646.** El rastro dice
 * quién miró; no impide que la respuesta —hasta 100 corridas, cada una con su `scope_nits`— se
 * quede escrita en la caché de disco del navegador y siga ahí cuando el usuario cierre sesión o
 * preste el equipo. Son las dos mitades del mismo criterio y aquí solo estaba puesta una.
 */
router.get('/sync/runs', lecturasPiiLimiter, async (req: Request, res: Response) => {
  const parsed = runsQuerySchema.safeParse(req.query);
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }
  const runs = await listarSyncRuns(parsed.data.limit);
  await registrarAccesoComparendos(req, {
    recurso: RECURSO_SYNC_RUN,
    accion: 'search',
    campos: [...CAMPOS_PII_SYNC_RUN],
    filas: runs.length,
  });
  res.set('Cache-Control', 'no-store');
  res.json(runs);
});

/** Detalle de una corrida con sus `steps[]`: qué fuente falló, con qué código y cuánto tardó (AC4). */
router.get('/sync/runs/:id', lecturasPiiLimiter, async (req: Request, res: Response) => {
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
    res.set('Cache-Control', 'no-store');
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
// La única escritura sobre un comparendo es el PATCH de gestión (HU #11557), que está al final del
// archivo y toca exactamente dos columnas: `causal_id` y `observacion`. Ni una de las de fuente.

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
 * Un booleano de query string, escrito a mano y con el alfabeto cerrado a `true`/`false`.
 *
 * **No es `z.coerce.boolean()`, y esa es toda la razón de que exista**: `coerce` aplica la
 * veracidad de JavaScript, donde la cadena `'false'` es `true` por no estar vacía. Un
 * `?sinCausal=false` que filtrara por «sin causal» sería el peor de los fallos posibles aquí —el
 * usuario quita el filtro y la lista se estrecha— y no lo delataría ningún error. Lo que no es
 * exactamente uno de los dos literales es un 400: `?sinCausal=1` no se adivina.
 */
const booleanoDeQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * Query de lista, compartida por `GET /registros` y `POST /registros/buscar`.
 *
 * Solo lleva lo que NO identifica a una persona: el estado de monitoreo, un fragmento del número de
 * comparendo —un consecutivo del Estado—, los tres filtros de gestión de la HU #11555 y la
 * paginación. Es la mitad del contrato que sí puede acabar en un access log sin que eso sea una
 * fuga (AGENTS.md §14): un municipio, un origen de merge y el id de una causal describen al
 * comparendo, no a su titular.
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
const registrosQueryCampos = z.object({
  estado: vacioEsAusente(z.enum(['activo', 'inactivo'])),
  // Mínimo 3 caracteres: `q=1` recorrería la tabla para devolver medio módulo.
  q: vacioEsAusente(z.string().trim().min(3, 'Busca por al menos 3 caracteres del número').max(60)),
  // El MISMO esquema del catálogo (normaliza y luego mide): el filtro compara contra el
  // `codigo_fuente` que se guardó, así que tiene que aceptar exactamente lo que aquel aceptó y
  // aplastarlo igual. De regalo hereda su alfabeto cerrado, que aquí no protege una URL saliente
  // pero sigue impidiendo que un valor con metacaracteres llegue al servicio.
  municipio: vacioEsAusente(codigoFuenteSchema),
  // `origen_merge`, no el municipio: qué fuentes han visto el comparendo (CF-08). Un valor fuera
  // del enum es 400 aquí y la base no se toca.
  fuente: vacioEsAusente(z.enum(['simit', 'municipal', 'ambos'])),
  // UUID y no cadena libre: `causal_id` es `uuid` en PostgreSQL y una comparación contra algo que
  // no lo es revienta con un 22P02 —un 500— en lugar de decir qué pasa.
  causalId: vacioEsAusente(z.string().uuid('La causal debe ser un identificador válido')),
  sinCausal: vacioEsAusente(booleanoDeQuery),
  limit: z.preprocess(
    (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    z.coerce.number().int().min(1).max(COMPARENDOS_REGISTROS_LIMIT_MAX)
      .default(COMPARENDOS_REGISTROS_LIMIT_MAX),
  ),
  cursor: vacioEsAusente(z.string().max(200)),
}).strict();

/**
 * «Con esta causal» y «sin ninguna causal» son preguntas incompatibles, y su intersección está vacía
 * SIEMPRE. Dejarlas pasar respondería 200 con una lista vacía, que en una pantalla de gestión se lee
 * como «no hay comparendos así» y no como «pediste dos filtros que se anulan» — el operador
 * ajustaría el resto de la búsqueda persiguiendo un resultado que no puede llegar.
 *
 * Es una función suelta y no un `refine` escrito dos veces porque desde la HU #11558 hay dos
 * esquemas que la necesitan (el del listado y el del export). Dos copias serían dos reglas que
 * pueden separarse, y separarse aquí significa que el archivo sale vacío por un motivo que la
 * pantalla ya sabía explicar.
 */
const sinCausalContradictoria = (q: { causalId?: string; sinCausal?: boolean }): boolean =>
  !(q.causalId !== undefined && q.sinCausal === true);

const MENSAJE_CAUSAL_CONTRADICTORIA = {
  message: 'No se puede filtrar por una causal y por la ausencia de causal a la vez',
  path: ['sinCausal'],
};

const registrosQuerySchema = registrosQueryCampos
  .refine(sinCausalContradictoria, MENSAJE_CAUSAL_CONTRADICTORIA);

/**
 * Query del export (HU #11558): la misma del listado **menos `limit` y `cursor`**.
 *
 * La resta es el contrato, no una omisión: un export no pagina —entrega el conjunto entero o
 * responde 422—, así que `?limit=200` o un `?cursor=` no son parámetros que se ignoren, son un 400.
 * Aceptarlos en silencio dejaría creer que se descargó «la página 3» de algo.
 *
 * Se deriva del MISMO objeto que el listado (`registrosQueryCampos`) y no se vuelve a escribir: el
 * filtro que el usuario tiene puesto en el visor y el que produce el archivo tienen que ser el mismo
 * o el export deja de ser «lo que estoy viendo» (AC1). El `.strict()` se repite después del `omit`
 * porque es lo que convierte `?nit=` en la query en el 400 que exige el AGENTS.md §14.
 */
const exportQuerySchema = registrosQueryCampos
  .omit({ limit: true, cursor: true })
  .strict()
  .refine(sinCausalContradictoria, MENSAJE_CAUSAL_CONTRADICTORIA);

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
    campos: [...CAMPOS_PII_REGISTRO, ...CAMPOS_PII_OBSERVACION],
    filas: pagina.items.length,
    // El orden importa y no es alfabético: `motivo` es `varchar(200)` y se recorta por el final, así
    // que delante va lo que un titular preguntaría —con qué identidad se buscó— y detrás los
    // criterios de negocio. Si alguna vez el recorte muerde, muerde lo prescindible. Los tres de la
    // HU #11555 van con su valor literal porque no lo son de nadie; el enmascarado de `nit` y
    // `placa` lo pone `registrarAccesoComparendos`, no esta función.
    filtros: {
      estado: filtro.estado,
      nit: filtro.nit,
      placa: filtro.placa,
      q: filtro.q,
      municipio: filtro.municipio,
      fuente: filtro.fuente,
      causalId: filtro.causalId,
      sinCausal: filtro.sinCausal,
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
 * `POST /registros/export` — el resultado del filtro, en un `.xlsx` (HU #11558, CF-07, ADR-0004).
 *
 * **Es un POST y no existe la variante GET, que es medio AC1.** No es purismo REST: un
 * `<a download href="…?nit=900123456">` —la forma natural de descargar— escribiría el NIT en el
 * access log del proxy, en el historial del navegador y en el `Referer`, los tres sitios que este
 * módulo lleva dos Features sacando de en medio (AGENTS.md §14). Que no haya GET es también lo que
 * obliga a la pantalla a descargar con `fetch` + `blob`, que es lo que se pidió en el ADR.
 *
 * **El orden de las cuatro operaciones es normativo (AC4) y está sostenido por algo más que este
 * comentario.** Validar → consultar con tope+1 → registro de acceso → cabeceras y archivo. Lo que
 * hace el orden difícil de invertir no es la secuencia escrita aquí sino que
 * `construirFilasExport` **lanza** cuando el filtro se pasa del tope: no devuelve filas de más que
 * alguien pudiera empezar a escribir «mientras comprueba». Sin filas no hay `sendExcel`, y sin
 * `sendExcel` no hay `Content-Disposition`; el 422 sale como JSON limpio por el `catch`, que es todo
 * el AC3. Un `res.set('Content-Disposition', …)` movido dos líneas más arriba produciría un `.xlsx`
 * de 300 bytes con un JSON de error dentro, y el usuario no lo entendería: por eso las cabeceras son
 * lo ÚLTIMO.
 *
 * **Qué pasa en el 422 con el rastro, porque el AC4 se puede leer al revés.** Lo que el AC prohíbe
 * emitir cuando el export no procede es el registro de acceso DEL EXPORT —`accion='export'` con sus
 * filas—, y eso se cumple: por ahí no pasa. Lo que sí queda es una línea distinta, `accion='search'`
 * con `filas=0` y el marcador `resultado=export_demasiado_grande`, porque la consulta llegó a correr
 * y porque sin ella el `pii_access_log` mentiría por omisión justo donde ADR-0004 promete leerlo
 * para recalibrar el tope (el razonamiento entero está en el `catch`).
 *
 * El registro de acceso va con `filas` = las entregadas de verdad (no el tope, no lo pedido) y se
 * espera con `await` antes de escribir el primer byte (AC6): esta petición vale hasta
 * `COMPARENDOS_EXPORT_MAX_FILAS` NITs y placas, así que perder su rastro por un fallo a mitad del
 * archivo no es aceptable. `campos` no incluye `CAMPOS_PII_PAYLOAD` porque los payloads no salen en
 * el archivo (RN-42): declarar de más haría que `campos_accedidos` dejara de decir la verdad, que
 * es lo único que ese log tiene que hacer.
 */
router.post('/registros/export', exportLimiter, async (req: Request, res: Response) => {
  const query = exportQuerySchema.safeParse(req.query);
  if (!query.success) { datosInvalidos(res, query.error); return; }
  // Igual que en `/registros/buscar`: sin cuerpo es un export sin filtros de identidad, no un error.
  const cuerpo = registrosBusquedaSchema.safeParse(req.body ?? {});
  if (!cuerpo.success) { datosInvalidos(res, cuerpo.error); return; }
  const filtro = { ...query.data, ...cuerpo.data };

  // Mismo orden que en `entregarPagina` y por el mismo motivo: `motivo` es `varchar(200)` y se
  // recorta por el final, así que delante va con qué identidad se buscó.
  const filtrosDelRastro = {
    estado: filtro.estado,
    nit: filtro.nit,
    placa: filtro.placa,
    q: filtro.q,
    municipio: filtro.municipio,
    fuente: filtro.fuente,
    causalId: filtro.causalId,
    sinCausal: filtro.sinCausal,
  };

  // Las mismas columnas personales que declara el listado, porque el archivo lleva las mismas: NIT,
  // placa y la observación que escribió una persona. Los payloads no (RN-42).
  const camposDelRastro = [...CAMPOS_PII_REGISTRO, ...CAMPOS_PII_OBSERVACION];

  try {
    // Aquí se decide el 422: si el filtro se pasa del tope, esto lanza y no hay filas que escribir.
    const filas = await construirFilasExport(filtro);

    await registrarAccesoComparendos(req, {
      recurso: RECURSO_REGISTROS,
      accion: 'export',
      campos: camposDelRastro,
      filas: filas.length,
      filtros: filtrosDelRastro,
    });

    // Un archivo con NIT, placa y observaciones dentro no se guarda en ningún intermedio.
    res.set('Cache-Control', 'no-store');
    await sendExcel(res, nombreArchivoExport(), COLUMNAS_EXPORT, filas);
  } catch (e) {
    // Si el fallo llega con la respuesta ya empezada —el archivo se estaba escribiendo—, `fallo()`
    // reventaría con ERR_HTTP_HEADERS_SENT y taparía la causa real. Se relanza al manejador global,
    // que sabe cerrar una respuesta a medias.
    if (res.headersSent) throw e;

    // **El export que choca con el tope también deja rastro**, y no por simetría.
    //
    // La consulta ya CORRIÓ: `tope + 1` filas con su NIT y su placa entraron en el proceso; lo único
    // que no ocurrió es la entrega. Un log que las omita deja dos agujeros, y el segundo es el que
    // obliga:
    //
    //   · Trazabilidad: «pedí el histórico entero de este NIT» es un gesto que la Ley 1581 art. 17
    //     puede tener que responder, y sin esta línea de él solo consta que alguien gastó cuota.
    //   · **Sesgo en el dato con el que ADR-0004 promete recalibrar el tope.** El ADR dice revisar
    //     el `pii_access_log` a los dos o tres meses para decidir si el tope sobra o falta. Si los
    //     exports que superan el tope no se escriben, la muestra queda amputada JUSTO en la cola que
    //     se quiere medir: concluiría que casi nadie se acerca al tope precisamente porque los que
    //     lo pasan son invisibles.
    //
    // `accion: 'search'` y no `'export'`: no se exportó nada, y contarlo como export estropearía los
    // agregados de `/api/privacy/pii-access/stats` y el recuento de filas realmente extraídas.
    // `filas: 0` es literal —no se entregó ninguna—, y el conteo real ni se sabe ni se sabrá: el
    // `tope + 1` existe para no calcularlo, así que esta fila tampoco revela cuántos comparendos
    // tiene el filtro. El marcador va DELANTE de los filtros porque `motivo` se recorta por el
    // final, y sin él esta línea sería indistinguible de una búsqueda cualquiera.
    if (e instanceof ComparendosExportDemasiadoGrandeError) {
      await registrarAccesoComparendos(req, {
        recurso: RECURSO_REGISTROS,
        accion: 'search',
        campos: camposDelRastro,
        filas: 0,
        filtros: { resultado: e.codigo, ...filtrosDelRastro },
      });
    }

    fallo(res, e);
  }
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
      campos: [...CAMPOS_PII_REGISTRO, ...CAMPOS_PII_OBSERVACION],
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

// ─────────────────────────────── Gestión del comparendo (CF-05, HU #11557) ──────────────────────
//
// La ÚNICA escritura del módulo sobre un comparendo, y toca dos columnas de las veintitantas de la
// tabla: la causal y la observación. Todo lo demás es dato de fuente y no se edita (RN-04, CF-09) —
// lo que en este archivo significa que el esquema es `.strict()` y que un cuerpo con `placa`,
// `monto` u `origenMerge` dentro es un 400, no un cuerpo del que se ignoran tres claves.

/**
 * Cuerpo del PATCH. Estricto, con las dos claves opcionales por separado y ninguna obligatoria —
 * pero no las dos ausentes.
 *
 * `.strict()` hace aquí dos trabajos y el segundo es el que importa. El primero es el de siempre:
 * `{ "observaciones": "…" }` —el error de dedo— se ignoraría en silencio y respondería 200 diciendo
 * que se guardó algo que no se guardó. El segundo es que convierte en un **400 explícito** cualquier
 * intento de escribir un campo de FUENTE por esta puerta: `placa`, `monto`, `origen_merge`,
 * `estado`… ninguno existe en este esquema, así que la respuesta a mandarlos no es «se ignoró», es
 * «eso no se edita». Que la inmutabilidad de la fuente se sostenga en la VALIDACIÓN y no solo en el
 * `set()` del servicio es deliberado: son dos candados y el de aquí se lee sin abrir otro archivo.
 *
 * El `refine` final es el mismo criterio que en `PATCH /nits/:id`: un cuerpo vacío es un 400 y no un
 * no-op silencioso. Aquí además tiene una consecuencia propia —un `{}` que respondiera 200 dejaría
 * un evento `gestion` en el timeline por un cambio que no ocurrió—.
 */
const gestionSchema = z.object({
  // UUID y no cadena libre, por lo mismo que en el filtro del listado: `causal_id` es `uuid` en
  // PostgreSQL y una comparación contra algo que no lo es revienta con un `22P02` —un 500— en vez
  // de decir qué pasa. `null` es un valor legítimo: retira la causal.
  causalId: z.string().uuid('La causal debe ser un identificador válido').nullable().optional(),
  observacion: z.string()
    // `trim()` antes de medir, como en el resto del módulo: el tope es de caracteres escritos, no de
    // espacios pegados al final por un copiar y pegar.
    .trim()
    // **La fuente del número es `packages/shared-types` y no este archivo** (AC5): el contador de
    // caracteres del formulario y esta validación tienen que ser el mismo número o el usuario
    // descubre el tope real en un 400 después de haber escrito.
    .max(
      COMPARENDOS_OBSERVACION_MAX,
      `La observación admite hasta ${COMPARENDOS_OBSERVACION_MAX} caracteres`,
    )
    // El byte cero no cabe en una columna `text` de PostgreSQL: llegaría hasta el driver y saldría
    // como un `22021` (un 500) en vez de como el 400 que es. Un JSON puede llevarlo (`\u0000`), así
    // que se cierra aquí. El resto de caracteres de control —incluido el salto de línea— se admiten:
    // esto es un campo de texto largo y la observación no se concatena a ninguna bitácora (RN-41).
    // Es un `refine` y no un `regex` porque un carácter de control dentro de una expresión regular
    // es un aviso de ESLint (`no-control-regex`) que aquí sería ruido: la comprobación es «no lo
    // contiene», que se dice mejor sin regex.
    .refine((v) => !v.includes('\u0000'), 'La observación no admite caracteres nulos')
    // Una observación que al recortar queda vacía es una observación borrada, no una cadena vacía
    // guardada: la columna acabaría con dos formas de decir «no hay nada» y la pantalla tendría que
    // distinguirlas para nada. Es la misma normalización que `vacioEsAusente` hace en los filtros,
    // con la diferencia de que aquí vacío no significa «no filtres» sino «vacíalo».
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
}).strict()
  .refine((d) => d.causalId !== undefined || d.observacion !== undefined, {
    message: 'Nada que actualizar: manda `causalId`, `observacion` o las dos',
  });

/**
 * Gestión del comparendo: 30 por minuto y usuario.
 *
 * **Es un limitador de LECTURA disfrazado de escritura, y por eso existe.** La respuesta de este
 * PATCH es el registro completo —con NIT y placa— más su timeline, exactamente lo que devuelve
 * `GET /registros/:id`; sin este limitador, quien quisiera leer registros de uno en uno sin gastar
 * la cuota de `registrosLimiter` solo tendría que pedirlos por aquí mandando la causal que la fila
 * ya tiene. El número es más holgado que el de la lectura por fila porque gestionar es un gesto
 * humano y lento (elegir una causal, escribir una observación), y 30/min sigue siendo un techo que
 * ningún operador real toca.
 *
 * Va después de los guardas del router, como los otros cuatro: quien no pasa `authMiddleware` ni
 * `requireRole` no consume cuota, así que un 401 en bucle no le agota el cupo a nadie.
 */
const gestionLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-comparendos-gestion'),
  message: { error: 'Demasiadas gestiones seguidas, espere 1 minuto' },
  store: makeStore('rl:flito-comparendos-gestion:'),
});

/**
 * `PATCH /registros/:id/gestion` — asigna o retira la causal y la observación (AC1..AC9).
 *
 * Deja rastro en los DOS registros, que responden preguntas distintas y no se sustituyen (lo dice
 * la cabecera de `flito-comparendos.pii.ts`): `audit()` responde «quién CAMBIÓ qué» y es lo que
 * hacen las otras nueve escrituras del módulo; `registrarAccesoComparendos` responde «quién MIRÓ
 * datos personales», y hace falta porque la respuesta lleva NIT y placa — este endpoint escribe dos
 * columnas y devuelve una lectura completa del registro.
 *
 * Ni la observación ni la placa ni el NIT entran en ninguno de los dos rastros: el `detail` de la
 * bitácora dice qué campos se tocaron y cuánto medía el texto, nunca el texto (RN-41).
 */
router.patch('/registros/:id/gestion', gestionLimiter, async (req: Request, res: Response) => {
  const id = leerId(req, res);
  if (id === null) return;
  const parsed = gestionSchema.safeParse(req.body ?? {});
  if (!parsed.success) { datosInvalidos(res, parsed.error); return; }

  // `authMiddleware` corre antes que esta ruta y rechaza sin token, así que en la práctica siempre
  // hay `sub`. Se comprueba igualmente porque aquí el actor es OBLIGATORIO y no opcional como en el
  // resto del módulo: el `CHECK` de la 0156 ata `gestion_actualizada_por` a
  // `gestion_actualizada_en`, así que un `?? null` con la fecha puesta sería un `23514` de la base
  // —un 500— en lugar de esta respuesta honesta.
  const actorId = req.user?.sub;
  if (actorId === undefined) { res.status(401).json({ error: 'Sesión no válida' }); return; }

  try {
    const registro = await gestionarComparendo(id, parsed.data, actorId);

    const campos = [
      parsed.data.causalId !== undefined ? `causal=${parsed.data.causalId ?? '—'}` : null,
      parsed.data.observacion !== undefined
        // La LONGITUD, nunca el texto (RN-41): `audit_logs` se consulta y se exporta, y una
        // observación la escribe una persona que pudo poner ahí lo que le pareciera relevante.
        ? `observación=${parsed.data.observacion === null ? 'sin observación' : `${parsed.data.observacion.length} caracteres`}`
        : null,
    ].filter((p): p is string => p !== null);

    await audit(req, {
      action: 'update',
      resource: 'flito_comparendos_registro',
      resourceId: registro.id,
      // Sin NIT y sin placa: el `resourceId` ya identifica el comparendo y desde él se llega a la
      // fila. La bitácora de este módulo nunca ha escrito la placa y no empieza aquí.
      detail: `Gestión del comparendo: ${campos.join(', ')}`,
    });

    // El registro de acceso va con `accion: 'read'` y no con una acción de escritura, y no es un
    // apaño: esta tabla registra ACCESOS, y lo que hubo aquí es que alguien VIO el NIT, la placa y
    // la observación de este comparendo — justo lo que la respuesta le entregó. El «quién cambió
    // qué» lo cuenta `audit()`, arriba, que es la otra mitad y no se sustituyen.
    //
    // Meter un valor de escritura en `accion` costaría dos uniones de TypeScript
    // (`shared/pii-audit.ts` y el `AccesoComparendos` de este módulo; la columna es `varchar(20)`
    // sin CHECK, y en `packages/shared-types` no hay nada) y rompería los agregados de
    // `/api/privacy/pii-access/stats`, que cuentan por acción. Ninguna de las dos cosas es cara; lo
    // que sería equivocado es el significado.
    await registrarAccesoComparendos(req, {
      recurso: RECURSO_REGISTROS,
      accion: 'read',
      campos: [...CAMPOS_PII_REGISTRO, ...CAMPOS_PII_OBSERVACION],
      filas: 1,
      referencia: registro.id,
    });

    // Igual que las otras tres rutas que devuelven registros: la respuesta lleva NIT y placa, así
    // que no se cachea en ningún sitio intermedio.
    res.set('Cache-Control', 'no-store');
    res.json(registro);
  } catch (e) { fallo(res, e); }
});

export default router;
