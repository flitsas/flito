// HU #12830 — la cola de impuestos expone el análisis factura ↔ RUNT (12825-12828) y filtra por
// semáforo; HU #12832 — distingue la certificación automática de la manual.
//
//   (i)   DTO por `ensamblar` (común a cola y detalle, se ejercita por `detalleImpuesto` como en
//         cola-fases/cola-certificacion): `analisisEstado`, `semaforo`, `motivoSemaforo` (solo en
//         rojo y solo del vocabulario cerrado) y `certificacion.automatica`.
//   (ii)  El detalle trae la comparación campo a campo; la fila de la cola NO proyecta el jsonb
//         entero, solo `->>'motivo'` (se lee de la proyección pasada a `db.select`).
//   (iii) El filtro `semaforo` se afirma sobre el SQL leído (`espia.condicionesLeidas()`): el mock
//         devuelve las mismas filas con o sin la condición.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadosA, renderizar, type SqlRenderizado } from '../helpers/sql-ligado.js';
import {
  ANALISIS_ESTADO_IMPUESTO_LABEL, MOTIVO_SEMAFORO_ROJO_LABEL, NOMBRE_CERTIFICADOR_AUTOMATICO,
  type ComparacionFacturaRunt,
} from '@operaciones/shared-types';

const kdb = createKeyedDb();

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const { detalleImpuesto, colaImpuestos } = await import('../../src/modules/flito-impuestos/flito-impuestos.service.js');
const { ACTOR_AUTOCERTIFICACION } = await import('../../src/modules/flito-impuestos/flito-impuestos.autocertificacion.js');
const { flitoImpuestos, flitoImpuestoCertificaciones, flitoCompradores, flitoSoportes, flitoTramites } = await import('../../src/db/schema.js');

const T_IMPUESTOS = getTableName(flitoImpuestos);
const T_CERT = getTableName(flitoImpuestoCertificaciones);
const T_COMPRADORES = getTableName(flitoCompradores);
const T_SOPORTES = getTableName(flitoSoportes);
const T_TRAMITES = getTableName(flitoTramites);

const ADMIN = { userId: 1, username: 'ops@flitsas.io', role: 'admin', organismos: [] as string[] };
const GESTOR = { userId: 2, username: 'gestor@flitsas.io', role: 'gestor_impuestos', organismos: ['05001'] };
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';

const COMPARACION: ComparacionFacturaRunt = {
  version: 1, motivo: null,
  campos: [
    { campo: 'vin', resultado: 'coincide', valorFactura: '3KPFF51ABTE156687', valorRunt: '3KPFF51ABTE156687' },
    { campo: 'color', resultado: 'difiere', valorFactura: 'GRIS ESTRELLA', valorRunt: 'GRIS CASSIOPEE' },
  ],
  resumen: { coinciden: 1, difieren: 1, noVerificables: 0 },
  calculadoEn: '2026-09-23T10:00:00.000Z',
};

const filaAcceso = (over: Record<string, unknown> = {}) => ({
  imp: {
    id: ID, tramiteId: 't1', estado: 'solicitado', organismoCodigo: '05001', gestionOperaciones: false,
    extraccion: null, extraccionFacturaVenta: null, pagadoEn: null, comparacionFacturaRunt: null, ...over,
  },
  dentroDeFrontera: true,
});

const filaCola = (over: Record<string, unknown> = {}) => ({
  id: ID, tramiteId: 't1', idFlit: 'FLIT-1001', tipoTramite: 'traspaso',
  fechaAprobacion: null, fechaCreacion: null, marca: 'KIA', linea: 'K3 CROSS',
  estado: 'solicitado', organismoCodigo: '05001', valorLiquidado: '350000', valorPagado: null,
  marcadoPorDiferencia: false, facturaVentaFlitId: null, enviadoEn: null, pagadoEn: null, liquidadoEn: null,
  motivoRechazo: null, createdAt: new Date('2026-08-01T12:00:00Z'),
  placa: 'QIU744', vin: '3KPFF51ABTE156687', companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', organismoSla: 24, enviadoPorNombre: null, tipoTitularFlit: 'cc',
  analisisEstado: null, semaforo: null, motivoSemaforo: null,
  ...over,
});

const filaCert = (over: Record<string, unknown> = {}) => ({
  id: 'cert-1', impuestoId: ID, createdAt: new Date('2026-09-23T15:00:00Z'),
  certificadoPorNombre: 'gestor@flitsas.io', certificadoPorId: 7, ...over,
});

