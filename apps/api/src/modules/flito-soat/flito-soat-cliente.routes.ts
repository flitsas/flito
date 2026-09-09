// FLITO — SOAT, canal Cliente (HTTP). Feature #11912, HU #11914 (alta), #11935 (alta sin RUNT
// bloqueante), #11966 (el RUNT vuelve a ser compuerta), #12092 (lectura OCR de la factura),
// #12080 (retirada de la revisión de Operaciones) y #12090 (la consulta al RUNT va SOLO por VIN).
// Montado en `/api/flito/soat`, junto al router del módulo.
// Contrato: ADR-0008 §6 y ADR-0010, que SUPERSEDE al ADR-0009. Los dos endpoints que consultan el
// RUNT —`POST /cliente/preconsulta` y `POST /cliente`— esperan a Kyverum y comparten la compuerta.
//
// ── Qué vive aquí, exactamente ───────────────────────────────────────────────────────────────────
//
// TRES rutas, las tres del rol `cliente` y las tres de la RADICACIÓN:
//
//   POST /cliente/preconsulta      — qué dice el RUNT de este vehículo (paso 1 del formulario).
//   POST /cliente                  — radicar. Crear ES enviar: la fila nace en `solicitado`.
//   POST /cliente/factura/lectura  — el OCR lee el comprador de la factura para prellenar el alta.
//
// Este archivo llegó a tener el ciclo entero del canal —radicar, validar, rechazar y subsanar—
// mientras existió la revisión de Operaciones (HU #11915). **Ya no.** El Feature #12074 la retira:
// desde la #12078 el alta despacha al gestor por defecto de la compañía y desde la #12079 la
// pantalla que revisaba no existe, así que la #12080 borra de aquí `GET /causales-rechazo`,
// `POST /:id/validar`, `POST /:id/rechazar-solicitud` y `PATCH /:id/solicitud` —y con ellas el
// último uso de `requireRole('admin')` en este router—. Lo que queda es de un solo rol y de un solo
// momento, y por eso este archivo ya no cuenta ningún ciclo: cuenta una puerta de entrada.
//
// Lo que sí sigue en pie es la razón de que sea un archivo aparte montado en la MISMA base: el
// recurso es el mismo (`flito_soat`), el aislamiento por compañía tiene que seguir pasando por
// `contextoSoat()`, y `flito-soat.routes.ts` tiene el techo de líneas congelado.
//
// No hay colisión de rutas con el router del módulo: sus patrones de segundo nivel son literales
// (`enviar`, `facturas`, `:id/rechazar`, `:id/factura`…) y ninguno casa con los de aquí, que hoy
// cuelgan todos del segmento literal `/cliente`. El montaje va ANTES en `app.ts` para que, si algún
// día se añadiera un patrón que sí casara, gane el específico.
//
// ── PII: nada identificable en la URL (AGENTS.md §14, AC5) ──────────────────────────────────────
//
// VIN y documento del propietario viajan SIEMPRE en el cuerpo. Por eso la preconsulta es un `POST`
// y no un `GET` con parámetros, aunque no escriba nada: un `GET /preconsulta?vin=…` deja el VIN en
// el log de acceso de nginx, en el historial del navegador y en el `Referer`. Ninguna de las tres
// rutas lleva hoy un `:id` siquiera.
//
// **La regla no se relaja porque desde la HU #12090 el único identificador de entrada sea el VIN**,
// y conviene decirlo: un VIN identifica un vehículo tan indirectamente como una placa —de hecho es
// la clave por la que este módulo busca— y `flito-soat.pii.ts` ya lo clasifica como dato personal.
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
import { soatClienteLimiter, soatPreconsultaLimiter, soatLecturaFacturaLimiter } from '../../shared/middleware/rateLimiter.js';
import {
  CAMPOS_COMPRADOR_FACTURA, PROCEDENCIAS_DATO, TIPOS_DOCUMENTO_RUNT,
  type ProcedenciaCompradorPersistida, type TipoDocumentoRunt,
} from '@operaciones/shared-types';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import { contextoSoat } from './flito-soat.service.js';
import { registrarAccesoRuntCliente, registrarLecturaFacturaCliente } from './flito-soat.pii.js';
import {
  crearSolicitud, DESENLACE_HABLA_DEL_VEHICULO, leerFacturaVenta, nombreCompletoDe, normalizarId,
  preconsulta, SolicitudSoatError,
  type ArchivoSolicitud, type PropietarioSolicitud,
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

// Aquí vivía `REVISION_OPERACIONES = requireRole('admin')`, el guarda de las cuatro rutas de la
// revisión. Se va con ellas (HU #12080): un `requireRole` sin ninguna ruta que lo use no es una
// cerradura, es una invitación a colgarle la siguiente ruta que aparezca sin volver a pensar quién
// debería poder llamarla.

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
  // El OCR caído sale como **503**, no como 500 (AC6 de la HU #12092). Sin esta rama, el `throw` de
  // abajo lo entregaba al handler global de Express, que responde 500: el formulario leería «error
  // del servidor» en vez de «el lector no está disponible ahora mismo, siga a mano», que es lo único
  // que el AC pide poder distinguir. Es la misma línea que ya tiene `flito-derechos.routes.ts`.
  if (e instanceof OcrNoDisponibleError) { res.status(e.status).json({ error: e.message }); return; }
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

/**
 * Todo llega como `multipart/form-data` en el alta, así que TODO campo es texto: no hay booleanos ni
 * números que Zod pueda coaccionar, y los campos que el formulario deja sin llenar llegan como
 * cadena VACÍA, no ausentes. De ahí este `preprocess`, que los pasa a `null`.
 *
 * Va aquí arriba —y no junto al `altaSchema`, donde estaba— porque desde la HU #11966 lo usa también
 * `vehiculoSchema` para el VIN opcional, que se declara antes.
 */
const vacioANull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/**
 * El piso del VIN, **medido sobre el valor NORMALIZADO** (bloqueante 1 de la auditoría de la #12090).
 *
 * ── Por qué 11 y no 5, que es lo que decía el AC ────────────────────────────────────────────────
 *
 * El AC1 pedía `min(5)`, heredado de la #11966. Allí ese piso era inofensivo porque el VIN NO era la
 * clave de búsqueda: `runt-direct.service.ts` activa la modalidad de VIN con
 * `vinNorm = (!placa && vin)`, así que con la placa presente el VIN solo alimentaba
 * `campoQueNoCuadra` y un valor corto acababa, como mucho, en un 422. Desde esta HU ese fragmento
 * **es** lo que se le manda a un registro nacional de pago, y un piso de 5 sobre un dato al que
 * luego se le quitan los separadores admite `'A-B-C'` → `ABC` (tres) y `'--A--'` → `A` (uno). El
 * piso tiene que valer para lo que SALE, no para lo que entra.
 *
 * 11 son las posiciones 1-11 de un VIN: WMI (fabricante), VDS (descriptor), dígito de control, año y
 * planta. Lo que un VIN no comparte con sus hermanos de flota son las seis últimas —el serial
 * consecutivo—, así que exigir 11 **no** impide enumerar una flota: eso lo acota el limitador (ver
 * `soatPreconsultaLimiter` en `shared/middleware/rateLimiter.ts`). Lo que 11 cierra es lo que estaba
 * abierto: que se reenvíe al RUNT un fragmento que ni siquiera identifica un modelo. Es además el
 * único piso de VIN que ya existía en el repo (`flito-tramites.routes.ts`, el alta de trámites demo).
 *
 * **No se sube a 17 —el VIN completo—, y conviene decir por qué, porque sería lo más estricto**: no
 * hay ninguna medición de la distribución real de `length(vehicles.vin)` en producción, y la columna
 * es `varchar(17)` y no `char(17)` justamente porque admite los chasis más cortos que llegan por la
 * vía legacy y por el OCR de la tarjeta de propiedad. Exigir 17 sin ese dato rechazaría altas
 * legítimas: una regresión funcional a cambio de un margen que 11 ya cubre en lo esencial. Revisable
 * en cuanto exista la medición.
 *
 * **Es una desviación DECLARADA del AC1**, no un descuido: el AC dice 5 y aquí hay 11.
 */
const VIN_MIN = 11;

/**
 * **El vehículo se identifica por VIN, y por nada más** (HU #12090, AC1).
 *
 * `vin` era opcional bajo la #11966 y aquí vuelve a ser obligatorio, pero por el motivo contrario:
 * entonces era una comprobación de cortesía sobre una consulta que iba por placa + documento; ahora
 * es la CLAVE de la consulta. Sin él no hay nada que preguntarle al RUNT, así que su ausencia es un
 * 400.
 *
 * ── La normalización va ANTES de medir, y es la MISMA función del servicio ──────────────────────
 *
 * El `preprocess` aplica `normalizarId()` —la que exporta `flito-soat-cliente.service.ts`, no una
 * copia— y el `min`/`max` cuentan sobre su salida. Antes el borde hacía `.trim()` y el servicio
 * quitaba además los separadores, así que el piso medía una cadena DISTINTA de la que viajaba. Con
 * una sola función no hay dos longitudes que puedan discrepar, y `parsed.data.vin` ya es exactamente
 * lo que se va a consultar y a persistir.
 *
 * Efecto lateral bueno, dicho para que nadie lo «arregle»: el `max(17)` también cuenta sobre lo
 * normalizado, así que un VIN legítimo tecleado con separadores (`9FKRG-2222-T2042405`, 19 crudos y
 * 17 al normalizar) pasa a ser ACEPTADO donde antes era un 400. `max(17)` sigue siendo la longitud
 * de `vehicles.vin`.
 *
 * ── `placa` ya no se declara, y Zod la DESCARTA sin error. Es deliberado ────────────────────────
 *
 * Este objeto NO lleva `.strict()`, a diferencia de `procedenciaMapaSchema`, y la diferencia tiene
 * que estar escrita porque las dos decisiones conviven en este archivo. El formulario del canal
 * sigue mandando `placa`, `tipoDocumento` y `numeroDocumento` en la preconsulta hasta que entre la
 * HU #12091, que es la que reordena la pantalla: si este schema los RECHAZARA, el canal Cliente
 * quedaría roto en el intervalo entre las dos historias. Descartarlos es además lo correcto en el
 * fondo y no solo lo compatible: una clave de más aquí es ruido de un formulario sobre un dato que
 * la ruta ya no usa para nada, mientras que una clave de más en el mapa de procedencia es una
 * AFIRMACIÓN sobre un dato del titular que se va a guardar. Por eso allí es 400 y aquí no.
 *
 * Lo que sí queda cerrado por construcción: una `placa` colada en el cuerpo no puede llegar al RUNT
 * ni a `vehicles.plate`, porque `parsed.data` no la contiene y nadie lee `req.body` después.
 */
const vehiculoSchema = z.object({
  vin: z.preprocess(
    (v) => (typeof v === 'string' ? normalizarId(v) : v),
    z.string()
      .min(VIN_MIN, `El VIN debe tener al menos ${VIN_MIN} caracteres`)
      .max(17, 'El VIN no puede pasar de 17 caracteres'),
  ),
});

const preconsultaSchema = vehiculoSchema;

/**
 * El documento del PROPIETARIO, que desde la HU #12090 es solo del alta.
 *
 * Ya no se merge en la preconsulta: la modalidad de VIN del RUNT no pide documento —el Bug #11927
 * obligaba a mandarlo porque iba la PLACA— y pedirlo para no usarlo sería recoger un dato personal
 * sin destino. En el alta se conserva porque ahí sí tiene uno: es el titular que se persiste en
 * `flito_compradores` y en `vehicles.owner_document`, no un parámetro de consulta.
 *
 * Mismo criterio de siempre: PII en el cuerpo, nunca en la URL.
 */
const documentoSchema = z.object({
  tipoDocumento: z.enum(TIPOS_DOCUMENTO_RUNT),
  numeroDocumento: z.string().trim().min(4, 'El documento del propietario es obligatorio').max(30),
});

/**
 * POST /cliente/preconsulta — paso 1: qué dice el RUNT de este vehículo.
 *
 * **Recibe el VIN y nada más** (HU #12090, AC1). Ni placa ni documento del propietario: la consulta
 * va por la modalidad de VIN, que no los pide. Sin `vin` es 400, no 503.
 *
 * No escribe nada, pero **sí deja rastro de acceso a datos personales**: devuelve la placa, el VIN y,
 * cuando el RUNT lo trae, el nombre del propietario. Es una consulta a un registro nacional sobre un
 * vehículo que puede no ser de quien pregunta, y quien pregunta es una empresa tercera. Por eso
 * `registrarAccesoRuntCliente` sigue corriendo en cada llamada —quién, cuándo y si trajo
 * propietario— y por eso la ruta sigue bajo `soatClienteLimiter`, el contador del canal.
 *
 * **Y desde esta HU lleva ADEMÁS `soatPreconsultaLimiter`, en ese orden** (bloqueante 3 de la
 * auditoría). El compartido va primero para que un sondeo consuma también el presupuesto del canal;
 * el segundo le pone a la preconsulta un techo más bajo DENTRO de esos 20. El motivo está en el
 * docblock de aquel: mientras la consulta exigía el documento del titular, enumerar era imposible a
 * cualquier ritmo y el límite solo contenía coste; consultando por VIN, el límite es lo único que
 * pone ritmo. Invertir el orden convertiría el sub-límite en un presupuesto aparte.
 *
 * ── RN-B1: consultar por VIN NO acredita al titular, y la consulta por documento SÍ lo hacía ────
 *
 * Hasta esta HU la pasarela solo respondía si el documento tecleado figuraba entre los propietarios
 * activos del vehículo, así que un 200 era, de rebote, una comprobación de titularidad gratis. Con
 * la modalidad de VIN eso desaparece: **cualquiera que conozca un VIN obtiene la ficha del
 * vehículo**, y el RUNT ya no dice nada sobre quién es su dueño. Queda escrito aquí para que nadie
 * vuelva a leer un 201 de esta ruta como «FLITO comprobó que el vehículo es de quien lo radica».
 *
 * **Lo que acredita la titularidad es la FACTURA DE VENTA**, obligatoria en `POST /cliente` y
 * revisada por Operaciones — no el RUNT. Las otras dos defensas que sí siguen en pie son de
 * AISLAMIENTO, no de titularidad, y conviene no confundirlas: `verificarRn01` impide que un vehículo
 * tenga dos SOAT, y `verificarTenenciaVehiculo` impide pisar la ficha de otra compañía.
 *
 * El VIN viaja en el CUERPO y por eso esto es un `POST` y no un `GET` con parámetros, aunque no
 * escriba nada (AGENTS.md §14): un VIN en la query queda en el log de nginx, en el historial del
 * navegador y en el `Referer`.
 */
router.post('/cliente/preconsulta', CANAL_CLIENTE, soatClienteLimiter, soatPreconsultaLimiter, async (req: Request, res: Response) => {
  const parsed = preconsultaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { vin } = parsed.data;
  try {
    const ctx = await contextoSoat(req.user!);
    const resultado = await preconsulta(vin, ctx);
    // El VIN va TECLEADO y no el efectivo del RUNT, y son el mismo valor en todo camino que llega
    // aquí: `campoQueNoCuadra` corta con 422 si difieren y con `runt_sin_vin` si el RUNT no lo
    // publica, así que solo el desenlace `ok` sigue. Se toma el tecleado porque es `string` —el del
    // RUNT es `string | null`— y porque es la MISMA expresión en los dos call sites, simetría que un
    // lector futuro no puede romper por descuido. La invariante está PROBADA, no comentada, en
    // `flito-soat.cliente-runt-por-vin.test.ts`. La placa, en cambio, solo puede venir del RUNT.
    await registrarAccesoRuntCliente(req, {
      vin, placa: resultado.vehiculo.placa, conPropietario: resultado.propietario !== null,
      // El 200 con renovación anticipada divulga ADEMÁS hasta cuándo vence el SOAT que el RUNT
      // reporta (HU #12212). Sin esta línea, `campos_accedidos` sub-declararía justo en las
      // respuestas que dicen más. Se deriva del resultado y no del cuerpo de la petición: lo que el
      // registro tiene que anotar es lo que SALIÓ, no lo que se pidió.
      conVigenciaProxima: resultado.vigenciaProxima !== null,
    });
    res.json(resultado);
  } catch (e) {
    await registrarIntentoRunt(req, vin, e, 'preconsulta');
    manejarError(res, e);
  }
});

/**
 * Deja constancia de un intento que **no entregó nada** y que aun así **dice algo del VEHÍCULO**
 * preguntado (ADR-0012 §8.2, decidido por David).
 *
 * Quién cumple esa condición lo decide {@link DESENLACE_HABLA_DEL_VEHICULO}, no una lista de
 * estados: «409, 422 o 503» era la forma que ese `Record` vino a reemplazar, y además no acertaba
 * —los dos 403 y el 400 del adjunto pasan por este mismo `catch` y no describen ninguna consulta—.
 *
 * ── Por qué hace falta ──────────────────────────────────────────────────────────────────────────
 *
 * El rastro se escribía DESPUÉS de que el servicio devolviera, así que solo quedaban los aciertos.
 * Con la consulta por placa + documento eso apenas importaba —había que conocer al titular para
 * preguntar—, pero enumerando VIN consecutivos **la mayoría de los intentos fallan**: el registro
 * veía justo lo que no era sondeo. Y el `409` de vehículo ajeno es además una divulgación pequeña
 * pero real (confirma que ese vehículo está en FLITO). Sin esta línea, la enumeración queda solo
 * ACOTADA por el limitador y no VISIBLE.
 *
 * ── Las tres cosas que tiene que respetar ───────────────────────────────────────────────────────
 *
 *   1. **No cambia la respuesta.** No toca `res`; de eso sigue encargándose `manejarError`, que se
 *      llama después y con el MISMO error.
 *   2. **No se come la excepción.** El `catch` de aquí solo traga fallos DEL REGISTRO —`logPiiAccess`
 *      ya falla abierto por su cuenta— para no sustituir el error de dominio, que es el que la
 *      persona necesita, por uno de la bitácora. Un `throw` aquí convertiría un 422 legible en un 500.
 *   3. **No dice que se accedió a datos.** Va con `resultado`, y eso hace que `campos_accedidos` se
 *      escriba VACÍO: no se entregó ni la placa, ni el VIN, ni el nombre. Ver `registrarAccesoRuntCliente`.
 *
 * El desenlace se toma del `codigo` del error de dominio —vocabulario CERRADO de `shared-types`— y
 * nunca de `e.message`, que es texto que puede traer dentro lo que se estuviera procesando.
 *
 * ── QUÉ fallos se registran, y por qué NO todos los que pasan por el `catch` ────────────────────
 *
 * El `catch` de estas dos rutas envuelve también las guardas que corren ANTES de la compuerta
 * —`canalDeLaCompania` (403) y `verificarPdfReal` (400)—, y ninguna describe una consulta sobre
 * ningún vehículo: la respuesta habría sido idéntica con cualquier VIN. Registrarlas escribía en el
 * log del artículo 17 la frase «Consulta RUNT del canal Cliente…» para peticiones que **nunca
 * consultaron el RUNT** — un EVENTO sobredeclarado, que es la misma clase de mentira que esta HU
 * vino a cerrar en `campos_accedidos`, un nivel más arriba. Y contradecía la regla que este módulo ya
 * se aplica al 400 del borde: «no describe ninguna consulta a un tercero».
 *
 * Quién es quién lo decide {@link DESENLACE_HABLA_DEL_VEHICULO}, un `Record` TOTAL que vive junto a
 * los `fallo()` del servicio: un desenlace nuevo no compila hasta que alguien lo clasifica. Aquí no
 * se repite ninguna lista, que es lo que derivaría.
 *
 * **Un error que NO es del canal tampoco se registra.** Un `throw` inesperado —lo que acaba en 500—
 * no es una afirmación sobre un vehículo, es un fallo nuestro, y para eso está el log de errores.
 * Escribirlo como «intento de acceso» metería en una tabla legal cualquier bug que se cuele por aquí.
 */
async function registrarIntentoRunt(
  req: Request, vin: string, e: unknown, motivo: 'preconsulta' | 'alta',
): Promise<void> {
  if (!(e instanceof SolicitudSoatError)) return;
  if (!DESENLACE_HABLA_DEL_VEHICULO[e.codigo]) return;
  const resultado = e.codigo;
  try {
    await registrarAccesoRuntCliente(req, { vin, conPropietario: false, motivo, resultado });
  } catch { /* el rastro no puede tapar el error de dominio: ver el punto 2 de arriba */ }
}

/**
 * El titular tal como lo teclea el Cliente: PARTIDO y con contacto y ubicación obligatorios (AC5 de
 * la HU #11966).
 *
 * Marca, línea, modelo, clase, servicio, cilindraje, carrocería y organismo NO están aquí, y esa
 * ausencia es el AC1: salen del RUNT y no se teclean. Aceptarlos «por comodidad del formulario»
 * permitiría radicar una solicitud con los datos que a uno le apetezca y con un organismo que decide
 * a qué proveedor acaba yendo el caso.
 *
 * **`nombreCompleto` tampoco está, y desde la #11966 tampoco se acepta.** Lo DERIVA el servicio
 * (`nombreCompletoDe`) de los tres campos de abajo. Aceptarlo dejaría dos fuentes de verdad para el
 * mismo nombre: la que el Excel publica (los campos partidos) y la que la cola busca
 * (`nombre_completo`), y podrían contradecirse sin que nada fallara.
 *
 * `correo`, `celular`, `direccion`, `municipio` y `departamento` son OBLIGATORIOS aquí aunque sus
 * columnas sigan nullable en la tabla: la nulabilidad la necesitan las filas de trámite, que llegan
 * sin contacto. La regla es del CANAL, y por eso vive en el borde del canal.
 */
const titularCampos = {
  nombres: z.preprocess(vacioANull, z.string().trim().max(200).nullable().optional()),
  apellidos: z.preprocess(vacioANull, z.string().trim().max(200).nullable().optional()),
  razonSocial: z.preprocess(vacioANull, z.string().trim().max(200).nullable().optional()),
  correo: z.string().trim().email('El correo no es válido').max(150),
  celular: z.string().trim().min(1, 'El celular es obligatorio').max(30),
  direccion: z.string().trim().min(1, 'La dirección es obligatoria').max(300),
  municipio: z.string().trim().min(1, 'El municipio es obligatorio').max(100),
  departamento: z.string().trim().min(1, 'El departamento es obligatorio').max(100),
} as const;

/**
 * `NIT` ⇒ razón social. Persona natural ⇒ nombres Y apellidos. **Nunca las dos cosas.**
 *
 * Es un `superRefine` y no dos schemas separados porque un `z.union` de dos objetos devolvería un
 * `flatten()` con los errores de las DOS ramas, que es ilegible para el formulario. Aquí cada error
 * cuelga de SU campo. (Hasta la HU #12080 lo compartían el alta y la subsanación; hoy lo usa solo
 * el alta, y el argumento del `flatten()` sigue en pie por sí solo.)
 *
 * Lo prohibido se rechaza además de exigir lo obligatorio (`razonSocial` con un `CC` es un 400, no
 * un campo que se ignora en silencio): la mitad negativa es la que el CHECK
 * `flito_compradores_titular_chk` respalda en la base, y las dos tienen que decir lo mismo o el
 * primer INSERT «válido» moriría con un 23514 y saldría como 500.
 *
 * ── Y la cota del DERIVADO, por el mismo argumento (bloqueante del `db-review-agent`) ────────────
 *
 * Ese párrafo de arriba vale igual para LONGITUDES que para el CHECK, y aquí faltaba. `nombres` y
 * `apellidos` son dos cotas INDEPENDIENTES de 200 que alimentan una columna de 200: el máximo
 * alcanzable es **401** (`200 + 1 + 200`), y `nombreCompletoDe()` concatena sin truncar. Los dos
 * destinos son `varchar(200)` —`flito_compradores.nombre_completo`, que además es NOT NULL, y
 * `vehicles.owner_name`—, así que un nombre partido que sume de más moría con
 * `22001 value too long` DENTRO de la transacción del alta: **500 y no 400**.
 *
 * Se acota el DERIVADO y no cada campo a 100, que era la otra salida: bajar los dos a 100 cerraría
 * el 401 por construcción, pero rechazaría un nombre de pila legítimo de 150 caracteres aunque el
 * apellido fuera corto y el total cupiera de sobra. Esto rechaza exactamente lo que no cabe.
 *
 * **No se trunca dentro de `nombreCompletoDe`**: dejaría la cola buscando sobre una cadena recortada
 * mientras el Excel publica los campos partidos completos — la divergencia silenciosa que esta HU
 * vino a cerrar. Y no se amplía la columna: sería otra migración sobre 7 052 filas para un dato que
 * solo es índice de búsqueda.
 *
 * Se llama a la MISMA función que deriva el nombre en el servicio, no a un `a.length + b.length + 1`
 * escrito aquí: el día que cambie el separador o el orden, la cota lo sigue sola.
 */
/** `flito_compradores.nombre_completo` y `vehicles.owner_name` son los dos `varchar(200)`. */
const MAX_NOMBRE_COMPLETO = 200;

function refinarTitular(
  d: { tipoDocumento: string; nombres?: unknown; apellidos?: unknown; razonSocial?: unknown },
  ctx: z.RefinementCtx,
): void {
  const juridica = d.tipoDocumento === 'NIT';
  const texto = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const nombres = texto(d.nombres);
  const apellidos = texto(d.apellidos);
  const razonSocial = texto(d.razonSocial);
  const error = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  if (juridica) {
    if (!razonSocial) error('razonSocial', 'La razón social es obligatoria cuando el documento es NIT');
    if (nombres) error('nombres', 'Un NIT no lleva nombres: usa la razón social');
    if (apellidos) error('apellidos', 'Un NIT no lleva apellidos: usa la razón social');
    return;
  }
  if (!nombres) error('nombres', 'Los nombres del propietario son obligatorios');
  if (!apellidos) error('apellidos', 'Los apellidos del propietario son obligatorios');
  if (razonSocial) error('razonSocial', 'Una persona natural no lleva razón social: usa nombres y apellidos');

  // El derivado tiene que caber en la columna. Cuelga de los DOS campos para que el formulario pueda
  // marcar los dos: el usuario acorta el que quiera, y ninguno de los dos es «el culpable».
  if (nombres && apellidos && nombreCompletoDe({ nombres, apellidos, razonSocial: null }).length > MAX_NOMBRE_COMPLETO) {
    const mensaje = `El nombre y los apellidos juntos no pueden pasar de ${MAX_NOMBRE_COMPLETO} caracteres.`;
    error('nombres', mensaje);
    error('apellidos', mensaje);
  }
}

/**
 * El mapa de procedencia, campo por campo (HU #12093, AC2).
 *
 * ── Se construye desde la constante compartida, y eso es media regla ────────────────────────────
 *
 * Las claves salen de `CAMPOS_COMPRADOR_FACTURA` —los nueve campos que el OCR de la factura extrae
 * del comprador (HU #12092)— y no de una lista escrita aquí. Con una copia local, el día que la
 * factura ganara un décimo campo el formulario podría declarar su procedencia y esta ruta la
 * rechazaría con un 400 que nadie sabría explicar. Los valores salen de `PROCEDENCIAS_DATO`, por lo
 * mismo.
 *
 * ── `.strict()`: un campo desconocido es 400 y no una clave que se cae en silencio ──────────────
 *
 * Zod descarta por omisión las claves que no declara, pero aquí el AC pide lo contrario: «un campo
 * o valor desconocido responde 400». Y tiene sentido que así sea: una clave de más en este mapa no
 * es ruido del formulario sobre un dato que la ruta no va a tocar, es una AFIRMACIÓN sobre un dato
 * del titular que se va a guardar. Aceptarla en silencio dejaría al front creyendo que declaró la
 * procedencia de `correo` cuando ese campo ni se lee de la factura.
 *
 * Cada campo es OPCIONAL: lo que no venga se completa con `manual` en el servicio (AC3). Es la
 * división de siempre en este router —el borde valida el vocabulario, el servicio deriva—, la misma
 * que separa `refinarTitular` de `nombreCompletoDe`.
 */
const procedenciaValorSchema = z.enum(PROCEDENCIAS_DATO).optional();

const procedenciaMapaSchema = z.object(
  // `fromEntries` y no un objeto literal con las nueve claves tecleadas: la lista es la compartida.
  // El tipo que Zod infiere de aquí es un índice `{ [k: string]: … }` en vez de las nueve claves
  // exactas —el precio de construir el shape en tiempo de ejecución—, y por eso el borde de salida
  // (la llamada a `crearSolicitud`) lo estrecha a `ProcedenciaCompradorPersistida`. Lo que decide
  // qué se acepta es el `.strict()` de abajo, que sí conoce las nueve claves porque se las dio esta
  // misma constante.
  Object.fromEntries(CAMPOS_COMPRADOR_FACTURA.map((campo) => [campo, procedenciaValorSchema])),
).strict();

/**
 * El alta viaja como `multipart/form-data`, así que el mapa llega como **una cadena JSON** en un
 * campo del formulario. Esto la parsea antes de validarla.
 *
 * Un JSON roto NO se convierte aquí en un `throw` ni en un `{}` silencioso: se devuelve el valor tal
 * como llegó —una cadena— y el schema de arriba lo rechaza, que es un `400 Datos inválidos` con su
 * `details` como cualquier otro campo del formulario. Tragárselo y guardar el mapa vacío sería
 * escribir «todo manual» sobre un alta cuyo formulario sí sabía la procedencia: el AC3 completa lo
 * que NO se declaró, no lo que se declaró mal.
 *
 * Ausente o cadena vacía → `undefined`, que es el alta sin procedencia del AC3 y es válida.
 */
const procedenciaCruda = (v: unknown): unknown => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return v;
  const texto = v.trim();
  if (texto === '') return undefined;
  try { return JSON.parse(texto); } catch { return v; }
};

