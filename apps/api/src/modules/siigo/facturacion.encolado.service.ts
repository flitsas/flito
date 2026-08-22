// Siigo — enviar trámites a facturación electrónica (HU #11328, Feature #11242).
//
// **Es el disparador de la Feature.** Hasta esta historia nada en el repositorio llamaba a la
// emisión: existían la elegibilidad (#11324), el armado (#11323), la emisión (#11326) y la cola con
// su trabajador (#11327), pero ninguna puerta por la que un humano pudiera pedir que se facturara.
// Esta es esa puerta, y por eso las guardas importan más que de costumbre.
//
// QUÉ HACE ESTE ARCHIVO Y QUÉ NO
//
// Compone dos piezas que ya existen y no reimplementa ninguna: pregunta a `evaluarElegibilidad` y,
// para lo que pasa el filtro, llama a `encolar`. La idempotencia (AC3) es del encolado —vive en dos
// índices únicos de la base, no en una comprobación previa— y los motivos del rechazo (AC2) son los
// de la elegibilidad, propagados palabra por palabra. Aquí no se decide ninguna de las dos cosas: si
// este archivo empezara a decidirlas, habría dos versiones de la misma regla y la copia sería
// siempre la que se quedara vieja.
//
// TRES DECISIONES
//
//   1. **Un lote por trámite** (AC1). `encolar` recibe UN id cada vez, no la lista entera. Con la
//      lista entera saldría un solo lote de N trámites: una sola clave de idempotencia, una sola
//      fila de cola y, por tanto, una sola factura para todos — y un fallo de uno se llevaría por
//      delante a los demás. Además la estrategia vigente es `por_tramite` (D-1), así que el lote
//      conjunto ni siquiera sería facturable. El coste es N llamadas; la alternativa es un cambio de
//      granularidad tomado por accidente.
//   2. **La elegibilidad se evalúa UNA vez para toda la selección**, no una por trámite: esa función
//      está escrita para lotes y arrastra los ocho joins del reporte de costos. Una llamada por fila
//      serían doscientas consultas pesadas para responder a un botón.
//   3. **En serie y no en paralelo.** Cada encolado son cuatro sentencias y un `ON CONFLICT`;
//      doscientos en paralelo agotarían el pool de conexiones para atender un solo clic, y dejarían
//      a las demás peticiones de la API esperando detrás. Un envío es una operación de fondo que
//      puede tardar; el resto de la aplicación no tiene por qué enterarse.

import type {
  ConceptoFacturable, ElegibilidadTramite, MotivoElegibilidad, SiigoEnvioTramite,
  SiigoRespuestaEnvio,
} from '@operaciones/shared-types';
import { resumirEnvio } from '@operaciones/shared-types';
import { evaluarElegibilidad } from './facturacion.elegibilidad.service.js';
import { encolar } from './facturacion.cola.service.js';
import { recordarEmision } from './emision-cliente.repo.js';
import type { EmisionElegida } from './facturacion.armado.js';
import { correoNoSolicitado, type CorreoDelEnvio } from './facturacion.correo.js';
import { exigirIntegracionNoFrenada } from './siigo.freno.service.js';
import { sanearMensaje } from './siigo.redaccion.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/**
 * Tope de trámites por envío.
 *
 * Es el tamaño de página máximo del reporte de costos, que es de donde sale la selección: quien
 * marca «toda la página» tiene que poder enviarla de una vez. Más alto no sirve de nada —no hay
 * pantalla que seleccione más— y sí costaría: son ~4 sentencias por trámite en la misma petición
 * HTTP. Deliberadamente por debajo del tope de la elegibilidad (400), que solo lee.
 */
export const TOPE_TRAMITES_ENVIO = 200;

/**
 * El envío es incoherente y no se encola nada. La ruta lo traduce a 400.
 *
 * Es la única familia de fallos de esta capa que aborta la petición ENTERA en vez de resolverse
 * trámite a trámite, y la diferencia no es de gravedad sino de sujeto: un trámite no elegible es un
 * hecho sobre ese trámite —los demás siguen—, mientras que esto es un defecto de lo que se pidió, y
 * lo pedido es uno solo. Contestar «rechazado» fila por fila diría que el problema está en los
 * trámites, que están bien.
 */
