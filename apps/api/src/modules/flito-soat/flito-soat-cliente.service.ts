// FLITO — SOAT, canal Cliente (lógica). Feature #11912, HU #11914.
// Diseño y tradeoffs: docs/adr/ADR-0008-flito-soat-canal-cliente.md
//
// ── Qué hace ─────────────────────────────────────────────────────────────────────────────────────
//
// La SEGUNDA puerta de `flito_soat`. Hasta hoy toda fila nacía en `resolverSoat()`, dentro del sync
// de trámites de FLIT; aquí la abre un usuario `cliente` de una compañía con el flag «SOAT sin
// trámite» encendido, para un vehículo que NO tiene trámite digital. La fila nace con
// `origen = 'cliente'` y estado `pendiente_revision`, que es lo que impide que un admin la despache
// al gestor con `POST /enviar` —esa ruta filtra por `pendiente`— sin que nadie la haya validado.
//
// ── Por qué es un archivo aparte y no crece `flito-soat.service.ts` ─────────────────────────────
//
// `max-lines` es `error` y bloquea CI: ese archivo tiene el techo congelado en 1090 líneas
// efectivas y mide ~760. El canal entero no cabe, y partirlo por la mitad sería peor que separarlo
// entero (ADR-0008 §7). Lo que SÍ se comparte es la puerta de acceso: `SoatCtx`, `contextoSoat()` y
// `buscarConAcceso()` viven allí y este módulo los importa — un endpoint del canal que se saltara
// esa puerta se saltaría el aislamiento por compañía.
//
// ── Lo que este módulo NO hace ───────────────────────────────────────────────────────────────────
//
// No valida, no rechaza y no subsana: eso es la HU #11915 y entra por `POST /:id/validar`,
// `POST /:id/rechazar-solicitud` y `PATCH /:id/solicitud`. Tampoco toca el ciclo del SOAT nacido de
// trámite, que sigue exactamente igual (AC5).
//
// ── El payload crudo del RUNT no se persiste (ADR-0008 §1.6) ────────────────────────────────────
//
// Se guardan solo los campos derivados que el AC1 nombra: marca, línea, modelo, clase, servicio y
// cilindraje van a `vehicles`; el organismo a `flito_soat.organismo_codigo`; el propietario a
// `flito_compradores`. El precedente contrario —`flito_tramites.flit_raw`, que guarda el reporte
// entero de FLIT con celular, correo y cédula en claro— existe porque el sync RECONCILIA y necesita
// saber qué decía antes. Aquí la consulta es de una sola vez, así que guardar el crudo sería copiar
// el peor rasgo del precedente a una tabla que nace limpia.

import { createHash, randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs,
  clients,
  flitoCompradores,
  flitoSoat,
  flitoSoatSolicitud,
  flitoSoportes,
  organismosTransitoConfig,
  vehicles,
} from '../../db/schema.js';
import {
  CodigoErrorSolicitudSoat,
  EstadoSoat,
  resolverCodigoOrganismoFlit,
  TipoSoporte,
  type TipoDocumentoRunt,
} from '@operaciones/shared-types';
import { ConceptoHistorial, registrarCambio } from '../../shared/historial/estado-historial.js';
import { carpetaDe } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { detectMime } from '../pesv/magic-number.js';
import { extraerVehiculoRunt, runtSinRegistro } from '../flito-impuestos/certificacion-runt.js';
import { derivePreflightChecks } from '../tramites/preflight.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import type { SoatCtx } from './flito-soat.service.js';

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

// ───────────────────────────── Entrada ──────────────────────────────────────

export interface PropietarioSolicitud {
  tipoDocumento: TipoDocumentoRunt;
  numeroDocumento: string;
  nombreCompleto: string;
  correo?: string | null;
  celular?: string | null;
  direccion?: string | null;
}

export interface EntradaSolicitud {
  placa: string;
  vin: string;
  propietario: PropietarioSolicitud;
}

