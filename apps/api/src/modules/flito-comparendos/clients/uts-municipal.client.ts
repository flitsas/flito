// FLITO comparendos — adapter del UTS municipal (Feature #11492 17a, HU #11499, AC2/AC3).
//
// La segunda fuente: el servicio de infracciones de cada municipio, al que se le pregunta uno por
// uno con el `codigoFuente` del catálogo (BELLO, ITAGUI, MEDELLIN…). Por eso la unidad de trabajo
// del sync no es el NIT sino el par (NIT, municipio), y por eso los errores de aquí llevan el
// código del municipio en `fuente`: un municipio caído no puede contaminar la lectura de los demás
// ni autorizar una inactivación (ADR-0001 §5).
//
// Sin token: el UTS no pide autorización. El único secreto del módulo es el de Verifik y no tiene
// nada que hacer en esta petición — mandarlo «por si acaso» sería regalarle la credencial a un
// tercero.
//
// ── El proveedor solo publica `http://`, y esta fuente lo acepta ─────────────────────────────────
//
// El host que dio el proveedor va sobre `http://` (texto plano) y no publica HTTPS. Hasta el
// 2026-08-20 este adapter lo RECHAZABA —`fuente_no_configurada`, 503— y con ello el modo `real`
// contra el UTS no era ejercitable. David decidió ese día abrirlo, sustituyendo a la decisión de
// «preguntar antes al proveedor» del Feature 17a §594.
//
// La excepción se pide en los DOS sitios y a mano, que es lo que la mantiene acotada:
//
//   1. `baseUrlExigida(..., { permitirTextoPlano: true })` — deja pasar la base `http://`.
//   2. `httpsGetJson(..., { permitirTextoPlano: true })` — hace que la petición SALGA por el
//      módulo `http`. Sin esto, el helper compartido habría hablado `https` igualmente contra el
//      host de la base y el NIT se habría remitido en silencio a un endpoint que nadie revisó (o
//      el operador habría recibido un error opaco de TLS en lugar de una respuesta).
//
// Verifik NO la pide y no debe pedirla: su petición lleva el Bearer del módulo, y en texto plano
// eso es regalar la credencial. Traspaso, RUNT, Fasecolda y Mercado Libre tampoco se ven afectados:
// la opción del helper está apagada por defecto.
//
// Lo que se acepta, dicho en voz alta: el NIT monitoreado —dato de empresa, transferencia a tercero
// bajo Ley 1581— viaja SIN CIFRAR en la query de un GET. Queda registrado en
// `docs/privacy/registro-terceros-destinatarios.md` y este adapter emite un `log.warn` la primera
// vez que usa esa base en un proceso, para que no se convierta en el estado normal por olvido
// (ver `avisarTextoPlano`: hoy es por proceso, no por corrida).

import { httpsGetJson } from '../../integraciones/http.js';
import { env } from '../../../config/env.js';
import { loggerFor } from '../../../shared/logger.js';
import { maskDocument } from '../../../shared/utils/pii.js';
import { ComparendosFuenteRespuestaIlegibleError } from '../flito-comparendos.errors.js';
import {
  baseUrlExigida,
  comoErrorDeFuente,
  conLimiteDeTiempo,
  exigirHttpOk,
  extraerLista,
  leerRuta,
  limiteDeTiempoMs,
  type ContextoFuente,
} from './fuente-http.js';
import type { ComparendoCrudoMunicipal, RespuestaFuenteMunicipal } from './types.js';

const log = loggerFor('flito-comparendos');

/**
 * Ruta del contrato UTS, completa. El host de cada ambiente va por `UTS_MUNICIPAL_BASE_URL`.
 *
 * `UTS_MUNICIPAL_BASE_URL` es **solo el origen** (`https://host`): el prefijo
 * `/infraction/api/Infraccion` es parte del contrato del proveedor y vive aquí, no en la variable.
 * Si alguien provisiona la base ya con ese prefijo, la ruta saldría duplicada.
 *
 * Con puerto: la base **sí** admite `…:8080`. `integraciones/http.ts` descartaba el `port` de la
 * URL y armaba la petición solo con `{ hostname, path }`, de modo que un puerto explícito salía en
 * silencio contra el 443; desde el 2026-08-20 el helper lo respeta.
 */
const RUTA_CONSULTA = '/infraction/api/Infraccion/ConsultarInfraccionFuente';