export class SiigoEnvioInvalidoError extends Error {
  readonly codigo: 'correo_multiempresa';

  constructor(codigo: SiigoEnvioInvalidoError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoEnvioInvalidoError';
    this.codigo = codigo;
  }
}

export interface EntradaEnvio {
  tramiteIds: string[];
  /**
   * Qué conceptos van en la factura (A1). Se elige al enviar y NO se deduce de la liquidación: a
   * una empresa se le gestiona el trámite entero pero solo se le factura electrónicamente una parte
   * —hoy, el trámite digital—; el resto se recupera por reintegro.
   *
   * Van para toda la selección y no por trámite: quien marca cincuenta filas del reporte está
   * facturando lo mismo de todas. Discriminar por trámite sería otra historia y otra pantalla.
   */
  conceptos: readonly ConceptoFacturable[];
  /**
   * La emisión elegida, UNA POR EMPRESA (A2). Ausente o sin la empresa de un trámite = ese trámite
   * se emite con la configuración global vigente, que es lo que se hacía antes de A2.
   *
   * Por empresa y no por trámite porque el vendedor y la forma de pago son atributos del cliente:
   * cincuenta trámites de la misma empresa comparten los cuatro valores, y pedirlos cincuenta veces
   * sería el camino más lento y el que más se equivoca.
   */
  emision?: ReadonlyArray<EmisionElegida & { clienteId: number }>;
  /**
   * Si la factura sale por correo al cliente y a qué direcciones (HU #11708). Ausente = no se pidió.
   *
   * Va para toda la selección y no por empresa, al revés que `emision`. El vendedor y la forma de
   * pago son atributos del cliente; «mándale esta factura por correo» es una decisión del momento en
   * que se envía, y quien marca cincuenta filas la toma una vez para las cincuenta.
   *
   * **Y justo por ser de la selección entera, las direcciones concretas exigen UNA sola empresa.**
   * Con dos, la misma lista se aplicaría a las facturas de las dos y cada empresa recibiría la de la
   * otra: una entrega de datos personales a quien no es su titular (Ley 1581) que además queda en el
   * acta como un `enviado` normal, indistinguible de uno correcto. Lo rechaza
   * `exigirCorreoDeUnaSolaEmpresa`, y es la misma postura que la pantalla: con varias empresas no se
   * escriben direcciones, se envía con la lista vacía y cada factura sale a la ficha de su cliente.
   *
   * **Ausente no es «como antes».** Antes de esta historia el correo lo decidía el ambiente y en
   * producción salía siempre. Ahora, si nadie lo pide, no sale — y la emisión deja acta diciendo que
   * no se pidió, que es lo que distingue «nadie lo quería» de «se nos olvidó» (AC2).
   */
  correo?: CorreoDelEnvio;
  /**
   * Contra qué empresa de Siigo se encola. **Lo decide el servidor** (`env.SIIGO_AMBIENTE`) y nunca
   * quien llama: dejarlo elegir al cliente sería ofrecer un botón para emitir en producción desde
   * una pantalla de pruebas, y una factura aceptada por la DIAN no se deshace. El tipo lo pide
   * explícito para que la ruta tenga que escribir de dónde sale, no para que pueda elegirlo.
   */
  ambiente: SiigoAmbiente;
  usuarioId: number | null;
  /** Volver a poner en cola lo dado por perdido. Apagado por omisión (AC3). */
  reactivar?: boolean;
  ahora?: Date;
}

/**
 * Envía una selección a la cola de facturación electrónica.
 *
 * **Un trámite rechazado no impide que los demás se encolen** (AC1), y eso no es un detalle de
 * implementación: quien selecciona cincuenta trámites del reporte no ha comprobado uno por uno que
 * los cincuenta sean elegibles. Si el primero sin documentación tumbara la petición entera, la única
 * forma de facturar sería ir de uno en uno. Por eso cada trámite tiene su propio desenlace, incluido
 * el fallo inesperado del encolado, y por eso el bucle no lanza nunca.
 *
 * Lanza —y aborta el envío completo— en un solo caso: la integración frenada. Es deliberado: llenar
 * una cola que nadie va a vaciar no ayuda a nadie, y deja a quien envió creyendo que hay trabajo en
 * marcha cuando lo que hay es un freno puesto.
 */
