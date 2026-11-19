// Torre de Control Gerencial (Épica #14590, B3) — Torre › Productos (SOAT · Impuestos · Derechos).
//   · Sin base: catálogo de los conjuntos nuevos (definición, frase y frase en 0; origen = `torre.tablero_productos.ver`),
//     columnas declaradas == columnas con SQL, sin PII prohibida (B3-AC2: ni dirección, ni VIN, ni póliza completa, ni
//     nada del titular), `tablaPiiDe` por entidad y guardas de la ruta (401/403).
//   · Contra PostgreSQL real (tx con ROLLBACK, `torre-pg.ts`; se salta sin TEST_DATABASE_URL):
//     B3-AC1: cada KPI, desglose y fila de tabla abre un detalle cuyo `total` es su cifra (y su `valorTotal`, el valor);
//     los 13 conjuntos nuevos se comprueban con datos; B3-AC2 sobre filas reales; B3-AC3: «SOAT gestionados» por compañía
//     == su detalle por fila.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CONJUNTOS_PRODUCTOS_TORRE, DETALLE_METRICA_TORRE, FUNCION_TABLERO_PRODUCTOS_TORRE, conjuntoTorre,
  type ConjuntoTorreId, type ConsultaDetalle, type DestinoCifra, type FiltroTorre, type TableroProductos,
} from '@operaciones/shared-types';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { tableroProductos } = await import('../../../src/modules/flito-torre/flito-torre.productos.service.js');
const { consultarDetalle, DetalleSinOrigenError, tablaPiiDe, proyectaPlaca } = await import('../../../src/modules/flito-torre/flito-torre.detalle.service.js');
const { consultarMetrica } = await import('../../../src/modules/flito-torre/flito-torre.metricas.service.js');
const { CONJUNTOS_SQL } = await import('../../../src/modules/flito-torre/flito-torre.conjuntos.js');
const { CATALOGO_SQL } = await import('../../../src/modules/flito-torre/flito-torre.catalogo.js');
const { libroTablero } = await import('../../../src/modules/flito-torre/flito-torre.tablero-export.js');
const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { default: tableros } = await import('../../../src/modules/flito-torre/flito-torre.tableros.routes.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';
import { conCadena } from '../../helpers/auth.js';

const TODO = { enlace: 'ninguno' } as const;
const HOY = '2035-03-31';
const PRODUCTOS = new Set([FUNCION_TABLERO_PRODUCTOS_TORRE, 'torre.tablero_operativo.ver']);
const IDS = CONJUNTOS_PRODUCTOS_TORRE.map((c) => c.id) as ConjuntoTorreId[];
const dialecto = new PgDialect();
const texto = (s: Parameters<PgDialect['sqlToQuery']>[0]) => dialecto.sqlToQuery(s).sql;

describe('catálogo de Productos (B3) — sin base', () => {
  it('13 conjuntos con definición, frase y frase en 0; los abre `torre.tablero_productos.ver`', () => {
    expect(IDS).toHaveLength(13);
    for (const c of CONJUNTOS_PRODUCTOS_TORRE) {
      expect(c.definicion.length, c.id).toBeGreaterThan(40);
      expect(c.frase, c.id).toContain('{n}');
      expect(c.fraseVacio.length, c.id).toBeGreaterThan(10);
      expect(c.funcionesOrigen, c.id).toEqual([FUNCION_TABLERO_PRODUCTOS_TORRE]);
      expect(CONJUNTOS_SQL[c.id], c.id).toBeDefined();
    }
  });

  it('cada columna declarada (conjuntos y métricas nuevas) tiene su SQL: ninguna se cae en silencio', () => {
    for (const c of CONJUNTOS_PRODUCTOS_TORRE) {
      for (const col of c.columnas) expect(CONJUNTOS_SQL[c.id].cols[col], `${c.id}.${col}`).toBeDefined();
      expect(c.columnas, c.id).toContain(c.ordenDefecto.columna);
    }
    for (const m of ['soat_gestionados', 'soat_pagados_valor', 'impuestos_gestionados', 'derechos_registrados'] as const) {
      const cols = CATALOGO_SQL[m].colsDetalle!;
      for (const col of DETALLE_METRICA_TORRE[m].columnas) if (col !== 'valor') expect(cols[col], `${m}.${col}`).toBeDefined();
    }
  });

  it('B3-AC2: ninguna columna proyecta dirección, VIN, póliza completa, póliza del RUNT ni datos del titular', () => {
    const prohibidas = /direccion|"vin"|poliza_runt|flito_compradores|numero_documento|nombre_completo|correo|celular|storage_key/;
    for (const c of CONJUNTOS_PRODUCTOS_TORRE) {
      for (const col of c.columnas) {
        const s = texto(CONJUNTOS_SQL[c.id].cols[col]!);
        expect(s, `${c.id}.${col}`).not.toMatch(prohibidas);
        // La póliza SOLO como sus 4 últimos.
        if (s.includes('numero_poliza')) expect(s, `${c.id}.${col}`).toMatch(/right\(btrim\("flito_soat"\."numero_poliza"\), 4\)/);
      }
    }
    expect(texto(CONJUNTOS_SQL.soat_por_vencer.cols.poliza_ultimos!)).toContain("'…' ||");
  });

  it('tablaPiiDe: la tabla de cada entidad nueva para pii_access_log', () => {
    const filtro: FiltroTorre = { rango: { preset: 'mes_actual' } } as FiltroTorre;
    const tabla = (c: ConjuntoTorreId) => tablaPiiDe({ origen: { tipo: 'conjunto', conjunto: c }, filtro });
    expect(tabla('soat_por_vencer')).toBe('flito_soat');
    expect(tabla('soat_incompletas_abiertas')).toBe('flito_soat_incompletas');
    expect(tabla('impuestos_direccion_pendiente')).toBe('flito_impuestos');
    expect(tabla('derechos_sin_soporte')).toBe('flito_derechos_tramite');
    expect(tabla('derechos_pendientes_sin_resolver')).toBe('flito_derechos_pendientes');
    expect(tablaPiiDe({ origen: { tipo: 'metrica', metrica: 'soat_gestionados' }, filtro })).toBe('flito_soat');
    // Todos proyectan la placa: la lectura se registra (AC10 de B1).
    for (const c of IDS) expect(proyectaPlaca({ origen: { tipo: 'conjunto', conjunto: c }, filtro }), c).toBe(true);
  });

  it('sin `torre.tablero_productos.ver` el detalle de un conjunto de Productos es 403 SIN_ORIGEN', async () => {
    const c: ConsultaDetalle = { origen: { tipo: 'conjunto', conjunto: 'soat_por_vencer' }, filtro: { rango: { desde: '2035-03-01', hasta: HOY } }, pagina: 1, tamano: 25 };
    await expect(consultarDetalle(c, { alcance: TODO, dinero: true, funciones: new Set(['torre.tablero_operativo.ver']), hoy: HOY }))
      .rejects.toBeInstanceOf(DetalleSinOrigenError);
  });
});

// ── Con base ─────────────────────────────────────────────────────────────────────────────────────────

const hoyBogota = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const enDias = (d: number) => new Date(Date.parse(`${hoyBogota()}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!URL_BASE)('Torre › Productos contra PostgreSQL (tx con ROLLBACK)', () => {
  let tx: Awaited<ReturnType<typeof abrirTx>>;
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { tx = await abrirTx(); s = sembrador(tx); await s.organismos('05001', '11001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  async function soat(o: {
    cia: number; organismo?: string; estado: string; creado?: string; pagadoEn?: string | null; valor?: number | null;
    venceEl?: string | null; vigencia?: string; poliza?: string | null; enviadoEn?: string | null;
  }): Promise<string> {
    const tramite = await s.tramite({ cia: o.cia, organismo: o.organismo ?? '05001' });
    const [v] = await tx`SELECT vehiculo_id FROM flito_tramites WHERE id = ${tramite}`;
    const [r] = await tx`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, organismo_codigo, estado, created_at, pagado_en,
        valor_pagado, vence_el, estado_vigencia, numero_poliza, enviado_en)
      VALUES (${`VIN${Math.random().toString(36).slice(2, 12).toUpperCase()}`}, ${v!.vehiculo_id}, ${o.cia}, ${o.organismo ?? '05001'},
        ${o.estado}, ${o.creado ?? '2035-03-10T15:00:00Z'}, ${o.pagadoEn ?? null}, ${o.valor ?? null}, ${o.venceEl ?? null},
        ${o.vigencia ?? 'no_verificado'}, ${o.poliza ?? null}, ${o.enviadoEn ?? null})
      RETURNING id`;
    await tx`UPDATE flito_tramites SET soat_id = ${r!.id} WHERE id = ${tramite}`;
    return r!.id as string;
  }

  async function impuesto(o: {
    cia: number; organismo?: string; estado: string; creado?: string; pagadoEn?: string | null; valor?: number | null;
    diferencia?: boolean; direccion?: boolean; motivo?: string | null; enviadoEn?: string | null;
  }) {
    const tramite = await s.tramite({ cia: o.cia, organismo: o.organismo ?? '05001' });
    await tx`INSERT INTO flito_impuestos (tramite_id, organismo_codigo, compania_id, modalidad_aplicada, estado, created_at, pagado_en,
        valor_pagado, valor_liquidado, marcado_por_diferencia, direccion_pendiente_revision, motivo_rechazo, enviado_en, direccion_factura)
      VALUES (${tramite}, ${o.organismo ?? '05001'}, ${o.cia}, 'requiere_gestion', ${o.estado}, ${o.creado ?? '2035-03-10T15:00:00Z'},
        ${o.pagadoEn ?? null}, ${o.valor ?? null}, ${o.valor ?? null}, ${o.diferencia ?? false}, ${o.direccion ?? false},
        ${o.motivo ?? null}, ${o.enviadoEn ?? null}, 'CALLE SECRETA 1 # 2-3')`;
  }

  async function soporte(campo: 'derecho_id' | null, id: string | null): Promise<string> {
    const [r] = await tx`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, subido_por_nombre, derecho_id)
      VALUES ('derecho', 'r.pdf', 'application/pdf', ${`k/${Math.random()}`}, ${'0'.repeat(64)}, 10, 'Prueba', ${campo ? id : null}) RETURNING id`;
    return r!.id as string;
  }

  async function escenario() {
    const x = await s.cia('X'); const y = await s.cia('Y');
    const haceDias = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    // SOAT: 2 pagados en marzo (uno en 11001), 1 por vencer en 10 días, 1 que vence en 90 (no cuenta), 1 vencido (no
    // cuenta), 1 solicitado sin soporte hace 3 días (sin gestión), 1 pendiente.
    await soat({ cia: x, estado: 'pagado', pagadoEn: '2035-03-15T15:00:00Z', valor: 500_000, poliza: 'AB123456789' });
    await soat({ cia: y, organismo: '11001', estado: 'pagado', pagadoEn: '2035-03-20T15:00:00Z', valor: 300_000 });
    await soat({ cia: x, estado: 'pagado', pagadoEn: '2035-02-10T15:00:00Z', valor: 1, venceEl: enDias(10), vigencia: 'vigente', creado: '2035-02-01T15:00:00Z' });
    await soat({ cia: x, estado: 'pagado', pagadoEn: '2035-02-10T15:00:00Z', valor: 1, venceEl: enDias(90), vigencia: 'vigente', creado: '2035-02-01T15:00:00Z' });
    await soat({ cia: x, estado: 'pagado', pagadoEn: '2035-02-10T15:00:00Z', valor: 1, venceEl: enDias(-1), vigencia: 'vigente', creado: '2035-02-01T15:00:00Z' });
    await soat({ cia: y, estado: 'solicitado', enviadoEn: haceDias(3) });
    await soat({ cia: y, estado: 'pendiente' });
    await tx`INSERT INTO flito_soat_incompletas (soat_id_reservado, compania_id, vin, solicitado_por_nombre, tipo_soat)
      VALUES (gen_random_uuid(), ${x}, 'VINSECRETO1234567', 'Prueba', 'renovacion'),
        (gen_random_uuid(), ${y}, 'VINSECRETO7654321', 'Prueba', 'renovacion')`;
    // Impuestos.
    await impuesto({ cia: x, estado: 'pagado', pagadoEn: '2035-03-12T15:00:00Z', valor: 200_000 });
    await impuesto({ cia: x, estado: 'con_novedad', motivo: 'Factura ilegible' });
    await impuesto({ cia: y, estado: 'con_novedad', motivo: 'Factura ilegible' });
    await impuesto({ cia: y, estado: 'con_novedad', motivo: null });
    await impuesto({ cia: x, estado: 'solicitado', diferencia: true, enviadoEn: haceDias(3) });
    await impuesto({ cia: y, estado: 'pendiente', direccion: true });
    // Derechos: 2 pagados en marzo (uno con soporte), 1 de febrero; y 1 recibo pendiente sin resolver en 05001.
    const t1 = await s.tramite({ cia: x }); const t2 = await s.tramite({ cia: y, organismo: '11001' }); const t3 = await s.tramite({ cia: x });
    await s.derecho({ tramiteId: t1, cia: x, organismo: '05001', valor: 90_000, fechaPago: '2035-03-05' });
    await s.derecho({ tramiteId: t2, cia: y, organismo: '11001', valor: 70_000, fechaPago: '2035-03-06' });
    await s.derecho({ tramiteId: t3, cia: x, organismo: '05001', valor: 1, fechaPago: '2035-02-06' });
    const [d1] = await tx`SELECT id FROM flito_derechos_tramite WHERE tramite_id = ${t1}`;
    await soporte('derecho_id', d1!.id as string);
    const sop = await soporte(null, null);
    await tx`INSERT INTO flito_derechos_pendientes (concepto, placa, soporte_id, organismo_codigo, valor, fecha_pago, origen)
      VALUES ('derecho', 'ZQ9999', ${sop}, '05001', 50000, '2035-03-01', 'manual')`;
    return { x, y, filtro: { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [x, y] } as FiltroTorre };
  }

  const detalle = (filtro: FiltroTorre, d: DestinoCifra, dinero = true) => {
    if (d.tipo !== 'conjunto') throw new Error('se esperaba un destino de conjunto');
    return consultarDetalle({ origen: d.origen, segmentos: d.segmentos, filtro, pagina: 1, tamano: 100 },
      { alcance: TODO, dinero, funciones: PRODUCTOS, hoy: HOY });
  };

  /** Todas las cifras del tablero con su destino (KPI, desglose, filas y totales de las tablas). */
  function cifras(t: TableroProductos): { que: string; n: number; valor?: number | null; destino: DestinoCifra; otros?: boolean }[] {
    const out: { que: string; n: number; valor?: number | null; destino: DestinoCifra; otros?: boolean }[] = [];
    for (const p of ['soat', 'impuestos', 'derechos'] as const) {
      const pes = t[p];
      for (const [k, e] of Object.entries(pes.explicaciones)) {
        out.push({ que: `${p}.${k}`, n: (pes.cifras as unknown as Record<string, number>)[k]!, destino: e!.destino });
        for (const d of e!.desglose ?? []) out.push({ que: `${p}.${k}.${d.etiqueta}`, n: d.valor, destino: d.destino! });
      }
      for (const tb of pes.tablas) {
        for (const f of [...tb.filas, tb.total]) {
          out.push({ que: `${p}.${tb.conjunto}.${f.clave}`, n: f.n, valor: f.valor, destino: f.destino, otros: f.clave === '__otros' });
        }
      }
    }
    return out;
  }

  it('B3-AC1: cada KPI, desglose y fila abre un detalle con su mismo número (y valor); los 13 conjuntos con datos', async () => {
    const { filtro } = await escenario();
    const ctx = { filtro, alcance: TODO, dinero: true, hoy: HOY };
    const t = await tableroProductos(ctx);
    const vistos = new Set<string>();
    for (const c of cifras(t)) {
      if (c.n === 0 || c.otros) { expect(c.destino, c.que).toEqual({ tipo: 'ninguno' }); continue; }
      const d = await detalle(filtro, c.destino);
      expect(d.total, c.que).toBe(c.n);
      if (c.valor != null) expect(d.valorTotal, c.que).toBe(c.valor);
      if (c.destino.tipo === 'conjunto' && c.destino.origen.tipo === 'conjunto') vistos.add(c.destino.origen.conjunto);
    }
    for (const id of IDS) expect(vistos.has(id), `conjunto ${id} sin datos en el escenario`).toBe(true);
    expect(vistos.has('soat_sin_gestion') && vistos.has('impuesto_sin_gestion')).toBe(true);

    // Números esperados (las condiciones, no solo la invariante).
    expect(t.soat.cifras).toMatchObject({ pagadosPeriodo: 2, pagadosValor: 800_000, porVencer: 1, sinGestion: 1, vigenciaNoVerificada: 2 });
    expect(t.impuestos.cifras).toMatchObject({ pagadosPeriodo: 1, pagadosValor: 200_000, sinGestion: 1, conDiferencia: 1, direccionPendiente: 1 });
    expect(t.derechos.cifras).toMatchObject({ pagadosPeriodo: 2, pagadosValor: 160_000, sinSoporte: 2 });
    expect(t.derechos.cifras.pendientesSinResolver).toBeGreaterThanOrEqual(1);
    expect(t.soat.tablas[0]!.filas.map((f) => [f.clave, f.n])).toEqual([['pendiente', 1], ['solicitado', 1], ['con_novedad', 0], ['pagado', 2]]);
    expect(t.impuestos.tablas[1]!.filas.map((f) => [f.etiqueta, f.n])).toEqual([['Factura ilegible', 2], ['Sin motivo', 1]]);
    expect(t.soat.explicaciones.pagadosPeriodo!.frase).toBe('2 SOAT pagados en el periodo. Valor pagado: $800.000.');
    expect(t.soat.explicaciones.porVencer!.definicion).toContain('30 días');
  });

  it('las cifras de pago son las métricas del Explorador (mismo número y valor)', async () => {
    const { filtro } = await escenario();
    const t = await tableroProductos({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    const imp = await consultarMetrica({ metrica: 'impuestos_pagados', filtro }, TODO, { dinero: true, hoy: HOY });
    const der = await consultarMetrica({ metrica: 'derechos_pagados', filtro }, TODO, { dinero: true, hoy: HOY });
    expect(imp.total.valor).toBe(t.impuestos.cifras.pagadosValor);
    expect(imp.total.n).toBe(t.impuestos.cifras.pagadosPeriodo);
    expect(der.total.valor).toBe(t.derechos.cifras.pagadosValor);
    expect(der.total.n).toBe(t.derechos.cifras.pagadosPeriodo);
  });

  it('B3-AC2: las filas reales no traen dirección, VIN ni la póliza completa', async () => {
    const { filtro } = await escenario();
    const t = await tableroProductos({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    let filas = 0;
    for (const c of cifras(t)) {
      if (!c.n || c.otros) continue;
      const d = await detalle(filtro, c.destino);
      const plano = JSON.stringify(d.filas);
      expect(plano, c.que).not.toMatch(/CALLE SECRETA|VINSECRETO|AB123456789|123456789/);
      filas += d.filas.length;
    }
    expect(filas).toBeGreaterThan(20);
    const pagados = await detalle(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'soat_pagados_periodo' } });
    const polizas = pagados.filas.map((f) => f.celdas.poliza_ultimos);
    expect(polizas).toHaveLength(2);
    expect(polizas).toContain('…6789');
    expect(polizas).toContain(null);
  });

  it('sin permiso de dinero: valores en null, la frase no dice el valor y el detalle tampoco', async () => {
    const { filtro } = await escenario();
    const t = await tableroProductos({ filtro, alcance: TODO, dinero: false, hoy: HOY });
    expect(t.soat.cifras.pagadosValor).toBeNull();
    expect(t.soat.explicaciones.pagadosPeriodo!.frase).toBe('2 SOAT pagados en el periodo.');
    expect(t.soat.tablas[0]!.filas.every((f) => f.valor === null)).toBe(true);
    const d = await detalle(filtro, t.soat.explicaciones.pagadosPeriodo!.destino, false);
    expect(d.valorTotal).toBeNull();
    expect(d.filas.every((f) => f.celdas.valor === null)).toBe(true);
    // El Excel tampoco lleva las filas de dinero.
    const libro = await libroTablero('productos', { filtro, alcance: TODO, dinero: false, hoy: HOY });
    expect(JSON.stringify(libro.hojas[0]!.filas)).not.toContain('Valor pagado');
    expect(libro.hojas.at(-1)!.nombre).toBe('Definiciones');
  });

  it('B3-AC3: «SOAT gestionados» por compañía: cada fila abre un detalle con un total igual a la fila', async () => {
    const { filtro } = await escenario();
    for (const fechaBase of ['creacion', 'pago'] as const) {
      const r = await consultarMetrica({ metrica: 'soat_gestionados', filtro, fechaBase, agrupacion: 'compania' }, TODO, { dinero: true, hoy: HOY });
      expect(r.filas.length, fechaBase).toBe(2);
      for (const f of r.filas) {
        const d = await consultarDetalle({ origen: { tipo: 'metrica', metrica: 'soat_gestionados', fechaBase },
          segmentos: [{ dimension: 'compania', valores: [f.clave] }], filtro, pagina: 1, tamano: 25 },
        { alcance: TODO, dinero: true, funciones: new Set(['torre.metricas.consultar']), hoy: HOY });
        expect(d.total, `${fechaBase} ${f.clave}`).toBe(f.valor);
        expect(d.filas.every((x) => typeof x.celdas.placa === 'string')).toBe(true);
      }
    }
    // Las otras tres métricas nuevas: el total de la métrica == el total (o la suma) de su detalle. Los derechos del
    // escenario se registran hoy (fuera de marzo de 2035): se miden por su fecha de pago.
    for (const [metrica, fechaBase] of [['soat_pagados_valor', 'pago'], ['impuestos_gestionados', 'creacion'], ['derechos_registrados', 'pago']] as const) {
      const r = await consultarMetrica({ metrica, filtro, fechaBase }, TODO, { dinero: true, hoy: HOY });
      const d = await consultarDetalle({ origen: { tipo: 'metrica', metrica, fechaBase }, filtro, pagina: 1, tamano: 25 },
        { alcance: TODO, dinero: true, funciones: new Set(['torre.metricas.consultar']), hoy: HOY });
      if (metrica === 'soat_pagados_valor') expect(d.valorTotal).toBe(r.total.valor);
      else expect(d.total, metrica).toBe(r.total.valor);
      expect(d.total, metrica).toBeGreaterThan(0);
    }
  });
});

// ── Ruta ─────────────────────────────────────────────────────────────────────────────────────────────

const filas = new Map<number, FilasPermisos>();
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const app = express();
app.use(express.json());
app.use('/api/flito/torre/tableros', tableros);
const MARZO = { filtro: { rango: { desde: '2035-03-01', hasta: '2035-03-31' } } };

describe('POST /tableros/productos y /productos/exportar — guardas (B3-AC1)', () => {
  beforeEach(() => {
    filas.clear();
    permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
    for (const i of [1, 2]) permisos.invalidarPermisosDe(i);
    filas.set(1, { rol: 'r1', tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(['accion.torre_operativa.ver']), excepciones: [] });
    filas.set(2, { rol: 'r2', tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(['accion.torre_productos.ver']), excepciones: [] });
  });

  for (const ruta of ['/productos', '/productos/exportar']) {
    it(`${ruta}: 401 sin token y 403 sin torre.tablero_productos.ver (aunque vea Operativa)`, async () => {
      expect((await request(app).post(`/api/flito/torre/tableros${ruta}`).send(MARZO)).status).toBe(401);
      const r = await request(app).post(`/api/flito/torre/tableros${ruta}`).set('Authorization', `Bearer ${await token(1)}`).send(MARZO);
      expect(r.status).toBe(403);
    });
  }

  it('exportar exige además torre.metricas.exportar (403) y un body inválido es 400', async () => {
    const auth = { Authorization: `Bearer ${await token(2)}` };
    expect((await request(app).post('/api/flito/torre/tableros/productos/exportar').set(auth).send(MARZO)).status).toBe(403);
    expect((await request(app).post('/api/flito/torre/tableros/productos').set(auth).send({ ...MARZO, otro: 1 })).status).toBe(400);
  });

  it('el catálogo declara el umbral del conjunto por vencer', () => {
    expect(conjuntoTorre('soat_por_vencer').umbral).toBe('dias_soat_por_vencer');
  });
});
