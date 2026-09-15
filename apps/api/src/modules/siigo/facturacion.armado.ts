// Cómo se arma la factura que se le envía a Siigo (HU #11325, Feature #11242).
//
// **Función pura, sin base de datos.** Recibe la liquidación, el mapeo ya resuelto, la
// configuración y el tercero —identificación y sucursal— como parámetros. Dos motivos:
//
//   1. Se puede probar el armado entero sin levantar nada, y estas son las pruebas que importan:
//      lo que sale de aquí es un documento ante la DIAN.
//   2. No depende de la tabla de terceros, que es de la HU #11297 y todavía no existe. Que el
//      armador esté escrito antes que ella no es casualidad: son dos preguntas separables.
//
// **Solo se envía lo que Siigo marca como obligatorio** (decisión de negocio del 2026-08-13). En
// `InvoiceIn` eso es: `document`, `date`, `customer`, `seller`, `items[]` —`code`, `quantity`,
// `price`— y `payments[]` —`id`, `value`—, más `cost_center` cuando el comprobante lo exige. Todo lo
// demás se omite, y cada omisión tiene una respuesta detrás, no una duda:
//
//   · `retentions[]` — las retenciones se configuran en el TERCERO en Siigo Nube. Si un cliente
//     existe, ya las trae; mandarlas desde aquí sería una segunda fuente de la misma verdad.
//   · `items[].taxes` — mismo principio, un nivel más abajo: los impuestos los aplica Siigo desde
//     el producto (A7, migración 0145).
//   · `currency` — el campo es literalmente «Código de Moneda EXTRANJERA». Se factura en COP, y en
//     COP lo correcto no es enviar `{ code: 'COP' }`: es no enviar nada.
//   · `number` — ni siquiera existe en `InvoiceIn`. El consecutivo lo asigna Siigo.
//   · `payments[].due_date` — no se maneja plazo de vencimiento. Ver `armarFactura` para lo que
//     esto implica si alguien elige una forma de pago que sí lo maneje.

import { createHash } from 'node:crypto';
import {
  CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION,
  CONCEPTO_FACTURABLE_LABEL,
  SIIGO_IDEMPOTENCY_KEY_MAX,
  SIIGO_IDEMPOTENCY_KEY_RE,
  type ConceptoFacturable,
  type ItemServicioSellado,
  type ValoresLiquidacion,
} from '@operaciones/shared-types';
import type { MapeoConcepto } from './mapeo-conceptos.service.js';
import { conceptosAplicables } from './siigo.compuerta.service.js';

// ── Lo que el armador necesita saber ────────────────────────────────────────

/** El tercero YA resuelto. La sucursal sale del vínculo con Siigo, nunca de un cero escrito aquí. */
export interface TerceroResuelto {
  identificacion: string;
  sucursal: number;
}

/** Un trámite con lo suyo: sus valores sellados y los datos que van a las observaciones. */
export interface TramiteFacturable {
  tramiteId: string;
  /** Identificador FLIT visible, el que usa la operación para hablar del trámite. */
  idFlit: string;
  placa: string | null;
  tipoTramite: string | null;
  liquidacion: ValoresLiquidacion;
  /**
   * El desglose SELLADO de los servicios adicionales (HU #12547), tal como quedó en
   * `detalle->'serviciosAdicionales'->'items'` al liquidar. Vacío cuando no hubo ninguno.
   *
   * **Campo aparte y no dentro de `ValoresLiquidacion`**: aquella describe UN valor por concepto y
   * de aquí salen VARIAS líneas de factura. Y es lo sellado, nunca una relectura de la tabla puente
   * `flito_tramite_servicios_adicionales`: un servicio quitado después del sello no se factura, y
   * la liquidación es la única que sabe qué se cobró.
   */
  serviciosAdicionales: ItemServicioSellado[];
}

