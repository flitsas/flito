// ADR-0041 §13 (Enmienda 1, Épica #13763) — costo de proveedor: forma del SQL y traducción a la fila. Corre SIEMPRE (sin base).
//
// El comportamiento de las reglas contra datos reales (C2, C3, C4, C7, C1, C6 y H-1…H-5) está en
// `__tests__/db/finanzas-costos-proveedor.pg.test.ts`, que necesita `TEST_DATABASE_URL` y el CI salta. Aquí se fija lo que
// sí se puede afirmar sin Postgres, para que el CI tenga un rojo si se rompe:
//   C1 / RN-CP-01  ninguna expresión de COBRO (total, base GMF, totales, bloqueos, incompletas) lee el costo de proveedor;
//                  `conJoins` no se toca; solo `SELECT_FILA` lo proyecta
//   C2 / RN-CP-02  vigencia `soat_con_tramite` en `enviado_en`; H-1 sin `enviado_en` ⇒ sin_proveedor; H-4 gestiona SOAT primero
//   C3 / RN-CP-03  el primero por `(created_at, id)` entre TODOS los trámites del `soat_id` (H-5: sin filtrar por compañía)
//   C4 / RN-CP-04  primera entrega VÁLIDA (H-3): `NOT legado` y acta desde el corte EN EL JOIN, ordenada por `entregado_en, id`
//   C7 / RN-CP-07  el filtro `costoProveedorSinConfigurar` añade una sola condición; sin él, ninguna
//   Traducción     `costosProveedorDeFila`: valor texto → número, total informativo, claves estables
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';