/**
 * Dónde cuelga el UTS su lista, en orden de prioridad. Las dos ramas, y se concatenan.
 *
 * Capturado contra el proveedor el 2026-08-20: la raíz es el eco de la consulta
 * (`{ idTipoIdentificacion, criterio, response, consultaMultaOComparendoOutDTO, … }`) y lo bueno
 * está dos niveles adentro. `informacionComparendo` va primero porque es donde llegaron los
 * comparendos reales; `informacionComparendoAdicional` aparece ANTES en el cuerpo y llegó VACÍO,
 * así que «la primera rama que exista» habría devuelto cero y apagado el histórico del NIT.
 *
 * Las que NO están, y por qué: `informacionMulta` es otro concepto de negocio (multas, no
 * comparendos) y `tarifasComparendos` es un catálogo de tarifas —sus ítems no son comparendos y
 * concatenarlos metería basura en el merge—. Si algún día hay que ingerir multas, es otra decisión
 * de negocio y otra rama, no un añadido silencioso aquí.
 */
const RUTAS_LISTA = [
  'consultaMultaOComparendoOutDTO.informacionComparendo',
  'consultaMultaOComparendoOutDTO.informacionComparendoAdicional',
] as const;

/** Dónde dice el UTS si la consulta le salió bien. Ver `exigirEnvelopeUtsOk`. */
const RUTA_ESTADO = 'consultaMultaOComparendoOutDTO.estado';

/** Único `codigoEstado` que el proveedor considera consulta resuelta («EXITOSO»). */
const CODIGO_ESTADO_OK = 1;

/**
 * El UTS contesta 200 aunque le haya ido mal: el veredicto va en el cuerpo.
 *
 * `consultaMultaOComparendoOutDTO.estado` trae `{ codigoEstado: 1, descripcion: "EXITOSO" }` en el
 * camino bueno. Si el código existe y NO es 1, la consulta no se resolvió, y entonces las listas
 * que vengan (vacías, típicamente) no significan «este NIT no debe nada»: significan «no se sabe».
 * Dejarlas pasar sería devolver `ok:true` con lista vacía y, con ella, la inactivación en falso del
 * histórico del NIT — el fallo que todo este módulo está construido para no cometer. Por eso sale
 * como `ComparendosFuenteRespuestaIlegibleError` (502) y no como una lista vacía.
 *
 * Si el envelope no trae `estado` no se inventa nada: se sigue adelante y decide `extraerLista`. Un
 * proveedor que cambie el nombre del campo no puede convertirse en un error duro por sorpresa.
 *
 * La pista lleva SOLO el `codigoEstado`, que es el diagnóstico útil y un valor del contrato. La
 * `descripcion` que acompaña al código NO se copia, aunque sea tentador: esta pista viaja al cuerpo
 * de la respuesta HTTP y a `flito_comparendos_sync_steps.mensaje`, que se conserva y se sirve, y la
 * rama `codigoEstado ≠ 1` no se ha observado nunca — nadie puede prometer qué escribe el proveedor
 * ahí. Un `"SIN INFORMACION PARA EL NIT 900…"` cabría de sobra en el recorte que había aquí, y el
 * contrato de esta clase de error es que la pista describe la FORMA, nunca el contenido. Por el
 * mismo motivo no sale el `criterio` de la raíz, que ES el NIT consultado.
 */
/**
 * El `codigoEstado` del envelope, o `undefined` si el UTS no se pronunció.
 *
 * Un solo lector para las dos preguntas que se le hacen al envelope —«¿dice que fue mal?» y «¿dice
 * algo siquiera?»—, porque son la misma lectura y separarlas invita a que una se quede atrás. Un
 * `estado` ausente, un `estado` que no es objeto y un `codigoEstado: null` son el MISMO caso: el
 * proveedor no emitió veredicto. Se devuelve el valor crudo, sin convertir: quién lo compara y cómo
 * es decisión de cada llamador.
 */
function codigoEstadoDelEnvelope(cuerpo: unknown): unknown {
  const estado = leerRuta(cuerpo, RUTA_ESTADO);
  if (estado === null || typeof estado !== 'object') return undefined;
  const codigo = (estado as Record<string, unknown>).codigoEstado;
  return codigo === null ? undefined : codigo;
}

