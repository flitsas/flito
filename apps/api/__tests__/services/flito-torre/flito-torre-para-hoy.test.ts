// Torre de Control Gerencial (Épica #14590, B6) — «Para hoy» y «Lo que cambió en el periodo» del Resumen 360°.
//   · Sin base: la lista fija de frentes (función de origen coherente con el catálogo; ninguno de Equipo; sin
//     `boletas_sin_conciliar`), el orden (crítico → atención → cifra) y las 6 reglas de hallazgos (cada una dispara y no
//     dispara con fixtures; máx. 4; sin dinero no hay pesos; periodo anterior en 0 no da variación).
//   · Contra PostgreSQL real (tx con ROLLBACK, `torre-pg.ts`): B6-AC1 — cada frente tiene `cifra` == `total` del detalle
//     de su destino; cifra 0 no genera frente; crítico si hay registros sobre el doble del umbral; la cobertura crítica
//     no cuenta las agotadas; un usuario sin la función de origen no recibe el frente.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FUNCION_EQUIPO_TORRE, FUNCION_TABLERO_LOGISTICA_TORRE, FUNCION_TABLERO_PRODUCTOS_TORRE, conjuntoTorre,
  type FiltroTorre, type FrenteTorre,
} from '@operaciones/shared-types';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { FRENTES_PARA_HOY, ordenarFrentes, tableroEjecutivo } = await import('../../../src/modules/flito-torre/flito-torre.ejecutivo.service.js');
const { hallazgosEjecutivo, MAX_HALLAZGOS } = await import('../../../src/modules/flito-torre/flito-torre.frases.js');
const { consultarDetalle } = await import('../../../src/modules/flito-torre/flito-torre.detalle.service.js');
const { valoresUmbrales } = await import('../../../src/modules/flito-torre/flito-torre.umbrales.service.js');

const TODO = { enlace: 'ninguno' } as const;
const HOY = '2035-03-31';
const EJECUTIVO = 'torre.tablero_ejecutivo.ver';
const COMERCIAL = 'torre.tablero_comercial.ver';
const OPERATIVO = 'torre.tablero_operativo.ver';
const FINANCIERO = 'torre.tablero_financiero.ver';
const TODAS = new Set([EJECUTIVO, COMERCIAL, OPERATIVO, FINANCIERO, FUNCION_TABLERO_PRODUCTOS_TORRE, FUNCION_TABLERO_LOGISTICA_TORRE]);

// ── Sin base ─────────────────────────────────────────────────────────────────────────────────────────

describe('«Para hoy» — lista fija y orden (sin base)', () => {
  it('cada frente exige una función de su tablero que también abre su conjunto; ninguno es de Equipo ni boletas sin conciliar', () => {
    for (const f of FRENTES_PARA_HOY) {
      expect(conjuntoTorre(f.conjunto).funcionesOrigen, f.conjunto).toContain(f.area);
      expect(conjuntoTorre(f.conjunto).funcionesOrigen, f.conjunto).not.toContain(FUNCION_EQUIPO_TORRE);
      expect(conjuntoTorre(f.conjunto).requiereDinero, f.conjunto).toBe(false);
    }
    const ids = FRENTES_PARA_HOY.map((f) => f.conjunto);
    expect(ids).not.toContain('boletas_sin_conciliar');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(19);
  });

  it('orden: crítico primero y luego por cifra descendente', () => {
    const f = (clave: string, severidad: FrenteTorre['severidad'], cifra: number): FrenteTorre =>
      ({ clave, conjunto: null, cifra, frase: '', severidad, accion: 'ver', destino: { tipo: 'ninguno' }, rango: null });
    const orden = ordenarFrentes([f('a', 'atencion', 50), f('b', 'critico', 2), f('c', 'atencion', 70), f('d', 'critico', 9)]);
    expect(orden.map((x) => x.clave)).toEqual(['d', 'b', 'c', 'a']);
  });
});