/**
 * Con qué se emite. **Se elige en cada envío, por empresa** — ya no hay configuración global.
 *
 * Los cuatro primeros son identificadores de una empresa de Siigo y salen de sus catálogos, nunca
 * de un literal escrito aquí. Los tres primeros son obligatorios porque `InvoiceIn` los exige;
 * `centroCostoCodigo` solo cuando el comprobante lo pide (`cost_center_mandatory`).
 */
export interface ParametrosEmision {
  documentoTipoCodigo: string;
  vendedorCodigo: string;
  formaPagoCodigo: string;
  centroCostoCodigo: string | null;
  /**
   * Si la factura se timbra ante la DIAN. Entra como DATO y no se deduce aquí del ambiente: quien
   * llama es el único que sabe contra qué empresa está emitiendo, y este archivo no toma decisiones
   * de negocio (ver la cabecera). `efectosExternosPermitidos` de `siigo.config.ts` lo resuelve.
   */
  timbrarEnDian: boolean;
  /** Si Siigo le manda copia al cliente al crear la factura. Misma procedencia que el anterior. */
  enviarCorreoAlCliente: boolean;
}

/** El mapeo resuelto de cada concepto que aparece en el grupo. */
export type MapeoPorConcepto = Partial<Record<ConceptoFacturable, MapeoConcepto>>;

export interface EntradaArmado {
  tramites: TramiteFacturable[];
  tercero: TerceroResuelto;
  parametros: ParametrosEmision;
  /**
   * Los conceptos elegidos al enviar (A1). Vacío = lote anterior a A1, que cubría TODOS los
   * aplicables de la liquidación; se conserva ese significado para poder emitir lo que ya estaba en
   * cola cuando esta historia entró.
   */
  conceptos: readonly ConceptoFacturable[];
  mapeo: MapeoPorConcepto;
  /** Fecha del documento, `yyyy-MM-dd`. Se recibe: el armador no lee el reloj. */
  fecha: string;
}

// ── Lo que sale ─────────────────────────────────────────────────────────────

export interface LineaFactura {
  code: string;
  description: string;
  quantity: number;
  price: number;
  taxes?: { id: number }[];
}

export interface FacturaArmada {
  document: { id: number };
  date: string;
  customer: { identification: string; branch_office: number };
  seller: number;
  items: LineaFactura[];
  /** Exactamente una, y sin `due_date`: no se maneja plazo de vencimiento. */
  payments: { id: number; value: number }[];
  observations: string;
  cost_center?: number;
  /**
   * Ausente = no se timbra. **Ausente y `{ send: false }` no son lo mismo para nosotros aunque
   * Siigo los trate igual**: lo primero es no pedir nada, lo segundo es afirmar que no. Se omite,
   * que es el mismo criterio de `retentions[]` y `number`.
   */
  stamp?: { send: boolean };
  /** Ausente = Siigo no manda copia al cliente. Mismo criterio que `stamp`. */
  mail?: boolean;
  /** Solo para trazabilidad interna; no viaja a Siigo. */
  _total: number;
}

export type MotivoRechazoArmado =
  | 'concepto_sin_mapeo'
  | 'concepto_sin_producto'
  | 'sin_lineas'
  | 'total_no_positivo'
  | 'importe_negativo'
  | 'parametro_no_numerico'
  | 'grupo_vacio'
  /**
   * HU #12547 — la suma de los items sellados no coincide con `valor_servicios_adicionales`, o hay
   * valor sellado sin items. Son datos que se contradicen a sí mismos dentro de la MISMA
   * liquidación: facturar cualquiera de las dos versiones sería elegir al azar cuál miente ante la
   * DIAN.
   */
  | 'servicios_no_cuadran';

export class FacturaNoArmableError extends Error {
  constructor(
    public readonly motivo: MotivoRechazoArmado,
    mensaje: string,
    public readonly detalle?: string,
  ) {
    super(mensaje);
    this.name = 'FacturaNoArmableError';
  }
}

// ── Idempotencia (AC6) ──────────────────────────────────────────────────────

