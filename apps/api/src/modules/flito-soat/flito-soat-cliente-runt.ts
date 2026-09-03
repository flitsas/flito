// FLITO — SOAT, canal Cliente: lo que habla con el RUNT y CÓMO se clasifica su respuesta.
// Diseño: docs/diseno-hu-11966-runt-compuerta-excel-cliente.md · ADR-0010 (supersede ADR-0009).
//
// **El RUNT vuelve a ser compuerta del alta** (HU #11966). Los DOS endpoints del canal —la
// preconsulta y `POST /cliente`— consultan Kyverum ANTES de escribir nada y traducen su respuesta a
// uno de cuatro desenlaces ({@link DesenlaceRunt}). No hay job post-commit: la #11935 lo introdujo y
// esta HU lo borra entero, que es lo que hace ESTRUCTURAL el «las filas ya radicadas no se
// reconsultan» del AC6 — sin función, no hay reconsulta posible por descuido.
//
// El payload crudo no se persiste (ADR-0008 §1.6, esa frase se conserva). Solo derivados.

import { eq } from 'drizzle-orm';
import {
  resolverCodigoOrganismoFlit,
  type TipoDocumentoRunt,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { organismosTransitoConfig } from '../../db/schema.js';
import { extraerVehiculoRunt, normalizarIdentificador, runtSinRegistro } from '../flito-impuestos/certificacion-runt.js';
import { derivePreflightChecks } from '../tramites/preflight.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
import { mapTipoDocUiToRunt } from '../runt/runt-tipo-doc.js';
import { loggerFor } from '../../shared/logger.js';

const log = loggerFor('flito-soat-cliente');

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
  /** `data.vehiculo.tipoCarroceria`. Va a `vehicles.carroceria` (HU #11966). */
  carroceria: string | null;
  /**
   * Pasajeros sentados y puertas (HU #11966). Los DOS son texto y los DOS pueden faltar.
   *
   * Alimentan `CapacidadCargaOPasajeros` y `Puertas` del Excel para las filas del canal. Si el RUNT
   * no los trajo, la celda va VACÍA — nunca la constante `'4'` de la plantilla, que es justo la
   * afirmación falsa que el AC6 viene a quitar del archivo.
   */
  pasajerosSentados: string | null;
  puertas: string | null;
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
 * Los TRECE campos del canal, a partir de la respuesta cruda.
 *
 * Los seis primeros salen de `extraerVehiculoRunt`, que es el extractor que ya resuelve los alias
 * del RUNT y está verificado contra una consulta real (`certificacion-runt.ts`). NO se reescribe:
 * duplicar las cadenas de alias es garantizar que dentro de un mes digan cosas distintas. Los
 * siete que faltan —cilindraje, servicio, carrocería, pasajeros, puertas, organismo y propietario—
 * no están en `DatosVehiculoRunt` porque la certificación de impuestos no los compara, y se leen
 * aquí con el mismo criterio.
 *
 * Las cadenas de alias de los tres nuevos (HU #11966) siguen la nomenclatura medida del payload:
 * `tipoCarroceria`, `pasajerosSentados` y `puertas` dentro de `data.vehiculo`, con los sinónimos
 * habituales por si el tipo de vehículo cambia la forma (una moto o un remolque no traen lo mismo).
 * `datosTecnicos` se mira como segunda vía, igual que ya hacen cilindraje y servicio.
 */
export function extraerDatosCanal(data: unknown): DatosRuntCanal {
  const d = (data ?? {}) as Record<string, unknown>;
  const veh = (d.vehiculo ?? null) as Record<string, unknown> | null;
  const tec = (d.datosTecnicos ?? null) as Record<string, unknown> | null;
  const base = extraerVehiculoRunt(data);
  const dosVias = (claves: readonly string[]) => alias(veh, claves) ?? alias(tec, claves);

  return {
    ...base,
    cilindraje: dosVias(['cilindraje', 'cilindrada']),
    tipoServicio: dosVias(['tipoServicio', 'servicio', 'nombreServicio']),
    carroceria: dosVias(['tipoCarroceria', 'carroceria', 'nombreCarroceria']),
    pasajerosSentados: dosVias(['pasajerosSentados', 'capacidadPasajeros', 'numeroPasajeros', 'pasajeros']),
    puertas: dosVias(['puertas', 'numeroPuertas', 'numPuertas']),
    organismoNombre: alias(veh, ['organismoTransito', 'organismoTransitoNombre', 'nombreOrganismoTransito']),
    propietarioNombre: alias(veh, ['nombrePropietario', 'propietario', 'nombreTitular']),
  };
}

/**
 * ¿El RUNT dice que este vehículo YA tiene SOAT vigente?
 *
 * Se delega en `derivePreflightChecks`. Solo `status === 'ok'` cuenta como vigente. `fail` es
 * «lo tuvo y está vencido»; `unknown` es «el RUNT no reporta póliza».
 */
export function soatVigenteSegunRunt(respuestaRunt: unknown): boolean {
  const { checks } = derivePreflightChecks({ vehiculoResp: respuestaRunt as { ok?: boolean; data?: unknown } });
  return checks.find((c) => c.key === 'soat')?.status === 'ok';
}

/**
 * La fecha hasta la que el RUNT dice que la póliza está vigente, en `yyyy-mm-dd`, o `null`.
 *
 * No se saca del `message` del check. Se leen los mismos alias que lee el pre-vuelo
 * (`fechaVencimSoat` / `fechaVencimiento`). Si el RUNT no manda fecha o manda algo que no es una
 * fecha, `null` — ninguna fecha por defecto.
 */
export function fechaVencimientoSoatRunt(data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const bruto = Array.isArray(d.soat) ? d.soat[0] : d.soat;
  const soat = (bruto ?? null) as Record<string, unknown> | null;
  const valor = alias(soat, ['fechaVencimSoat', 'fechaVencimiento']);
  if (!valor) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor);
  if (iso) return fechaValida(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(valor.trim());
  if (dmy) return fechaValida(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  return null;
}

/** `yyyy-mm-dd` si los tres números son un día del calendario; `null` si no. */
function fechaValida(anio: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || anio < 1900 || anio > 2200) return null;
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * El organismo del RUNT, traducido a código DIVIPOLA y comprobado contra la tabla.
 *
 * Dos comprobaciones: `resolverCodigoOrganismoFlit` cruza el nombre contra el catálogo nacional,
 * y `organismos_transito_config` es la tabla a la que apunta la FK. Devuelve `null` si no cruza
 * — y `null` NO aborta nada (AC5 de la HU #11966): la fila se crea igual con el organismo vacío y
 * el satélite anotando `organismo_no_catalogado`.
 */
export async function resolverOrganismoCatalogo(nombre: string | null): Promise<string | null> {
  const codigo = resolverCodigoOrganismoFlit({ nombre });
  if (!codigo) return null;
  const [fila] = await db.select({ codigo: organismosTransitoConfig.codigo })
    .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  return fila?.codigo ?? null;
}

/**
 * QUÉ campo del RUNT difiere de lo que se radicó, o `null` si no difiere ninguno.
 *
 * Un campo que el RUNT no trajo (`NO_VERIFICABLE`) no es «no cuadra» — misma normalización que
 * `compararCampo` de certificación. Y un VIN que el cliente NO tecleó tampoco: desde la HU #11966 el
 * VIN es opcional en la entrada y el efectivo es el del RUNT, así que no hay nada que contrastar.
 *
 * Devuelve el campo y no un booleano porque el 422 del VIN lleva `campo: 'vin'` para que el wizard
 * pueda poner el foco donde toca. El de la placa no lo necesita: la placa es obligatoria y es lo
 * único que el usuario pudo escribir mal.
 */
export function campoQueNoCuadra(
  entrada: { placa: string; vin: string | null },
  datos: DatosRuntCanal,
): 'placa' | 'vin' | null {
  const placaRunt = normalizarIdentificador(datos.placa);
  const vinRunt = normalizarIdentificador(datos.vin);
  const placaIn = normalizarIdentificador(entrada.placa);
  const vinIn = normalizarIdentificador(entrada.vin);
  if (placaRunt !== null && placaIn !== null && placaRunt !== placaIn) return 'placa';
  if (vinRunt !== null && vinIn !== null && vinRunt !== vinIn) return 'vin';
  return null;
}

export type RespuestaKyverum = {
  ok?: boolean;
  data?: unknown;
  message?: string;
  /**
   * Código HTTP con el que la pasarela contestó, cuando `ok` es `false` (HU #11966).
   *
   * Lo anota `runt.service.ts` y lo lee SOLO este archivo. `200` = «el RUNT respondió que no»;
   * cualquier otro valor, o su ausencia, = «el RUNT no respondió». Ver {@link esNegativaDeNegocio}.
   */
  httpStatus?: number;
};

/**
 * Consulta Kyverum. No clasifica: quien llama decide qué hacer con la respuesta.
 *
 * Bug #11927: la pasarela exige documento cuando va la placa; el VIN al lado no lo sustituye.
 *
 * `vin` es opcional desde la HU #11966 (AC1) y se manda vacío cuando el Cliente no lo tecleó: la
 * consulta sigue siendo por placa + documento, que es la combinación que la pasarela acepta.
 */
export async function consultarRuntCrudo(
  placa: string,
  vin: string | null,
  numeroDocumento: string,
  tipoDocumento: TipoDocumentoRunt,
): Promise<RespuestaKyverum> {
  const tipoRunt = mapTipoDocUiToRunt(tipoDocumento) ?? tipoDocumento;
  return await consultarVehiculoRunt(placa, vin ?? undefined, numeroDocumento, tipoRunt) as RespuestaKyverum;
}

/** Los códigos de la familia «revise los datos», tal como los emite la compuerta. */
export type CodigoRevise = 'runt_no_cuadra' | 'runt_sin_registro' | 'runt_sin_vin';

/**
 * Los CUATRO desenlaces posibles de una consulta al RUNT, y el único vocabulario con el que la
 * compuerta habla con los dos endpoints.
 *
 * Es un tipo de dominio y no un `SolicitudSoatError` a propósito: aquí se DECIDE qué pasó, y el
 * servicio traduce a HTTP. Separarlo permite que la preconsulta y el alta compartan la decisión —que
 * es la invariante del AC («los dos endpoints devuelven lo mismo ante el mismo RUNT»)— sin que este
 * archivo tenga que conocer códigos de estado.
 */
export type DesenlaceRunt =
  | { clase: 'ok'; datos: DatosRuntCanal; vinEfectivo: string; organismoCodigo: string | null }
  | { clase: 'vigente'; fechaVencimiento: string | null }
  | { clase: 'revise'; codigo: CodigoRevise; campo?: 'vin' }
  | { clase: 'caido' };

/**
 * ¿Este `ok:false` es una NEGATIVA DE NEGOCIO del RUNT, o es que el RUNT no respondió?
 *
 * **Es la decisión cara de la HU #11966 y el AC4 entero depende de ella.** `consultarVehiculoRunt`
 * devuelve `{ ok:false, message }` en los dos casos: cuando la pasarela contesta HTTP 200 con un
 * rechazo («los datos no corresponden con los propietarios activos del vehículo») y cuando hay
 * timeout, red, no-200 o circuito abierto. Tratarlos igual convierte un «no» de negocio en un 503
 * «el RUNT no está disponible», que es exactamente lo que el AC4 prohíbe.
 *
 * ── Transporte PRIMERO, texto después ────────────────────────────────────────────────────────────
 *
 * `httpStatus === 200` es una señal ESTRUCTURAL: un 200 es, por construcción, «el RUNT respondió».
 * No se puede romper porque Kyverum corrija una redacción. El predicado sobre el mensaje
 * (`/propietari/i`, el mismo de `esTraspasoEnSincronizacion` y de `soat/refresh.service.ts`) se
 * conserva DEBAJO como red: cubre la vía directa, que no pasa por la pasarela y no trae `httpStatus`.
 *
 * **El defecto es «caído», y eso es el seguro**: un desenlace desconocido responde 503 y no crea
 * nada. Nunca produce un alta falsa. El precio, escrito para que se vea: si Kyverum señalara un
 * rechazo de propietario con un no-200 **y** cambiara la redacción, el usuario leería «el RUNT no
 * está disponible» cuando sí lo está. Por eso la compuerta loguea el desenlace con su `httpStatus`
 * (sin placa ni documento), para poder medirlo en DEV.
 */
export function esNegativaDeNegocio(respuesta: RespuestaKyverum): boolean {
  if (respuesta?.httpStatus === 200) return true;
  return /propietari/i.test(respuesta?.message ?? '');
}

/**
 * De la respuesta cruda de Kyverum al desenlace, en el ORDEN que fija el diseño §2.3.
 *
 * El orden importa y es el del AC:
 *
 *   1. `ok:false` → negativa de negocio (`runt_no_cuadra`) o caído. Nada más se puede mirar.
 *   2. Sin registro → `runt_sin_registro`. `runtSinRegistro` no se fía del eco de la consulta.
 *   3. Placa o VIN que difieren → `runt_no_cuadra` (+ `campo: 'vin'`).
 *   4. Sin VIN en la respuesta → `runt_sin_vin`. Sin VIN efectivo no hay fila posible (RN-01).
 *   5. SOAT vigente → `vigente`.
 *   6. `ok`, con el organismo cruzado contra catálogo (o `null`, que NO aborta — AC5).
 *
 * La vigencia va DESPUÉS de los cuatro «revise»: si los datos del RUNT no sirven para identificar el
 * vehículo, decir «ya tiene SOAT vigente» sería afirmar algo sobre un vehículo que no se ha
 * confirmado que sea el que se radica.
 */
export async function clasificarDesenlaceRunt(
  respuesta: RespuestaKyverum,
  entrada: { placa: string; vin: string | null },
): Promise<DesenlaceRunt> {
  if (!respuesta?.ok) {
    if (esNegativaDeNegocio(respuesta)) return { clase: 'revise', codigo: 'runt_no_cuadra' };
    return { clase: 'caido' };
  }
  if (runtSinRegistro(respuesta.data)) return { clase: 'revise', codigo: 'runt_sin_registro' };

  const datos = extraerDatosCanal(respuesta.data);

  const campo = campoQueNoCuadra(entrada, datos);
  if (campo !== null) {
    // El 422 NUNCA lleva el VIN del RUNT: un Cliente puede sondear placas, y responder «el bueno es
    // este» convertiría el endpoint en un lector de VIN por placa. Solo se dice QUÉ campo revisar.
    return campo === 'vin'
      ? { clase: 'revise', codigo: 'runt_no_cuadra', campo: 'vin' }
      : { clase: 'revise', codigo: 'runt_no_cuadra' };
  }

  const vinEfectivo = normalizarIdentificador(datos.vin);
  if (vinEfectivo === null) return { clase: 'revise', codigo: 'runt_sin_vin' };

  if (soatVigenteSegunRunt(respuesta)) {
    return { clase: 'vigente', fechaVencimiento: fechaVencimientoSoatRunt(respuesta.data) };
  }

  return {
    clase: 'ok',
    datos,
    vinEfectivo,
    organismoCodigo: await resolverOrganismoCatalogo(datos.organismoNombre),
  };
}

/**
 * En qué CLASE de fallo cayó la pasarela, sin echar el mensaje al log.
 *
 * ── Por qué un token y no `err.message` (hueco que encontró el gate B) ──────────────────────────
 *
 * El mensaje de un `throw` es texto de un TERCERO y puede traer dentro lo que la pasarela estuviera
 * procesando — la placa, el VIN o el documento con el que se consultó. `logger` redacta por NOMBRE
 * de campo (`*.password`, `*.token`…), así que una placa dentro de una cadena libre entra al log
 * entera y no la ve nadie. Es la misma regla que `rateLimiter.ts` deja escrita: «nada de datos
 * personales, y no por costumbre — `logger` no redacta lo que no reconoce».
 *
 * La suite del job que la HU #11966 borró era el único guardián de la forma de este log
 * (`{ soatId, verificacionEstado }`, sin placa ni documento). El aserto se recupera en
 * `flito-soat.cliente-alta-runt-compuerta.test.ts`, sobre las DOS ramas.
 *
 * ── Por qué se clasifica en vez de omitir ───────────────────────────────────────────────────────
 *
 * ADR-0010 promete poder MEDIR en DEV cuántas caídas hay y de qué tipo; con solo `desenlace: 'caido'`
 * no se distingue un timeout de un circuito abierto. El token es un vocabulario CERRADO —cuatro
 * valores escritos aquí—, así que por construcción no puede publicar nada del vehículo: lo que no
 * casa ninguna regla sale como `otro`, nunca como el texto original.
 */
const CAUSAS_CAIDA: readonly (readonly [RegExp, string])[] = [
  [/timeout|timed out|etimedout|esockettimedout/i, 'timeout'],
  [/econnreset|econnrefused|enotfound|eai_again|epipe|socket hang up|network/i, 'red'],
  [/circuit|circuito/i, 'circuito'],
];

export function causaDeCaida(err: unknown): 'timeout' | 'red' | 'circuito' | 'otro' {
  const mensaje = err instanceof Error ? err.message : String(err ?? '');
  for (const [patron, causa] of CAUSAS_CAIDA) {
    if (patron.test(mensaje)) return causa as 'timeout' | 'red' | 'circuito';
  }
  return 'otro';
}

/**
 * Consulta + clasificación, con el `throw` de la pasarela recogido como «caído».
 *
 * Es el ÚNICO punto por el que el canal habla con el RUNT: la preconsulta y el alta llaman aquí, y
 * por eso los dos devuelven exactamente lo mismo ante la misma respuesta. Dos copias divergen y el
 * wizard acaba bloqueando lo que la API acepta, o al revés.
 *
 * **El log no lleva placa, VIN, documento ni nombre, y tampoco el mensaje CRUDO del error** — solo
 * el desenlace, la señal de transporte y un token de causa de vocabulario cerrado
 * ({@link causaDeCaida}). Es lo que hace falta para medir en DEV el riesgo de la clasificación (ver
 * {@link esNegativaDeNegocio}) sin abrir una vía de PII en logs.
 */
export async function consultarYClasificar(
  placa: string,
  vin: string | null,
  numeroDocumento: string,
  tipoDocumento: TipoDocumentoRunt,
): Promise<DesenlaceRunt> {
  let respuesta: RespuestaKyverum;
  try {
    respuesta = await consultarRuntCrudo(placa, vin, numeroDocumento, tipoDocumento);
  } catch (err: unknown) {
    // Un `throw` no es una respuesta: el defecto seguro es «caído», que no crea nada.
    //
    // `causa` y NO `err.message`: el mensaje es texto de un tercero y puede traer la placa o el
    // documento con el que se consultó. Ver `causaDeCaida`.
    log.warn(
      { desenlace: 'caido', causa: causaDeCaida(err), httpStatus: null },
      'compuerta RUNT del canal Cliente',
    );
    return { clase: 'caido' };
  }

  const desenlace = await clasificarDesenlaceRunt(respuesta, { placa, vin });
  if (desenlace.clase === 'caido' || desenlace.clase === 'revise') {
    log.info(
      {
        desenlace: desenlace.clase,
        codigo: desenlace.clase === 'revise' ? desenlace.codigo : null,
        httpStatus: respuesta.httpStatus ?? null,
      },
      'compuerta RUNT del canal Cliente',
    );
  }
  return desenlace;
}
