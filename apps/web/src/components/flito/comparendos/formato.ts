// FLITO — Comparendos: cómo se pinta un dato del registro. Nada de React aquí.
//
// Vivían dentro de `TablaComparendos.tsx` (HU #11560). Salen a un módulo propio en la HU #11562
// porque el panel de detalle pinta los MISMOS datos y no tiene por qué importar de un componente de
// tabla para formatear un monto — y sobre todo porque aquí se ve de un vistazo la distinción que la
// HU #11562 tuvo que introducir y que el nombre viejo escondía:
//
//   · `fechaCorta` / `fechaLarga` — una fecha de CALENDARIO (`date`, sin hora).
//   · `fechaColombia`             — un INSTANTE, del que solo se pinta el día.
//   · `fechaHoraColombia`         — el mismo instante CON su hora.
//   · `fechaHoraCortaColombia`    — ese instante con hora pero SIN año (HU #11636, tablas).
//
// El nombre `fechaHoraColombia` lo llevaba, hasta esta HU, la función que NO pinta hora: usaba
// `toLocaleDateString` con `{day, month, year}`. La tabla no necesita la hora —trece columnas y una
// corrida diaria— y el panel sí (el wireframe pide «2 jul 2026, 03:12»). Corregir la vieja en
// sitio habría cambiado tres columnas de la tabla y las aserciones vigentes de la #11560, así que
// se parte en dos: la de siempre se renombra a lo que hace y la de la hora nace nueva.

import type { ComparendoRegistro, ComparendosTipoRegistro } from '@operaciones/shared-types';

/** Guion de ausencia. `null` es información: hay fuentes que no traen la placa, la fecha o el monto. */
export const SIN_DATO = '—';

/**
 * Monto en pesos colombianos (HU #11560, AC1). Se formatea sobre `Number(monto)` **solo para
 * mostrar**: la columna es `numeric(14,2)` y en el cliente no se suma nada.
 */
export function pesos(monto: string | null): string {
  if (monto === null || monto.trim() === '') return SIN_DATO;
  const n = Number(monto);
  if (!Number.isFinite(n)) return SIN_DATO;
  return n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
}

/**
 * `YYYY-MM-DD` → `Date` local, o `null` si la cadena no es una fecha.
 *
 * Se parte a mano en vez de pasar por `new Date(fecha)`: esa forma la interpreta como medianoche
 * UTC y, al pintarla en hora de Colombia (UTC−5), retrocede un día — el comparendo decía 12 y la
 * tabla mostraba 11. Es una fecha de calendario, sin hora que convertir y sin huso al que moverla.
 */
