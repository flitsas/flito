// HU #12627 — el desglose de solo lectura de los viajes de logística por trámite (AC7), y la forma
// de las expresiones nuevas del reporte (AC1, AC5, AC6) sobre el SQL RENDERIZADO.
//
// El servicio no recalcula nada: toma `.logistica` de la liquidación sellada (`liquidacionDe`) o
// de la previsualización (`calcular`), así que aquí las dos se mockean con `importOriginal` —el
// resto del módulo (`TASA_GMF`, `LiquidacionError`) es el real— y lo que se afirma es a CUÁL de
// las dos se le hace caso y cómo se traduce. La ruta se monta con el router REAL de finanzas y
// `testToken`, para que el 403 salga de `LECTURA` y no de un stub.
//
// Mutantes: devolver lo vigente para un sellado → «calcular no se llama»; `exigirFuncion(...)`
// en vez de `LECTURA` → `permisos.valla-legacy.test.ts` (prohíbe el import) y el 403 del cliente;
// quitar la guarda de uuid → la base recibiría un 22P02 en vez de responder 404.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { DesgloseViajesLogistica, ViajeLogisticaSellado } from '@operaciones/shared-types';
import { chain } from '../helpers/db.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    select: selectMock, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined),
  ventanaActual: () => new Date(),
  VENTANA_DEDUP_MS: 3_600_000,
}));

const liquidacionDeMock = vi.fn();
const calcularMock = vi.fn();
vi.mock('../../src/modules/flito-liquidacion/flito-liquidacion.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js')>();
  return { ...real, liquidacionDe: liquidacionDeMock, calcular: calcularMock };
});

const { desgloseDe, desgloseViajesLogistica, TramiteNoEncontradoError } =
  await import('../../src/modules/finanzas/finanzas.viajes-logistica.js');
const { LiquidacionError } = await import('../../src/modules/flito-liquidacion/flito-liquidacion.service.js');
const {
  conJoins, EXPR_LOGISTICA, EXPR_LOGISTICA_VIAJES_CANTIDAD, SELECT_FILA, SELECT_TOTALES,
} = await import('../../src/modules/finanzas/finanzas.service.js');
const { flitoTramites } = await import('../../src/db/schema.js');
const { renderizar } = await import('../helpers/sql-ligado.js');

const TRAMITE = '7d2f4a10-0b1c-4d2e-9f30-a1b2c3d4e5f6';
const FILA_TRAMITE = { tramiteId: TRAMITE, idFlit: 'FLIT-0001', placa: 'ABC123' };
const BASE = { tramiteId: TRAMITE, idFlit: 'FLIT-0001', placa: 'ABC123' };
const T0 = '2026-09-15T15:00:00.000Z';

const viaje = (numero: number, valor: number): ViajeLogisticaSellado => ({
  id: `v${numero}`, numero, modo: 'manual', valor, tarifaVigente: 35000, motivo: 'devolucion',
  motivoDetalle: null, registradoPorNombre: 'Ana', registradoEn: T0,
});
const VIAJES = [viaje(2, 35000), viaje(3, 20000)];

/** `.logistica` como lo devuelve `calcular` (vigente) o `liquidacionDe` (sellado). */
const logistica = (o: Partial<{ valor: number | null; tarifa: number | null; viajes: ViajeLogisticaSellado[] | null; totalViajes: number | null }> = {}) => ({
  valor: 90000, origen: 'Tarifa', bloquea: false, tarifa: 35000, viajes: VIAJES, totalViajes: 3, ...o,
});
const calculo = (l = logistica()) => ({ tramiteId: TRAMITE, idFlit: 'FLIT-0001', logistica: l });
const sello = (l = logistica()) => ({ ...calculo(l), liquidadoEn: T0 });

beforeEach(() => {
  selectMock.mockReset();
  liquidacionDeMock.mockReset();
  calcularMock.mockReset();
});

// ───────────────────────── AC7 — desgloseDe: la traducción, pura ─────────────────────────

