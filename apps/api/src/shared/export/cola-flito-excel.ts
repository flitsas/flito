// FLITO — el archivo `.xlsx` de las colas de SOAT e Impuestos (Feature #11908, HU #11909).
//
// Las dos colas exportan LA MISMA hoja: once columnas del vehículo y de su propietario. Vive aquí y
// no duplicado en cada módulo por el motivo que la HU deja escrito y que ya se ha cumplido antes en
// este repo: dos listas de columnas copiadas divergen en el cambio siguiente —alguien añade una
// columna donde está trabajando y no en la otra— y a partir de ahí el mismo botón produce dos
// archivos distintos según la pantalla. El precedente de directorio compartido es
// `shared/soportes/soportes-consulta.ts`, que resolvió lo mismo con los soportes de los dos módulos.
//
// Lo que NO vive aquí: de dónde sale cada valor. Eso es de cada módulo —el SOAT lee la ciudad de sus
// trámites y reconcilia, el impuesto la tiene 1:1— y por eso cada uno tiene su
// `*.export.service.ts`. Aquí solo está lo que el archivo TIENE que compartir para no divergir: qué
// columnas hay, cómo se llaman, cómo se sella el nombre del archivo, qué error corta el export y
// —desde la corrección del gate de seguridad— la CUOTA, que es compartida por el mismo motivo que el
// tope: lo que se está racionando es el heap de UN proceso. Ver `exportColaLimiter` al final.

import rateLimit from 'express-rate-limit';
import { makeStore, userOrIpKey } from '../middleware/rateLimiter.js';
import { TZ_COLOMBIA } from '../utils/fecha-rango.js';

/**
 * Las ONCE columnas del archivo, en su orden exacto (AC1 de la HU #11909).
 *
 * Es una LISTA BLANCA escrita a mano, igual que `COLUMNAS_EXPORT` de comparendos y por lo mismo: una
 * columna personal que alguien añada mañana a la proyección de la cola no puede aparecer en un
 * archivo que sale del perímetro por el mero hecho de existir. `Object.keys(fila)` daría lo
 * contrario — y las tres celdas más sensibles de esta hoja (cédula, correo, dirección) hacen que esa
 * diferencia no sea académica.
 *
 * **Las cabeceras van en MAYÚSCULAS y SIN TILDES, y son exactamente estas once.** Es decisión de
 * producto pegada en la HU: «las columnas son exactamente…». No hay `Municipio`, no hay columna de
 * fecha de creación aunque el filtro nuevo sea por ella, y no hay nombre del propietario —solo su
 * documento—. Añadir una «por conveniencia» rompe el AC1 y, en el caso del nombre, ampliaría lo que
 * el archivo publica sin que nadie lo haya decidido.
 *
 * Quien lea este archivo desde fuera tiene que localizar las columnas POR EL TEXTO de la cabecera y
 * no por su posición: el orden es contrato de esta HU, pero es el texto lo que se mantiene estable
 * si algún día se inserta una columna.
 */
export const COLUMNAS_COLA_EXPORT: { header: string; key: string; width: number }[] = [
  { header: 'PLACA', key: 'placa', width: 12 },
  { header: 'CEDULA', key: 'cedula', width: 16 },
  { header: 'CORREO', key: 'correo', width: 32 },
  { header: 'TELEFONO', key: 'telefono', width: 16 },
  { header: 'DIRECCION', key: 'direccion', width: 36 },
  { header: 'VIN', key: 'vin', width: 20 },
  { header: 'CIUDAD', key: 'ciudad', width: 20 },
  { header: 'CARROCERIA', key: 'carroceria', width: 18 },
  { header: 'TIPO DE SERVICIO', key: 'tipoServicio', width: 18 },
  { header: 'CILINDRAJE', key: 'cilindraje', width: 12 },
  { header: 'ORGANISMO DE TRANSITO', key: 'organismoTransito', width: 30 },
];

/**
 * Una fila del archivo, con las claves de {@link COLUMNAS_COLA_EXPORT}.
 *
 * Extiende `Record<string, string | null>` por dos motivos, y el segundo es el que importa: el
 * primero es que `sendExcel` recibe `Record<string, unknown>[]`; el segundo es que la firma cierra
 * los VALORES a `string | null`, de modo que un `Date`, un número o un objeto no pueden acabar en
 * una celda por accidente. Todo lo que entra en esta hoja es texto ya formateado o vacío.
 */
export interface FilaColaExport extends Record<string, string | null> {
  placa: string | null;
  cedula: string | null;
  correo: string | null;
  telefono: string | null;
  direccion: string | null;
  vin: string | null;
  ciudad: string | null;
  carroceria: string | null;
  tipoServicio: string | null;
  cilindraje: string | null;
  organismoTransito: string | null;
}

