// Siigo — qué pasa con el correo al cliente cuando se emite la factura (HU #11708, Feature #11243).
//
// Un archivo entero para una decisión de quince líneas, y el motivo es que esas quince líneas son la
// historia. Antes de esta HU el correo se DEDUCÍA del ambiente y no había nada que decidir; ahora se
// elige en el envío, y una elección que viaja por cuatro capas hasta el cron necesita un sitio donde
// la regla esté escrita una sola vez y se pueda leer sin base de datos delante.
//
// LAS DOS COSAS QUE ESTE ARCHIVO GARANTIZA
//
//   1. **Elección Y ambiente, nunca elección O ambiente.** La casilla del envío puede APAGAR el
//      correo en producción; no puede ENCENDERLO fuera de ella. Es el AC4 y es el criterio que
//      impide que esta historia se convierta en un agujero: fuera de producción las facturas son
//      ensayos, pero las direcciones a las que saldrían son las de clientes reales, y un correo
//      enviado no se deshace. Si algún día alguien convierte el `&&` de `decidirCorreoDeEmision` en
//      un `||` «para poder probar el envío en pruebas», lo que habrá hecho es mandarle a un cliente
//      real una factura que no existe.
//   2. **Siempre hay acta, también cuando el correo no se pidió.** Es el AC2. Un envío sin correo y
//      un envío al que se le olvidó el correo son indistinguibles si el segundo no deja rastro, y el
//      segundo es un cliente esperando una factura que no va a llegar. Por eso esta función nunca
//      devuelve «nada que registrar»: devuelve `enviar: false` con un código y un motivo.
//
// LO QUE NO ESTÁ AQUÍ
//
// El timbre ante la DIAN. Sigue derivándose del ambiente y no se elige por factura, a propósito: un
// interruptor apagado en producción produciría facturas que en FLITO figuran emitidas y ante la DIAN
// no existen. Que las dos decisiones compartieran una línea (`efectosExternos`) no significaba que
// fueran la misma decisión; esta historia las separa y aquella se queda donde estaba.

import type { SiigoDestinatario, SiigoEnvioRegistro } from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import {
  enviarFacturaPorCorreo, redactarCorreos, registrarEnvioDeEmision, validarDestinatarios,
} from './siigo.envio-correo.service.js';
import { detalleTecnico } from './siigo.redaccion.js';

const log = loggerFor('siigo.emision.correo');

/**
 * Lo que el envío eligió sobre el correo. Es lo que se guarda con el lote y lo que el trabajador
 * vuelve a leer cuando le toca emitir.
 *
 * `destinatarios` vacío **no** es «a nadie»: es «a quien diga la ficha del cliente». Quien no quiere
 * que salga nada, deja `solicitado` en falso. Confundir las dos cosas haría que quitar la última
 * dirección de una lista mandara la factura a la ficha en vez de no mandarla.
 */
export interface CorreoDelEnvio {
  solicitado: boolean;
  destinatarios: SiigoDestinatario[];
}

/** La elección por omisión: no se pidió correo. Un envío anterior a esta HU es exactamente esto. */
export function correoNoSolicitado(): CorreoDelEnvio {
  return { solicitado: false, destinatarios: [] };
}

/**
 * Qué hacer con el correo de esta emisión, ya resuelto.
 *
 * `explicitos` es el campo que decide POR DÓNDE sale el correo, y no es un detalle: `mail: true` en
 * la creación le dice a Siigo que mande a la dirección que el tercero tiene registrada allá, y esa
 * es justo la que las direcciones elegidas vienen a sustituir (AC3). Cuando las hay, la creación va
 * sin `mail` y el correo se pide después por `POST /v1/invoices/{id}/mail`, que sí admite lista.
 * Poner las dos cosas mandaría el documento dos veces.
 */
export interface DecisionCorreo {
  /** Si esta emisión debe producir un correo al cliente. */
  enviar: boolean;
  /** Si las direcciones las eligió una persona (y por tanto mandan sobre la ficha). */
  explicitos: boolean;
  /** A quién. Se registra en el acta también cuando `enviar` es falso: el acta es su único sitio. */
  destinatarios: SiigoDestinatario[];
  /** Por qué no salió, con nombre propio. `null` cuando sale. */
  codigo: string | null;
  /** Lo mismo, para una persona. **Nunca contiene una dirección**: solo posiciones (AC5). */
  motivo: string | null;
}

/**
 * La decisión, sin base de datos y sin red (AC1, AC2, AC4, AC5).
 *
 * El ORDEN de las tres preguntas es parte de la respuesta:
 *
 *   1. ¿Se pidió? Si nadie lo pidió, decir «este ambiente no manda correo» sería contestar una
 *      pregunta que nadie hizo y mandar a alguien a mirar la configuración del ambiente por un
 *      envío en el que la casilla estaba en blanco.
 *   2. ¿El ambiente lo permite? Aquí vive el AC4, y es un `&&`. Va antes de mirar las direcciones
 *      porque no es un problema de esta lista ni de esta factura: en este ambiente no se manda
 *      correo a NADIE, y decir «la dirección 2 está repetida» invitaría a corregir una lista que no
 *      iba a salir de todos modos.
 *   3. ¿La lista se puede mandar? Es `validarDestinatarios`, la misma que usa el reenvío manual, y
 *      su mensaje señala posiciones y nunca valores.
 */