const altaSchema = vehiculoSchema.merge(documentoSchema).extend(titularCampos).extend({
  procedencia: z.preprocess(procedenciaCruda, procedenciaMapaSchema.optional()),
}).superRefine(refinarTitular);

/**
 * POST /cliente — crear ES enviar (AC1). Sin borrador.
 *
 * `upload.single` corre DESPUÉS del rate limit a propósito: el limitador tiene que frenar antes de
 * que el proceso cargue 15 MB en memoria, no después.
 *
 * ── Del vehículo se teclea el VIN; del titular, todo (HU #12090, AC1) ───────────────────────────
 *
 * `placa` deja de ser entrada aquí igual que en la preconsulta, y por eso el `parsed.data` de esta
 * ruta ya no la tiene: la que se persiste en `vehicles.plate` es la que devolvió el RUNT (AC5).
 * `tipoDocumento` y `numeroDocumento` SÍ siguen —los pide `documentoSchema`— y no es una
 * inconsistencia con la preconsulta: allí eran un parámetro de consulta que la modalidad de VIN ya
 * no necesita, y aquí son el TITULAR que se guarda en `flito_compradores`.
 *
 * ── RN-B1: quien acredita la titularidad es la FACTURA, no el RUNT ──────────────────────────────
 *
 * Consultar el RUNT por VIN no dice nada sobre de quién es el vehículo (ver el docblock de
 * `/cliente/preconsulta`): cualquiera que conozca un VIN obtiene la ficha. Lo que sostiene que quien
 * radica puede radicar por ese vehículo es el PDF obligatorio de esta ruta —la factura de venta— y
 * la revisión de Operaciones sobre ella. Ni el 201 ni ninguna guarda de este archivo comprueban
 * titularidad, y confundir la compuerta del RUNT con esa comprobación es el error que este párrafo
 * existe para evitar.
 */