/**
 * Columnas personales que este archivo entrega, con el nombre que tienen en la BASE (Ley 1581
 * art. 17).
 *
 * Se declara aquí, junto a las columnas, para que quien toque {@link COLUMNAS_COLA_EXPORT} vea en la
 * misma pantalla lo que el `pii_access_log` va a tener que decir. Es la lista del EXPORT y no la de
 * la cola: son lecturas distintas y declarar de más hace que `campos_accedidos` deje de decir la
 * verdad, que es lo único que ese registro tiene que hacer.
 *
 * `nombre_completo` NO está, y es la comprobación de que la lista describe el archivo y no la tabla:
 * la hoja lleva la CÉDULA del propietario pero no su nombre. `ciudad` sí: es del trámite del
 * titular, viaja en el archivo y hasta esta HU no se registraba en ninguna parte.
 */
export const CAMPOS_PII_COLA_EXPORT = [
  'numero_documento', 'correo', 'celular', 'direccion', 'placa', 'vin', 'ciudad',
] as const;

/**
 * El nombre del organismo tal como se imprime: el alias, y si no lo hay, su código.
 *
 * `organismos_transito_config.alias` es NULLABLE. Sin este escalón, un organismo sin alias dejaría
 * la celda vacía teniendo el código a mano —que es un dato útil y el que aparece en el filtro— o,
 * peor, escribiría la cadena `"null"` si alguien resolviera el hueco con un `String()`. El orden es
 * el que sirve al lector: primero cómo se llama, y solo si no se sabe, cómo se identifica.
 */
export function organismoParaExport(alias: string | null, codigo: string | null): string | null {
  const nombre = alias?.trim();
  if (nombre) return nombre;
  const cod = codigo?.trim();
  return cod ? cod : null;
}

/**
 * Un valor de texto tal como va a la celda: el propio texto, o VACÍO si no hay dato (AC7).
 *
 * `null` viaja como `null` y ExcelJS deja la celda sin escribir. Nunca `"—"` —eso lo pinta la
 * interfaz, no el backend (`flito-soat.service.ts`, comentario de los datos técnicos)—, nunca
 * `"null"` y nunca `String(null)`: una celda vacía se filtra en Excel y un texto de relleno no, y
 * además un guion en la columna CEDULA de un archivo que alguien va a conciliar es un dato inventado
 * con aspecto de cierto. Es la misma regla que ya aplica `flito-comparendos.export.service.ts`.
 *
 * La cadena vacía y la que solo tiene espacios se tratan como ausencia por lo mismo: `" "` en una
 * celda es indistinguible de vacío a la vista y distinto al filtrar.
 */
export function celdaTexto(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  const limpio = valor.trim();
  return limpio === '' ? null : limpio;
}

/**
 * El sello de tiempo del nombre del archivo, en hora de COLOMBIA y no en la del servidor (UTC).
 *
 * Misma decisión que tomó el export de comparendos: quien descarga a las 9 de la mañana espera un
 * archivo que diga las 9. Se arma por PARTES y no recortando el `format()` porque el separador que
 * mete ICU entre fecha y hora cambia entre versiones —coma, espacio estrecho, espacio duro—, y un
 * `replace(', ', ' ')` que un día no case metería una coma dentro de una cabecera HTTP.
 */
const FORMATO_SELLO = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ_COLOMBIA,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * `<prefijo>_YYYYMMDD-HHmm.xlsx`.
 *
 * Lleva marca de tiempo porque un export se repite —se afina el filtro y se vuelve a bajar— y tres
 * archivos con el mismo nombre en la carpeta de descargas se convierten en `soat (2).xlsx`, que no
 * dice cuál es cuál.
 *
 * **No lleva NADA del filtro**, y aquí eso pesa más que en comparendos: el filtro `buscar` de estas
 * colas casa contra placa, VIN, nombre y cédula, así que meterlo en el nombre escribiría la cédula
 * de un titular en el sistema de archivos de quien descarga y en cualquier adjunto que reenvíe.
 */
export function nombreArchivoColaExport(prefijo: 'soat' | 'impuestos', ahora: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const parte of FORMATO_SELLO.formatToParts(ahora)) p[parte.type] = parte.value;
  return `${prefijo}_${p.year}${p.month}${p.day}-${p.hour}${p.minute}.xlsx`;
}

/**
 * El filtro exportado se pasa del tope: no hay archivo (RN de la HU, ADR-0004 §2).
 *
 * **422 y no 400**: la petición está bien formada y el filtro es legítimo; lo que no cabe es el
 * RESULTADO. Esa diferencia es la que permite a la pantalla decir «acota el filtro» en vez de
 * «revisa lo que escribiste».
 *
 * **No dice cuántas filas hay.** No se sabe —la comprobación es `tope + 1`, así que el número exacto
 * ni se ha contado— y devolverlo convertiría el 422 en un contador de registros por filtro: quien no
 * puede llevarse los datos podría al menos preguntar «¿cuántos SOAT tiene esta compañía?» sin dejar
 * más rastro que un error. El mensaje dice el TOPE, que es el dato con el que el usuario actúa.
 *
 * **Es una clase propia y NO un `SoatError`/`ImpuestoError`, a propósito.** Esos dos llevan solo
 * `status` + `message` y sus `handleError` responden `{ error }` sin `codigo`; la pantalla decide
 * por `codigo`. Colgarlo de ellos obligaría a cambiar el sobre de error de todos los demás endpoints
 * de los dos módulos para servir a uno. El 422 lo emite el `catch` propio de cada ruta de export.
 */
