// FLITO SOAT — verificación de vigencia: el RECORRIDO (Feature #12075, HU #12096).
//
// La HU #12095 entregó la PROGRAMACIÓN (`flito-soat-vigencia.cron.ts`): cuándo arranca, quién la
// ejecuta, cómo se apaga y cuándo se reintenta. Aquí vive lo otro: QUÉ vehículos se toman, CÓMO se
// consultan y QUÉ se escribe.
//
// Las dos ataduras con el andamiaje, que no son cosméticas y que este archivo tiene que respetar:
//
//   · `pendientes > 0` es lo ÚNICO que dispara el reintento horario. Un fallido contado como
//     verificado apaga el reintento en silencio y para siempre — es el mutante caro de esta HU.
//   · `dia` e `intento` viajan hacia adentro para poder excluir lo ya verificado con éxito ese día.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-D7  La corrida NO mueve la solicitud. No llama a `registrarCambio`, no escribe en
//        `flito_estado_historial` ni en `flito_soat_solicitud`, y su `set()` no contiene `estado`,
//        `pagado_en`, `motivo_rechazo` ni `numero_poliza`. La verificación es una lectura del
//        registro nacional anotada al margen; convertirla en una transición dejaría a la operación
//        con SOAT que cambian de estado solos de madrugada, sin actor y sin poder revertirlo.
//        Tampoco toca `updated_at`: todos sus escritores actuales son acciones humanas, y moverla
//        cada noche la vaciaría de significado sin que nada se pusiera rojo.
//
// AC5    **Un silencio no es un «no».** Si el RUNT no responde, el vehículo queda `no_verificado` y
//        `verificada_en`, `vence_el` y `poliza_runt` se quedan EXACTAMENTE como estaban. El riesgo
//        real está medido y tiene nombre: `soatVigenteSegunRunt` devuelve `false` cuando el RUNT no
//        respondió (`preflight.ts` marca el check como `unknown` y esa función solo cuenta
//        `status === 'ok'`), así que un `soatVigenteSegunRunt(r) ? 'vigente' : 'sin_registro'`
//        escribiría `sin_registro` con la pasarela caída — dar por vencido por silencio. De ahí el
//        orden de {@link clasificarVigencia}: transporte primero, vigencia al final.
//
// AC6    La corrida no puede degradar las consultas de usuarios. El breaker `runt-vehicle` es DE
//        PROCESO y COMPARTIDO con el alta del canal, la certificación de impuestos, la preconsulta
//        y el pre-vuelo; con él abierto la llamada rebota al instante sin salir a la red. Un censo
//        contra un RUNT caído se quemaría en milisegundos, marcaría todo `no_verificado` y gastaría
//        un reintento horario sin haber intentado nada. Por eso el breaker se consulta ANTES de cada
//        tanda y la corrida PARA, devolviendo el resto como `pendientes` — que es la señal que
//        reprograma a la hora.
//
// AC7    De aquí solo salen CONTEOS. Ningún identificador de vehículo llega al cron ni al log; los
//        motivos son un vocabulario cerrado de cuatro tokens y nunca el mensaje de la pasarela, que
//        es texto de un tercero y puede traer dentro la placa o el VIN con los que se consultó.