describe('desgloseDe — de `.logistica` de la liquidación al desglose (AC7)', () => {
  it('sin liquidar: origen vigente, la tarifa como viaje 1, 3 viajes y el total = tarifa + Σ viajes', () => {
    const d = desgloseDe(BASE, logistica(), null);
    expect(d).toEqual<DesgloseViajesLogistica>({
      ...BASE, gestionaLogistica: true, liquidado: false, liquidadoEn: null, origen: 'vigente',
      tarifa: 35000, totalViajes: 3, totalLogistica: 90000, items: VIAJES,
    });
    // El orden es el de la liquidación (ORDER BY numero): no se reordena ni se filtra.
    expect(d.items!.map((v) => v.numero)).toEqual([2, 3]);
  });

  it('sin liquidar y sin tarifa configurada: totalLogistica null, los viajes registrados se enseñan igual', () => {
    const d = desgloseDe(BASE, logistica({ valor: null, tarifa: null }), null);
    expect(d.origen).toBe('vigente');
    expect(d.gestionaLogistica).toBe(true);
    expect(d.totalLogistica).toBeNull();
    expect(d.tarifa).toBeNull();
    expect(d.totalViajes).toBe(3);
    expect(d.items).toHaveLength(2);
  });

  it('sellado por la HU #12626: origen sellado, liquidadoEn, items = el snapshot y el total sellado', () => {
    const d = desgloseDe(BASE, logistica(), T0);
    expect(d).toEqual<DesgloseViajesLogistica>({
      ...BASE, gestionaLogistica: true, liquidado: true, liquidadoEn: T0, origen: 'sellado',
      tarifa: 35000, totalViajes: 3, totalLogistica: 90000, items: VIAJES,
    });
  });

  it('sellado con `viajes: []` (sin adicionales): 1 viaje y items vacíos, NO sin_desglose', () => {
    const d = desgloseDe(BASE, logistica({ valor: 35000, viajes: [], totalViajes: 1 }), T0);
    expect(d.origen).toBe('sellado');
    expect(d.totalViajes).toBe(1);
    expect(d.items).toEqual([]);
    expect(d.totalLogistica).toBe(35000);
  });

  it('sellado ANTES de la HU #12626 (viajes null): sin_desglose, items/totalViajes/tarifa null y el total = valor_logistica', () => {
    const d = desgloseDe(BASE, logistica({ valor: 35000, tarifa: null, viajes: null, totalViajes: null }), T0);
    expect(d).toEqual<DesgloseViajesLogistica>({
      ...BASE, gestionaLogistica: true, liquidado: true, liquidadoEn: T0, origen: 'sin_desglose',
      tarifa: null, totalViajes: null, totalLogistica: 35000, items: null,
    });
  });

  it('sin_desglose es SOLO para un sello: sin liquidar, `viajes` nunca es null (sería vigente)', () => {
    // Mutante «origen por `viajes === null` sin mirar `liquidado`»: aquí diría sin_desglose.
    const d = desgloseDe(BASE, logistica({ viajes: [], totalViajes: 1 }), null);
    expect(d.origen).toBe('vigente');
  });

  it('no gestiona (vigente: totalViajes 0): gestionaLogistica false, items [], 0 viajes, total null', () => {
    const d = desgloseDe(BASE, { valor: null, origen: 'La compañía autogestiona', bloquea: false, tarifa: null, viajes: [], totalViajes: 0 }, null);
    expect(d).toEqual<DesgloseViajesLogistica>({
      ...BASE, gestionaLogistica: false, liquidado: false, liquidadoEn: null, origen: 'vigente',
      tarifa: null, totalViajes: 0, totalLogistica: null, items: [],
    });
  });

  it('no gestiona (sellado: valor null con snapshot): gestionaLogistica false por el VALOR, no por los viajes', () => {
    // Mutante «gestiona = totalViajes !== 0» también con lo sellado: un sello que no cobró logística
    // trae totalViajes 0 y coincidiría; pero uno viejo sin logística trae null y diría que gestiona.
    const d = desgloseDe(BASE, logistica({ valor: null, tarifa: null, viajes: [], totalViajes: 0 }), T0);
    expect(d.gestionaLogistica).toBe(false);
    expect(d.origen).toBe('sellado');
    expect(d.items).toEqual([]);
    expect(d.totalViajes).toBe(0);
    expect(d.totalLogistica).toBeNull();
    const viejo = desgloseDe(BASE, logistica({ valor: null, tarifa: null, viajes: null, totalViajes: null }), T0);
    expect(viejo.gestionaLogistica).toBe(false);
    expect(viejo.origen).toBe('sin_desglose');
  });
});