/**
 * Deriva la clave de idempotencia de la identidad del lote.
 *
 * **El id del lote no sirve tal cual**: un UUID lleva guiones y 36 caracteres, y el contrato de
 * Siigo exige alfanumérico de hasta 30 sin especiales — `siigo.client.ts` lo rechaza antes de salir
 * a la red. Se deriva con un resumen truncado.
 *
 * Determinista y **nunca aleatoria**: es lo único que impide que un reintento produzca una segunda
 * factura ante la DIAN. Calcularla dos veces sobre el mismo lote da lo mismo, por construcción.
 */
export function claveIdempotencia(ambiente: string, huellaLote: string): string {
  const clave = createHash('sha256')
    .update(`${ambiente}|${huellaLote}`)
    .digest('hex')
    .slice(0, SIIGO_IDEMPOTENCY_KEY_MAX);
  /* c8 ignore next 3 -- un sha256 hex truncado siempre cumple; la guarda es por si el algoritmo
     cambia algún día y nadie recuerda el contrato. */
  if (!SIIGO_IDEMPOTENCY_KEY_RE.test(clave)) {
    throw new FacturaNoArmableError('parametro_no_numerico', `Clave de idempotencia inválida: ${clave}`);
  }
  return clave;
}

/**
 * Huella del conjunto de trámites: sha256 de sus ids **ordenados**.
 *
 * Ordenados para que el orden de selección en la pantalla no produzca lotes distintos con
 * exactamente el mismo contenido — que sería la misma carrera de dos facturas por un trámite, solo
 * que provocada por dónde hizo clic quien factura.
 */
export function huellaDeTramites(tramiteIds: string[]): string {
  return createHash('sha256').update([...tramiteIds].sort().join('|')).digest('hex');
}

/**
 * La identidad del lote: trámites Y conceptos elegidos (A1, C3).
 *
 * **Por qué no basta con los trámites.** Desde que qué se factura se elige al enviar, el conjunto de
 * trámites dejó de determinar la factura. Dos envíos de los MISMOS trámites con conceptos distintos
 * —trámite digital hoy, logística mañana— producían la misma huella, así que el segundo recuperaba
 * el lote del primero y **no emitía nada**, informando «ya en cola». Sin error y sin rastro: el peor
 * fallo posible en algo que mueve dinero.
 *
 * Los dos conjuntos se ordenan y se separan con un carácter que no aparece en un uuid ni en un
 * nombre de concepto, para que no exista un par (trámites, conceptos) distinto que produzca la
 * misma cadena.
 */
export interface EmisionElegida {
  documentoTipoCodigo: string | null;
  vendedorCodigo: string | null;
  formaPagoCodigo: string | null;
  centroCostoCodigo: string | null;
}

/** Ninguno elegido: se usará la configuración global vigente, como antes de A2. */
export const SIN_EMISION_ELEGIDA: EmisionElegida = {
  documentoTipoCodigo: null, vendedorCodigo: null, formaPagoCodigo: null, centroCostoCodigo: null,
};

/** `true` cuando no se eligió nada. Es lo que decide si la huella degrada a su forma anterior. */
export function emisionVacia(e: EmisionElegida | undefined | null): boolean {
  return !e || (e.documentoTipoCodigo === null && e.vendedorCodigo === null
    && e.formaPagoCodigo === null && e.centroCostoCodigo === null);
}

