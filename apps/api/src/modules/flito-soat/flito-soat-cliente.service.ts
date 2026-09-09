// FLITO — SOAT, canal Cliente (lógica). Feature #11912, HU #11914 (alta), #11935 (alta sin RUNT
// bloqueante), #11966 (el RUNT vuelve a ser compuerta) y #12080 (Feature #12074: se retira la
// revisión de Operaciones).
// Diseño y tradeoffs: docs/adr/ADR-0008-flito-soat-canal-cliente.md (satélite, RN-01, no crudo)
// y docs/adr/ADR-0010-flito-soat-runt-compuerta-alta.md, que SUPERSEDE al ADR-0009.
//
// ── Qué hace ─────────────────────────────────────────────────────────────────────────────────────
//
// La SEGUNDA puerta de `flito_soat`. Hasta hoy toda fila nacía en `resolverSoat()`, dentro del sync
// de trámites de FLIT; aquí la abre un usuario `cliente` de una compañía con el flag «SOAT sin
// trámite» encendido, para un vehículo que NO tiene trámite digital. La fila nace con
// `origen = 'cliente'`.
//
// ── Desde la HU #12078 (Feature #12074) el alta DESPACHA, y ya no espera revisión ───────────────
//
// La fila nacía en `pendiente_revision` y solo `POST /:id/validar` la llevaba a `solicitado`. Ahora
// nace en `solicitado` con el DESTINO ya escrito en el mismo INSERT, y el destino sale del gestor
// por defecto que Operaciones configura POR COMPAÑÍA (`clients.flito_proveedor_soat_sin_tramite_id`,
// migración 0175). Sin ámbitos y sin prioridades: una compañía, un destino, una sola consulta
// (`resolverDestinoCanalCliente`). El gestor la ve sin que nadie la valide, porque
// `ESTADOS_SOAT_VISIBLES_GESTOR` ya contiene `solicitado`.
//
// **El SOAT POR TRÁMITE no cambia** (límite del PO, 2026-09-05): Operaciones sigue eligiendo gestor
// en cada `POST /flito/soat/enviar`, y ni esa ruta ni `enviarAlGestor()` leen esa columna.
//
// ── Y desde la HU #12080 el circuito de revisión NO EXISTE ───────────────────────────────────────
//
// `pendiente_revision` y `rechazada` sobrevivieron a la #12078 porque quedaban las transiciones y
// las filas radicadas bajo la regla anterior. Esta HU las retira del tipo de Postgres (migración
// 0176, que ABORTA si queda alguna fila en ellos) y borra de este archivo `validarSolicitud`,
// `rechazarSolicitud`, `subsanarSolicitud` y `listarCausalesRechazo`, con los helpers que solo
// ellas usaban (`solicitudEnEstado`, `moverEstado`, `carreraPerdida`). Lo que queda aquí es el
// ALTA y nada más.
//
// ── Por qué es un archivo aparte y no crece `flito-soat.service.ts` ─────────────────────────────
//
// `max-lines` es `error` y bloquea CI: ese archivo tiene el techo congelado en 1090 líneas
// efectivas y mide ~760. El canal entero no cabe, y partirlo por la mitad sería peor que separarlo
// entero (ADR-0008 §7). Lo que SÍ se comparte es la puerta de acceso: `SoatCtx`, `contextoSoat()` y
// `buscarConAcceso()` viven allí y este módulo los importa — un endpoint del canal que se saltara
// esa puerta se saltaría el aislamiento por compañía.
//
// ── El ciclo completo del canal, y dónde acaba ───────────────────────────────────────────────────
//
//   POST /cliente  (#11914, #12078) — nace en `solicitado`, con destino resuelto. Y se acabó.
//
// De ahí en adelante el SOAT es indistinguible de uno nacido de trámite: `solicitado → pagado` por
// el OCR de la factura (RN-03) es la vía de siempre y no la toca nadie de aquí. El canal Cliente
// tiene, desde la #12080, exactamente UNA transición propia: la que crea la fila.
//
// ── Lo que este módulo NO hace ───────────────────────────────────────────────────────────────────
//
// No toca el ciclo del SOAT nacido de TRÁMITE, que sigue exactamente igual. Ya no hace falta
// defenderlo con un guarda de `origen = 'cliente'` en cada transición —no quedan transiciones que
// guardar—: lo único que este módulo escribe sobre una fila ajena es nada, porque solo inserta.
//
// El payload crudo del RUNT no se persiste (ADR-0008 §1.6, conservado por ADR-0010).
//
// ── El RUNT es COMPUERTA del alta otra vez (HU #11966, ADR-0010) ────────────────────────────────
//
// Se guardan solo los campos DERIVADOS, y se guardan DENTRO de la transacción del alta: marca,
// línea, año, clase, cilindraje, servicio, carrocería, pasajeros y puertas salen del RUNT y el
// organismo se escribe si el nombre que reporta cruza el catálogo. Los dos endpoints del canal
// —`POST /cliente/preconsulta` y `POST /cliente`— llaman a la MISMA compuerta
// (`verificarRuntCompuerta`) y devuelven exactamente lo mismo ante la misma respuesta de Kyverum:
// 503 si no respondió, 422 si respondió que no, 409 si el vehículo ya tiene SOAT vigente. Dos copias
// de esa decisión divergen y el wizard acaba bloqueando lo que la API acepta.
//
// **El organismo NO es compuerta** (AC5): si el nombre no cruza catálogo, `organismo_codigo` queda
// NULL, el satélite anota `organismo_no_catalogado` y la fila SE CREA. El
// `422 organismo_no_catalogado` desapareció de los dos endpoints.
//
// Lo que la #11935 dejó y esta HU no toca: las solicitudes radicadas bajo aquella regla conservan su
// `verificacion_estado` tal como está. Cero UPDATE sobre ellas (AC6).
//
// ── Y desde la HU #12090 la compuerta se abre CON EL VIN, no con la placa ───────────────────────
//
// El vehículo se identifica por VIN y nada más. Placa, tipo y número de documento del propietario
// dejan de ser entrada del vehículo: la placa pasa a ser un dato DEVUELTO por el RUNT —y es la que
// se escribe en `vehicles.plate`— y el documento deja de viajar al registro nacional, porque la
// modalidad de VIN no lo pide. El titular se sigue tecleando entero (es lo que va a
// `flito_compradores`), pero ya no sirve para interrogar al RUNT.
//
// **Consultar por VIN NO acredita al titular** (RN-B1). La consulta por documento sí lo hacía de
// rebote: el RUNT solo respondía si ese documento figuraba entre los propietarios activos, y ese
// «no» era una comprobación de titularidad que salía gratis. Con el VIN no hay tal cosa: cualquiera
// que conozca un VIN obtiene la ficha. Lo que acredita que quien radica puede radicar por ese
// vehículo es **la factura de venta adjunta**, que es obligatoria y es lo que Operaciones revisa.

import { createHash, randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs,
  clients,
  flitoCompradores,
  flitoProveedoresSoat,
  flitoSoat,
  flitoSoatSolicitud,
  flitoSoportes,
  organismosTransitoConfig,
  vehicles,
} from '../../db/schema.js';
import {
  CAMPOS_COMPRADOR_FACTURA,
  CodigoErrorSolicitudSoat,
  EstadoSoat,
  type ExtraccionFacturaVenta,
  PROCEDENCIA_POR_DEFECTO,
  type ProcedenciaComprador,
  type ProcedenciaCompradorPersistida,
  TipoSoporte,
  type TipoDocumentoRunt,
} from '@operaciones/shared-types';
import { ConceptoHistorial, registrarCambio } from '../../shared/historial/estado-historial.js';
import { extraerFacturaVenta } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { detectMime } from '../pesv/magic-number.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { buscarConAcceso, ORIGEN_CLIENTE, type SoatCtx } from './flito-soat.service.js';
import {
  consultarYClasificar,
  type CodigoRevise,
  type DatosRuntCanal,
} from './flito-soat-cliente-runt.js';

export {
  extraerDatosCanal,
  fechaVencimientoSoatRunt,
  soatVigenteSegunRunt,
  type DatosRuntCanal,
} from './flito-soat-cliente-runt.js';

/**
 * Error del canal con CÓDIGO además de estado HTTP.
 *
 * El estado solo no alcanza: los AC2, AC3 y AC4 piden tres desenlaces distintos que el formulario
 * tiene que poder separar —reintentar, pintar el modal de «ya tiene SOAT vigente», o mandar al
 * detalle de la solicitud que ya existe— y dos de ellos son `409`. Separarlos comparando el TEXTO
 * del mensaje es lo que se rompe la próxima vez que alguien corrija una tilde, así que el código va
 * en el cuerpo y es una constante de shared-types.
 */
export class SolicitudSoatError extends Error {
  constructor(
    readonly status: number,
    readonly codigo: CodigoErrorSolicitudSoat,
    message: string,
    /**
     * Lo que la pantalla necesita ADEMÁS del código, y que la ruta serializa junto al mensaje.
     *
     * Existe por un solo caso y conviene que no crezca sin pensarlo: el 409 de RN-01 tiene que poder
     * decir «esa solicitud es TUYA, ábrela» sin decirle a nadie nada de una solicitud ajena. Todo lo
     * que entre aquí sale al cliente, así que entra dato por dato y con su motivo.
     */
    readonly datos?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SolicitudSoatError';
  }
}

const fallo = (status: number, codigo: CodigoErrorSolicitudSoat, mensaje: string, datos?: Record<string, unknown>) =>
  new SolicitudSoatError(status, codigo, mensaje, datos);

