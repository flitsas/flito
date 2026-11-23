// Torre de Control Gerencial (Épica #14590, B4) — Torre › Logística y Financiera › Facturación · Bolsas.
//   · Sin base: catálogo de los 14 conjuntos nuevos (definición, frase, origen), columnas declaradas == columnas con SQL,
//     sin PII prohibida (B4-AC1: ni dirección de entrega, ni receptor, contacto, quien entrega, coordenadas, storage keys
//     ni el mensajero; de Siigo, nunca el `error_code` crudo ni el payload), `tablaPiiDe`, Zod del segmento `bolsa` y
//     guardas de las rutas nuevas (401/403).
//   · Contra PostgreSQL real (tx con ROLLBACK, `torre-pg.ts`; se salta sin TEST_DATABASE_URL):
//     B4-AC1/AC2/AC3: cada KPI, desglose y fila de los tres tableros abre un detalle cuyo `total` es su cifra; los 14
//     conjuntos nuevos se comprueban con datos; el error de Siigo es legible; las filas reales no traen PII; y la «Bolsa
//     con menor cobertura» del Resumen (B1) es la misma bolsa y la misma cifra que la cobertura de Bolsas.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CONJUNTOS_FINANCIERA_B4_TORRE, CONJUNTOS_LOGISTICA_TORRE, FUNCION_TABLERO_LOGISTICA_TORRE, conjuntoTorre,
  type CifraExplicada, type ConjuntoTorreId, type ConsultaDetalle, type DestinoCifra, type FiltroTorre, type TablaAreaTorre,
} from '@operaciones/shared-types';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { tableroLogistica } = await import('../../../src/modules/flito-torre/flito-torre.logistica.service.js');
const { tableroFacturacion } = await import('../../../src/modules/flito-torre/flito-torre.facturacion.service.js');
const { tableroBolsas } = await import('../../../src/modules/flito-torre/flito-torre.bolsas.service.js');
const { tableroFinanciero } = await import('../../../src/modules/flito-torre/flito-torre.financiera.service.js');
const { consultarDetalle, DetalleSinOrigenError, tablaPiiDe, proyectaPlaca } = await import('../../../src/modules/flito-torre/flito-torre.detalle.service.js');
const { CONJUNTOS_SQL, fragmentoConjunto, SIN_UMBRALES } = await import('../../../src/modules/flito-torre/flito-torre.conjuntos.js');
const { valoresUmbrales } = await import('../../../src/modules/flito-torre/flito-torre.umbrales.service.js');
const { libroTablero } = await import('../../../src/modules/flito-torre/flito-torre.tablero-export.js');
const { TEXTO_ERROR_SIIGO } = await import('../../../src/modules/flito-torre/flito-torre.logistica-sql.js');
const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { default: tableros } = await import('../../../src/modules/flito-torre/flito-torre.tableros.routes.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';
import { conCadena } from '../../helpers/auth.js';
import { proveedorLogistica } from '../../helpers/proveedor-padre.js';

const TODO = { enlace: 'ninguno' } as const;
const HOY = '2035-03-31';
const FUNCIONES = new Set([FUNCION_TABLERO_LOGISTICA_TORRE, 'torre.tablero_financiero.ver']);
const IDS = [...CONJUNTOS_LOGISTICA_TORRE, ...CONJUNTOS_FINANCIERA_B4_TORRE].map((c) => c.id) as ConjuntoTorreId[];
const dialecto = new PgDialect();
const texto = (s: Parameters<PgDialect['sqlToQuery']>[0]) => dialecto.sqlToQuery(s).sql;
const MARZO_FILTRO = { rango: { desde: '2035-03-01', hasta: HOY } } as FiltroTorre;
const ctxSinBase = { filtro: MARZO_FILTRO, alcance: TODO, dinero: true, hoy: HOY };
const U_PRUEBA = { ...SIN_UMBRALES, dias_cobertura_rojo: 7, dias_cobertura_amarillo: 15, dias_traslado_abierto: 3 } as never;

describe('catálogo de Logística y Financiera (B4) — sin base', () => {
  it('14 conjuntos con definición, frase y frase en 0; Logística los abre su función y Financiera la suya', () => {
    expect(IDS).toHaveLength(14);
    for (const c of CONJUNTOS_LOGISTICA_TORRE) expect(c.funcionesOrigen, c.id).toEqual([FUNCION_TABLERO_LOGISTICA_TORRE]);
    for (const c of CONJUNTOS_FINANCIERA_B4_TORRE) expect(c.funcionesOrigen, c.id).toEqual(['torre.tablero_financiero.ver']);
    for (const id of IDS) {
      const c = conjuntoTorre(id);
      expect(c.definicion.length, id).toBeGreaterThan(40);
      expect(c.frase, id).toContain('{n}');
      expect(c.fraseVacio.length, id).toBeGreaterThan(10);
      expect(CONJUNTOS_SQL[id], id).toBeDefined();
    }
    // E2 abre `entregas_logistica` (B1): también con la función de Logística.
    expect(conjuntoTorre('entregas_logistica').funcionesOrigen).toContain(FUNCION_TABLERO_LOGISTICA_TORRE);
    expect(conjuntoTorre('traslados_abiertos_mas_de_n').umbral).toBe('dias_traslado_abierto');
  });

  it('cada columna declarada tiene su SQL (con los umbrales: el semáforo de la bolsa) y el orden por defecto es una de ellas', () => {
    for (const id of IDS) {
      const f = fragmentoConjunto(id, ctxSinBase, U_PRUEBA);
      for (const col of conjuntoTorre(id).columnas) expect(f.cols[col], `${id}.${col}`).toBeDefined();
      expect(conjuntoTorre(id).columnas, id).toContain(conjuntoTorre(id).ordenDefecto.columna);
    }
  });

  it('B4-AC1: ninguna columna proyecta dirección, receptor, contacto, quien entrega, coordenadas, storage keys ni el mensajero', () => {
    const prohibidas = /direccion|contacto|receptor|entrega_nombre|entregado_lat|entregado_lng|storage_key|mensajero|motivo_detalle|registrado_por|cargada_por|conciliada_por|error_detalle|payload|revision_motivo|observacion|"concepto"/;
    for (const id of IDS) {
      const f = fragmentoConjunto(id, ctxSinBase, U_PRUEBA);
      for (const col of conjuntoTorre(id).columnas) expect(texto(f.cols[col]!), `${id}.${col}`).not.toMatch(prohibidas);
    }
  });

  it('el error de Siigo solo se COMPARA (nunca se proyecta el `error_code`): todas sus apariciones son condiciones', () => {
    const s = texto(fragmentoConjunto('facturas_con_error', ctxSinBase, U_PRUEBA).cols.error_factura!);
    const usos = [...s.matchAll(/"siigo_facturas"\."error_code"(.{0,8})/g)].map((m) => m[1]!.trim());
    expect(usos.length).toBeGreaterThan(5);
    for (const u of usos) expect(u, s).toMatch(/^(IS NULL|= \$\d+)/);
    // Cada código y su texto van como parámetros, no concatenados.
    expect(s).not.toContain('siigo_no_responde');
    expect(Object.keys(TEXTO_ERROR_SIIGO)).toContain('siigo_no_responde');
  });

  it('tablaPiiDe: la tabla de cada entidad nueva; proyectaPlaca: actas, viajes, cola y movimientos sí; traslados, facturas, bolsas y boletas no', () => {
    const tabla = (c: ConjuntoTorreId) => tablaPiiDe({ origen: { tipo: 'conjunto', conjunto: c }, filtro: MARZO_FILTRO });
    const placa = (c: ConjuntoTorreId) => proyectaPlaca({ origen: { tipo: 'conjunto', conjunto: c }, filtro: MARZO_FILTRO });
    expect(tabla('traslados_por_estado')).toBe('flito_logistica_traslados');
    expect(tabla('actas_pendientes_entrega')).toBe('flito_logistica_actas');
    expect(tabla('viajes_adicionales_periodo')).toBe('flito_tramite_viajes_logistica');
    expect(tabla('facturas_con_error')).toBe('siigo_facturas');
    expect(tabla('cola_facturacion_atascada')).toBe('siigo_cola_facturacion');
    expect(tabla('bolsas_cobertura')).toBe('flito_bolsas_unicas');
    expect(tabla('movimientos_bolsa_periodo')).toBe('flito_bolsas_unicas_movimientos');
    expect(tabla('boletas_sin_conciliar')).toBe('flito_conciliacion_boletas');
    for (const c of ['actas_pendientes_entrega', 'actas_devueltas_periodo', 'viajes_adicionales_periodo', 'cola_facturacion_atascada', 'movimientos_bolsa_periodo'] as const) {
      expect(placa(c), c).toBe(true);
    }
    for (const c of ['traslados_por_estado', 'facturas_con_error', 'bolsas_cobertura', 'boletas_sin_conciliar'] as const) expect(placa(c), c).toBe(false);
  });

  it('Zod: el segmento `bolsa` solo admite el uuid de la bolsa (sin «Sin valor»)', async () => {
    const { consultaDetalleSchema } = await import('../../../src/modules/flito-torre/flito-torre.esquemas.js');
    const con = (valores: (string | null)[]) => consultaDetalleSchema.safeParse({
      origen: { tipo: 'conjunto', conjunto: 'movimientos_bolsa_periodo' }, segmentos: [{ dimension: 'bolsa', valores }],
      filtro: MARZO_FILTRO, pagina: 1, tamano: 25,
    }).success;
    expect(con(['0b6f3c3e-8a5e-4c1f-9d7a-1c2b3d4e5f60'])).toBe(true);
    expect(con(['Bolsa de Rentacar'])).toBe(false);
    expect(con([null])).toBe(false);
  });

  it('sin la función de Logística, el detalle de un conjunto de Logística es 403 SIN_ORIGEN (y sin Financiera, el de Bolsas)', async () => {
    const c = (conjunto: ConjuntoTorreId): ConsultaDetalle => ({ origen: { tipo: 'conjunto', conjunto }, filtro: MARZO_FILTRO, pagina: 1, tamano: 25 });
    const acc = (f: string) => ({ alcance: TODO, dinero: true, funciones: new Set([f]), hoy: HOY });
    await expect(consultarDetalle(c('traslados_por_estado'), acc('torre.tablero_productos.ver'))).rejects.toBeInstanceOf(DetalleSinOrigenError);
    await expect(consultarDetalle(c('bolsas_cobertura'), acc(FUNCION_TABLERO_LOGISTICA_TORRE))).rejects.toBeInstanceOf(DetalleSinOrigenError);
  });
});

// ── Con base ─────────────────────────────────────────────────────────────────────────────────────────

const haceDias = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

describe.skipIf(!URL_BASE)('Torre › Logística, Facturación y Bolsas contra PostgreSQL (tx con ROLLBACK)', () => {
  let tx: Awaited<ReturnType<typeof abrirTx>>;
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { tx = await abrirTx(); s = sembrador(tx); await s.organismos('05001', '11001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  const traslado = async (cia: number, o: { estado: string; origen: string; destino: string; registrado: string }) => {
    const [r] = await tx`INSERT INTO flito_logistica_traslados (compania_id, origen, destino, estado, registrado_en)
      VALUES (${cia}, ${o.origen}, ${o.destino}, ${o.estado}, ${o.registrado}) RETURNING id`;
    return r!.id as string;
  };
  const documento = async (tramiteId: string, cia: number, actaId: string | null = null) => {
    const [v] = await tx`SELECT vehiculo_id FROM flito_tramites WHERE id = ${tramiteId}`;
    const [d] = await tx`INSERT INTO flito_logistica_documentos (tramite_id, tipo, organismo_codigo, compania_id, vehiculo_id, acta_id)
      VALUES (${tramiteId}, 'licencia_transito', '05001', ${cia}, ${v!.vehiculo_id}, ${actaId}) RETURNING id`;
    return d!.id as string;
  };
  const acta = async (cia: number, o: { estado: string; creada: string; motivo?: string | null; entregada?: string | null; proveedor?: string | null }) => {
    const [a] = await tx`INSERT INTO flito_logistica_actas (compania_id, estado, created_at, motivo_devolucion, entregado_en, proveedor_logistica_id,
        direccion_entrega, contacto_nombre, receptor_nombre, entrega_nombre, entregado_lat, entregado_lng, firma_storage_key)
      VALUES (${cia}, ${o.estado}, ${o.creada}, ${o.motivo ?? null}, ${o.entregada ?? null}, ${o.proveedor ?? null},
        'CALLE SECRETA ENTREGA 9', 'CONTACTO SECRETO', 'RECEPTOR SECRETO', 'ENTREGADOR SECRETO', 6.2442, -75.5812, 'llave/secreta.png')
      RETURNING id`;
    return a!.id as string;
  };
  const lote = async () => {
    const [l] = await tx`INSERT INTO siigo_lotes_facturacion (ambiente, huella) VALUES ('pruebas', ${`H${Math.random().toString(36).slice(2)}`}) RETURNING id`;
    return l!.id as string;
  };
  const factura = async (tramiteId: string, o: { estado: string; error?: string | null; revision?: boolean; enviada?: string | null; total?: number | null }) => {
    const l = await lote();
    const [f] = await tx`INSERT INTO siigo_facturas (lote_id, ambiente, idempotency_key, estado, error_code, error_detalle, requiere_revision,
        enviada_en, total_siigo, numero, siigo_invoice_id, en_proceso_desde)
      VALUES (${l}, 'pruebas', ${`K${Math.random().toString(36).slice(2, 14)}`}, ${o.estado}, ${o.error ?? null}, 'DETALLE CRUDO SECRETO',
        ${o.revision ?? false}, ${o.enviada ?? null}, ${o.total ?? null}, ${`FV-${Math.floor(Math.random() * 1e6)}`},
        ${o.estado === 'emitida' ? `inv-${Math.random()}` : null}, ${o.estado === 'en_proceso' ? new Date().toISOString() : null}) RETURNING id`;
    await tx`INSERT INTO siigo_factura_tramites (factura_id, tramite_id, concepto, activo) VALUES (${f!.id}, ${tramiteId}, 'tramite', ${o.estado !== 'fallida'})`;
    return f!.id as string;
  };
  const dian = async (facturaId: string, ...estados: string[]) => {
    for (const e of estados) await tx`INSERT INTO siigo_factura_estados_dian (factura_id, estado, fuente, motivo) VALUES (${facturaId}, ${e}, 'sondeo', 'MOTIVO DIAN')`;
  };
  const cola = async (tramites: string[], o: { estado: string; proximo: string }) => {
    const l = await lote();
    for (const t of tramites) await tx`INSERT INTO siigo_lote_tramites (lote_id, tramite_id) VALUES (${l}, ${t})`;
    await tx`INSERT INTO siigo_cola_facturacion (lote_id, ambiente, estado, proximo_intento_at, intentos) VALUES (${l}, 'pruebas', ${o.estado}, ${o.proximo}, 2)`;
  };
  const movimiento = async (bolsaId: string, tipo: 'entrada' | 'salida', valor: number, fecha: string, tramiteId: string | null = null) => {
    await tx`INSERT INTO flito_bolsas_unicas_movimientos (bolsa_id, tipo, origen, valor, saldo_resultante, periodo, fecha, registrado_por_nombre,
        tramite_id, observacion, concepto)
      VALUES (${bolsaId}, ${tipo}, ${tipo === 'entrada' ? 'recarga' : 'manual'}, ${valor}, 0, ${fecha.slice(0, 7)}, ${fecha}, 'FUNCIONARIO SECRETO',
        ${tramiteId}, 'OBSERVACION SECRETA', ${tipo === 'salida' ? 'soat' : null})`;
  };
  const boleta = async (cia: number, o: { estado: string; declarado: number; cruzado: number | null }) => {
    await tx`INSERT INTO flito_conciliacion_boletas (compania_id, estado, archivo_nombre, archivo_hash, filas, total_declarado, total_cruzado,
        fecha_pago, cargada_por_nombre)
      VALUES (${cia}, ${o.estado}, 'portal.xlsx', ${Math.random().toString(16).slice(2).padEnd(64, '0')}, 3, ${o.declarado}, ${o.cruzado},
        '2035-03-05', 'CARGADOR SECRETO')`;
  };

  async function escenario() {
    const x = await s.cia('X'); const y = await s.cia('Y'); const z = await s.cia('Z'); const w = await s.cia('W');
    const u = await valoresUmbrales();
    // ── Traslados: 1 abierto reciente, 1 en camino de 5 días, 1 de 10 días (pasa del doble de 3), 1 entregado y 1 anulado.
    const tr2 = await traslado(x, { estado: 'en_ruta', origen: 'organismo', destino: 'cliente', registrado: haceDias(u.dias_traslado_abierto + 2) });
    await traslado(x, { estado: 'registrado', origen: 'organismo', destino: 'flit', registrado: haceDias(0.2) });
    await traslado(y, { estado: 'registrado', origen: 'flit', destino: 'cliente', registrado: haceDias(u.dias_traslado_abierto * 2 + 4) });
    await traslado(y, { estado: 'entregado', origen: 'flit', destino: 'cliente', registrado: haceDias(20) });
    await traslado(x, { estado: 'anulado', origen: 'organismo', destino: 'cliente', registrado: haceDias(20) });
    const tLt = await s.tramite({ cia: x });
    const doc = await documento(tLt, x);
    await tx`INSERT INTO flito_logistica_traslado_lts (traslado_id, destino, documento_id, concepto_precio) VALUES (${tr2}, 'cliente', ${doc}, 'legado')`;
    // ── Actas de entrega (punto cliente): 2 pendientes (una con su documento), 1 entregada y 4 devueltas (3 en marzo).
    const prov = await proveedorLogistica(tx, { nombre: 'Mensajería Andina' });
    const a1 = await acta(x, { estado: 'generada', creada: haceDias(4), proveedor: prov });
    await documento(await s.tramite({ cia: x, placa: 'ZQA111' }), x, a1);
    await acta(y, { estado: 'despachada', creada: haceDias(2) });
    await acta(x, { estado: 'entregada', creada: haceDias(6), entregada: haceDias(5) });
    await acta(x, { estado: 'devuelta', creada: '2035-03-10T15:00:00Z', motivo: 'Destinatario ausente' });
    await acta(y, { estado: 'devuelta', creada: '2035-03-12T15:00:00Z', motivo: 'Destinatario ausente' });
    await acta(y, { estado: 'devuelta', creada: '2035-03-15T15:00:00Z', motivo: null });
    await acta(x, { estado: 'devuelta', creada: '2035-02-01T15:00:00Z', motivo: 'Fuera del periodo' });
    // ── Entregas (B1) y viajes: 3 aprobados con logística; el primero con 2 viajes adicionales en marzo, el segundo con
    //    uno de febrero (fuera del periodo de los viajes, pero ya no fue «al primer intento») y el tercero sin viajes.
    const e1 = await s.tramite({ cia: x, aprobado: '2035-03-05T15:00:00Z' });
    const e2 = await s.tramite({ cia: y, aprobado: '2035-03-06T15:00:00Z' });
    await s.liquidacion(e1, { total: 100_000, logistica: 20_000 });
    await s.liquidacion(e2, { total: 80_000, logistica: 20_000 });
    const e3 = await s.tramite({ cia: x, aprobado: '2035-03-08T15:00:00Z' });
    await s.liquidacion(e3, { total: 50_000, logistica: 20_000 });
    for (const [t, n, en] of [[e1, 2, '2035-03-06T15:00:00Z'], [e1, 3, '2035-03-07T15:00:00Z'], [e2, 2, '2035-02-07T15:00:00Z']] as const) {
      await tx`INSERT INTO flito_tramite_viajes_logistica (tramite_id, numero, modo, valor, motivo, motivo_detalle, registrado_en)
        VALUES (${t}, ${n}, 'manual', 15000, 'otro', 'DETALLE LIBRE SECRETO', ${en})`;
    }
    // ── Facturas: fallida sin corregir, fallida ya corregida (su trámite tiene otra emitida), emitida en revisión, rechazada
    //    por la DIAN, aceptada tras un rechazo y una con un código que no está en el catálogo.
    const [fa, fb, fc, fd, fe] = [await s.tramite({ cia: x }), await s.tramite({ cia: x }), await s.tramite({ cia: y }), await s.tramite({ cia: y }), await s.tramite({ cia: x })];
    await factura(fa, { estado: 'fallida', error: 'siigo_no_responde' });
    await factura(fb, { estado: 'fallida', error: 'emision_sin_mapeo' });
    const fbOk = await factura(fb, { estado: 'emitida', enviada: '2035-03-10T15:00:00Z', total: 500_000 });
    await dian(fbOk, 'rechazada', 'aceptada');
    await factura(fc, { estado: 'emitida', revision: true, enviada: '2035-03-11T15:00:00Z', total: 300_000 });
    const rech = await factura(fd, { estado: 'emitida', enviada: '2035-02-01T15:00:00Z', total: 1 });
    await dian(rech, 'aceptada', 'rechazada');
    await factura(fe, { estado: 'fallida', error: 'codigo_que_nadie_conoce' });
    // ── Cola: 2 trámites con el reintento vencido, 1 agotado, 1 al día (no cuenta) y 1 agotado ya facturado (no cuenta).
    await cola([await s.tramite({ cia: x }), await s.tramite({ cia: y })], { estado: 'pendiente', proximo: '2001-01-01T00:00:00Z' });
    await cola([await s.tramite({ cia: x })], { estado: 'fallido_definitivo', proximo: '2001-01-01T00:00:00Z' });
    await cola([await s.tramite({ cia: x })], { estado: 'pendiente', proximo: '2999-01-01T00:00:00Z' });
    await cola([fb], { estado: 'fallido_definitivo', proximo: '2001-01-01T00:00:00Z' });
    // ── Bolsas (consumo de los 30 días hasta HOY): x crítica (1 día), y agotada, z en atención y w sin consumo (al día).
    const bx = await s.bolsa(x, 100_000);
    await movimiento(bx, 'salida', 3_000_000, '2035-03-15', e1);
    await movimiento(bx, 'entrada', 2_000_000, '2035-03-02');
    await movimiento(bx, 'salida', 9_000_000, '2035-02-10');
    await s.bolsa(y, 0);
    const bz = await s.bolsa(z, Math.round(((u.dias_cobertura_rojo + u.dias_cobertura_amarillo) / 2) * 100_000));
    await movimiento(bz, 'salida', 3_000_000, '2035-03-20');
    await s.bolsa(w, 5_000_000);
    // ── Boletas: 2 sin conciliar en x (una con diferencia), 1 descartada y 1 sin cruzar en y.
    await boleta(x, { estado: 'cargada', declarado: 100, cruzado: 100 });
    await boleta(x, { estado: 'cargada', declarado: 100, cruzado: 90 });
    await boleta(y, { estado: 'descartada', declarado: 50, cruzado: 40 });
    await boleta(y, { estado: 'cargada', declarado: 70, cruzado: null });
    return { x, y, z, w, u, bx, bz, filtro: { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [x, y, z, w] } as FiltroTorre };
  }

  const detalle = (filtro: FiltroTorre, d: DestinoCifra, dinero = true) => {
    if (d.tipo !== 'conjunto') throw new Error('se esperaba un destino de conjunto');
    return consultarDetalle({ origen: d.origen, segmentos: d.segmentos, filtro, pagina: 1, tamano: 100 },
      { alcance: TODO, dinero, funciones: FUNCIONES, hoy: HOY });
  };

  type Cifra = { que: string; n: number; valor?: number | null; destino?: DestinoCifra; otros?: boolean };
  const deExplicaciones = (pre: string, cifras: object, ex: Partial<Record<string, CifraExplicada>>): Cifra[] =>
    Object.entries(ex).flatMap(([k, e]) => [
      { que: `${pre}.${k}`, n: (cifras as Record<string, number>)[k]!, destino: e!.destino },
      ...(e!.desglose ?? []).filter((d) => d.destino).map((d) => ({ que: `${pre}.${k}.${d.etiqueta}`, n: d.valor, destino: d.destino })),
    ]);
  const deTablas = (pre: string, tablas: TablaAreaTorre[]): Cifra[] => tablas.flatMap((tb) => [...tb.filas, tb.total]
    .map((f) => ({ que: `${pre}.${tb.conjunto}.${f.clave}`, n: f.n, valor: f.valor, destino: f.destino, otros: f.clave === '__otros' })));

  async function verificar(filtro: FiltroTorre, cifras: Cifra[], vistos: Set<string>) {
    for (const c of cifras) {
      if (c.n === 0 || c.otros) { expect(c.destino, c.que).toEqual({ tipo: 'ninguno' }); continue; }
      const d = await detalle(filtro, c.destino!);
      expect(d.total, c.que).toBe(c.n);
      if (c.valor != null) expect(d.valorTotal, c.que).toBe(c.valor);
      if (c.destino!.tipo === 'conjunto' && c.destino!.origen.tipo === 'conjunto') vistos.add(c.destino!.origen.conjunto);
    }
  }

  it('B4-AC1/AC2/AC3: cada KPI, desglose y fila de los tres tableros abre un detalle con su mismo número; los 14 conjuntos con datos', async () => {
    const { filtro, u, bx, bz } = await escenario();
    const ctx = { filtro, alcance: TODO, dinero: true, hoy: HOY };
    const [lg, fa, bo] = [await tableroLogistica(ctx), await tableroFacturacion(ctx), await tableroBolsas(ctx)];
    const vistos = new Set<string>();
    await verificar(filtro, [
      ...deExplicaciones('traslados', lg.traslados.cifras, lg.traslados.explicaciones), ...deTablas('traslados', lg.traslados.tablas),
      ...deExplicaciones('entregas', lg.entregas.cifras, lg.entregas.explicaciones), ...deTablas('entregas', lg.entregas.tablas),
      ...deExplicaciones('facturacion', fa.cifras, fa.explicaciones), ...deTablas('facturacion', fa.tablas),
      ...deExplicaciones('bolsas', bo.cifras, bo.explicaciones),
      ...bo.cobertura.filas.map((f) => ({ que: `bolsas.cobertura.${f.compania}`, n: f.movimientos, destino: f.destino })),
    ], vistos);
    for (const id of IDS) expect(vistos.has(id), `conjunto ${id} sin datos en el escenario`).toBe(true);

    // Números esperados (las condiciones, no solo la invariante).
    expect(lg.traslados.cifras).toEqual({ abiertos: 3, abiertosMasDeN: 2 });
    expect(lg.traslados.explicaciones.abiertosMasDeN!.desglose![0]!.valor).toBe(1);
    expect(lg.traslados.tablas[0]!.filas.map((f) => [f.clave, f.n])).toEqual([['registrado', 2], ['en_ruta', 1], ['entregado', 1], ['devuelto', 0], ['anulado', 1]]);
    expect(lg.traslados.rutasAbiertas.map((r) => r.n).reduce((a, b) => a + b, 0)).toBe(3);
    expect(lg.entregas.cifras).toMatchObject({
      pendientesEntrega: 2, devueltasPeriodo: 3, entregasPeriodo: 3, primerIntento: 1, primerIntentoPct: 33.3, viajesAdicionales: 2, tramitesConViajes: 1,
    });
    expect(lg.entregas.tablas[0]!.filas.map((f) => [f.etiqueta, f.n])).toEqual([['Destinatario ausente', 2], ['Sin motivo', 1]]);
    expect(lg.entregas.explicaciones.devueltasPeriodo!.frase).toContain('El motivo más común: Destinatario ausente (2).');
    expect(fa.cifras).toMatchObject({ sinFacturar: 3, sinFacturarValor: 230_000, conError: 3, rechazadasDian: 1, colaAtascada: 3, facturadasPeriodo: 2, facturadoValor: 800_000 });
    expect(fa.explicaciones.colaAtascada!.desglose!.map((d) => d.valor)).toEqual([2, 1]);
    expect(fa.explicaciones.facturadasPeriodo!.frase).toBe('En el periodo se facturaron $800.000 en 2 facturas.');
    expect(fa.tablas[0]!.filas.map((f) => [f.n, f.valor])).toEqual([[2, 150_000], [1, 80_000]]);
    expect(bo.cifras).toMatchObject({
      activas: 4, enCritico: 2, enAtencion: 1, agotadas: 1, criticasConSaldo: 1, movimientosPeriodo: 3, recargas: 1, consumos: 2,
      recargasValor: 2_000_000, consumosValor: 6_000_000, boletasSinConciliar: 3, boletasConDiferencia: 1,
    });
    const porBolsa = new Map(bo.cobertura.filas.map((f) => [f.bolsaId, f]));
    expect(porBolsa.get(bx)).toMatchObject({ diasCobertura: 1, severidad: 'critico', movimientos: 2 });
    expect(porBolsa.get(bz)).toMatchObject({ severidad: 'atencion', movimientos: 1 });
    expect(bo.cobertura.filas.at(-1)).toMatchObject({ diasCobertura: null, severidad: 'ok', movimientos: 0, destino: { tipo: 'ninguno' } });
    expect(bo.explicaciones.enCritico!.definicion).toContain(`${u.dias_cobertura_amarillo} días`);
  });

  it('B4-AC3: la cifra de bolsas en crítico == el detalle `bolsas_cobertura` + severidad crítico, y la «Bolsa con menor cobertura» del Resumen no cambia', async () => {
    const { filtro, x } = await escenario();
    const ctx = { filtro, alcance: TODO, dinero: true, hoy: HOY };
    const bo = await tableroBolsas(ctx);
    const crit = await detalle(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'bolsas_cobertura' }, segmentos: [{ dimension: 'severidad', valores: ['critico'] }] });
    expect(crit.total).toBe(bo.cifras.enCritico);
    expect(crit.filas.map((f) => f.celdas.severidad)).toEqual(['Crítico', 'Crítico']);
    const resumen = await tableroFinanciero(ctx);
    const menor = bo.cobertura.filas.find((f) => f.diasCobertura != null)!;
    // La agotada (0 días) es la de menor cobertura; la crítica con saldo (1 día) le sigue. Mismo SQL en las dos vistas.
    expect(resumen.cifras.menorCobertura).toEqual({ companiaId: menor.companiaId, compania: menor.compania, dias: menor.diasCobertura, severidad: menor.severidad });
    expect(resumen.cifras.menorCobertura).toMatchObject({ dias: 0, severidad: 'critico' });
    expect(resumen.bolsas.filas.map((f) => [f.companiaId, f.diasCobertura, f.severidad]))
      .toEqual(bo.cobertura.filas.map((f) => [f.companiaId, f.diasCobertura, f.severidad]));
    expect(resumen.bolsas.filas.find((f) => f.companiaId === x)).toMatchObject({ saldo: 100_000, consumoDiario: 100_000, diasCobertura: 1 });
  });

  it('el error de Siigo se lee: texto del catálogo, genérico sin traducción, «revisión» sin código; nunca el código ni el detalle crudo', async () => {
    const { filtro } = await escenario();
    const d = await detalle(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'facturas_con_error' } });
    expect(d.filas.map((f) => f.celdas.error_factura).sort()).toEqual(
      ['Error de Siigo, ver la factura.', 'Quedó marcada para revisión.', 'Siigo no respondió al envío.'].sort());
    expect(JSON.stringify(d)).not.toMatch(/siigo_no_responde|codigo_que_nadie_conoce|emision_sin_mapeo|DETALLE CRUDO/);
  });

  it('B4-AC1: las filas reales no traen dirección de entrega, receptor, contacto, quien entrega, coordenadas, storage keys ni personas', async () => {
    const { filtro } = await escenario();
    const ctx = { filtro, alcance: TODO, dinero: true, hoy: HOY };
    const destinos = [
      ...Object.values((await tableroLogistica(ctx)).entregas.explicaciones), ...Object.values((await tableroLogistica(ctx)).traslados.explicaciones),
      ...Object.values((await tableroFacturacion(ctx)).explicaciones), ...Object.values((await tableroBolsas(ctx)).explicaciones),
    ].map((e) => e!.destino).filter((x) => x.tipo === 'conjunto');
    let filas = 0;
    for (const dest of destinos) {
      const d = await detalle(filtro, dest);
      expect(JSON.stringify(d.filas)).not.toMatch(/SECRET|6\.2442|75\.5812|llave\/|MOTIVO DIAN/);
      filas += d.filas.length;
    }
    expect(filas).toBeGreaterThan(20);
    const actas = await detalle(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'actas_pendientes_entrega' } });
    expect(actas.filas.map((f) => f.celdas.placas)).toContainEqual(['ZQA111']);
    expect(actas.filas.map((f) => f.celdas.proveedor_logistica)).toContain('Mensajería Andina');
    const viajes = await detalle(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'viajes_adicionales_periodo' } });
    expect(viajes.filas.map((f) => f.celdas.motivo)).toEqual(['Otro', 'Otro']);
  });

  it('sin permiso de dinero: valores en null, las frases no dicen pesos y el Excel no lleva las filas de dinero', async () => {
    const { filtro } = await escenario();
    const ctx = { filtro, alcance: TODO, dinero: false, hoy: HOY };
    const fa = await tableroFacturacion(ctx);
    expect(fa.cifras.sinFacturarValor).toBeNull();
    expect(fa.cifras.facturadoValor).toBeNull();
    expect(fa.explicaciones.facturadasPeriodo!.frase).toBe('En el periodo se emitieron 2 facturas.');
    expect(fa.tablas[0]!.filas.every((f) => f.valor === null)).toBe(true);
    const bo = await tableroBolsas(ctx);
    expect(bo.cobertura.filas.every((f) => f.saldo === null && f.consumoDiario === null)).toBe(true);
    expect(bo.cifras.recargasValor).toBeNull();
    expect(bo.explicaciones.movimientosPeriodo!.frase).not.toContain('$');
    const d = await detalle(filtro, bo.explicaciones.movimientosPeriodo!.destino, false);
    expect(d.filas.every((f) => f.celdas.valor === null)).toBe(true);
    for (const t of ['logistica', 'facturacion', 'bolsas'] as const) {
      const libro = await libroTablero(t, ctx);
      expect(JSON.stringify(libro.hojas[0]!.filas), t).not.toMatch(/Valor/);
      expect(libro.hojas.at(-1)!.nombre, t).toBe('Definiciones');
    }
  });
});