export function huellaDeLote(
  tramiteIds: string[], conceptos: readonly string[], emision?: EmisionElegida | null,
): string {
  const t = [...new Set(tramiteIds)].sort().join('|');
  const c = [...new Set(conceptos)].sort();

  // A2 — la emisión elegida también identifica al lote, por el mismo motivo que los conceptos:
  // cambia la factura que sale. Y el fallo que evita es el mismo — sin ella, reenviar los mismos
  // trámites con otro vendedor devolvería «ya en cola» y emitiría con el vendedor viejo, en
  // silencio. Con ella, el reenvío produce un lote nuevo y choca contra el índice de D-5 con un
  // error que se lee. Ruidoso y correcto es mejor que silencioso y equivocado.
  if (!emisionVacia(emision)) {
    const e = [
      emision!.documentoTipoCodigo ?? '', emision!.vendedorCodigo ?? '',
      emision!.formaPagoCodigo ?? '', emision!.centroCostoCodigo ?? '',
    ].join('|');
    return createHash('sha256').update(`${t}#${c.join('|')}@${e}`).digest('hex');
  }

  // **Sin conceptos, la huella es EXACTAMENTE la de antes de A1.** No es un caso de borde: los lotes
  // creados antes de esta historia ya tienen su huella guardada y su fila de cola esperando. Si el
  // trabajador recalculara una huella distinta para ellos, `asegurarLote` no los reconocería, crearía
  // un lote NUEVO y reservaría otra clave de idempotencia — es decir, emitiría una SEGUNDA factura
  // ante la DIAN de algo que ya estaba encolado. Un envío nuevo nunca llega aquí con la lista vacía:
  // la ruta exige `min(1)` y `encolar` lanza `sin_conceptos`.
  if (c.length === 0) return createHash('sha256').update(t).digest('hex');

  return createHash('sha256').update(`${t}#${c.join('|')}`).digest('hex');
}

// ── Armado ──────────────────────────────────────────────────────────────────

/** Convierte a número lo que llega como cadena desde `numeric`, sin tragarse un valor sucio. */
function aNumero(valor: string | number, campo: string): number {
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (!Number.isFinite(n)) {
    throw new FacturaNoArmableError(
      'parametro_no_numerico', `El valor de ${campo} no es un número: ${String(valor)}`,
    );
  }
  return n;
}

/**
 * Las líneas de un trámite (AC2, AC3, AC4).
 *
 * Una por cada concepto que APLICA. `conceptosAplicables` ya sostiene la distinción que importa:
 * `null` significa que el concepto no aplica al trámite y `'0.00'` que aplica y vale cero. Un
 * concepto en cero **sí** genera línea; que la contabilidad vea un cero explícito es distinto de
 * que no vea nada.
 */
/**
 * Qué conceptos de ESTE trámite entran en la factura (A1).
 *
 * Intersección de lo APLICABLE —la liquidación tiene valor no nulo— con lo ELEGIDO. Las dos
 * direcciones importan: elegir un concepto que este trámite no liquidó no lo inventa, y no elegir
 * uno que sí liquidó lo deja fuera, que es exactamente lo que pide el negocio —se gestiona el
 * trámite entero y se factura electrónicamente una parte—.
 *
 * Lista vacía de elegidos = lote anterior a A1: todos los aplicables, como se hacía entonces.
 */
export function conceptosFacturados(
  liquidacion: ValoresLiquidacion, elegidos: readonly ConceptoFacturable[],
): ConceptoFacturable[] {
  const aplicables = conceptosAplicables(liquidacion);
  if (elegidos.length === 0) return aplicables;
  const permitidos = new Set(elegidos);
  return aplicables.filter((c) => permitidos.has(c));
}

/**
 * Medio centavo. Por debajo de eso la diferencia es redondeo, no un descuadre.
 *
 * El mismo criterio y el mismo número que `TOLERANCIA_TOTAL` de `facturacion.emision.service.ts`,
 * que compara nuestro total con el que devuelve Siigo. **No es celo excesivo**: lo sellado llega
 * como cadena de `numeric(14,2)` y los `items[].valor` son números JS, así que `85000.1 + 40000.1`
 * vale `125000.20000000001164` mientras que `Number('125000.20')` vale `125000.19999999999709`:
 * se separan en 1.45e-11. Con `!==` esa factura —correcta— se caía con `servicios_no_cuadran`.
 * (Ojo con el ejemplo: `85000.1 + 40000.2` NO sirve para ilustrarlo, porque da bit a bit el mismo
 * double que `Number('125000.30')`. El spec tiene un caso por cada borde de esta constante.)
 */