/**
 * ¿Este desenlace **afirma algo sobre el VEHÍCULO** identificado por el VIN? (ADR-0012 §8.2).
 *
 * Es el criterio que decide si un intento fallido deja línea en `pii_access_log`, y vive aquí
 * —junto a los `fallo()` que crean cada error— y no en el router: quien estrene un desenlace tiene
 * que clasificarlo en el mismo sitio donde lo escribe.
 *
 * ── Por qué un `Record` TOTAL y no una lista de códigos ─────────────────────────────────────────
 *
 * Una lista (`[409, 422, 503]`, o un `Set` de códigos) deriva en silencio: el día que alguien añada
 * un desenlace, la lista sigue compilando y el código nuevo cae por omisión del lado que le tocara
 * — y si ese lado es «sí», se estrena un evento sobredeclarado en una tabla con seis años de
 * retención. Un `Record<CodigoErrorSolicitudSoat, boolean>` es TOTAL: añadir un miembro al enum de
 * `shared-types` **rompe el build** hasta que alguien decida qué es. El criterio deja de depender de
 * que alguien se acuerde.
 *
 * ── Qué es «hablar del vehículo», y por qué NO es «se consultó el RUNT» ─────────────────────────
 *
 * El criterio no puede ser si la petición llegó a hablar con Kyverum: `vin_ya_tiene_soat` corta
 * ANTES de la compuerta —lo produce `verificarRn01` con su lectura barata— y es justamente el
 * desenlace que más interesa ver repetido, porque un 409 confirma que ESE VIN está en FLITO. Es una
 * divulgación pequeña pero real sobre cartera ajena, y enumerando es señal.
 *
 * El criterio es: **¿la respuesta habría sido distinta con otro VIN?** Si sí, la línea describe una
 * pregunta sobre un vehículo concreto y el titular de ese vehículo tiene derecho a verla (art. 17).
 * Si no —`sin_compania`, `canal_desactivado`, `archivo_no_pdf`—, la respuesta habla del LLAMANTE o
 * de su adjunto, es idéntica para cualquier VIN, y escribirla sería declarar el acceso a datos de un
 * tercero por el que nadie llegó a preguntar. Es la misma clase de mentira que esta HU vino a cerrar
 * en `campos_accedidos`, un nivel más arriba: allí un CAMPO sobredeclarado, aquí un EVENTO.
 */
export const DESENLACE_HABLA_DEL_VEHICULO: Record<CodigoErrorSolicitudSoat, boolean> = {
  // ── Sí: la respuesta depende del VIN que se preguntó ──────────────────────────────────────────
  /** El RUNT no respondió A ESTA consulta. Es el intento que un sondeo repite mientras la pasarela va mal. */
  [CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE]: true,
  /** El registro nacional dice que no conoce ese VIN. */
  [CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO]: true,
  /** El VIN tecleado no coincide con el que el registro tiene para ese vehículo. */
  [CodigoErrorSolicitudSoat.RUNT_NO_CUADRA]: true,
  /** El registro tiene el vehículo y no publica su VIN: afirma que EXISTE. */
  [CodigoErrorSolicitudSoat.RUNT_SIN_VIN]: true,
  /** El RUNT reporta SOAT vigente para ese vehículo. */
  [CodigoErrorSolicitudSoat.SOAT_VIGENTE]: true,
  /** Ese VIN ya está en FLITO: el 409 que confirma cartera, propia o ajena. */
  [CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT]: true,

  // ── No: la respuesta es la misma para cualquier VIN ───────────────────────────────────────────
  /** Del USUARIO: no tiene compañía. No se llegó a mirar ningún vehículo. */
  [CodigoErrorSolicitudSoat.SIN_COMPANIA]: false,
  /** De la COMPAÑÍA: el canal está apagado. Ídem. */
  [CodigoErrorSolicitudSoat.CANAL_DESACTIVADO]: false,
  /** Del ADJUNTO: los bytes no son un PDF. Corta antes de mirar nada del vehículo. */
  [CodigoErrorSolicitudSoat.ARCHIVO_NO_PDF]: false,
  /** De la SOLICITUD pedida, no de un vehículo: lo produce la lectura de factura con `solicitudId`. */
  [CodigoErrorSolicitudSoat.SOLICITUD_NO_ENCONTRADA]: false,

  // ── No, y además hoy inalcanzables por estas dos rutas ────────────────────────────────────────
  //
  // Sobrevivientes del circuito de revisión que la HU #12080 retiró, más el del satélite. Se
  // clasifican igual porque el `Record` es total, y el día que alguno vuelva la decisión ya está
  // tomada donde se ve. Ninguno depende del VIN preguntado.
  [CodigoErrorSolicitudSoat.ORGANISMO_NO_CATALOGADO]: false,
  [CodigoErrorSolicitudSoat.NO_ES_DEL_CANAL]: false,
  [CodigoErrorSolicitudSoat.ESTADO_NO_PERMITE]: false,
  [CodigoErrorSolicitudSoat.CAUSAL_INVALIDA]: false,
  [CodigoErrorSolicitudSoat.OBSERVACION_REQUERIDA]: false,
  [CodigoErrorSolicitudSoat.DESTINO_REQUERIDO]: false,
};

// ───────────────────────────── Entrada ──────────────────────────────────────

/**
 * El titular tal como lo teclea el Cliente, **partido** (HU #11966, AC5).
 *
 * `nombres`/`apellidos` XOR `razonSocial`: lo impone Zod en la ruta (una sola puerta de escritura) y
 * lo respalda `flito_compradores_titular_chk` en la base. `nombreCompleto` **no está y no puede
 * estar**: es un DERIVADO (`nombreCompletoDe`) que alimenta la búsqueda de la cola. Aceptarlo del
 * cliente dejaría dos fuentes de verdad para el mismo nombre, y la que se enseña en el Excel (los
 * campos partidos) podría contradecir a la que se busca en la cola.
 *
 * Contacto y ubicación son OBLIGATORIOS para este canal (AC5) aunque las columnas sigan nullable en
 * la tabla: la nulabilidad la necesitan las filas de trámite, que llegan sin contacto.
 */
export interface PropietarioSolicitud {
  tipoDocumento: TipoDocumentoRunt;
  numeroDocumento: string;
  /** Persona natural. `null` cuando el tipo es `NIT`. */
  nombres: string | null;
  apellidos: string | null;
  /** Persona jurídica. `null` cuando el tipo NO es `NIT`. */
  razonSocial: string | null;
  correo: string;
  celular: string;
  direccion: string;
  /** Municipio y departamento del DOMICILIO del titular, no del organismo (AC5). */
  municipio: string;
  departamento: string;
}

/**
 * El nombre en una cadena, para `flito_compradores.nombre_completo`.
 *
 * Es lo que interroga la búsqueda de la cola (`condicionesCola`), que compara contra
 * `nombre_completo` y no contra los campos partidos. Se deriva aquí —una función, un sitio— y el
 * alta escribe LAS DOS cosas: los campos partidos y el derivado. Escribir solo uno dejaría el Excel
 * publicando un nombre y la cola buscando por otro, que es la divergencia silenciosa que esta
 * función existe para cerrar. (Hasta la HU #12080 la compartía con la subsanación, que ya no está;
 * el argumento no dependía de haber dos llamadores.)
 */
export function nombreCompletoDe(p: Pick<PropietarioSolicitud, 'nombres' | 'apellidos' | 'razonSocial'>): string {
  if (p.razonSocial) return p.razonSocial.trim();
  return [p.nombres, p.apellidos].filter((x): x is string => !!x && x.trim() !== '')
    .map((x) => x.trim()).join(' ');
}

export interface EntradaSolicitud {
  /**
   * **Lo ÚNICO que se teclea del vehículo** (HU #12090, AC1). Era opcional bajo la #11966 y ahora es
   * la clave de la consulta: el RUNT se interroga por VIN y devuelve todo lo demás, la placa
   * incluida. Por eso `placa` desapareció de esta interfaz en vez de quedarse «por compatibilidad»:
   * mientras el campo existiera, cualquier llamador podría volver a escribir en `vehicles.plate` un
   * valor que nadie confirmó.
   */
  vin: string;
  propietario: PropietarioSolicitud;
  /**
   * De dónde salió cada dato del propietario (HU #12093, AC2). Puede venir INCOMPLETO o no venir:
   * lo que falte se completa con `manual` (AC3, {@link procedenciaCompleta}).
   *
   * Va aquí y NO dentro de `PropietarioSolicitud`, y esa colocación sigue siendo una decisión
   * aunque desde la HU #12080 el alta sea su único llamador: `PropietarioSolicitud` describe QUIÉN
   * es el titular, y de dónde salió cada dato es una afirmación sobre CÓMO se llenó este
   * formulario. Aquí, el tipo dice sin ambigüedad que este dato es del ALTA.
   *
   * El vocabulario lo valida Zod en la ruta —campo desconocido o valor fuera de los tres: 400— y no
   * aquí: es una regla del borde, igual que `refinarTitular`.
   */
  procedencia: ProcedenciaCompradorPersistida | null;
}

/**
 * El mapa COMPLETO que se persiste: lo declarado, y `manual` en todo lo demás (AC3).
 *
 * ── Por qué se completa y no se guarda tal cual llegó ───────────────────────────────────────────
 *
 * «Nunca nulos ni ausentes» es el AC entero. Un mapa a medias obligaría a cada lector a decidir por
 * su cuenta qué significa una clave ausente, y la primera pantalla que decidiera «ausente = leído de
 * la factura» estaría afirmando de un dato TECLEADO que lo puso el concesionario — que es justo la
 * pregunta que esta HU existe para responder.
 *
 * ── Y por qué el defecto es `manual` y no un cuarto valor «desconocido» ─────────────────────────
 *
 * Porque `manual` es lo CIERTO, no lo cómodo: al alta no se llega por ninguna vía que no sea el
 * formulario, así que un campo que llegó sin declarar procedencia lo escribió una persona. Un
 * «desconocido» añadiría un estado que ninguna pantalla sabría pintar y que el revisor tendría que
 * interpretar igual.
 *
 * Se recorre `CAMPOS_COMPRADOR_FACTURA` —la constante compartida— y no una lista escrita aquí: el
 * día que la factura gane un décimo campo del comprador, el mapa lo gana en el mismo cambio. Con una
 * copia local, ese campo se persistiría ausente para siempre y en verde.
 */
