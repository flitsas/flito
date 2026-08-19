// Siigo — entregar la factura por correo y poder reenviarla (HU #11334, Feature #11243).
//
// La historia se resume en una frase: poder responder «no me llegó» con un hecho en vez de con una
// suposición. Todo lo que sigue existe para que ese hecho quede escrito.
//
// CUATRO DECISIONES QUE SOSTIENEN ESTE ARCHIVO
//
//   1. **FLITO no envía el correo: se lo pide a Siigo.** No se toca `notification_outbox` ni
//      `services/email.ts`, que son la maquinaria de los correos que mandamos nosotros. De ahí solo
//      se reutiliza `isValidEmail`, que es una comprobación de forma y no un mecanismo de envío.
//      Confundirlos produciría dos correos con la misma factura: el suyo y el nuestro.
//   2. **Todo se comprueba ANTES de llamar.** Sin correo, con demasiadas direcciones, con una
//      dirección mal escrita o con una factura que aún no existe en Siigo, no sale ninguna petición.
//      No es delicadeza: la ventana de 100 peticiones por minuto es de la EMPRESA y la comparte con
//      la emisión, y Siigo bloquea el usuario API si más del 80 % de las peticiones fallan durante
//      siete días. Cada llamada que se sabe perdida de antemano gasta las dos cosas.
//   3. **Lo que no sale también se registra.** Un envío que no ocurrió deja fila con
//      `no_realizado` y su motivo. Si no la dejara, la pregunta «¿por qué no le llegó?» no tendría
//      respuesta justo en el caso en que hay algo que arreglar.
//   4. **Los destinatarios los calcula una función, no un literal.** Hoy devuelve el correo de la
//      compañía, que es la decisión D-3 del diseño. Que el contacto fiscal deba recibirlo también
//      es una pregunta de contabilidad sin responder; aislarla en `resolverDestinatarios` hace que
//      responderla sea añadir un origen, no rehacer el envío.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  SIIGO_ENVIO_MAX_DESTINATARIOS,
  type SiigoDestinatario,
  type SiigoEnvioOrigen,
  type SiigoEnvioRegistro,
  type SiigoEnvioResultado,
  type SiigoEnvioResumen,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoTramites, siigoFacturaEnvios, siigoFacturaTramites, siigoFacturas } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { isValidEmail } from '../../services/email.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { claveResiliencia } from './siigo.catalogos.service.js';
import { registrarOperacion } from './siigo.operaciones.repo.js';
import { motivoLegible } from './siigo.productos.service.js';
import { ejecutarConResiliencia } from './siigo.resiliencia.js';
import { detalleTecnico } from './siigo.redaccion.js';
import { efectosExternosPermitidos } from './siigo.config.js';
import type { SiigoAmbiente } from './credenciales.service.js';

const log = loggerFor('siigo.envio');

/**
 * Timeout del envío.
 *
 * Es una petición pequeña —una lista de direcciones—, pero Siigo tiene que adjuntar el documento
 * antes de contestar. Treinta segundos: por encima de una consulta normal y muy por debajo de los
 * 120 s del cliente, que están pensados para la creación de comprobantes.
 */
export const TIMEOUT_ENVIO_MS = 30_000;

/** Circuito propio. Que el envío de correo esté caído no puede dejar de emitir. */
export function claveCortacircuitosEnvio(ambiente: string): string {
  return `siigo:envio-correo:${ambiente}`;
}

/** Fallo con nombre propio. La ruta lo traduce a HTTP; el servicio no sabe de códigos de estado. */
export class SiigoEnvioError extends Error {
  readonly codigo:
    | 'no_existe'
    | 'factura_no_emitida'
    | 'ambiente_no_productivo'
    | 'cliente_sin_correo'
    | 'demasiados_destinatarios'
    | 'destinatario_invalido';

  constructor(codigo: SiigoEnvioError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoEnvioError';
    this.codigo = codigo;
  }
}