const TOLERANCIA_SERVICIOS = 0.005;

/**
 * Las líneas de los servicios adicionales de un trámite: **una por item sellado** (HU #12547).
 *
 * Es la única forma de un concepto que trae DESGLOSE: `valor_servicios_adicionales` es la suma, y
 * lo que el cliente reconoce en su factura es «Cambio de placa 85.000 / Duplicado de licencia
 * 40.000», no un renglón agregado que obliga a pedir el detalle por correo. Si mañana otro concepto
 * gana desglose sellado, este es el patrón —no un `if` más sobre un nombre de concepto—.
 *
 * `description` es el NOMBRE DEL SERVICIO tal como se selló, no `nombreProducto` del mapeo: el
 * producto de Siigo es uno solo para todos los servicios (por eso `code` se repite) y usarlo como
 * descripción borraría justo la distinción que estas líneas existen para mostrar. No se recorta:
 * `nombre` es `varchar(120)` y por esta misma ruta ya viaja `nombreProducto` de `varchar(200)`.
 *
 * El cuadre va aquí y no en la elegibilidad porque es el armado el que convierte los items en
 * dinero facturado. Dos datos de la MISMA liquidación que se contradicen no se promedian ni se
 * elige uno: se rechaza la factura. **El caso «valor sellado > 0 con items vacíos» lo atrapa esta
 * misma comparación** (suma 0 contra un valor positivo); un `if` aparte sería un camino que un
 * mutante puede borrar sin poner nada en rojo.
 */
function lineasDeServicios(
  tramite: TramiteFacturable, codigoProducto: string, valorSellado: number,
): LineaFactura[] {
  // `aNumero` PRIMERO, cuadre después. Con un `Number(item.valor)` a secas, un valor sucio da
  // `NaN`, `Math.abs(NaN - v) > 0.005` es **false** —toda comparación con NaN lo es— y la factura
  // saldría con un `price: NaN` sin que nada lanzara. `aNumero` corta antes con
  // `parametro_no_numerico`, que además es el motivo correcto: el problema es el dato del item, no
  // que el desglose no cuadre.
  const lineas = tramite.serviciosAdicionales.map((item) => ({
    code: codigoProducto,
    description: item.nombre,
    quantity: 1,
    price: aNumero(item.valor, `el servicio adicional ${item.nombre} del trámite ${tramite.idFlit}`),
  }));

  const suma = lineas.reduce((acc, l) => acc + l.price, 0);
  if (Math.abs(suma - valorSellado) > TOLERANCIA_SERVICIOS) {
    throw new FacturaNoArmableError(
      'servicios_no_cuadran',
      `El desglose de ${CONCEPTO_FACTURABLE_LABEL.servicio_adicional} no cuadra con el valor `
      + 'sellado de la liquidación.',
      `${tramite.idFlit}: items ${suma.toFixed(2)} vs liquidación ${valorSellado.toFixed(2)} `
      + `(${lineas.length} item(s))`,
    );
  }

  return lineas;
}

