/**
 * Épica #14707 (ADR-0049, diseño §7) — Bloque 2: las LECTURAS no cuentan un trámite muerto (anulado, abortado o
 * revocado) ni un SOAT/impuesto `descartado`. Contra PostgreSQL de verdad: el `db` de la aplicación es el `dbProxy` de
 * `flito-torre/torre-pg.ts` (BEGIN … ROLLBACK por test; la base local no se ensucia). Sin `TEST_DATABASE_URL` se SALTA
 * (el CI no levanta Postgres); la parte pura (Siigo bandeja) corre siempre.
 *
 * Una prueba por lectura: cola SOAT, cola de impuestos, Tablero (conteos y alertas «sin gestión»), Gestión Trámites
 * (D7: siguen visibles con su vigencia; «Anulado» trae también Abortado; `tipoServicio`; lote con `noVigentes`),
 * Torre (conteos, liquidación vigente y el SOAT atribuido al trámite vivo), Finanzas (decisión cerrada 6: anulado y
 * abortado fuera, revocado SUMA y se marca; `ya_contado` no se atribuye a un muerto), Siigo bandeja (chip) y los
 * cruces por placa (D10) de comprobantes.
 * Datos sintéticos (año 2035, placas «ZQ…»): ningún dato real.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { URL_BASE, dbProxy, abrirTx, cerrarTx, cerrarBase, sembrador, placaNueva } from './flito-torre/torre-pg.js';

vi.mock('../../src/db/client.js', () => ({ db: dbProxy, getPoolStats: vi.fn() }));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logMock }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { condicionesCola, conJoinsCola } = await import('../../src/modules/flito-soat/flito-soat.service.js');
const { condicionesColaImpuestos, conJoinsColaImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
const { resumen } = await import('../../src/modules/flito-tablero/flito-tablero.service.js');
const tramites = await import('../../src/modules/flito-tramites/flito-tramites.service.js');
const { detalleTramite } = await import('../../src/modules/flito-tramites/flito-tramites-detalle.service.js');
const { CATALOGO_SQL, LIQUIDACION_VIGENTE } = await import('../../src/modules/flito-torre/flito-torre.catalogo.js');
const { DESDE_SOAT } = await import('../../src/modules/flito-torre/flito-torre.productos-sql.js');
const { filasParaExportar, totalesReporteCostos } = await import('../../src/modules/finanzas/finanzas.service.js');
const { sumaEnFinanzasPorTramite } = await import('../../src/shared/tramite-vigente.js');
const { agruparTramites } = await import('../../src/modules/siigo/siigo.bandeja.service.js');
const { candidatosPorLlave, candidatosPorTexto } = await import('../../src/modules/flito-comprobantes/flito-comprobantes.cruce.js');
const { buscarCandidato } = await import('../../src/modules/flito-impuestos/flito-recibos.service.js');
const { CONJUNTOS_PRODUCTOS_SQL } = await import('../../src/modules/flito-torre/flito-torre.conjuntos-productos.js');
const { DESDE_IMPUESTOS } = await import('../../src/modules/flito-torre/flito-torre.productos-sql.js');
const { flitoSoat, flitoImpuestos, flitoDerechosTramite } = await import('../../src/db/schema.js');
const { ESTADOS_SOAT_OPERATIVOS, ESTADOS_IMPUESTO_OPERATIVOS } = await import('@operaciones/shared-types');

const describeDb = URL_BASE ? describe : describe.skip;
type Tx = Awaited<ReturnType<typeof abrirTx>>;
type Muerte = 'Anulado' | 'Abortado' | 'Revocado';
let tx: Tx;
let s: ReturnType<typeof sembrador>;
let cia: number;
let nit: string;

const ctxSoat = { userId: 1, username: 't', role: 'admin', proyeccionCliente: false, alcance: 'todo', proveedorSoatId: null, companiaId: null } as never;
const ctxImp = { userId: 1, username: 't', role: 'admin', organismos: [], alcance: { enlace: 'ninguno' } } as never;
const deCia = () => ({ enlace: 'compania' as const, companiaId: cia });
const HACE_100H = () => new Date(Date.now() - 100 * 3_600_000).toISOString();

/** Trámite de la compañía de prueba. Con `muerte`, queda muerto como lo deja el sync (estado `anulado` + crudo). */
async function tramite(o: { muerte?: Muerte; flitEstado?: string; placa?: string; creado?: string; aprobado?: string } = {}): Promise<string> {
  const id = await s.tramite({ cia, flitEstado: o.muerte ?? o.flitEstado ?? 'Asignado', placa: o.placa, creadoSync: o.creado, aprobado: o.aprobado });
  await tx`UPDATE flito_tramites SET compania_nit = ${nit}, estado = ${o.muerte ? 'anulado' : null},
    created_at = COALESCE(${o.creado ?? null}::timestamptz, created_at) WHERE id = ${id}`;
  return id;
}