describe('hallazgos deterministas (B6-AC2, sin base)', () => {
  const sinCambio = { actual: 100, anterior: 100 };
  const creados = (actual: number, anterior: number, top3Pct: number | null = 50, companias = 10) =>
    ({ actual, anterior, top3Pct, companias, mayor: 'Aseguradora Andina', mayorPct: 61 });

  it('H1 volumen: dispara con |Δ| ≥ 10 % (sube y baja) y no con 9 % ni con periodo anterior en 0', () => {
    expect(hallazgosEjecutivo({ creados: creados(1240, 1100) })).toEqual([
      { regla: 'H1', area: 'comercial', frase: 'Se crearon 1.240 trámites, 13 % más que en el periodo anterior (1.100).' }]);
    expect(hallazgosEjecutivo({ creados: creados(88, 100) })[0]!.frase).toBe('Se crearon 88 trámites, 12 % menos que en el periodo anterior (100).');
    expect(hallazgosEjecutivo({ creados: creados(109, 100) })).toEqual([]);
    expect(hallazgosEjecutivo({ creados: creados(50, 0) })).toEqual([]);
  });

  it('H2 concentración: Top 3 ≥ 80 % con más de 3 compañías; no con 79 % ni con 3 compañías (100 % por construcción)', () => {
    expect(hallazgosEjecutivo({ creados: creados(100, 100, 98) })).toEqual([{ regla: 'H2', area: 'comercial',
      frase: '3 compañías concentran el 98 % de los trámites creados; la mayor, Aseguradora Andina, el 61 %.' }]);
    expect(hallazgosEjecutivo({ creados: creados(100, 100, 79) })).toEqual([]);
    expect(hallazgosEjecutivo({ creados: creados(100, 100, 100, 3) })).toEqual([]);
  });

  it('H3 conversión: |Δ| ≥ 5 puntos', () => {
    expect(hallazgosEjecutivo({ conversion: { actual: 25, anterior: 31 } })[0]).toEqual({ regla: 'H3', area: 'comercial',
      frase: 'La conversión a facturado bajó de 31 % a 25 % frente al periodo anterior.' });
    expect(hallazgosEjecutivo({ conversion: { actual: 35, anterior: 31 } })).toEqual([]);
    expect(hallazgosEjecutivo({ conversion: { actual: 35, anterior: null } })).toEqual([]);
  });

  it('H4 sin facturar: sube ≥ 20 % y al menos 10; con dinero en pesos, sin dinero en trámites', () => {
    expect(hallazgosEjecutivo({ sinFacturar: { actual: 63, anterior: 40, valorActual: null, valorAnterior: null } })[0]).toEqual({
      regla: 'H4', area: 'financiera', frase: 'Lo aprobado sin facturar pasó de 40 a 63 trámites frente al periodo anterior.' });
    expect(hallazgosEjecutivo({ sinFacturar: { actual: 63, anterior: 40, valorActual: 48_000_000, valorAnterior: 30_000_000 } })[0]!.frase)
      .toBe('Lo aprobado sin facturar pasó de $30 M a $48 M frente al periodo anterior.');
    expect(hallazgosEjecutivo({ sinFacturar: { actual: 9, anterior: 2, valorActual: null, valorAnterior: null } })).toEqual([]);
    expect(hallazgosEjecutivo({ sinFacturar: { actual: 47, anterior: 40, valorActual: null, valorAnterior: null } })).toEqual([]);
    expect(hallazgosEjecutivo({ sinFacturar: { actual: 20, anterior: 40, valorActual: null, valorAnterior: null } })).toEqual([]);
  });

  it('H5 primer intento: |Δ| ≥ 3 puntos', () => {
    expect(hallazgosEjecutivo({ primerIntento: { actual: 92, anterior: 95 } })[0]).toEqual({ regla: 'H5', area: 'logistica', vista: 'entregas',
      frase: 'Las entregas al primer intento bajaron de 95 % a 92 %.' });
    expect(hallazgosEjecutivo({ primerIntento: { actual: 93, anterior: 95 } })).toEqual([]);
  });

  it('H6 productos: |Δ| ≥ 15 % en SOAT o impuestos (una sola frase, la del cambio mayor)', () => {
    expect(hallazgosEjecutivo({ pagados: { soat: { actual: 138, anterior: 172 }, impuestos: { actual: 116, anterior: 100 } } })).toEqual([
      { regla: 'H6', area: 'productos', vista: 'soat', frase: 'Se pagaron 138 SOAT, 20 % menos que en el periodo anterior.' }]);
    expect(hallazgosEjecutivo({ pagados: { soat: sinCambio, impuestos: { actual: 50, anterior: 40 } } })[0]!.vista).toBe('impuestos');
    expect(hallazgosEjecutivo({ pagados: { soat: { actual: 114, anterior: 100 }, impuestos: sinCambio } })).toEqual([]);
  });

  it('máx. 4, ordenados por la magnitud relativa; sin datos de un área no sale su regla', () => {
    const h = hallazgosEjecutivo({
      creados: creados(200, 100, 90), conversion: { actual: 10, anterior: 40 }, sinFacturar: { actual: 100, anterior: 10, valorActual: null, valorAnterior: null },
      primerIntento: { actual: 80, anterior: 95 }, pagados: { soat: { actual: 100, anterior: 50 }, impuestos: sinCambio },
    });
    expect(h).toHaveLength(MAX_HALLAZGOS);
    // H4: 900 % / 20 = 45; H1: 100 / 10 = 10; H3: 30 / 5 = 6; H6: 100 / 15 ≈ 6,7; H5: 15 / 3 = 5; H2: 90 / 80 ≈ 1,1.
    expect(h.map((x) => x.regla)).toEqual(['H4', 'H1', 'H6', 'H3']);
    expect(hallazgosEjecutivo({})).toEqual([]);
  });
});

