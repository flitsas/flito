// FLITO — SOAT, canal Cliente (lógica). Feature #11912, HU #11914 (alta) y #11915 (revisión).
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
// ── El ciclo completo del canal, y dónde acaba ───────────────────────────────────────────────────
//
//   POST /cliente              (#11914) — nace en `pendiente_revision`.
//   POST /:id/validar          (#11915) — el ADMIN la manda a `solicitado`, REUSANDO
//                                         `enviarAlGestor()` con otro estado de partida (AC1).
//   POST /:id/rechazar-solicitud (#11915) — el ADMIN la manda a `rechazada` con causal del catálogo
//                                         general MÁS observación, las dos obligatorias (AC2).
//   PATCH /:id/solicitud       (#11915) — el CLIENTE corrige y reenvía la MISMA fila, que vuelve a
//                                         `pendiente_revision` (AC3).
//
// De ahí en adelante el SOAT es indistinguible de uno nacido de trámite: `solicitado → pagado` por
// el OCR de la factura (RN-03) es la vía de siempre y no la toca nadie de aquí.
//
// ── Lo que este módulo NO hace ───────────────────────────────────────────────────────────────────
//
// No toca el ciclo del SOAT nacido de TRÁMITE, que sigue exactamente igual: las tres transiciones de
// arriba exigen `origen = 'cliente'` y responden 409 sobre cualquier otra fila. Y no es una
// comprobación decorativa: un `cliente` ve en su cola todos los SOAT de su compañía —también los
// que creó el sync— y un `admin` los ve todos, así que sin ese guarda la ruta de validar sería una
// segunda puerta a `solicitado` que se salta `POST /enviar` y su destino explícito.
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
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  auditLogs,
  clients,
  flitoCompradores,
  flitoSoat,
  flitoSoatCausalesRechazo,
  flitoSoatSolicitud,
  flitoSoportes,
  organismosTransitoConfig,
  vehicles,
} from '../../db/schema.js';
import {
  type CausalRechazoSoat,
  CodigoErrorSolicitudSoat,
  ESTADO_SOAT_LABEL,
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
import {
  buscarConAcceso, enviarAlGestor, ORIGEN_CLIENTE,
  type DestinoEnvio, type SoatCtx,
} from './flito-soat.service.js';

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
  //
  // ── `FOR UPDATE`: la relectura no solo tiene que ser autoritativa, tiene que ser ESTABLE ────────
  //
  // Cierre de la carga LOW que la auditoría de seguridad de la HU #11914 dejó para la #11915. Sin el
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
        origen: ORIGEN_CLIENTE,
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
      // `propia: false`: la carrera la pierde quien llega segundo y no se ha leído la fila ganadora.
      // Decir «no es tuya» sería mentir la mitad de las veces, y consultarla ahora para saberlo
      // convertiría una carrera perdida en una consulta más. Es lo prudente: el front enseña el
      // mensaje y no ofrece abrir nada.
      //
      // ── Y el TEXTO es el mismo que el del vehículo ajeno, no uno propio ──────────────────────────
      //
      // Cierre de la segunda carga LOW de la auditoría de la #11914. Con una frase distinta, este
      // 409 era distinguible del de `vehiculoAjeno()`, y esa diferencia es un ORÁCULO: sondeando
      // VINes, dos intentos separaban «ese vehículo ya tiene SOAT» de «ese vehículo existe en FLITO
      // sin SOAT», que son dos hechos sobre la cartera de otra compañía. Los tres caminos que
      // acaban en «no es tuyo y no puedes» —VIN con SOAT ajeno, ficha de `vehicles` ajena y carrera
      // perdida— comparten ahora código, cuerpo y frase, así que ninguno responde una pregunta que
      // los otros dos no respondan.
      throw vehiculoAjeno();
    }
    throw e;
  }

  return { id: soatId, estado: EstadoSoat.PENDIENTE_REVISION };
}

// ═════════════════ Revisión del admin, rechazo y subsanación (HU #11915) ═════

