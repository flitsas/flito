// FLITO Bolsas — extracto del cliente (HU #11124, Feature §6).
//
// El extracto reparte el consumo del cliente por organismo y por concepto: dos lecturas del mismo
// libro que cuadran por construcción, porque salen de las mismas sumas.
//
// La «bolsa simbólica» del organismo, que vivía en este archivo, se retiró en la HU #11162 junto con
// los pagos al organismo. Aquella vista era una DEUDA derivada (cobrado − pagado) y el modelo real
// es el inverso: FLIT precarga saldo y la secretaría lo consume. Su cobertura vive ahora en
// `flito-bolsas-transito.test.ts`.
//
// Aviso sobre el alcance del mock: las sumas ocurren en SQL (`sum(case when …)`), que aquí no se
// ejecuta. Por eso, además de los tests de comportamiento —que asumen la fila ya agregada, como la
// devolvería Postgres— hay uno que verifica la EXPRESIÓN generada.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { extractoDe } = await import('../../src/modules/flito-bolsas/flito-bolsas.service.js');

// ─────────────────────────── Escenario ───────────────────────────────────────

const COMPANIA = 7;
const BOLSA_ID = '11111111-1111-1111-1111-111111111111';
const SOPORTE_ID = '33333333-3333-3333-3333-333333333333';
const PAGO_ID = '44444444-4444-4444-4444-444444444444';
const ORGANISMO = '05001';
const AHORA = new Date('2026-07-30T15:00:00Z');
const CTX = { userId: 9, nombre: 'financiera@flit.io' };

function hoyEnColombia(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

const SOPORTE = {
  nombreArchivo: 'transferencia.pdf', contentType: 'application/pdf',
  storageKey: 'organismos/05001/pagos/transferencia.pdf',
  hash: 'b'.repeat(64), tamanoBytes: 4096,
};

const filaBolsa = {
  id: BOLSA_ID, companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.',
  saldo: '500000', ultimaRecargaValor: '800000', ultimaRecargaEn: AHORA,
};

/**
 * Las tres consultas de `extractoDe` sobre `flito_bolsa_movimientos` van encoladas: preguntan por la
 * misma tabla y solo las distingue el orden en que se lanzan (totales, por organismo, por concepto).
 */
function escenarioExtracto(
  totales: Record<string, unknown>,
  porOrganismo: Record<string, unknown>[],
  porConcepto: Record<string, unknown>[],
  bolsa: Record<string, unknown>[] = [filaBolsa],
): void {
  kdb.when
    .selectOnce('flito_bolsa_movimientos', [totales])
    .selectOnce('flito_bolsa_movimientos', porOrganismo)
    .selectOnce('flito_bolsa_movimientos', porConcepto)
    .select('flito_bolsas', bolsa);
}

/** Texto del SQL de una proyección: los trozos literales de la expresión, sin los parámetros. */
function sqlDe(proyeccion: unknown, campo: string): string {
  const expr = (proyeccion as Record<string, unknown>)[campo];
  const trozos: string[] = [];
  const visitar = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visitar); return; }
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.value)) trozos.push(...o.value.filter((v): v is string => typeof v === 'string'));
    if (Array.isArray(o.queryChunks)) o.queryChunks.forEach(visitar);
  };
  visitar(expr);
  return trozos.join(' ');
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
});

// ─────────────────────────── AC1: extracto del cliente ───────────────────────