async function soatDe(tramiteId: string, estado: string, o: { enviadoEn?: string; pagado?: { en: string; valor: number } } = {}): Promise<string> {
  const [t] = await tx`SELECT t.vehiculo_id, v.vin FROM flito_tramites t JOIN vehicles v ON v.id = t.vehiculo_id WHERE t.id = ${tramiteId}`;
  const descartado = estado === 'descartado';
  const [r] = await tx`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, organismo_codigo, estado, origen, enviado_en, descartado_en, motivo_descarte,
      pagado_en, valor_pagado)
    VALUES (${t!.vin}, ${t!.vehiculo_id}, ${cia}, '05001', ${estado}::flito_soat_estado, 'tramite', ${o.enviadoEn ?? null},
      ${descartado ? new Date().toISOString() : null}, ${descartado ? 'anulado' : null}, ${o.pagado?.en ?? null}, ${o.pagado?.valor ?? null}) RETURNING id`;
  await tx`UPDATE flito_tramites SET soat_id = ${r!.id} WHERE id = ${tramiteId}`;
  return String(r!.id);
}

async function impuestoDe(tramiteId: string, estado: string, o: { enviadoEn?: string; pagado?: { en: string; valor: number } } = {}): Promise<string> {
  const descartado = estado === 'descartado';
  const [r] = await tx`INSERT INTO flito_impuestos (tramite_id, compania_id, organismo_codigo, modalidad_aplicada, estado, enviado_en, descartado_en, motivo_descarte,
      pagado_en, valor_pagado)
    VALUES (${tramiteId}, ${cia}, '05001', 'requiere_gestion', ${estado}::flito_impuesto_estado, ${o.enviadoEn ?? null},
      ${descartado ? new Date().toISOString() : null}, ${descartado ? 'anulado' : null}, ${o.pagado?.en ?? null}, ${o.pagado?.valor ?? null}) RETURNING id`;
  return String(r!.id);
}

const ejecutar = async (q: ReturnType<typeof sql>) => (await dbProxy.execute(q)) as unknown as Array<Record<string, unknown>>;

afterAll(async () => { if (URL_BASE) await cerrarBase(); });

describe('Siigo bandeja (puro): cada trámite de la factura trae su vigencia para el chip', () => {
  it('revocado → «revocado»; vivo → «vigente»; sin estado → «vigente»', () => {
    const m = agruparTramites([
      { facturaId: 'f1', tramiteId: 't1', idFlit: '1', companiaId: 1, estado: 'anulado', flitEstado: 'Revocado' },
      { facturaId: 'f1', tramiteId: 't2', idFlit: '2', companiaId: 1, estado: 'aprobado', flitEstado: 'Aprobado' },
      { facturaId: 'f2', tramiteId: 't3', idFlit: '3', companiaId: 1 },
    ]);
    expect(m.get('f1')!.map((t) => t.vigenciaTramite)).toEqual(['revocado', 'vigente']);
    expect(m.get('f2')![0]!.vigenciaTramite).toBe('vigente');
  });
});