export class ExportColaDemasiadoGrandeError extends Error {
  /** Lo que la pantalla lee para distinguir este 422 de cualquier otro. */
  readonly codigo = 'export_demasiado_grande';
  readonly status = 422;

  constructor(tope: number) {
    super(
      `El filtro aplicado supera las ${tope.toLocaleString('es-CO')} filas que admite un export. `
      + 'Acota la búsqueda —por estado, por compañía, por organismo o por fecha— y vuelve a intentarlo.',
    );
    this.name = 'ExportColaDemasiadoGrandeError';
  }
}

/**
 * La cuota del export de las DOS colas: 5 por minuto y usuario, en UNA sola bolsa compartida.
 *
 * ── Por qué una y no una por cola (corrección del gate de seguridad de la HU #11909) ─────────────
 *
 * La primera versión de esta HU le dio una bolsa a cada router, con el argumento de que «son dos
 * colas y dos pantallas, así que descargar la de impuestos no puede frenar la de SOAT». Ese
 * argumento es el CONTRARIO del que sostiene `FLITO_COLA_EXPORT_MAX_FILAS`, que es una sola perilla
 * para las dos precisamente porque «el presupuesto que se reparte es el del PROCESO, y el proceso es
 * uno» (`config/env.ts`). Un presupuesto de heap y dos bolsas de peticiones que lo llenan es la
 * misma contradicción escrita dos veces.
 *
 * Y no es teórica. `sendExcel` construye el workbook ENTERO en memoria, el API corre en una sola
 * instancia fork con `max_memory_restart: '512M'` (`ecosystem.config.cjs`) y ADR-0004 midió que con
 * el tope en 2 000 **cinco exports simultáneos suman +239 MB de los 262 disponibles** —23 MB de
 * margen, y el sexto ni siquiera está medido—. El limitador cuenta peticiones POR MINUTO, no en
 * vuelo, y la cuota es por usuario sin cota global: **una sola sesión** puede tener los cinco
 * construyéndose a la vez. Con dos bolsas nuevas, esa misma sesión pasa de 5 a 10 concurrentes
 * posibles y se come el margen entero. Que esta hoja tenga once columnas y no veintiuna no salva: el
 * propio ADR advierte que a esa escala manda el ruido del allocator y del GC, no el número de filas.
 *
 * El segundo motivo es de privacidad, y es el mismo con el que comparendos razona su 5/min: la cuota
 * multiplicada por el tope ES el techo de extracción del módulo. Con una bolsa son 10 000 filas por
 * minuto y usuario; con dos, 20 000 — y cada fila de aquí lleva cédula, correo, teléfono y dirección
 * del titular, más PII por fila que la de comparendos.
 *
 * Lo que se paga es lo que decía aquel comentario: quien acaba de bajar cinco archivos de SOAT no
 * puede bajar el sexto de Impuestos hasta que pase el minuto. Es el intercambio correcto — el
 * recurso que se está racionando no es «la pantalla», es el heap del proceso, y es uno.
 *
 * ── Por qué es UNA INSTANCIA y no dos `rateLimit()` con la misma llave ───────────────────────────
 *
 * `makeStore` devuelve `undefined` cuando no hay Redis (desarrollo, CI, tests), y entonces
 * `express-rate-limit` crea un `MemoryStore` **por llamada**. Dos llamadas con el mismo
 * `keyGenerator` compartirían el nombre de la llave y NO el contador: el freno se vería idéntico en
 * el código y valdría el doble en ejecución. Por eso el middleware se construye aquí una vez y los
 * dos routers importan el MISMO objeto.
 *
 * ── Lo que este limitador NO hace ────────────────────────────────────────────────────────────────
 *
 * No acota la CONCURRENCIA (no es un semáforo) ni el volumen diario. ADR-0004 dejó las dos cosas
 * fuera de alcance a propósito, junto con el `WorkbookWriter` en streaming; esto es la cuota que el
 * ADR sí decide, aplicada al recurso que de verdad se comparte.
 *
 * Y NO toca la bolsa del export de comparendos (`rl:flito-comparendos-export:`), que es anterior y
 * vive en su módulo: unificarla también es una decisión sobre código que esta HU no trae.
 *
 * **Un 422 consume cuota igual que un 200, y no es un descuido**: `express-rate-limit` cuenta la
 * petición al entrar, antes del handler. Si el export demasiado grande saliera gratis, sondear el
 * tamaño de un filtro —«¿cuántos SOAT tiene esta compañía?»— sería ilimitado, que es justo la
 * pregunta que el 422 evita responder.
 *
 * `userOrIpKey` y no la IP pelada: varios usuarios de Operaciones salen por la misma IP corporativa,
 * y frenar por IP castigaría a la oficina entera por lo que hace una cuenta.
 */
export const exportColaLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey('flito-cola-export'),
  message: { error: 'Demasiados exports seguidos, espera 1 minuto' },
  store: makeStore('rl:flito-cola-export:'),
});