export function procedenciaCompleta(declarada: ProcedenciaCompradorPersistida | null | undefined): ProcedenciaComprador {
  const completa = {} as ProcedenciaComprador;
  for (const campo of CAMPOS_COMPRADOR_FACTURA) {
    completa[campo] = declarada?.[campo] ?? PROCEDENCIA_POR_DEFECTO;
  }
  return completa;
}

/** El adjunto, con la misma forma que `ArchivoSubido` del módulo hermano. */
export interface ArchivoSolicitud {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/**
 * Mayúsculas y solo alfanuméricos, igual que `runt.service.ts` normaliza lo que consulta.
 *
 * **Se EXPORTA desde la HU #12090, y ese export es una corrección de seguridad, no una comodidad**
 * (bloqueante 1 de la auditoría). El borde valida la longitud del VIN y esta función decide lo que
 * de verdad sale hacia Kyverum y hacia las dos guardas: si el borde midiera sobre una cadena y esto
 * produjera otra, el piso no valdría lo que dice — `'A-B-C'` pasa un `trim()` con CINCO caracteres y
 * sale de aquí con TRES. Miden lo mismo porque es la MISMA función, y por eso el router la comparte
 * en vez de escribir su propia normalización «equivalente», que es como se separan dos reglas que
 * tenían que ser una.
 *
 * Se sigue llamando también aquí dentro, y no sobra: es idempotente, y `preconsulta`/`crearSolicitud`
 * son funciones exportadas cuyo contrato no puede depender de que quien llame haya normalizado.
 */
export const normalizarId = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

// ───────────────────────────── Guardas del alta ─────────────────────────────

/** La compañía del `cliente`, con el flag del canal y la carpeta de storage ya resueltos. */
interface CanalCompania {
  companiaId: number;
  carpetaStorage: string | null;
}

/**
 * Las dos guardas que preceden a todo lo demás: el usuario tiene compañía y esa compañía tiene el
 * canal encendido (AC5).
 *
 * `ctx.companiaId` sale de `contextoSoat()`, que lo lee de la BASE en cada petición y no del JWT
 * (§3 del ADR): mover a alguien de compañía surte efecto sin re-emitirle el token. Que falte es el
 * usuario que el CHECK `users_cliente_compania_chk` ya no debería permitir; aquí es un 403 y no un
 * 500, y sobre todo no es «pasa».
 */
async function canalDeLaCompania(ctx: SoatCtx): Promise<CanalCompania> {
  if (!ctx.companiaId) {
    throw fallo(403, CodigoErrorSolicitudSoat.SIN_COMPANIA,
      'Tu usuario no tiene una compañía asignada, así que no puede radicar solicitudes.');
  }
  const [compania] = await db
    .select({ id: clients.id, sinTramite: clients.soatSinTramite, carpeta: clients.flitoCarpetaStorage })
    .from(clients).where(eq(clients.id, ctx.companiaId)).limit(1);

  // Sin fila y con el flag apagado son el mismo desenlace y el mismo mensaje a propósito: los dos
  // significan «esta compañía no tiene abierto el canal», y distinguirlos solo le diría a quien
  // sondea si su compañía existe.
  if (!compania?.sinTramite) {
    throw fallo(403, CodigoErrorSolicitudSoat.CANAL_DESACTIVADO,
      'Tu compañía no tiene habilitada la solicitud de SOAT sin trámite. Contacta a FLITO para activarla.');
  }
  return { companiaId: compania.id, carpetaStorage: compania.carpeta };
}

/**
 * RN-01, comprobada ANTES de consultar el RUNT y antes de subir nada (AC4).
 *
 * `flito_soat.vin` es NOT NULL UNIQUE, así que la última línea de defensa es la base y no esto —y
 * por eso el INSERT también atrapa el 23505—. Esta consulta existe para dar el mensaje útil: quien
 * radica tiene que saber que el vehículo YA tiene una solicitud y que no se crea una segunda.
 *
 * ── Un solo mensaje desde la HU #12080 ──────────────────────────────────────────────────────────
 *
 * Había una rama para el estado `rechazada` que mandaba a subsanar la misma fila. Ese estado ya no
 * existe (Feature #12074, migración 0176), así que la rama se va: mantenerla sería una condición
 * que ningún dato puede cumplir, y el día que alguien la leyera creería que la subsanación existe.
 *
 * ── El 409 va RECORTADO cuando la fila es de otra compañía, y eso es una frontera ───────────────
 *
 * Un `cliente` puede sondear VINs: son 17 caracteres, pero los de una flota son consecutivos. Si la
 * respuesta contara el estado, cada intento respondería una pregunta sobre la cartera de OTRA
 * compañía, que es exactamente la fuga que el aislamiento de la HU #11913 pasó dos rondas cerrando.
 * Así que:
 *
 *   · fila de SU compañía → `propia: true` + `id` + `estado`, para que pueda abrir la suya. Es
 *     información que ya podía ver en su cola.
 *   · fila de otra        → `propia: false`, sin id, sin estado y con un texto que solo dice que ese
 *     vehículo ya está en FLITO. Ni siquiera se le dice de quién es.
 *
 * El bloqueo es el MISMO en los dos casos: RN-01 no se relaja por no ser suya.
 */
async function verificarRn01(vin: string, companiaId: number): Promise<void> {
  const [existente] = await db
    .select({ id: flitoSoat.id, estado: flitoSoat.estado, companiaId: flitoSoat.companiaId })
    .from(flitoSoat).where(eq(flitoSoat.vin, vin)).limit(1);
  if (!existente) return;

  // Mismo código, mismo cuerpo recortado y MISMO TEXTO que el vehículo ajeno sin SOAT: los dos son
  // «no es de su compañía» y distinguirlos sería contarle cuál de los dos es.
  if (existente.companiaId !== companiaId) throw vehiculoAjeno();

  throw fallo(409, CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT,
    'Este vehículo ya tiene un SOAT en FLITO. Un vehículo no puede tener dos (RN-01).',
    { propia: true, id: existente.id, estado: existente.estado });
}

/**
 * Lo ÚNICO que se le dice a quien radica sobre un vehículo que no es de su compañía.
 *
 * Es el MISMO texto para los dos casos que lo producen —el VIN ya tiene SOAT de otra compañía, y el
 * VIN ya tiene ficha en `vehicles` a nombre de otra compañía— y eso es deliberado: si cada uno
 * tuviera su frase, dos intentos distinguirían «ese vehículo tiene SOAT» de «ese vehículo existe sin
 * SOAT», que es información sobre la cartera ajena obtenida a fuerza de sondear VINs. Un solo texto
 * y un solo código los vuelve indistinguibles.
 */
const MENSAJE_VEHICULO_AJENO =
  'Este vehículo ya está registrado en FLITO y no figura a nombre de su compañía. Si es suyo, escríbanos para revisarlo.';

const vehiculoAjeno = () => fallo(
  409, CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT, MENSAJE_VEHICULO_AJENO, { propia: false },
);

/**
 * ¿Esta ficha de `vehicles` es de OTRA compañía?
 *
 * ── El agujero que cierra, que NO lo tapaba la RN-01 ────────────────────────────────────────────
 *
 * `verificarRn01` mira `flito_soat.vin`; esto mira `vehicles.vin`, y son conjuntos distintos: un
 * vehículo puede existir en `vehicles` SIN fila en `flito_soat`, y de hecho es el caso mayoritario
 * —`upsertVehiculo()` del sync corre para todos los trámites, mientras que `resolverSoat()` solo
 * corre con el trámite asignado y con compañía y organismo emparejados—. Para uno de esos VIN, la
 * RN-01 no encuentra nada y el UNIQUE de `flito_soat.vehiculo_id` tampoco salta, porque el vehículo
 * ajeno no tiene SOAT: sin esta comprobación, el alta hacía UPDATE sobre la ficha de otra compañía y
 * le sobrescribía titular, cédula, placa, marca, línea, año y clase con lo que teclea quien radica.
 *
 * `clientId` vacío NO es ajeno: ver la decisión escrita en `upsertVehiculoRunt`.
 *
 * Un solo predicado para las dos llamadas —la previa y la de dentro de la transacción— para que
 * quien lo cambie no pueda cambiarlo en un sitio y olvidarse del otro.
 *
 * ── Por qué `!= null` y no `!== null` ───────────────────────────────────────────────────────────
 *
 * Comparación LAXA a propósito: cubre `null` y `undefined` con la misma regla, porque aquí los dos
 * significan lo mismo —«nadie reclama esta ficha»— y tratarlos distinto no tiene sentido en el
 * dominio. En producción la diferencia no existe (el `select` proyecta la columna y PostgreSQL
 * devuelve `null`), pero fuera de producción sí: el doble de drizzle del repo devuelve la fila
 * ENTERA que el test registró, sin recortarla a las claves del `select`, así que una fila de prueba
 * sin `clientId` llega con `undefined`. Con el estricto, esa fila se clasificaba como AJENA y el
 * alta se cortaba con un 409 sobre un vehículo que no era de nadie — un fallo que solo aparece en
 * las pruebas, y que además contradecía lo que este mismo bloque promete.
 */
function esDeOtraCompania(fila: { clientId?: number | null } | undefined, companiaId: number): boolean {
  return !!fila && fila.clientId != null && fila.clientId !== companiaId;
}

/**
 * Tenencia del vehículo, comprobada ANTES del RUNT y antes de subir el archivo.
 *
 * La autoridad está dentro de la transacción (`upsertVehiculoRunt`), donde la fila se lee otra vez y
 * no puede cambiar bajo los pies; esto es la versión temprana, por lo mismo que la RN-01 se mira dos
 * veces: para no dejar un objeto huérfano en el bucket ni gastar una consulta al RUNT por un alta
 * que ya se sabe que no va a entrar.
 */
async function verificarTenenciaVehiculo(vin: string, companiaId: number): Promise<void> {
  const [ficha] = await db.select({ clientId: vehicles.clientId })
    .from(vehicles).where(eq(vehicles.vin, vin)).limit(1);
  if (esDeOtraCompania(ficha, companiaId)) throw vehiculoAjeno();
}

/**
 * El adjunto es un PDF por CONTENIDO, no por extensión ni por lo que diga el navegador (AC5).
 *
 * El `Content-Type` del multipart lo deriva el navegador de la extensión y es trivialmente
 * falsificable: un ejecutable renombrado a `.pdf` reporta `application/pdf` y supera el `fileFilter`
 * de multer. Se olfatean los bytes con `file-type`, igual que las evidencias de PESV.
 *
 * No se usa `checkMagicNumber` —que compara además el mime DECLARADO con el detectado— porque aquí
 * solo hay un tipo permitido: si el contenido es un PDF, lo que el cliente declarara es irrelevante,
 * y exigir que coincidan rechazaría un PDF legítimo enviado con `application/octet-stream`, que es
 * lo que mandan varios clientes HTTP.
 */
async function verificarPdfReal(archivo: ArchivoSolicitud): Promise<void> {
  const detectado = await detectMime(archivo.buffer);
  if (detectado !== 'application/pdf') {
    throw fallo(400, CodigoErrorSolicitudSoat.ARCHIVO_NO_PDF,
      `La factura de venta debe ser un PDF. El archivo enviado es ${detectado ?? 'de un tipo que no se reconoce'}.`);
  }
}

/** Lo que el RUNT resolvió, ya cruzado con el catálogo de organismos de FLITO. */
export interface ResultadoRunt {
  datos: DatosRuntCanal;
  /**
   * El VIN que se va a persistir: el que trajo el RUNT, normalizado (AC1).
   *
   * No es el que tecleó el Cliente ni un eco de la petición. Con el VIN obligatorio (HU #12090) la
   * compuerta ya comprobó que coinciden —si difieren es un `422 runt_no_cuadra`; si el RUNT no lo
   * publica es un `422 runt_sin_vin`—, así que en el camino que llega aquí los dos valores son el
   * mismo. Se conserva el del RUNT y no el tecleado porque es el que el registro CONFIRMA: la
   * igualdad es una consecuencia de la compuerta, no una invariante que este campo deba suponer.
   */
  vinEfectivo: string;
  /** `null` = el organismo del RUNT no cruza catálogo. **No aborta** (AC5). */
  organismoCodigo: string | null;
  /**
   * El instante en que el RUNT RESPONDIÓ (HU #12093, AC4). Lo persiste el alta en
   * `flito_soat_solicitud.runt_consultado_en`; la preconsulta lo recibe y no lo guarda —no hay fila.
   *
   * Se toma AQUÍ, en la compuerta, y no en el INSERT: entre una cosa y la otra están la subida del
   * PDF a S3 y la apertura de la transacción, que en una petición lenta son segundos. La ficha
   * promete «datos del RUNT del …», así que lo que tiene que quedar escrito es cuándo habló el
   * registro nacional, no cuándo terminamos de guardar.
   */
  consultadoEn: Date;
  /**
   * El aviso de vigencia próxima, o `null` si el RUNT no reporta SOAT vigente (HU #12212).
   *
   * **Requerido y nullable, no opcional**, y es la misma forma que `propietario: {...} | null`: así
   * los DOS `return` de {@link verificarRuntCompuerta} tienen que decidir qué ponen. Con `?` el
   * `case 'ok'` habría podido omitirlo y el campo habría quedado `undefined` —indistinguible de «no
   * lo calculamos»— en la rama más transitada.
   *
   * `poliza` llega hasta aquí porque se PERSISTE en `flito_soat.poliza_runt`; NO se publica en el
   * 200 de la preconsulta. Ver {@link Preconsulta.vigenciaProxima}.
   */
  vigenciaProxima: { venceEl: string; poliza: string | null } | null;
}

/**
 * LA compuerta: consulta el RUNT y traduce cada forma de «no» en un error TIPADO.
 *
 * **La usan los DOS endpoints** —`preconsulta` y `crearSolicitud`— y esa es la invariante que sostiene
 * el AC: los dos devuelven exactamente lo mismo ante la misma respuesta de Kyverum. Con dos copias,
 * el paso 1 del wizard negaría un alta que el paso 2 acepta, o al revés.
 *
 * ── Los tres desenlaces, y por qué el 503 y el 422 no se pueden confundir (AC2 y AC4) ────────────
 *
 *   · **503 `runt_no_disponible`** — el RUNT NO respondió: timeout, red, no-200, circuito abierto o
 *     un `throw`. El usuario puede reintentar y no hay nada que corregir.
 *   · **422 de la familia «revise los datos»** — el RUNT SÍ respondió y su respuesta impide crear:
 *     no cuadra con los propietarios activos, no hay vehículo, el VIN tecleado difiere, o el
 *     registro no publica VIN. El usuario tiene que corregir algo.
 *   · **409 `soat_vigente`** — el vehículo ya tiene SOAT. No se crea y no se compra (AC3).
 *
 * Quién es quién lo decide `esNegativaDeNegocio` por la señal de TRANSPORTE (HTTP 200 = respondió) y
 * no por el texto del mensaje. Ver su docblock: es la decisión cara de esta HU.
 *
 * **El 422 nunca devuelve el valor que el RUNT considera bueno**, y con la HU #12090 el riesgo pasó
 * a ser simétrico: antes era filtrar el VIN a quien sondeaba placas ajenas, ahora es confirmarle el
 * VIN correcto a quien sondea VINs —los de una flota son consecutivos—. Solo viaja `campo: 'vin'`,
 * para que el formulario ponga el foco. Mismo criterio que el 409 recortado de la RN-01
 * (`MENSAJE_VEHICULO_AJENO`), y lo garantiza la construcción del error: `desenlace.campo` es el
 * único dato que entra en `datos`, y `CodigoErrorSolicitudSoat`/`MENSAJE_REVISE` son constantes.
 */
async function verificarRuntCompuerta(vin: string): Promise<ResultadoRunt> {
  const desenlace = await consultarYClasificar(vin);
  // Inmediatamente después del `await` y antes de cualquier rama: es el instante en que el registro
  // nacional respondió, que es lo que el AC4 pide poder enseñar. Se toma también en los desenlaces
  // que abortan —cuesta cero y evita que el «cuándo» dependa de qué contestó el RUNT—, y solo se
  // persiste en el que crea fila.
  const consultadoEn = new Date();

  switch (desenlace.clase) {
    case 'caido':
      throw fallo(503, CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE,
        'No fue posible consultar el RUNT en este momento. Intenta de nuevo en unos minutos.');
    case 'revise':
      throw fallo(422, CODIGO_REVISE[desenlace.codigo], MENSAJE_REVISE[desenlace.codigo],
        desenlace.campo ? { campo: desenlace.campo } : undefined);
    case 'vigente':
      throw fallo(409, CodigoErrorSolicitudSoat.SOAT_VIGENTE,
        'El RUNT reporta que este vehículo ya tiene un SOAT vigente. No se puede solicitar otro.',
        desenlace.fechaVencimiento ? { fechaVencimiento: desenlace.fechaVencimiento } : undefined);
    case 'ok':
      return {
        datos: desenlace.datos,
        vinEfectivo: desenlace.vinEfectivo,
        organismoCodigo: desenlace.organismoCodigo,
        consultadoEn,
        vigenciaProxima: null,
      };
    // El RUNT reporta SOAT vigente, pero le queda un mes o menos: **es un alta permitida**, no un
    // 409. Devuelve el MISMO payload que `ok` —el vehículo es el mismo y la fila que se crea es la
    // misma— más el aviso. Todo lo que separa este caso del anterior es ese objeto.
    case 'renovacion_anticipada':
      return {
        datos: desenlace.datos,
        vinEfectivo: desenlace.vinEfectivo,
        organismoCodigo: desenlace.organismoCodigo,
        consultadoEn,
        vigenciaProxima: { venceEl: desenlace.venceEl, poliza: desenlace.poliza },
      };
  }
}

/** El código de shared-types que le toca a cada desenlace «revise los datos». */
const CODIGO_REVISE: Record<CodigoRevise, CodigoErrorSolicitudSoat> = {
  runt_no_cuadra: CodigoErrorSolicitudSoat.RUNT_NO_CUADRA,
  runt_sin_registro: CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO,
  runt_sin_vin: CodigoErrorSolicitudSoat.RUNT_SIN_VIN,
};

/**
 * Lo que se le dice a la persona en cada uno. Ninguno menciona el VIN del RUNT ni el nombre del
 * propietario que devolvió el registro: el mensaje explica qué hacer, no qué sabe el RUNT.
 *
 * Los dos primeros cambian con la HU #12090 y por el mismo motivo: mandaban revisar «la placa, el
 * tipo y el número de documento», que desde esta HU no son entrada de nada. Un mensaje que pide
 * corregir un campo que la pantalla ya no tiene es peor que no decir nada.
 */
const MENSAJE_REVISE: Record<CodigoRevise, string> = {
  runt_no_cuadra:
    'El RUNT no confirma este vehículo. Revisa el VIN que escribiste.',
  runt_sin_registro:
    'El RUNT no tiene registrado un vehículo con ese VIN. Revísalo.',
  runt_sin_vin:
    'El RUNT no publica el VIN de este vehículo, y sin VIN no podemos radicar la solicitud. Escríbenos para revisarlo.',
};

// ───────────────────────────── Preconsulta ──────────────────────────────────

export interface Preconsulta {
  vehiculo: Omit<DatosRuntCanal, 'organismoNombre' | 'propietarioNombre'>;
  /**
   * `codigo` es `string | null` desde la HU #11966: el organismo dejó de ser compuerta (AC5) y el
   * `422 organismo_no_catalogado` desapareció de los dos endpoints. Si la preconsulta siguiera
   * bloqueando por organismo, el paso 1 del wizard negaría un alta que el paso 2 aceptaría.
   */
  organismo: { codigo: string | null; nombre: string | null };
  /** Solo el nombre, y solo si el RUNT lo trajo. Ver `DatosRuntCanal.propietarioNombre`. */
  propietario: { nombreCompleto: string } | null;
  /**
   * «Este vehículo ya tiene SOAT y vence pronto; se puede renovar por anticipado» (HU #12212, AC1).
   *
   * ── El contrato, que la HU #12213 consume tal cual ──────────────────────────────────────────────
   *
   *   · La clave está **SIEMPRE presente**. `null` = no hay aviso. Nunca ausente, nunca `undefined`:
   *     el front distingue «no hay» de «el back no lo mandó» sin adivinar.
   *   · `venceEl` es `yyyy-mm-dd` y **no es nullable dentro del objeto**. Sin fecha no hay aviso —es
   *     el 409 de siempre (AC3)—, así que un `{ venceEl: null }` sería un estado inalcanzable.
   *
   * ── Por qué NO viaja la póliza ──────────────────────────────────────────────────────────────────
   *
   * Desde la HU #12090 rige la RN-B1 escrita en la ruta: **cualquiera que conozca un VIN obtiene la
   * ficha**, porque consultar por VIN ya no acredita al titular. Publicar aquí el número de póliza
   * sería una divulgación NUEVA y cosechable enumerando VIN, sobre un dato que hoy no sale por
   * ninguna vía —la HU #12097 se negó por lo mismo a proyectar `poliza_runt` hacia la cola—. El AC1
   * pide la fecha; la póliza se persiste en servidor y ahí se queda.
   */
  vigenciaProxima: { venceEl: string } | null;
}

/**
 * Paso 1 del wizard: el cliente escribe **el VIN y nada más**, y ve lo que el RUNT sabe del vehículo
 * antes de adjuntar nada (HU #12090, AC1).
 *
 * Aplica canal, RN-01, tenencia y la compuerta del RUNT — las mismas que el alta y en el mismo
 * orden, para que el formulario no deje llenar diez campos y adjuntar un PDF para fallar al final.
 * Y no escribe NADA: es una lectura.
 *
 * ── Qué cambia con la HU #12090 ─────────────────────────────────────────────────────────────────
 *
 *   · La firma pierde `placa`, `numeroDocumento` y `tipoDocumento`. La consulta va por la modalidad
 *     de VIN, que no pide documento del propietario: el Bug #11927 obligaba a mandarlo PORQUE iba la
 *     placa, y ya no va.
 *   · Las dos guardas baratas (RN-01 y tenencia) vuelven a correr SIEMPRE antes de Kyverum. Bajo la
 *     #11966 no se podía —sin VIN tecleado no había clave por la que buscar— y ese era el coste
 *     declarado del VIN opcional. Con el VIN obligatorio ese coste desaparece.
 *   · `vehiculo.placa` es la que DEVUELVE el RUNT (AC3), y puede ser `null`. Antes era el eco
 *     normalizado de la petición.
 *   · `vehiculo.vin` sigue siendo el del RUNT: es el que se va a persistir.
 *   · `organismo.codigo` puede ser `null` (#11966, AC5).
 */
export async function preconsulta(vin: string, ctx: SoatCtx): Promise<Preconsulta> {
  const canal = await canalDeLaCompania(ctx);
  const vinNorm = normalizarId(vin);

  // Las dos guardas baratas, ANTES de gastar una consulta a Kyverum. Se vuelven a mirar debajo sobre
  // el VIN efectivo porque entre una cosa y la otra hay una llamada de red entera.
  await verificarRn01(vinNorm, canal.companiaId);
  await verificarTenenciaVehiculo(vinNorm, canal.companiaId);

  const { datos, vinEfectivo, organismoCodigo, vigenciaProxima } = await verificarRuntCompuerta(vinNorm);

  // Autoritativas. El 409 que producen es idéntico al de la RN-01 ajena, sin id y sin estado.
  await verificarRn01(vinEfectivo, canal.companiaId);
  await verificarTenenciaVehiculo(vinEfectivo, canal.companiaId);

  const [organismo] = organismoCodigo
    ? await db.select({ alias: organismosTransitoConfig.alias })
        .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, organismoCodigo)).limit(1)
    : [];

  return {
    vehiculo: {
      // **La placa es la del RUNT** (HU #12090, AC3), y sigue siendo «la que se va a persistir»: es
      // el mismo valor que `upsertVehiculoRunt` escribe en `vehicles.plate`. Lo que cambió es de
      // dónde sale. `null` cuando el registro no la publica — la pantalla pinta «—», que es lo
      // honesto: inventar aquí el eco de una petición que ya no lleva placa sería enseñar como dato
      // del RUNT algo que nadie confirmó.
      placa: datos.placa,
      vin: vinEfectivo,
      marca: datos.marca, linea: datos.linea, modelo: datos.modelo, clase: datos.clase,
      cilindraje: datos.cilindraje, tipoServicio: datos.tipoServicio,
      carroceria: datos.carroceria,
      pasajerosSentados: datos.pasajerosSentados,
      puertas: datos.puertas,
    },
    organismo: { codigo: organismoCodigo, nombre: organismo?.alias ?? null },
    propietario: datos.propietarioNombre ? { nombreCompleto: datos.propietarioNombre } : null,
    // Se PROYECTA, no se reenvía: de `{ venceEl, poliza }` sale solo la fecha. La póliza se queda en
    // el servidor (RN-B1). El objeto se reconstruye a mano y no con un spread por eso mismo — un
    // `...vigenciaProxima` publicaría el campo que se añadiera mañana sin que nadie lo decidiera.
    vigenciaProxima: vigenciaProxima ? { venceEl: vigenciaProxima.venceEl } : null,
  };
}

