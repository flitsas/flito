// Siigo — entrega de la factura por correo y reenvío (HU #11334, Feature #11243).
//
// El correo lo envía **Siigo**, no FLITO. Esto no pasa por `notification_outbox` ni por
// `services/email.ts`, que son la maquinaria de los correos que enviamos nosotros: aquí FLITO le
// PIDE a Siigo que envíe y registra qué contestó. Confundir las dos cosas produciría un correo
// duplicado —el nuestro y el suyo— con la misma factura adjunta.
//
// Lo que esta historia posee es el REGISTRO, no el envío: quién recibió, cuándo, con qué resultado
// y a petición de quién. Es la diferencia entre responder «no me llegó» con un hecho o con una
// suposición, que es literalmente lo que pide la historia.

/**
 * Cómo acabó el intento de envío.
 *
 * `no_realizado` NO es un sinónimo de `fallido`, y separarlos es el AC3 entero: un cliente sin
 * correo en su ficha nunca llegó a Siigo, así que no hay nada que reintentar ni cuota que se haya
 * gastado — lo que hay es un dato que falta y una persona que debe completarlo. Meterlos en el
 * mismo cajón haría que la bandeja invitara a reintentar algo que va a volver a no salir.
 */
export const SIIGO_ENVIO_RESULTADOS = ['enviado', 'fallido', 'no_realizado'] as const;
export type SiigoEnvioResultado = (typeof SIIGO_ENVIO_RESULTADOS)[number];

/**
 * Quién originó el envío.
 *
 * `emision` es el correo que Siigo manda solo, porque la creación de la factura se lo pidió en el
 * mismo `POST` (`mail: true`). Ese envío existe aunque nadie de FLITO haya pulsado nada, y si no se
 * registrara, el primer envío —el que de verdad recibe el cliente— sería justo el único invisible.
 * Es la frontera del AC7: la Feature 13 pide el envío en la creación; esta lo apunta.
 */
export const SIIGO_ENVIO_ORIGENES = ['emision', 'reenvio'] as const;
export type SiigoEnvioOrigen = (typeof SIIGO_ENVIO_ORIGENES)[number];

/**
 * Tope de direcciones por envío.
 *
 * Es el límite de Siigo (`docs/integraciones/siigo-api.md` §3), no una preferencia nuestra. Se
 * comprueba ANTES de salir: mandar seis y que Siigo lo rechace gasta una petición de la ventana de
 * 100 por minuto que comparte con la emisión, y cuenta como error en la proporción por la que Siigo
 * bloquea el usuario API.
 */
export const SIIGO_ENVIO_MAX_DESTINATARIOS = 5;

/** Por qué no se pudo armar el envío. Nombres, no cadenas sueltas: la pantalla los traduce. */
export const SIIGO_ENVIO_MOTIVOS_NO_REALIZADO = [
  /** El cliente no tiene ningún correo utilizable en su ficha (AC3). */
  'cliente_sin_correo',
  /** La factura todavía no existe en Siigo: no está emitida, o falló al emitirse (AC5). */
  'factura_no_emitida',
  /** Más direcciones de las que Siigo admite (AC6). */
  'demasiados_destinatarios',
  /** Alguna dirección no tiene forma de dirección (AC6). */
  'destinatario_invalido',
] as const;
export type SiigoEnvioMotivoNoRealizado = (typeof SIIGO_ENVIO_MOTIVOS_NO_REALIZADO)[number];

/**
 * De dónde puede salir un destinatario.
 *
 * La decisión D-3 del diseño es el correo de la **compañía**, y hoy la función resolutora solo
 * devuelve ese. Pero desde la HU #11292 la ficha tiene además un correo de contacto fiscal, y la
 * pregunta «¿debe recibirlo también el contacto?» es de contabilidad, no de programación. Este
 * catálogo existe para que el día que se responda sea añadir un origen y no rehacer el envío: el
 * registro guarda de DÓNDE salió cada dirección, así que la respuesta se podrá dar mirando datos.
 */
export const SIIGO_ENVIO_ORIGENES_DESTINATARIO = ['compania', 'contacto_fiscal', 'manual'] as const;
export type SiigoEnvioOrigenDestinatario = (typeof SIIGO_ENVIO_ORIGENES_DESTINATARIO)[number];

/** Una dirección con su procedencia. La procedencia es la que hace auditable el AC2. */
export interface SiigoDestinatario {
  correo: string;
  origen: SiigoEnvioOrigenDestinatario;
}

/** Una fila del registro de envíos, tal como la lee la pantalla. */
export interface SiigoEnvioRegistro {
  id: string;
  facturaId: string;
  origen: SiigoEnvioOrigen;
  resultado: SiigoEnvioResultado;
  destinatarios: SiigoDestinatario[];
  motivo: string | null;
  codigo: string | null;
  solicitadoPor: number | null;
  creadoEn: string;
}

/**
 * El resumen que responde «¿se le mandó, cuántas veces y cuándo la última?» (AC4).
 *
 * `ultimoEnviado` y `ultimo` son campos distintos a propósito: si el último intento falló, la
 * pregunta útil sigue siendo cuándo fue la última vez que el cliente SÍ recibió algo.
 */
export interface SiigoEnvioResumen {
  facturaId: string;
  veces: number;
  vecesEnviado: number;
  ultimo: SiigoEnvioRegistro | null;
  ultimoEnviado: SiigoEnvioRegistro | null;
  envios: SiigoEnvioRegistro[];
}

export function esEnvioResultado(v: string): v is SiigoEnvioResultado {
  return (SIIGO_ENVIO_RESULTADOS as readonly string[]).includes(v);
}

export function esEnvioOrigen(v: string): v is SiigoEnvioOrigen {
  return (SIIGO_ENVIO_ORIGENES as readonly string[]).includes(v);
}
