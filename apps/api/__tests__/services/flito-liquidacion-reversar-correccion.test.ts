// HU #11343, AC5 — reversar deja de ser un callejón sin salida.
//
// **La prohibición no cambia.** Un trámite facturado sigue sin poder reversar su liquidación, y eso
// es lo primero que se prueba aquí: si algún día este archivo dejara pasar el reverso, el error no
// sería de mensaje sino de fondo — una factura electrónica aceptada por la DIAN no se deshace
// borrando una fila en FLITO.
//
// Lo que cambia es que el mensaje deja de acabarse en sí mismo. Antes decía «no puede reversarse» y
// punto; quien lo leía se iba a preguntar por WhatsApp, donde la respuesta no queda registrada.
// Ahora dice además cuál es la vía de corrección de ESA factura según su estado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: vi.fn(),
}));

const { reversar, LiquidacionError } = await import(
  '../../src/modules/flito-liquidacion/flito-liquidacion.service.js');

const LIQUIDACIONES = 'flito_liquidaciones';
const PUENTE = 'siigo_factura_tramites';
const CORRECCIONES = 'siigo_factura_correcciones';

const TRAMITE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MOTIVO = 'Se cargó mal el valor del impuesto';

function liquidacionFacturada() {
  return {
    id: 'liq-1', tramiteId: TRAMITE_ID, estado: 'facturado', total: '850000',
    detalle: {}, liquidadoEn: new Date('2026-08-01T10:00:00Z'),
  };
}

/** La fila que devuelve el join del puente con la factura: `{ f: <factura> }`. */
function facturaViva(over: Record<string, unknown> = {}) {
  return {
    f: {
      id: 'fact-1', ambiente: 'pruebas', estado: 'emitida', siigoInvoiceId: 'inv-1',
      cufe: 'cufe-abc', numero: 'FV-100',
      enviadaEn: new Date('2026-08-01T10:00:00Z'),
      createdAt: new Date('2026-08-01T10:00:00Z'),
      ...over,
    },
  };
}

async function intentarReverso(): Promise<Error> {
  try {
    await reversar(TRAMITE_ID, MOTIVO, 9);
  } catch (e) {
    return e as Error;
  }
  throw new Error('el reverso NO debía completarse');
}

beforeEach(() => kdb.reset());

describe('AC5 — la prohibición sigue en pie', () => {
  it('un trámite facturado no reversa, pase lo que pase con la factura', async () => {
    kdb.when.select(LIQUIDACIONES, [liquidacionFacturada()])
      .select(PUENTE, [facturaViva()]).select(CORRECCIONES, []);

    const e = await intentarReverso();
    expect(e).toBeInstanceOf(LiquidacionError);
    expect(e.message).toContain('no puede reversarse');
    // Nada se borró ni se insertó: el reverso ni siquiera empezó.
    expect(kdb.delete).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

describe('AC5 — y además dice cuál es la vía', () => {
  it('con la factura aceptada por la DIAN, remite a registrar la corrección hecha por fuera', async () => {
    kdb.when.select(LIQUIDACIONES, [liquidacionFacturada()])
      .select(PUENTE, [facturaViva()]).select(CORRECCIONES, []);

    const e = await intentarReverso();
    expect(e.message).toContain('Ninguna operación de la API de Siigo');
    expect(e.message).toContain('se registra en FLITO');
    // Y no se inventa la operación: no se sabe cuál es (pregunta 8, abierta).
    expect(e.message.toLowerCase()).not.toContain('nota crédito');
  });

  it('con la factura aún no enviada a la DIAN, nombra las operaciones que Siigo documenta', async () => {
    kdb.when.select(LIQUIDACIONES, [liquidacionFacturada()])
      .select(PUENTE, [facturaViva({ cufe: null })]).select(CORRECCIONES, []);

    const e = await intentarReverso();
    expect(e.message).toContain('anulacion');
    expect(e.message).toContain('borrado');
  });

  it('con la emisión fallida, remite al reintento y no a una corrección', async () => {
    kdb.when.select(LIQUIDACIONES, [liquidacionFacturada()])
      .select(PUENTE, [facturaViva({ estado: 'fallida' })]).select(CORRECCIONES, []);

    const e = await intentarReverso();
    expect(e.message).toContain('reintentar');
  });
});

describe('AC5 — la vía nunca puede empeorar el rechazo', () => {
  it('sin factura electrónica, el mensaje se queda como estaba', async () => {
    // El trámite pudo marcarse como facturado por otro medio. Un mensaje que hablara de corregir
    // una factura que no existe sería peor que el mensaje escueto.
    kdb.when.select(LIQUIDACIONES, [liquidacionFacturada()]).select(PUENTE, []);

    const e = await intentarReverso();
    expect(e.message).toBe('El trámite ya está facturado: su liquidación no puede reversarse');
  });

  it('si la consulta de la factura falla, sale el rechazo de negocio y no un 500', async () => {
    // `viaDeCorreccionDeTramite` no lanza: convertir un rechazo explicado en un error de servidor
    // sin explicación sería un cambio a peor.
    kdb.when.select(LIQUIDACIONES, [liquidacionFacturada()])
      .selectThrow(PUENTE, new Error('conexión caída'));

    const e = await intentarReverso();
    expect(e).toBeInstanceOf(LiquidacionError);
    expect(e.message).toContain('no puede reversarse');
  });
});