function lineasDe(
  tramite: TramiteFacturable, mapeo: MapeoPorConcepto, elegidos: readonly ConceptoFacturable[],
): LineaFactura[] {
  const lineas: LineaFactura[] = [];

  for (const concepto of conceptosFacturados(tramite.liquidacion, elegidos)) {
    const m = mapeo[concepto];

    // C1 — el descarte va PRIMERO, antes de las guardas que lanzan.
    //
    // Estaba al final, y era la diferencia entre «este concepto no va en la factura» y «esta
    // factura no se puede armar»: un trámite con SOAT liquidado del que solo se factura el trámite
    // digital fallaba con `concepto_sin_mapeo` salvo que alguien le diera un producto de Siigo al
    // SOAT — un producto que jamás iba a aparecer en ninguna factura. Lo que no va en la factura no
    // se valida.
    if (m && !m.facturaLineaPropia) continue;

    if (!m) {
      throw new FacturaNoArmableError(
        'concepto_sin_mapeo',
        `El concepto ${CONCEPTO_FACTURABLE_LABEL[concepto]} no está mapeado a un producto de Siigo.`,
        concepto,
      );
    }
    if (!m.codigoProducto) {
      throw new FacturaNoArmableError(
        'concepto_sin_producto',
        `El concepto ${CONCEPTO_FACTURABLE_LABEL[concepto]} no tiene código de producto en Siigo.`,
        concepto,
      );
    }

    const valor = tramite.liquidacion[CONCEPTO_FACTURABLE_COLUMNA_LIQUIDACION[concepto]];
    const price = aNumero(valor as string, `${concepto} del trámite ${tramite.idFlit}`);
    if (price < 0) {
      throw new FacturaNoArmableError(
        'importe_negativo',
        `El concepto ${CONCEPTO_FACTURABLE_LABEL[concepto]} tiene un importe negativo.`,
        `${tramite.idFlit}: ${price}`,
      );
    }

    // HU #12547 — un concepto con DESGLOSE sellado produce una línea por item, no una sola.
    //
    // El criterio, para que el siguiente concepto con desglose no copie a ciegas: aquí se bifurca
    // porque la liquidación selló un detalle (`detalle->'serviciosAdicionales'->'items'`) que el
    // cliente tiene que ver renglón a renglón, y `price` —la suma— pasa a ser lo que se CUADRA
    // contra ese detalle en vez de lo que se factura. Va después del descarte por
    // `facturaLineaPropia` y de las guardas de mapeo y producto a propósito: esas reglas son las
    // mismas para todos los conceptos y duplicarlas aquí sería un segundo sitio donde puedan
    // divergir.
    if (concepto === 'servicio_adicional') {
      lineas.push(...lineasDeServicios(tramite, m.codigoProducto, price));
      continue;
    }

    // A7 — SIN `taxes`. Es campo opcional del contrato, y omitirlo hace que Siigo aplique los del
    // propio producto, que es donde contabilidad los mantiene y de donde `GET /v1/products` los
    // publica con id, tipo y porcentaje. Mandarlos desde aquí obligaba a FLITO a guardar una copia
    // del tratamiento tributario y a que alguien la firmara concepto por concepto —incluidos los
    // que nunca se facturan—, que era el trabajo que esta simplificación borra.
    //
    // Lo que se pierde a cambio: FLITO ya no puede afirmar el IVA de una línea. Si el producto está
    // mal configurado en Siigo Nube, la factura sale mal y de este lado no hay nada que lo detenga.
    lineas.push({
      code: m.codigoProducto,
      description: m.nombreProducto ?? CONCEPTO_FACTURABLE_LABEL[concepto],
      quantity: 1,
      price,
    });
  }

  return lineas;
}

/**
 * Observaciones con trazabilidad (AC7).
 *
 * El identificador FLIT, la placa y el tipo de trámite. Es lo que permite reconciliar una factura
 * con su trámite cuando el `UPDATE` local falló pero el `POST` a Siigo sí llegó — y también lo que
 * lee una persona en Siigo Nube cuando alguien pregunta de qué es esta factura.
 */
function observacionesDe(tramites: TramiteFacturable[]): string {
  const lineas = tramites.map((t) => {
    const partes = [t.idFlit];
    if (t.placa) partes.push(`placa ${t.placa}`);
    if (t.tipoTramite) partes.push(t.tipoTramite);
    return partes.join(' · ');
  });
  return `FLITO · ${lineas.join(' | ')}`.slice(0, 4000);
}

/**
 * Arma la factura de UN grupo de trámites (AC1).
 *
 * Funciona igual con un grupo de uno que con uno de varios: **no hay ningún condicional sobre la
 * cantidad**. Es lo que permitirá habilitar la facturación consolidada añadiendo un agrupador y
 * nada más.
 */