/**
 * El catálogo de causales, tal como lo ofrece la pantalla del rechazo (AC2).
 *
 * Solo las ACTIVAS: una causal desactivada es una que el negocio retiró, y ofrecerla volvería a
 * escribirla en solicitudes nuevas. El nombre de una causal ya usada sí sigue viajando —lo resuelve
 * el `LEFT JOIN` del detalle contra la tabla, sin pasar por esta lista—, así que desactivar una no
 * deja rechazos viejos sin rótulo.
 *
 * Por `orden` y, a igualdad, por nombre. El desempate no es cosmético: sin él, dos causales con el
 * mismo `orden` bailan entre peticiones y el desplegable cambia de forma sin que nada cambie. Mismo
 * criterio que `listarCausales()` de comparendos, que es el precedente de este catálogo.
 */
export async function listarCausalesRechazo(): Promise<CausalRechazoSoat[]> {
  const filas = await db
    .select({
      id: flitoSoatCausalesRechazo.id,
      nombre: flitoSoatCausalesRechazo.nombre,
      activo: flitoSoatCausalesRechazo.activo,
      orden: flitoSoatCausalesRechazo.orden,
    })
    .from(flitoSoatCausalesRechazo)
    .where(eq(flitoSoatCausalesRechazo.activo, true))
    .orderBy(asc(flitoSoatCausalesRechazo.orden), asc(flitoSoatCausalesRechazo.nombre));
  return filas.map((f) => ({ ...f, orden: Number(f.orden) }));
}

/** Lo que devuelven las tres transiciones: lo mínimo para que la pantalla repinte y recargue. */
export interface ResultadoTransicion {
  id: string;
  estado: EstadoSoat;
}

/**
 * Las TRES guardas que preceden a cualquier transición del canal, en un solo sitio.
 *
 * Están juntas porque separarlas es cómo se olvida una: las tres rutas nuevas necesitan exactamente
 * lo mismo —que la fila exista para quien pregunta, que sea del canal y que esté en el estado desde
 * el que la transición tiene sentido— y con tres copias bastaba con que una se escribiera al revés.
 *
 *   1. `buscarConAcceso()` — 404 y NO 403, que es el contrato que sostiene el aislamiento (ADR-0008
 *      §5). Para el `cliente` aplica además la frontera por compañía; para el `admin` no filtra
 *      nada, que es lo correcto: revisa las de todas.
 *   2. `origen = 'cliente'` — ver la cabecera del módulo. Un SOAT de trámite no entra por aquí.
 *   3. El estado de partida — para poder decir en qué estado SÍ está, que es lo que la pantalla
 *      necesita para redactar su mensaje.
 *
 * ── Lo que esta función NO es, y la frase que hubo que corregir aquí (db-review de la #11915) ────
 *
 * **No es la autoridad sobre la carrera, y decía que lo era.** Este bloque afirmaba que el estado de
 * partida «convierte un doble clic en un 409 en vez de en una segunda transición»; no lo hace,
 * porque la guarda y la escritura son dos viajes distintos a la base. Entre el `SELECT` de aquí y el
 * `UPDATE` de allá cabe otra petición entera: en READ COMMITTED el UPDATE reevalúa su `WHERE` contra
 * la versión ya commiteada por el otro, y un `where id = X` sigue siendo cierto pase lo que pase con
 * el estado. El interleaving concreto que eso permitía: A valida (la fila queda `solicitado`, con
 * proveedor y `enviado_en`) y commitea; B, que había leído `pendiente_revision` un instante antes,
 * espera el lock y **aplica igual** — quedaba un SOAT `rechazada` con proveedor y ya en la cola del
 * gestor, y una fila de historial diciendo `estadoAnterior: 'pendiente_revision'` cuando el estado
 * real anterior era `solicitado`. El historial no quedaba incompleto: quedaba FALSO.
 *
 * Quien decide es `moverEstado()`, aquí debajo. Esto se queda porque sigue haciendo falta para las
 * otras dos guardas y para el MENSAJE: un CAS solo sabe decir «no pude», no «está en Solicitado».
 */