describe('extractoDe — AC1: el consumo desglosado cuadra con el saldo', () => {
  it('entradas − salidas es el saldo actual de la bolsa', async () => {
    // Los desgloses salen del mismo libro que produce el saldo, así que cuadran por construcción.
    // Este test fija esa invariante: si un día el saldo se leyera de otra fuente, saltaría aquí.
    escenarioExtracto(
      { entradas: '800000', salidas: '300000' },
      [{ clave: ORGANISMO, entradas: '0', salidas: '300000', movimientos: 3 }],
      [{ clave: 'impuesto', entradas: '0', salidas: '300000', movimientos: 3 }],
    );

    const e = await extractoDe(COMPANIA);

    expect(e.totalEntradas).toBe(800000);
    expect(e.totalSalidas).toBe(300000);
    expect(e.saldoActual).toBe(500000);
    expect(e.totalEntradas - e.totalSalidas).toBe(e.saldoActual);
  });

  it('cada agrupación reparte las mismas sumas por una dimensión distinta', async () => {
    escenarioExtracto(
      { entradas: '800000', salidas: '300000' },
      [
        { clave: ORGANISMO, entradas: '0', salidas: '180000', movimientos: 2 },
        { clave: '11001', entradas: '0', salidas: '120000', movimientos: 1 },
        { clave: null, entradas: '800000', salidas: '0', movimientos: 1 },
      ],
      [
        { clave: 'impuesto', entradas: '0', salidas: '120000', movimientos: 1 },
        { clave: 'soat', entradas: '0', salidas: '180000', movimientos: 2 },
        { clave: null, entradas: '800000', salidas: '0', movimientos: 1 },
      ],
    );

    const e = await extractoDe(COMPANIA);
    const suma = (ls: { salidas: number }[]) => ls.reduce((a, l) => a + l.salidas, 0);

    expect(suma(e.porOrganismo)).toBe(e.totalSalidas);
    expect(suma(e.porConcepto)).toBe(e.totalSalidas);
  });

  it('las columnas nulas se agrupan como «sin_asignar», no se pierden', async () => {
    // Una recarga no tiene organismo ni concepto, y el trámite digital y la logística no tienen
    // organismo por ser honorarios de FLIT. Descartarlas descuadraría el desglose contra el total.
    escenarioExtracto(
      { entradas: '800000', salidas: '215000' },
      [{ clave: null, entradas: '800000', salidas: '215000', movimientos: 4 }],
      [{ clave: null, entradas: '800000', salidas: '0', movimientos: 1 }],
    );

    const e = await extractoDe(COMPANIA);
    expect(e.porOrganismo[0].clave).toBe('sin_asignar');
    expect(e.porConcepto[0].clave).toBe('sin_asignar');
    expect(e.porOrganismo[0].entradas).toBe(800000);
  });

  it('los numeric llegan como número, no como string', async () => {
    escenarioExtracto(
      { entradas: '800000.50', salidas: '300000.25' },
      [{ clave: ORGANISMO, entradas: '0', salidas: '300000.25', movimientos: 3 }],
      [],
    );

    const e = await extractoDe(COMPANIA);
    expect(e.totalEntradas).toBe(800000.5);
    expect(e.porOrganismo[0].salidas).toBe(300000.25);
    expect(e.porOrganismo[0].movimientos).toBe(3);
  });

  it('cliente sin bolsa → saldo 0 y desgloses vacíos, no un error', async () => {
    escenarioExtracto({ entradas: '0', salidas: '0' }, [], [], []);

    const e = await extractoDe(COMPANIA);
    expect(e).toMatchObject({ companiaId: COMPANIA, saldoActual: 0, totalEntradas: 0, totalSalidas: 0 });
    expect(e.porOrganismo).toEqual([]);
  });

  it('con periodo, el filtro llega a la consulta', async () => {
    // El extracto mensual es lo que Financiera concilia contra el cierre; sin el filtro mostraría el
    // histórico completo y ambos números no cuadrarían nunca.
    escenarioExtracto({ entradas: '0', salidas: '0' }, [], []);
    await extractoDe(COMPANIA, '2026-06');

    // Se mira el historial y no el último `where`: la consulta que cierra el extracto es la de la
    // bolsa, que solo filtra por compañía.
    expect(espia.filtrosUsados()).toContain('2026-06');
  });

  it('las entradas y las salidas se suman por separado, no en neto', async () => {
    // Verificado sobre la expresión SQL: el mock no ejecuta el `sum(case when …)`. Si alguien lo
    // sustituyera por un `sum(valor)` a secas, el extracto mostraría un neto y el desglose por
    // concepto dejaría de poder explicar el consumo.
    escenarioExtracto({ entradas: '0', salidas: '0' }, [], []);
    await extractoDe(COMPANIA);

    const proyeccion = kdb.select.mock.calls[0][0];
    expect(sqlDe(proyeccion, 'entradas')).toMatch(/case when/);
    expect(sqlDe(proyeccion, 'entradas')).toMatch(/else 0/);
  });
});
