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

/**
 * Respuesta simulada para una petición. Las formas replican las documentadas en
 * `docs/integraciones/siigo-api.md`, de modo que quien las consume no necesita saber en qué modo
 * está corriendo.
 */
export function respuestaSimulada(
  metodo: MetodoHttp, ruta: string, opciones: OpcionesSimulacion = {},
): RespuestaSimulada {
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

  // Catálogos: arreglo simple.
  if (metodo === 'GET' && /^\/v1\/(document-types|users|payment-types|taxes|account-groups)/.test(ruta)) {
    return { status: 200, ok: true, datos: [] };
  }

  // Cualquier otra ruta: éxito vacío. Mejor que fingir un 404 que nadie pidió.
  return { status: 200, ok: true, datos: {} };
}
