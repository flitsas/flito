/**
 * HU #12170 — Helper `hasFuncion` (AC1 / AC6 mutantes nombrados).
 *
 * Corre con Node nativo (sin Vitest en apps/web):
 *   node --experimental-strip-types --test apps/web/src/lib/permissions-funciones.test.ts
 *
 * Mutantes que este archivo mata:
 *   1. `hasFuncion` siempre `true` → falla «sin permiso no ve control» (null/vacío → false).
 *   2. `hasFuncion` siempre `false` / conjunto vacío forzado → falla «con la función, true».
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFunctions, hasFuncion, motivoSinFuncion } from './permissions-funciones.ts';

describe('hasFuncion (HU #12170)', () => {
  it('fail-closed mientras el conjunto no ha llegado (null)', () => {
    assert.equal(hasFuncion(null, 'soat.solicitud.crear'), false);
    assert.equal(hasFuncion(undefined, 'soat.solicitud.crear'), false);
    assert.equal(effectiveFunctions(null), null);
  });

  it('conjunto vacío: ninguna función permitida (AC4 / mutante «siempre true»)', () => {
    assert.equal(hasFuncion([], 'soat.solicitud.crear'), false);
    assert.equal(hasFuncion([], 'soat.solicitud.enviar'), false);
    const set = effectiveFunctions([]);
    assert.ok(set);
    assert.equal(set.size, 0);
  });

  it('con la función en el conjunto: true (mutante «siempre vacío»)', () => {
    const mios = ['soat.cola.ver', 'soat.solicitud.crear'];
    assert.equal(hasFuncion(mios, 'soat.solicitud.crear'), true);
    assert.equal(hasFuncion(mios, 'soat.solicitud.enviar'), false);
  });

  it('motivoSinFuncion distingue módulo vs función (RN-A9)', () => {
    assert.match(motivoSinFuncion({ tieneModulo: false }), /módulo/i);
    assert.match(motivoSinFuncion({ tieneModulo: true }), /función/i);
    assert.match(
      motivoSinFuncion({ tieneModulo: true, nombreFuncion: 'Radicar una solicitud de SOAT' }),
      /Radicar/,
    );
  });
});