async function solicitudEnEstado(
  id: string, estadoEsperado: EstadoSoat, ctx: SoatCtx,
): Promise<typeof flitoSoat.$inferSelect> {
  const soat = await buscarConAcceso(id, ctx);
  if (!soat) {
    throw fallo(404, CodigoErrorSolicitudSoat.SOLICITUD_NO_ENCONTRADA, 'La solicitud no existe.');
  }
  if (soat.origen !== ORIGEN_CLIENTE) {
    throw fallo(409, CodigoErrorSolicitudSoat.NO_ES_DEL_CANAL,
      'Este SOAT nació de un trámite, no de una solicitud del canal Cliente: su ciclo no pasa por esta acción.');
  }
  if (soat.estado !== estadoEsperado) {
    throw fallo(409, CodigoErrorSolicitudSoat.ESTADO_NO_PERMITE,
      `Esta acción solo aplica a una solicitud en "${ESTADO_SOAT_LABEL[estadoEsperado]}", y esta está en "${ESTADO_SOAT_LABEL[soat.estado as EstadoSoat]}".`,
      { estado: soat.estado });
  }
  return soat;
}

/** El ejecutor de una transacción de drizzle (no hay alias exportado; mismo truco que `flito-sync`). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * La carrera perdida, con el MISMO contrato en las tres transiciones: 409 y «recarga la pantalla».
 *
 * Un solo sitio para que las tres digan lo mismo. `validarSolicitud` ya daba el 409 —lo hereda del
 * `SKIP LOCKED` de `enviarAlGestor`—, y el rechazo y la subsanación no; esa asimetría dentro de la
 * misma HU es la que encontró `db-review-agent`.
 *
 * «Un solo sitio» fue una promesa a medias hasta la #11916: `validarSolicitud` repetía el literal en
 * vez de llamar aquí, así que las tres decían lo mismo por coincidencia y no por construcción. Ahora
 * las TRES llaman a este helper, y por eso el test de la #11916 compara los tres cuerpos entre sí en
 * vez de comparar cada uno contra un texto escrito a mano.
 */
const carreraPerdida = () => fallo(409, CodigoErrorSolicitudSoat.ESTADO_NO_PERMITE,
  'Otra persona acaba de mover esta solicitud. Recarga la pantalla para ver cómo quedó.');

/**
 * Mueve el estado **solo si sigue siendo el que se leyó**: compare-and-swap en un solo viaje.
 *
 * ── Por qué esto y no mover `solicitudEnEstado()` dentro de la transacción con `FOR UPDATE` ──────
 *
 * Las dos formas cierran la carrera y se eligió esta. `buscarConAcceso()` es una función COMPARTIDA
 * —la usan el detalle, el historial, los soportes, la carga de factura y el rechazo del gestor— que
 * consulta con el `db` de módulo y hace `innerJoin` con `clients`; para bloquear desde ella habría
 * que parametrizarle el ejecutor y añadirle un `for('update', { of: flitoSoat })`, es decir, tocar
 * la puerta de acceso de medio módulo para arreglar dos funciones. El radio de ese cambio es mayor
 * que el del fallo. El CAS, en cambio, es local, no toma bloqueos explícitos y hace que la condición
 * y la escritura sean **el mismo statement**, que es la única forma de que no quepa nada entre ellas.
 *
 * ── Qué va en el `WHERE`, y por qué las tres ────────────────────────────────────────────────────
 *
 *   · `id` — la fila.
 *   · `estado = desde` — **la que cierra el bloqueante**. Sin ella el UPDATE es ciego: `id = X` sigue
 *     siendo cierto después de que otro haya movido la fila.
 *   · `origen = 'cliente'` — inmutable (solo la escribe el INSERT del alta), así que no hay carrera
 *     que cerrar aquí; va igualmente para que el statement no dependa de la lectura previa para
 *     NINGUNO de los dos hechos que le importan. Cuesta cero y quita un acoplamiento.
 *
 * ── Y por qué `.returning()` y no el contador de filas del driver ───────────────────────────────
 *
 * `rowCount` viene con la forma que le dé el driver y cambia entre `postgres.js` y `pg`. La fila
 * devuelta no: si vuelve una, se movió; si vuelve ninguna, alguien ganó la carrera. Es además lo que
 * ya hacen `rechazar()`, `reactivar()` y `reversar()` en el módulo hermano.
 *
 * Devuelve `false` en vez de lanzar para que quien llama decida —lanzar desde aquí escondería el
 * `throw` dentro de un helper de dos líneas—, pero **el único desenlace correcto es lanzar**: la
 * transacción tiene que revertirse entera, y por eso esta llamada va la PRIMERA de cada `tx`.
 */