/** Lo que hace falta saber de una factura para enviarla. */
interface FacturaAEnviar {
  id: string;
  ambiente: string;
  siigoInvoiceId: string | null;
  numero: string | null;
  estado: string;
  clienteEmail: string | null;
  clienteContactEmail: string | null;
}

/**
 * Ficha de contacto de la que salen los destinatarios. Un tipo propio y mínimo, no la fila entera
 * de `clients`: la función de abajo es pura y se prueba sin base de datos.
 */
export interface FichaDeContacto {
  email: string | null;
  contactEmail: string | null;
}

/**
 * De dónde sale cada destinatario (AC2).
 *
 * **Pura, y ese es el punto.** No lee la base, no llama a Siigo y no conoce ninguna dirección: todo
 * lo que devuelve viene de la ficha que recibe. Una dirección escrita en el código —la del área de
 * cartera, la de un cliente concreto— sobreviviría a cualquier cambio de la ficha y acabaría
 * mandando facturas ajenas a quien ya no trabaja aquí.
 *
 * **Hoy devuelve solo el correo de la compañía.** Es la decisión D-3 del diseño. La ficha tiene
 * además el correo del contacto fiscal desde la HU #11292, y si debe recibirlo también es una
 * pregunta de contabilidad que nadie ha respondido — así que no se responde aquí por comodidad.
 * Cuando se responda, es añadir un elemento a la lista que devuelve esta función: ni el registro,
 * ni las validaciones, ni la llamada a Siigo cambian.
 */
export function resolverDestinatarios(ficha: FichaDeContacto): SiigoDestinatario[] {
  const correo = (ficha.email ?? '').trim();
  if (correo === '') return [];
  return [{ correo, origen: 'compania' }];
}

/**
 * ¿Esta lista se puede mandar? (AC6)
 *
 * Devuelve el motivo o `null`. Separada del envío para poder contestar «esto no va a salir» sin
 * gastar una petición ni escribir una fila — la usa también la comprobación previa de la pantalla.
 */
export function validarDestinatarios(
  destinatarios: SiigoDestinatario[],
): { codigo: SiigoEnvioError['codigo']; mensaje: string } | null {
  if (destinatarios.length === 0) {
    return {
      codigo: 'cliente_sin_correo',
      mensaje: 'El cliente no tiene un correo registrado en su ficha. Complételo para poder enviarle la factura.',
    };
  }
  if (destinatarios.length > SIIGO_ENVIO_MAX_DESTINATARIOS) {
    return {
      codigo: 'demasiados_destinatarios',
      mensaje: `Siigo admite como máximo ${SIIGO_ENVIO_MAX_DESTINATARIOS} direcciones por envío, y se pidieron ${destinatarios.length}.`,
    };
  }
  const posicion = destinatarios.findIndex((d) => !isValidEmail(d.correo.trim()));
  if (posicion >= 0) {
    // Se señala la POSICIÓN, no la dirección. El mensaje acaba en la columna `motivo`, que es
    // append-only y que la purga por derecho de supresión NO vacía —solo vacía `destinatarios`—,
    // así que escribir aquí la dirección abriría una copia permanente e inalcanzable de un dato
    // personal. No se pierde nada: la dirección está en `destinatarios`, que sí se puede redactar.
    return {
      codigo: 'destinatario_invalido',
      mensaje: `La dirección número ${posicion + 1} no tiene forma de dirección de correo.`,
    };
  }
  return null;
}

/**
 * Quita del texto cualquier cosa con forma de dirección de correo.
 *
 * Se aplica a lo que contesta Siigo antes de guardarlo en `motivo`. Nuestro simulador no devuelve
 * las direcciones en el error, pero el ambiente real es de otro y puede echárnoslas de vuelta en el
 * mensaje: si eso pasara, quedarían en una columna que la purga no vacía y que nadie puede editar.
 * Redactar aquí cuesta una línea; descubrirlo dentro de un año no tendría arreglo.
 */
