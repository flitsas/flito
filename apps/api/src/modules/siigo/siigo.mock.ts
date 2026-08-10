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
export function reiniciarConsecutivoSimulado(): void { consecutivo = 0; }

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

/** Productos (`GET /v1/products?code=`). Uno por concepto facturable, más un caso inactivo. */
const PRODUCTS_SIMULADOS = [
  {
    id: 'mock-prod-soat', code: 'SOAT-2024', name: 'SOAT — Seguro Obligatorio', active: true,
    account_group: 1254, taxes: [], unit: '94',
  },
  {
    id: 'mock-prod-imp', code: 'IMP-VEHICULAR', name: 'Impuesto vehicular', active: true,
    account_group: 1254, taxes: [], unit: '94',
  },
  {
    id: 'mock-prod-der', code: 'DER-TRANSITO', name: 'Derecho de tránsito', active: true,
    account_group: 1254, taxes: [], unit: '94',
  },
  {
    id: 'mock-prod-tram', code: 'TRAMITE-DIGITAL', name: 'Trámite digital', active: true,
    account_group: 1253, taxes: [{ id: 13156, name: 'IVA 19%', percentage: 19 }], unit: '94',
  },
  {
    id: 'mock-prod-log', code: 'LOGISTICA', name: 'Servicio de logística', active: true,
    account_group: 1253, taxes: [{ id: 13156, name: 'IVA 19%', percentage: 19 }], unit: '94',
  },
  {
    id: 'mock-prod-gmf', code: 'GMF-4X1000', name: 'Gravamen a los movimientos financieros',
    active: true, account_group: 1253, taxes: [], unit: '94',
  },
  {
    id: 'mock-prod-off', code: 'PRODUCTO-INACTIVO', name: 'Producto descontinuado', active: false,
    account_group: 1255, taxes: [], unit: '94',
  },
];

/** Exportado para que los tests afirmen sobre los mismos datos que sirve el simulador. */
export const PRODUCTOS_SIMULADOS: readonly { code: string; active: boolean; name: string }[] =
  PRODUCTS_SIMULADOS;

/**
 * Productos creados durante la vida del proceso (HU #11286).
 *
 * Separados de las fixtures y MUTABLES a propósito. El AC7 pide que el flujo de vinculación se
 * pueda probar de extremo a extremo sin ambiente real, y ese flujo es: crear → el mapeo se
 * actualiza → la actualización REVALIDA el código contra Siigo. Si lo recién creado no apareciera
 * en la siguiente consulta, la vinculación fallaría con «no existe» y el simulador no serviría para
 * ensayar justo lo que la historia pide ensayar.
 */
const productosCreadosEnSimulacion: Array<{
  ambiente: string; id: string; code: string; name: string; active: boolean;
}> = [];

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
export function respuestaSimulada(
  metodo: MetodoHttp, ruta: string, opciones: OpcionesSimulacion = {},
): RespuestaSimulada {
  // Ambiente al que pertenece la simulación: los productos recordados se particionan por él.
  const ambiente = opciones.ambiente ?? env.SIIGO_AMBIENTE;
  const aleatorio = opciones.aleatorio ?? Math.random;
  const tasaTimeout = opciones.tasaTimeout ?? env.SIIGO_MOCK_TIMEOUT_RATE;
  const tasaError = opciones.tasaError ?? env.SIIGO_MOCK_ERROR_RATE;

  if (tasaTimeout > 0 && aleatorio() < tasaTimeout) throw new SiigoMockTimeout();
  if (tasaError > 0 && aleatorio() < tasaError) return errorSimulado();

  // Creación de factura de venta.
  if (metodo === 'POST' && /^\/v1\/invoices\/?$/.test(ruta)) {
    consecutivo += 1;
    return {
      status: 201,
      ok: true,
      datos: {
        id: `mock-invoice-${consecutivo}`,
        document: { id: 24446 },
        number: consecutivo,
        name: `FV-1-${consecutivo}`,
        date: '2026-08-04',
        customer: { identification: '900123456', branch_office: 0 },
        total: 0,
        balance: 0,
        seller: 629,
        stamp: { send: true, status: 'Audit' },
        mail: { send: false },
        items: [],
        payments: [],
        public_url: `https://documentview.siigo.com/document?data=mock-${consecutivo}`,
        metadata: { created: '2026-08-04T00:00:00.000Z', last_updated: null },
      },
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

  // Creación de tercero.
  if (metodo === 'POST' && /^\/v1\/customers\/?$/.test(ruta)) {
    return {
      status: 201,
      ok: true,
      datos: {
        id: 'mock-customer-1',
        type: 'Customer',
        person_type: 'Company',
        id_type: { code: '31', name: 'NIT' },
        identification: '900123456',
        branch_office: 0,
        name: ['Empresa simulada'],
        active: true,
        metadata: { created: '2026-08-04T00:00:00.000Z', last_updated: null },
      },
    };
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
    const yaExiste = PRODUCTS_SIMULADOS.some((p) => p.code === code)
      || productosCreadosEnSimulacion.some((p) => p.code === code && p.ambiente === ambiente);
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
    productosCreadosEnSimulacion.push({ ambiente, id, code, name, active: true });

    return {
      status: 201,
      ok: true,
      datos: {
        id,
        code,
        name,
        account_group: { id: enviado.account_group ?? 1253, name: 'Grupo simulado' },
        type: enviado.type ?? 'Service',
        stock_control: enviado.stock_control === true,
        active: true,
        tax_classification: enviado.tax_classification ?? 'Taxed',
        taxes: Array.isArray(enviado.taxes) ? enviado.taxes : [],
        prices: [],
        unit: { code: enviado.unit ?? '94', name: 'unidad' },
        unit_label: 'unidad',
        reference: null,
        description: null,
        additional_fields: {},
        available_quantity: 0,
        warehouses: [],
        metadata: { created: '2026-08-06T00:00:00.000Z', last_updated: null },
      },
    };
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
      const encontrados = [
        ...PRODUCTS_SIMULADOS,
        ...productosCreadosEnSimulacion.filter((p) => p.ambiente === ambiente),
      ].filter((p) => p.code === codigo);
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