// ───────────────────────────── Alta ─────────────────────────────────────────

/**
 * *Upsert* del vehículo por VIN, con la política del sync (`setVehiculoDesdeFlit`): **un campo vacío
 * no borra lo que ya se sabía** (ADR-0008 §1.4).
 *
 * `flito_soat.vehiculo_id` es NOT NULL UNIQUE, así que el alta TIENE que resolver un `vehicles.id`
 * antes de insertar. Las dos ramas escriben con reglas distintas, igual que `upsertVehiculo()`: en
 * el UPDATE los `null` del RUNT se omiten —la fila puede traer datos de otra fuente, p. ej. el OCR
 * de la tarjeta de propiedad—, y en el INSERT van tal cual, porque en una fila nueva `null` es la
 * forma correcta de decir «el RUNT no lo trajo».
 *
 * Riesgo heredado y escrito (§1.4): `vehicles.plate` NO es único. Un vehículo que exista con
 * `vin IS NULL` —posible por la vía legacy, que se alimenta de placa— no se encuentra por VIN y
 * produce una segunda fila con la misma placa. El sync ya vive con esto; este canal no lo empeora
 * ni lo arregla.
 *
 * ── La ficha ajena NO se toca (bloqueante del `security-agent`) ──────────────────────────────────
 *
 * `vehicles` es una tabla COMPARTIDA por todas las compañías y la búsqueda por VIN no las separa.
 * Antes de este guarda, radicar con el VIN de un vehículo de otra compañía sobrescribía SU ficha con
 * lo que teclea quien radica —`ownerName` y `ownerDocument` son campos libres del formulario—, y la
 * solicitud quedaba apuntando a esa fila. Además de la mezcla de datos, sustituir el titular y la
 * cédula de la ficha de un tercero sin su intervención rompe el principio de veracidad de la Ley
 * 1581. Ahora es un 409 recortado y no un UPDATE.
 *
 * ── Qué se hace con `clientId === null`, que era el hueco sin decidir ────────────────────────────
 *
 * **Se ADOPTA para la compañía que radica**, y es una decisión, no el camino por omisión:
 *
 *   · Bloquear negaría un alta legítima: una ficha sin dueño es lo que dejan la vía legacy (que se
 *     alimenta de placa) y el OCR de la tarjeta de propiedad, y el vehículo puede ser perfectamente
 *     de quien radica — que además llega con el RUNT confirmando el vehículo y con la factura de
 *     venta adjunta.
 *   · Dejarla en `null` mantendría el agujero ABIERTO para esa fila: el siguiente que radicara con
 *     ese VIN, de cualquier compañía, volvería a encontrarla sin dueño y a sobrescribirla. Adoptar
 *     es lo que hace que la comprobación de arriba signifique algo la segunda vez.
 *
 * Es la misma regla que ya aplica la rama del INSERT, que escribe `clientId` sin preguntar; la
 * diferencia es que aquí queda ANOTADA (`audit_logs`, `resource: 'vehicles'`), porque tocar una
 * ficha que ya existía es un cambio sobre datos de alguien y el rastro de `flito_soat` no lo cuenta.
 */