export function redactarCorreos(texto: string): string {
  return texto.replace(/[^\s<>()[\]",;:]+@[^\s<>()[\]",;:]+\.[A-Za-z]{2,}/g, '[correo]');
}

/**
 * ¿Existe ya en Siigo? (AC5)
 *
 * Se exigen las dos cosas —estado `emitida` y el identificador que devolvió Siigo— porque son dos
 * afirmaciones distintas: la primera es lo que FLITO cree, la segunda es la prueba. Sin el
 * identificador no hay ni ruta a la que llamar.
 */
export function facturaEnviable(f: Pick<FacturaAEnviar, 'estado' | 'siigoInvoiceId'>): boolean {
  return f.estado === 'emitida' && f.siigoInvoiceId !== null && f.siigoInvoiceId.trim() !== '';
}

async function cargarFactura(facturaId: string): Promise<FacturaAEnviar | null> {
  // El cliente sale del trámite que la factura cubre, igual que en el archivo de documentos.
  //
  // **`activo` no es opcional aquí.** Un enlace desactivado es un trámite que esta factura YA NO
  // cubre; si entrara en el join, la fila ganadora la elegiría el planificador y la factura podría
  // salir al correo de otra empresa. Mandar la factura de A al cliente B no es un fallo de
  // presentación: es divulgación de datos fiscales y personales.
  //
  // El `orderBy` acompaña por la misma razón: con la estrategia consolidada que la Feature deja
  // preparada habría varios enlaces vivos, y «el primero» tiene que ser siempre el mismo primero.
  const [fila] = await db.select({
    id: siigoFacturas.id,
    ambiente: siigoFacturas.ambiente,
    siigoInvoiceId: siigoFacturas.siigoInvoiceId,
    numero: siigoFacturas.numero,
    estado: siigoFacturas.estado,
    clienteEmail: clients.email,
    clienteContactEmail: clients.contactEmail,
  })
    .from(siigoFacturas)
    .leftJoin(siigoFacturaTramites, and(
      eq(siigoFacturaTramites.facturaId, siigoFacturas.id),
      eq(siigoFacturaTramites.activo, true),
    ))
    .leftJoin(flitoTramites, eq(flitoTramites.id, siigoFacturaTramites.tramiteId))
    .leftJoin(clients, eq(clients.id, flitoTramites.companiaId))
    .where(eq(siigoFacturas.id, facturaId))
    .orderBy(asc(siigoFacturaTramites.tramiteId))
    .limit(1);

  return fila ?? null;
}

/** Escribe la fila del acta. Es el único sitio del módulo que inserta en esta tabla. */
async function anotarEnvio(campos: {
  facturaId: string;
  origen: SiigoEnvioOrigen;
  resultado: SiigoEnvioResultado;
  destinatarios: SiigoDestinatario[];
  codigo?: string | null;
  motivo?: string | null;
  solicitadoPor?: number | null;
}): Promise<SiigoEnvioRegistro> {
  const [fila] = await db.insert(siigoFacturaEnvios).values({
    facturaId: campos.facturaId,
    origen: campos.origen,
    resultado: campos.resultado,
    destinatarios: campos.destinatarios,
    codigo: campos.codigo ?? null,
    motivo: campos.motivo ?? null,
    solicitadoPor: campos.solicitadoPor ?? null,
  }).returning();

  return aRegistro(fila);
}

function aRegistro(fila: typeof siigoFacturaEnvios.$inferSelect): SiigoEnvioRegistro {
  return {
    id: fila.id,
    facturaId: fila.facturaId,
    origen: fila.origen as SiigoEnvioOrigen,
    resultado: fila.resultado as SiigoEnvioResultado,
    destinatarios: fila.destinatarios ?? [],
    motivo: fila.motivo,
    codigo: fila.codigo,
    solicitadoPor: fila.solicitadoPor,
    creadoEn: fila.createdAt instanceof Date ? fila.createdAt.toISOString() : String(fila.createdAt),
  };
}