router.post('/cliente', CANAL_CLIENTE, soatClienteLimiter, upload.single('facturaVenta'), async (req: Request, res: Response) => {
  const parsed = altaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  if (!req.file) { res.status(400).json({ error: 'Falta la factura de venta (PDF)' }); return; }

  const { vin } = parsed.data;
  const archivo: ArchivoSolicitud = {
    originalname: req.file.originalname, mimetype: req.file.mimetype,
    buffer: req.file.buffer, size: req.file.size,
  };

  try {
    const ctx = await contextoSoat(req.user!);
    const creada = await crearSolicitud(
      {
        // Sin `placa`: la del alta es la que devuelve el RUNT (HU #12090, AC5), y `EntradaSolicitud`
        // ya no tiene dónde ponerla aunque el formulario la mande.
        vin, propietario: propietarioDe(parsed.data),
        // Lo declarado y nada más: completarlo es del servicio (`procedenciaCompleta`, AC3), que es
        // quien tiene que garantizar el mapa sin huecos ante CUALQUIER llamador y no solo ante esta
        // ruta. `?? null` y no `?? {}` para que «no vino» siga siendo distinguible aquí arriba.
        procedencia: (parsed.data.procedencia as ProcedenciaCompradorPersistida | undefined) ?? null,
      },
      archivo, ctx,
    );
    // **El rastro de PII que la HU #11966 devuelve a esta ruta.** Bajo la #11935 no hacía falta: el
    // alta no consultaba el RUNT dentro de la petición. Ahora sí —consulta un registro NACIONAL
    // sobre un vehículo que puede no ser de quien pregunta, y recibe datos del vehículo y a veces el
    // nombre del propietario—, que es exactamente el caso que el artículo 17 de la Ley 1581 quiere
    // poder reconstruir. Va con `motivo: 'alta'` para no confundirse con la preconsulta.
    //
    // `conPropietario: false`: a diferencia de la preconsulta, esta ruta NO devuelve el nombre que
    // trae el RUNT (el 201 es `{ id, estado }`). Declararlo sería declarar de más, que ya fue un
    // bloqueante en este módulo.
    //
    // El VIN es el TECLEADO —misma expresión que en la preconsulta, ver allí por qué son el mismo
    // valor— y la placa es la que devolvió el RUNT, que llega en `creada.placa` porque no hay otra
    // fuente: es el dato que esta misma HU convirtió en salida.
    await registrarAccesoRuntCliente(req, {
      vin, placa: creada.placa, conPropietario: false, motivo: 'alta',
    });
    // El `detail` NO lleva placa, VIN ni documento, y no es una omisión: `audit_logs` es una tabla
    // append-only que se exporta y se lee entera, y el patrón contrario ya existe en el repo
    // (`runt.routes.ts` escribe la placa en su bitácora). El `resourceId` es el uuid del SOAT, que
    // es opaco y basta para reconstruir el caso desde la fila.
    //
    // **Desde la HU #12078 dice además A QUÉ DESTINO fue** (AC7): el uuid del gestor, o que la
    // asumió Operaciones por contingencia. Sin eso, la bitácora no puede reconstruir a dónde se
    // despachó una solicitud que ya nadie valida a mano. El uuid de un proveedor no es dato
    // personal —es una aseguradora— y por eso sí puede vivir en una tabla que se exporta entera.
    const destino = creada.destino.gestionOperaciones
      ? 'gestion_operaciones'
      : `proveedor=${creada.destino.proveedorSoatId}`;
    await audit(req, {
      action: 'create', resource: 'flito_soat', resourceId: creada.id,
      detail: `Alta de solicitud SOAT del canal Cliente (origen=cliente, estado=${creada.estado}, destino=${destino})`,
    });
    // **Proyección explícita, y no `json(creada)`.** `crearSolicitud` devuelve también el destino
    // —lo necesita el `audit()` de arriba—, y devolver el objeto entero le contaría al CLIENTE a qué
    // aseguradora despachó su compañía: eso no es asunto suyo, y el AC1 dice `{ id, estado }`. Es el
    // mismo patrón que mordió en la HU #12093 con el `.returning()` sin proyección.
    res.status(201).json({ id: creada.id, estado: creada.estado });
  } catch (e) {
    await registrarIntentoRunt(req, vin, e, 'alta');
    manejarError(res, e);
  }
});