async function upsertVehiculoRunt(
  tx: Pick<typeof db, 'select' | 'insert' | 'update'>,
  entrada: { vin: string },
  datos: DatosRuntCanal,
  propietario: PropietarioSolicitud,
  companiaId: number,
  ctx: SoatCtx,
  soatId: string,
): Promise<number> {
  // `vehicles.year` es integer y el RUNT manda el año-modelo como texto. Un valor que no sea un año
  // se descarta en vez de escribir un `NaN` que Postgres rechazaría con un 22P02.
  const anio = Number(datos.modelo);
  const year = Number.isInteger(anio) && anio > 1900 && anio < 2200 ? anio : null;

  // `clientId` viaja en la proyección porque es lo que decide si esta fila se puede tocar. Se relee
  // DENTRO de la transacción —no basta con la comprobación previa— porque entre aquella y este
  // UPDATE cabe otra petición entera.
  //
  // ── `FOR UPDATE`: la relectura no solo tiene que ser autoritativa, tiene que ser ESTABLE ────────
  //
  // Cierre de la carga LOW que la auditoría de seguridad de la HU #11914 dejó pendiente. Sin el
  // bloqueo, esta lectura y el UPDATE de abajo son dos instantes distintos: entre ellos cabe el sync
  // de trámites —`upsertVehiculo()` escribe `client_id` sobre la misma fila— asignándole la ficha a
  // OTRA compañía. Este alta ya había leído `client_id IS NULL`, así que la clasificaría como
  // adoptable y le sobrescribiría titular, cédula y placa a una ficha que, para cuando se escribe,
  // ya tiene dueño. `FOR UPDATE` serializa las dos escrituras: la que llega segunda espera y relee.
  //
  // La carrera GRANDE —dos altas del mismo VIN— no depende de esto: la cierra el UNIQUE de
  // `flito_soat.vin`, que es la base y no el servicio (RN-01). Esto cierra la que quedaba, que es
  // contra un escritor que no pasa por esa constraint.
  //
  // `FOR UPDATE` y no `SKIP LOCKED`: aquí no se despacha una cola en la que saltarse una fila
  // ocupada sea correcto (eso es `enviarAlGestor`), sino que se lee la única fila que importa. Con
  // `SKIP LOCKED` el alta la vería como inexistente y crearía una SEGUNDA ficha con el mismo VIN.
  const [existente] = await tx.select({ id: vehicles.id, clientId: vehicles.clientId }).from(vehicles)
    .where(eq(vehicles.vin, entrada.vin)).for('update').limit(1);

  if (esDeOtraCompania(existente, companiaId)) throw vehiculoAjeno();

  if (existente) {
    // `== null` por lo mismo que el predicado de tenencia, y tiene que ser la MISMA laxitud: si aquí
    // se comparara estricto, una ficha cuyo dueño llega vacío no sería «ajena» —así que el alta
    // seguiría— pero tampoco se adoptaría, y volvería a quedar sin dueño para el siguiente. Las dos
    // decisiones se toman sobre el mismo hecho y tienen que leerlo igual.
    const adopta = existente.clientId == null;
    await tx.update(vehicles).set({
      ...(adopta ? { clientId: companiaId } : {}),
      // **La placa pasa a la política de «un campo vacío no borra lo que ya se sabía»** (§1.4), y
      // ese condicional es la mitad de la HU #12090 en esta función. Se escribía incondicionalmente
      // porque era un campo TECLEADO y obligatorio: no podía llegar vacía. Ahora llega del RUNT, que
      // en la modalidad de VIN puede no publicarla, y un `plate: null` a pelo BORRARÍA la placa que
      // la ficha ya tenía —puesta por el sync de trámites o por el OCR de la tarjeta de propiedad—
      // sin que nadie lo pidiera. Con el condicional, «el RUNT no la trajo» deja la fila como estaba,
      // igual que marca, línea o clase.
      ...(datos.placa ? { plate: datos.placa } : {}),
      ...(datos.marca ? { brand: datos.marca } : {}),
      ...(datos.linea ? { model: datos.linea } : {}),
      ...(year !== null ? { year } : {}),
      ...(datos.clase ? { vehicleClass: datos.clase } : {}),
      ...(datos.cilindraje ? { cilindraje: datos.cilindraje } : {}),
      ...(datos.tipoServicio ? { tipoServicio: datos.tipoServicio } : {}),
      // Los tres de la HU #11966, con la MISMA política: un `null` del RUNT no borra lo que ya se
      // sabía. `puertas` la escribe solo este canal (ver `vehicles.puertas` en el esquema).
      ...(datos.carroceria ? { carroceria: datos.carroceria } : {}),
      ...(datos.pasajerosSentados ? { pasajerosSentados: datos.pasajerosSentados } : {}),
      ...(datos.puertas ? { puertas: datos.puertas } : {}),
      ownerName: nombreCompletoDe(propietario),
      ownerDocument: propietario.numeroDocumento,
      updatedAt: new Date(),
    }).where(eq(vehicles.id, existente.id));

    // El rastro que faltaba: `audit()` anota la creación del SOAT con SU uuid, así que la
    // modificación de una ficha de `vehicles` que ya existía no quedaba escrita en ninguna parte.
    // Sin placa, sin VIN y sin documento: los identificadores del vehículo son cuasi-PII y esta
    // tabla se exporta entera (AGENTS.md §14).
    await tx.insert(auditLogs).values({
      userId: ctx.userId, userEmail: ctx.username, action: 'update', resource: 'vehicles',
      resourceId: String(existente.id),
      detail: `Alta de solicitud SOAT del canal Cliente (${soatId}): ficha del vehículo actualizada con los datos del RUNT${adopta ? ' y asignada a la compañía que radica (no tenía dueño)' : ''}`,
    });
    return existente.id;
  }

  // En una fila NUEVA `null` sí es la forma correcta de decir «el RUNT no lo trajo», y la placa no
  // es una excepción: `vehicles.plate` es nullable desde la migración 0000 y aquí no hay ningún
  // valor previo que perder. Ver el HANDOFF de la HU #12090: el desenlace «el RUNT no publica la
  // placa» NO existe (el simétrico `runt_sin_vin` sí), así que esta fila puede nacer sin placa.
  const [creado] = await tx.insert(vehicles).values({
    vin: entrada.vin, plate: datos.placa, clientId: companiaId,
    brand: datos.marca, model: datos.linea, year, vehicleClass: datos.clase,
    cilindraje: datos.cilindraje, tipoServicio: datos.tipoServicio,
    carroceria: datos.carroceria,
    pasajerosSentados: datos.pasajerosSentados,
    puertas: datos.puertas,
    ownerName: nombreCompletoDe(propietario), ownerDocument: propietario.numeroDocumento,
  }).returning({ id: vehicles.id });
  return creado.id;
}