function escenario(opts: { cola?: Record<string, unknown>; acceso?: Record<string, unknown>; certs?: unknown[] } = {}) {
  kdb.when
    .selectOnce(T_IMPUESTOS, [filaAcceso(opts.acceso)])
    .selectOnce(T_IMPUESTOS, [filaCola(opts.cola)])
    .select(T_COMPRADORES, [])
    .select(T_CERT, opts.certs ?? [])
    .select(T_SOPORTES, [])
    .select(T_TRAMITES, []);
}

beforeEach(() => { kdb.reset(); });

// ═════════════════ (i) el DTO ═══════════════════════════════════════════════════════════════════

describe('HU #12830 — la fila trae analisisEstado, semaforo y motivoSemaforo', () => {
  it('nunca analizado → los tres en null explícito, no ausentes', async () => {
    escenario();
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r).toHaveProperty('analisisEstado', null);
    expect(r).toHaveProperty('semaforo', null);
    expect(r).toHaveProperty('motivoSemaforo', null);
  });

  it('en_curso → analisisEstado en_curso, sin semáforo', async () => {
    escenario({ cola: { analisisEstado: 'en_curso' } });
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r?.analisisEstado).toBe('en_curso');
    expect(r?.semaforo).toBeNull();
  });

  it('completado + naranja → semáforo naranja y motivo null', async () => {
    escenario({ cola: { analisisEstado: 'completado', semaforo: 'naranja', motivoSemaforo: null } });
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r?.semaforo).toBe('naranja');
    expect(r?.motivoSemaforo).toBeNull();
  });

  it('rojo por RUNT → motivo runt_sin_respuesta', async () => {
    escenario({ cola: { analisisEstado: 'completado', semaforo: 'rojo', motivoSemaforo: 'runt_sin_respuesta' } });
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r?.semaforo).toBe('rojo');
    expect(r?.motivoSemaforo).toBe('runt_sin_respuesta');
  });

  it('rojo por factura ilegible → motivo error_lectura_factura', async () => {
    escenario({ cola: { analisisEstado: 'completado', semaforo: 'rojo', motivoSemaforo: 'error_lectura_factura' } });
    expect((await detalleImpuesto(ID, ADMIN))?.motivoSemaforo).toBe('error_lectura_factura');
  });

  it('un motivo que no es del vocabulario cerrado no viaja (null)', async () => {
    escenario({ cola: { analisisEstado: 'completado', semaforo: 'rojo', motivoSemaforo: 'timeout del proveedor' } });
    expect((await detalleImpuesto(ID, ADMIN))?.motivoSemaforo).toBeNull();
  });

  it('un motivo con semáforo que no es rojo no viaja: motivo ⇔ rojo', async () => {
    escenario({ cola: { analisisEstado: 'completado', semaforo: 'verde', motivoSemaforo: 'runt_sin_respuesta' } });
    expect((await detalleImpuesto(ID, ADMIN))?.motivoSemaforo).toBeNull();
  });

  it('error_analisis → se publica tal cual', async () => {
    escenario({ cola: { analisisEstado: 'error_analisis' } });
    expect((await detalleImpuesto(ID, ADMIN))?.analisisEstado).toBe('error_analisis');
  });
});

describe('HU #12832 — certificacion.automatica', () => {
  it('la firmada por el paso de autocertificación → automatica true', async () => {
    escenario({ certs: [filaCert({ certificadoPorId: null, certificadoPorNombre: ACTOR_AUTOCERTIFICACION.username })] });
    const r = await detalleImpuesto(ID, ADMIN);
    expect(r?.certificacion).toEqual({
      id: 'cert-1', certificadoEn: '2026-09-23T15:00:00.000Z',
      certificadoPorNombre: NOMBRE_CERTIFICADOR_AUTOMATICO, automatica: true,
    });
  });

  it('manual de una persona → automatica false', async () => {
    escenario({ certs: [filaCert()] });
    expect((await detalleImpuesto(ID, ADMIN))?.certificacion?.automatica).toBe(false);
  });

  it('manual de un usuario ya borrado (FK SET NULL) → sigue siendo manual', async () => {
    escenario({ certs: [filaCert({ certificadoPorId: null })] });
    expect((await detalleImpuesto(ID, ADMIN))?.certificacion?.automatica).toBe(false);
  });

  it('el actor de la autocertificación firma con la constante compartida', () => {
    expect(ACTOR_AUTOCERTIFICACION).toEqual({ userId: null, username: NOMBRE_CERTIFICADOR_AUTOMATICO });
  });
});

// ═════════════════ (ii) dónde va la comparación ═════════════════════════════════════════════════