function comoCalendario(fecha: string): Date | null {
  const [y, m, d] = fecha.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** `YYYY-MM-DD` → «12 jul 2026». La de las celdas de tabla, donde el ancho manda. */
export function fechaCorta(fecha: string | null): string {
  if (!fecha) return SIN_DATO;
  const d = comoCalendario(fecha);
  if (!d) return fecha;
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * `YYYY-MM-DD` → «12 de julio de 2026». La del panel de detalle (HU #11562), donde hay sitio.
 *
 * Mismo parseo de calendario que `fechaCorta` y por el mismo motivo: lo único que cambia es el mes.
 */
export function fechaLarga(fecha: string | null): string {
  if (!fecha) return SIN_DATO;
  const d = comoCalendario(fecha);
  if (!d) return fecha;
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Instante (columna `timestamptz`) en **hora de Colombia**, del que se pinta solo el DÍA.
 *
 * La zona va explícita: un operador con el portátil en otra zona —o un runner de CI en UTC— vería
 * «03:12» convertido a su hora local y creería que la corrida pasó a otra hora de la que pasó.
 * Sin `timeZone` esto es «la fecha de la máquina de quien mira», que es un dato distinto.
 */
export function fechaColombia(instante: string | null): string {
  if (!instante) return SIN_DATO;
  const t = new Date(instante);
  if (Number.isNaN(t.getTime())) return SIN_DATO;
  return t.toLocaleDateString('es-CO', {
    timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric',
  });
}

/**
 * El mismo instante **con su hora**, en hora de Colombia: «2 jul 2026, 03:12» (HU #11562).
 *
 * Es la del panel de detalle, donde la hora sí se lee: distinguir dos corridas del mismo día, o
 * saber si una gestión se registró antes o después de la sincronización de la madrugada, es
 * exactamente lo que el timeline responde.
 *
 * `hour12: false` a propósito: con «a. m./p. m.» la columna deja de alinear y, sobre todo, «12:30
 * a. m.» se lee mal a las 00:30. El resto del producto ya pinta horas de 24 en las bitácoras.
 *
 * El `timeZone` pesa aquí MÁS que en `fechaColombia`: sin él, un desfase de husos que allí solo se
 * nota en los instantes de madrugada, aquí desplaza TODAS las horas de la pantalla.
 */
export function fechaHoraColombia(instante: string | null): string {
  if (!instante) return SIN_DATO;
  const t = new Date(instante);
  if (Number.isNaN(t.getTime())) return SIN_DATO;
  return t.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * Cuánto tardó algo, en la unidad que se lee de un vistazo: «840 ms», «1,2 s», «2 min 5 s».
 *
 * La usa el detalle por fuente de una corrida (HU #11635): cada paso trae su `duracionMs` y la
 * columna existe para responder «¿cuál de las fuentes nos está frenando?». Con milisegundos crudos
 * —«8004»— esa pregunta obliga a contar cifras en cada fila.
 *
 * **Tres tramos y no uno**, porque el número útil cambia con la escala: por debajo del segundo lo
 * que importa es que fue inmediato; entre uno y sesenta, un decimal distingue una fuente ágil de
 * una lenta sin fingir precisión de milisegundo; por encima del minuto, los segundos sueltos ya no
 * dicen nada y lo que se busca es «esto tardó minutos».
 *
 * `null` es un dato (el modo simulado no cronometra, y un paso que no llegó a responder tampoco):
 * sale como {@link SIN_DATO}, igual que el resto de ausencias del módulo. Un negativo también, que
 * es lo que daría restar dos instantes con el reloj del servidor corrido: mejor un guion que un
 * «−3,0 s» que nadie sabe interpretar.
 */
export function duracionCorta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return SIN_DATO;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const segundos = ms / 1000;
  // El decimal va SIEMPRE, también cuando es cero: «8,0 s» y «1,2 s» alinean en la columna y se
  // comparan de un vistazo; «8 s» junto a «1,2 s» obliga a leer cada celda entera.
  if (segundos < 60) {
    return `${segundos.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  }
  const minutos = Math.floor(segundos / 60);
  const resto = Math.round(segundos - minutos * 60);
  // 119,7 s redondea a «1 min 60 s», que no es una duración. Se sube el minuto. Y los minutos
  // justos se dicen sin el «0 s» que solo añade ruido.
  if (resto === 60) return `${minutos + 1} min`;
  return resto === 0 ? `${minutos} min` : `${minutos} min ${resto} s`;
}

/** Qué fuentes han visto el comparendo. Lo calcula el merge, no el proveedor (CF-08). */
const ETIQUETA_ORIGEN: Record<ComparendoRegistro['origenMerge'], string> = {
  simit: 'SIMIT',
  municipal: 'Municipal',
  ambos: 'Ambos',
};

/**
 * El origen, con respaldo al valor crudo.
 *
 * El `Record` sobre la unión hace que añadir un origen al contrato NO compile hasta que alguien le
 * escriba su texto —ese es el mecanismo, y se conserva—, pero el valor llega por la RED: un backend
 * un paso por delante de esta pestaña manda un `origenMerge` que este mapa no tiene, y sin respaldo
 * la celda y la cabecera del panel dirían «Origen: undefined». Es el mismo cuidado que
 * `rotuloEvento` ya tiene con los tipos de evento desconocidos y por el mismo motivo: mejor una
 * etiqueta fea que una palabra que no significa nada.
 *
 * Vive aquí y no en la tabla ni en el panel porque los DOS lo pintan: tenerlo dos veces es cómo se
 * arregla el respaldo en un sitio y se deja el «undefined» en el otro.
 */
export function etiquetaOrigen(origen: ComparendoRegistro['origenMerge']): string {
  return (ETIQUETA_ORIGEN as Record<string, string | undefined>)[origen] ?? origen;
}

/**
 * El mismo instante, **sin el año**: «14 de ago, 15:02». La de la TABLA del historial (HU #11636).
 *
 * Es la tercera forma de pintar un instante en este módulo y la enmienda de UX del 20 ago 2026
 * (decisión 15) explica por qué hacían falta las tres: el instante completo
 * ({@link fechaHoraColombia}) es para las FRASES SUELTAS —«Iniciada el 14 ago 2026, 15:02» en la
 * consola, la cabecera del modal de detalle—, donde la corrida puede ser de otro día y quien lee no
 * tiene de dónde deducirlo. En una tabla ordenada por «Inicio», en cambio, el año se repite idéntico
 * en veinte filas y solo engorda una columna que ya compite con otras cuatro.
 *
 * Lo que **no** se recorta es la hora: dos corridas del mismo día son el caso normal —una nocturna y
 * la que alguien lanzó a mano— y sin hora las dos filas se leerían iguales.
 *
 * Mismo `timeZone` explícito y mismo `hour12: false` que sus hermanas, y por los mismos motivos.
 */
export function fechaHoraCortaColombia(instante: string | null): string {
  if (!instante) return SIN_DATO;
  const t = new Date(instante);
  if (Number.isNaN(t.getTime())) return SIN_DATO;
  return t.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * Qué es la fila HOY ante la autoridad (HU #11712). Lo deriva el merge del número de resolución;
 * **no lo dice ningún campo del proveedor** y no se puede inferir de `estadoFuente`.
 */
const ETIQUETA_TIPO_REGISTRO: Record<ComparendosTipoRegistro, string> = {
  comparendo: 'Comparendo',
  multa: 'Multa',
};

/**
 * El tipo de registro, con la MISMA forma que {@link etiquetaOrigen} y por los mismos dos motivos:
 * el `Record` sobre la unión hace que añadir un tercer tipo al contrato NO compile hasta que alguien
 * le escriba su texto, y el respaldo al valor crudo evita el «undefined» cuando un backend un paso
 * por delante de esta pestaña manda un valor que este mapa todavía no tiene.
 *
 * **El `null` se pinta {@link SIN_DATO}, nunca «Comparendo»** (HU #11713, AC3). `null` es «no se
 * sabe»: es lo que devuelve todo el histórico anterior a la migración 0160, cuyo dato ya no está en
 * ninguna parte, y en las filas `inactivo` es permanente porque ningún sync vuelve a visitarlas
 * (CF-10). Rellenar el hueco con la palabra convertiría una ausencia en un dato verificado que nadie
 * va a revisar nunca — y el front, además, **no deriva** el tipo: `numeroResolucion` no se pinta en
 * la tabla y no se usa aquí para adivinar lo que el servidor no afirmó.
 */
export function etiquetaTipoRegistro(tipo: ComparendoRegistro['tipoRegistro']): string {
  // `==` A PROPÓSITO, no un descuido que haya que «corregir» a `===`: cubre `null` y `undefined` con
  // una sola rama. El tipo promete `null`, pero el valor llega por la red y una pestaña cacheada
  // contra un backend anterior a la HU #11712 recibe la clave AUSENTE — que es justo el caso que el
  // párrafo de arriba dice cubrir. Con `===` el lookup daría `undefined`, el `?? tipo` devolvería
  // `undefined` y React pintaría la celda VACÍA: exactamente lo que el AC3 prohíbe.
  if (tipo == null) return SIN_DATO;
  return (ETIQUETA_TIPO_REGISTRO as Record<string, string | undefined>)[tipo] ?? tipo;
}
