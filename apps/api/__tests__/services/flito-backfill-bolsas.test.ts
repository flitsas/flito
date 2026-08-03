// FLITO — planificación del backfill del histórico de bolsas (HU #11163).
//
// Se prueba `planificar()`, que es donde vive toda la decisión: qué se asentaría, qué se deja fuera
// y por qué. Lo que sigue después (`aplicar`) es orquestación de transacciones sobre funciones que ya
// tienen su propia cobertura — `registrarSalidasLiquidacion` en la HU #11122 y
// `registrarConsumoDerecho` en la #11161.
//
// Que la simulación y la aplicación salgan del MISMO plan es lo que hace fiable el dry-run (AC5): si
// el reporte se calculara por un camino distinto al que escribe, prometería una cosa y haría otra.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyedDb, type Resolver } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { planificar } = await import('../../src/scripts/flito-backfill-bolsas.js');

type Fila = Record<string, unknown>;

const COMPANIA = 7;
const TRAMITE = 'aaaaaaaa-0000-0000-0000-000000000001';
const SOAT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const IMPUESTO_ID = 'cccccccc-0000-0000-0000-000000000003';
const DERECHO_ID = 'dddddddd-0000-0000-0000-000000000004';
const ORG_DERECHO = '05266';

/**
 * Una liquidación sellada, con los valores CONGELADOS. El backfill nunca recalcula: la tarifa de
 * hace un año no tiene por qué ser la de hoy.
 */
function liquidacionSellada(over: Fila = {}): Fila {
  return {
    tramiteId: TRAMITE, idFlit: 'FLIT-1', companiaId: COMPANIA,
    liquidadoEn: new Date('2026-03-15T10:00:00Z'),
    valorSoat: '450000', valorImpuesto: '120000', valorDerecho: '100000',
    valorTramiteDigital: '200000', valorLogistica: '15000',
    baseGmf: '885000', tasaGmf: '0.004', valorGmf: '3540', total: '888540',
    soatId: SOAT_ID, soatOrganismo: '05001',
    impuestoId: IMPUESTO_ID, impuestoOrganismo: '11001',
    derechoId: DERECHO_ID, derechoOrganismo: ORG_DERECHO,
    ...over,
  };
}

/** Llaves ya presentes en el libro del cliente. Lo que el backfill NO debe volver a asentar. */
let llavesEnLibro: string[] = [];
/** Organismos con el indicador de bolsa encendido. */
let organismosConBolsa: string[] = [];
/** Periodos ya cerrados, como 'YYYY-MM'. */
let periodosCerrados: string[] = [];

const consultaLlaves: Resolver = () => llavesEnLibro.map((llave) => ({ llave }));
const consultaOrganismos: Resolver = () => organismosConBolsa.map((codigo) => ({ codigo }));
const consultaCierres: Resolver = () =>
  (periodosCerrados.length > 0 ? [{ id: 'cierre-1' }] : []);

function escenario(liquidaciones: Fila[]): void {
  kdb.when
    .select('flito_liquidaciones', liquidaciones)
    .select('flito_bolsa_movimientos', consultaLlaves)
    .select('organismos_transito_config', consultaOrganismos)
    .select('flito_bolsa_cierres', consultaCierres);
}

beforeEach(() => {
  kdb.reset();
  llavesEnLibro = [];
  organismosConBolsa = [];
  periodosCerrados = [];
});

// ─────────────────────────── AC1 y AC2 ───────────────────────────────────────

describe('planificar — AC1: salidas del histórico del cliente', () => {
  it('planea una salida por concepto sellado, con la llave que usaría el sellado real', async () => {
    escenario([liquidacionSellada()]);

    const r = await planificar();

    expect(r.porCliente).toHaveLength(1);
    const plan = r.porCliente[0];
    expect(plan.companiaId).toBe(COMPANIA);
    // Los seis conceptos, incluido el GMF que la HU #11160 añadió (AC2).
    expect(plan.liquidaciones[0].conceptos.map((c) => c.concepto))
      .toEqual(['soat', 'impuesto', 'derecho', 'tramite_digital', 'logistica', 'gmf']);
    // 450.000 + 120.000 + 100.000 + 200.000 + 15.000 + 3.540
    expect(plan.total).toBe(888_540);
  });

  it('las llaves son las mismas que produce salidasDe, que es lo que evita el recobro', async () => {
    // AC4: mientras el SOAT de un vehículo no tenga su llave en el libro, el próximo trámite del
    // mismo VIN lo vuelve a descontar. Sembrarlas es el motivo de fondo del backfill.
    escenario([liquidacionSellada()]);

    const r = await planificar();

    expect(r.porCliente[0].liquidaciones[0].conceptos.map((c) => c.llave)).toEqual([
      `soat:${SOAT_ID}`,
      `impuesto:${IMPUESTO_ID}`,
      `tramite:${TRAMITE}:derecho`,
      `tramite:${TRAMITE}:tramite_digital`,
      `tramite:${TRAMITE}:logistica`,
      `tramite:${TRAMITE}:gmf`,
    ]);
  });

  it('un concepto que no aplicaba no genera salida', async () => {
    // `null` es «no aplica» y no cero: una compañía que autogestiona el SOAT no lo tiene sellado.
    escenario([liquidacionSellada({ valorSoat: null, valorLogistica: null })]);

    const r = await planificar();

    expect(r.porCliente[0].liquidaciones[0].conceptos.map((c) => c.concepto))
      .toEqual(['impuesto', 'derecho', 'tramite_digital', 'gmf']);
  });
});