/** Código de violación de unicidad de PostgreSQL. Aquí solo puede venir del VIN o del vehículo. */
const UNIQUE_VIOLATION = '23505';

// ═══════════ El destino del alta (Feature #12074, HU #12078) ═════════════════

/**
 * El ejecutor de una transacción de drizzle (no hay alias exportado; mismo truco que `flito-sync`).
 *
 * Vivía al final del archivo, con las tres transiciones de la #11915; se sube aquí al borrarlas
 * (HU #12080), que es donde está su único usuario: `resolverDestinoCanalCliente`.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * El motivo del historial en el camino feliz (AC1, literal exacto).
 *
 * Los tres literales se EXPORTAN para que los tests los nombren en vez de copiarlos: una copia y el
 * original divergen, y el día que diverjan el test seguiría verde afirmando sobre una cadena que ya
 * no escribe nadie.
 */
export const MOTIVO_ENVIO_DIRECTO = 'Envío directo al gestor (canal Cliente)';

/** El del historial cuando el destino cayó en contingencia (AC2d). */
export const MOTIVO_ENVIO_CONTINGENCIA =
  'Envío directo al gestor (canal Cliente): el gestor por defecto de la compañía no está disponible, la asume Operaciones';

/** Lo que verá Operaciones en su bandeja, en `flito_soat.gestion_operaciones_motivo`. */
export const MOTIVO_GESTION_OPERACIONES_ALTA =
  'El gestor por defecto de la compañía no estaba disponible al radicar (canal Cliente).';

/**
 * A dónde va una solicitud del canal Cliente. Los dos campos de destino son excluyentes y NUNCA
 * están los dos vacíos: o hay `proveedorSoatId`, o `gestionOperaciones` es `true` (AC1).
 */
export interface DestinoCanalCliente {
  proveedorSoatId: string | null;
  gestionOperaciones: boolean;
  /** El literal que va a `flito_estado_historial.motivo`. Nunca vacío. */
  motivoHistorial: string;
  /** Solo en contingencia: lo que verá Operaciones en su bandeja. `null` en el camino feliz. */
  contingenciaMotivo: string | null;
}

/**
 * El destino de un alta del canal Cliente: el gestor por defecto de SU compañía (AC2).
 *
 * ── Por qué vive en ESTE archivo y no en `flito-soat.service.ts` ─────────────────────────────────
 *
 * Aquel es el archivo del SOAT POR TRÁMITE y el que exporta `enviarAlGestor()`. Poner el resolutor
 * ahí lo dejaría a un `import` de distancia de la ruta que el AC2e declara intocable, y la primera
 * vez que alguien «unificara el destino» las dos puertas quedarían atadas sin que nada se pusiera
 * rojo. **La frontera de archivo ES la garantía estructural del AC2e**; el test nombrado es la
 * segunda capa, no la primera. Operaciones sigue eligiendo gestor en cada `POST /flito/soat/enviar`,
 * que es cuando alguien mira la carga de cada uno (HU #10979).
 *
 * ── Una sola consulta, y `LEFT JOIN` y no dos `select` ──────────────────────────────────────────
 *
 * El AC2 lo pide con esas palabras —«una compañía, un destino, una sola consulta»— y además hace
 * falta: «sin gestor» y «gestor inactivo» son el MISMO desenlace (la contingencia) y tienen que
 * leerse en el MISMO instante. Partirlo en dos consultas abre una ventana en la que el proveedor se
 * desactiva entre una y otra y el alta escribe un destino que ya no atiende.
 *
 * `flito_reglas_proveedor_soat` NO aparece, y no por descuido: sus reglas se retiraron a propósito
 * en la HU #10979 y su DROP sigue pendiente. Sin ámbitos, sin prioridades, sin `PRIORIDAD_POR_AMBITO`.
 *
 * ── El fallo por defecto es la contingencia, nunca un alta caída (AC2d) ─────────────────────────
 *
 * `proveedorId === null || activo !== true` es UN solo predicado para los dos casos —no configurado
 * y configurado pero apagado—, y el `!== true` es deliberado: una fila sin `activo` (que el
 * `LEFT JOIN` deja en `null` cuando no cruza) cuenta como no disponible. Un problema de
 * configuración no puede impedir que un cliente radique.
 *
 * Recibe el `tx` y no lee de `db`: el AC2 exige que el destino se lea DENTRO de la misma
 * transacción que lo escribe.
 */