// ───────────────────── AC7 — desgloseViajesLogistica: a quién le hace caso ─────────────────────

describe('desgloseViajesLogistica — sellada manda; sin sello, la previsualización', () => {
  it('un id que no es uuid es 404 SIN tocar la base (el id es opaco; nunca 22P02)', async () => {
    await expect(desgloseViajesLogistica('no-es-uuid')).rejects.toBeInstanceOf(TramiteNoEncontradoError);
    expect(selectMock).not.toHaveBeenCalled();
    expect(liquidacionDeMock).not.toHaveBeenCalled();
  });

  it('un trámite inexistente es 404 y no llega a la liquidación', async () => {
    selectMock.mockReturnValueOnce(chain([]));
    await expect(desgloseViajesLogistica(TRAMITE)).rejects.toThrow('El trámite no existe');
    expect(liquidacionDeMock).not.toHaveBeenCalled();
    expect(calcularMock).not.toHaveBeenCalled();
  });

  it('liquidado: lo sellado, y `calcular` NO se llama (la tabla viva no se mira)', async () => {
    selectMock.mockReturnValueOnce(chain([FILA_TRAMITE]));
    liquidacionDeMock.mockResolvedValueOnce(sello(logistica({ valor: 55000, viajes: [viaje(2, 20000)], totalViajes: 2 })));
    const d = await desgloseViajesLogistica(TRAMITE);
    expect(d.origen).toBe('sellado');
    expect(d.liquidadoEn).toBe(T0);
    expect(d.totalLogistica).toBe(55000);
    expect(d.totalViajes).toBe(2);
    expect(d.placa).toBe('ABC123');
    expect(d.idFlit).toBe('FLIT-0001');
    expect(calcularMock).not.toHaveBeenCalled();
  });

  it('sin liquidar: `calcular`, origen vigente, 3 viajes y 90.000', async () => {
    selectMock.mockReturnValueOnce(chain([FILA_TRAMITE]));
    liquidacionDeMock.mockResolvedValueOnce(null);
    calcularMock.mockResolvedValueOnce(calculo());
    const d = await desgloseViajesLogistica(TRAMITE);
    expect(calcularMock).toHaveBeenCalledWith(TRAMITE);
    expect(d.origen).toBe('vigente');
    expect(d.liquidado).toBe(false);
    expect(d.totalViajes).toBe(3);
    expect(d.totalLogistica).toBe(90000);
    expect(d.items!.map((v) => v.numero)).toEqual([2, 3]);
  });

  it('la placa puede faltar (trámite sin vehículo): null, no undefined', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...FILA_TRAMITE, placa: null }]));
    liquidacionDeMock.mockResolvedValueOnce(null);
    calcularMock.mockResolvedValueOnce(calculo());
    expect((await desgloseViajesLogistica(TRAMITE)).placa).toBeNull();
  });

  it('«El trámite no existe» de la liquidación se traduce al 404 propio; cualquier otro error sube tal cual', async () => {
    selectMock.mockReturnValueOnce(chain([FILA_TRAMITE]));
    liquidacionDeMock.mockResolvedValueOnce(null);
    calcularMock.mockRejectedValueOnce(new LiquidacionError('El trámite no existe'));
    await expect(desgloseViajesLogistica(TRAMITE)).rejects.toBeInstanceOf(TramiteNoEncontradoError);

    selectMock.mockReturnValueOnce(chain([FILA_TRAMITE]));
    liquidacionDeMock.mockResolvedValueOnce(null);
    calcularMock.mockRejectedValueOnce(new Error('se cayó la base'));
    await expect(desgloseViajesLogistica(TRAMITE)).rejects.toThrow('se cayó la base');
  });
});