/**
 * El titular del cuerpo validado al que espera el servicio, con la partición ya resuelta.
 *
 * La usaban el alta y la subsanación; desde la HU #12080 solo queda el alta. `null` explícito y no
 * `undefined` porque lo que llega a `flito_compradores` tiene que poder escribir la ausencia de
 * razón social de una persona natural, y no dejar la columna «como estuviera».
 */
function propietarioDe(d: {
  tipoDocumento: TipoDocumentoRunt; numeroDocumento: string;
  nombres?: unknown; apellidos?: unknown; razonSocial?: unknown;
  correo: string; celular: string; direccion: string; municipio: string; departamento: string;
}): PropietarioSolicitud {
  const texto = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  return {
    tipoDocumento: d.tipoDocumento,
    numeroDocumento: d.numeroDocumento,
    nombres: texto(d.nombres),
    apellidos: texto(d.apellidos),
    razonSocial: texto(d.razonSocial),
    correo: d.correo,
    celular: d.celular,
    direccion: d.direccion,
    municipio: d.municipio,
    departamento: d.departamento,
  };
}

/**
 * El cuerpo de la lectura: **nada obligatorio salvo el adjunto**, y el `solicitudId` OPCIONAL.
 *
 * Era opcional porque la lectura servía en los DOS momentos del canal: durante el ALTA, cuando la
 * solicitud todavía no existe y no hay uuid que dar, y durante la SUBSANACIÓN, cuando sí lo había y
 * el registro de acceso tenía que poder decir sobre qué caso se leyó (AC7). **La subsanación se
 * retira con la HU #12080, así que hoy ningún llamador manda el campo.** Se conserva —opcional y
 * validado como uuid— en vez de borrarlo: quitarlo obligaría a cambiar el contrato de la ruta y a
 * tocar `registrarLecturaFacturaCliente`, que sigue queriendo saber «sobre qué caso» cuando lo hay,
 * y el día que una lectura vuelva a ocurrir sobre una solicitud existente el rastro de PII ya está
 * escrito. Un campo opcional que nadie manda vale `null` y no cambia ninguna respuesta.
 *
 * Va en el CUERPO del multipart y no como `:id` ni como query: es el mismo criterio con el que la
 * preconsulta es un `POST` —AGENTS.md §14, nada identificable en la URL—. El uuid es opaco y ahí
 * estaría permitido, pero ponerlo en la ruta obligaría a un patrón nuevo en la allowlist del canal y
 * a que la lectura del alta (sin uuid) tuviera OTRA ruta distinta. Una sola ruta, un solo `porque`.
 */