describeDb('lecturas que no cuentan un trámite muerto (PostgreSQL)', () => {
  beforeEach(async () => {
    tx = await abrirTx();
    s = sembrador(tx);
    await s.organismos('05001');
    cia = await s.cia('Cía 14707');
    nit = `N14707${cia}`;
    await tx`UPDATE clients SET document = ${nit} WHERE id = ${cia}`;
  });
  afterEach(async () => { await cerrarTx(); });

  it('cola SOAT (página, conteo, facetas, export y ZIP comparten condicionesCola): el descartado no existe', async () => {
    await soatDe(await tramite(), 'pendiente');
    await soatDe(await tramite({ muerte: 'Anulado' }), 'descartado');
    const contar = async (filtros: object) => {
      const conds = condicionesCola(ctxSoat, { companias: [cia], ...filtros })!;
      const [r] = await conJoinsCola(dbProxy.select({ n: sql<number>`count(*)::int` }).from(flitoSoat).$dynamic()).where(sql.join(conds, sql` AND `));
      return Number(r!.n);
    };
    expect(await contar({})).toBe(1);
    expect(await contar({ estados: ['descartado'] })).toBe(0); // ni pidiéndolo
  });

  it('cola de impuestos: fuera el descartado y el de un trámite muerto (carrera); los estados «todos» son los operativos', async () => {
    await impuestoDe(await tramite(), 'pendiente');
    await impuestoDe(await tramite({ muerte: 'Abortado' }), 'descartado');
    await impuestoDe(await tramite({ muerte: 'Anulado' }), 'pendiente'); // aún sin descartar: tampoco cuenta
    const conds = condicionesColaImpuestos(ctxImp, { companias: [cia], estados: [...ESTADOS_IMPUESTO_OPERATIVOS] })!;
    const [r] = await conJoinsColaImpuestos(dbProxy.select({ n: sql<number>`count(*)::int` }).from(flitoImpuestos).$dynamic())
      .where(sql.join(conds, sql` AND `));
    expect(Number(r!.n)).toBe(1);
    expect(ESTADOS_IMPUESTO_OPERATIVOS).not.toContain('descartado');
  });

  it('Tablero: los conteos son los estados operativos (sin «descartado») y «sin gestión» no alerta desde un muerto', async () => {
    await soatDe(await tramite(), 'pendiente');
    await soatDe(await tramite({ muerte: 'Anulado' }), 'descartado');
    await impuestoDe(await tramite(), 'pendiente');
    await impuestoDe(await tramite({ muerte: 'Revocado' }), 'descartado');
    // SOAT solicitado compartido por un muerto (más antiguo) y un vivo: la alerta sale UNA vez, por el vivo.
    const muerto = await tramite({ muerte: 'Anulado' });
    const compartido = await soatDe(muerto, 'solicitado', { enviadoEn: HACE_100H() });
    const vivo = await tramite();
    await tx`UPDATE flito_tramites SET soat_id = ${compartido} WHERE id = ${vivo}`;
    // Impuesto solicitado de un muerto aún sin descartar: no alerta.
    await impuestoDe(await tramite({ muerte: 'Anulado' }), 'solicitado', { enviadoEn: HACE_100H() });

    const r = await resumen(deCia());
    expect(Object.keys(r.soat!).sort()).toEqual([...ESTADOS_SOAT_OPERATIVOS].sort());
    expect(Object.keys(r.impuestos!).sort()).toEqual([...ESTADOS_IMPUESTO_OPERATIVOS].sort());
    expect(r.soat!.pendiente).toBe(1);
    expect(r.impuestos!.pendiente).toBe(1);
    expect(r.alertas.soat_sin_gestion).toBe(1);
    expect(r.alertas.impuesto_sin_gestion).toBe(0);
  });

  it('Gestión Trámites (D7): los muertos siguen visibles con su vigencia; «Anulado» trae Abortado y Revocado; tipoServicio', async () => {
    const vivo = await tramite();
    const anulado = await tramite({ muerte: 'Anulado' });
    const abortado = await tramite({ muerte: 'Abortado' });
    const revocado = await tramite({ muerte: 'Revocado' });
    await impuestoDe(anulado, 'descartado');
    await tx`UPDATE vehicles SET tipo_servicio = 'Público' WHERE id = (SELECT vehiculo_id FROM flito_tramites WHERE id = ${vivo})`;

    const todos = await tramites.listar({ pageSize: 50 }, deCia());
    const porId = new Map(todos.items.map((f) => [f.tramiteId, f]));
    expect(porId.get(vivo)).toMatchObject({ vigenciaTramite: 'vigente', vehiculo: { tipoServicio: 'Público' } });
    expect(porId.get(anulado)).toMatchObject({ vigenciaTramite: 'anulado', impuesto: { estado: 'descartado' } });
    expect(porId.get(abortado)!.vigenciaTramite).toBe('abortado');
    expect(porId.get(revocado)!.vigenciaTramite).toBe('revocado');

    const filtro = await tramites.listar({ estados: ['Anulado'], pageSize: 50 }, deCia());
    expect(filtro.items.map((f) => f.tramiteId).sort()).toEqual([anulado, abortado, revocado].sort());

    const det = await detalleTramite(revocado, deCia());
    expect(det).toMatchObject({ vigenciaTramite: 'revocado', vehiculo: { tipoServicio: null } });

    // Lote: el muerto se omite y se cuenta en `noVigentes`.
    const lote = await tramites.solicitarImpuestos([anulado, abortado], { userId: 1, username: 't', role: 'admin', alcance: deCia() });
    expect(lote).toMatchObject({ enviados: 0, noVigentes: 2 });
  });

  it('Torre: conteos de trámites sin muertos, la liquidación de un revocado no es vigente y el SOAT se atribuye al vivo', async () => {
    const vivo = await tramite({ creado: '2035-03-02T00:00:00Z' });
    const revocado = await tramite({ muerte: 'Revocado' });
    await tramite({ muerte: 'Abortado' });
    const contar = async (fijas: ReturnType<typeof sql>[]) =>
      Number((await ejecutar(sql`SELECT count(*)::int AS n FROM flito_tramites WHERE compania_id = ${cia} AND ${sql.join(fijas, sql` AND `)}`))[0]!.n);
    for (const m of ['tramites', 'tramites_creados', 'tramites_aprobados', 'tasa_aprobacion'] as const) {
      expect(await contar(CATALOGO_SQL[m].fijas), m).toBe(1);
    }
    expect(await contar([LIQUIDACION_VIGENTE])).toBe(1);
    const [rev] = await ejecutar(sql`SELECT ${LIQUIDACION_VIGENTE} AS vigente FROM flito_tramites WHERE id = ${revocado}`);
    expect(rev!.vigente).toBe(false);

    // SOAT compartido: el muerto (más antiguo) y el vivo. El producto se ve con el trámite VIVO.
    const muertoViejo = await tramite({ muerte: 'Anulado', creado: '2035-03-01T00:00:00Z' });
    const soat = await soatDe(muertoViejo, 'solicitado');
    await tx`UPDATE flito_tramites SET soat_id = ${soat} WHERE id = ${vivo}`;
    const [fila] = await ejecutar(sql`SELECT flito_tramites.id AS tramite FROM ${DESDE_SOAT} WHERE ${flitoSoat.id} = ${soat}`);
    expect(fila!.tramite).toBe(vivo);
    // Un SOAT descartado no cuenta como gestionado.
    await soatDe(await tramite({ muerte: 'Anulado' }), 'descartado');
    const [g] = await ejecutar(sql`SELECT count(*)::int AS n FROM ${DESDE_SOAT}
      WHERE ${flitoSoat.companiaId} = ${cia} AND ${sql.join(CATALOGO_SQL.soat_gestionados.fijas, sql` AND `)}`);
    expect(Number(g!.n)).toBe(1);
  });

  it('Torre (B1): un SOAT/impuesto descartado conserva pagado_en y valor_pagado, pero no SUMA ni sale en los conjuntos', async () => {
    const pago = { en: '2035-03-05T15:00:00Z', valor: 700_000 };
    await soatDe(await tramite({ muerte: 'Anulado' }), 'descartado', { pagado: pago });
    await impuestoDe(await tramite({ muerte: 'Abortado' }), 'descartado', { pagado: pago });
    await soatDe(await tramite(), 'pagado', { pagado: { en: pago.en, valor: 1_000 } });
    await impuestoDe(await tramite(), 'pagado', { pagado: { en: pago.en, valor: 2_000 } });
    const pagoDe = (m: 'soat_pagados_valor' | 'impuestos_pagados') => CATALOGO_SQL[m].fechas.pago!.fijas;
    const [soatSuma] = await ejecutar(sql`SELECT COALESCE(sum(${CATALOGO_SQL.soat_pagados_valor.valor!}), 0)::int AS v FROM ${DESDE_SOAT}
      WHERE ${flitoSoat.companiaId} = ${cia} AND ${sql.join([...CATALOGO_SQL.soat_pagados_valor.fijas, ...pagoDe('soat_pagados_valor')], sql` AND `)}`);
    expect(Number(soatSuma!.v)).toBe(1_000);
    const [impSuma] = await ejecutar(sql`SELECT COALESCE(sum(${CATALOGO_SQL.impuestos_pagados.valor!}), 0)::int AS v
      FROM ${CATALOGO_SQL.impuestos_pagados.desde}
      WHERE ${flitoImpuestos.companiaId} = ${cia} AND ${sql.join([...CATALOGO_SQL.impuestos_pagados.fijas, ...pagoDe('impuestos_pagados')], sql` AND `)}`);
    expect(Number(impSuma!.v)).toBe(2_000);
    // Los conjuntos del detalle (B3) usan el mismo corte: pagados del periodo y «por estado» sin cubo `descartado`.
    const sinUmbral = {} as never;
    for (const [id, desde, col] of [
      ['soat_pagados_periodo', DESDE_SOAT, flitoSoat.companiaId], ['soat_por_estado', DESDE_SOAT, flitoSoat.companiaId],
      ['impuestos_pagados_periodo', DESDE_IMPUESTOS, flitoImpuestos.companiaId], ['impuestos_por_estado', DESDE_IMPUESTOS, flitoImpuestos.companiaId],
    ] as const) {
      const fijas = CONJUNTOS_PRODUCTOS_SQL[id].propia(sinUmbral);
      const [c] = await ejecutar(sql`SELECT count(*)::int AS n FROM ${desde} WHERE ${col} = ${cia} AND ${sql.join(fijas, sql` AND `)}`);
      expect(Number(c!.n), id).toBe(1);
    }
  });

  it('Finanzas (decisión 6): anulado y abortado fuera del reporte y sus totales; el revocado SUMA y lleva su vigencia', async () => {
    const vivo = await tramite();
    const anulado = await tramite({ muerte: 'Anulado' });
    const abortado = await tramite({ muerte: 'Abortado' });
    const revocado = await tramite({ muerte: 'Revocado' });
    for (const [id, valor] of [[vivo, 1_000], [anulado, 20_000], [abortado, 300_000], [revocado, 4_000]] as const) {
      await s.derecho({ tramiteId: id, cia, organismo: '05001', valor, fechaPago: '2035-03-05' });
    }

    const filas = await filasParaExportar({ empresas: [nit] });
    expect(filas.map((f) => f.tramiteId).sort()).toEqual([vivo, revocado].sort());
    expect(filas.find((f) => f.tramiteId === revocado)!.vigenciaTramite).toBe('revocado');
    expect(filas.find((f) => f.tramiteId === vivo)!.vigenciaTramite).toBe('vigente');

    const { totales } = await totalesReporteCostos({ empresas: [nit] });
    expect(totales.derechoTramite).toBe(5_000);

    // Gastos diarios: el derecho de un anulado/abortado no suma; el del revocado sí.
    const [d] = await ejecutar(sql`SELECT COALESCE(sum(valor), 0)::int AS v FROM flito_derechos_tramite
      WHERE compania_id = ${cia} AND ${sumaEnFinanzasPorTramite(flitoDerechosTramite.tramiteId)}`);
    expect(Number(d!.v)).toBe(5_000);
  });

  it('Finanzas «ya_contado»: el costo del SOAT compartido no se atribuye a un anulado más antiguo, sino al vivo', async () => {
    const anulado = await tramite({ muerte: 'Anulado', creado: '2035-03-01T00:00:00Z' });
    const vivo = await tramite({ creado: '2035-03-02T00:00:00Z' });
    const otro = await tramite({ creado: '2035-03-03T00:00:00Z' });
    const soat = await soatDe(anulado, 'pagado');
    await tx`UPDATE flito_tramites SET soat_id = ${soat} WHERE id IN (${vivo}, ${otro})`;
    const filas = await filasParaExportar({ empresas: [nit] });
    const costoDe = (id: string) => filas.find((f) => f.tramiteId === id) as unknown as { costoProveedorSoat?: { estado: string; contadoEnTramiteId?: string | null } };
    expect(costoDe(vivo).costoProveedorSoat?.estado).not.toBe('ya_contado');
    expect(costoDe(otro).costoProveedorSoat).toMatchObject({ estado: 'ya_contado', contadoEnTramiteId: vivo });
  });

  it('cruces por placa (D10, recibos): un trámite muerto cuyo impuesto aún no se descartó (carrera) no es candidato', async () => {
    const placa = placaNueva();
    const muerto = await tramite({ placa, muerte: 'Anulado' });
    await impuestoDe(muerto, 'solicitado');
    const lote = { esGestor: false, organismos: [], porAlcance: sql`${flitoImpuestos.companiaId} = ${cia}`, porDefecto: 0, umbrales: new Map() };
    expect(await buscarCandidato(placa, 'solicitado' as never, lote as never)).toBeNull();
    const vivo = await tramite({ placa });
    const impVivo = await impuestoDe(vivo, 'solicitado');
    expect((await buscarCandidato(placa, 'solicitado' as never, lote as never))?.impuestoId).toBe(impVivo);
  });

  it('cruces por placa (D10, comprobantes): un trámite muerto con la misma placa no es candidato', async () => {
    const placa = placaNueva();
    const vivo = await tramite({ placa });
    await tramite({ placa, muerte: 'Anulado' });
    await tramite({ placa, muerte: 'Revocado' });
    const porLlave = await candidatosPorLlave({ placa, idFlit: null, vin: null });
    expect(porLlave.candidatos.map((c) => c.tramiteId)).toEqual([vivo]);
    expect((await candidatosPorTexto(placa)).map((c) => c.tramiteId)).toEqual([vivo]);
  });
});
