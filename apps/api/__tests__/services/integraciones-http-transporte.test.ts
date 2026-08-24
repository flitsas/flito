// integraciones/http.ts — el TRANSPORTE, contra un servidor HTTP de verdad.
//
// Los dos comportamientos que se fijan aquí no se pueden demostrar con un mock del helper, porque
// lo que falla vive precisamente dentro de él: cómo acumula los trozos del socket y cómo interpreta
// el cuerpo. Por eso este archivo levanta un `http.createServer` en localhost y habla con él.
//
//   1. **Un carácter multibyte partido entre dos trozos no se corrompe.** `d += trozo` decodifica
//      cada Buffer por su cuenta y parte el carácter a la mitad. Quien trocea es el SOCKET, así que
//      el riesgo existe con `Content-Length` y sin él: abajo están los DOS casos. El de
//      `Content-Length` es el que corresponde a lo que el UTS municipal responde de verdad —los
//      cinco municipios medidos el 2026-08-21, de los ocho sembrados, traen `Content-Length` y ninguno
//      `Transfer-Encoding: chunked`—, y por eso el chunked NUNCA fue la causa del Bug #11711. El
//      daño de este fallo es mojibake PERSISTIDO (`descripcion_infraccion`, `payload_*`), no un
//      error de parseo.
//   2. **JSON doblemente codificado, que sí es la causa raíz del Bug #11711.** El UTS devuelve el
//      JSON ya serializado, como STRING, de modo que el primer `JSON.parse` entrega un string y la
//      comprobación del envelope se queda sin nada que mirar. Se desenrolla UNA capa, en el
//      transporte, y SOLO si el llamador lo pide: la opción está apagada por defecto para que
//      encenderla en el UTS no la encienda en traspaso, RUNT, Fasecolda ni Mercado Libre, que
//      comparten estos helpers.
//
// No se mockea nada: el objetivo es ejercer el socket real.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { httpsGetJson, parsearCuerpo } from '../../src/modules/integraciones/http.js';
import { leerRuta } from '../../src/modules/flito-comparendos/clients/fuente-http.js';
import { cuerpoDobleEncodeado, payloadUts } from '../fixtures/comparendos/payloads-fuente.js';

/** Lo que el servidor de turno hará con la petición. Lo fija cada test antes de llamar. */
let responder: (res: http.ServerResponse) => void = (res) => res.end();

let servidor: http.Server;
let base = '';

beforeAll(async () => {
  servidor = http.createServer((_req, res) => responder(res));
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
});

/** GET al servidor local. `permitirTextoPlano` porque el helper habla `https` por defecto. */
function pedir(extra: { desenrollarJsonAnidado?: boolean } = {}): Promise<{ status: number | undefined; data: any }> {
  return httpsGetJson(`${base}/x`, undefined, 5_000, { permitirTextoPlano: true, ...extra });
}