/**
 * Envía —o reenvía— la factura por correo (AC1, AC3, AC4, AC5, AC6).
 *
 * El orden de las comprobaciones no es estético: cada una que se adelanta es una petición que no se
 * gasta y un error que no cuenta en la proporción por la que Siigo bloquea el usuario API.
 *
 * Un fallo de Siigo NO lanza: deja la fila en `fallido` y la devuelve. Reenviar es una acción que
 * una persona repite mirando la pantalla, y para eso necesita ver qué pasó la vez anterior. Lo que
 * sí lanza es lo que hace la petición imposible —factura inexistente o no emitida—, porque ahí no
 * hay nada que registrar contra una factura que no está.
 */
export async function enviarFacturaPorCorreo(
  facturaId: string,
  opciones: { solicitadoPor?: number | null; destinatarios?: SiigoDestinatario[] } = {},
): Promise<SiigoEnvioRegistro> {
  const f = await cargarFactura(facturaId);
  if (!f) throw new SiigoEnvioError('no_existe', 'La factura no existe.');

  // A6 — el segundo camino al correo del cliente, y el que se olvida.
  //
  // Omitir `mail` al crear la factura cierra la puerta de la emisión, no esta: aquí se llama a
  // `POST /v1/invoices/{id}/mail` con la dirección REAL de la empresa, que sale de `clients.email`.
  // Un clic en «reenviar» desde QA le manda una factura de ensayo a un cliente de verdad, y eso no
  // se puede deshacer. Va ANTES de comprobar el estado de la factura a propósito: no es un problema
  // de esta factura, es que en este ambiente no se manda correo a nadie.
  if (!efectosExternosPermitidos(f.ambiente as SiigoAmbiente)) {
    throw new SiigoEnvioError(
      'ambiente_no_productivo',
      `Las facturas del ambiente ${f.ambiente} no se envían por correo: solo se crean en Siigo. `
      + 'El correo al cliente únicamente sale desde producción.',
    );
  }

  // AC5 — no se reenvía lo que todavía no existe en Siigo. Se lanza en vez de registrar porque no
  // es un envío que salió mal: es una operación que no tenía sentido pedir.
  if (!facturaEnviable(f)) {
    throw new SiigoEnvioError(
      'factura_no_emitida',
      'La factura todavía no existe en Siigo: no está emitida o falló al emitirse.',
    );
  }

  // AC2 — la lista la calcula la función resolutora, salvo que quien llama traiga la suya.
  const destinatarios = opciones.destinatarios
    ?? resolverDestinatarios({ email: f.clienteEmail, contactEmail: f.clienteContactEmail });

  // AC3 y AC6 — todo lo comprobable se comprueba antes de salir a la red.
  const problema = validarDestinatarios(destinatarios);
  if (problema) {
    return anotarEnvio({
      facturaId: f.id,
      origen: 'reenvio',
      resultado: 'no_realizado',
      destinatarios,
      codigo: problema.codigo,
      motivo: problema.mensaje,
      solicitadoPor: opciones.solicitadoPor,
    });
  }

  const correos = destinatarios.map((d) => d.correo.trim());
  try {
    await ejecutarConResiliencia(
      () => siigoRequestOrThrow<unknown>({
        metodo: 'POST',
        ruta: `/v1/invoices/${encodeURIComponent(f.siigoInvoiceId!)}/mail`,
        ambiente: f.ambiente as SiigoAmbiente,
        cuerpo: { mail_to: correos },
        timeoutMs: TIMEOUT_ENVIO_MS,
      }),
      {
        clave: claveResiliencia(f.ambiente),
        claveCortacircuitos: claveCortacircuitosEnvio(f.ambiente),
      },
    );

    await registrarOperacion({
      ambiente: f.ambiente,
      operacion: 'factura_envio_correo',
      resultado: 'ok',
      // Cuántas direcciones, no cuáles: la bitácora no es sitio para datos personales, y el acta
      // —que sí las guarda y sí se puede purgar— ya es el registro autorizado para eso.
      mensaje: `Factura ${f.numero ?? f.id} enviada a ${correos.length} destinatario(s).`,
    });

    return anotarEnvio({
      facturaId: f.id,
      origen: 'reenvio',
      resultado: 'enviado',
      destinatarios,
      solicitadoPor: opciones.solicitadoPor,
    });
  } catch (e) {
    const motivo = redactarCorreos(motivoLegible(e));
    // `detalleTecnico` y no el error entero: el serializador de pino copia las propiedades propias
    // del error, y `SiigoApiError` expone `params`, `detail` y el cuerpo crudo de la respuesta. Si
    // Siigo devolviera ahí la dirección ofensora, acabaría en un log que ninguna purga alcanza y
    // que `logger.redact` no cubre —solo cubre credenciales—. Los logs no se pueden olvidar.
    log.error({ err: redactarCorreos(detalleTecnico(e)), facturaId: f.id },
      'envio de factura por correo falló');
    await registrarOperacion({
      ambiente: f.ambiente,
      operacion: 'factura_envio_correo',
      resultado: 'error_tecnico',
      mensaje: motivo,
    });

    // AC1 — un envío fallido queda registrado como fallido; no se pierde.
    return anotarEnvio({
      facturaId: f.id,
      origen: 'reenvio',
      resultado: 'fallido',
      destinatarios,
      codigo: 'siigo_rechazo',
      motivo,
      solicitadoPor: opciones.solicitadoPor,
    });
  }
}