// ── Con base ─────────────────────────────────────────────────────────────────────────────────────────

const haceDias = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

describe.skipIf(!URL_BASE)('«Para hoy» contra PostgreSQL (tx con ROLLBACK)', () => {
  let tx: Awaited<ReturnType<typeof abrirTx>>;
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { tx = await abrirTx(); s = sembrador(tx); await s.organismos('05001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  const lote = async () => {
    const [l] = await tx`INSERT INTO siigo_lotes_facturacion (ambiente, huella) VALUES ('pruebas', ${`H${Math.random().toString(36).slice(2)}`}) RETURNING id`;
    return l!.id as string;
  };
  const facturaRechazada = async (tramiteId: string) => {
    const [f] = await tx`INSERT INTO siigo_facturas (lote_id, ambiente, idempotency_key, estado, enviada_en, total_siigo, numero, siigo_invoice_id)
      VALUES (${await lote()}, 'pruebas', ${`K${Math.random().toString(36).slice(2, 14)}`}, 'emitida', '2035-03-02T15:00:00Z', 1,
        ${`FV-${Math.floor(Math.random() * 1e6)}`}, ${`inv-${Math.random()}`}) RETURNING id`;
    await tx`INSERT INTO siigo_factura_tramites (factura_id, tramite_id, concepto, activo) VALUES (${f!.id}, ${tramiteId}, 'tramite', true)`;
    await tx`INSERT INTO siigo_factura_estados_dian (factura_id, estado, fuente, motivo) VALUES (${f!.id}, 'rechazada', 'sondeo', 'MOTIVO')`;
  };
  const cola = async (tramiteId: string, estado: string) => {
    const l = await lote();
    await tx`INSERT INTO siigo_lote_tramites (lote_id, tramite_id) VALUES (${l}, ${tramiteId})`;
    await tx`INSERT INTO siigo_cola_facturacion (lote_id, ambiente, estado, proximo_intento_at, intentos) VALUES (${l}, 'pruebas', ${estado}, '2001-01-01T00:00:00Z', 2)`;
  };
  const traslado = async (cia: number, dias: number) => {
    await tx`INSERT INTO flito_logistica_traslados (compania_id, origen, destino, estado, registrado_en)
      VALUES (${cia}, 'organismo', 'cliente', 'registrado', ${haceDias(dias)})`;
  };

  async function escenario() {
    const u = await valoresUmbrales();
    const x = await s.cia('X'); const y = await s.cia('Y');
    // Borradores: uno pasa del umbral sin llegar al doble (atención), otro pasa del doble (crítico).
    const b = u.dias_borrador_abandonado;
    await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: haceDias(b + 1), creadoSync: haceDias(b + 1) });
    await s.tramite({ cia: y, flitEstado: 'Borrador', creadoFlit: haceDias(b * 2 + 3), creadoSync: haceDias(b * 2 + 3) });
    // Sin facturar del mes en curso (marzo de 2035): 2 aprobados con liquidación y sin factura; uno de febrero no cuenta.
    for (const ap of ['2035-03-05T15:00:00Z', '2035-03-10T15:00:00Z', '2035-02-10T15:00:00Z']) {
      await s.liquidacion(await s.tramite({ cia: x, aprobado: ap }), { total: 1_500_000 });
    }
    // Facturación: 1 rechazada por la DIAN (crítico fijo); cola: 1 vencida (atención) — y en otro escenario, agotada.
    await facturaRechazada(await s.tramite({ cia: y }));
    await cola(await s.tramite({ cia: x }), 'pendiente');
    // Traslados: solo uno, sobre el umbral sin llegar al doble → atención.
    await traslado(x, u.dias_traslado_abierto + 1);
    // Bolsas: x en crítico con saldo (1 día de cobertura), y agotada (también crítica): no se cuentan dos veces.
    const bx = await s.bolsa(x, 100_000);
    await s.salida(bx, 3_000_000, '2035-03-15');
    await s.bolsa(y, 0);
    return { u, x, y, filtro: { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [x, y] } as FiltroTorre };
  }

  const ctxDe = (filtro: FiltroTorre, funciones: ReadonlySet<string>, dinero = true) => ({ filtro, alcance: TODO, dinero, hoy: HOY, funciones });

  async function totalDetalle(filtro: FiltroTorre, f: FrenteTorre, funciones: ReadonlySet<string>): Promise<number> {
    if (f.destino.tipo !== 'conjunto') throw new Error(`${f.clave}: se esperaba un destino de conjunto`);
    const d = await consultarDetalle({
      origen: f.destino.origen, segmentos: f.destino.segmentos, filtro: f.rango ? { ...filtro, rango: f.rango } : filtro, pagina: 1, tamano: 25,
    }, { alcance: TODO, dinero: true, funciones, hoy: HOY });
    return d.total;
  }

  it('B6-AC1: cada frente tiene cifra == total de su detalle; cifra 0 no entra; gravedad, frase y dedupe de bolsas', async () => {
    const { filtro, u } = await escenario();
    const t = await tableroEjecutivo(ctxDe(filtro, TODAS));
    const por = new Map(t.paraHoy.map((f) => [f.clave, f]));
    for (const f of t.paraHoy) {
      expect(f.cifra, f.clave).toBeGreaterThan(0);
      // «Clientes en caída» no es conjunto: «Revisar» lleva al bloque del Comercial.
      if (f.clave === 'fuga') { expect(f).toMatchObject({ accion: 'revisar', conjunto: null, destino: { tipo: 'bloque', bloque: 'fuga' } }); continue; }
      expect(f.accion, f.clave).toBe('ver');
      expect(await totalDetalle(filtro, f, TODAS), f.clave).toBe(f.cifra);
    }
    // Lo sembrado, con su gravedad.
    expect(por.get('borrador_abandonado')).toMatchObject({ cifra: 2, severidad: 'critico', accion: 'ver',
      frase: `trámites llevan más de ${u.dias_borrador_abandonado} días en Borrador.` });
    expect(por.get('sin_facturar')).toMatchObject({ cifra: 2, severidad: 'atencion', rango: { preset: 'mes' } });
    expect(por.get('sin_facturar')!.frase).toBe('trámites aprobados este mes aún no tienen factura ($3 M).');
    expect(por.get('facturas_rechazadas_dian')).toMatchObject({ cifra: 1, severidad: 'critico', frase: 'factura fue rechazada por la DIAN.' });
    expect(por.get('cola_facturacion_atascada')).toMatchObject({ cifra: 1, severidad: 'atencion' });
    expect(por.get('traslados_abiertos_mas_de_n')).toMatchObject({ cifra: 1, severidad: 'atencion' });
    // Dedupe: la agotada solo está en su frente; la cobertura crítica cuenta la otra («otra bolsa…»).
    expect(por.get('bolsas_agotadas')).toMatchObject({ cifra: 1, severidad: 'critico' });
    expect(por.get('bolsas_cobertura')).toMatchObject({ cifra: 1, severidad: 'critico' });
    expect(por.get('bolsas_cobertura')!.frase).toMatch(new RegExp(`^otra bolsa alcanza para menos de ${u.dias_cobertura_rojo} días; la más baja, X `));
    // Cifra 0 → sin frente (nada sembrado de SOAT, impuestos, actas ni boletas en estas compañías).
    for (const c of ['soat_sin_gestion', 'actas_pendientes_entrega', 'boletas_con_diferencia', 'facturas_con_error']) expect(por.has(c), c).toBe(false);
    // Orden: todos los críticos antes que cualquier atención; dentro de cada gravedad, cifra descendente.
    const sev = t.paraHoy.map((f) => f.severidad);
    expect(sev.lastIndexOf('critico')).toBeLessThan(sev.indexOf('atencion'));
    expect(t.paraHoy).toEqual(ordenarFrentes(t.paraHoy));
    // `riesgos` se conserva en el DTO por compatibilidad; los hallazgos son a lo sumo 4.
    expect(Array.isArray(t.riesgos)).toBe(true);
    expect(t.hallazgos.length).toBeLessThanOrEqual(MAX_HALLAZGOS);
  });

  it('cola con intentos agotados → crítico; sin dinero el frente de sin facturar no lleva pesos', async () => {
    const { filtro, x } = await escenario();
    await cola(await s.tramite({ cia: x }), 'fallido_definitivo');
    const t = await tableroEjecutivo(ctxDe(filtro, TODAS, false));
    const colaF = t.paraHoy.find((f) => f.clave === 'cola_facturacion_atascada')!;
    expect(colaF).toMatchObject({ cifra: 2, severidad: 'critico' });
    expect(await totalDetalle(filtro, colaF, TODAS)).toBe(2);
    expect(t.paraHoy.find((f) => f.clave === 'sin_facturar')!.frase).toBe('trámites aprobados este mes aún no tienen factura.');
  });

  it('sin la función de origen no hay frente: Comercial (+360°) no ve Operativa, Productos, Logística ni Financiera', async () => {
    const { filtro } = await escenario();
    const comercial = new Set([EJECUTIVO, COMERCIAL, 'torre.metricas.consultar']);
    const t = await tableroEjecutivo(ctxDe(filtro, comercial));
    // borrador_abandonado se podría abrir con el 360°, pero su tablero de origen es Operativa: no entra.
    expect(t.paraHoy.filter((f) => f.clave !== 'fuga')).toEqual([]);
    // Solo Logística: solo sus frentes.
    const lg = await tableroEjecutivo(ctxDe(filtro, new Set([EJECUTIVO, FUNCION_TABLERO_LOGISTICA_TORRE])));
    expect(lg.paraHoy.map((f) => f.clave)).toEqual(['traslados_abiertos_mas_de_n']);
    for (const f of lg.paraHoy) expect(conjuntoTorre(f.conjunto!).funcionesOrigen).toContain(FUNCION_TABLERO_LOGISTICA_TORRE);
    // Sin `funciones` (p. ej. el Excel del 360°): ni frentes ni hallazgos.
    const sin = await tableroEjecutivo({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    expect(sin.paraHoy).toEqual([]);
    expect(sin.hallazgos).toEqual([]);
  });

  it('hallazgos con datos: H4 sale con el periodo anterior sembrado y solo con la función de Financiera', async () => {
    const { filtro, x } = await escenario();
    // periodoAnterior(1–31 mar) = 29 ene – 28 feb: 1 sin facturar (el del 10-feb). Marzo: 2 + 9 = 11 (≥ 10 y ≥ +20 %).
    for (let i = 0; i < 9; i++) await s.liquidacion(await s.tramite({ cia: x, aprobado: '2035-03-20T15:00:00Z' }), { total: 1_000 });
    const t = await tableroEjecutivo(ctxDe(filtro, new Set([EJECUTIVO, FINANCIERO]), false));
    expect(t.hallazgos).toEqual([{ regla: 'H4', area: 'financiera', frase: 'Lo aprobado sin facturar pasó de 1 a 11 trámites frente al periodo anterior.' }]);
    const sinFin = await tableroEjecutivo(ctxDe(filtro, new Set([EJECUTIVO, OPERATIVO]), false));
    expect(sinFin.hallazgos.find((h) => h.regla === 'H4')).toBeUndefined();
  });
});
