// FLITO — SOAT, canal Cliente: lo que habla con el RUNT y CÓMO se clasifica su respuesta.
// Diseño: docs/diseno-hu-11966-runt-compuerta-excel-cliente.md · ADR-0010 (supersede ADR-0009).
//
// **El RUNT vuelve a ser compuerta del alta** (HU #11966). Los DOS endpoints del canal —la
// preconsulta y `POST /cliente`— consultan Kyverum ANTES de escribir nada y traducen su respuesta a
// uno de cuatro desenlaces ({@link DesenlaceRunt}). No hay job post-commit: la #11935 lo introdujo y
// esta HU lo borra entero, que es lo que hace ESTRUCTURAL el «las filas ya radicadas no se
// reconsultan» del AC6 — sin función, no hay reconsulta posible por descuido.
//
// ── Y desde la HU #12090 se consulta SOLO POR VIN ────────────────────────────────────────────────
//
// La entrada de este archivo era `(placa, vin?, documento, tipoDocumento)`; hoy es `(vin)` y nada
// más. La modalidad de VIN del RUNT (`tipoConsulta: '2'`) no pide documento del propietario —es la
// consulta por placa la que lo exige (Bug #11927)—, así que el canal deja de mandar al registro
// nacional la cédula de nadie para preguntar por un vehículo. Lo que se contrasta también cambia de
// dueño: antes se comparaban placa y VIN contra lo tecleado; ahora la placa es un dato DEVUELTO y lo
// único que se contrasta es el VIN. Ver {@link campoQueNoCuadra}.
//
// El payload crudo no se persiste (ADR-0008 §1.6, esa frase se conserva). Solo derivados.