/**
 * Anota el correo que la CREACIÓN de la factura produjo (AC7).
 *
 * Esta historia no vuelve a implementar ese envío: la creación ya le pide a Siigo que mande el
 * correo en el mismo `POST` (`mail: true` en `facturacion.armado.ts`). Lo que faltaba es que
 * quedara escrito, porque si no, el primer correo —el que el cliente de verdad recibe— sería justo
 * el único invisible en el historial, y el segundo parecería el primero.
 *
 * La llama el emisor cuando exista, pasándole lo que Siigo contestó. `enviado` se toma de la
 * respuesta (`mail.send`) y no de lo que pedimos: pedir no es enviar.
 */
export async function registrarEnvioDeEmision(
  facturaId: string,
  respuesta: { enviado: boolean; destinatarios: SiigoDestinatario[]; motivo?: string | null },
): Promise<SiigoEnvioRegistro> {
  return anotarEnvio({
    facturaId,
    origen: 'emision',
    resultado: respuesta.enviado ? 'enviado' : 'no_realizado',
    destinatarios: respuesta.destinatarios,
    codigo: respuesta.enviado ? null : 'emision_sin_correo',
    motivo: respuesta.enviado
      ? null
      : respuesta.motivo ?? 'Siigo no envió el correo al crear la factura.',
    solicitadoPor: null,
  });
}

/**
 * «¿Se le mandó, cuántas veces y cuándo la última?» (AC4)
 *
 * `ultimo` y `ultimoEnviado` son campos distintos a propósito: si el último intento falló, la
 * pregunta útil sigue siendo cuándo fue la última vez que el cliente SÍ recibió algo. Colapsarlos
 * haría que una factura entregada hace un mes y con un reenvío fallido hoy pareciera no entregada.
 */
export async function resumenEnvios(facturaId: string): Promise<SiigoEnvioResumen> {
  const filas = await db.select()
    .from(siigoFacturaEnvios)
    .where(eq(siigoFacturaEnvios.facturaId, facturaId))
    .orderBy(desc(siigoFacturaEnvios.createdAt));

  const envios = filas.map(aRegistro);
  const enviados = envios.filter((e) => e.resultado === 'enviado');

  return {
    facturaId,
    veces: envios.length,
    vecesEnviado: enviados.length,
    ultimo: envios[0] ?? null,
    ultimoEnviado: enviados[0] ?? null,
    envios,
  };
}

