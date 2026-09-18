// Comprobantes universales (Épica #12245, Feature #12606) — HU #12631 AC4: `flito-comprobantes.expr.ts` es un LEAF
// para F3 (#12607): exporta las subconsultas escalares de la fila documental de los honorarios y no importa nada
// de `finanzas/` ni de `flito-liquidacion/` (que serán quienes lo importen). Sin BD: se afirma sobre el SQL
// renderizado (`PgDialect.sqlToQuery`) y sobre el texto de los archivos.
//
// Mutantes que estas pruebas atrapan:
//   · concepto como parámetro (`${concepto}` en vez de `sql.raw`) → «SIN parámetros» cae (Bug #12058).
//   · quitar `estado = 'aplicado'` o `es_pago = true` → el SQL exacto de EXPR_DOC_TD cae.
//   · correlacionar con otra tabla → «"flito_tramites"."id"» cae.
//   · importar `../finanzas/…` o `../flito-liquidacion/…` desde expr.ts → el grep cae.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderizar } from '../helpers/sql-ligado.js';
import * as expr from '../../src/modules/flito-comprobantes/flito-comprobantes.expr.js';
import { flitoComprobantes } from '../../src/db/schema.js';

const RAIZ = resolve(import.meta.dirname, '../../src/modules');
const doc = (e: unknown) => renderizar(e as never);