// ── Rutas ────────────────────────────────────────────────────────────────────────────────────────────

const filas = new Map<number, FilasPermisos>();
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const app = express();
app.use(express.json());
app.use('/api/flito/torre/tableros', tableros);
const MARZO = { filtro: { rango: { desde: '2035-03-01', hasta: '2035-03-31' } } };

describe('rutas nuevas de B4 — guardas', () => {
  beforeEach(() => {
    filas.clear();
    permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
    for (const i of [1, 2, 3]) permisos.invalidarPermisosDe(i);
    filas.set(1, { rol: 'r1', tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(['accion.torre_productos.ver', 'accion.torre_operativa.ver']), excepciones: [] });
    filas.set(2, { rol: 'r2', tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(['accion.torre_logistica.ver']), excepciones: [] });
    filas.set(3, { rol: 'r3', tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(['accion.torre_financiera.ver']), excepciones: [] });
  });

  for (const ruta of ['/logistica', '/logistica/exportar']) {
    it(`${ruta}: 401 sin token y 403 sin torre.tablero_logistica.ver (aunque vea Productos y Operativa)`, async () => {
      expect((await request(app).post(`/api/flito/torre/tableros${ruta}`).send(MARZO)).status).toBe(401);
      expect((await request(app).post(`/api/flito/torre/tableros${ruta}`).set('Authorization', `Bearer ${await token(1)}`).send(MARZO)).status).toBe(403);
    });
  }

  for (const ruta of ['/financiera/facturacion', '/financiera/bolsas', '/financiera/facturacion/exportar', '/financiera/bolsas/exportar']) {
    it(`${ruta}: 401 sin token y 403 sin torre.tablero_financiero.ver (aunque vea Logística)`, async () => {
      expect((await request(app).post(`/api/flito/torre/tableros${ruta}`).send(MARZO)).status).toBe(401);
      expect((await request(app).post(`/api/flito/torre/tableros${ruta}`).set('Authorization', `Bearer ${await token(2)}`).send(MARZO)).status).toBe(403);
    });
  }

  it('exportar exige además torre.metricas.exportar (403) y un body inválido es 400', async () => {
    const lg = { Authorization: `Bearer ${await token(2)}` };
    const fi = { Authorization: `Bearer ${await token(3)}` };
    expect((await request(app).post('/api/flito/torre/tableros/logistica/exportar').set(lg).send(MARZO)).status).toBe(403);
    expect((await request(app).post('/api/flito/torre/tableros/financiera/bolsas/exportar').set(fi).send(MARZO)).status).toBe(403);
    expect((await request(app).post('/api/flito/torre/tableros/logistica').set(lg).send({ ...MARZO, otro: 1 })).status).toBe(400);
    expect((await request(app).post('/api/flito/torre/tableros/financiera/facturacion').set(fi).send({ ...MARZO, otro: 1 })).status).toBe(400);
  });
});
