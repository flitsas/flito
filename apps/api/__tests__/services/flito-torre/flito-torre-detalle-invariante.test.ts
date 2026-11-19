// Torre de Control Gerencial (Épica #14590, ADR-0047, B1a) — la INVARIANTE central contra PostgreSQL real (tx con
// ROLLBACK, `torre-pg.ts`; se salta sin TEST_DATABASE_URL): con el mismo filtro, la cifra del tablero (o la celda del
// Explorador) es igual al `total` del detalle — y, en las de suma, a su `valorTotal` — por cada conjunto de B1 (AC1, AC5,
// AC12). Más: filtrar, ordenar y paginar sin repetir (AC6), placa/compañía/estado sin datos del titular (AC4), y dinero
// en `null` sin permiso (AC9).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONJUNTOS_TORRE, type ConsultaDetalle, type ConjuntoTorreId, type FiltroTorre, type SegmentoDetalle } from '@operaciones/shared-types';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { tableroComercial } = await import('../../../src/modules/flito-torre/flito-torre.comercial.service.js');
const { tableroOperativo } = await import('../../../src/modules/flito-torre/flito-torre.operativa.service.js');
const { tableroFinanciero } = await import('../../../src/modules/flito-torre/flito-torre.financiera.service.js');
const { consultarMetrica } = await import('../../../src/modules/flito-torre/flito-torre.metricas.service.js');
const { consultarDetalle } = await import('../../../src/modules/flito-torre/flito-torre.detalle.service.js');
const { valoresUmbrales } = await import('../../../src/modules/flito-torre/flito-torre.umbrales.service.js');

const TODO = { enlace: 'ninguno' } as const;
const HOY = '2035-03-31';
const FUNCIONES = new Set(['torre.tablero_ejecutivo.ver', 'torre.tablero_comercial.ver', 'torre.tablero_operativo.ver', 'torre.tablero_financiero.ver', 'torre.metricas.consultar']);
const haceHoras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const haceDias = (d: number) => haceHoras(d * 24);