function exigirEnvelopeUtsOk(cuerpo: unknown, httpStatus: number, ctx: ContextoFuente): void {
  const codigo = codigoEstadoDelEnvelope(cuerpo);
  if (codigo === undefined) return;
  if (Number(codigo) === CODIGO_ESTADO_OK) return;

  throw new ComparendosFuenteRespuestaIlegibleError(
    ctx.origen, ctx.fuente, httpStatus,
    `el UTS respondió codigoEstado ${String(codigo).slice(0, 12)}`,
  );
}

/**
 * ¿Ya se avisó de que esta fuente va en texto plano?
 *
 * El adapter se llama una vez por par (NIT, municipio): sin esto, una corrida de 8 municipios × N
 * NITs llenaría el log del mismo aviso y dejaría de leerse. Se recuerda la base avisada para que un
 * cambio de provisión vuelva a avisar.
 *
 * DEUDA: no hay gancho desde el sync, así que dentro de un mismo proceso el aviso sale una vez y no
 * una por corrida. `reiniciarAvisoTextoPlano()` existe para cuando se quiera enganchar (y para que
 * los tests no dependan del orden).
 */
let baseAvisadaEnClaro: string | null = null;

/** Olvida el aviso de texto plano. Para los tests y para el arranque de una corrida del sync. */
export function reiniciarAvisoTextoPlano(): void {
  baseAvisadaEnClaro = null;
}

/**
 * Deja constancia de que el NIT sale sin cifrar, sin enseñar ni la URL ni el NIT.
 *
 * `maskDocument` para el NIT (Ley 1581) y del host solo el ESQUEMA: la base es provisión, no dato
 * personal, pero esta línea acaba en el log central y la URL completa de esta fuente lleva el NIT
 * en la query — no se registra ninguna URL de este módulo, y la regla no se rompe por un aviso.
 */
function avisarTextoPlano(base: string, nit: string, ctx: ContextoFuente): void {
  if (baseAvisadaEnClaro === base) return;
  baseAvisadaEnClaro = base;
  log.warn(
    { fuente: ctx.fuente, nit: maskDocument(nit), esquema: 'http' },
    'UTS municipal sobre http: el NIT viaja sin cifrar hacia el proveedor (decisión 2026-08-20)',
  );
}

/**
 * Infracciones que el UTS de un municipio tiene para un NIT.
 *
 * En `mock` no toca la red ni exige base URL, igual que el adapter de Verifik.
 *
 * @param nit          NIT normalizado del catálogo.
 * @param codigoFuente Valor que viaja literal en `?fuente=` (RN-03). Puede llevar espacios: hay
 *                     municipios de varias palabras y el catálogo los admite.
 * @throws ComparendosFuenteError con `codigo` y `httpStatus`, sin PII en el mensaje.
 */
