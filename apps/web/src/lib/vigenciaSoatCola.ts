// FLITO — Cómo se PINTA la vigencia del SOAT en la cola (HU #12097, Feature #12075).
//
// Vive fuera de `FlitoSoat.tsx` por una sola razón: es la única pieza de esta HU con lógica de
// decisión, y aquí es una función PURA —sin React, sin reloj implícito, sin DOM— que se puede
// probar con `TZ=UTC` y con la fecha inyectada. Dentro de la página habría que arrancar un
// navegador para preguntarle qué pinta con `verificadaEn` nulo.
//
// No consulta nada y no deriva `vencido`: eso lo hace el servidor sobre el conjunto entero, porque
// el filtro corre en SQL y dos derivaciones se contradirían justo el día del vencimiento
// (`flito-soat.service.ts`, `vigenciaVista`). Aquí solo se elige el texto y el tono.

import type { VigenciaSoatVista } from '@operaciones/shared-types';
import type { ChipTone } from '../components/flit/StatusChip';

/** El bloque `vigencia` de la fila, tal como lo proyecta `GET /flito/soat`. */
export interface VigenciaSoatCola {
  /** Ya DERIVADO en el servidor, `vencido` incluido. */
  estado: VigenciaSoatVista;
  /** ISO de la ÚLTIMA RESPUESTA del RUNT. `null` = nunca ha habido ninguna. */
  verificadaEn: string | null;
  /** `yyyy-mm-dd`. Puede faltar: el RUNT reporta a veces por estado y sin fecha. */
  venceEl: string | null;
}

export interface VigenciaPintada {
  /** `null` = **sin pastilla**: no hay ninguna afirmación que hacer sobre el vehículo. */
  chip: { etiqueta: string; tono: ChipTone } | null;
  /** La segunda línea. Siempre hay una cuando la fila entra en la verificación. */
  linea: string;
}

const ZONA = 'America/Bogota';

/**
 * El día de CALENDARIO en Bogotá de un instante, `yyyy-mm-dd`.
 *
 * Con `Intl` y zona explícita, no con el reloj del proceso ni con cubos de 24 horas: la corrida es
 * a las 00:10 y reintenta a la 01:10, 02:10 y 03:10, así que una verificación de las 03:10 de ayer
 * leída a las 02:00 de hoy son 22,8 horas — «hoy» para `Math.floor(ms/86400000)` y «ayer» para
 * quien la mira. La zona explícita hace además que el resultado no dependa del `TZ` del navegador
 * ni del de la máquina que corre las pruebas.
 */
function diaBogota(iso: string): string | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(t);
}

/**
 * Días de calendario entre dos `yyyy-mm-dd`.
 *
 * `Date.UTC` sobre las tres cifras ya separadas: las dos fechas entran al mismo mediodía imaginario
 * y la resta no puede arrastrar husos ni horarios de verano. Comparar los `Date` de los instantes
 * originales sí podría.
 */
function diasDeCalendario(desde: string, hasta: string): number {
  const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(hasta) - ms(desde)) / 86_400_000);
}

const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `yyyy-mm-dd` → `4/09/26`. A mano y NO con `toLocaleDateString`, por dos motivos:
 * `new Date('2027-03-12')` es medianoche UTC y en Colombia se leería «11/03»; y el formato de es-CO
 * depende de la versión de ICU del navegador, así que el aserto del E2E dejaría de ser estable.
 */
function fechaCorta(dia: string): string {
  return `${Number(dia.slice(8, 10))}/${dia.slice(5, 7)}/${dia.slice(2, 4)}`;
}

/**
 * La antigüedad, relativa; la absoluta entra EXACTAMENTE cuando la relativa deja de ser una fecha.
 * «hoy» y «ayer» ya son la fecha para quien lee; a partir de dos días no, y entra la corta con año
 * —que es lo que delata un cron apagado un mes—.
 */
function antiguedad(diaVerificacion: string, diaHoy: string): string {
  const dias = diasDeCalendario(diaVerificacion, diaHoy);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  return `hace ${dias} días (${fechaCorta(diaVerificacion)})`;
}

/**
 * El chip de los estados CONCLUYENTES. `no_verificado` no pasa por aquí: no afirma nada del
 * vehículo y por eso ni comparte gramática ni comparte tono con estos tres.
 *
 * Los cuatro tonos usados en toda la HU son `success`/`warning`/`danger`/`active` y ninguno es
 * casual: `neutral` y `draft` redefinen su tinta en tema oscuro contra un fondo de chip que se
 * queda en el hex claro (1,98:1 y 1,37:1). Es un defecto preexistente del kit, fuera del alcance de
 * esta HU, y aquí solo decide que «No se pudo consultar» sea azul y no el gris que pediría el
 * instinto.
 */
