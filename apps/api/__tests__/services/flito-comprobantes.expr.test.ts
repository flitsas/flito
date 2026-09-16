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

  it('es un leaf: no importa nada de finanzas/ ni de flito-liquidacion/, y ningún archivo de esos módulos lo importa todavía (F3 lo conecta)', () => {
    const fuente = readFileSync(resolve(RAIZ, 'flito-comprobantes/flito-comprobantes.expr.ts'), 'utf8');
    const imports = [...fuente.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i, i).not.toMatch(/\/finanzas\//);
      expect(i, i).not.toMatch(/flito-liquidacion/);
      expect(i, i).not.toMatch(/finanzas-servicios-adicionales/);
    }
    for (const modulo of ['finanzas', 'flito-liquidacion']) {
      for (const f of readdirSync(resolve(RAIZ, modulo))) {
        if (!f.endsWith('.ts')) continue;
        const texto = readFileSync(resolve(RAIZ, modulo, f), 'utf8');
        expect(texto, `${modulo}/${f}`).not.toMatch(/flito-comprobantes\.expr/);
        expect(texto, `${modulo}/${f}`).not.toMatch(/flito_comprobantes|flitoComprobantes/);
      }
    }
  });
});
