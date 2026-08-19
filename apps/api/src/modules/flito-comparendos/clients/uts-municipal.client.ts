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
// ── Limitación conocida: el proveedor publica el endpoint sobre `http://` ────────────────────────
//
// El host que dio el proveedor va sobre `http://` (texto plano) y el transporte que usa este
// adapter —`integraciones/http.ts`— habla `https` incondicionalmente. Por tanto **el modo `real`
// contra el UTS municipal no puede funcionar todavía**: `mock` sigue siendo el único modo
// ejercitable de esta fuente.
//
// Y no se deja a la suerte: `baseUrlExigida` **rechaza** una base que no sea `https:` con
// `fuente_no_configurada` (503). Sin esa comprobación, una base `http://` no habría significado
// «va en texto plano» sino «sale igual contra el 443 de ese host» —y si ese 443 está abierto, el
// NIT se remite a un endpoint que nadie revisó; y si no lo está, el operador recibe un error opaco
// de TLS o de DNS en lugar del error de provisión que este módulo diseñó justo para esto.
//
// Es deliberado y no un descuido: abrir el helper a texto plano mandaría el NIT monitoreado por la
// red sin cifrar y afectaría de paso a traspaso, RUNT y Fasecolda, que comparten ese helper. La
// decisión del Líder Técnico es preguntar antes al proveedor si expone HTTPS; solo si la respuesta
// es que no, se evaluará un transporte http acotado a esta fuente. Hasta entonces, lo que hay aquí
// es el verbo y la ruta correctos, no una integración operativa.

import { httpsGetJson } from '../../integraciones/http.js';
import { env } from '../../../config/env.js';
import { loggerFor } from '../../../shared/logger.js';
import { maskDocument } from '../../../shared/utils/pii.js';
import {
  baseUrlExigida,
  comoErrorDeFuente,
  conLimiteDeTiempo,
  exigirHttpOk,
  extraerLista,
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
 * Sin puerto: `integraciones/http.ts` arma la petición con `{ hostname, path }` y **descarta el
 * `port` de la URL**, así que un `…:8080` saldría en silencio contra el 443 de ese host. Añadir
 * `port` al helper es cambio de un helper compartido (traspaso, RUNT, Fasecolda) y va en su propio
 * PR; mientras tanto la variable no admite puerto, y el que hoy publica el proveedor va sobre
 * `http://`, que este adapter rechaza (ver la cabecera del archivo).
 */
const RUTA_CONSULTA = '/infraction/api/Infraccion/ConsultarInfraccionFuente';

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

  const base = baseUrlExigida(env.UTS_MUNICIPAL_BASE_URL, 'UTS_MUNICIPAL_BASE_URL', ctx);

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
      }, limiteDeTiempoMs()),
      ctx,
    );

    const httpStatus = exigirHttpOk(respuesta.status, ctx);
    const items = extraerLista<ComparendoCrudoMunicipal>(respuesta.data, httpStatus, ctx);

    log.debug({ fuente: ctx.fuente, nit: maskDocument(nit), httpStatus, items: items.length },
      'consulta a UTS municipal resuelta');

    return { ...ctx, modo: 'real', httpStatus, items };
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

  return { ...ctx, modo: 'mock', httpStatus: null, items };
}