import { and, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { MotivoCaidaRunt, ResumenMotivosCorrida } from '@operaciones/shared-types';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { auditLogs, flitoSoat } from '../../db/schema.js';
import { circuitoAbierto } from '../../services/circuitBreaker.js';
import { loggerFor } from '../../shared/logger.js';
import { conConcurrencia } from '../../shared/utils/con-concurrencia.js';
import { EXISTS_COMPROBANTE_SOAT } from './flito-soat-censo.js';
import {
  causaDeCaida, consultarRuntCrudo, fechaVencimientoSoatRunt, polizaSoatRunt, soatVigenteSegunRunt,
  type RespuestaKyverum,
} from './flito-soat-cliente-runt.js';
import { runtSinRegistro } from '../flito-impuestos/certificacion-runt.js';

const log = loggerFor('flito-soat-vigencia');

/** El circuito por el que sale `consultarVehiculoRunt` (`runt.service.ts`). Compartido — ver AC6. */
const CIRCUITO_RUNT = 'runt-vehicle';

/**
 * Reintentos POR VEHÍCULO dentro de una misma corrida: 1, o sea 2 consultas como mucho.
 *
 * El AC6 pide dos cosas distintas y las separa a propósito: una constante CONFIGURABLE para el ritmo
 * (`SOAT_VIGENCIA_CONCURRENCIA`, que se calibra sin desplegar) y un tope DECLARADO para esto. Es un
 * tope y no una perilla porque encima de él ya hay tres reintentos horarios del cron: con `k`
 * reintentos por vehículo, un RUNT caído produce 4 corridas × N vehículos × (1 + k) consultas. Con
 * k=1 eso son 8N; con k=3, 16N. Un reintento que se multiplica por el de arriba deja de ser un
 * reintento y pasa a ser la tormenta que CF-06 nombra.
 */
export const MAX_REINTENTOS_VEHICULO = 1;

/**
 * Cuánto puede durar una corrida antes de dejar de tomar vehículos nuevos: 40 minutos.
 *
 * Es el 80 % del `LOCK_TTL_MS` (50 min) del cron, y responde la pregunta que su cabecera dejó
 * abierta («la HU #12096 tendrá que revisarlo si el recorrido real puede tardar más»). Pasarse del
 * TTL no es que la corrida vaya lenta: es que el candado caduca y otra instancia entra EN PARALELO
 * a consultar los mismos vehículos. Al agotarse el presupuesto el resto vuelve como `pendientes` y
 * el reintento de la hora siguiente los recoge.
 *
 * **No hay `LIMIT` en el censo**, y esta es la razón de que no lo haya: truncar la consulta haría
 * que `total` mintiera —diría «considerados: 500» cuando había 3 000— y el corte quedaría invisible.
 * El presupuesto corta DESPUÉS de contar, así que `considerados` sigue siendo el censo real y la
 * diferencia aparece donde tiene que aparecer: en `pendientes`.
 */
export const PRESUPUESTO_CORRIDA_MS = 40 * 60_000;

/**
 * Vehículos por tanda. Entre una y otra se consultan el breaker y el presupuesto.
 *
 * No es el paralelismo —ese es `SOAT_VIGENCIA_CONCURRENCIA`— sino cada cuánto se vuelve a mirar si
 * conviene seguir. Con 20 y concurrencia 2, la corrida revisa las dos condiciones cada ~10 rondas:
 * lo bastante seguido para que un RUNT que se cae no se lleve por delante un censo entero, y lo
 * bastante espaciado para que el pool no se vacíe en cada corte.
 */
const VEHICULOS_POR_TANDA = 20;

/** Colombia no tiene horario de verano: el desfase es fijo y no hay que preguntárselo a nadie. */
const OFFSET_BOGOTA = '-05:00';

export interface RecorridoVigenciaParams {
  /** Día de la corrida en Bogotá, `YYYY-MM-DD`. Es la llave por la que se sabe qué ya se verificó hoy. */
  dia: string;
  /** Número de ejecución del día: 1 es la corrida inicial, 2..4 son los reintentos horarios. */
  intento: number;
}

export interface ResultadoRecorridoVigencia {
  /** Vehículos que el recorrido tomó en este intento. Es el censo REAL, sin truncar. */
  considerados: number;
  /** Verificados con éxito en este intento. Un reintento no vuelve a tomarlos. */
  verificados: number;
  /**
   * Vehículos que quedaron SIN verificar por indisponibilidad de la fuente.
   *
   * Mayor que cero es lo que reprograma la corrida a la hora siguiente. No incluye los que se
   * resolvieron con un «no» legítimo: eso es un vehículo verificado, no uno pendiente.
   */
  pendientes: number;
  /** De los verificados, cuántos CAMBIARON de `estado_vigencia`. Es lo único que se audita por fila. */
  cambiaron: number;
  /** Conteos por causa de caída + reintentos gastados. Vocabulario cerrado (AC7). */
  motivos: ResumenMotivosCorrida;
}

/** Lo que el recorrido necesita de cada fila. Ni placa, ni documento, ni propietario, ni la fila entera. */
export interface VehiculoAVerificar {
  soatId: string;
  vin: string;
  /**
   * Estado de vigencia ANTERIOR, y no es un dato de más.
   *
   * El AC3 pide auditar «solo los vehículos cuya vigencia cambió», y para saber si cambió hace falta
   * el valor previo: sin él la alternativa es un UPDATE condicional que, cuando no cambia nada, deja
   * la fila sin refrescar `verificada_en` y obliga a un segundo UPDATE — dos consultas por vehículo
   * en la noche normal, que es justo la que no cambia nada. No es PII: es el estado de un proceso
   * interno de FLITO sobre su propia fila.
   */
  estadoVigencia: string;
}

/**
 * Error propio del recorrido, con NOMBRE propio.
 *
 * El cron loguea `err.name` y nunca `err.message` (AC7): el mensaje de un fallo de base puede traer
 * dentro el VIN de una fila. Esta clase es lo que hace que ese nombre sea diagnóstico —«reventó el
 * recorrido», no un `Error` genérico— sin publicar nada.
 *
 * **No existe un `RuntSinRespuestaError`, y su ausencia es el diseño:** un RUNT que no responde NO
 * es una excepción de este recorrido, es un `pendiente`. Convertirlo en `throw` haría que el primer
 * timeout abortara el censo entero y que el cron contara 1 pendiente donde había 3 000.
 */
export class RecorridoVigenciaError extends Error {
  override name = 'RecorridoVigenciaError';
}

// ─────────────────────────────── El censo (AC2) ─────────────────────────────────────────────────

/**
 * El instante a partir del cual una verificación cuenta como «de hoy»: 00:00 de Bogotá de `dia`.
 *
 * En JS y no con `AT TIME ZONE` en SQL, por dos motivos que se refuerzan: el corte queda como UN
 * parámetro enlazado (en vez de un literal de zona repetido dentro de la consulta, que con Drizzle
 * son dos parámetros distintos en cuanto se interpola dos veces) y el predicado es DETERMINISTA —
 * depende del `dia` que el cron calculó con `Intl`, no del reloj del servidor de base de datos, que
 * es otra máquina y otro huso.
 */
export function corteDelDia(dia: string): Date {
  return new Date(`${dia}T00:00:00${OFFSET_BOGOTA}`);
}

/**
 * El predicado del censo: comprobante cargado y no verificado con éxito desde el corte.
 *
 * Exportado para poder comprobarlo sobre el SQL RENDERIZADO (`__tests__/helpers/sql-ligado.ts`). No
 * es una comodidad: el mock de drizzle es passthrough en `where`, así que afirmar sobre las filas
 * que devuelve `vehiculosAVerificar` sería una tautología —el test recibe lo que el test registró—
 * y el AC2 quedaría sin verificar.
 *
 * ── La exclusión del AC6 es UNA sola cláusula ───────────────────────────────────────────────────
 *
 * `verificada_en IS NULL OR verificada_en < corte`. Se puede escribir así de simple porque
 * `verificada_en` SOLO se toca cuando el RUNT respondió: un vehículo que hoy falló conserva la fecha
 * vieja (o `NULL`), así que sigue cayendo del lado de «pendiente por verificar» y el reintento de la
 * hora siguiente lo vuelve a tomar. Si la rama `no_verificado` escribiera la fecha del intento, este
 * predicado excluiría justo a los que fallaron y el reintento horario se los saltaría — que es el
 * modo de fallo más silencioso de esta HU.
 *
 * **Sin la frontera de autogestión y sin excluir `gestion_operaciones`**: el AC2 dice «los vehículos
 * con comprobante cargado, y solo esas». Que FLITO haya pagado la póliza es condición necesaria y
 * suficiente para preguntar por ella; a quién le toque gestionar el SOAT no cambia si el RUNT lo
 * reconoce.
 */
export function condicionCenso(corte: Date): SQL {
  return and(
    EXISTS_COMPROBANTE_SOAT,
    or(isNull(flitoSoat.verificadaEn), lt(flitoSoat.verificadaEn, corte)),
  )!;
}

/**
 * Los vehículos que toca verificar en este intento.
 *
 * Devuelve el censo ENTERO: sin `LIMIT` (ver {@link PRESUPUESTO_CORRIDA_MS}). El orden es por
 * `verificada_en` ascendente con `NULLS FIRST` —lo más viejo y lo nunca verificado primero—, para
 * que si el presupuesto o el breaker cortan la corrida, lo que se queda sin consultar sea lo más
 * fresco y no lo más rancio. No hay ningún aserto de orden en la suite: el mock ignora `orderBy`,
 * así que un test sobre él sería verde vacío; queda como preferencia declarada, no como garantía.
 */
export async function vehiculosAVerificar(dia: string): Promise<VehiculoAVerificar[]> {
  const filas = await db
    .select({
      soatId: flitoSoat.id,
      vin: flitoSoat.vin,
      estadoVigencia: flitoSoat.estadoVigencia,
    })
    .from(flitoSoat)
    .where(condicionCenso(corteDelDia(dia)))
    // `NULLS FIRST` explícito: el defecto de PostgreSQL para ASC es `NULLS LAST`, que pondría lo
    // NUNCA verificado al final — exactamente al revés de lo que se quiere.
    .orderBy(sql`${flitoSoat.verificadaEn} ASC NULLS FIRST`);
  return filas;
}

// ────────────────────────── El clasificador: el ORDEN es el AC5 ─────────────────────────────────

export type DesenlaceVigencia =
  | { estado: 'vigente'; venceEl: string | null; poliza: string | null }
  | { estado: 'sin_registro' }
  | { estado: 'no_verificado'; motivo: MotivoCaidaRunt };

/**
 * De la respuesta del RUNT al desenlace, en el ÚNICO orden que respeta el AC5.
 *
 *   1. `null` = no se consultó porque el circuito estaba abierto → `no_verificado`, `circuito`.
 *   2. `ok !== true` = se consultó y el RUNT no respondió → `no_verificado`, con la causa.
 *   3. El registro no conoce el vehículo → `sin_registro`.
 *   4. Y SOLO aquí, la vigencia.
 *
 * **Transporte primero, y los pasos 1 y 2 no se pueden fundir con el 4.** `soatVigenteSegunRunt`
 * devuelve `false` tanto cuando el RUNT dice «vencido» como cuando no dijo nada
 * (`derivePreflightChecks` marca el check `unknown` si `vehiculoResp.ok` es falso, y esa función
 * solo cuenta `status === 'ok'`). Un `soatVigenteSegunRunt(r) ? 'vigente' : 'sin_registro'` escribe
 * `sin_registro` con la pasarela caída: dar por vencido por silencio, que es el AC5 al revés.
 *
 * **El circuito entra como `null` y no como una llamada viva a `circuitoAbierto()`.** Preguntarlo
 * aquí, DESPUÉS de tener la respuesta, descartaría una respuesta buena solo porque el breaker se
 * abrió entretanto por culpa de otro llamador — el breaker es compartido. Quien decide no consultar
 * es {@link verificarVehiculo}, antes; esta función solo traduce.
 *
 * **La asimetría de las dos firmas es una trampa medida y por eso están escritas juntas:**
 * `soatVigenteSegunRunt` recibe la RESPUESTA ENTERA y `fechaVencimientoSoatRunt` recibe `data`.
 * Pasarle la respuesta entera a la segunda devuelve `null` siempre, sin error y sin test rojo.
 *
 * Función pura: sin red, sin base, sin reloj. Es lo que permite ejercer los cuatro desenlaces sin
 * levantar nada.
 */
export function clasificarVigencia(respuesta: RespuestaKyverum | null): DesenlaceVigencia {
  // 1. TRANSPORTE: ni siquiera se intentó.
  if (respuesta === null) return { estado: 'no_verificado', motivo: 'circuito' };
  // 2. TRANSPORTE: se intentó y no hubo respuesta. `causaDeCaida` sobre el MENSAJE de la respuesta y
  //    no sobre un `catch`: `consultarVehiculoRunt` atrapa todo —incluido el `CircuitoAbiertoError`—
  //    y devuelve `{ ok:false, message }`, así que aquí casi nunca llega una excepción.
  if (respuesta.ok !== true) return { estado: 'no_verificado', motivo: causaDeCaida(respuesta.message) };
  // 3. El RUNT respondió y no hay vehículo detrás. `runtSinRegistro` no se fía del eco de la
  //    consulta: la pasarela devuelve el identificador con el que se preguntó aunque no encuentre
  //    nada.
  if (runtSinRegistro(respuesta.data)) return { estado: 'sin_registro' };
  // 4. Ahora sí: el RUNT habló del vehículo y dice si la póliza está viva.
  if (!soatVigenteSegunRunt(respuesta)) return { estado: 'sin_registro' };
  return {
    estado: 'vigente',
    venceEl: fechaVencimientoSoatRunt(respuesta.data),
    poliza: polizaSoatRunt(respuesta.data),
  };
}

/**
 * Lo que se escribe por desenlace. **Las claves ausentes son la mitad del contrato.**
 *
 * | Desenlace | `estado_vigencia` | `verificada_en` | `vence_el` | `poliza_runt` |
 * |---|---|---|---|---|
 * | responde y hay SOAT vigente | `vigente` | ahora | si vino | si vino |
 * | responde y no | `sin_registro` | ahora | intacto | intacto |
 * | no responde / circuito | `no_verificado` | **intacto** | **intacto** | **intacto** |
 *
 * En `no_verificado` el payload NO puede contener `verificada_en`, `vence_el` ni `poliza_runt —**ni
 * siquiera con `null`**: un `null` explícito BORRA lo que había, y `verificada_en` significa «cuándo
 * RESPONDIÓ el RUNT», no «cuándo se intentó». Lo mismo con `vence_el` en `sin_registro`: la fecha
 * vieja es la última verdad conocida y el AC5 la conserva.
 *
 * Y lo que NUNCA aparece aquí (RN-D7): `estado`, `pagadoEn`, `motivoRechazo`, `numeroPoliza` —la
 * póliza del RUNT va a `polizaRunt` y punto, o se borraría la llave de conciliación del OCR— ni
 * `updatedAt`.
 */
export function payloadDeDesenlace(d: DesenlaceVigencia, ahora: Date): Record<string, unknown> {
  if (d.estado === 'no_verificado') return { estadoVigencia: 'no_verificado' };
  if (d.estado === 'sin_registro') return { estadoVigencia: 'sin_registro', verificadaEn: ahora };
  return {
    estadoVigencia: 'vigente',
    verificadaEn: ahora,
    ...(d.venceEl !== null ? { venceEl: d.venceEl } : {}),
    ...(d.poliza !== null ? { polizaRunt: d.poliza } : {}),
  };
}

// ─────────────────────────── Una consulta, con su tope por vehículo ─────────────────────────────

interface ConsultaVehiculo {
  /** `null` = no se consultó: el circuito estaba abierto. */
  respuesta: RespuestaKyverum | null;
  /** Consultas REPETIDAS que gastó este vehículo (0 o 1, ver {@link MAX_REINTENTOS_VEHICULO}). */
  reintentos: number;
}

async function consultarUnaVez(vin: string): Promise<RespuestaKyverum> {
  try {
    return await consultarRuntCrudo(vin);
  } catch (err: unknown) {
    // `consultarVehiculoRunt` casi nunca lanza —atrapa todo y devuelve `{ok:false,message}`—, pero
    // sí lo hace ANTES del try en dos guardas de argumentos. El mensaje se convierte aquí mismo en
    // un token de vocabulario cerrado: si llegara al `message` de la respuesta, acabaría en
    // `motivos` y de ahí a una columna jsonb con texto de un tercero dentro.
    return { ok: false, message: causaDeCaida(err) };
  }
}

/**
 * La consulta de UN vehículo, con el breaker delante y el tope por vehículo detrás.
 *
 * El breaker se consulta antes de gastar la llamada y también antes del reintento: con el circuito
 * abierto la llamada no sale a la red, rebota al instante y consume el tope sin haber intentado
 * nada. `circuitoAbierto` es consulta pura y respeta el medio-abierto: no impide que
 * `withCircuitBreaker` pruebe si el servicio volvió pasado el minuto de reset.
 */
export async function verificarVehiculo(vin: string): Promise<ConsultaVehiculo> {
  if (circuitoAbierto(CIRCUITO_RUNT)) return { respuesta: null, reintentos: 0 };

  let reintentos = 0;
  for (;;) {
    const respuesta = await consultarUnaVez(vin);
    if (respuesta.ok === true) return { respuesta, reintentos };
    if (reintentos >= MAX_REINTENTOS_VEHICULO) return { respuesta, reintentos };
    if (circuitoAbierto(CIRCUITO_RUNT)) return { respuesta, reintentos };
    reintentos += 1;
  }
}

// ─────────────────────────────── La escritura y su auditoría ────────────────────────────────────

/**
 * Escribe el desenlace de un vehículo y audita SI Y SOLO SI la vigencia cambió.
 *
 * `audit_logs` responde «quién CAMBIÓ qué»: una consulta que no cambió nada no cambió nada, y N
 * filas por noche diciendo «seguía vigente» dejarían la tabla inservible para lo que existe. La
 * corrida entera deja además UNA fila con los totales ({@link auditarCorrida}), que es donde se lee
 * «anoche se verificaron 3 000 y cambiaron 2».
 *
 * `detail` sin placa, sin VIN, sin documento: el `resourceId` ya es el id del SOAT, que es la llave
 * con la que se llega a la fila si hace falta mirar.
 *
 * Devuelve `true` si hubo cambio de estado.
 */
async function escribirDesenlace(
  v: VehiculoAVerificar, d: DesenlaceVigencia, ahora: Date, params: RecorridoVigenciaParams,
): Promise<boolean> {
  await db.update(flitoSoat).set(payloadDeDesenlace(d, ahora)).where(eq(flitoSoat.id, v.soatId));

  if (d.estado === v.estadoVigencia) return false;

  await db.insert(auditLogs).values({
    userId: null,
    userEmail: 'sistema',
    action: 'update',
    resource: 'flito_soat',
    resourceId: v.soatId,
    detail: `Verificación diaria de vigencia contra el RUNT (día ${params.dia}, intento ${params.intento}): `
      + `${v.estadoVigencia} → ${d.estado}.`,
  });
  return true;
}

/** La fila de auditoría de la corrida: los totales, una vez. Sin identificadores de vehículo. */
async function auditarCorrida(params: RecorridoVigenciaParams, r: ResultadoRecorridoVigencia): Promise<void> {
  const motivos = Object.entries(r.motivos).map(([k, n]) => `${k}=${n}`).join(', ') || 'ninguno';
  await db.insert(auditLogs).values({
    userId: null,
    userEmail: 'sistema',
    action: 'update',
    resource: 'flito_soat_verificacion_corridas',
    // `dia#intento` y no un uuid: es la llave natural de la tabla y cabe de sobra en varchar(50).
    resourceId: `${params.dia}#${params.intento}`,
    detail: `Verificación diaria de vigencia del SOAT. Considerados ${r.considerados}, `
      + `verificados ${r.verificados}, con cambio ${r.cambiaron}, sin verificar ${r.pendientes}. `
      + `Motivos: ${motivos}.`,
  });
}

// ───────────────────────────────────── El recorrido ─────────────────────────────────────────────

function sumar(motivos: ResumenMotivosCorrida, clave: MotivoCaidaRunt | 'reintentos', n = 1): void {
  if (n === 0) return;
  motivos[clave] = (motivos[clave] ?? 0) + n;
}

/**
 * Recorre los vehículos que toca verificar hoy.
 *
 * De aquí solo salen conteos (AC7). Un vehículo que falla NO aborta la corrida: se cuenta como
 * `pendiente` y el reintento horario lo recoge. Lo único que se propaga es un fallo de la propia
 * base, envuelto en {@link RecorridoVigenciaError} para que el cron loguee un nombre y no un mensaje.
 */
export async function recorrerVigenciaSoat(
  params: RecorridoVigenciaParams,
): Promise<ResultadoRecorridoVigencia> {
  const arranque = Date.now();

  let vehiculos: VehiculoAVerificar[];
  try {
    vehiculos = await vehiculosAVerificar(params.dia);
  } catch {
    // El mensaje de un fallo de base puede traer dentro el VIN de una fila; solo sobrevive el nombre.
    throw new RecorridoVigenciaError('no se pudo leer el censo de vehículos a verificar');
  }

  const r: ResultadoRecorridoVigencia = {
    considerados: vehiculos.length, verificados: 0, pendientes: 0, cambiaron: 0, motivos: {},
  };

  for (let i = 0; i < vehiculos.length; i += VEHICULOS_POR_TANDA) {
    // Las DOS guardas van ANTES de tomar la tanda, no después: lo que se decide aquí es si merece la
    // pena gastar N llamadas más, y con el circuito abierto la respuesta es que no — rebotarían al
    // instante, marcarían todo `no_verificado` y encima mantendrían el circuito abierto para
    // cualquier persona que esté usando el sistema (AC6).
    const restantes = vehiculos.length - i;
    if (circuitoAbierto(CIRCUITO_RUNT)) {
      r.pendientes += restantes;
      sumar(r.motivos, 'circuito', restantes);
      log.warn(
        { dia: params.dia, intento: params.intento, pendientes: restantes },
        'corrida de vigencia: circuito del RUNT abierto, se para y el resto queda pendiente',
      );
      break;
    }
    if (Date.now() - arranque >= PRESUPUESTO_CORRIDA_MS) {
      r.pendientes += restantes;
      log.warn(
        { dia: params.dia, intento: params.intento, pendientes: restantes },
        'corrida de vigencia: presupuesto agotado antes del TTL del candado, el resto queda pendiente',
      );
      break;
    }

    const tanda = vehiculos.slice(i, i + VEHICULOS_POR_TANDA);
    // Pool de promesas y NO un `for` en serie ni un `Promise.all` del lote entero: el primero
    // tardaría N × latencia del RUNT y se saldría del presupuesto; el segundo abriría el circuito
    // compartido de un golpe. `conConcurrencia` no bloquea el event loop.
    const consultas = await conConcurrencia(
      tanda, env.SOAT_VIGENCIA_CONCURRENCIA, (v) => verificarVehiculo(v.vin),
    );

    for (let j = 0; j < tanda.length; j += 1) {
      const v = tanda[j]!;
      const { respuesta, reintentos } = consultas[j]!;
      sumar(r.motivos, 'reintentos', reintentos);

      const desenlace = clasificarVigencia(respuesta);
      if (desenlace.estado === 'no_verificado') {
        // Un silencio NO es un verificado. Este conteo es lo único que reprograma el reintento.
        r.pendientes += 1;
        sumar(r.motivos, desenlace.motivo);
      } else {
        r.verificados += 1;
      }

      try {
        if (await escribirDesenlace(v, desenlace, new Date(), params)) r.cambiaron += 1;
      } catch {
        throw new RecorridoVigenciaError('no se pudo escribir el desenlace de la verificación');
      }
    }
  }

  try {
    await auditarCorrida(params, r);
  } catch {
    throw new RecorridoVigenciaError('no se pudo auditar la corrida de verificación');
  }

  return r;
}