const lecturaFacturaSchema = z.object({
  solicitudId: z.preprocess(
    vacioANull,
    z.string().uuid('El identificador de la solicitud no es válido').nullable().optional(),
  ),
});

/**
 * POST /cliente/factura/lectura — el OCR lee el COMPRADOR de la factura de venta (HU #12092, AC6).
 *
 * Devuelve la extracción y **no persiste ni archiva nada**: ni objeto en storage, ni fila en
 * `flito_soportes`, ni soporte, ni solicitud. El buffer muere con la petición. Es un PRELLENADO del
 * formulario, y por eso cada campo viaja con su confianza y su `confiable`: quien decide qué hacer
 * con un dato bajo umbral es la persona que ve el formulario, no esta ruta.
 *
 * **El orden de los middlewares es el del AC6 de la HU #12092** (el AC6 de la #12214 es otro: el del
 * 429 upstream): el limitador va DELANTE de `upload.single` para que el freno actúe antes de que el
 * proceso cargue 15 MB en memoria, no después. Invertirlos —que es lo
 * cómodo si algún día hace falta mirar el cuerpo para decidir— convertiría el rate limit en un
 * contador que se aplica cuando el daño ya está hecho.
 *
 * **Y desde la HU #12214 el limitador es `soatLecturaFacturaLimiter` y NO `soatClienteLimiter`.** La
 * ruta sale del contador compartido del canal y se queda solo con el suyo (12/15min/usuario); no va
 * anidada como la preconsulta, y esa asimetría es la HU entera. La preconsulta se anida porque lo que
 * se busca es un techo MÁS BAJO dentro de los 20; aquí se busca lo contrario, que releer la factura
 * NO le quite presupuesto al envío de la misma solicitud que se está prellenando. Anidarla dejaría
 * ese gasto intacto.
 *
 * No es un descuento de seguridad: el freno sigue puesto y sigue delante de multer. Lo que cambia es
 * de qué bolsillo sale. Esta ruta no consulta el RUNT ni escribe una fila, así que no participa de la
 * cosecha que el contador compartido raciona —el razonamiento está entero en el docblock de
 * `soatClienteLimiter`—; lo suyo es coste por byte contra un encargado externo, y eso se raciona en
 * su propio contador.
 *
 * **Tres segmentos, sin colisión**: los patrones vecinos son `/cliente` y `/cliente/preconsulta`, de
 * uno y dos segmentos, así que ninguno casa con esta ruta.
 *
 * La respuesta va ENVUELTA en `{ extraccion }` y no plana: deja sitio para metadatos —el umbral
 * aplicado, por ejemplo— sin romper al front el día que hagan falta.
 *
 * **Ningún valor leído se escribe en los logs** (AC7): ni `audit()` —esto no cambia nada, y la
 * bitácora de este módulo responde «quién CAMBIÓ qué»— ni un `log.debug` con el JSON extraído. Lo que
 * queda escrito es una línea en `pii_access_log`: quién, cuándo, qué columnas y sobre qué solicitud.
 */
router.post(
  '/cliente/factura/lectura',
  CANAL_CLIENTE, soatLecturaFacturaLimiter, upload.single('facturaVenta'),
  async (req: Request, res: Response) => {
    const parsed = lecturaFacturaSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
    if (!req.file) { res.status(400).json({ error: 'Falta la factura de venta (PDF)' }); return; }

    const archivo: ArchivoSolicitud = {
      originalname: req.file.originalname, mimetype: req.file.mimetype,
      buffer: req.file.buffer, size: req.file.size,
    };
    const solicitudId = parsed.data.solicitudId ?? null;

    try {
      const ctx = await contextoSoat(req.user!);
      const extraccion = await leerFacturaVenta(archivo, ctx, solicitudId);
      // Después de la extracción y no antes: lo que se registra es que los datos personales SE
      // ENTREGARON. Una lectura que acabó en 503 no accedió a nada de nadie.
      await registrarLecturaFacturaCliente(req, { solicitudId });
      res.json({ extraccion });
    } catch (e) { manejarError(res, e); }
  },
);

export default router;