export async function consultarComparendosMunicipales(
  nit: string, codigoFuente: string,
): Promise<RespuestaFuenteMunicipal> {
  const ctx: ContextoFuente = { origen: 'municipal', fuente: codigoFuente };

  if (env.COMPARENDOS_SIMIT_MODE === 'mock') return respuestaSimulada(nit, ctx);

  // `permitirTextoPlano` SOLO aquí (ver la cabecera del archivo): el proveedor no publica HTTPS y
  // esta petición no lleva credencial. Verifik no la pide y no debe pedirla.
  const base = baseUrlExigida(
    env.UTS_MUNICIPAL_BASE_URL, 'UTS_MUNICIPAL_BASE_URL', ctx, { permitirTextoPlano: true },
  );
  const enClaro = base.toLowerCase().startsWith('http://');
  if (enClaro) avisarTextoPlano(base, nit, ctx);

  // `URLSearchParams` y no interpolación. El Zod de la HU #11497 ya restringe el alfabeto de las
  // dos cosas que entran aquí —el NIT a dígitos y el código de fuente a letras, dígitos, espacio,
  // guion y guion bajo— pero eso protege lo que se guarda POR EL API; codificar aquí protege
  // también lo que llegue por un seed, una migración o un script. Un `&` en el código de fuente
  // dejaría de ser un valor para pasar a ser un parámetro más de la petición.
  //
  // El espacio sale como `+` (application/x-www-form-urlencoded), que es la forma canónica en una
  // query string y la que decodifican los stacks de servidor habituales.
  const parametros = new URLSearchParams({ fuente: codigoFuente, nit });
  const url = `${base}${RUTA_CONSULTA}?${parametros.toString()}`;

  try {
    // Las DOS cosas, y no una: el `timeoutMs` de `httpsGetJson` aborta el socket de verdad, pero es
    // un timeout de INACTIVIDAD — un proveedor que gotee un byte cada 7 s no lo dispara nunca y
    // mantiene la petición viva indefinidamente. La carrera pone encima el plazo ABSOLUTO, que es
    // lo que protege el presupuesto de tiempo del sync (ADR-0001 §7) frente al techo de ~120 s del
    // nginx. Sin ella, un proveedor que gotea deja la corrida entera colgada.
    const respuesta = await conLimiteDeTiempo(
      () => httpsGetJson(url, {
        Accept: 'application/json',
        // La clave de caché de esta petición ES la URL, y la URL lleva el NIT dentro. Aquí importa
        // más que en Verifik: esta llamada NO lleva `Authorization`, así que la restricción de la
        // RFC 9111 al caché compartido de respuestas autenticadas no aplica y este encabezado es
        // lo único que le quita a un proxy intermedio la discreción de almacenarla.
        'Cache-Control': 'no-store',
        // La misma excepción que arriba, y en el mismo sitio donde se decide: sin esto el helper
        // hablaría `https` contra un host que solo escucha en claro.
        //
        // `desenrollarJsonAnidado`: el UTS devuelve el cuerpo DOBLEMENTE CODIFICADO —el JSON ya
        // serializado, entregado como string—, de modo que el primer `JSON.parse` no da el objeto
        // sino un string. No es una sospecha: es la causa raíz del Bug #11711, medida el 2026-08-21
        // en CINCO de los OCHO municipios que siembra la 0150 (BELLO, MEDELLIN, ITAGUI, ENVIGADO y
        // SABANETA; CALI, MANIZALES y RIONEGRO no se midieron), todos con `Content-Length` y todos
        // con la comilla doble como primer byte del cuerpo. Que falten tres no deja un hueco: el
        // desenrollado solo actúa si el primer `JSON.parse` entrega un `string`, así que un
        // municipio que conteste JSON normal sigue el camino de siempre.
        //
        // Qué se veía ANTES del arreglo, dicho con precisión porque de aquí sale la decisión: un
        // 502 `fuente_respuesta_ilegible` OPACO —la pista era «texto plano de N caracteres»—, y NO
        // una lista vacía. `extraerLista` no reconoce ninguna lista dentro de un string y lanza, así
        // que el histórico del NIT nunca llegó a tocarse por esta vía.
        //
        // Y aun así el desenrollado va AQUÍ, en el TRANSPORTE y ANTES de `exigirEnvelopeUtsOk`,
        // porque el riesgo de verdad aparece en cuanto se desenrolla más tarde: sobre un string esa
        // comprobación no ve el `codigoEstado` y sale limpia. Un cuerpo desenrollado más abajo
        // llegaría a `extraerLista` con el envelope ENTERO y sus listas dentro —la captura del
        // 2026-08-21 muestra envelopes cuyas cuatro listas vienen vacías—, de modo que un
        // `codigoEstado` no-OK sin validar acabaría en `ok:true` con lista vacía. Y la lista vacía
        // es lo que inactiva el histórico del NIT (ADR-0001 §5). El orden es la garantía; el
        // emplazamiento no es cosmético.
        //
        // El alcance de lo que toca este arreglo NO es uniforme, y conviene no venderlo como si lo
        // fuera:
        //   · `permitirTextoPlano` y `desenrollarJsonAnidado` son POR LLAMADA. Encenderlas aquí no
        //     las enciende en Verifik, traspaso, RUNT, Fasecolda ni Mercado Libre: esos cinco
        //     siguen con el parseo de siempre.
        //   · La acumulación del cuerpo en Buffer (`leerCuerpo`) NO es opt-in: aplica a TODOS los
        //     llamadores del helper y ninguno la pidió. Se asume a conciencia —era una lectura mal
        //     hecha para cualquiera— y lo único que cambia es el resultado de un cuerpo que hoy
        //     llegaría con U+FFFD por un carácter multibyte partido entre dos trozos del socket.
      }, limiteDeTiempoMs(), { permitirTextoPlano: enClaro, desenrollarJsonAnidado: true }),
      ctx,
    );

    const httpStatus = exigirHttpOk(respuesta.status, ctx);
    // El 200 no basta: el UTS pone el veredicto de la consulta DENTRO del cuerpo.
    exigirEnvelopeUtsOk(respuesta.data, httpStatus, ctx);
    const items = extraerLista<ComparendoCrudoMunicipal>(respuesta.data, httpStatus, ctx, RUTAS_LISTA);

    // ── ¿Concluyente? (Bug #11711 AC8, RN-47) ────────────────────────────────────────────────────
    //
    // Llegados aquí el envelope o dijo `codigoEstado: 1` o no dijo nada: un código distinto ya lanzó
    // arriba. La consulta se considera CONCLUYENTE si el proveedor se pronunció —hay `codigoEstado`—
    // o si trajo comparendos, que es un pronunciamiento de hecho: quien devuelve una lista con algo
    // dentro está contestando a la pregunta.
    //
    // Lo que queda fuera es el caso medido el 2026-08-21 en MEDELLIN con un NIT sin comparendos:
    // `codigoEstado: null` y cero ítems. Ese vacío no es «no debe nada»; es «no sé decirte». Y no se
    // convierte en error a propósito: el MISMO municipio contesta `codigoEstado: 1` para otro NIT
    // —y BELLO contesta 1 con cero comparendos—, así que exigir veredicto los dejaría caídos para
    // siempre. Se responde `ok`, con la lista que haya, y se le quita a esa respuesta el único
    // poder que no puede tener: autorizar una inactivación por ausencia (ADR-0001 §5).
    const concluyente = codigoEstadoDelEnvelope(respuesta.data) !== undefined || items.length > 0;

    log.debug({ fuente: ctx.fuente, nit: maskDocument(nit), httpStatus, items: items.length, concluyente },
      'consulta a UTS municipal resuelta');

    return { ...ctx, modo: 'real', httpStatus, items, concluyente };
  } catch (e) {
    const fallo = comoErrorDeFuente(e, ctx);
    log.warn({ fuente: ctx.fuente, nit: maskDocument(nit), codigo: fallo.codigo, httpStatus: fallo.httpStatus },
      'consulta a UTS municipal fallida');
    throw fallo;
  }
}