export async function resolverDestinoCanalCliente(
  tx: Tx, companiaId: number,
): Promise<DestinoCanalCliente> {
  const [fila] = await tx
    .select({ proveedorId: flitoProveedoresSoat.id, activo: flitoProveedoresSoat.activo })
    .from(clients)
    .leftJoin(
      flitoProveedoresSoat,
      eq(flitoProveedoresSoat.id, clients.flitoProveedorSoatSinTramiteId),
    )
    .where(eq(clients.id, companiaId))
    .limit(1);

  const disponible = fila?.proveedorId != null && fila.activo === true;
  if (!disponible) {
    return {
      proveedorSoatId: null,
      gestionOperaciones: true,
      motivoHistorial: MOTIVO_ENVIO_CONTINGENCIA,
      contingenciaMotivo: MOTIVO_GESTION_OPERACIONES_ALTA,
    };
  }
  return {
    proveedorSoatId: fila!.proveedorId,
    gestionOperaciones: false,
    motivoHistorial: MOTIVO_ENVIO_DIRECTO,
    contingenciaMotivo: null,
  };
}

export interface SolicitudCreada {
  id: string;
  estado: EstadoSoat;
  /**
   * La placa que devolvió el RUNT, **solo para el rastro de PII** (ADR-0012, HU #12090).
   *
   * Y **no se proyecta en el 201**, igual que `destino`: la respuesta sigue siendo `{ id, estado }`.
   * Existe porque el registro del artículo 17 escribe un HMAC de la placa además del del VIN —para
   * que un titular que solo conoce su placa pueda ser emparejado— y esta es la ÚNICA fuente: desde
   * esta HU la placa es un dato de salida del RUNT, no algo que el router tenga a mano. El VIN no
   * necesitó este tratamiento porque el router ya lo tiene en `parsed.data.vin`.
   *
   * `null` cuando el registro no la publica, que esta misma HU dejó medido que ocurre.
   */
  placa: string | null;
  /**
   * A dónde fue, PARA LA AUDITORÍA del AC7 — y solo para ella.
   *
   * La ruta lo escribe en `audit_logs` y **no lo devuelve en el 201**, que sigue siendo
   * `{ id, estado }`: a qué aseguradora despacha su compañía no es asunto de quien radica, y el
   * `res.json(creada)` de antes se lo habría contado sin que nadie lo pidiera.
   */
  destino: DestinoCanalCliente;
}

/**
 * El alta del canal Cliente: crear ES enviar (AC1). No hay borrador.
 *
 * **El RUNT es compuerta otra vez** (ADR-0010): o el registro confirma el vehículo y no hay SOAT
 * vigente, o no hay fila. El 201 significa que la ficha del vehículo ya está escrita con lo que dijo
 * el RUNT y que el satélite nace en `ok`.
 *
 * ── El orden de los pasos es la mitad del diseño ─────────────────────────────────────────────────
 *
 *   1. Canal encendido y compañía del usuario — lo más barato y lo que más veces va a fallar.
 *   2. El adjunto es un PDF de verdad — antes de gastar S3 y antes de gastar una consulta a Kyverum.
 *   3. RN-01 + tenencia sobre el VIN TECLEADO — un 409 barato, ANTES del RUNT.
 *   4. La COMPUERTA — 503 | 422 | 409-vigente. Aquí es donde el alta puede no llegar a existir.
 *   5. VIN efectivo = el del RUNT (AC1).
 *   6. RN-01 + tenencia sobre el VIN efectivo — AUTORITATIVAS (HU #12090, AC5).
 *   7. UUID + subida a S3 — fuera de la transacción (CA-11).
 *   8. La transacción: vehículo CON los datos del RUNT —**la placa incluida** (AC5)—, **el destino
 *      resuelto** (HU #12078), SOAT en `solicitado` con ese destino y con el organismo cruzado (o
 *      NULL), satélite en `ok`, propietario partido, soporte e historial, todo o nada.
 *   9. COMMIT → 201. **No hay `setImmediate`**: no queda nada por verificar.
 *
 * El paso 3 DUPLICA el 6 y desde la HU #12090 puede correr SIEMPRE, porque el VIN es obligatorio: la
 * rama «sin VIN tecleado no hay clave por la que buscar» desapareció con el coste que la #11966
 * declaraba. El 6 no se va por eso: entre el 3 y el 8 hay una llamada de red al RUNT —segundos— y es
 * la lectura de después la que decide. Es el mismo patrón de la tenencia (previa + dentro de la tx).
 *
 * El `id` del SOAT se genera AQUÍ y no lo pone la base: la clave de storage se nombra con él.
 */
