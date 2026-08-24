// Siigo API — modo simulado (HU #11252).
//
// Sin credenciales del ambiente real no se puede construir nada, y esperar a tenerlas dejaría
// paradas las Features 11 a 15. El simulador permite desarrollar y probar el ciclo completo hoy.
//
// Dos reglas que hacen que esto sea útil en vez de un placebo:
//
//   1. El modo se resuelve en UN punto, igual que hace `modules/integraciones/mode.ts`. Si el
//      `if (mock)` se dispersa por el código, cada sitio acaba simulando algo distinto y el
//      simulador deja de parecerse a Siigo.
//   2. Modo real sin credenciales FALLA, no cae al simulador. Un fallback silencioso haría creer
//      que se facturó cuando no salió nada — el peor fallo posible en este dominio.

import { env } from '../../config/env.js';
import type { MetodoHttp } from './siigo.client.js';

export type ModoSiigo = 'mock' | 'real';

export function modoSiigo(): ModoSiigo {
  return env.SIIGO_MODE;
}

export function enModoMock(): boolean {
  return modoSiigo() === 'mock';
}

/** Se lanza cuando el simulador debe fingir que Siigo no responde. */
export class SiigoMockTimeout extends Error {
  constructor() {
    super('Tiempo de espera agotado contra Siigo (simulado)');
    this.name = 'SiigoMockTimeout';
  }
}

export interface RespuestaSimulada {
  status: number;
  ok: boolean;
  datos: unknown;
}

export interface OpcionesSimulacion {
  /** Inyectable para que los tests no dependan del azar. */
  aleatorio?: () => number;
  /**
   * Proporción de respuestas simuladas que fallan / agotan la espera. Para ensayar reintentos.
   *
   * **Las inyecta quien prueba, y por omisión son 0: sin caos** (Bug #11649). Eran
   * `SIIGO_MOCK_ERROR_RATE` y `SIIGO_MOCK_TIMEOUT_RATE`, dos variables de entorno cuyo único
   * cometido era provocar fallos a propósito. Un ajuste que solo sirve dentro de una prueba no es
   * configuración del despliegue: como variable había que acordarse de ponerla a 0 en todas
   * partes, y el día que alguien la dejara puesta el simulador rompería peticiones reales de
   * desarrollo sin que nada en el código lo explicara.
   */
  tasaError?: number;
  tasaTimeout?: number;
  /**
   * Cuerpo de la petición, para las rutas que responden en función de lo enviado (HU #11286: la
   * creación de productos devuelve el `code` y el `name` que recibió).
   *
   * Va aquí y no como tercer parámetro posicional porque ese sitio ya lo ocupan las opciones en las
   * llamadas existentes; cambiarlo habría roto los tests del simulador sin ganar nada.
   */
  cuerpo?: unknown;
  /**
   * Ambiente de la petición. Los productos que el simulador recuerda se particionan por él: pruebas
   * y produccion son empresas distintas en Siigo, y mezclarlas daría por bueno un código que el API
   * real no resolvería.
   */
  ambiente?: string;
  /**
   * Clave de idempotencia de la petición (HU #11326).
   *
   * Llega hasta aquí porque **Siigo la honra de verdad**: repetir la misma clave devuelve el
   * comprobante ya creado en vez de duplicarlo. Un simulador que la ignorara crearía dos facturas
   * ante un reintento y daría por bueno justo el escenario que toda la historia existe para impedir
   * — sería más permisivo que el ambiente real, que es la peor clase de simulador.
   */
  idempotencyKey?: string;
}

/** Token simulado. Se distingue a simple vista de uno real para que nadie lo confunda en un log. */
export const TOKEN_SIMULADO = 'mock-access-token-siigo';

/**
 * Error con la MISMA estructura que devuelve Siigo. Que sea idéntica es el punto: permite ejercer de
 * verdad el traductor de errores y la política de reintentos sin tocar la red.
 */
function errorSimulado(): RespuestaSimulada {
  return {
    status: 429,
    ok: false,
    datos: {
      Status: 429,
      Errors: [{
        Code: 'requests_limit',
        Message: 'Too many requests (simulado)',
        Params: [],
        Detail: 'Respuesta generada por el modo simulado de FLITO.',
      }],
    },
  };
}

/** Consecutivo estable dentro del proceso: dos facturas simuladas no comparten número. */
let consecutivo = 0;

/**
 * Facturas que el simulador recuerda (HU #11326), por identificador y por clave de idempotencia.
 *
 * Hasta esta HU el simulador devolvía una factura FIJA que ignoraba el cuerpo: mismo total cero,
 * mismo cliente, sin observaciones y sin memoria. Con eso no se podía ensayar nada de lo que esta
 * historia decide — ni que un reintento con la misma clave no duplica, ni que el descuadre de total
 * se marca, ni que la reconciliación encuentra por las observaciones lo que se emitió.
 */
const facturasSimuladas = new Map<string, Record<string, unknown>>();
const facturasPorClave = new Map<string, string>();

/** Tope efectivo del tamaño de página, como el ejemplo documentado de Siigo. Ver el listado. */
export const PAGE_SIZE_MAX_SIMULADO = 25;

export function reiniciarConsecutivoSimulado(): void {
  consecutivo = 0;
  facturasSimuladas.clear();
  facturasPorClave.clear();
}