/**
 * Payload municipal de prueba, determinista y sin red (AC2).
 *
 * Está hecho para encajar con el de Verifik: el primer elemento repite el número
 * `MOCK-COMPARTIDO-<nit>-0002` que SIMIT ya devolvió —mismo comparendo visto por las dos fuentes,
 * que es el caso de unicidad del CF-07— y trae la `descripcion` que allí faltaba, para que el merge
 * de la HU #11500 rellene el hueco sin pisar nada. El segundo solo existe en el municipio, y su
 * número incluye el `codigoFuente` para que se vea de qué UTS salió.
 */
function respuestaSimulada(nit: string, ctx: ContextoFuente): RespuestaFuenteMunicipal {
  const items: ComparendoCrudoMunicipal[] = [
    {
      numero: `MOCK-COMPARTIDO-${nit}-0002`,
      placa: 'MOK456',
      codigo: 'D02',
      descripcion: 'Conducir sin portar la licencia de tránsito',
      fecha: '2026-06-02',
      organismo: `Secretaría de Movilidad de ${ctx.fuente}`,
      valor: '1160500',
      estado: 'Notificado',
    },
    {
      numero: `MOCK-${ctx.fuente}-${nit}-0003`,
      placa: 'MOK789',
      codigo: 'B01',
      descripcion: 'Transitar por sitios restringidos',
      fecha: '2026-06-21',
      organismo: `Secretaría de Movilidad de ${ctx.fuente}`,
      valor: '232100',
      estado: 'Pendiente de pago',
    },
  ];

  log.debug({ fuente: ctx.fuente, nit: maskDocument(nit), items: items.length },
    'consulta a UTS municipal simulada (COMPARENDOS_SIMIT_MODE=mock): no se tocó la red');

  // Concluyente: el mock SÍ contesta a lo que se le pregunta, y su lista es la respuesta completa.
  // Marcarlo como no concluyente dejaría el modo simulado sin poder ejercer nunca la inactivación,
  // que es media HU #11500.
  return { ...ctx, modo: 'mock', httpStatus: null, items, concluyente: true };
}