/**
 * Redacta las direcciones de las actas de un titular, conservando el hecho del envío (Ley 1581).
 *
 * Es la mitad de la tabla que el flujo de olvido sí puede tocar, y la única: el disparador de la
 * migración 0141 rechaza cualquier otro cambio. Después de esto la fila sigue diciendo «se envió el
 * día X con resultado Y», que es lo que prueba la entrega ante una glosa, sin conservar a quién.
 *
 * **Se busca por dos caminos, y hacen falta los dos.** El primero es la compañía de la factura; el
 * segundo, la dirección en sí. Buscar solo por compañía deja fuera tres clases de acta con datos
 * personales dentro, y en las tres el flujo de olvido le diría al titular que se le olvidó:
 *
 *   1. `flito_tramites.compania_id` es NULLABLE —«la empresa aún no existe»—, y ningún `IN` casa
 *      con `NULL`. Un acta de una factura cuyo trámite no tiene compañía resuelta sería inalcanzable
 *      para siempre.
 *   2. La ruta admite destinatarios escritos a mano, que pueden ser de un tercero que no es el
 *      cliente de esa factura. La purga por compañía está indexada por el DUEÑO DE LA FACTURA, no
 *      por el titular del dato — que es justamente quien ejerce el derecho.
 *   3. Una segunda ejecución del olvido sobre el mismo documento no encuentra clientes (ya están
 *      anonimizados) y se quedaría sin nada que purgar aunque hubiera actas nuevas.
 *
 * El segundo camino usa contención de jsonb (`@>`), que es lo que el índice GIN de la 0141 acelera.
 *
 * Devuelve cuántas actas se redactaron. Las ya purgadas se excluyen, y eso no es una optimización:
 * el disparador rechaza volver a purgar una fila redactada, así que sin el filtro una segunda
 * llamada abortaría la transacción entera del olvido.
 *
 * Recibe el ejecutor porque el flujo de olvido corre dentro de UNA transacción: si esto usara la
 * conexión suelta, las direcciones se borrarían aunque el resto del olvido se deshiciera después
 * —o al revés—, y quedaría un titular medio olvidado que nadie sabría terminar de olvidar.
 */
export async function purgarDestinatariosDeClientes(
  companiaIds: number[],
  correos: string[] = [],
  ejecutor: Pick<typeof db, 'select' | 'update'> = db,
): Promise<number> {
  const limpios = correos.map((c) => c.trim()).filter((c) => c !== '');
  if (companiaIds.length === 0 && limpios.length === 0) return 0;

  const porCompania = companiaIds.length > 0
    ? sql`EXISTS (
        SELECT 1 FROM siigo_factura_tramites sft
          JOIN flito_tramites ft ON ft.id = sft.tramite_id
         WHERE sft.factura_id = ${siigoFacturaEnvios.facturaId}
           AND ft.compania_id IN (${sql.join(companiaIds.map((c) => sql`${c}`), sql`, `)}))`
    : sql`false`;

  const porCorreo = limpios.length > 0
    ? sql`${siigoFacturaEnvios.destinatarios} @> ANY (ARRAY[${sql.join(
        limpios.map((c) => sql`${JSON.stringify([{ correo: c }])}::jsonb`), sql`, `,
      )}])`
    : sql`false`;

  const actas = await ejecutor.select({ id: siigoFacturaEnvios.id })
    .from(siigoFacturaEnvios)
    .where(and(
      isNull(siigoFacturaEnvios.destinatariosPurgadosEn),
      sql`(${porCompania} OR ${porCorreo})`,
    ));

  if (actas.length === 0) return 0;

  const purgadas = await ejecutor.update(siigoFacturaEnvios)
    .set({ destinatarios: [], destinatariosPurgadosEn: new Date() })
    .where(and(
      inArray(siigoFacturaEnvios.id, actas.map((a) => a.id)),
      isNull(siigoFacturaEnvios.destinatariosPurgadosEn),
    ))
    .returning({ id: siigoFacturaEnvios.id });

  return purgadas.length;
}