export async function crearSolicitud(
  entrada: EntradaSolicitud,
  archivo: ArchivoSolicitud,
  ctx: SoatCtx,
): Promise<SolicitudCreada> {
  const canal = await canalDeLaCompania(ctx);
  await verificarPdfReal(archivo);

  const vinTecleado = normalizarId(entrada.vin);
  await verificarRn01(vinTecleado, canal.companiaId);
  await verificarTenenciaVehiculo(vinTecleado, canal.companiaId);

  const { datos, vinEfectivo, organismoCodigo, consultadoEn, vigenciaProxima } =
    await verificarRuntCompuerta(vinTecleado);

  // Sobre el VIN EFECTIVO, que es el que se va a escribir (AC5). No sobra por coincidir hoy con el
  // tecleado —la compuerta garantiza esa igualdad—: lo que esta pareja cubre es la ventana entre la
  // comprobación previa y el INSERT, en la que cabe otra petición entera radicando el mismo VIN.
  const vin = vinEfectivo;
  await verificarRn01(vin, canal.companiaId);
  await verificarTenenciaVehiculo(vin, canal.companiaId);

  const soatId = randomUUID();
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  const storageKey = await uploadEntityDocument(
    carpetaDe({ id: canal.companiaId, flitoCarpetaStorage: canal.carpetaStorage }, 'soat/facturas-venta'),
    soatId, archivo.originalname, archivo.buffer, archivo.mimetype,
  );

  let destino!: DestinoCanalCliente;
  // Un solo instante para `enviado_en` y para `gestion_operaciones_en`: son el mismo hecho —esta
  // solicitud se despachó ahora— y dos `new Date()` los separarían por milisegundos sin motivo.
  const ahora = new Date();

  try {
    await db.transaction(async (tx) => {
      const vehiculoId = await upsertVehiculoRunt(
        tx, { vin }, datos, entrada.propietario, canal.companiaId, ctx, soatId,
      );

      // DENTRO de la transacción y ANTES del INSERT, para que el destino entre en el MISMO INSERT
      // que el estado (AC1). Es el argumento ya escrito para `procedencia` de `flitoCompradores`:
      // escribirlo aparte —un UPDATE después— dejaría una ventana en la que la fila está
      // `solicitado` y no dice a dónde va, más una segunda escritura que puede fallar sola.
      destino = await resolverDestinoCanalCliente(tx, canal.companiaId);

      await tx.insert(flitoSoat).values({
        id: soatId,
        vin,
        vehiculoId,
        origen: ORIGEN_CLIENTE,
        // **Crear ES despachar** (HU #12078, AC1). Nace en `solicitado`, que es el estado que
        // `ESTADOS_SOAT_VISIBLES_GESTOR` ya deja ver al gestor: entre el alta y esa visibilidad no
        // queda ningún paso intermedio (AC5). Desde la HU #12080 tampoco queda el estado con el que
        // ese paso se hacía: `pendiente_revision` no existe en el tipo (migración 0176).
        estado: EstadoSoat.SOLICITADO,
        companiaId: canal.companiaId,
        // El cruce del catálogo, o `null` si el nombre del RUNT no cruza. `null` NO aborta (AC5):
        // el organismo dejó de ser compuerta y Operaciones lo completa a mano.
        organismoCodigo,
        // Quién y cuándo la despachó. Es lo que hasta ahora escribía `enviarAlGestor()` en la
        // validación del admin; aquí lo escribe el alta porque el alta ES el envío.
        enviadoPorId: ctx.userId,
        enviadoEn: ahora,
        // El destino, en las dos ramas del mismo objeto: o proveedor, o contingencia. Nunca los dos
        // vacíos (AC1) y nunca los dos puestos.
        proveedorSoatId: destino.proveedorSoatId,
        // `false`, a diferencia de `enviarAlGestor()`, que pone `true`: esa bandera significa «una
        // persona eligió este proveedor a mano», y aquí no eligió nadie — lo dijo la configuración.
        proveedorSobrescrito: false,
        gestionOperaciones: destino.gestionOperaciones,
        gestionOperacionesMotivo: destino.contingenciaMotivo,
        gestionOperacionesEn: destino.gestionOperaciones ? ahora : null,
        // **`null` a propósito**, y es la decisión que más fácil sería degradar. Las otras dos
        // escrituras de esta columna (`asumirEnOperaciones` y su gemela de impuestos) ponen el
        // usuario porque UNA PERSONA decidió el traspaso. Aquí lo decidió una configuración rota:
        // poner el id del cliente que radica afirmaría que él pidió la contingencia, que es falso, y
        // es la clase de fila que la regla 2 del ADR-0005 llama «un acto sin actor, indistinguible
        // de un error de escritura». El quién y el cuándo del alta están en `enviado_por_id` y en la
        // fila de historial.
        gestionOperacionesPorId: null,
        // ── Renovación anticipada: se guarda LO QUE EL RUNT DIJO, y nada más (HU #12212, AC9) ────
        //
        // Las dos claves van **ausentes** cuando no hay aviso, no `null` explícito: es la misma
        // mecánica de `payloadDeDesenlace` en el servicio de vigencia, y la diferencia importa —una
        // clave ausente deja el default de la columna en paz, un `null` lo pisa—.
        //
        // Lo que NO se escribe aquí, y es parte del mismo AC:
        //   · `numero_poliza` — es la llave de conciliación del OCR (Feature #11623). Pisarla con la
        //     del registro la borraría sin que nada se pusiera rojo. Por eso `poliza_runt` existe.
        //   · `verificada_en` — significa «cuándo respondió el RUNT sobre ESTE SOAT», que aún no
        //     existe: el que se está radicando no es el que el RUNT reporta. Escribirla sacaría la
        //     fila del censo del día (`verificada_en < corte`) y le quitaría su `NULLS FIRST`.
        //   · `estado_vigencia` — queda en su default `no_verificado`. Ponerle `'vigente'` haría
        //     que, en cuanto pasara `vence_el` —a un mes o menos, o sea antes de que FLITO pague—,
        //     la fila cumpliera exactamente `condicionVigencia('vencido')` y la cola afirmara «el
        //     SOAT que FLITO pagó está vencido» sobre una solicitud ni siquiera pagada.
        //
        // La combinación `vence_el` poblado + `estado_vigencia = 'no_verificado'` YA EXISTE en
        // producción: `payloadDeDesenlace` la produce cada noche que el RUNT no responde, y sus dos
        // lectores la resuelven bien. Esto no estrena un estado, lo reutiliza.
        ...(vigenciaProxima ? { venceEl: vigenciaProxima.venceEl, polizaRunt: vigenciaProxima.poliza } : {}),
      });

      await tx.insert(flitoCompradores).values({
        soatId,
        // Derivado, no tecleado: es lo que interroga la búsqueda de la cola. La fuente son las cinco
        // columnas de abajo. Ver `nombreCompletoDe`.
        nombreCompleto: nombreCompletoDe(entrada.propietario),
        nombres: entrada.propietario.nombres,
        apellidos: entrada.propietario.apellidos,
        razonSocial: entrada.propietario.razonSocial,
        numeroDocumento: entrada.propietario.numeroDocumento,
        tipoDocumento: entrada.propietario.tipoDocumento,
        correo: entrada.propietario.correo,
        celular: entrada.propietario.celular,
        direccion: entrada.propietario.direccion,
        municipio: entrada.propietario.municipio,
        departamento: entrada.propietario.departamento,
        // Los nueve campos, siempre completos y siempre en el MISMO INSERT que los valores que
        // describen (AC2 y AC3). Escribirlo aparte —un UPDATE después del COMMIT, como hacía el
        // satélite bajo la #11935— dejaría una ventana en la que la fila tiene los datos y no dice de
        // dónde salieron, y una segunda escritura que puede fallar sola.
        procedencia: procedenciaCompleta(entrada.procedencia),
        orden: 0,
      });

      await tx.insert(flitoSoatSolicitud).values({
        soatId,
        solicitadoPorId: ctx.userId,
        solicitadoPorNombre: ctx.username,
        // La compuerta ya corrió y la fila existe: la lectura es CONCLUYENTE. `pendiente` habría
        // sido cierto bajo la #11935, cuando el desenlace se conocía después del COMMIT.
        verificacionEstado: 'ok',
        // `false` y no `null`: es una lectura concluyente, no un hueco.
        //
        // **Sigue en `false` también en el alta por renovación anticipada** (HU #12212), donde el
        // RUNT SÍ reportó una póliza vigente, y eso es deliberado: su único lector la pinta como el
        // rótulo «vigente» del detalle (`apps/web/src/lib/soatCliente.ts`: «vigente» es
        // `verificacionEstado === 'ok' && soatVigente === true`), así que ponerla en `true` estrenaría
        // en esa pantalla un estado que nadie diseñó y que además diría «este SOAT está vigente»
        // sobre la solicitud NUEVA, que no lo está. Lo que el RUNT reportó queda escrito donde tiene
        // lector: `flito_soat.vence_el` y `flito_soat.poliza_runt`, arriba. Si la ficha del canal
        // tiene que enseñar el aviso, es trabajo de la HU #12213 y de esta pareja de columnas.
        soatVigente: false,
        // El único código que puede llevar una fila NUEVA. `null` cuando el organismo sí cruzó.
        verificacionCodigo: organismoCodigo ? null : CodigoErrorSolicitudSoat.ORGANISMO_NO_CATALOGADO,
        // Cuándo respondió el RUNT, no cuándo se guardó esto (HU #12093, AC4). Sale de la compuerta,
        // que lo tomó justo al resolverse la llamada; `solicitado_en` —la columna de al lado, con su
        // `defaultNow()`— es el otro instante, y tenerlos separados es el motivo de la columna.
        runtConsultadoEn: consultadoEn,
      });

      await tx.insert(flitoSoportes).values({
        tipo: TipoSoporte.FACTURA_VENTA,
        nombreArchivo: archivo.originalname,
        contentType: archivo.mimetype,
        storageKey, hash, tamanoBytes: archivo.size,
        soatId,
        subidoPorId: ctx.userId,
        subidoPorNombre: ctx.username,
      });

      await registrarCambio(tx, {
        concepto: ConceptoHistorial.SOAT,
        registroId: soatId,
        estadoAnterior: null,
        estadoNuevo: EstadoSoat.SOLICITADO,
        // UN solo `registrarCambio` en los dos caminos, con el motivo cambiando: la solicitud tiene
        // un principio y solo uno. **Sin el uuid del proveedor**, por la razón que
        // `asumirEnOperaciones` ya dejó escrita al quitárselo: el historial es de lo poco que un
        // lector externo llega a ver. El uuid del destino sí va al `audit_logs` del AC7, que el
        // cliente no ve.
        motivo: destino.motivoHistorial,
        usuarioId: ctx.userId,
        usuarioEmail: ctx.username,
        origen: 'usuario',
      });
    });
  } catch (e) {
    if ((e as { code?: string })?.code === UNIQUE_VIOLATION) {
      throw vehiculoAjeno();
    }
    throw e;
  }

  // Sin `setImmediate` y sin job: la verificación ya ocurrió, dentro de la petición. La función que
  // la #11935 programaba aquí (`verificarRuntPostAlta`) se BORRÓ con esta HU, y ese borrado es lo
  // que hace estructural el «las filas ya radicadas no se reconsultan» del AC6.
  return { id: soatId, estado: EstadoSoat.SOLICITADO, placa: datos.placa, destino };
}

// ═════════ Lectura OCR de la factura de venta (Feature #12073, HU #12092) ════

/**
 * Lee la factura de venta y devuelve lo que el OCR encontró: los cinco campos documentales y los
 * NUEVE del comprador. **No persiste, no sube nada y no crea soporte** (AC6).
 *
 * ── Por qué vive aquí y no en la ruta ───────────────────────────────────────────────────────────
 *
 * `verificarPdfReal` es privada de este archivo, y exportarla para llamarla desde el router era la
 * salida tentadora: dejaría la validación del MIME real disponible para cualquiera y repartiría en
 * dos archivos la decisión de qué se acepta como factura. La lógica vive donde vive esa guarda, y la
 * ruta solo arma el `ArchivoSolicitud` con el buffer que multer le entregó.
 *
 * ── El orden, que es el mismo del alta y por las mismas razones ─────────────────────────────────
 *
 *   1. Canal encendido y compañía del usuario — lo más barato, y sin él una compañía sin el canal
 *      abierto podría quemar llamadas a un modelo de pago con PDFs de 15 MB.
 *   2. El adjunto es un PDF de VERDAD (bytes, no extensión) — antes de mandarle nada al encargado
 *      externo. Un ejecutable renombrado no llega a salir de la red.
 *   3. Si viene `solicitudId`, que sea alcanzable para quien pregunta (404-no-403). Va ANTES del OCR
 *      a propósito: si no, cualquier cliente podría estampar en el registro del artículo 17 el uuid
 *      de una solicitud ajena, y el rastro que la ley exige quedaría apuntando al caso equivocado.
 *   4. La extracción. Es lo único caro y lo último que corre.
 *
 * ── El umbral lo pone quien llama, y aquí es el GLOBAL ──────────────────────────────────────────
 *
 * `umbralPara(null)` → `OCR_UMBRAL_DEFECTO`. **No** se usa `flito_proveedores_soat.umbral_ocr` por
 * dos razones: en el momento de la lectura la solicitud todavía no existe —esta ruta prellena el
 * formulario ANTES del alta, así que no hay proveedor del que leer el umbral—; y ese umbral califica
 * la lectura de la PÓLIZA que emite ese proveedor, no la de una factura de concesionario.
 * Se pasa por `umbralPara` y no se lee `env` a pelo para que sea la misma función que el resto del
 * repo.
 *
 * ── Qué pasa cuando el OCR no está ──────────────────────────────────────────────────────────────
 *
 * `extraerFacturaVenta` lanza `OcrNoDisponibleError(503)` y la ruta lo traduce: el formulario sigue a
 * mano (AC6). Con el fallback local (`OCR_LOCAL=1` y sin API key) no lanza y devuelve los CATORCE
 * campos en `null` con `confiable: false` —los nueve del comprador y los cinco documentales—, que es
 * exactamente el AC3 y tampoco impide seguir.
 */
export async function leerFacturaVenta(
  archivo: ArchivoSolicitud,
  ctx: SoatCtx,
  solicitudId: string | null = null,
): Promise<ExtraccionFacturaVenta> {
  await canalDeLaCompania(ctx);
  await verificarPdfReal(archivo);

  if (solicitudId) {
    const soat = await buscarConAcceso(solicitudId, ctx);
    if (!soat) {
      throw fallo(404, CodigoErrorSolicitudSoat.SOLICITUD_NO_ENCONTRADA, 'La solicitud no existe.');
    }
  }

  return extraerFacturaVenta({
    nombreArchivo: archivo.originalname,
    contentType: archivo.mimetype,
    contenido: archivo.buffer,
    umbral: umbralPara(null),
  });
}