async function moverEstado(tx: Tx, id: string, desde: EstadoSoat, hacia: EstadoSoat, ahora: Date): Promise<boolean> {
  const filas = await tx.update(flitoSoat)
    .set({ estado: hacia, updatedAt: ahora })
    .where(and(
      eq(flitoSoat.id, id),
      eq(flitoSoat.estado, desde),
      eq(flitoSoat.origen, ORIGEN_CLIENTE),
    ))
    .returning({ id: flitoSoat.id });
  return filas.length === 1;
}

/**
 * AC1 — el admin VALIDA: `pendiente_revision` → `solicitado`, el MISMO estado al que llega un SOAT
 * de trámite cuando Operaciones lo envía al gestor.
 *
 * ── Reúso de verdad, no un `update` paralelo ─────────────────────────────────────────────────────
 *
 * Lo pide la HU con estas palabras y es la decisión cara de esta función: se llama a
 * `enviarAlGestor()` —la misma función, el mismo `FOR UPDATE ... SKIP LOCKED`, la misma asignación
 * de destino, la misma fila de historial— pasándole `estadoOrigen: 'pendiente_revision'`. Lo único
 * que cambia entre las dos puertas es de qué estado se parte.
 *
 * Un `UPDATE ... SET estado = 'solicitado'` escrito aquí habría sido más corto y habría divergido en
 * la primera corrección que alguien hiciera en una sola de las dos copias: el día que el envío gane
 * una columna —como ya ganó `proveedor_sobrescrito` y las tres de `gestion_operaciones`—, las
 * solicitudes validadas llegarían al gestor a medio poblar y la cola las mostraría distintas sin que
 * nada fallara.
 *
 * ── Por qué `enviados.length === 0` es un 409 y no un 200 vacío ──────────────────────────────────
 *
 * `enviarAlGestor` no lanza: devuelve `yaEnviados` para poder despachar 200 registros y contar los
 * que se quedaron fuera. Sobre UNO, quedarse fuera solo puede significar que otro admin ganó la
 * carrera —el `SKIP LOCKED` se saltó la fila que aquel bloqueó—, y eso es exactamente lo que el 409
 * cuenta. Responder 200 dejaría a la pantalla creyendo que validó algo que no validó.
 */
export async function validarSolicitud(
  id: string, destino: DestinoEnvio, ctx: SoatCtx,
): Promise<ResultadoTransicion> {
  // El destino es OBLIGATORIO y es UNO. Lo valida además el `refine` de la ruta —igual que el de
  // `POST /enviar`, de donde está calcado— y se repite aquí porque la regla no es de la ruta: un
  // `solicitado` sin proveedor y sin contingencia es un SOAT en la cola de NADIE, sin ANS con el que
  // medirlo. Es exactamente por lo que la HU #10979 hizo obligatorio el proveedor en el envío
  // masivo, y validar una solicitud desemboca en el mismo sitio.
  if (Boolean(destino.proveedorSoatId) === Boolean(destino.gestionOperaciones)) {
    throw fallo(400, CodigoErrorSolicitudSoat.DESTINO_REQUERIDO,
      'Elige el proveedor al que se envía, o marca que la gestiona Operaciones. Una de las dos, no ambas.');
  }
  await solicitudEnEstado(id, EstadoSoat.PENDIENTE_REVISION, ctx);

  const { enviados } = await enviarAlGestor([id], ctx, destino, {
    estadoOrigen: EstadoSoat.PENDIENTE_REVISION,
    motivo: destino.gestionOperaciones
      ? 'Solicitud validada: pasa a gestión de Operaciones'
      : 'Solicitud validada: pasa al gestor',
  });

  // Llama al helper y no repite el literal: su docblock promete «un solo sitio para que las tres
  // digan lo mismo» y esa frase era falsa en la letra —esta rama tenía su propia copia del texto, y
  // dos copias divergen en cuanto alguien mejore una—. Corregido en la #11916.
  if (enviados.length === 0) throw carreraPerdida();

  // El satélite guarda QUIÉN revisó y CUÁNDO. Va fuera de la transacción de `enviarAlGestor` y no
  // dentro, y es un tradeoff consciente: meterlo dentro exigiría abrirle a esa función un `hook` de
  // escritura arbitraria —o duplicarla— para un dato que no participa de ninguna regla. Si esta
  // segunda escritura fallara, la solicitud quedaría validada y en la cola del gestor, que es su
  // estado correcto, con el revisor sin anotar; el historial de `enviarAlGestor` sí lo tiene, con su
  // usuario y su instante, así que el rastro no se pierde en ningún caso.
  await db.update(flitoSoatSolicitud).set({
    revisadoPorId: ctx.userId,
    revisadoPorNombre: ctx.username,
    revisadoEn: new Date(),
    updatedAt: new Date(),
  }).where(eq(flitoSoatSolicitud.soatId, id));

  return { id, estado: EstadoSoat.SOLICITADO };
}