describe('HU #12830/#12831 — la comparación va en el detalle, no en cada fila', () => {
  it('el detalle trae la comparación guardada por la 12827', async () => {
    escenario({ acceso: { comparacionFacturaRunt: COMPARACION }, cola: { analisisEstado: 'completado', semaforo: 'naranja' } });
    expect((await detalleImpuesto(ID, ADMIN))?.comparacion).toEqual(COMPARACION);
  });

  it('sin comparación → null explícito', async () => {
    escenario();
    expect(await detalleImpuesto(ID, ADMIN)).toHaveProperty('comparacion', null);
  });

  it('la proyección de la cola lee solo `->> \'motivo\'` del jsonb y no la columna entera', async () => {
    kdb.when.select(T_IMPUESTOS, []).select(T_COMPRADORES, []).select(T_CERT, []).select(T_SOPORTES, []);
    await colaImpuestos(ADMIN, {});
    const proyecciones = kdb.select.mock.calls.map((c) => c[0] as Record<string, unknown> | undefined);
    const deCola = proyecciones.find((p) => p && 'motivoSemaforo' in p);
    expect(deCola, 'la proyección de la cola no trae motivoSemaforo').toBeDefined();
    expect(Object.keys(deCola!)).not.toContain('comparacionFacturaRunt');
    const q = new PgDialect().sqlToQuery(deCola!.motivoSemaforo as never);
    expect(q.sql).toMatch(/"flito_impuestos"\."comparacion_factura_runt"->>'motivo'/);
    expect(Object.keys(deCola!)).toEqual(expect.arrayContaining(['analisisEstado', 'semaforo']));
  });
});

// ═════════════════ (iii) el filtro semaforo ═════════════════════════════════════════════════════

const conSemaforo = (consultas: SqlRenderizado[]) => consultas.find((q) => /"flito_impuestos"\."semaforo"\s+in/i.test(q.sql));

describe('HU #12830 — filtro `semaforo` en el SQL (preset «Con alertas»)', () => {
  const vacio = () => kdb.when.select(T_IMPUESTOS, []).select(T_COMPRADORES, []).select(T_CERT, []).select(T_SOPORTES, []);

  it('naranja,rojo → `semaforo in ($, $)` ligando esos dos, AND con el resto', async () => {
    const espia = crearEspia(kdb);
    vacio();
    await colaImpuestos(ADMIN, { semaforo: ['naranja', 'rojo'], organismos: ['05001'] });
    const q = conSemaforo(espia.condicionesLeidas().map((c) => renderizar(c as never)));
    expect(q, 'ninguna condición de la cola filtra por semaforo').toBeDefined();
    expect(ligadosA(q!, '"flito_impuestos"."semaforo"').sort()).toEqual(['naranja', 'rojo']);
    expect(ligadosA(q!, '"flito_impuestos"."organismo_codigo"')).toEqual(['05001']);
  });

  it('sin el filtro (o vacío) el SQL no nombra semaforo en el WHERE', async () => {
    const espia = crearEspia(kdb);
    vacio();
    await colaImpuestos(ADMIN, { semaforo: [] });
    const consultas = espia.condicionesLeidas().map((c) => renderizar(c as never));
    expect(consultas.length).toBeGreaterThan(0);
    expect(conSemaforo(consultas)).toBeUndefined();
  });

  it('gestor + filtro: la frontera de organismos sigue en el mismo WHERE', async () => {
    const espia = crearEspia(kdb);
    vacio();
    await colaImpuestos(GESTOR, { semaforo: ['rojo'] });
    const q = conSemaforo(espia.condicionesLeidas().map((c) => renderizar(c as never)));
    expect(q).toBeDefined();
    expect(ligadosA(q!, '"flito_impuestos"."semaforo"')).toEqual(['rojo']);
    expect(ligadosA(q!, '"flito_impuestos"."organismo_codigo"')).toEqual(['05001']);
  });
});

// ═════════════════ copy unificado al AC ═════════════════════════════════════════════════════════

describe('HU #12830 — copy de shared-types', () => {
  it('en_curso se rotula «Analizando»; los motivos del rojo, con el texto del AC', () => {
    expect(ANALISIS_ESTADO_IMPUESTO_LABEL.en_curso).toBe('Analizando');
    expect(MOTIVO_SEMAFORO_ROJO_LABEL.error_lectura_factura).toBe('No se pudo leer la factura');
    expect(MOTIVO_SEMAFORO_ROJO_LABEL.runt_sin_respuesta).toBe('El RUNT no respondió o no tiene registro del vehículo');
  });
});