function chipConcluyente(v: VigenciaSoatCola): { etiqueta: string; tono: ChipTone } | null {
  switch (v.estado) {
    // Dos redacciones ENTERAS y no una con un hueco: que el RUNT reporte vigencia por estado y sin
    // fecha es frecuente y legítimo, y «Vigente hasta —» no es una frase.
    case 'vigente':
      return { etiqueta: v.venceEl && ES_FECHA.test(v.venceEl) ? `Vigente hasta ${fechaCorta(v.venceEl)}` : 'Vigente', tono: 'success' };
    // El servidor solo deriva `vencido` desde `vigente` y con `vence_el` puesto, así que el «Venció»
    // pelado no es alcanzable hoy; se escribe igual para que un dato anómalo no deje el chip mudo.
    case 'vencido':
      return { etiqueta: v.venceEl && ES_FECHA.test(v.venceEl) ? `Venció el ${fechaCorta(v.venceEl)}` : 'Venció', tono: 'warning' };
    // Sujeto y lugar: la ausencia está EN EL REGISTRO, no en nuestro proceso. No hay lectura posible
    // en la que describa una consulta fallida.
    case 'sin_registro':
      return { etiqueta: 'Sin SOAT en el RUNT', tono: 'danger' };
    default:
      return null;
  }
}

/**
 * Qué pinta la celda «Estado» para una fila, y **es la única fuente de esos textos** (la fila y el
 * modal leen de aquí).
 *
 * Devuelve `null` cuando la fila NO entra en la verificación diaria —no tiene comprobante cargado, o
 * la respuesta es de un API anterior a la HU y no trae el bloque—: en ese caso la celda queda
 * exactamente como estaba, sin chip, sin línea y **sin «—»**. La ausencia es correcta y muda.
 *
 * **La precedencia es de la fecha, no del estado.** Con `verificadaEn` nulo se pinta «Sin verificar»
 * sea cual sea el `estado`, porque ese nulo significa que de este SOAT no consta ninguna respuesta
 * del registro. Escrito como un `switch (estado)` —el error más fácil de toda la HU— el chip azul
 * «No se pudo consultar» se llenaría cada mañana de comprobantes cargados ayer a los que aún no les
 * ha tocado la corrida, afirmando un fallo que no ha ocurrido.
 *
 * `ahora` se inyecta para poder probar la frontera de día sin depender del reloj de la máquina.
 */
export function pintarVigenciaSoat(
  vigencia: VigenciaSoatCola | null | undefined,
  ahora: Date = new Date(),
): VigenciaPintada | null {
  if (!vigencia) return null;

  const dia = vigencia.verificadaEn ? diaBogota(vigencia.verificadaEn) : null;
  // Sin «todavía»: sobre un VIN que el RUNT nunca acepta, «todavía» prometería para siempre una
  // espera que no va a terminar. Y es la misma palabra que el filtro que devuelve estas filas.
  if (dia === null) return { chip: null, linea: 'Sin verificar' };

  const hoy = diaBogota(ahora.toISOString());
  const edad = hoy === null ? 'hoy' : antiguedad(dia, hoy);

  // El segundo discriminador del AC3, y es GRAMATICAL: tres estados abren con «Verificado …» —hubo
  // respuesta y esta es su fecha— y `no_verificado` abre con «Último dato: …», que es otra
  // afirmación (lo que sabemos es de antes). Cambiando la paleta entera seguirían distinguiéndose.
  if (vigencia.estado === 'no_verificado') {
    return { chip: { etiqueta: 'No se pudo consultar', tono: 'active' }, linea: `Último dato: ${edad}` };
  }
  return { chip: chipConcluyente(vigencia), linea: `Verificado ${edad}` };
}

/**
 * El mismo texto, para el `<Dato>` del modal: la etiqueta del chip cuando hay chip, y si no la
 * línea. Un rótulo distinto por estado obligaría a leer dos veces lo que ya se leyó en la fila.
 */
export function textoVigenciaSoat(
  vigencia: VigenciaSoatCola | null | undefined,
  ahora: Date = new Date(),
): string {
  const pintada = pintarVigenciaSoat(vigencia, ahora);
  if (!pintada) return '—';
  return pintada.chip?.etiqueta ?? pintada.linea;
}