/** Lo que el admin escribe al rechazar. Las DOS obligatorias (AC2). */
export interface EntradaRechazo {
  causalId: string;
  observacion: string;
}

/**
 * AC2 — el admin RECHAZA: `pendiente_revision` → `rechazada`, con causal del catálogo general Y
 * observación. Sin una de las dos, **el estado no cambia y no se escribe nada**.
 *
 * ── El orden de las comprobaciones ES el AC ──────────────────────────────────────────────────────
 *
 * «No se escribe nada» no es una consecuencia de que falle el UPDATE: es que las cuatro guardas
 * —acceso, canal, estado, y las dos entradas— corren ANTES de abrir la transacción. Un rechazo que
 * validara la causal dentro de la transacción cumpliría el AC por accidente (el ROLLBACK) y dejaría
 * de cumplirlo el día que alguien moviera una escritura fuera.
 *
 * ── Por qué la causal se comprueba contra la TABLA y con `activo = true` ─────────────────────────
 *
 * Un uuid cualquiera pasaría el `z.string().uuid()` de la ruta y llegaría hasta la FK, que respondería
 * 23503 → 500. El AC pide «causal válida del catálogo», y válida incluye VIGENTE: una causal
 * desactivada es una que el negocio retiró, y aceptarla por id —cuando la pantalla ya no la ofrece—
 * convertiría el catálogo en una lista de sugerencias.
 *
 * ── Lo que NO se escribe: `flito_soat.motivo_rechazo` ────────────────────────────────────────────
 *
 * Esa columna es el rechazo del GESTOR (`POST /:id/rechazar`, destino `con_novedad`): otro actor,
 * otro estado y otra audiencia. Mezclarlos haría ilegible el historial de una fila que pase por los
 * dos, y es el error que el ADR-0008 §1.2 previene con la tabla satélite.
 */