export function decidirCorreoDeEmision(entrada: {
  elegido: CorreoDelEnvio;
  /** Lo que la ficha del cliente resuelve hoy. Se usa solo si el envío no eligió direcciones. */
  deLaFicha: SiigoDestinatario[];
  /** `efectosExternosPermitidos(ambiente)`. El filtro que la elección no puede abrir. */
  efectosExternos: boolean;
  /** Solo para el mensaje: quien lo lee necesita saber en qué ambiente estaba. */
  ambiente: string;
}): DecisionCorreo {
  const { elegido, deLaFicha, efectosExternos, ambiente } = entrada;
  const explicitos = elegido.destinatarios.length > 0;
  const destinatarios = explicitos ? elegido.destinatarios : deLaFicha;

  // AC2 — no se pidió. El acta se escribe igual, y con su nombre: `no_solicitado` es un desenlace
  // normal que nadie tiene que arreglar, no un fallo. Los destinatarios van vacíos porque no hubo
  // ninguno: guardar aquí la dirección de la ficha sería conservar un dato personal para registrar
  // que no se usó.
  if (!elegido.solicitado) {
    return {
      enviar: false,
      explicitos: false,
      destinatarios: [],
      codigo: 'no_solicitado',
      motivo: 'La factura no se envió por correo: no solicitado en el envío.',
    };
  }

  // AC4 — la elección pasa por el filtro del ambiente, no lo sustituye.
  if (!efectosExternos) {
    return {
      enviar: false,
      explicitos,
      destinatarios,
      codigo: 'ambiente_no_productivo',
      motivo: `En el ambiente ${ambiente} no se manda correo a nadie: las facturas solo se crean en `
        + 'Siigo. El correo al cliente únicamente sale desde producción.',
    };
  }

  // AC5 — todo lo comprobable, antes de salir a la red. Incluye el caso «el cliente no tiene correo
  // en su ficha», que llega aquí como lista vacía y que es la razón más común de que no salga.
  const problema = validarDestinatarios(destinatarios);
  if (problema) {
    return { enviar: false, explicitos, destinatarios, codigo: problema.codigo, motivo: problema.mensaje };
  }

  return { enviar: true, explicitos, destinatarios, codigo: null, motivo: null };
}

/**
 * Ejecuta la decisión sobre una factura que YA existe en Siigo (AC1, AC2, AC3, AC4, AC5).
 *
 * Se llama después de que la emisión haya dejado la factura en `emitida`, y el orden no es
 * negociable: la ruta de correo de Siigo necesita el identificador que devuelve la creación, y el
 * acta tiene clave foránea contra la factura. Antes de eso no hay ni a qué mandar ni dónde apuntarlo.
 *
 * **Dos caminos, y la diferencia es quién pone las direcciones:**
 *
 *   · Sin direcciones elegidas, el correo ya salió: la creación llevaba `mail: true` y Siigo lo
 *     mandó a la ficha del tercero. Aquí solo queda APUNTARLO, que es lo que hace
 *     `registrarEnvioDeEmision`. Volver a pedirlo mandaría el documento dos veces.
 *   · Con direcciones elegidas, la creación fue SIN `mail` —habría mandado a la ficha, que es justo
 *     lo que se está sustituyendo— y el correo se pide ahora por la ruta que admite lista. La hace
 *     `enviarFacturaPorCorreo`, la misma del reenvío manual, con `origen: 'emision'` para que el
 *     acta diga de dónde vino. Sus comprobaciones se ejecutan otra vez, incluida la del ambiente:
 *     es la segunda cerradura de la misma puerta y no sobra.
 *
 * **No lanza nunca, y esa es la parte importante.** Para cuando esto corre existe una factura ante
 * la DIAN. Un fallo al mandar el correo —o al escribir el acta— no puede convertir una emisión
 * correcta en una fallida: el trabajador la reintentaría, y el reintento no puede deshacer un
 * documento fiscal. Lo que se pierde es el acta, y eso se ve en el log; lo que no se pierde es la
 * factura. El error se redacta antes de registrarlo porque Siigo puede devolver la dirección
 * ofensora en el mensaje y los logs no se pueden purgar.
 */
export async function aplicarCorreoDeEmision(
  facturaId: string, decision: DecisionCorreo,
): Promise<SiigoEnvioRegistro | null> {
  try {
    if (decision.enviar && decision.explicitos) {
      return await enviarFacturaPorCorreo(facturaId, {
        destinatarios: decision.destinatarios,
        origen: 'emision',
        // Sin `solicitadoPor`: lo pidió el envío, no una persona apretando «reenviar». Quién lo
        // pidió está en `encolado_por` de la fila de cola, que es donde esa pregunta se responde.
        solicitadoPor: null,
      });
    }
    return await registrarEnvioDeEmision(facturaId, {
      enviado: decision.enviar,
      destinatarios: decision.destinatarios,
      codigo: decision.codigo,
      motivo: decision.motivo,
    });
  } catch (e) {
    log.error({ err: redactarCorreos(detalleTecnico(e)), facturaId },
      'no se pudo registrar el correo de la emisión: la factura sí quedó emitida');
    return null;
  }
}