/** Error de datos con la forma exacta de Siigo, para poder ejercer el traductor de verdad. */
function faltaCampo(campo: string): RespuestaSimulada {
  return {
    status: 400,
    ok: false,
    datos: {
      Status: 400,
      Errors: [{
        Code: 'parameter_required',
        Message: `The field ${campo} is required.`,
        Params: [campo],
        Detail: 'Respuesta generada por el modo simulado de FLITO.',
      }],
    },
  };
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Crea —o devuelve— una factura simulada.
 *
 * **Exige lo que Siigo exige.** Un simulador más permisivo que el ambiente real hace pasar en
 * desarrollo justo el caso que revienta en producción, que es el único que interesa ensayar. Los
 * obligatorios son los documentados en `docs/integraciones/siigo-api.md` §3.
 *
 * **Y honra la clave de idempotencia**, que es la razón de ser de esta HU: repetir la misma clave
 * devuelve el comprobante ya creado, con un 200 en vez de un 201, tal como hace Siigo. Sin esto, el
 * ensayo del reintento crearía dos facturas y diría que todo está bien.
 */
function crearFacturaSimulada(cuerpo: unknown, idempotencyKey?: string): RespuestaSimulada {
  if (idempotencyKey) {
    const yaCreada = facturasPorClave.get(idempotencyKey);
    if (yaCreada) {
      return { status: 200, ok: true, datos: facturasSimuladas.get(yaCreada)! };
    }
  }

  if (!esObjeto(cuerpo)) return faltaCampo('document');

  const documento = esObjeto(cuerpo.document) ? cuerpo.document : null;
  if (!documento || typeof documento.id !== 'number') return faltaCampo('document.id');
  if (typeof cuerpo.date !== 'string' || !cuerpo.date) return faltaCampo('date');

  const cliente = esObjeto(cuerpo.customer) ? cuerpo.customer : null;
  if (!cliente || typeof cliente.identification !== 'string' || !cliente.identification) {
    return faltaCampo('customer.identification');
  }
  if (typeof cuerpo.seller !== 'number') return faltaCampo('seller');

  const items = Array.isArray(cuerpo.items) ? cuerpo.items : [];
  if (items.length === 0) return faltaCampo('items');
  for (const it of items) {
    if (!esObjeto(it) || typeof it.code !== 'string' || !it.code) return faltaCampo('items.code');
    if (typeof it.quantity !== 'number') return faltaCampo('items.quantity');
    if (typeof it.price !== 'number') return faltaCampo('items.price');
  }

  const pagos = Array.isArray(cuerpo.payments) ? cuerpo.payments : [];
  if (pagos.length === 0) return faltaCampo('payments');

  consecutivo += 1;
  const id = `mock-invoice-${consecutivo}`;
  // El total lo CALCULA, no lo copia del pago: es lo que permite que un descuadre entre lo que FLITO
  // esperaba y lo que Siigo liquida se pueda ensayar (AC6). Devolver el valor enviado haría que
  // cuadrara siempre y el camino de revisión no se probaría nunca.
  const total = items.reduce((s: number, it: unknown) => {
    const i = it as { price: number; quantity: number };
    return s + i.price * i.quantity;
  }, 0);

  const factura: Record<string, unknown> = {
    id,
    document: { id: documento.id },
    number: consecutivo,
    name: `FV-1-${consecutivo}`,
    date: cuerpo.date,
    customer: {
      identification: cliente.identification,
      branch_office: typeof cliente.branch_office === 'number' ? cliente.branch_office : 0,
    },
    total,
    balance: total,
    seller: cuerpo.seller,
    // Recién creada, la DIAN todavía no se ha pronunciado: `Audit` y sin CUFE. Devolver un CUFE aquí
    // haría parecer aceptada una factura que todavía está en validación.
    stamp: { send: cuerpo.stamp === undefined ? false : true, status: 'Audit' },
    mail: { send: cuerpo.mail === true },
    observations: typeof cuerpo.observations === 'string' ? cuerpo.observations : '',
    items,
    payments: pagos,
    public_url: `https://documentview.siigo.com/document?data=${id}`,
    metadata: { created: `${cuerpo.date}T00:00:00.000Z`, last_updated: null },
  };

  facturasSimuladas.set(id, factura);
  if (idempotencyKey) facturasPorClave.set(idempotencyKey, id);
  return { status: 201, ok: true, datos: factura };
}

/**
 * Listado de facturas con los filtros que Siigo documenta (HU #11326).
 *
 * Es lo que usa la reconciliación para averiguar si la factura llegó a existir, así que un listado
 * que siempre responde vacío —lo que hacía el simulador— convertía «no se pudo comprobar» en «no
 * existe» sin que nada avisara. Ese es exactamente el camino que acaba emitiendo la segunda factura.
 *
 * Pagina de verdad porque el tope de páginas de la búsqueda es una salida no concluyente, y sin
 * paginación real esa rama no se podría ensayar.
 */
function listarFacturasSimuladas(query: URLSearchParams): RespuestaSimulada {
  const identificacion = query.get('customer_identification');
  const sucursal = query.get('customer_branch_office');
  const pagina = Math.max(1, Number(query.get('page') ?? '1') || 1);
  // El tamaño de página lo decide el SERVIDOR, no quien pregunta. La documentación de Siigo muestra
  // el listado respondiendo `page_size: 25` con `total_results: 253`, y no declara máximo. Este
  // simulador topa en 25 a propósito: devolver siempre lo pedido hacía imposible ensayar el caso en
  // que llegan menos de los que caben — que es justo donde un recorrido ingenuo se declara completo
  // habiendo visto una fracción del listado, y concluye que una factura no existe.
  const tam = Math.min(Math.max(1, Number(query.get('page_size') ?? '25') || 25), PAGE_SIZE_MAX_SIMULADO);

  let todas = [...facturasSimuladas.values()];
  if (identificacion) {
    todas = todas.filter((f) => {
      const c = f.customer as { identification?: unknown } | undefined;
      return c?.identification === identificacion;
    });
  }
  if (sucursal !== null) {
    todas = todas.filter((f) => {
      const c = f.customer as { branch_office?: unknown } | undefined;
      return String(c?.branch_office ?? 0) === sucursal;
    });
  }

  const inicio = (pagina - 1) * tam;
  return {
    status: 200,
    ok: true,
    datos: {
      pagination: { page: pagina, page_size: tam, total_results: todas.length },
      results: todas.slice(inicio, inicio + tam),
      _links: {},
    },
  };
}

// ── Catálogos simulados (HU #11281) ─────────────────────────────────────────
//
// Hasta esta HU el simulador respondía `[]` a los seis catálogos. Una lista vacía no es un
// simulador: es un endpoint que nunca falla y nunca sirve. Con ella no se puede elegir un tipo de
// comprobante, ni mapear un impuesto, ni probar que la parametrización rechaza un elemento inactivo.
//
// Estas fixtures replican campo por campo las estructuras del blueprint de Siigo (`Document`,
// `User`, `PaymentTypes`, `Tax`, `AccountGroup`, `CostCenter`) y están elegidas para que la
// parametrización completa se pueda configurar y validar sin ambiente real:
//
//   · cada catálogo trae al menos un elemento INACTIVO, para ejercer el filtrado y el marcado;
//   · las formas de pago traen una de contado y una a crédito con `due_date: true`, que es la que
//     dispara la trampa documentada de «una sola forma de pago si maneja vencimiento»;
//   · los impuestos traen IVA de dos tarifas más retenciones, que es lo que se mapea de verdad;
//   · los tipos de comprobante traen uno electrónico y uno que exige centro de costo.
//
// Los datos son ficticios a propósito: ningún nombre, correo ni cédula de una persona real.

/** Tipos de comprobante de venta (`GET /v1/document-types?type=FV`). */
const DOCUMENT_TYPES_SIMULADOS = [
  {
    id: 24446, code: '1', name: 'Factura de venta', description: 'Factura de venta electrónica',
    type: 'FV', active: true, seller_by_item: false, cost_center: true,
    cost_center_mandatory: false, automatic_number: true, consecutive: 3,
    discount_type: 'Percentage', decimals: true, advance_payment: false,
    reteiva: true, reteica: true, self_withholding: false, self_withholding_limit: 0,
    electronic_type: 'ElectronicInvoice',
  },
  {
    id: 24447, code: '2', name: 'Factura de venta con centro de costo',
    description: 'Factura de venta electrónica — centro de costo obligatorio',
    type: 'FV', active: true, seller_by_item: false, cost_center: true,
    cost_center_mandatory: true, automatic_number: true, consecutive: 118,
    discount_type: 'Value', decimals: true, advance_payment: true,
    reteiva: true, reteica: true, self_withholding: true, self_withholding_limit: 1000000,
    electronic_type: 'ElectronicInvoice',
  },
  {
    id: 24448, code: '3', name: 'Factura de venta (numeración cerrada)',
    description: 'Resolución vencida — no debe poderse parametrizar',
    type: 'FV', active: false, seller_by_item: false, cost_center: false,
    cost_center_mandatory: false, automatic_number: false, consecutive: 0,
    discount_type: 'Percentage', decimals: false, advance_payment: false,
    reteiva: false, reteica: false, self_withholding: false, self_withholding_limit: 0,
    electronic_type: 'NoElectronicInvoice',
  },
];

/** Vendedores (`GET /v1/users`). Datos ficticios: no hay personas reales en el simulador. */
const USERS_SIMULADOS = [
  {
    id: 35071, username: 'ventas1@ejemplo.test', first_name: 'Ana', last_name: 'Ramírez',
    email: 'ventas1@ejemplo.test', active: true, identification: '1000000001',
  },
  {
    id: 35072, username: 'ventas2@ejemplo.test', first_name: 'Carlos', last_name: 'Beltrán',
    email: 'ventas2@ejemplo.test', active: true, identification: '1000000002',
  },
  {
    id: 35073, username: 'retirado@ejemplo.test', first_name: 'Diana', last_name: 'Osorio',
    email: 'retirado@ejemplo.test', active: false, identification: '1000000003',
  },
];

/** Formas de pago (`GET /v1/payment-types?document_type=FV`). */
const PAYMENT_TYPES_SIMULADOS = [
  { id: 5636, name: 'Contado', type: 'Cartera', active: true, due_date: false },
  { id: 5637, name: 'Crédito 30 días', type: 'Cartera', active: true, due_date: true },
  { id: 5638, name: 'Transferencia bancaria', type: 'Cartera', active: true, due_date: false },
  { id: 5639, name: 'Consignación (descontinuada)', type: 'Cartera', active: false, due_date: false },
];

/** Impuestos y retenciones (`GET /v1/taxes`). */
const TAXES_SIMULADOS = [
  { id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19.00, active: true },
  { id: 13157, name: 'IVA 5%', type: 'IVA', percentage: 5.00, active: true },
  { id: 13158, name: 'ReteFuente servicios 4%', type: 'Retefuente', percentage: 4.00, active: true },
  { id: 13159, name: 'ReteICA 0.966%', type: 'ReteICA', percentage: 0.966, active: true },
  { id: 13160, name: 'IVA 16% (derogado)', type: 'IVA', percentage: 16.00, active: false },
  // IVA 0 %: es el impuesto que Siigo asocia a los productos EXENTOS —el reintegro de costos y el
  // servicio de FLIT lo llevan en la cuenta real—, y sin él en el catálogo un producto simulado
  // exento apuntaría a un id que la validación del mapeo daría por desconocido.
  { id: 13161, name: 'IVA 0%', type: 'IVA', percentage: 0.00, active: true },
];

/** Grupos de inventario / clasificaciones (`GET /v1/account-groups`). */
const ACCOUNT_GROUPS_SIMULADOS = [
  { id: 1253, name: 'Servicios de trámites', active: true },
  { id: 1254, name: 'Derechos de tránsito', active: true },
  { id: 1255, name: 'Productos', active: true },
  { id: 1256, name: 'Clasificación en desuso', active: false },
];

/** Centros de costo (`GET /v1/cost-centers`). */
const COST_CENTERS_SIMULADOS = [
  { id: 25732, code: '13-1', name: 'Principal', active: true },
  { id: 25733, code: '13-2', name: 'Sede Bogotá', active: true },
  { id: 25734, code: '13-3', name: 'Sede Medellín', active: true },
  { id: 25735, code: '13-9', name: 'Sede cerrada', active: false },
];

/**
 * Catálogos simulados por ruta base. Exportado para que los tests puedan afirmar sobre los mismos
 * datos que sirve el simulador, en vez de duplicarlos y quedar desincronizados.
 */
export const CATALOGOS_SIMULADOS: Record<string, unknown[]> = {
  'document-types': DOCUMENT_TYPES_SIMULADOS,
  users: USERS_SIMULADOS,
  'payment-types': PAYMENT_TYPES_SIMULADOS,
  taxes: TAXES_SIMULADOS,
  'account-groups': ACCOUNT_GROUPS_SIMULADOS,
  'cost-centers': COST_CENTERS_SIMULADOS,
};

// ── Productos simulados (HU #11283) ─────────────────────────────────────────
//
// Hasta esta HU el simulador respondía un listado vacío a `/v1/products`, con lo que TODO código
// resultaba inexistente y la validación no se podía ejercer: no había forma de probar el caso feliz
// ni de distinguirlo del inactivo.
//
// El AC5 exige que el simulador conozca los tres casos —existente y activo, existente e inactivo, e
// inexistente— porque son las tres ramas de la validación. El tercero no necesita fixture: es
// cualquier código que no esté en esta lista.
//
// Los códigos siguen la forma que admite Siigo (alfanumérico con `.`, `_` y `-`, hasta 30) y cubren
// los seis conceptos facturables, para que la parametrización completa se pueda configurar y
// validar en modo simulado de punta a punta.
//
// **La FORMA es la de la respuesta real, contrastada contra la cuenta de FLIT.** Antes estas
// fixtures tenían una forma inventada —`unit: '94'` en vez de `{ code, name }`, `account_group`
// como número, sin `type` ni `tax_classification`, y `taxes: []` en todos— y las pruebas del
// módulo afirmaban sobre ella. Un simulador más permisivo que el ambiente real deja pasar en
// desarrollo justo lo que revienta en producción: es la lección que este proyecto ya pagó en la
// HU #11297 con los terceros, aquí aplicada al catálogo de productos, con el modo real a días de
// encenderse.
//
// Lo que la respuesta real enseña y estas fixtures reproducen:
//
//   · `unit` es un OBJETO `{ code, name }`, y hay productos que no traen la clave.
//   · `account_group` es un OBJETO `{ id, name }`, no el id suelto.
//   · en los productos `Excluded` la clave `taxes` NO EXISTE — no es un arreglo vacío. Quien los
//     recorra tiene que sobrevivir a su ausencia, y ahora hay con qué probarlo.
//   · `tax_included` puede venir en `true`, forma que el simulador nunca producía.

/** Nombre de la unidad de medida por su código UNECE. Solo las que el simulador usa. */
const UNIDADES_SIMULADAS: Record<string, string> = { '94': 'unidad' };

/** `unit` con la forma real: objeto, no cadena. */
function unidadSimulada(codigo: string): { code: string; name: string } {
  return { code: codigo, name: UNIDADES_SIMULADAS[codigo] ?? 'unidad' };
}

/**
 * `account_group` con la forma real: objeto con el nombre del grupo, no el id suelto.
 *
 * El nombre sale del mismo catálogo que sirve `/v1/account-groups`, y no de una constante aparte,
 * para que un producto simulado no pueda apuntar a un grupo que el catálogo simulado desconoce.
 */
function grupoSimulado(id: number): { id: number; name: string } {
  const g = ACCOUNT_GROUPS_SIMULADOS.find((x) => x.id === id);
  return { id, name: g?.name ?? 'Grupo simulado' };
}

/**
 * Impuesto de un producto con la forma real: `{ id, name, type, percentage }` — sin `active`, que
 * es del catálogo y no de la línea del producto.
 *
 * Se resuelve contra `TAXES_SIMULADOS` a propósito: si el impuesto de un producto simulado no
 * estuviera en el catálogo simulado, quien parametrizara en modo simulado copiando ese id se
 * encontraría un `impuesto_desconocido` que el ambiente real no daría.
 */
function impuestoSimulado(id: number): { id: number; name: string; type: string; percentage: number } {
  const t = TAXES_SIMULADOS.find((x) => x.id === id);
  // Un id que el catálogo no conoce se devuelve tal cual: Siigo lo rechazaría al crear, y fingir
  // aquí un nombre inventado escondería ese rechazo.
  return t
    ? { id: t.id, name: t.name, type: t.type, percentage: t.percentage }
    : { id, name: '', type: '', percentage: 0 };
}

/**
 * Un producto tal como lo devuelve `GET /v1/products`.
 *
 * Los campos opcionales NO son laxitud del tipo: son la variabilidad REAL de la respuesta. En la
 * cuenta de FLIT hay productos sin `taxes` (los `Excluded`), sin `unit` ni `unit_label`, y con
 * `prices` que otros no traen. Declararlos obligatorios obligaría a rellenarlos, y el simulador
 * volvería a ser más uniforme —y por tanto más permisivo— que el ambiente que simula.
 */
export interface ProductoSimuladoApi {
  id: string;
  code: string;
  name: string;
  account_group: { id: number; name: string };
  type: 'Product' | 'Service';
  stock_control: boolean;
  active: boolean;
  tax_classification: 'Taxed' | 'Exempt' | 'Excluded';
  tax_included: boolean;
  tax_consumption_value?: number;
  /** Ausente en los `Excluded`. La clave NO existe; no es un arreglo vacío. */
  taxes?: Array<{ id: number; name: string; type: string; percentage: number }>;
  unit?: { code: string; name: string };
  unit_label?: string;
  reference?: string;
  description?: string;
  prices?: Array<{
    currency_code: string;
    price_list: Array<{ position: number; name: string; value: number }>;
  }>;
  additional_fields: Record<string, string>;
  available_quantity: number;
  warehouses: Array<{ id: number; name: string; quantity: number }>;
  metadata: { created: string; last_updated?: string };
}

/** Productos (`GET /v1/products?code=`). Uno por concepto facturable, más un caso inactivo. */
const PRODUCTS_SIMULADOS: ProductoSimuladoApi[] = [
  // Los tres primeros son `Excluded` y por eso NO llevan `taxes`: es la forma que devuelve Siigo
  // para el SOAT, los trámites y los impuestos, y la que hay que poder recorrer sin romperse.
  {
    id: 'mock-prod-soat', code: 'SOAT-2024', name: 'SOAT — Seguro Obligatorio',
    account_group: grupoSimulado(1254), type: 'Product', stock_control: true, active: true,
    tax_classification: 'Excluded', tax_included: false, tax_consumption_value: 0,
    unit: unidadSimulada('94'), unit_label: 'unidad', reference: '', description: '',
    additional_fields: { barcode: '', brand: '', tariff: '', model: '' },
    available_quantity: -1, warehouses: [{ id: -1, name: 'Sin asignar', quantity: -1 }],
    metadata: { created: '2026-03-06T10:41:10.637Z' },
  },
  {
    id: 'mock-prod-imp', code: 'IMP-VEHICULAR', name: 'Impuesto vehicular',
    account_group: grupoSimulado(1254), type: 'Product', stock_control: true, active: true,
    tax_classification: 'Excluded', tax_included: false, tax_consumption_value: 0,
    unit: unidadSimulada('94'), unit_label: 'unidad', reference: '', description: '',
    additional_fields: { barcode: '', brand: '', tariff: '', model: '' },
    available_quantity: -1, warehouses: [{ id: -1, name: 'Sin asignar', quantity: -1 }],
    metadata: { created: '2026-03-06T10:42:28.263Z' },
  },
  {
    id: 'mock-prod-der', code: 'DER-TRANSITO', name: 'Derecho de tránsito',
    account_group: grupoSimulado(1254), type: 'Product', stock_control: true, active: true,
    tax_classification: 'Excluded', tax_included: false, tax_consumption_value: 0,
    unit: unidadSimulada('94'), unit_label: 'unidad', reference: '', description: '',
    additional_fields: { barcode: '', brand: '', tariff: '', model: '' },
    available_quantity: -1, warehouses: [{ id: -1, name: 'Sin asignar', quantity: -1 }],
    metadata: { created: '2026-03-06T10:41:55.073Z', last_updated: '2026-03-10T16:47:54.620Z' },
  },
  {
    id: 'mock-prod-tram', code: 'TRAMITE-DIGITAL', name: 'Trámite digital',
    account_group: grupoSimulado(1253), type: 'Service', stock_control: false, active: true,
    tax_classification: 'Taxed', tax_included: false, taxes: [impuestoSimulado(13156)],
    unit: unidadSimulada('94'), unit_label: 'unidad', reference: '', description: '',
    additional_fields: { barcode: '', brand: '', tariff: '', model: '' },
    available_quantity: -1, warehouses: [{ id: -1, name: 'Sin asignar', quantity: -1 }],
    metadata: { created: '2025-12-09T16:53:49.247Z', last_updated: '2025-12-10T16:47:54.620Z' },
  },
  {
    id: 'mock-prod-log', code: 'LOGISTICA', name: 'Servicio de logística',
    account_group: grupoSimulado(1253), type: 'Service', stock_control: false, active: true,
    tax_classification: 'Taxed', tax_included: false, taxes: [impuestoSimulado(13156)],
    unit: unidadSimulada('94'), unit_label: '', reference: '',
    additional_fields: { barcode: '' },
    available_quantity: -27, warehouses: [{ id: -1, name: 'Sin asignar', quantity: -27 }],
    metadata: { created: '2024-12-11T10:53:39.670Z' },
  },
  // El reintegro de costos: exento con IVA 0 % y `tax_included: true`. La combinación existe en la
  // cuenta real («002 Servicio FLIT») y es hoy inocua —el 0 % no mueve el total—, pero es una forma
  // que el simulador nunca producía y con la que nadie había probado nada. Tampoco trae `unit`:
  // otra ausencia real que el código de arriba tiene que aguantar.
  {
    id: 'mock-prod-gmf', code: 'GMF-4X1000', name: 'Gravamen a los movimientos financieros',
    account_group: grupoSimulado(1253), type: 'Service', stock_control: false, active: true,
    tax_classification: 'Exempt', tax_included: true, tax_consumption_value: 0,
    taxes: [impuestoSimulado(13161)],
    prices: [{
      currency_code: 'COP',
      price_list: [{ position: 1, name: 'Precio de venta 1', value: 4000 }],
    }],
    additional_fields: {},
    available_quantity: -1, warehouses: [{ id: -1, name: 'Sin asignar', quantity: -1 }],
    metadata: { created: '2024-01-22T14:11:36.927Z', last_updated: '2024-08-21T21:56:38.007Z' },
  },
  {
    id: 'mock-prod-off', code: 'PRODUCTO-INACTIVO', name: 'Producto descontinuado',
    account_group: grupoSimulado(1255), type: 'Product', stock_control: true, active: false,
    tax_classification: 'Excluded', tax_included: false,
    additional_fields: {},
    available_quantity: 1, warehouses: [{ id: -1, name: 'Sin asignar', quantity: 1 }],
    metadata: { created: '2020-08-27T20:30:32.627Z', last_updated: '2024-08-21T21:54:03.487Z' },
  },
];

/** Exportado para que los tests afirmen sobre los mismos datos que sirve el simulador. */
export const PRODUCTOS_SIMULADOS: readonly ProductoSimuladoApi[] = PRODUCTS_SIMULADOS;

/**
 * Productos creados durante la vida del proceso (HU #11286).
 *
 * Separados de las fixtures y MUTABLES a propósito. El AC7 pide que el flujo de vinculación se
 * pueda probar de extremo a extremo sin ambiente real, y ese flujo es: crear → el mapeo se
 * actualiza → la actualización REVALIDA el código contra Siigo. Si lo recién creado no apareciera
 * en la siguiente consulta, la vinculación fallaría con «no existe» y el simulador no serviría para
 * ensayar justo lo que la historia pide ensayar.
 *
 * El `ambiente` va FUERA del producto: es del simulador, no de Siigo. Cuando estaba dentro, lo
 * creado salía en el listado con una forma propia —`{ ambiente, id, code, name, active }`— distinta
 * de la de las fixtures y con una clave que el API real no devuelve nunca.
 */
const productosCreadosEnSimulacion: Array<{
  ambiente: string; producto: ProductoSimuladoApi;
}> = [];

/**
 * Lo que ve una consulta: las fixtures más lo creado en ESTE ambiente, con la misma forma.
 *
 * Ordenado por fecha de creación, más recientes primero, que es como Siigo devuelve el listado.
 * Antes salían en el orden en que estaban escritas aquí, y con eso el orden alfabético que aplica
 * `listarProductos` parecía innecesario: en modo simulado la lista ya venía «bien».
 */
function catalogoSimuladoDe(ambiente: string): ProductoSimuladoApi[] {
  return [
    ...PRODUCTS_SIMULADOS,
    ...productosCreadosEnSimulacion.filter((p) => p.ambiente === ambiente).map((p) => p.producto),
  ].sort((a, b) => b.metadata.created.localeCompare(a.metadata.created));
}

/**
 * Tope de productos recordados. El simulador es una ayuda de desarrollo, no un almacén: sin cota,
 * un proceso largo acumularía sin límite. Al llegar al tope se desaloja el más antiguo.
 */
const MAX_PRODUCTOS_SIMULADOS = 200;

/**
 * Consecutivo PROPIO de los productos simulados.
 *
 * Separado del de facturas a propósito: compartirlo hacía que crear productos desplazara los
 * números de las facturas simuladas, y que reiniciar uno dejara el otro descuadrado.
 */
let consecutivoProducto = 0;

/** Solo para tests y para el arranque, igual que `reiniciarConsecutivoSimulado`. */
export function reiniciarProductosSimulados(): void {
  productosCreadosEnSimulacion.length = 0;
  consecutivoProducto = 0;
}

/**
 * Aplica los filtros de consulta que Siigo sí honra en los catálogos.
 *
 * Solo `document-types?type=` filtra de verdad en Siigo. `payment-types?document_type=` acota por
 * comprobante, pero el simulador no modela formas de pago exclusivas de otro documento, así que
 * devuelve la lista completa en vez de fingir un filtro que no distingue nada.
 */
function filtrarCatalogoSimulado(recurso: string, query: URLSearchParams, elementos: unknown[]): unknown[] {
  if (recurso !== 'document-types') return elementos;
  const tipo = query.get('type');
  if (!tipo) return elementos;
  return elementos.filter((e) => (e as { type?: string }).type === tipo);
}

/**
 * Respuesta simulada para una petición. Las formas replican las documentadas en
 * `docs/integraciones/siigo-api.md`, de modo que quien las consume no necesita saber en qué modo
 * está corriendo.
 */
/**
 * Terceros que el simulador recuerda, por identificador. Se comparte entre llamadas para poder
 * ensayar consultar → crear → volver a consultar, que es el ciclo del AC7.
 */
const tercerosSimulados = new Map<string, Record<string, unknown>>();
let consecutivoTercero = 0;

/** Vacía la memoria del simulador. Solo para tests: sin esto se filtran entre casos. */
export function olvidarTercerosSimulados(): void {
  tercerosSimulados.clear();
  consecutivoTercero = 0;
}

export function respuestaSimulada(
  metodo: MetodoHttp, ruta: string, opciones: OpcionesSimulacion = {},
): RespuestaSimulada {
  // Ambiente al que pertenece la simulación: los productos recordados se particionan por él.
  const ambiente = opciones.ambiente ?? env.SIIGO_AMBIENTE;
  const aleatorio = opciones.aleatorio ?? Math.random;
  // Por omisión, cero caos: el simulador solo falla si quien prueba se lo pide (Bug #11649).
  const tasaTimeout = opciones.tasaTimeout ?? 0;
  const tasaError = opciones.tasaError ?? 0;

  if (tasaTimeout > 0 && aleatorio() < tasaTimeout) throw new SiigoMockTimeout();
  if (tasaError > 0 && aleatorio() < tasaError) return errorSimulado();

  // Creación de factura de venta (HU #11326).
  if (metodo === 'POST' && /^\/v1\/invoices\/?$/.test(ruta)) {
    return crearFacturaSimulada(opciones.cuerpo, opciones.idempotencyKey);
  }

  // Envío por correo de una factura (HU #11334). Va también ANTES del listado genérico.
  //
  // El simulador RECHAZA lo que el ambiente real rechaza —más de cinco direcciones, o una lista
  // vacía—, porque un simulador más permisivo que Siigo es peor que no tenerlo: haría pasar en
  // desarrollo justo el caso que revienta en producción, que es el único que interesa ensayar.
  const correo = /^\/v1\/invoices\/([^/]+)\/mail\/?$/.exec(ruta);
  if (metodo === 'POST' && correo) {
    const enviadoAlCorreo = (opciones.cuerpo ?? {}) as { mail_to?: unknown };
    const destinos = Array.isArray(enviadoAlCorreo.mail_to) ? enviadoAlCorreo.mail_to : [];
    if (destinos.length === 0 || destinos.length > 5) {
      return {
        status: 400,
        ok: false,
        datos: {
          Errors: [{
            Code: 'invalid_mail_to',
            Message: 'mail_to debe tener entre 1 y 5 direcciones.',
            Params: [String(destinos.length)],
          }],
        },
      };
    }
    return {
      status: 200,
      ok: true,
      datos: { id: correo[1], mail: { send: true, to: destinos } },
    };
  }

  // PDF y XML de una factura (HU #11335). Va ANTES del listado genérico de `/v1/invoices`, que si
  // no se traga estas dos rutas y responde `results: []` — una respuesta sin documento con la que el
  // archivo no se puede ensayar, ni en su caso feliz ni en el de contenido ilegible.
  //
  // La forma es la documentada: JSON con el archivo en base64. Los contenidos son mínimos pero
  // AUTÉNTICOS —el PDF empieza por `%PDF` y el XML por `<?xml`— porque el servicio comprueba esa
  // firma antes de archivar, y un simulador que devolviera texto cualquiera daría por buena una
  // respuesta que el ambiente real haría fallar.
  const documento = /^\/v1\/invoices\/([^/]+)\/(pdf|xml)\/?$/.exec(ruta);
  if (metodo === 'GET' && documento) {
    const id = decodeURIComponent(documento[1]!);
    const contenido = documento[2] === 'pdf'
      ? `%PDF-1.4\n% factura simulada ${id}\n%%EOF\n`
      : `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice><ID>${id}</ID></Invoice>\n`;
    return {
      status: 200,
      ok: true,
      datos: { id, base64: Buffer.from(contenido, 'utf8').toString('base64') },
    };
  }

  // Terceros (HU #11297). Antes había aquí una creación que devolvía SIEMPRE el mismo tercero fijo:
  // servía para comprobar que la petición salía, y no para nada más. Con ella, asegurar dos veces el
  // mismo cliente «creaba» dos veces sin quejarse, que es justo el error que en producción deja dos
  // terceros —o un rechazo— y una factura contra el equivocado.
  //
  // Ahora el simulador RECUERDA y aplica las reglas de Siigo: la clave es (identificación,
  // sucursal), repetirla en la misma sucursal se rechaza, y el `PUT` REEMPLAZA en vez de fusionar.
  // Un simulador más permisivo que el ambiente real es peor que no tenerlo.
  const unTercero = /^\/v1\/customers\/([^/?]+)\/?$/.exec(ruta);

  if (metodo === 'GET' && /^\/v1\/customers\/?(\?|$)/.test(ruta)) {
    const q = new URLSearchParams(ruta.includes('?') ? ruta.slice(ruta.indexOf('?') + 1) : '');
    const identificacion = (q.get('identification') ?? '').trim();
    const sucursal = Number(q.get('branch_office') ?? 0);
    const encontrados = [...tercerosSimulados.values()].filter((t) =>
      String(t.identification ?? '').trim() === identificacion
      && Number(t.branch_office ?? 0) === sucursal);
    return {
      status: 200,
      ok: true,
      datos: {
        pagination: { page: 1, page_size: 25, total_results: encontrados.length },
        results: encontrados,
        _links: {},
      },
    };
  }

  if (metodo === 'GET' && unTercero) {
    const t = tercerosSimulados.get(unTercero[1]);
    return t
      ? { status: 200, ok: true, datos: t }
      : { status: 404, ok: false, datos: { Errors: [{ Code: 'not_found', Message: 'Customer not found' }] } };
  }

  if (metodo === 'POST' && /^\/v1\/customers\/?$/.test(ruta)) {
    const enviado = (opciones.cuerpo ?? {}) as Record<string, unknown>;
    const identificacion = String(enviado.identification ?? '').trim();
    const sucursal = Number(enviado.branch_office ?? 0);

    // Obligatorios según §2 de la documentación. El simulador los EXIGE porque Siigo los exige: si
    // aceptara una creación sin identificación ni nombre, un código que se olvide de armarlos
    // pasaría aquí y fallaría en el ambiente real, que es el único sitio donde molesta.
    if (identificacion === '' || !Array.isArray(enviado.name) || enviado.name.length === 0) {
      return {
        status: 400,
        ok: false,
        datos: {
          Errors: [{
            Code: 'invalid_customer',
            Message: 'identification and name are required.',
            Params: ['identification', 'name'],
          }],
        },
      };
    }

    const yaEsta = [...tercerosSimulados.values()].some((t) =>
      String(t.identification ?? '').trim() === identificacion
      && Number(t.branch_office ?? 0) === sucursal);
    if (yaEsta) {
      return {
        status: 400,
        ok: false,
        datos: {
          Errors: [{
            Code: 'duplicated_identification',
            Message: 'Identification already exists for this branch office.',
            Params: ['identification'],
          }],
        },
      };
    }
    consecutivoTercero += 1;
    const creado: Record<string, unknown> = {
      type: 'Customer',
      active: true,
      ...enviado,
      id: `mock-customer-${consecutivoTercero}`,
      // Campos que Siigo guarda y FLITO NO modela. Están aquí a propósito: son exactamente los que
      // un `PUT` construido solo con lo nuestro borraría, y el test lo comprueba.
      related_users: { seller_id: 629, collector_id: 629 },
      comments: 'Cliente heredado del maestro de contabilidad.',
      metadata: { created: '2026-08-04T00:00:00.000Z', last_updated: null },
    };
    tercerosSimulados.set(String(creado.id), creado);
    return { status: 201, ok: true, datos: creado };
  }

  if (metodo === 'PUT' && unTercero) {
    const id = unTercero[1];
    if (!tercerosSimulados.has(id)) {
      return { status: 404, ok: false, datos: { Errors: [{ Code: 'not_found', Message: 'Customer not found' }] } };
    }
    // REEMPLAZA, no fusiona: es el comportamiento documentado y la razón entera de que el servicio
    // lea antes de escribir. Un simulador que fusionara escondería el borrado.
    const enviado = (opciones.cuerpo ?? {}) as Record<string, unknown>;
    const reemplazado = { ...enviado, id };
    tercerosSimulados.set(id, reemplazado);
    return { status: 200, ok: true, datos: reemplazado };
  }

  // Creación de producto (HU #11286). Antes esta ruta caía en la rama final de éxito vacío y
  // devolvía un objeto sin identificador ni código, con lo que el flujo de vinculación no se podía
  // probar. Responde con la forma documentada de `ProductOut` y RECUERDA lo creado, para que la
  // revalidación posterior lo encuentre (AC7).
  if (metodo === 'POST' && /^\/v1\/products\/?$/.test(ruta)) {
    const enviado = (opciones.cuerpo ?? {}) as Record<string, unknown>;
    const code = typeof enviado.code === 'string' ? enviado.code : 'MOCK-PROD';
    const name = typeof enviado.name === 'string' ? enviado.name : 'Producto simulado';

    // Siigo exige `code` único: el simulador replica ese rechazo con la misma estructura de error.
    // La unicidad se comprueba DENTRO del ambiente: pruebas y produccion son empresas distintas en
    // Siigo, y un simulador que las mezclara daría verde por una razón que el API real no concede.
    const yaExiste = catalogoSimuladoDe(ambiente).some((p) => p.code === code);
    if (yaExiste) {
      return {
        status: 400,
        ok: false,
        datos: {
          Status: 400,
          Errors: [{
            Code: 'already_exists',
            Message: 'Product code already exists (simulado)',
            Params: ['code'],
            Detail: 'Respuesta generada por el modo simulado de FLITO.',
          }],
        },
      };
    }

    consecutivoProducto += 1;
    const id = `mock-product-${consecutivoProducto}`;
    if (productosCreadosEnSimulacion.length >= MAX_PRODUCTOS_SIMULADOS) {
      productosCreadosEnSimulacion.shift();
    }

    // Lo creado se recuerda con la MISMA forma con la que se sirve el listado, porque en Siigo es
    // el mismo objeto. Antes se guardaban cinco campos sueltos y una clave `ambiente`, y la
    // consulta posterior devolvía un producto que no se parecía a los demás ni al del API real.
    const clasificacion: ProductoSimuladoApi['tax_classification'] =
      enviado.tax_classification === 'Exempt' || enviado.tax_classification === 'Excluded'
        ? enviado.tax_classification
        : 'Taxed';
    const impuestos = (Array.isArray(enviado.taxes) ? enviado.taxes : []).flatMap((t) => {
      const idImpuesto = (t as { id?: unknown } | null)?.id;
      // Siigo devuelve el impuesto COMPLETO —nombre, tipo y tarifa—, no el `{ id }` que se envió.
      return typeof idImpuesto === 'number' ? [impuestoSimulado(idImpuesto)] : [];
    });
    const unidad = typeof enviado.unit === 'string' ? unidadSimulada(enviado.unit) : null;

    const creado: ProductoSimuladoApi = {
      id,
      code,
      name,
      account_group: grupoSimulado(
        typeof enviado.account_group === 'number' ? enviado.account_group : 1253),
      type: enviado.type === 'Product' ? 'Product' : 'Service',
      stock_control: enviado.stock_control === true,
      active: true,
      tax_classification: clasificacion,
      tax_included: enviado.tax_included === true,
      // `tax_consumption_value` solo viaja en los NO gravados, igual que en la respuesta real.
      ...(clasificacion === 'Taxed' ? {} : { tax_consumption_value: 0 }),
      // Los `Excluded` NO llevan la clave `taxes`. Es la forma del ambiente real, y devolver aquí
      // un arreglo vacío haría pasar en desarrollo el código que da por hecho que la clave está.
      ...(clasificacion === 'Excluded' ? {} : { taxes: impuestos }),
      ...(unidad === null ? {} : { unit: unidad, unit_label: unidad.name }),
      reference: '',
      description: '',
      additional_fields: {},
      available_quantity: 0,
      warehouses: [],
      metadata: { created: '2026-08-06T00:00:00.000Z' },
    };
    productosCreadosEnSimulacion.push({ ambiente, producto: creado });

    return { status: 201, ok: true, datos: creado };
  }

  // Consulta de producto por código (HU #11283). Va ANTES del listado genérico: sin esto el
  // simulador respondería `results: []` a todo código y la validación no tendría caso feliz.
  const producto = /^\/v1\/products\/?\?(.*)$/.exec(ruta);
  if (metodo === 'GET' && producto) {
    const codigo = new URLSearchParams(producto[1]!).get('code');
    if (codigo !== null) {
      // Siigo compara el `code` tal cual; el simulador hace lo mismo para no ser más permisivo que
      // el original y dejar pasar en pruebas un código que en producción no resolvería.
      // Se busca también entre los creados en esta simulación: es lo que hace posible el AC7.
      const encontrados = catalogoSimuladoDe(ambiente).filter((p) => p.code === codigo);
      return {
        status: 200,
        ok: true,
        datos: {
          pagination: { page: 1, page_size: 25, total_results: encontrados.length },
          results: encontrados,
          _links: {},
        },
      };
    }

    // A3 — el LISTADO paginado, sin filtro de código. Antes caía en la rama genérica de más abajo y
    // devolvía cero resultados, con lo que el selector de producto salía vacío en modo simulado: la
    // pantalla que existe para elegir un producto no se podía ensayar sin Siigo real.
    const query = new URLSearchParams(producto[1] ?? '');
    const todos = catalogoSimuladoDe(ambiente);
    const tam = Math.max(1, Number(query.get('page_size') ?? 25) || 25);
    const pagina = Math.max(1, Number(query.get('page') ?? 1) || 1);
    const desde = (pagina - 1) * tam;
    return {
      status: 200,
      ok: true,
      datos: {
        pagination: { page: pagina, page_size: tam, total_results: todos.length },
        results: todos.slice(desde, desde + tam),
        _links: {},
      },
    };
  }

  // Detalle del rechazo (HU #11333). Va ANTES de la consulta de la factura, que si no se traga esta
  // ruta por ser un prefijo suyo.
  //
  // `...-multi` devuelve VARIOS errores porque el caso de uno solo no ensaya el AC3: un rechazo con
  // tres causas y una sola mostrada hace que se corrija una, se reintente, y vuelva a rechazarse por
  // la segunda. `...-sindetalle` devuelve la lista vacía, que es «rechazó y no dice por qué» —
  // distinto de un fallo de consulta y hay que poder distinguirlos.
  const detalleRechazo = /^\/v1\/invoices\/([^/]+)\/stamp\/errors\/?$/.exec(ruta);
  if (metodo === 'GET' && detalleRechazo) {
    const id = detalleRechazo[1];
    if (id.endsWith('-sindetalle')) return { status: 200, ok: true, datos: { results: [] } };
    if (id.endsWith('-multi')) {
      return {
        status: 200,
        ok: true,
        datos: {
          results: [
            { Code: 'invalid_dian_resolution', Message: 'Invalid DIAN resolution', Params: [] },
            { Code: 'invalid_identification', Message: 'Invalid identification', Params: ['customer.identification'] },
            { Code: 'un_codigo_que_no_esta_en_el_catalogo', Message: 'Unmapped', Params: [] },
          ],
        },
      };
    }
    return {
      status: 200,
      ok: true,
      datos: {
        results: [{ Code: 'invalid_dian_resolution', Message: 'Invalid DIAN resolution', Params: [] }],
      },
    };
  }

  // Estado de UNA factura (HU #11332). Va ANTES del listado genérico, que si no se traga esta ruta
  // y responde `results: []` — una respuesta sin `stamp` con la que el sondeo no se puede ensayar.
  //
  // El identificador decide el estado, para poder ensayar los cuatro caminos sin tocar la base:
  // `...-rechazada` rechaza, `...-validacion` sigue en curso, `...-raro` devuelve un `status` que
  // FLITO no sabe traducir —el caso que NO debe convertirse en un estado adivinado— y cualquier
  // otro acepta. Un simulador que solo supiera decir «aceptada» dejaría sin ensayar justo lo que
  // duele.
  const unaFactura = /^\/v1\/invoices\/([^/]+)\/?$/.exec(ruta);
  if (metodo === 'GET' && unaFactura) {
    const id = unaFactura[1];
    const estado = id.endsWith('-rechazada') ? 'Rejected'
      : id.endsWith('-validacion') ? 'Audit'
      : id.endsWith('-raro') ? 'UnEstadoQueNadieDocumento'
      : 'Accepted';
    return {
      status: 200,
      ok: true,
      datos: {
        id,
        name: `FV-1-${id.slice(-4)}`,
        date: '2026-08-04',
        // El CUFE solo existe cuando la DIAN aceptó. Devolverlo siempre haría que el sondeo
        // pareciera correcto aunque leyera el campo equivocado.
        cufe: estado === 'Accepted' ? `cufe-${id}` : null,
        stamp: { send: true, status: estado },
        mail: { send: false },
        public_url: `https://documentview.siigo.com/document?data=${id}`,
      },
    };
  }

  // Listado de facturas con filtros (HU #11326). Va ANTES del listado genérico, que responde vacío
  // siempre — y un vacío falso aquí es lo que haría concluir a la reconciliación que la factura no
  // existe cuando sí existe.
  const listadoFacturas = /^\/v1\/invoices(?:\/)?(?:\?(.*))?$/.exec(ruta);
  if (metodo === 'GET' && listadoFacturas) {
    return listarFacturasSimuladas(new URLSearchParams(listadoFacturas[1] ?? ''));
  }

  // Listados: forma paginada documentada.
  if (metodo === 'GET' && /^\/v1\/(invoices|customers|products)/.test(ruta)) {
    return {
      status: 200,
      ok: true,
      datos: {
        pagination: { page: 1, page_size: 25, total_results: 0 },
        results: [],
        _links: {},
      },
    };
  }

  // Catálogos: arreglo simple, con elementos representativos (HU #11281).
  const catalogo = /^\/v1\/(document-types|users|payment-types|taxes|account-groups|cost-centers)(?:\/)?(?:\?(.*))?$/
    .exec(ruta);
  if (metodo === 'GET' && catalogo) {
    const recurso = catalogo[1]!;
    const query = new URLSearchParams(catalogo[2] ?? '');
    return {
      status: 200,
      ok: true,
      datos: filtrarCatalogoSimulado(recurso, query, CATALOGOS_SIMULADOS[recurso] ?? []),
    };
  }

  // Cualquier otra ruta: éxito vacío. Mejor que fingir un 404 que nadie pidió.
  return { status: 200, ok: true, datos: {} };
}