// ───────────────────────────── AC7 — la ruta, con el router real ─────────────────────────────

const RUTA = `/api/finanzas/tramites/${TRAMITE}/viajes-logistica`;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/finanzas/finanzas.routes.js');
  app.use('/api/finanzas', router);
  return app;
}
const auth = async (role: TestRole) => `Bearer ${await testToken({ sub: 3, username: `${role}@flit.io`, role })}`;

/** Los que no leen el reporte de costos tampoco leen el desglose de una de sus celdas. */
const ROLES_SIN_LECTURA: TestRole[] = [
  'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota', 'conductor',
  'gestor_impuestos', 'mensajero', 'cliente',
];

describe('GET /api/finanzas/tramites/:id/viajes-logistica — la MISMA guarda LECTURA del reporte', () => {
  it('sin token → 401', async () => {
    const app = await buildApp();
    expect((await request(app).get(RUTA)).status).toBe(401);
  });

  it.each(ROLES_SIN_LECTURA)('%s → 403 sin tocar la base', async (role) => {
    const app = await buildApp();
    const r = await request(app).get(RUTA).set('Authorization', await auth(role));
    expect(r.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each(['admin', 'financiera', 'auditor'] as TestRole[])('%s → 200 con el desglose vigente, no-store', async (role) => {
    selectMock.mockReturnValueOnce(chain([FILA_TRAMITE]));
    liquidacionDeMock.mockResolvedValueOnce(null);
    calcularMock.mockResolvedValueOnce(calculo());
    const app = await buildApp();
    const r = await request(app).get(RUTA).set('Authorization', await auth(role));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual<DesgloseViajesLogistica>({
      ...BASE, gestionaLogistica: true, liquidado: false, liquidadoEn: null, origen: 'vigente',
      tarifa: 35000, totalViajes: 3, totalLogistica: 90000, items: VIAJES,
    });
  });

  it('liquidado por la HU #12626 → origen sellado con el snapshot; liquidado antes → sin_desglose', async () => {
    const app = await buildApp();
    selectMock.mockReturnValueOnce(chain([FILA_TRAMITE]));
    liquidacionDeMock.mockResolvedValueOnce(sello());
    const sellado = await request(app).get(RUTA).set('Authorization', await auth('financiera'));
    expect(sellado.status).toBe(200);
    expect(sellado.body.origen).toBe('sellado');
    expect(sellado.body.liquidadoEn).toBe(T0);
    expect(sellado.body.items).toEqual(VIAJES);
    expect(sellado.body.totalLogistica).toBe(90000);
    expect(calcularMock).not.toHaveBeenCalled();

    selectMock.mockReturnValueOnce(chain([FILA_TRAMITE]));
    liquidacionDeMock.mockResolvedValueOnce(sello(logistica({ valor: 35000, tarifa: null, viajes: null, totalViajes: null })));
    const viejo = await request(app).get(RUTA).set('Authorization', await auth('financiera'));
    expect(viejo.body).toMatchObject({ origen: 'sin_desglose', items: null, totalViajes: null, tarifa: null, totalLogistica: 35000 });
  });

  it('no gestiona → gestionaLogistica false, items [], totalViajes 0, totalLogistica null', async () => {
    selectMock.mockReturnValueOnce(chain([FILA_TRAMITE]));
    liquidacionDeMock.mockResolvedValueOnce(null);
    calcularMock.mockResolvedValueOnce(calculo({ valor: null, origen: 'Autogestiona', bloquea: false, tarifa: null, viajes: [], totalViajes: 0 }));
    const app = await buildApp();
    const r = await request(app).get(RUTA).set('Authorization', await auth('admin'));
    expect(r.body).toMatchObject({ gestionaLogistica: false, items: [], totalViajes: 0, totalLogistica: null });
  });

  it('id que no es uuid → 404 { error }, y uno inexistente → el mismo 404', async () => {
    const app = await buildApp();
    const r = await request(app).get('/api/finanzas/tramites/no-es-uuid/viajes-logistica').set('Authorization', await auth('admin'));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'El trámite no existe' });

    selectMock.mockReturnValueOnce(chain([]));
    const r2 = await request(app).get(RUTA).set('Authorization', await auth('admin'));
    expect(r2.status).toBe(404);
    expect(r2.body).toEqual({ error: 'El trámite no existe' });
  });
});

// ──────────── AC1, AC5, AC6 — la forma de las expresiones del reporte (SQL renderizado) ────────────
//
// El mock `chain` devuelve la fila entera y descarta joins y `where`, así que un `leftJoin` a la
// tabla de viajes o una copia de la expresión sin viajes pasarían en verde. Los VALORES (90.000,
// 3 viajes, sellado antes → null) se ejecutan contra Postgres en `db/reporte-viajes-logistica.test.ts`.

const SUBCONSULTA_SUMA = '(SELECT SUM("flito_tramite_viajes_logistica"."valor") FROM "flito_tramite_viajes_logistica" '
  + 'WHERE "flito_tramite_viajes_logistica"."tramite_id" = "flito_tramites"."id")';
const SUBCONSULTA_CUENTA = '(SELECT COUNT(*)::int FROM "flito_tramite_viajes_logistica" '
  + 'WHERE "flito_tramite_viajes_logistica"."tramite_id" = "flito_tramites"."id")';
/** HU #12653: el viaje 1 es COALESCE(comprobante de pago aplicado, tarifa); la Σ de viajes sigue FUERA. */
const VIAJE_1 = 'COALESCE((select "flito_comprobantes"."valor" from "flito_comprobantes" where "flito_comprobantes"."tramite_id" = "flito_tramites"."id" '
  + 'and "flito_comprobantes"."concepto" = \'logistica\' and "flito_comprobantes"."estado" = \'aplicado\' and "flito_comprobantes"."es_pago" = true limit 1), "lg"."valor")';

describe('EXPR_LOGISTICA — tarifa + Σ viajes por subconsulta correlacionada (AC1, AC2, AC4)', () => {
  it('la rama estimada es COALESCE(documental, lg.valor) + COALESCE(Σ viajes, 0): sin COALESCE(lg.valor, 0) y sin parámetros', () => {
    const { sql, params } = renderizar(EXPR_LOGISTICA);
    // Mutante «solo Σ viajes» (55.000): faltaría la tarifa; «COALESCE(lg.valor, 0) + Σ»: sin tarifa
    // daría un valor en vez de «no configurado» (AC2). Desde la HU #12653 el viaje 1 lee primero el
    // comprobante de pago aplicado y la Σ de viajes se suma FUERA de ese COALESCE.
    expect(sql).toContain(`ELSE ${VIAJE_1} + COALESCE(${SUBCONSULTA_SUMA}, 0) END`);
    expect(sql).not.toContain('COALESCE("lg"."valor"');
    // Sellada manda y no se suma la tabla viva (AC4): la primera rama es la columna, a secas.
    expect(sql).toMatch(/^CASE WHEN "flito_liquidaciones"\."id" IS NOT NULL THEN "flito_liquidaciones"\."valor_logistica"\s+WHEN NOT/);
    expect(sql.indexOf('flito_tramite_viajes_logistica')).toBeGreaterThan(sql.indexOf('THEN NULL'));
    // Ni un `$n`: la referencia es columna contra columna (Bug #12058, consolidado).
    expect(params).toEqual([]);
    expect(sql).not.toMatch(/\$\d/);
  });

  it('no se suma antes del WHEN NOT gestiona: un autogestionable con filas sigue en NULL (AC3)', () => {
    const { sql } = renderizar(EXPR_LOGISTICA);
    // Tres ramas y en este orden: sellada → no gestiona (NULL, sin sumar nada) → estimada con viajes.
    expect(sql.match(/WHEN /g)).toHaveLength(2);
    expect(sql).toMatch(
      /"valor_logistica"\s+WHEN NOT \(NOT COALESCE\("clients"\."logistica_autogestionable", false\) OR \("flito_excepciones_autogestion"\."id" IS NOT NULL\)\) THEN NULL\s+ELSE COALESCE\(\(select "flito_comprobantes"\."valor"/,
    );
  });

  it('conJoins no añade un join a la tabla de viajes (AC1: el abanico)', () => {
    const { sql } = conJoins(new QueryBuilder().select({ id: flitoTramites.id }).from(flitoTramites).$dynamic()).toSQL();
    expect(sql).not.toMatch(/join "flito_tramite_viajes_logistica"/i);
  });
});

describe('EXPR_LOGISTICA_VIAJES_CANTIDAD — cuántos viajes, contando el 1 de la tarifa (AC5)', () => {
  it('sellada: totalViajes del snapshot solo si `viajes` es un array (jsonb_typeof); si no, NULL', () => {
    const { sql, params } = renderizar(EXPR_LOGISTICA_VIAJES_CANTIDAD);
    // Mutante «quitar jsonb_typeof»: un detalle escalar haría 22023 en el reporte entero (contra base).
    expect(sql).toContain(`THEN CASE WHEN jsonb_typeof("flito_liquidaciones"."detalle" -> 'logistica' -> 'viajes') = 'array'`);
    expect(sql).toContain(`THEN ("flito_liquidaciones"."detalle" -> 'logistica' ->> 'totalViajes')::int END`);
    // Sin ELSE en el CASE interno: sellada ANTES del Feature → NULL, no 0 (mutante «ELSE 0»).
    expect(sql).not.toMatch(/'totalViajes'\)::int ELSE/);
    // Claves como texto, no parámetros.
    expect(params).toEqual([]);
  });

  it('no gestiona → 0; sin sellar → 1 + COUNT de la tabla (mutante «olvidar el +1»)', () => {
    const { sql } = renderizar(EXPR_LOGISTICA_VIAJES_CANTIDAD);
    expect(sql).toMatch(/WHEN NOT \(NOT COALESCE\("clients"\."logistica_autogestionable", false\) OR \("flito_excepciones_autogestion"\."id" IS NOT NULL\)\) THEN 0\s+ELSE 1 \+ /);
    expect(sql).toContain(`ELSE 1 + ${SUBCONSULTA_CUENTA} END`);
  });

  it('SELECT_FILA la proyecta como `logisticaViajesCantidad`, DESPUÉS de las columnas de la HU #12432 (append-only; la HU #12653 añade las suyas detrás)', () => {
    const claves = Object.keys(SELECT_FILA);
    expect(claves.indexOf('logisticaViajesCantidad')).toBeGreaterThan(claves.indexOf('titularDireccion'));
    expect(claves.indexOf('logisticaViajesCantidad')).toBeLessThan(claves.indexOf('origenTd'));
    expect(renderizar(SELECT_FILA.logisticaViajesCantidad).sql).toBe(renderizar(EXPR_LOGISTICA_VIAJES_CANTIDAD).sql);
  });
});

describe('SELECT_TOTALES.logistica — la MISMA expresión que la celda (AC6)', () => {
  it('COALESCE(SUM(EXPR_LOGISTICA), 0), byte a byte, con la subconsulta dentro del agregado', () => {
    // Mutante «copia de la expresión sin viajes» en los totales: el SQL dejaría de ser igual.
    expect(renderizar(SELECT_TOTALES.logistica).sql).toBe(`COALESCE(SUM(${renderizar(EXPR_LOGISTICA).sql}), 0)`);
    expect(renderizar(SELECT_FILA.logistica).sql).toBe(renderizar(EXPR_LOGISTICA).sql);
    expect(renderizar(SELECT_TOTALES.logistica).params).toEqual([]);
  });

  it('el reintegro (RN-02) suma la logística CON viajes: la subconsulta aparece dos veces (término + GMF)', () => {
    const { sql } = renderizar(SELECT_TOTALES.totalReintegro);
    expect(sql.match(/SUM\("flito_tramite_viajes_logistica"\."valor"\)/g)).toHaveLength(2);
    // Y el servicio no la lleva: la logística es reintegro, no servicio.
    expect(renderizar(SELECT_TOTALES.totalServicio).sql).not.toContain('flito_tramite_viajes_logistica');
  });
});