export async function enviarAFacturacion(entrada: EntradaEnvio): Promise<SiigoRespuestaEnvio> {
  const { ambiente, usuarioId } = entrada;

  // ANTES de evaluar nada: si el freno está puesto, no se toca la base para una petición que no va
  // a producir trabajo útil. Deja su propio rastro en la bitácora y lanza.
  await exigirIntegracionNoFrenada({ ambiente, usuarioId });

  // Se conserva el orden en que llegaron, sin duplicados: quien envió una lista espera la respuesta
  // en el mismo orden para poder casarla con sus filas sin buscar por identificador.
  const ids = [...new Set(entrada.tramiteIds.filter(Boolean))];
  const conceptos = [...new Set(entrada.conceptos)];

  // C2 — la elegibilidad se evalúa contra los conceptos ELEGIDOS, no contra los que el trámite
  // tenga liquidados. Sin esto, un trámite con SOAT sin mapear bloquearía una factura de trámite
  // digital en la que el SOAT no aparece.
  const veredictos = new Map(
    (await evaluarElegibilidad(ids, ambiente, conceptos)).map((v) => [v.tramiteId, v]),
  );

  // HU #11708 — la guarda va AQUÍ y no en la ruta, y esa es la excepción razonada al reparto de
  // siempre (la ruta valida la forma, el servicio decide). Lo que hay que comprobar no es la forma
  // del cuerpo —`correo` y `tramiteIds` son válidos por separado— sino a cuántas empresas pertenece
  // lo que se seleccionó, y eso solo se sabe leyendo. La ruta tendría que consultar la base para
  // preguntarlo, o repetir esta misma evaluación: dos consultas de elegibilidad por envío y dos
  // sitios donde vive la regla. Va justo después de los veredictos —la primera línea en que el dato
  // existe— y antes del bucle, que es lo que la hace un rechazo y no una limpieza a medias: hasta
  // aquí solo se ha leído.
  exigirCorreoDeUnaSolaEmpresa(entrada.correo, veredictos);

  // A2 — la emisión se indexa por empresa una sola vez. Cada trámite busca la suya por su compañía,
  // que la elegibilidad ya resolvió: sin eso habría que volver a consultarla por trámite.
  const emisionPorCliente = new Map<number, EmisionElegida>(
    (entrada.emision ?? []).map((e) => [e.clienteId, {
      documentoTipoCodigo: e.documentoTipoCodigo,
      vendedorCodigo: e.vendedorCodigo,
      formaPagoCodigo: e.formaPagoCodigo,
      centroCostoCodigo: e.centroCostoCodigo,
    }]),
  );

  const items: SiigoEnvioTramite[] = [];
  const recordados = new Set<number>();
  for (const tramiteId of ids) {
    const veredicto = veredictos.get(tramiteId);
    const companiaId = veredicto?.companiaId ?? null;
    const emision = companiaId === null ? undefined : emisionPorCliente.get(companiaId);

    const item = await enviarUno(tramiteId, veredicto?.motivos, entrada, emision);
    items.push(item);

    // Se recuerda solo lo que de verdad se encoló, y una vez por empresa. Recordar una elección que
    // acabó en rechazo precargaría el próximo diálogo con algo que nunca llegó a facturar nada.
    if (item.resultado === 'encolado' && companiaId !== null && emision && !recordados.has(companiaId)) {
      recordados.add(companiaId);
      await recordarEmision(ambiente, companiaId, emision, entrada.usuarioId);
    }
  }

  return { ambiente, items, resumen: resumirEnvio(items) };
}