vi.mock('../../src/db/client.js', () => ({ db: {}, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const svc = await import('../../src/modules/finanzas/finanzas.service.js');
const { costosProveedorDeFila, conceptoDe, exprCostosProveedor, costosProveedorConsolidadoDe } = await import('../../src/modules/finanzas/finanzas.costos-proveedor.js');

const dialecto = new PgDialect();
const texto = (q: SQL) => dialecto.sqlToQuery(q).sql.replace(/\s+/g, ' ');
const VIGENCIAS = 'flito_tarifas_proveedor_vigencias';
const vivo = exprCostosProveedor({ gestionaSoat: sql`GS_MARCA`, gestionaLogistica: sql`GL_MARCA` });

describe('C1 / RN-CP-01 — el costo de proveedor no entra en ninguna expresión de cobro', () => {
  it('EXPR_TOTAL, EXPR_GMF, EXPR_INCOMPLETA (que contiene EXPR_BLOQUEADA) y SELECT_TOTALES no leen las vigencias de proveedor', () => {
    const cobro: Record<string, SQL> = {
      EXPR_TOTAL: svc.EXPR_TOTAL, EXPR_GMF: svc.EXPR_GMF, EXPR_INCOMPLETA: svc.EXPR_INCOMPLETA,
      ...Object.fromEntries(Object.entries(svc.SELECT_TOTALES).map(([k, v]) => [`SELECT_TOTALES.${k}`, v as SQL])),
    };
    for (const [nombre, q] of Object.entries(cobro)) {
      expect(texto(q), nombre).not.toContain(VIGENCIAS);
      expect(texto(q), nombre).not.toContain('costosProveedor');
    }
  });

  it('solo SELECT_FILA lo proyecta, en sus dos columnas jsonb; conJoins no se une a la tabla de vigencias', () => {
    const conCosto = Object.entries(svc.SELECT_FILA)
      .filter(([, v]) => v instanceof Object && 'getSQL' in (v as object) && texto((v as { getSQL(): SQL }).getSQL()).includes(VIGENCIAS))
      .map(([k]) => k);
    expect(conCosto.sort()).toEqual(['costoProveedorLogistica', 'costoProveedorSoat']);
    expect(svc.conJoins.toString()).not.toContain('Proveedor');
  });
});

describe('C2 / RN-CP-02 — SOAT con trámite', () => {
  const soat = texto(vivo.soatVivo);
  it('H-4: «no gestiona» va antes que cualquier proveedor; H-1: sin enviado_en ⇒ sin_proveedor antes de buscar vigencia', () => {
    expect(soat.indexOf('GS_MARCA')).toBeGreaterThan(-1);
    expect(soat.indexOf('GS_MARCA')).toBeLessThan(soat.indexOf('flito_proveedores p'));
    expect(soat).toMatch(/"enviado_en" IS NULL THEN jsonb_build_object\('estado', 'sin_proveedor'/);
  });
  it('vigencia soat_con_tramite que contiene enviado_en (rango semiabierto); nunca soat_sin_tramite (C5)', () => {
    expect(soat).toContain("tstzrange(v.vigente_desde, v.vigente_hasta, '[)') @> \"flito_soat\".\"enviado_en\"::timestamptz");
    expect(dialecto.sqlToQuery(vivo.soatVivo).params).toContain('soat_con_tramite');
    expect(soat).not.toContain('soat_sin_tramite');
  });
});

describe('C3 / RN-CP-03 — SOAT compartido', () => {
  it('H-5: el primero se busca entre TODOS los trámites del soat_id por (created_at, id), sin condición de compañía', () => {
    const soat = texto(vivo.soatVivo);
    expect(soat).toContain('(p1.created_at, p1.id) < ("flito_tramites"."created_at", "flito_tramites"."id")');
    expect(soat).toContain('ORDER BY p1.created_at, p1.id LIMIT 1');
    expect(soat).not.toMatch(/p1\.compania/);
  });
});

describe('C4 / RN-CP-04 — logística: primera entrega VÁLIDA (H-3)', () => {
  const log = texto(vivo.logisticaVivo);
  it('legado y acta anterior al corte se excluyen EN EL JOIN (se salta a la siguiente), no en un CASE de la primera', () => {
    expect(log).toMatch(/JOIN flito_logistica_traslados tr ON tr\.id = l\.traslado_id AND NOT tr\.legado/);
    expect(log).toMatch(/a\.created_at >= COALESCE\(\(SELECT c\.corte_en FROM flito_logistica_corte_proveedor c\)/);
    expect(log).not.toMatch(/WHEN tr\.legado/);
  });
  it('solo líneas entregadas de la licencia de tránsito, ordenadas por entregado_en, id; vigencia en entregado_en', () => {
    expect(log).toContain("l.estado = 'entregado'");
    expect(log).toContain("d.tipo = 'licencia_transito'");
    expect(log).toContain('ORDER BY a.entregado_en, a.id LIMIT 1');
    expect(log).toContain("@> a.entregado_en::timestamptz");
    expect(log.indexOf('GL_MARCA')).toBeLessThan(log.indexOf('flito_logistica_documentos'));
  });
});

describe('C7 / RN-CP-07 — filtro costoProveedorSinConfigurar', () => {
  it('true añade UNA condición sobre los dos estados; false o ausente, ninguna; no toca la etapa', () => {
    const base = svc.condiciones({});
    expect(svc.condiciones({ costoProveedorSinConfigurar: false })).toHaveLength(base.length);
    const con = svc.condiciones({ costoProveedorSinConfigurar: true });
    expect(con).toHaveLength(base.length + 1);
    const extra = texto(con.at(-1)!);
    expect(extra.match(/->>'estado' = 'sin_configurar'/g)).toHaveLength(2);
    expect(texto(svc.EXPR_INCOMPLETA)).not.toContain('sin_configurar');
  });
});

describe('Traducción a la fila — costosProveedorDeFila', () => {
  const crudo = (o: Record<string, unknown>) => ({
    estado: 'costo', proveedorId: 'p1', proveedor: 'Seguros Uno', vigenciaId: 'v1', valor: '12000.50',
    fechaReferencia: '2026-09-02T10:00:00+00:00', contadoEnTramiteId: null, contadoEnIdFlit: null, ...o,
  });

  it('valor texto o número → número; total = suma de los que tienen valor; null si ninguno', () => {
    const f = costosProveedorDeFila({ costoProveedorSoat: crudo({}), costoProveedorLogistica: JSON.stringify(crudo({ valor: 8000 })) });
    expect(f.costoProveedorSoat.valor).toBe(12000.5);
    expect(f.costoProveedorLogistica.valor).toBe(8000);
    expect(f.costoProveedorTotal).toBe(20000.5);
    expect(f.costoProveedorSoat.fechaReferencia).toBe('2026-09-02T10:00:00.000Z');
    const sin = costosProveedorDeFila({ costoProveedorSoat: crudo({ estado: 'sin_configurar', valor: null }), costoProveedorLogistica: null });
    expect(sin.costoProveedorTotal).toBeNull();
    expect(sin.costoProveedorSoat.estado).toBe('sin_configurar');
  });

  it('$0 es un costo válido (R4): suma 0, no null', () => {
    const f = costosProveedorDeFila({ costoProveedorSoat: crudo({ valor: 0 }), costoProveedorLogistica: crudo({ estado: 'sin_proveedor', valor: null }) });
    expect(f.costoProveedorTotal).toBe(0);
  });

  it('ausente o estado desconocido ⇒ sin_proveedor con TODAS las claves en null (contrato estable)', () => {
    expect(conceptoDe(undefined)).toEqual({
      estado: 'sin_proveedor', proveedorId: null, proveedor: null, vigenciaId: null, valor: null,
      fechaReferencia: null, contadoEnTramiteId: null, contadoEnIdFlit: null,
    });
    expect(conceptoDe({ estado: 'inventado', valor: 5 }).estado).toBe('sin_proveedor');
    expect(conceptoDe(crudo({ estado: 'ya_contado', valor: null, contadoEnTramiteId: 't1', contadoEnIdFlit: 'FLIT-1' })))
      .toMatchObject({ estado: 'ya_contado', contadoEnIdFlit: 'FLIT-1' });
  });
});

describe('Pie del detalle — costosProveedorConsolidadoDe (totalesCostosProveedor)', () => {
  it('numeric de pg (texto) → número; fila ausente ⇒ ceros; no trae claves de cobro (RN-CP-01)', () => {
    expect(costosProveedorConsolidadoDe({
      costoProveedorSoat: '20000.00', costoProveedorLogistica: '10000', costoProveedorTotal: '30000.00', tramitesCostoSinConfigurar: 2,
    })).toEqual({ costoProveedorSoat: 20000, costoProveedorLogistica: 10000, costoProveedorTotal: 30000, tramitesCostoSinConfigurar: 2 });
    expect(costosProveedorConsolidadoDe(undefined)).toEqual({ costoProveedorSoat: 0, costoProveedorLogistica: 0, costoProveedorTotal: 0, tramitesCostoSinConfigurar: 0 });
  });

  it('SELECT_TOTALES (los totales de cobro del pie) sigue sin claves de costo de proveedor', () => {
    expect(Object.keys(svc.SELECT_TOTALES).some((k) => k.toLowerCase().includes('proveedor'))).toBe(false);
  });
});