describe('httpsGetJson — un carácter multibyte partido entre dos trozos del socket', () => {
  // El texto es el de una descripción de infracción real del UTS: acentos por todas partes.
  const DESCRIPCION = 'Conducir un vehículo a velocidad superior a la máxima permitida, '
    + 'según la señalización de la vía. Notificación al infractor por comparación de imágenes.';

  it('no destruye un carácter partido entre dos trozos del socket', async () => {
    const cuerpo = JSON.stringify({ descripcion: DESCRIPCION });
    const bytes = Buffer.from(cuerpo, 'utf8');

    // Corte EN MEDIO de un carácter multibyte: se busca un byte de arranque (0b110xxxxx en la `í`,
    // la `ó`, la `á`…) y se parte justo detrás, dejando la continuación en el segundo trozo.
    const arranque = bytes.findIndex((b) => b >= 0xc0);
    expect(arranque).toBeGreaterThan(0);
    const corte = arranque + 1;

    responder = (res) => {
      // Sin `Content-Length`: Node sale con `Transfer-Encoding: chunked`. Es el caso de un
      // proveedor cualquiera; NO es lo que hace el UTS (ver el caso siguiente).
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.write(bytes.subarray(0, corte));
      res.write(bytes.subarray(corte));
      res.end();
    };

    const r = await pedir();

    expect(r.status).toBe(200);
    // El texto llega IDÉNTICO. Con el acumulador de strings salían aquí rombos U+FFFD, y esos
    // rombos se persisten en `descripcion_infraccion` y en `payload_municipal`.
    expect(r.data.descripcion).toBe(DESCRIPCION);
    expect(JSON.stringify(r.data)).not.toContain('�');
  });

  it('tampoco con `Content-Length`, que es como responde el UTS de verdad', async () => {
    // El caso que desmonta el diagnóstico viejo del Bug #11711: los cinco municipios medidos el
    // 2026-08-21 —de los ocho sembrados— responden con `Content-Length` y sin `Transfer-Encoding`,
    // y aun así el cuerpo
    // llega al proceso en varios eventos `data` —quien trocea es el socket, no la codificación de
    // transferencia—. La acumulación en Buffer hace falta igual; el chunked nunca fue el motivo.
    const cuerpo = JSON.stringify({ descripcion: DESCRIPCION });
    const bytes = Buffer.from(cuerpo, 'utf8');
    const corte = bytes.findIndex((b) => b >= 0xc0) + 1;

    responder = (res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': bytes.length,
      });
      res.write(bytes.subarray(0, corte));
      // El resto en OTRO segmento, y por eso el `setTimeout`: dos `write` seguidos los junta el
      // kernel en un solo paquete y el cliente vería un único evento `data`, con lo que el caso no
      // ejercería nada. Con la pausa, el carácter llega partido de verdad — que es justo lo que le
      // pasa a una respuesta grande aunque traiga `Content-Length`.
      setTimeout(() => res.end(bytes.subarray(corte)), 25);
    };

    const r = await pedir();

    expect(r.status).toBe(200);
    expect(r.data.descripcion).toBe(DESCRIPCION);
    expect(JSON.stringify(r.data)).not.toContain('�');
  });

  it('un cuerpo de TEXTO que no es JSON también llega íntegro', async () => {
    const texto = `no soy JSON — ${DESCRIPCION}`;
    const bytes = Buffer.from(texto, 'utf8');
    const corte = bytes.findIndex((b) => b >= 0xc0) + 1;

    responder = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.write(bytes.subarray(0, corte));
      res.write(bytes.subarray(corte));
      res.end();
    };

    const r = await pedir();

    // Cuerpo no parseable ⇒ se devuelve el texto crudo, que es lo de siempre; pero SIN corromper.
    expect(r.data).toBe(texto);
  });
});

describe('parsearCuerpo — JSON doblemente codificado, y solo a petición', () => {
  it('APAGADA (el default): un cuerpo doblemente codificado sigue llegando como string', () => {
    // La garantía para los cuatro llamadores que este Bug no toca —traspaso, RUNT, Fasecolda y
    // Mercado Libre—: sin pedirlo, el parseo es el de siempre y el cuerpo se queda en `string`.
    const cuerpo = JSON.stringify(JSON.stringify({ consultaMultaOComparendoOutDTO: { estado: {} } }));

    expect(parsearCuerpo(cuerpo)).toBe(JSON.stringify({ consultaMultaOComparendoOutDTO: { estado: {} } }));
    expect(typeof parsearCuerpo(cuerpo)).toBe('string');
  });

  it('ENCENDIDA: un cuerpo que parsea a STRING y ese string a objeto se desenrolla', () => {
    const cuerpo = JSON.stringify(JSON.stringify({ consultaMultaOComparendoOutDTO: { estado: {} } }));

    expect(parsearCuerpo(cuerpo, true)).toEqual({ consultaMultaOComparendoOutDTO: { estado: {} } });
  });

  it('también cuando lo de dentro es un array', () => {
    const cuerpo = JSON.stringify(JSON.stringify([{ numero: 'A-1' }]));

    expect(parsearCuerpo(cuerpo, true)).toEqual([{ numero: 'A-1' }]);
    expect(typeof parsearCuerpo(cuerpo)).toBe('string');
  });

  it('un string que es solo un string se queda como string: UN reintento, no un bucle', () => {
    expect(parsearCuerpo('"EXITOSO"', true)).toBe('EXITOSO');
    // Triple codificación: se desenrolla UNA capa y para —queda el string de la capa intermedia,
    // no el objeto del fondo—. Desenrollar «lo que haga falta» convertiría cualquier cuerpo raro
    // en un objeto, y aquí se quiere exactamente lo contrario.
    const intermedio = JSON.stringify('{"a":1}');
    expect(parsearCuerpo(JSON.stringify(intermedio), true)).toBe(intermedio);
  });

  it('un número o un booleano codificados como string no se rescatan como objeto', () => {
    expect(parsearCuerpo('"42"', true)).toBe('42');
    expect(parsearCuerpo('42', true)).toBe(42);
  });

  it('texto que no es JSON se devuelve crudo, sin inventar nada, con o sin la opción', () => {
    expect(parsearCuerpo('<html><body>portal</body></html>', true)).toBe('<html><body>portal</body></html>');
    expect(parsearCuerpo('<html><body>portal</body></html>')).toBe('<html><body>portal</body></html>');
    expect(parsearCuerpo('', true)).toBe('');
  });

  it('el camino normal no cambia: objeto JSON de toda la vida', () => {
    expect(parsearCuerpo('{"data":{"multas":[]}}')).toEqual({ data: { multas: [] } });
    expect(parsearCuerpo('{"data":{"multas":[]}}', true)).toEqual({ data: { multas: [] } });
  });

  it('el transporte solo desenrolla si la llamada lo pide', async () => {
    const doble = JSON.stringify(JSON.stringify({ data: { multas: [{ numero: 'A-1' }] } }));
    responder = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(doble);
    };

    const porDefecto = await pedir();
    const pidiendolo = await pedir({ desenrollarJsonAnidado: true });

    // Sin pedirlo, lo de siempre: un string. Es la garantía de los cuatro llamadores compartidos.
    expect(porDefecto.data).toBe(JSON.stringify({ data: { multas: [{ numero: 'A-1' }] } }));
    // Pidiéndolo, el objeto. Y desenrollado AQUÍ, no más adelante: el adapter del UTS comprueba el
    // envelope (`codigoEstado`) sobre `respuesta.data` antes de extraer la lista, y sobre un string
    // esa comprobación no vería nada y se saltaría en silencio.
    expect(pidiendolo.data).toEqual({ data: { multas: [{ numero: 'A-1' }] } });
  });
});