/**
 * Direcciones concretas y varias empresas en la misma selección: no se encola nada (HU #11708).
 *
 * `correo.destinatarios` viaja para la selección ENTERA —así se guarda en el lote y así lo lee el
 * trabajador—, de modo que con dos empresas la factura de cada una saldría también al buzón de la
 * otra. No es un envío de más: es entregar a un tercero la facturación de una empresa que no
 * autorizó nada (Ley 1581), y el acta lo registraría como un `enviado` cualquiera, así que después
 * no habría ni forma de encontrarlo. Como el correo sale de un documento fiscal ya emitido, tampoco
 * se puede deshacer.
 *
 * **El servidor no puede ser el lado permisivo**: la pantalla ya no deja escribir direcciones con
 * varias empresas, pero un `POST` construido a mano por cualquiera con permiso `emitir` no pasa por
 * la pantalla, y la frontera es esta.
 *
 * Se cuentan las empresas de lo que DE VERDAD se encolaría —los trámites sin motivos—, no las de
 * todo lo seleccionado. Un trámite rechazado no produce factura y por tanto no produce correo:
 * contarlo bloquearía envíos legítimos —cincuenta trámites de una empresa y uno, no elegible, de
 * otra— sin proteger nada. Un veredicto elegible siempre trae compañía; los que no la tienen entran
 * con el motivo `sin_compania` y quedan fuera por su cuenta.
 *
 * **Sin direcciones concretas no hay nada que rechazar** y varias empresas son legítimas: la lista
 * vacía significa «a quien diga la ficha de cada cliente», y ahí cada factura sale a la suya.
 *
 * El mensaje no nombra ni una dirección ni una empresa, solo cuántas hay (AC5): lo que se responde a
 * una petición rechazada acaba en el registro de errores de quien integra.
 */
function exigirCorreoDeUnaSolaEmpresa(
  correo: CorreoDelEnvio | undefined, veredictos: Map<string, ElegibilidadTramite>,
): void {
  if (!correo || correo.destinatarios.length === 0) return;

  const empresas = new Set<number>();
  for (const v of veredictos.values()) {
    if (v.motivos.length === 0 && v.companiaId !== null) empresas.add(v.companiaId);
  }
  if (empresas.size <= 1) return;

  throw new SiigoEnvioInvalidoError(
    'correo_multiempresa',
    `La selección tiene trámites de ${empresas.size} empresas y se escribieron direcciones de `
    + 'correo concretas, que se aplicarían a todas las facturas por igual. Envía una empresa a la '
    + 'vez para elegir direcciones, o envíalas sin direcciones: cada factura sale a las de la ficha '
    + 'de su propio cliente.',
  );
}

/**
 * Un trámite: se juzga, y si pasa, se encola.
 *
 * `motivos === undefined` significa que la evaluación no devolvió veredicto para ese trámite, cosa
 * que hoy no puede pasar —devuelve uno por cada identificador válido, incluidos los inexistentes—.
 * Se trata como `error` y no como `no_elegible` a propósito: un «no elegible» sin motivos sería
 * justo el mensaje genérico que toda la elegibilidad existe para no dar, y además taparía un fallo
 * real haciéndolo pasar por una regla de negocio.
 */
async function enviarUno(
  tramiteId: string, motivos: MotivoElegibilidad[] | undefined, entrada: EntradaEnvio,
  emision: EmisionElegida | undefined,
): Promise<SiigoEnvioTramite> {
  const base = { tramiteId, motivos: [], estado: null, colaId: null, loteId: null, detalle: null };

  if (motivos === undefined) {
    return {
      ...base,
      resultado: 'error',
      detalle: 'No se pudo evaluar la elegibilidad de este trámite. No se encoló nada.',
    };
  }
  // AC2 — los motivos viajan TAL CUAL los devolvió la elegibilidad. Ni se resumen, ni se traducen,
  // ni se sustituyen por un texto de esta ruta.
  if (motivos.length > 0) return { ...base, resultado: 'no_elegible', motivos };

  try {
    const r = await encolar({
      tramiteIds: [tramiteId],
      conceptos: entrada.conceptos,
      emision,
      correo: entrada.correo ?? correoNoSolicitado(),
      ambiente: entrada.ambiente,
      usuarioId: entrada.usuarioId,
      reactivar: entrada.reactivar,
      ahora: entrada.ahora,
    });
    return {
      ...base, resultado: r.resultado, estado: r.estado, colaId: r.colaId, loteId: r.loteId,
    };
  } catch (e) {
    // `sanearMensaje` SIEMPRE: un error del motor envuelto por drizzle llega con la sentencia y sus
    // parámetros dentro —que aquí incluyen identificadores de trámite— y este texto acaba en
    // pantalla. Es la misma regla que aplica el desenlace de la cola.
    return {
      ...base,
      resultado: 'error',
      detalle: sanearMensaje(e instanceof Error ? e.message : 'Fallo al encolar el trámite.'),
    };
  }
}