export function armarFactura(entrada: EntradaArmado): FacturaArmada {
  const { tramites, tercero, parametros, fecha } = entrada;
  const mapeo = entrada.mapeo;

  if (tramites.length === 0) {
    throw new FacturaNoArmableError('grupo_vacio', 'No hay trámites que facturar en este grupo.');
  }

  const items = tramites.flatMap((t) => lineasDe(t, mapeo, entrada.conceptos));
  if (items.length === 0) {
    throw new FacturaNoArmableError(
      'sin_lineas', 'Ningún concepto del grupo genera una línea de factura.',
    );
  }

  // AC7 — validación de sanidad AUNQUE los valores vengan de una liquidación sellada. Defensa en
  // profundidad: una liquidación corrupta no puede producir una factura ante la DIAN.
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  if (!(total > 0)) {
    throw new FacturaNoArmableError(
      'total_no_positivo', `El total de la factura no es mayor que cero: ${total}`,
    );
  }

  // AC5 — EXACTAMENTE UNA forma de pago, y sin `due_date`.
  //
  // **Aquí hay un filo conocido, y se ataja antes de llegar.** Si la forma de pago maneja
  // vencimiento, `due_date` pasa de opcional a OBLIGATORIO y la factura se rechaza sin él. FLITO no
  // maneja plazo —decisión del 2026-08-13— y no se compensa inventando una fecha: la factura diría
  // un vencimiento que nadie acordó.
  //
  // Por eso el filtro está en la ELECCIÓN, no aquí: `/v1/payment-types` devuelve `due_date` por
  // forma de pago, así que las que lo manejan ni siquiera se ofrecen (ver `catalogos-vivo.service`).
  // Este armador no puede verificarlo —recibe un código, no el catálogo—, y `invalid_payment` de
  // `siigo.errors.ts` queda como red por si alguien cambia la configuración en Siigo Nube entre la
  // elección y la emisión.
  const pago: FacturaArmada['payments'][number] = {
    id: aNumero(parametros.formaPagoCodigo, 'forma de pago'),
    value: total,
  };

  const factura: FacturaArmada = {
    document: { id: aNumero(parametros.documentoTipoCodigo, 'tipo de comprobante') },
    date: fecha,
    customer: { identification: tercero.identificacion, branch_office: tercero.sucursal },
    seller: aNumero(parametros.vendedorCodigo, 'vendedor'),
    items,
    payments: [pago],
    observations: observacionesDe(tramites),
    _total: total,
  };

  if (parametros.centroCostoCodigo) {
    factura.cost_center = aNumero(parametros.centroCostoCodigo, 'centro de costo');
  }

  // Los dos efectos irreversibles, y los únicos campos del documento que no describen la venta sino
  // lo que Siigo debe HACER con ella. Se añaden solo cuando se piden: el valor por defecto de ambos
  // en Siigo es `false`, así que omitirlos es pedir «solo créala».
  if (parametros.timbrarEnDian) factura.stamp = { send: true };
  if (parametros.enviarCorreoAlCliente) factura.mail = true;

  // AC8 — lo que NO se envía está en la cabecera del archivo, con su respuesta al lado. Ninguna de
  // esas omisiones es ya una duda: `retentions[]` y los impuestos los aplica Siigo desde el tercero
  // y el producto, `currency` es solo para moneda extranjera, `number` no existe en `InvoiceIn` y no
  // hay plazo de vencimiento.
  return factura;
}

// ── Agrupadores (AC1) ───────────────────────────────────────────────────────

/**
 * Cómo se reparten los trámites en facturas.
 *
 * Hoy hay uno solo. Añadir el consolidado por cliente —decisión D-1, diferida— será **un agrupador
 * nuevo**, no un rediseño: el armador ya no distingue un grupo de uno de un grupo de varios.
 */
export type Agrupador = (tramites: TramiteFacturable[]) => TramiteFacturable[][];

/** Un grupo por trámite. La única estrategia admitida hoy. */
export const agrupadorPorTramite: Agrupador = (tramites) => tramites.map((t) => [t]);