// ─────────────────────────── AC6 ─────────────────────────────────────────────

describe('planificar — AC6: lo ya asentado no se vuelve a planear', () => {
  it('con todas las llaves en el libro no queda nada por hacer', async () => {
    llavesEnLibro = [
      `salida:soat:${SOAT_ID}`,
      `salida:impuesto:${IMPUESTO_ID}`,
      `salida:tramite:${TRAMITE}:derecho`,
      `salida:tramite:${TRAMITE}:tramite_digital`,
      `salida:tramite:${TRAMITE}:logistica`,
      `salida:tramite:${TRAMITE}:gmf`,
    ];
    escenario([liquidacionSellada()]);

    const r = await planificar();

    expect(r.porCliente).toHaveLength(0);
  });

  it('solo el GMF pendiente → solo el GMF se planea', async () => {
    // Es el caso de las liquidaciones selladas entre la HU #11122 y la #11160: tienen sus cinco
    // conceptos pero les falta el gravamen (AC2).
    llavesEnLibro = [
      `salida:soat:${SOAT_ID}`,
      `salida:impuesto:${IMPUESTO_ID}`,
      `salida:tramite:${TRAMITE}:derecho`,
      `salida:tramite:${TRAMITE}:tramite_digital`,
      `salida:tramite:${TRAMITE}:logistica`,
    ];
    escenario([liquidacionSellada()]);

    const r = await planificar();

    expect(r.porCliente[0].liquidaciones[0].conceptos.map((c) => c.concepto)).toEqual(['gmf']);
    // La apertura cubre exactamente lo que se va a cargar, ni un peso más.
    expect(r.porCliente[0].total).toBe(3540);
  });
});

// ─────────────────────────── AC3 ─────────────────────────────────────────────

describe('planificar — AC3: consumo histórico del organismo', () => {
  it('el derecho consume la bolsa del organismo marcado', async () => {
    organismosConBolsa = [ORG_DERECHO];
    escenario([liquidacionSellada()]);

    const r = await planificar();

    expect(r.porOrganismo.get(ORG_DERECHO)).toEqual({ movimientos: 1, total: 100_000 });
  });

  it('un organismo sin el indicador no recibe consumo', async () => {
    organismosConBolsa = [];
    escenario([liquidacionSellada()]);

    const r = await planificar();

    expect(r.porOrganismo.size).toBe(0);
  });

  it('el consumo del organismo no depende de que el trámite tenga compañía', async () => {
    // El derecho se cobra siempre: la secretaría gastó su saldo aunque el trámite no hubiera
    // cruzado con un cliente.
    organismosConBolsa = [ORG_DERECHO];
    escenario([liquidacionSellada({ companiaId: null })]);

    const r = await planificar();

    expect(r.porCliente).toHaveLength(0);
    expect(r.porOrganismo.get(ORG_DERECHO)?.movimientos).toBe(1);
  });
});

// ─────────────────────────── AC7 y AC8 ───────────────────────────────────────

describe('planificar — AC7: liquidaciones sin compañía', () => {
  it('no se les asienta nada y quedan listadas en el reporte', async () => {
    escenario([liquidacionSellada({ companiaId: null })]);

    const r = await planificar();

    expect(r.porCliente).toHaveLength(0);
    expect(r.sinCompania).toEqual(['FLIT-1']);
  });
});

describe('planificar — AC8: periodos ya cerrados', () => {
  it('los movimientos de un periodo cerrado no se planean y se reportan', async () => {
    // Cerrar es congelar: meterle movimientos invalidaría un reporte que ya se selló.
    periodosCerrados = ['2026-03'];
    escenario([liquidacionSellada()]);

    const r = await planificar();

    expect(r.porCliente).toHaveLength(0);
    expect(r.periodosCerrados).toEqual([
      { companiaId: COMPANIA, periodo: '2026-03', tramiteId: 'FLIT-1' },
    ]);
  });

  it('el periodo sale de la fecha de la liquidación, no de hoy', async () => {
    // Cada movimiento se imputa al mes en que se liquidó (AC1): imputarlo a hoy metería el
    // histórico entero en el mes en curso y descuadraría el cierre.
    periodosCerrados = ['2026-03'];
    escenario([liquidacionSellada({ liquidadoEn: new Date('2026-03-01T00:30:00Z') })]);

    const r = await planificar();

    expect(r.periodosCerrados[0].periodo).toBe('2026-03');
  });
});