import { eq } from 'drizzle-orm';
import { polizaParaColumna, resolverCodigoOrganismoRunt } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { organismosTransitoConfig } from '../../db/schema.js';
import { extraerVehiculoRunt, normalizarIdentificador, runtSinRegistro } from '../flito-impuestos/certificacion-runt.js';
import { derivePreflightChecks } from '../tramites/preflight.js';
import { consultarVehiculoRunt } from '../runt/runt.service.js';
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
  /**
   * Número de motor y de serie (HU #12401). Llegan por `...base` del extractor común; van a
   * `vehicles.num_motor` / `num_serie` con la política de «un vacío no borra» y recorte a la
   * columna (`runt/vehiculo-motor-serie.ts`). NO se publican en la preconsulta: la pantalla no los
   * muestra y todo lo que sale por ahí es «dato del RUNT» que alguien acaba enseñando.
   */
  numMotor: string | null;
  numSerie: string | null;
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
 * Los seis primeros —y motor y serie, desde la HU #12401— salen de `extraerVehiculoRunt`, que es
 * el extractor que ya resuelve los alias del RUNT y está verificado contra una consulta real
 * (`certificacion-runt.ts`). NO se reescribe: duplicar las cadenas de alias es garantizar que
 * dentro de un mes digan cosas distintas. Los siete que faltan —cilindraje, servicio, carrocería,
 * pasajeros, puertas, organismo y propietario— no están en `DatosVehiculoRunt` porque la
 * certificación de impuestos no los compara, y se leen aquí con el mismo criterio.
 *
 * Las cadenas de alias de los tres nuevos (HU #11966) siguen la nomenclatura medida del payload:
 * `tipoCarroceria`, `pasajerosSentados` y `puertas` dentro de `data.vehiculo`, con los sinónimos
 * habituales por si el tipo de vehículo cambia la forma (una moto o un remolque no traen lo mismo).
 * `datosTecnicos` se mira como segunda vía, igual que ya hacen cilindraje y servicio.
 *
 * **`organismoNombre` pasa a leerse por las DOS vías (Bug #12179).** Era el único de los trece que se
 * leía solo de `data.vehiculo`, sin razón que lo distinga de sus cinco vecinos: el RUNT reparte los
 * campos entre `vehiculo` y `datosTecnicos` sin contrato estable, y esa asimetría convertía «el RUNT
 * lo mandó en el otro nodo» en «el RUNT no lo mandó». Alinearlo no relaja nada —`alias` sigue
 * exigiendo un valor no vacío— y quita una de las dos causas posibles del «—» de la ficha.
 *
 * **`tipoDocPropietario` NO se extrae, y no es un olvido** (HU #12090, AC2). Vive un nivel más
 * arriba (`data.tipoDocPropietario`, hermano de `vehiculo`) y en la modalidad de VIN vale siempre
 * `'C'`: no es lo que el registro dice del propietario, es el tipo con el que la vía directa
 * intentó la consulta —`tiposAIntentar = ['C']` cuando hay VIN—. Leerlo aquí lo metería en
 * `DatosRuntCanal`, y todo lo que entra ahí acaba persistido o publicado como «dato del RUNT».
 * Quien lo necesite de verdad es la certificación de impuestos, que consulta POR PLACA y lo guarda
 * en su propia tabla (`flito_certificaciones_runt.tipo_doc_propietario`); ese uso no cambia.
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
    organismoNombre: dosVias(['organismoTransito', 'organismoTransitoNombre', 'nombreOrganismoTransito']),
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

/**
 * El número de póliza que el RUNT reporta, normalizado, o `null` (HU #12096).
 *
 * Vive aquí y no en el servicio de vigencia porque lee el MISMO bloque `data.soat` que
 * {@link fechaVencimientoSoatRunt} y con el mismo `alias`: dos extractores del mismo nodo en
 * archivos distintos acaban resolviendo alias distintos.
 *
 * Se normaliza con `polizaParaColumna` —el mismo helper que usa `pagarEnTx` para `numero_poliza`—
 * y no «como se leyó»: la columna a la que va (`poliza_runt`) es varchar(60) y la gracia de tenerla
 * es poder compararla con la del OCR. Dos normalizaciones distintas harían que dos veces la misma
 * póliza pareciera reexpedida.
 */
export function polizaSoatRunt(data: unknown): string | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const bruto = Array.isArray(d.soat) ? d.soat[0] : d.soat;
  const soat = (bruto ?? null) as Record<string, unknown> | null;
  const valor = alias(soat, ['numeroPoliza', 'noPoliza', 'numPoliza', 'poliza']);
  return polizaParaColumna(valor);
}

/** `yyyy-mm-dd` si los tres números son un día del calendario; `null` si no. */
function fechaValida(anio: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || anio < 1900 || anio > 2200) return null;
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * El día de HOY en Colombia, `yyyy-mm-dd`, sin depender de la zona del proceso (HU #12212).
 *
 * El contenedor corre en UTC y el umbral de la renovación anticipada es una regla de negocio
 * colombiana: a las 19:00 de Bogotá el reloj del proceso ya está en el día siguiente, y con él la
 * frontera inclusive del AC4 se correría un día entero para todas las solicitudes de la tarde.
 *
 * **La receta está DUPLICADA a propósito** (`Intl.DateTimeFormat('en-CA', { timeZone })` +
 * `formatToParts`): es la misma de `ahoraEnBogota` (`flito-soat-vigencia.cron.ts`) y no se importa
 * porque `cron → vigencia.service → cliente-runt` ya es una cadena de imports, así que traerla
 * cerraría un ciclo. Consolidar las dos en un helper compartido es otra HU; mientras tanto, lo que
 * no puede divergir es el `timeZone` y el locale `en-CA` —que es el que emite `yyyy-mm-dd`—.
 *
 * Aquí solo hace falta el día: la hora y el minuto que el cron necesita para su ventana de arranque
 * no tienen lector en esta regla, y devolverlos invitaría a decidir el umbral con una hora.
 */
export function diaEnBogota(ahora: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(ahora);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/**
 * La última fecha que cuenta como «vence en un mes o menos»: MISMA FECHA DEL MES SIGUIENTE.
 *
 * Mes CALENDARIO y no 30 días: es lo que decidió el PO y lo que la persona entiende por «un mes».
 * Se construye con `Date.UTC(anio, mes, dia)` —igual que {@link fechaValida}— y con **clamp** al
 * último día del mes siguiente cuando ese día no existe: `2027-01-31` → `2027-02-28`, nunca el
 * `2027-03-03` al que desbordaría `Date` por su cuenta (AC5). Desbordar ampliaría el umbral en
 * silencio justo para los días finales de mes.
 *
 * El paso al año siguiente sale gratis del índice de mes 0-based: diciembre → `Date.UTC(a, 12, d)`.
 */
export function limiteRenovacionAnticipada(hoy: string): string {
  const anio = Number(hoy.slice(0, 4));
  const mes = Number(hoy.slice(5, 7));
  const dia = Number(hoy.slice(8, 10));
  // `Date.UTC(anio, mes + 1, 0)` es el día CERO del mes que sigue al siguiente, o sea el último del
  // mes siguiente. De ahí sale el clamp, sin tabla de longitudes ni regla de bisiestos escrita a mano.
  const ultimoDiaMesSiguiente = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  const limite = new Date(Date.UTC(anio, mes, Math.min(dia, ultimoDiaMesSiguiente)));
  const mm = String(limite.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(limite.getUTCDate()).padStart(2, '0');
  return `${limite.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * ¿Al SOAT que el RUNT reporta vigente le queda **un mes o menos**? (HU #12212).
 *
 * Comparación LEXICOGRÁFICA de cadenas `yyyy-mm-dd` —el mismo criterio que ya usa `vigenciaVista`
 * en `flito-soat.service.ts`—: sin `Date`, sin husos y sin medianoche del proceso. Con ese formato
 * el orden alfabético ES el cronológico, y no hay una hora que pueda mover la frontera.
 *
 * **La frontera es INCLUSIVE** (`<=`): si vence exactamente dentro de un mes, se permite.
 *
 * **Sin fecha, `false`**, y es el defecto seguro del AC3: el RUNT dice «vigente» pero no dice hasta
 * cuándo, y de ahí no se puede deducir que falte un mes o menos. Se queda en el 409 de siempre.
 *
 * Un `venceEl` ANTERIOR a hoy también cae del lado «no bloquea», y es el resultado correcto: es una
 * póliza que el RUNT sigue reportando y que ya venció.
 */
export function esRenovacionAnticipada(venceEl: string | null, hoy: string): boolean {
  if (!venceEl) return false;
  return venceEl <= limiteRenovacionAnticipada(hoy);
}

/**
 * El organismo del RUNT, traducido a código DIVIPOLA y comprobado contra la tabla.
 *
 * Dos comprobaciones: `resolverCodigoOrganismoRunt` cruza el nombre contra el catálogo nacional,
 * y `organismos_transito_config` es la tabla a la que apunta la FK. Devuelve `null` si no cruza
 * — y `null` NO aborta nada (AC5 de la HU #11966): la fila se crea igual con el organismo vacío y
 * el satélite anotando `organismo_no_catalogado`.
 *
 * **Por qué el resolutor TOLERANTE y no `resolverCodigoOrganismoFlit` (Bug #12179).** Aquí solo hay
 * una cadena, la que redacta el RUNT, y su redacción varía respecto de la del catálogo. La igualdad
 * exacta solo acertaba cuando el RUNT escribía literalmente la redacción propia de FLIT, así que
 * organismos que el registro SÍ mandaba acababan en `organismo_no_catalogado` y en un «—» en la
 * ficha. El resolutor exacto se conserva para el reporte de FLIT, que trae la ciudad aparte y no
 * debe volverse más laxo. La segunda comprobación —la tabla de la FK— **no se relaja**: un código
 * que el catálogo nacional conoce pero la tabla no sigue siendo `null`.
 */
export async function resolverOrganismoCatalogo(nombre: string | null): Promise<string | null> {
  const codigo = resolverCodigoOrganismoRunt(nombre);
  if (!codigo) return null;
  const [fila] = await db.select({ codigo: organismosTransitoConfig.codigo })
    .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  return fila?.codigo ?? null;
}

/**
 * ¿El VIN que el RUNT devuelve difiere del que se tecleó? `'vin'` si difiere, `null` si no.
 *
 * ── Qué se contrasta desde la HU #12090, y qué dejó de contrastarse (AC3) ───────────────────────
 *
 * Contrastaba placa Y VIN, porque los dos eran datos TECLEADOS y los dos podían escribirse mal. Con
 * la consulta por VIN la placa deja de ser entrada: viaja como dato DEVUELTO por el registro, y
 * contrastar un dato contra sí mismo no es una comprobación, es una tautología que además nunca
 * podría fallar. Queda un solo contraste, y es el que sigue teniendo sentido: lo que la persona
 * escribió contra lo que el registro nacional dice.
 *
 * Un VIN que el RUNT no trajo (`NO_VERIFICABLE`) NO es «no cuadra» — misma normalización que
 * `compararCampo` de certificación—: es {@link DesenlaceRunt} `runt_sin_vin`, que dice la verdad
 * («el registro no publica el VIN») en vez de pedirle a la persona que corrija algo suyo. La guarda
 * de ausencia es lo que separa los dos desenlaces y por eso no se puede simplificar a
 * `vinRunt !== vinIn`.
 *
 * Devuelve el campo y no un booleano porque el 422 lleva `campo: 'vin'` para que el wizard ponga el
 * foco donde toca — y hoy ese es además el ÚNICO campo que la persona pudo escribir mal.
 */
export function campoQueNoCuadra(vinTecleado: string, datos: DatosRuntCanal): 'vin' | null {
  const vinRunt = normalizarIdentificador(datos.vin);
  const vinIn = normalizarIdentificador(vinTecleado);
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
 * Consulta Kyverum **por VIN y solo por VIN** (HU #12090, AC2). No clasifica: quien llama decide.
 *
 * ── Los cuatro argumentos de la llamada, y por qué son estos ────────────────────────────────────
 *
 * `consultarVehiculoRunt(placa, vin, documento, tipoDocumento)` elige modalidad por lo que recibe, y
 * la elige en `runt-direct.service.ts`: `vinNorm = (!placa && vin)`. Es decir, **basta con que la
 * placa vaya para que la modalidad de VIN NO se active**, aunque el VIN también viaje. Por eso aquí
 * la placa va `undefined` y no «vacía por si acaso»: con `''` el resultado sería el mismo hoy —es
 * falsy— pero la intención quedaría a merced de la próxima persona que «normalice» ese predicado.
 * Con la modalidad activa, el cuerpo que sale al RUNT lleva `tipoConsulta: '2'`, `placa: ''`,
 * `documento: ''` y `tipoDocumento: ''` (`runt-direct.service.ts`), que es el AC2 literal.
 *
 * `documento` y `tipoDocumento` van en CADENA VACÍA y no en `undefined` porque aquí no hay un dato
 * que se omite: hay un dato que esta consulta ya no tiene y no debe inventarse. La vía de la
 * pasarela (`consultarVehiculoProxy`) los omite del cuerpo por ser falsy, así que la cédula del
 * propietario deja de salir del perímetro para preguntar por un vehículo por las DOS vías.
 *
 * **`mapTipoDocUiToRunt` ya no se llama, y su ausencia es parte del AC**: traducía el tipo de
 * documento de la UI al del RUNT, y en la modalidad de VIN no hay tipo de documento que traducir.
 * Lo que la vía directa devuelve como `tipoDocPropietario` en esta modalidad es la constante `'C'`
 * (`tiposAIntentar = ['C']`) — relleno fijo, no un dato del registro. Este canal no lo lee, no lo
 * persiste y no lo publica; ver el docblock de {@link extraerDatosCanal}, que no lo extrae.
 */
export async function consultarRuntCrudo(vin: string): Promise<RespuestaKyverum> {
  return await consultarVehiculoRunt(undefined, vin, '', '') as RespuestaKyverum;
}

/** Los códigos de la familia «revise los datos», tal como los emite la compuerta. */
export type CodigoRevise = 'runt_no_cuadra' | 'runt_sin_registro' | 'runt_sin_vin';

/** Lo que hace falta para CREAR la fila. Lo comparten los dos desenlaces que dejan pasar el alta. */
type PayloadOk = { datos: DatosRuntCanal; vinEfectivo: string; organismoCodigo: string | null };

/**
 * Los CINCO desenlaces posibles de una consulta al RUNT, y el único vocabulario con el que la
 * compuerta habla con los dos endpoints.
 *
 * Es un tipo de dominio y no un `SolicitudSoatError` a propósito: aquí se DECIDE qué pasó, y el
 * servicio traduce a HTTP. Separarlo permite que la preconsulta y el alta compartan la decisión —que
 * es la invariante del AC («los dos endpoints devuelven lo mismo ante el mismo RUNT»)— sin que este
 * archivo tenga que conocer códigos de estado.
 *
 * ── Por qué `renovacion_anticipada` es una CLASE y no un campo opcional de `ok` (HU #12212) ──────
 *
 * Es la misma razón que ya está escrita en `DESENLACE_HABLA_DEL_VEHICULO`. El `switch` de
 * `verificarRuntCompuerta` (`flito-soat-cliente.service.ts`) no tiene `default` y la función está
 * tipada `Promise<ResultadoRunt>`; con `strict:true`, añadir un miembro a esta unión **rompe el
 * build** hasta que exista su `case`. Un `venceEl?: string` colgado de `ok` habría compilado igual
 * el día que se añadiera y el aviso se habría perdido en silencio en cualquier rama que no lo
 * leyera. El compilador es aquí el único lector que no se olvida.
 *
 * Lleva el payload de `ok` ENTERO —el alta que la renovación anticipada permite crea la misma fila
 * que cualquier otra— más las dos cosas que la distinguen: hasta cuándo vence lo que el RUNT reporta
 * y qué póliza es. La póliza viaja hasta aquí porque se PERSISTE (`poliza_runt`); no se publica en
 * el 200 de la preconsulta (RN-B1).
 */
export type DesenlaceRunt =
  | ({ clase: 'ok' } & PayloadOk)
  | ({ clase: 'renovacion_anticipada'; venceEl: string; poliza: string | null } & PayloadOk)
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
 *   3. El VIN devuelto difiere del tecleado → `runt_no_cuadra` + `campo: 'vin'` (HU #12090, AC3).
 *   4. Sin VIN en la respuesta → `runt_sin_vin`. Sin VIN efectivo no hay fila posible (RN-01).
 *   5. SOAT vigente → `renovacion_anticipada` si vence en un mes o menos; si no, `vigente`.
 *   6. `ok`, con el organismo cruzado contra catálogo (o `null`, que NO aborta — AC5).
 *
 * **El orden se conserva ENTERO** (HU #12090, AC4; HU #12212, AC7): lo único que cambia es QUÉ
 * compara el paso 3 y en qué se BIFURCA el paso 5, no cuándo se comparan ni en qué orden. La
 * vigencia sigue DESPUÉS de los «revise»: si los datos del RUNT no sirven para identificar el
 * vehículo, decir «ya tiene SOAT vigente» —o abrirle la puerta a un alta por renovación
 * anticipada— sería afirmar algo sobre un vehículo que no se ha confirmado que sea el que se
 * radica. Un VIN que no cuadra sigue siendo `422 runt_no_cuadra` aunque el SOAT venza mañana.
 *
 * `hoy` es un PARÁMETRO con defecto y no una lectura del reloj dentro del cuerpo: es lo que deja
 * congelarlo en los tests sin tocar el reloj del proceso ni la zona horaria. El defecto
 * {@link diaEnBogota} se evalúa en cada llamada, así que en producción es siempre el día de hoy.
 */
export async function clasificarDesenlaceRunt(
  respuesta: RespuestaKyverum,
  vinTecleado: string,
  hoy: string = diaEnBogota(),
): Promise<DesenlaceRunt> {
  if (!respuesta?.ok) {
    if (esNegativaDeNegocio(respuesta)) return { clase: 'revise', codigo: 'runt_no_cuadra' };
    return { clase: 'caido' };
  }
  if (runtSinRegistro(respuesta.data)) return { clase: 'revise', codigo: 'runt_sin_registro' };

  const datos = extraerDatosCanal(respuesta.data);

  // El 422 NUNCA lleva el VIN del RUNT. El riesgo cambió de forma con la HU #12090 y no
  // desapareció: antes era filtrar el VIN a quien sondeaba placas ajenas; ahora es confirmarle el
  // VIN bueno a quien sondea VINs de una flota —que son consecutivos—. Solo se dice QUÉ revisar.
  if (campoQueNoCuadra(vinTecleado, datos) !== null) {
    return { clase: 'revise', codigo: 'runt_no_cuadra', campo: 'vin' };
  }

  const vinEfectivo = normalizarIdentificador(datos.vin);
  if (vinEfectivo === null) return { clase: 'revise', codigo: 'runt_sin_vin' };

  if (soatVigenteSegunRunt(respuesta)) {
    const venceEl = fechaVencimientoSoatRunt(respuesta.data);
    // La renovación anticipada NO relaja ninguna otra guarda: se decide aquí, en el mismo paso 5 y
    // detrás de los cuatro anteriores. Sin fecha, `esRenovacionAnticipada` devuelve `false` y esto
    // cae en el `vigente` de siempre (AC3).
    if (esRenovacionAnticipada(venceEl, hoy)) {
      return {
        clase: 'renovacion_anticipada',
        venceEl: venceEl as string,
        poliza: polizaSoatRunt(respuesta.data),
        datos,
        vinEfectivo,
        organismoCodigo: await resolverOrganismoCatalogo(datos.organismoNombre),
      };
    }
    return { clase: 'vigente', fechaVencimiento: venceEl };
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
 * **El log no lleva placa, VIN, documento ni nombre de persona, y tampoco el mensaje CRUDO del
 * error** — solo el desenlace, la señal de transporte, un token de causa de vocabulario cerrado
 * ({@link causaDeCaida}) y, en los desenlaces que RESUELVEN organismo, su nombre con el cruce
 * de catálogo (Bug #12179; la justificación de por qué ese campo no es PII está en el cuerpo). Es lo
 * que hace falta para medir en DEV el riesgo de la clasificación (ver {@link esNegativaDeNegocio}) y
 * la causa del organismo vacío, sin abrir una vía de PII en logs.
 */
export async function consultarYClasificar(vin: string): Promise<DesenlaceRunt> {
  let respuesta: RespuestaKyverum;
  try {
    respuesta = await consultarRuntCrudo(vin);
  } catch (err: unknown) {
    // Un `throw` no es una respuesta: el defecto seguro es «caído», que no crea nada.
    //
    // `causa` y NO `err.message`: el mensaje es texto de un tercero y puede traer dentro el VIN con
    // el que se consultó (antes, la placa y el documento). Ver `causaDeCaida`.
    log.warn(
      { desenlace: 'caido', causa: causaDeCaida(err), httpStatus: null },
      'compuerta RUNT del canal Cliente',
    );
    return { clase: 'caido' };
  }

  const desenlace = await clasificarDesenlaceRunt(respuesta, vin);

  // ── La línea de los desenlaces que resuelven organismo, y por qué existe (Bug #12179) ────────
  //
  // El «—» de la ficha tiene DOS causas posibles y desde fuera son indistinguibles: que el RUNT no
  // mandara el organismo, o que lo mandara y el canal no lo cruzara contra el catálogo. El nombre
  // crudo no se persistía ni se logueaba en ninguna parte, así que la nota del work item («el campo
  // llega nulo desde Kyverum») no se podía ni confirmar ni desmentir. Con estas dos claves sí:
  // `organismoRunt: null` es la primera causa, y un nombre con `organismoCatalogado: false` es la
  // segunda.
  //
  // **Por qué este campo SÍ puede entrar al log** y la placa, el VIN, el documento, el nombre del
  // propietario y `err.message` no: un organismo de tránsito es una ENTIDAD PÚBLICA —la secretaría
  // de un municipio—, no un dato de una persona identificada ni identificable, y no está en la
  // familia que `logPiiAccess` protege. Se distingue además de `err.message` en que no es texto
  // libre de una ruta de error: es un campo NOMBRADO del payload, con significado conocido, leído
  // por `alias`. Nada más entra en esta línea: ni el VIN con el que se consultó, ni la placa que el
  // RUNT devolvió, ni el propietario que viaja en el mismo nodo.
  //
  // ── La guarda es por PRESENCIA DEL PAYLOAD, no por lista de clases ──────────────────────────────
  //
  // `'organismoCodigo' in desenlace` es exactamente «este desenlace resolvió organismo», que es la
  // condición que esta línea mide. Estrecha la unión a las dos variantes que llevan `PayloadOk`
  // —`ok` y `renovacion_anticipada` (HU #12212)— y **cualquier desenlace futuro que lleve el mismo
  // payload entra solo**. Enumerar las dos clases funcionaría hoy y volvería a dejar fuera a la
  // siguiente en silencio, que es justo lo que pasó al llegar la renovación anticipada: una familia
  // entera de altas —que resuelven organismo y persisten `organismo_codigo` igual que las demás—
  // dejó de loguear sin que nada avisara.
  //
  // El `desenlace` va con la clase REAL, para poder separarlas en el log. Y nada más: `venceEl` y
  // `poliza` viajan en la renovación pero NO entran aquí — el número de póliza es cuasi-PII y no
  // tiene relación con lo que esta línea mide.
  if ('organismoCodigo' in desenlace) {
    log.info(
      {
        desenlace: desenlace.clase,
        organismoRunt: desenlace.datos.organismoNombre,
        organismoCatalogado: desenlace.organismoCodigo !== null,
      },
      'compuerta RUNT del canal Cliente',
    );
  }

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