/** El adjunto, con la misma forma que `ArchivoSubido` del módulo hermano. */
export interface ArchivoSolicitud {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/** Mayúsculas y solo alfanuméricos, igual que `runt.service.ts` normaliza lo que consulta. */
const normalizarId = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

// ───────────────────────────── Lectura del RUNT ─────────────────────────────

/**
 * Lo que el canal necesita del RUNT. `null` en un campo significa «el RUNT no lo trajo», y no se
 * inventa: `vehicles` guarda null y la pantalla pinta «—».
 */
export interface DatosRuntCanal {
  placa: string | null;
  vin: string | null;
  marca: string | null;
  linea: string | null;
  /** Año-modelo. Texto aquí; `vehicles.year` es integer y la conversión se hace al escribir. */
  modelo: string | null;
  clase: string | null;
  cilindraje: string | null;
  tipoServicio: string | null;
  organismoNombre: string | null;
  /**
   * Nombre del propietario SI el RUNT lo trae.
   *
   * Riesgo abierto 2 del ADR-0008, y por eso este campo es opcional en el sentido fuerte: hay dos
   * afirmaciones contradictorias en el repo sobre si el RUNT devuelve al propietario
   * (`certificacion-runt.ts:11` dice que no; `soat/refresh.service.ts:111` lo lee de
   * `vehiculo.nombrePropietario`). El canal NO depende de la respuesta: el propietario que se
   * PERSISTE es el que teclea el cliente, y esto viaja solo en la preconsulta, para que el
   * formulario pueda pre-rellenar el nombre cuando exista. Correo, dirección y teléfono no vienen
   * por ninguna vía y siempre los teclea la persona.
   */
  propietarioNombre: string | null;
}

/** Primer alias con valor útil. El RUNT no es consistente con los nombres de sus campos. */
function alias(fuente: Record<string, unknown> | null, claves: readonly string[]): string | null {
  if (!fuente) return null;
  for (const k of claves) {
    const v = fuente[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length > 0 && s.toLowerCase() !== 'null') return s;
  }
  return null;
}

/**
 * Los diez campos del canal, a partir de la respuesta cruda.
 *
 * Los seis primeros salen de `extraerVehiculoRunt`, que es el extractor que ya resuelve los alias
 * del RUNT y está verificado contra una consulta real (`certificacion-runt.ts`). NO se reescribe:
 * duplicar las cadenas de alias es garantizar que dentro de un mes digan cosas distintas. Los
 * cuatro que faltan —cilindraje, servicio, organismo y propietario— no están en `DatosVehiculoRunt`
 * porque la certificación de impuestos no los compara, y se leen aquí con el mismo criterio.
 */
export function extraerDatosCanal(data: unknown): DatosRuntCanal {
  const d = (data ?? {}) as Record<string, unknown>;
  const veh = (d.vehiculo ?? null) as Record<string, unknown> | null;
  const tec = (d.datosTecnicos ?? null) as Record<string, unknown> | null;
  const base = extraerVehiculoRunt(data);

  return {
    ...base,
    cilindraje: alias(veh, ['cilindraje', 'cilindrada']) ?? alias(tec, ['cilindraje', 'cilindrada']),
    tipoServicio: alias(veh, ['tipoServicio', 'servicio', 'nombreServicio'])
      ?? alias(tec, ['tipoServicio', 'servicio', 'nombreServicio']),
    organismoNombre: alias(veh, ['organismoTransito', 'organismoTransitoNombre', 'nombreOrganismoTransito']),
    propietarioNombre: alias(veh, ['nombrePropietario', 'propietario', 'nombreTitular']),
  };
}

/**
 * ¿El RUNT dice que este vehículo YA tiene SOAT vigente? (AC3)
 *
 * Se delega en `derivePreflightChecks`, que es la función PURA con la que el pre-vuelo de trámites
 * lee esa misma vigencia desde 2025 —estado textual, fecha de vencimiento y sus alias— en vez de
 * escribir aquí una segunda regla. Dos lecturas de la misma vigencia acaban discrepando, y la que
 * discrepara aquí compraría un SOAT que el vehículo ya tiene.
 *
 * Solo `status === 'ok'` bloquea. `fail` es «lo tuvo y está vencido», que es precisamente el caso
 * que este canal existe para atender, y `unknown` es «el RUNT no reporta póliza»: bloquear con una
 * respuesta no concluyente dejaría al cliente sin poder pedir un SOAT que necesita.
 */
export function soatVigenteSegunRunt(respuestaRunt: unknown): boolean {
  const { checks } = derivePreflightChecks({ vehiculoResp: respuestaRunt as { ok?: boolean; data?: unknown } });
  return checks.find((c) => c.key === 'soat')?.status === 'ok';
}

/**
 * La fecha hasta la que el RUNT dice que la póliza está vigente, en `yyyy-mm-dd`, o `null`.
 *
 * ── Por qué es una función aparte de `soatVigenteSegunRunt` ─────────────────────────────────────
 *
 * Son dos preguntas distintas y conviene que no se mezclen: aquella decide SI bloquea —y esa REGLA
 * se delega entera en `derivePreflightChecks`, que ya la sabe leer por estado y por fecha—, y esta
 * solo copia un dato para que el modal pueda decir hasta cuándo. Fundirlas obligaría a que la regla
 * devolviera una estructura, y el día que el pre-vuelo cambie su forma se llevaría por delante al
 * canal.
 *
 * **No se saca del `message` del check**, que es donde ya está escrita («SOAT vigente hasta …»):
 * parsear la prosa de otro módulo es exactamente el modo de fallo que este campo viene a quitarle a
 * la pantalla. Se leen los mismos alias que lee el pre-vuelo (`fechaVencimSoat` / `fechaVencimiento`)
 * sobre el mismo objeto.
 *
 * ── Y por qué normaliza a `yyyy-mm-dd` ──────────────────────────────────────────────────────────
 *
 * El RUNT manda `dd/MM/yyyy` casi siempre e ISO a veces. `yyyy-mm-dd` es la forma en la que este
 * producto pasa fechas de CALENDARIO por la API, y es la que la web sabe rotular en español; pasar
 * el texto crudo dejaría el modal escribiendo «vigente hasta el 01/02/2027» en una pantalla donde
 * todo lo demás dice «1 de febrero de 2027». Normalizar no es inventar: es el mismo día.
 *
 * Lo que NO hace, y es la mitad del contrato: si el RUNT no manda fecha —reporta la vigencia solo
 * por estado, que es un caso frecuente y legítimo— o manda algo que no es una fecha, devuelve `null`
 * y el 409 sale SIN el campo. Ninguna fecha por defecto, ningún «hoy + un año».
 */
export function fechaVencimientoSoatRunt(data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const bruto = Array.isArray(d.soat) ? d.soat[0] : d.soat;
  const soat = (bruto ?? null) as Record<string, unknown> | null;
  const valor = alias(soat, ['fechaVencimSoat', 'fechaVencimiento']);
  if (!valor) return null;

  // ISO (con o sin hora): se queda con el día.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor);
  if (iso) return fechaValida(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // `dd/MM/yyyy` y `dd-MM-yyyy`, que es como la manda la pasarela.
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(valor.trim());
  if (dmy) return fechaValida(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  return null;
}

/** `yyyy-mm-dd` si los tres números son un día del calendario; `null` si no. */
function fechaValida(anio: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || anio < 1900 || anio > 2200) return null;
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  // Rechaza el 31 de febrero y compañía: `Date` los desborda al mes siguiente en silencio.
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

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
 * radica tiene que saber que el vehículo YA tiene una solicitud, incluida una **rechazada**, cuya
 * subsanación edita esa misma fila (HU #11915) en vez de crear una segunda.
 *
 * ── El 409 va RECORTADO cuando la fila es de otra compañía, y eso es una frontera ───────────────
 *
 * Un `cliente` puede sondear VINs: son 17 caracteres, pero los de una flota son consecutivos. Si la
 * respuesta contara el estado —o distinguiera «existe y está rechazada» de «existe»— cada intento
 * respondería una pregunta sobre la cartera de OTRA compañía, que es exactamente la fuga que el
 * aislamiento de la HU #11913 pasó dos rondas cerrando. Así que:
 *
 *   · fila de SU compañía → `propia: true` + `id` + `estado`, y el texto que le dice qué hacer
 *     (abrir la suya, o subsanarla si está rechazada). Es información que ya podía ver en su cola.
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
    existente.estado === EstadoSoat.RECHAZADA
      ? 'Esta solicitud ya existe y fue rechazada. Corríjala desde su detalle: se subsana la misma solicitud, no se crea otra.'
      : 'Este vehículo ya tiene un SOAT en FLITO. Un vehículo no puede tener dos (RN-01).',
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
  organismoCodigo: string;
}

/**
 * Consulta el RUNT y traduce cada forma de «no» en un error TIPADO (AC2 y AC3).
 *
 * Ninguno de estos casos crea la solicitud, y ninguno es un 500: el formulario tiene que poder
 * reintentar (RUNT caído) o corregir (organismo fuera de catálogo) sin perder lo tecleado, y para
 * eso necesita saber cuál de los cuatro le pasó.
 */
async function consultarRunt(placa: string, vin: string): Promise<ResultadoRunt> {
  // Con VIN no hace falta el documento del propietario: la pasarela lo exige solo cuando se
  // consulta por placa. Se mandan los dos porque el AC1 pide consultar con placa Y VIN.
  const respuesta = await consultarVehiculoRunt(placa, vin) as { ok?: boolean; data?: unknown; message?: string };
  if (!respuesta?.ok) {
    throw fallo(503, CodigoErrorSolicitudSoat.RUNT_NO_DISPONIBLE,
      'No fue posible consultar el RUNT en este momento. Intenta de nuevo en unos minutos.');
  }
  // Una placa o un VIN que el RUNT no conoce responden `ok:true` con todo en null salvo el
  // identificador que se consultó — es el eco de la pregunta. Sin esta guarda, la solicitud se
  // crearía con marca, línea y organismo vacíos y nadie sabría de dónde salió.
  if (runtSinRegistro(respuesta.data)) {
    throw fallo(422, CodigoErrorSolicitudSoat.RUNT_SIN_REGISTRO,
      'El RUNT no tiene registrado un vehículo con esa placa y ese VIN. Revisa los datos.');
  }
  if (soatVigenteSegunRunt(respuesta)) {
    // La fecha viaja como campo propio y SOLO si el RUNT la trajo: el modal tiene dos redacciones —
    // con fecha y sin ella— y la de sin fecha no es un caso degradado, es la que corresponde cuando
    // la pasarela reporta la vigencia por estado. Interpolar un hueco vacío sería peor que no
    // decirlo. Es el vehículo por el que pregunta su propia compañía, así que no hay frontera que
    // cruzar aquí: lo único que se le devuelve es lo que el RUNT acaba de responderle.
    const fechaVencimiento = fechaVencimientoSoatRunt(respuesta.data);
    throw fallo(409, CodigoErrorSolicitudSoat.SOAT_VIGENTE,
      'El RUNT reporta que este vehículo ya tiene un SOAT vigente. No se puede solicitar otro.',
      fechaVencimiento ? { fechaVencimiento } : undefined);
  }

  const datos = extraerDatosCanal(respuesta.data);
  const organismoCodigo = await resolverOrganismo(datos.organismoNombre);
  return { datos, organismoCodigo };
}

/**
 * El organismo del RUNT, traducido a código DIVIPOLA y comprobado contra la tabla (AC2).
 *
 * Son DOS comprobaciones y las dos hacen falta: `resolverCodigoOrganismoFlit` cruza el nombre contra
 * el catálogo nacional de shared-types, y `organismos_transito_config` es la tabla a la que apunta
 * la FK de `flito_soat.organismo_codigo`. Un código del catálogo que no esté configurado en esta
 * instalación haría fallar el INSERT con un 23503 — un 500 genérico donde el AC pide un error
 * accionable.
 */
async function resolverOrganismo(nombre: string | null): Promise<string> {
  const codigo = resolverCodigoOrganismoFlit({ nombre });
  if (codigo) {
    const [fila] = await db.select({ codigo: organismosTransitoConfig.codigo })
      .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
    if (fila) return fila.codigo;
  }
  // `organismoNombre` va como CAMPO y no solo dentro de la frase. La pantalla necesita el dato para
  // componer su propio texto («El RUNT lo reporta en X, que aún no está habilitado»), y sacarlo de
  // las comillas del mensaje ata una redacción a una expresión regular: el día que alguien corrija
  // la frase, la UI deja de encontrarlo sin que ningún test se entere. `null` cuando el RUNT no
  // reporta organismo —que es la OTRA variante del copy— y la clave viaja igualmente, para que
  // «no vino» se distinga de «no lo mandaron».
  throw fallo(422, CodigoErrorSolicitudSoat.ORGANISMO_NO_CATALOGADO,
    `El organismo de tránsito que reporta el RUNT${nombre ? ` («${nombre}»)` : ''} no está en el catálogo de FLITO. Escríbenos para habilitarlo.`,
    { organismoNombre: nombre ?? null });
}

// ───────────────────────────── Preconsulta ──────────────────────────────────

export interface Preconsulta {
  vehiculo: Omit<DatosRuntCanal, 'organismoNombre' | 'propietarioNombre'>;
  organismo: { codigo: string; nombre: string | null };
  /** Solo el nombre, y solo si el RUNT lo trajo. Ver `DatosRuntCanal.propietarioNombre`. */
  propietario: { nombreCompleto: string } | null;
}

/**
 * Paso 1 del alta: el cliente escribe placa y VIN y ve lo que el RUNT sabe del vehículo, antes de
 * teclear al propietario y de adjuntar nada.
 *
 * Aplica EXACTAMENTE las mismas guardas que el alta —canal encendido, RN-01, RUNT, SOAT vigente,
 * organismo— y en el mismo orden, a propósito: si la preconsulta fuera más laxa, el formulario
 * dejaría llenar diez campos y adjuntar un PDF para fallar al final; si fuera más estricta,
 * bloquearía altas legítimas. Y no escribe NADA: es una lectura.
 */
export async function preconsulta(placa: string, vin: string, ctx: SoatCtx): Promise<Preconsulta> {
  const canal = await canalDeLaCompania(ctx);
  const placaNorm = normalizarId(placa);
  const vinNorm = normalizarId(vin);
  await verificarRn01(vinNorm, canal.companiaId);
  // La misma guarda de tenencia que el alta, y en el mismo sitio: si la preconsulta fuera más laxa,
  // el formulario dejaría llenar los diez campos y adjuntar el PDF para fallar al final. No entrega
  // información de más — el 409 es idéntico al de la RN-01 ajena, sin id y sin estado.
  await verificarTenenciaVehiculo(vinNorm, canal.companiaId);
  const { datos, organismoCodigo } = await consultarRunt(placaNorm, vinNorm);

  const [organismo] = await db.select({ alias: organismosTransitoConfig.alias })
    .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, organismoCodigo)).limit(1);

  return {
    vehiculo: {
      // La placa y el VIN que se devuelven son los NORMALIZADOS de la petición y no el eco del
      // RUNT: son los que se van a persistir, y enseñar otros sería enseñar algo que no se guardó.
      placa: placaNorm,
      vin: vinNorm,
      marca: datos.marca, linea: datos.linea, modelo: datos.modelo, clase: datos.clase,
      cilindraje: datos.cilindraje, tipoServicio: datos.tipoServicio,
    },
    organismo: { codigo: organismoCodigo, nombre: organismo?.alias ?? null },
    propietario: datos.propietarioNombre ? { nombreCompleto: datos.propietarioNombre } : null,
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
 *     venta adjunta, y cuya solicitud nace en `pendiente_revision` para que una persona la valide.
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
  entrada: { placa: string; vin: string },
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
  const [existente] = await tx.select({ id: vehicles.id, clientId: vehicles.clientId }).from(vehicles)
    .where(eq(vehicles.vin, entrada.vin)).limit(1);

  if (esDeOtraCompania(existente, companiaId)) throw vehiculoAjeno();

  if (existente) {
    // `== null` por lo mismo que el predicado de tenencia, y tiene que ser la MISMA laxitud: si aquí
    // se comparara estricto, una ficha cuyo dueño llega vacío no sería «ajena» —así que el alta
    // seguiría— pero tampoco se adoptaría, y volvería a quedar sin dueño para el siguiente. Las dos
    // decisiones se toman sobre el mismo hecho y tienen que leerlo igual.
    const adopta = existente.clientId == null;
    await tx.update(vehicles).set({
      ...(adopta ? { clientId: companiaId } : {}),
      plate: entrada.placa,
      ...(datos.marca ? { brand: datos.marca } : {}),
      ...(datos.linea ? { model: datos.linea } : {}),
      ...(year !== null ? { year } : {}),
      ...(datos.clase ? { vehicleClass: datos.clase } : {}),
      ...(datos.cilindraje ? { cilindraje: datos.cilindraje } : {}),
      ...(datos.tipoServicio ? { tipoServicio: datos.tipoServicio } : {}),
      ownerName: propietario.nombreCompleto,
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

  const [creado] = await tx.insert(vehicles).values({
    vin: entrada.vin, plate: entrada.placa, clientId: companiaId,
    brand: datos.marca, model: datos.linea, year, vehicleClass: datos.clase,
    cilindraje: datos.cilindraje, tipoServicio: datos.tipoServicio,
    ownerName: propietario.nombreCompleto, ownerDocument: propietario.numeroDocumento,
  }).returning({ id: vehicles.id });
  return creado.id;
}

/** Código de violación de unicidad de PostgreSQL. Aquí solo puede venir del VIN o del vehículo. */
const UNIQUE_VIOLATION = '23505';

export interface SolicitudCreada {
  id: string;
  estado: EstadoSoat;
}

/**
 * El alta del canal Cliente: crear ES enviar (AC1). No hay borrador.
 *
 * ── El orden de los pasos es la mitad del diseño ─────────────────────────────────────────────────
 *
 *   1. Canal encendido y compañía del usuario — lo más barato y lo que más veces va a fallar.
 *   2. El adjunto es un PDF de verdad — antes de gastar una consulta al RUNT.
 *   3. RN-01 — antes de consultar el RUNT y ANTES de subir el archivo: un VIN repetido no debe dejar
 *      un objeto huérfano en el bucket.
 *   4. RUNT: disponible, con registro, sin SOAT vigente, con organismo catalogado.
 *   5. Subida a S3 — fuera de la transacción, como `cargarFactura()` (CA-11): una llamada de red
 *      dentro de una transacción la mantiene abierta el tiempo que tarde el bucket.
 *   6. La transacción: vehículo, SOAT, propietario, satélite, soporte e historial, todo o nada.
 *
 * El `id` del SOAT se genera AQUÍ y no lo pone la base, y no es capricho: la clave de storage se
 * nombra con él, y sin conocerlo antes habría que nombrar el objeto con la placa o el VIN —los dos
 * son cuasi-PII (AGENTS.md §14) y acabarían en una ruta de bucket que se lee en cualquier consola—,
 * o subir el archivo después y dejar la fila sin soporte si esa subida falla.
 */
export async function crearSolicitud(
  entrada: EntradaSolicitud,
  archivo: ArchivoSolicitud,
  ctx: SoatCtx,
): Promise<SolicitudCreada> {
  const canal = await canalDeLaCompania(ctx);
  await verificarPdfReal(archivo);

  const placa = normalizarId(entrada.placa);
  const vin = normalizarId(entrada.vin);
  await verificarRn01(vin, canal.companiaId);
  // Y la ficha de `vehicles`, que es OTRO conjunto: hay vehículos sin SOAT que sí tienen dueño.
  await verificarTenenciaVehiculo(vin, canal.companiaId);

  const { datos, organismoCodigo } = await consultarRunt(placa, vin);

  const soatId = randomUUID();
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  const storageKey = await uploadEntityDocument(
    carpetaDe({ id: canal.companiaId, flitoCarpetaStorage: canal.carpetaStorage }, 'soat/facturas-venta'),
    soatId, archivo.originalname, archivo.buffer, archivo.mimetype,
  );

  try {
    await db.transaction(async (tx) => {
      const vehiculoId = await upsertVehiculoRunt(tx, { placa, vin }, datos, entrada.propietario, canal.companiaId, ctx, soatId);

      await tx.insert(flitoSoat).values({
        id: soatId,
        vin,
        vehiculoId,
        // Los dos valores que definen el canal. `pendiente_revision` y NO `pendiente`: esa es la
        // razón de que el estado exista (ADR-0008 §2), porque `POST /enviar` filtra por `pendiente`
        // y despacharía al gestor una solicitud que nadie ha validado.
        origen: 'cliente',
        estado: EstadoSoat.PENDIENTE_REVISION,
        // La compañía del USUARIO, no un campo del formulario: el cliente no elige para quién
        // radica.
        companiaId: canal.companiaId,
        // Del RUNT, no tecleado (AC1).
        organismoCodigo,
      });

      // El propietario va a `flito_compradores` con `soat_id` puesto y `tramite_id` en null — el
      // CHECK `flito_compradores_padre_chk` exige uno y solo uno. Está aquí y no en una tabla nueva
      // porque es donde el término de búsqueda de la cola ya lo interroga (ADR-0008 §1.3).
      await tx.insert(flitoCompradores).values({
        soatId,
        nombreCompleto: entrada.propietario.nombreCompleto,
        numeroDocumento: entrada.propietario.numeroDocumento,
        tipoDocumento: entrada.propietario.tipoDocumento,
        correo: entrada.propietario.correo ?? null,
        celular: entrada.propietario.celular ?? null,
        direccion: entrada.propietario.direccion ?? null,
        orden: 0,
      });

      await tx.insert(flitoSoatSolicitud).values({
        soatId,
        solicitadoPorId: ctx.userId,
        // El nombre es el rastro durable, igual que en `flito_soportes.subido_por_nombre`.
        solicitadoPorNombre: ctx.username,
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

      // El alta también es un cambio de estado: sin esta fila, el historial de una solicitud del
      // canal empezaría en su primera revisión y nadie sabría cuándo ni quién la radicó. Participa
      // de la MISMA transacción a propósito (`registrarCambio` recibe el ejecutor): un estado sin su
      // fila de historial es justo el agujero que esa función existe para tapar.
      await registrarCambio(tx, {
        concepto: ConceptoHistorial.SOAT,
        registroId: soatId,
        estadoAnterior: null,
        estadoNuevo: EstadoSoat.PENDIENTE_REVISION,
        usuarioId: ctx.userId,
        usuarioEmail: ctx.username,
        origen: 'usuario',
      });
    });
  } catch (e) {
    // La ÚLTIMA línea de RN-01, y la única que sostiene la regla cuando dos peticiones con el mismo
    // VIN corren a la vez: entre el `verificarRn01` de arriba y este INSERT cabe otra petición
    // entera, y quien decide es el UNIQUE de la base. Se traduce al mismo 409 que la comprobación
    // previa para que el formulario reciba una sola respuesta a una sola pregunta.
    if ((e as { code?: string })?.code === UNIQUE_VIOLATION) {
      // Sin `propia`: la carrera la pierde quien llega segundo y no se ha leído la fila ganadora.
      // Decir «no es tuya» sería mentir la mitad de las veces, y consultarla ahora para saberlo
      // convertiría una carrera perdida en una consulta más. `propia: false` es lo prudente: el
      // front enseña el mensaje y no ofrece abrir nada.
      throw fallo(409, CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT,
        'Este vehículo ya tiene un SOAT en FLITO. Un vehículo no puede tener dos (RN-01).',
        { propia: false });
    }
    throw e;
  }

  return { id: soatId, estado: EstadoSoat.PENDIENTE_REVISION };
}