// ── Bug #11711 · el cuerpo real del UTS, contra el socket ────────────────────────────────────────
//
// Lo de arriba prueba `parsearCuerpo` como función. Esto prueba el CAMINO COMPLETO —socket, lectura
// del cuerpo, parseo y opciones— con la forma medida del proveedor: 200, `application/json`,
// `Content-Length`, y el envelope del UTS serializado DOS veces.

describe('httpsGetJson — el cuerpo doble-encodeado del UTS (Bug #11711)', () => {
  /**
   * Responde como el UTS medido el 2026-08-21: 200, `application/json; charset=utf-8`,
   * `Content-Length` y NADA de `Transfer-Encoding`.
   */
  function comoElUts(cuerpo: string): void {
    responder = (res) => {
      const bytes = Buffer.from(cuerpo, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': bytes.length,
      });
      res.end(bytes);
    };
  }

  it('AC1 — encendida, `data` llega ya desenrollado y el envelope se puede leer', async () => {
    comoElUts(cuerpoDobleEncodeado(payloadUts()));

    const r = await pedir({ desenrollarJsonAnidado: true });

    expect(r.status).toBe(200);
    expect(typeof r.data).toBe('object');
    // `RUTA_ESTADO` del adapter: es lo que `exigirEnvelopeUtsOk` consulta ANTES de extraer la
    // lista, y es lo que devolvía `undefined` mientras el cuerpo llegaba como string.
    expect(leerRuta(r.data, 'consultaMultaOComparendoOutDTO.estado'))
      .toEqual({ codigoEstado: 1, descripcion: 'EXITOSO' });
  });

  it('AC1 — apagada, el MISMO cuerpo es un string y el envelope queda invisible', async () => {
    comoElUts(cuerpoDobleEncodeado(payloadUts({ estado: { codigoEstado: 4, descripcion: null } })));

    const r = await pedir();

    // El agujero que justifica el emplazamiento, escrito tal cual: sobre un string no hay
    // `codigoEstado` que comprobar, así que `exigirEnvelopeUtsOk` sale limpia y un «no se sabe» del
    // proveedor cruza esa puerta sin ruido. Lo que pasaba después, antes del arreglo, era un 502
    // opaco de `extraerLista` —no una lista vacía—; el peligro de la lista vacía es el de
    // desenrollar TARDE, con el envelope ya sin validar.
    expect(typeof r.data).toBe('string');
    expect(leerRuta(r.data, 'consultaMultaOComparendoOutDTO.estado')).toBeUndefined();
  });

  it('AC3 — el cuerpo de ENVIGADO se desenrolla a un objeto SIN listas, no a una lista vacía', async () => {
    // Forma real capturada el 2026-08-21: doble-encodeado y sin envelope. Lo que importa aquí es
    // que el transporte entrega un OBJETO —para que el adapter lo pueda rechazar por lo que es— y
    // no un string opaco ni, mucho menos, algo con pinta de lista.
    comoElUts(cuerpoDobleEncodeado({ codigo: 4, descripcion: null }));

    const r = await pedir({ desenrollarJsonAnidado: true });

    expect(r.data).toEqual({ codigo: 4, descripcion: null });
    expect(Array.isArray(r.data)).toBe(false);
    expect(leerRuta(r.data, 'consultaMultaOComparendoOutDTO.informacionComparendo')).toBeUndefined();
  });
});