export async function rechazarSolicitud(
  id: string, entrada: EntradaRechazo, ctx: SoatCtx,
): Promise<ResultadoTransicion> {
  // No se guarda lo que devuelve: desde el CAS, el estado de partida que se ESCRIBE es el que la
  // base confirmó, no el que trajo esta lectura. Esta llamada sigue aquí por las otras dos guardas
  // (404 y `no_es_del_canal`) y por el mensaje, que necesita saber en qué estado está de verdad.
  await solicitudEnEstado(id, EstadoSoat.PENDIENTE_REVISION, ctx);

  const observacion = entrada.observacion?.trim() ?? '';
  if (!observacion) {
    throw fallo(400, CodigoErrorSolicitudSoat.OBSERVACION_REQUERIDA,
      'El rechazo exige una observación que explique qué hay que corregir.');
  }

  const [causal] = await db
    .select({ id: flitoSoatCausalesRechazo.id, nombre: flitoSoatCausalesRechazo.nombre })
    .from(flitoSoatCausalesRechazo)
    .where(and(
      eq(flitoSoatCausalesRechazo.id, entrada.causalId),
      eq(flitoSoatCausalesRechazo.activo, true),
    ))
    .limit(1);
  if (!causal) {
    throw fallo(400, CodigoErrorSolicitudSoat.CAUSAL_INVALIDA,
      'La causal de rechazo no está en el catálogo, o ya no está activa.');
  }

  const ahora = new Date();
  await db.transaction(async (tx) => {
    // PRIMERO y condicionado: si otro admin ya movió la fila, aquí se corta y la transacción entera
    // se revierte — sin causal escrita encima de la suya y sin una fila de historial que mienta
    // sobre el estado del que venía.
    if (!await moverEstado(tx, id, EstadoSoat.PENDIENTE_REVISION, EstadoSoat.RECHAZADA, ahora)) {
      throw carreraPerdida();
    }

    await tx.update(flitoSoatSolicitud).set({
      causalRechazoId: causal.id,
      observacionRechazo: observacion,
      revisadoPorId: ctx.userId,
      revisadoPorNombre: ctx.username,
      revisadoEn: ahora,
      updatedAt: ahora,
    }).where(eq(flitoSoatSolicitud.soatId, id));

    // En la MISMA transacción que el estado, como el resto del módulo: un estado sin su fila de
    // historial es justo el agujero que `registrarCambio` existe para tapar.
    //
    // El motivo lleva el NOMBRE de la causal y NO la observación. La causal es un valor de catálogo
    // —lo mismo para todas las solicitudes que la usen— mientras que la observación es texto libre
    // escrito sobre un caso concreto y puede nombrar al propietario o su documento; el historial se
    // le sirve al `cliente` (con recortes, `historialDe(..., lectorExterno)`) y a auditoría, así que
    // no es sitio para PII que ya vive en su columna y que el detalle entrega con proyección.
    await registrarCambio(tx, {
      concepto: ConceptoHistorial.SOAT,
      registroId: id,
      // Idem: lo que el CAS comprobó, no lo que la lectura previa trajo.
      estadoAnterior: EstadoSoat.PENDIENTE_REVISION,
      estadoNuevo: EstadoSoat.RECHAZADA,
      motivo: `Rechazo de la solicitud: ${causal.nombre}`,
      usuarioId: ctx.userId,
      usuarioEmail: ctx.username,
      origen: 'usuario',
    });
  });

  return { id, estado: EstadoSoat.RECHAZADA };
}

/**
 * Lo que el CLIENTE puede corregir al subsanar, y por qué esta lista es tan corta (AC3).
 *
 * ── Editable: el propietario ─────────────────────────────────────────────────────────────────────
 *
 * Son los seis campos que una persona TECLEA en el alta, y por tanto los únicos en los que puede
 * haberse equivocado. Dos de las CINCO causales sembradas hablan justo de ellos —«Los datos del
 * propietario no coinciden con la factura de venta» y «Faltan datos de contacto del propietario»—,
 * así que sin poder editarlos la subsanación no podría atender dos de cada cinco rechazos.
 *
 * ── Editable: la factura de venta (opcional) ─────────────────────────────────────────────────────
 *
 * Otras dos son sobre el adjunto —«Factura de venta ilegible» y «La factura de venta no corresponde
 * al vehículo»—, y la quinta («Se necesita otro documento») acaba casi siempre en lo mismo. Va como
 * opcional porque un rechazo por datos del propietario no obliga a volver a subir un PDF correcto.
 *
 * ── NO editable: el VIN. Esta es la decisión que sostiene la RN-01 ───────────────────────────────
 *
 * Cambiar el VIN convertiría la subsanación en un ALTA ENCUBIERTA: la fila conserva su `id`, su
 * `vehiculo_id` y su historial, pero pasaría a hablar de OTRO vehículo — uno para el que nadie
 * comprobó la RN-01 (¿ya tiene SOAT?), nadie consultó el RUNT (¿existe?, ¿tiene SOAT vigente?, ¿qué
 * organismo?), nadie comprobó la tenencia (¿la ficha de `vehicles` es de otra compañía?) y cuyo
 * `organismo_codigo` —que decide a qué proveedor acaba yendo el caso— seguiría siendo el del
 * vehículo viejo. El UNIQUE de `flito_soat.vin` ni siquiera saltaría si el VIN nuevo no tuviera
 * SOAT. Un vehículo equivocado no se subsana: se abandona esa solicitud y se radica la correcta.
 *
 * ── NO editable: la placa ────────────────────────────────────────────────────────────────────────
 *
 * Por lo mismo, en menor grado: placa y VIN se consultaron al RUNT COMO PAREJA y la placa vive en
 * `vehicles`, que es una tabla compartida entre compañías. Dejar que la subsanación la reescriba
 * reabriría —por otra puerta— el camino de escritura sobre ficha ajena que el bloqueante de la
 * #11914 cerró.
 *
 * ── NO se toca `vehicles.owner_name` / `owner_document` ──────────────────────────────────────────
 *
 * El alta los escribe; la subsanación no. Es deliberado y tiene coste: si el cliente corrige el
 * nombre del propietario, la ficha del vehículo conserva el viejo. Se acepta porque la fuente de
 * verdad del propietario PARA ESTA SOLICITUD es `flito_compradores` —es lo que leen la cola, el
 * detalle y la búsqueda por propietario, y es lo que el admin revisa—, mientras que `vehicles` es
 * una tabla compartida cuya escritura desde este canal acaba de ser un bloqueante de seguridad.
 * Ampliarla a una segunda ruta no es alcance de esta HU, y queda dicho en vez de descubierto.
 */