describe('HU #12631 AC4 — flito-comprobantes.expr.ts', () => {
  it('EXPR_DOC_TD / EXPR_DOC_LG: subconsulta escalar sobre flito_comprobantes correlacionada con flito_tramites.id, por concepto literal, con estado = aplicado AND es_pago = true, SIN parámetros', () => {
    const td = doc(expr.EXPR_DOC_TD);
    expect(td.params).toEqual([]);
    expect(td.sql).toBe('(select "flito_comprobantes"."valor" from "flito_comprobantes" where "flito_comprobantes"."tramite_id" = "flito_tramites"."id" and "flito_comprobantes"."concepto" = \'tramite_digital\' and "flito_comprobantes"."estado" = \'aplicado\' and "flito_comprobantes"."es_pago" = true limit 1)');
    const lg = doc(expr.EXPR_DOC_LG);
    expect(lg.params).toEqual([]);
    expect(lg.sql).toBe('(select "flito_comprobantes"."valor" from "flito_comprobantes" where "flito_comprobantes"."tramite_id" = "flito_tramites"."id" and "flito_comprobantes"."concepto" = \'logistica\' and "flito_comprobantes"."estado" = \'aplicado\' and "flito_comprobantes"."es_pago" = true limit 1)');
  });

  it('las expresiones de diferencia y de marca, por concepto (incluida servicios_adicionales, que solo aporta la diferencia), con la misma correlación y sin parámetros', () => {
    for (const [e, col, concepto] of [
      [expr.EXPR_DIF_TD, 'diferencia_tarifa', 'tramite_digital'], [expr.EXPR_DIF_LG, 'diferencia_tarifa', 'logistica'], [expr.EXPR_DIF_SA, 'diferencia_tarifa', 'servicios_adicionales'],
      [expr.EXPR_MARCADO_TD, 'marcado_por_diferencia', 'tramite_digital'], [expr.EXPR_MARCADO_LG, 'marcado_por_diferencia', 'logistica'], [expr.EXPR_MARCADO_SA, 'marcado_por_diferencia', 'servicios_adicionales'],
    ] as const) {
      const q = doc(e);
      expect(q.params, `${col} ${concepto}`).toEqual([]);
      expect(q.sql).toBe(`(select "flito_comprobantes"."${col}" from "flito_comprobantes" where "flito_comprobantes"."tramite_id" = "flito_tramites"."id" and "flito_comprobantes"."concepto" = '${concepto}' and "flito_comprobantes"."estado" = 'aplicado' and "flito_comprobantes"."es_pago" = true limit 1)`);
    }
    expect(expr.CONCEPTOS_HONORARIO).toEqual(['tramite_digital', 'logistica', 'servicios_adicionales']);
    expect(expr.esHonorario('soat' as never)).toBe(false);
  });

  it('es un leaf: no importa nada de finanzas/ ni de flito-liquidacion/; finanzas/ lo importa SOLO desde valores-documentales y el service (HU #12653, F3); flito-liquidacion/ SOLO desde su service (HU #12654)', () => {
    const fuente = readFileSync(resolve(RAIZ, 'flito-comprobantes/flito-comprobantes.expr.ts'), 'utf8');
    const imports = [...fuente.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i, i).not.toMatch(/\/finanzas\//);
      expect(i, i).not.toMatch(/flito-liquidacion/);
      expect(i, i).not.toMatch(/finanzas-servicios-adicionales/);
    }
    // finanzas/: la conexión de F3 entra por dos archivos concretos y por ningún otro.
    const PUEDEN = ['finanzas.valores-documentales.ts', 'finanzas.service.ts'];
    const importanElLeaf: string[] = [];
    for (const f of readdirSync(resolve(RAIZ, 'finanzas'))) {
      if (!f.endsWith('.ts')) continue;
      const texto = readFileSync(resolve(RAIZ, 'finanzas', f), 'utf8');
      if (/flito-comprobantes\.expr/.test(texto)) importanElLeaf.push(f);
      if (!PUEDEN.includes(f)) expect(texto, `finanzas/${f}`).not.toMatch(/flito-comprobantes\.expr|flito_comprobantes|flitoComprobantes/);
    }
    expect(importanElLeaf.sort()).toEqual(PUEDEN.sort());
    // flito-liquidacion/: la HU #12654 lo conecta por UN archivo (el service) y solo por el leaf: la
    // tabla se nombra ahí únicamente como columna de `documental(...)`, nunca con join ni filtro propio.
    const importanEnLiquidacion: string[] = [];
    for (const f of readdirSync(resolve(RAIZ, 'flito-liquidacion'))) {
      if (!f.endsWith('.ts')) continue;
      const texto = readFileSync(resolve(RAIZ, 'flito-liquidacion', f), 'utf8');
      if (/flito-comprobantes\.expr/.test(texto)) importanEnLiquidacion.push(f);
      if (f !== 'flito-liquidacion.service.ts') expect(texto, `flito-liquidacion/${f}`).not.toMatch(/flito-comprobantes\.expr|flito_comprobantes|flitoComprobantes/);
      else {
        expect(texto).not.toMatch(/(leftJoin|innerJoin)\(flitoComprobantes/);
        expect(texto).not.toMatch(/flitoComprobantes\.(estado|esPago)/);
      }
    }
    expect(importanEnLiquidacion).toEqual(['flito-liquidacion.service.ts']);
  });

  it('HU #12653: exporta la fábrica documental() y documentalAceptadaPorNombre() con la MISMA correlación que EXPR_DOC_*, sin parámetros; no existe EXPR_DOC_SA', () => {
    const CORRELACION = (concepto: string) =>
      `where "flito_comprobantes"."tramite_id" = "flito_tramites"."id" and "flito_comprobantes"."concepto" = '${concepto}' and "flito_comprobantes"."estado" = 'aplicado' and "flito_comprobantes"."es_pago" = true limit 1)`;
    const ref = doc(expr.documental(flitoComprobantes.tarifaReferencia, 'logistica'));
    expect(ref.params).toEqual([]);
    expect(ref.sql).toBe(`(select "flito_comprobantes"."tarifa_referencia" from "flito_comprobantes" ${CORRELACION('logistica')}`);
    // La misma fábrica produce EXPR_DOC_TD: una sola definición de «qué fila documental cuenta».
    expect(doc(expr.documental(flitoComprobantes.valor, 'tramite_digital')).sql).toBe(doc(expr.EXPR_DOC_TD).sql);

    const nombre = doc(expr.documentalAceptadaPorNombre('servicios_adicionales'));
    expect(nombre.params).toEqual([]);
    expect(nombre.sql).toBe(`(select "users"."username" from "flito_comprobantes" join "users" on "users"."id" = "flito_comprobantes"."diferencia_aceptada_por_id" ${CORRELACION('servicios_adicionales')}`);
    expect(nombre.sql).not.toContain('extraccion');

    expect('EXPR_DOC_SA' in expr).toBe(false);
  });
});