describe.skipIf(!URL_BASE)('invariante cifra == total del detalle (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  let tx: Awaited<ReturnType<typeof abrirTx>>;
  beforeEach(async () => { tx = await abrirTx(); s = sembrador(tx); await s.organismos('05001', '11001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  const detalle = (filtro: FiltroTorre, origen: ConsultaDetalle['origen'], o: Partial<ConsultaDetalle> = {}, dinero = true) =>
    consultarDetalle({ origen, filtro, pagina: 1, tamano: 25, ...o }, { alcance: TODO, dinero, funciones: FUNCIONES, hoy: HOY });
  const total = async (filtro: FiltroTorre, c: ConjuntoTorreId, segmentos?: SegmentoDetalle[]) =>
    (await detalle(filtro, { tipo: 'conjunto', conjunto: c }, { segmentos })).total;

  let nSoporte = 0;
  const soporte = async (o: { soatId?: string; impuestoId?: string; derechoId?: string; descartado?: boolean }) => {
    nSoporte++;
    await tx`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, soat_id, impuesto_id,
        derecho_id, subido_por_nombre, descartado)
      VALUES ('comprobante', 'prueba.pdf', 'application/pdf', ${`torre/prueba/${Date.now()}-${nSoporte}`}, ${`h${Date.now()}${nSoporte}`.slice(0, 64)}, 10,
        ${o.soatId ?? null}, ${o.impuestoId ?? null}, ${o.derechoId ?? null}, 'Prueba', ${o.descartado ?? false})`;
  };

  /** Siembra un escenario que toca los 14 conjuntos de B1 en `x`, `y` y `z` (soportes 0/1/2/3 en `z`). */
  async function escenario() {
    const u = await valoresUmbrales();
    const x = await s.cia('X'); const y = await s.cia('Y');
    const dB = u.dias_borrador_abandonado; const dOt = u.dias_respuesta_ot; const h = u.horas_soat_impuesto_sin_soporte;
    // Foto: 2 borradores abandonados (1 pasa del doble), 1 reciente; 2 estancados en el organismo (1 crítico).
    await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: haceDias(dB + 1) });
    await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: haceDias(dB * 2 + 1) });
    await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: haceHoras(2) });
    const e1 = await s.tramite({ cia: x, flitEstado: 'Entregado', organismo: '11001', creadoFlit: haceDias(dOt * 3 + 5) });
    await s.historial(e1, 'Asignado', 'Entregado', haceDias(dOt + 1));
    const e2 = await s.tramite({ cia: x, flitEstado: 'Enviado a OT', organismo: '11001', creadoFlit: haceDias(dOt * 3 + 5) });
    await s.historial(e2, 'Asignado', 'Enviado a OT', haceDias(dOt * 2 + 1));
    // SOAT e impuesto sin gestión: uno sobre el umbral y uno sobre el doble de cada uno.
    for (const horas of [h + 1, h * 2 + 1]) {
      const vin = `VS${horas}${Date.now() % 100_000_000}`;
      const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${`ZS${horas % 100}${Date.now() % 100}`}, ${vin}) RETURNING id`;
      await tx`INSERT INTO flito_soat (vin, vehiculo_id, estado, compania_id, enviado_en) VALUES (${vin}, ${v!.id}, 'solicitado', ${x}, ${haceHoras(horas)})`;
      const ti = await s.tramite({ cia: x, flitEstado: 'Asignado', creadoFlit: haceDias(30) });
      await s.impuesto({ tramiteId: ti, cia: x, organismo: '05001', valorPagado: null, pagadoEn: null, estado: 'solicitado' });
      await tx`UPDATE flito_impuestos SET enviado_en = ${haceHoras(horas)} WHERE tramite_id = ${ti}`;
    }
    // Periodo (marzo de 2035): creados, radicado, rechazado, aprobados con liquidación, con factura y con viaje.
    const t1 = await s.tramite({ cia: x, organismo: '11001', creadoFlit: '2035-03-02T15:00:00Z', aprobado: '2035-03-04T15:00:00Z' });
    await s.liquidacion(t1, { total: 100_000, logistica: 40_000, digital: 60_000 });
    await s.factura(t1, { creada: '2035-03-06T15:00:00Z' });
    const t2 = await s.tramite({ cia: x, organismo: '11001', creadoFlit: '2035-03-03T15:00:00Z', aprobado: '2035-03-05T15:00:00Z' });
    await s.liquidacion(t2, { total: 150_000, logistica: 60_000, digital: 90_000 });
    await s.viaje(t2, 2, 20_000);
    const t3 = await s.tramite({ cia: x, creadoFlit: '2035-03-04T15:00:00Z', flitEstado: 'Entregado' });
    await s.historial(t3, 'Asignado', 'Entregado', '2035-03-05T15:00:00Z');
    await s.tramite({ cia: x, organismo: '11001', creadoFlit: '2035-03-05T15:00:00Z', flitEstado: 'Rechazado' });
    const anulado = await s.tramite({ cia: x, creadoFlit: '2035-03-06T15:00:00Z', aprobado: '2035-03-07T15:00:00Z', flitEstado: 'Anulado' });
    await s.liquidacion(anulado, { total: 999_000, logistica: 9_000 });
    await s.tramite({ cia: y, creadoFlit: '2035-03-07T15:00:00Z', aprobado: '2035-03-08T15:00:00Z' });
    // Soportes (AC5): tercera compañía con aprobados de 1 (derecho), 2 (impuesto + derecho) y 3 soportes, y un
    // soporte DESCARTADO que no cuenta. Los demás aprobados del escenario quedan con 0.
    const z = await s.cia('Z');
    const conSoportes = async (n: 1 | 2 | 3, dia: string) => {
      const id = await s.tramite({ cia: z, creadoFlit: `2035-03-${dia}T13:00:00Z`, aprobado: `2035-03-${dia}T18:00:00Z` });
      await s.derecho({ tramiteId: id, cia: z, organismo: '05001', valor: 10_000, fechaPago: `2035-03-${dia}` });
      const [d] = await tx`SELECT id FROM flito_derechos_tramite WHERE tramite_id = ${id}`;
      await soporte({ derechoId: d!.id as string });
      if (n >= 2) {
        await s.impuesto({ tramiteId: id, cia: z, organismo: '05001', valorPagado: null, pagadoEn: null });
        const [i] = await tx`SELECT id FROM flito_impuestos WHERE tramite_id = ${id}`;
        await soporte({ impuestoId: i!.id as string });
      } else {
        // Impuesto con su único soporte descartado: sigue faltando.
        await s.impuesto({ tramiteId: id, cia: z, organismo: '05001', valorPagado: null, pagadoEn: null });
        const [i] = await tx`SELECT id FROM flito_impuestos WHERE tramite_id = ${id}`;
        await soporte({ impuestoId: i!.id as string, descartado: true });
      }
      if (n === 3) {
        const vin = `VZ${dia}${Date.now() % 100_000_000}`;
        const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${`ZZ${dia}${Date.now() % 100}`}, ${vin}) RETURNING id`;
        const [so] = await tx`INSERT INTO flito_soat (vin, vehiculo_id, estado, compania_id) VALUES (${vin}, ${v!.id}, 'pagado', ${z}) RETURNING id`;
        await tx`UPDATE flito_tramites SET soat_id = ${so!.id} WHERE id = ${id}`;
        await soporte({ soatId: so!.id as string });
      }
      return id;
    };
    const conUno = await conSoportes(1, '10');
    const conDos = await conSoportes(2, '11');
    const conTres = await conSoportes(3, '12');
    return {
      x, y, z, u, conUno, conDos, conTres,
      filtro: { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [x, y, z] } as FiltroTorre,
    };
  }

  it('AC1 · Operativo: radar, WIP y logística == total de su conjunto (y los críticos == segmento severidad)', async () => {
    const { filtro } = await escenario();
    const t = await tableroOperativo({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    const radar = Object.fromEntries(t.radar.filas.map((f) => [f.causa, f.cantidad]));
    expect(radar.borrador_abandonado).toBe(2);
    for (const c of ['soat_sin_gestion', 'impuesto_sin_gestion', 'borrador_abandonado', 'estancado_ot'] as const) {
      expect(await total(filtro, c), c).toBe(radar[c]);
    }
    expect(await total(filtro, 'borrador_abandonado')).toBe(t.cifras.borradoresAbandonados);
    expect(await total(filtro, 'en_curso')).toBe(t.cifras.wip);
    const critico: SegmentoDetalle[] = [{ dimension: 'severidad', valores: ['critico'] }];
    expect(await total(filtro, 'borrador_abandonado', critico)).toBe(t.explicaciones.borradoresAbandonados!.desglose![0]!.valor);
    expect(await total(filtro, 'borrador_abandonado', critico)).toBe(1);
    expect(await total(filtro, 'borrador_abandonado', [{ dimension: 'severidad', valores: ['atencion'] }])).toBe(1);
    // La frase del encabezado usa el total VIVO del detalle y sus críticos; es la misma de la KPI (una sola fuente).
    const u = await valoresUmbrales();
    const b = await detalle(filtro, { tipo: 'conjunto', conjunto: 'borrador_abandonado' });
    expect(b.frase).toBe(`2 trámites llevan más de ${u.dias_borrador_abandonado} días en Borrador; 1 pasa de ${u.dias_borrador_abandonado * 2} días.`);
    expect(t.explicaciones.borradoresAbandonados!.frase).toBe(b.frase);
    const vacio = await detalle(filtro, { tipo: 'conjunto', conjunto: 'borrador_abandonado' }, { filtrosDetalle: { placa: 'QQ9Q9Q9' } });
    expect(vacio.total).toBe(0);
    expect(vacio.frase).toBe(`Hoy ningún borrador lleva más de ${u.dias_borrador_abandonado} días.`);
    expect(vacio.fraseVacio).toBe(vacio.frase);
    expect(b.fraseVacio).toBe(vacio.frase);
    const est = await detalle(filtro, { tipo: 'conjunto', conjunto: 'estancado_ot' });
    expect(est.frase).toBe(`2 trámites llevan más de ${u.dias_respuesta_ot} días en el organismo sin respuesta; 1 pasa de ${u.dias_respuesta_ot * 2} días.`);
    const gestionesCriticas = (await total(filtro, 'soat_sin_gestion', critico)) + (await total(filtro, 'impuesto_sin_gestion', critico));
    expect(gestionesCriticas).toBe(t.explicaciones.sinGestionFueraAns!.desglose![2]!.valor);
    expect(await total(filtro, 'entregas_logistica')).toBe(t.logistica.entregas);
    expect(await total(filtro, 'entregas_logistica', [{ dimension: 'nivel', valores: ['primer_intento'] }])).toBe(t.logistica.primerIntento);
    const bog = t.benchmarkOt.filas.find((f) => f.organismoCodigo === '11001')!;
    expect(await total(filtro, 'tramites_creados', [{ dimension: 'organismo', valores: ['11001'] }])).toBe(bog.volumen);
    expect(await total(filtro, 'rechazados_cohorte', [{ dimension: 'organismo', valores: ['11001'] }])).toBe(Math.round((bog.volumen * bog.pctRechazado) / 100));
    expect(await total(filtro, 'aprobados_cohorte', [{ dimension: 'organismo', valores: ['11001'] }])).toBe(Math.round((bog.volumen * bog.pctAprobado) / 100));
    // La fila del radar lleva su destino al conjunto (AC13).
    expect(t.radar.filas.find((f) => f.causa === 'borrador_abandonado')!.destino).toEqual({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'borrador_abandonado' } });
  });

  it('AC1/AC2 · Comercial: embudo y trámites del periodo == total; la concentración Top 3 nombra y abre sus compañías', async () => {
    const { filtro } = await escenario();
    const t = await tableroComercial({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    const paso = Object.fromEntries(t.embudo.pasos.map((p) => [p.paso, p.valor]));
    expect(await total(filtro, 'tramites_creados')).toBe(t.cifras.tramitesPeriodo);
    expect(await total(filtro, 'radicados_cohorte')).toBe(paso.radicados);
    expect(await total(filtro, 'aprobados_cohorte')).toBe(paso.aprobados);
    expect(await total(filtro, 'facturados_cohorte')).toBe(paso.facturados);
    expect(paso.facturados).toBe(1);
    const e = t.explicaciones.concentracionTop3Pct!;
    expect(e.definicion).toContain(CONJUNTOS_TORRE.find((c) => c.id === 'tramites_creados')!.definicion);
    // AC2: tres compañías, y la frase nombra las tres con su porcentaje.
    const top3 = t.concentracion.volumen.top.slice(0, 3);
    expect(top3).toHaveLength(3);
    for (const p of top3) expect(e.frase).toContain(`${p.compania} (${p.pct.toLocaleString('es-CO', { maximumFractionDigits: 1 })} %)`);
    expect(e.frase).toMatch(/vienen de 3 compañías: /);
    expect(e.componentes!.map((x) => x.etiqueta)).toEqual(top3.map((p) => p.compania));
    expect(e.frase).not.toMatch(/Top 5/);
    if (e.destino.tipo !== 'conjunto') throw new Error('destino esperado: conjunto');
    expect((await detalle(filtro, e.destino.origen, { segmentos: e.destino.segmentos })).total).toBe(top3.reduce((a, p) => a + p.valor, 0));
  });

  it('AC1/AC5 · Financiero: sin facturar (cifra y valor), soportes 3/3 por nivel y margen == detalle', async () => {
    const { filtro, conUno, conDos, conTres } = await escenario();
    const t = await tableroFinanciero({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    const sf = await detalle(filtro, { tipo: 'conjunto', conjunto: 'sin_facturar' });
    expect(sf.total).toBe(t.cifras.sinFacturarTramites);
    expect(sf.valorTotal).toBe(t.cifras.sinFacturarValor);
    const c = t.conciliacion;
    expect(await total(filtro, 'soportes_aprobados')).toBe(c.total);
    // AC5: hay trámites en los cuatro niveles, y cada nivel del detalle == el del bloque de conciliación.
    expect([c.cero > 0, c.uno, c.dos, c.completos]).toEqual([true, 1, 1, 1]);
    const porNivel = async (n: string) => total(filtro, 'soportes_aprobados', [{ dimension: 'nivel', valores: [n] }]);
    expect([await porNivel('0'), await porNivel('1'), await porNivel('2'), await porNivel('3')]).toEqual([c.cero, c.uno, c.dos, c.completos]);
    const incompletos = await detalle(filtro, { tipo: 'conjunto', conjunto: 'soportes_aprobados' }, { segmentos: [{ dimension: 'nivel', valores: ['0', '1', '2'] }], tamano: 100 });
    expect(incompletos.total).toBe(c.cero + c.uno + c.dos);
    const ids = incompletos.filas.map((f) => f.tramiteId);
    expect(ids).toEqual(expect.arrayContaining([conUno, conDos]));
    expect(ids).not.toContain(conTres);
    const faltan = (id: string) => incompletos.filas.find((f) => f.tramiteId === id)!.celdas.faltan_soportes;
    expect(faltan(conUno)).toEqual(['SOAT', 'Impuesto']);   // el impuesto solo tiene un soporte descartado
    expect(faltan(conDos)).toEqual(['SOAT']);
    expect(incompletos.filas.find((f) => f.tramiteId !== conUno && f.tramiteId !== conDos)!.celdas.faltan_soportes).toEqual(['SOAT', 'Impuesto', 'Derecho']);
    expect(await total(filtro, 'soportes_aprobados', [{ dimension: 'faltante', valores: ['derecho'] }])).toBe(c.cero);
    const ss = t.explicaciones.soportesCompletosPct!;
    if (ss.destino.tipo !== 'conjunto') throw new Error('destino esperado: conjunto');
    expect((await detalle(filtro, ss.destino.origen, { segmentos: ss.destino.segmentos })).total).toBe(c.cero + c.uno + c.dos);
    expect(await total(filtro, 'soportes_aprobados', [{ dimension: 'faltante', valores: ['soat'] }])).toBe(c.total - c.completos);
    const m = await detalle(filtro, { tipo: 'conjunto', conjunto: 'margen_aprobados' });
    expect(m.valorTotal).toBe(t.margen!.porServicio.reduce((a, x) => a + x.cobrado, 0));
    // AC13: la fila de sin facturar («Ver en reporte de costos» en la web) abre el conjunto con SU compañía; la web
    // manda el mismo filtro de la barra, así que el detalle con ese filtro da exactamente la cifra de la fila.
    const fila = t.sinFacturar.filas[0]!;
    expect(fila.destino).toEqual({
      tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'sin_facturar' },
      segmentos: [{ dimension: 'compania', valores: [fila.companiaId == null ? null : String(fila.companiaId)] }],
    });
    if (fila.destino?.tipo !== 'conjunto') throw new Error('destino esperado: conjunto');
    expect((await detalle(filtro, fila.destino.origen, { segmentos: fila.destino.segmentos })).total).toBe(fila.tramites);
  });

  it('AC1/AC12 · Explorador: conteo, suma y tasa == total / valorTotal; la fila por compañía == su segmento', async () => {
    const { filtro, x } = await escenario();
    const m = (metrica: 'tramites_creados' | 'ingreso_liquidado' | 'tasa_aprobacion', agrupacion?: 'compania') =>
      consultarMetrica({ metrica, filtro, agrupacion }, TODO, { dinero: true, hoy: HOY });
    const conteo = await m('tramites_creados', 'compania');
    const dm = await detalle(filtro, { tipo: 'metrica', metrica: 'tramites_creados' });
    expect(dm.total).toBe(conteo.total.valor);
    expect(dm.frase).toBe(`${dm.total} trámites creados con los filtros de arriba.`);
    expect(dm.fraseVacio).toBe('Sin registros de trámites creados con los filtros de arriba.');
    const filaX = conteo.filas.find((f) => f.clave === String(x))!;
    expect((await detalle(filtro, { tipo: 'metrica', metrica: 'tramites_creados' }, { segmentos: [{ dimension: 'compania', valores: [String(x)] }] })).total).toBe(filaX.valor);
    const suma = await m('ingreso_liquidado');
    const ds = await detalle(filtro, { tipo: 'metrica', metrica: 'ingreso_liquidado' });
    expect(ds.total).toBe(suma.total.n);
    expect(ds.valorTotal).toBe(suma.total.valor);
    const tasa = await m('tasa_aprobacion');
    const dt = await detalle(filtro, { tipo: 'metrica', metrica: 'tasa_aprobacion' }, { tamano: 100 });
    expect(dt.total).toBe(tasa.total.n);
    const aprobados = dt.filas.filter((f) => f.celdas.aprobado === true).length;
    expect(Math.round((aprobados / dt.total) * 10_000) / 100).toBe(tasa.total.valor);
  });

  it('AC4/AC9 · columnas sin datos del titular; sin dinero el valor y el valorTotal van en null', async () => {
    const { filtro } = await escenario();
    const b = await detalle(filtro, { tipo: 'conjunto', conjunto: 'borrador_abandonado' });
    expect(b.columnas.map((c) => c.id)).toEqual(expect.arrayContaining(['placa', 'compania', 'estado']));
    for (const k of ['nombre', 'cedula', 'documento', 'vin']) expect(Object.keys(b.filas[0]!.celdas)).not.toContain(k);
    expect(b.filas[0]!.celdas.compania).toMatch(/^X /);
    expect(b.filas[0]!.celdas.estado).toBe('Borrador');
    const sf = await detalle(filtro, { tipo: 'conjunto', conjunto: 'sin_facturar' }, {}, false);
    expect(sf.valorTotal).toBeNull();
    expect(sf.filas.every((f) => f.celdas.valor === null)).toBe(true);
    expect(sf.dineroVisible).toBe(false);
  });

  it('AC6 · filtrar por compañía, ordenar por Creado y pasar a la página 2 sin repetir', async () => {
    const x = await s.cia('X'); const y = await s.cia('Y');
    for (let i = 0; i < 55; i++) await s.tramite({ cia: x, creadoFlit: `2035-03-${String(1 + (i % 28)).padStart(2, '0')}T${String(10 + (i % 10)).padStart(2, '0')}:00:00Z` });
    for (let i = 0; i < 5; i++) await s.tramite({ cia: y, creadoFlit: '2035-03-10T15:00:00Z' });
    const filtro: FiltroTorre = { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [x, y] };
    const pagina = (n: number) => detalle(filtro, { tipo: 'conjunto', conjunto: 'tramites_creados' }, {
      filtrosDetalle: { companiaIds: [x] }, orden: { columna: 'creado_en', dir: 'asc' }, pagina: n, tamano: 25,
    });
    const [p1, p2, p3] = [await pagina(1), await pagina(2), await pagina(3)];
    expect(p1.total).toBe(55);
    const ids = [...p1.filas, ...p2.filas, ...p3.filas].map((f) => f.id);
    expect(ids).toHaveLength(55);
    expect(new Set(ids).size).toBe(55);
    const fechas = [...p1.filas, ...p2.filas, ...p3.filas].map((f) => String(f.celdas.creado_en));
    expect(fechas).toEqual([...fechas].sort());
    expect([...p1.filas, ...p2.filas].every((f) => String(f.celdas.compania).startsWith('X '))).toBe(true);
  });
});