export interface EntradaSubsanacion {
  propietario: PropietarioSolicitud;
}

/**
 * AC3 — el CLIENTE subsana: `rechazada` → `pendiente_revision`, sobre LA MISMA FILA.
 *
 * Mismo `id`, mismo VIN, mismo `vehiculo_id`, mismo historial. **Cero INSERT en `flito_soat`**: esa
 * es la mitad del AC y es lo que el índice `flito_soat.vin UNIQUE` habría impedido de todas formas,
 * pero con un 500 en vez de con un ciclo.
 *
 * ── Qué se limpia del rechazo, y por qué TODO ────────────────────────────────────────────────────
 *
 * Causal, observación, revisor y fecha de revisión se ponen a `null` en el mismo movimiento. Son las
 * cuatro caras del mismo hecho —«esta solicitud fue devuelta»— y ese hecho deja de ser cierto en el
 * instante en que vuelve a la cola de revisión. Dejar la causal y borrar solo el estado le pondría
 * al admin una solicitud «pendiente de revisión» con un rechazo pegado que ya no aplica, y al cliente
 * una pantalla que sigue pidiéndole que corrija lo que acaba de corregir. Lo que pasó no se pierde:
 * el historial guarda las dos transiciones con su motivo y `reenvios` cuenta las vueltas.
 *
 * ── El adjunto: la anterior se DESCARTA, no se borra ─────────────────────────────────────────────
 *
 * `idx_flito_soportes_soat_factura_venta` es único sobre `soat_id` con `descartado = false`, así que
 * insertar la nueva sin descartar la vieja moriría con 23505. Se marca `descartado = true` y se
 * inserta: la vieja sigue existiendo —es la que el admin vio cuando rechazó, y sin ella no se puede
 * auditar por qué lo hizo— y solo la nueva queda viva.
 */
export async function subsanarSolicitud(
  id: string,
  entrada: EntradaSubsanacion,
  archivo: ArchivoSolicitud | null,
  ctx: SoatCtx,
): Promise<ResultadoTransicion> {
  // El canal tiene que seguir encendido: subsanar es radicar otra vez, y una compañía a la que se le
  // cerró el canal no debe poder reabrir por la puerta de atrás lo que ya no puede abrir por la
  // principal. Además es de donde sale la carpeta de storage del adjunto nuevo.
  const canal = await canalDeLaCompania(ctx);
  // Igual que en el rechazo: se llama por las guardas y por el mensaje, no por el estado — ese lo
  // fija el CAS de la transacción.
  await solicitudEnEstado(id, EstadoSoat.RECHAZADA, ctx);

  // Antes de subir nada, por lo mismo que en el alta: un adjunto que no es un PDF no debe dejar un
  // objeto huérfano en el bucket.
  let subido: { storageKey: string; hash: string } | null = null;
  if (archivo) {
    await verificarPdfReal(archivo);
    const hash = createHash('sha256').update(archivo.buffer).digest('hex');
    // Fuera de la transacción (CA-11): una llamada de red dentro la mantendría abierta lo que tarde
    // el bucket. La clave se nombra con el id del SOAT, que ya existe — no hace falta generarlo.
    const storageKey = await uploadEntityDocument(
      carpetaDe({ id: canal.companiaId, flitoCarpetaStorage: canal.carpetaStorage }, 'soat/facturas-venta'),
      id, archivo.originalname, archivo.buffer, archivo.mimetype,
    );
    subido = { storageKey, hash };
  }

  const ahora = new Date();
  await db.transaction(async (tx) => {
    // ── El CAS va PRIMERO, y el orden aquí importa más que en el rechazo ─────────────────────────
    //
    // Si otro reenvío ganó la carrera, se corta antes de tocar nada. Ponerlo al final —donde estaba
    // el UPDATE ciego— tenía dos desenlaces malos y ninguno era un 409 limpio: dos filas de
    // historial y `reenvios` subido dos veces, o un 23505 contra el índice único parcial de la
    // factura de venta (`idx_flito_soportes_soat_factura_venta`) al insertar la segunda viva, que
    // sale como 500.
    if (!await moverEstado(tx, id, EstadoSoat.RECHAZADA, EstadoSoat.PENDIENTE_REVISION, ahora)) {
      throw carreraPerdida();
    }

    // El propietario, sobre la MISMA fila de `flito_compradores` que creó el alta. El `where` va por
    // `soat_id`, que es el padre de esta rama de la tabla (`flito_compradores_padre_chk`): una
    // solicitud del canal tiene exactamente un propietario y `tramite_id IS NULL`.
    await tx.update(flitoCompradores).set({
      nombreCompleto: entrada.propietario.nombreCompleto,
      numeroDocumento: entrada.propietario.numeroDocumento,
      tipoDocumento: entrada.propietario.tipoDocumento,
      correo: entrada.propietario.correo ?? null,
      celular: entrada.propietario.celular ?? null,
      direccion: entrada.propietario.direccion ?? null,
    }).where(eq(flitoCompradores.soatId, id));

    if (subido && archivo) {
      await tx.update(flitoSoportes)
        .set({ descartado: true })
        .where(and(
          eq(flitoSoportes.soatId, id),
          eq(flitoSoportes.tipo, TipoSoporte.FACTURA_VENTA),
          eq(flitoSoportes.descartado, false),
        ));
      await tx.insert(flitoSoportes).values({
        tipo: TipoSoporte.FACTURA_VENTA,
        nombreArchivo: archivo.originalname,
        contentType: archivo.mimetype,
        storageKey: subido.storageKey,
        hash: subido.hash,
        tamanoBytes: archivo.size,
        soatId: id,
        subidoPorId: ctx.userId,
        subidoPorNombre: ctx.username,
      });
    }

    // El estado ya lo movió el CAS de arriba. Lo que sigue valiendo decir aquí: fue un UPDATE y no
    // un INSERT —la misma fila, el mismo id y el mismo VIN (AC3)— y ni `vin` ni `vehiculoId`
    // aparecen en su `set`, que es la RN-01 (ver `EntradaSubsanacion`).
    await tx.update(flitoSoatSolicitud).set({
      causalRechazoId: null,
      observacionRechazo: null,
      revisadoPorId: null,
      revisadoPorNombre: null,
      revisadoEn: null,
      // `+ 1` en SQL y no `fila.reenvios + 1` leído antes: dos reenvíos simultáneos de la misma
      // solicitud no pueden pisarse el contador si lo incrementa la base.
      reenvios: sql`${flitoSoatSolicitud.reenvios} + 1`,
      updatedAt: ahora,
    }).where(eq(flitoSoatSolicitud.soatId, id));

    await registrarCambio(tx, {
      concepto: ConceptoHistorial.SOAT,
      registroId: id,
      // El estado de partida es el que el CAS acaba de COMPROBAR, no el que trajo la lectura previa.
      // Con la lectura, una carrera dejaba escrito un `estadoAnterior` que ya era falso; con la
      // constante, o el CAS pasó —y entonces era `rechazada`— o esta línea no se ejecuta.
      estadoAnterior: EstadoSoat.RECHAZADA,
      estadoNuevo: EstadoSoat.PENDIENTE_REVISION,
      motivo: archivo
        ? 'Subsanación del cliente: datos del propietario y factura de venta'
        : 'Subsanación del cliente: datos del propietario',
      usuarioId: ctx.userId,
      usuarioEmail: ctx.username,
      origen: 'usuario',
    });
  });

  return { id, estado: EstadoSoat.PENDIENTE_REVISION };
}
