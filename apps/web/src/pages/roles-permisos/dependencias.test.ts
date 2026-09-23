/**
 * HU #12717 — dependencia pantalla → acciones en las funciones puras (ficha UX §14).
 *
 * Corre con Node nativo (sin Vitest en apps/web), igual que `modulos.test.ts`:
 *   node --experimental-strip-types --test apps/web/src/pages/roles-permisos/dependencias.test.ts
 *
 * Mutantes (§14.7) que este archivo mata:
 *   1. Habilitar las acciones con 0 pantallas marcadas en un módulo que sí tiene pantalla
 *      (`moduloHabilitado` → `true`) → falla «sin pantalla marcada, deshabilitado».
 *   2. Desmarcar las acciones al quitar UNA de dos pantallas (contar «una marcada» como «ninguna»)
 *      → falla «con dos pantallas, quitar una no toca las acciones».
 *   3. «Marcar todas» que marque solo las acciones → falla «marcarModulo incluye la(s) pantalla(s)».
 *   4. Tratar «módulo sin pantalla» como «pantalla desmarcada» → falla «sin pantalla no hay
 *      dependencia» (habilitado, sin huérfanas, sin explicación).
 *   5. `accionesSinPantalla` que devuelva también las desmarcadas, o que devuelva algo con una
 *      pantalla marcada → falla «solo las marcadas y solo sin pantalla».
 *   6. `desmarcarPantalla` que mute el Set de entrada, o que deje una acción marcada → falla
 *      «devuelve un Set nuevo» y «desmarca todas las acciones».
 *   7. Copy: singular/plural del aviso, «una de las dos pantallas», «Desmarcarla» con n = 1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_MARCA_PRIMERO_PANTALLA, COPY_MARCA_PRIMERO_UNA_PANTALLA, accionesSinPantalla, avisoSinPantalla, botonDesmarcar,
  desmarcarPantalla, explicacionModulo, marcarModulo, moduloHabilitado, pantallasDe, sufijoSinPantalla,
} from './dependencias.ts';

const pagina = (codigo: string, nombreNegocio = codigo) => ({ codigo, nombreNegocio, descripcion: null, tipo: 'pagina' as const });
const accion = (codigo: string) => ({ codigo, nombreNegocio: codigo, descripcion: null, tipo: 'operacion' as const });

const IMPUESTOS = { modulo: 'impuestos', funciones: [pagina('pagina.flito_impuestos', 'Entrar al portal de Impuestos'), accion('impuestos.pagar'), accion('impuestos.exportar')] };
const LOGISTICA = {
  modulo: 'logistica',
  funciones: [pagina('pagina.flito_logistica', 'Entrar a Logística'), pagina('pagina.flito_logistica_ruta', 'Entrar a la ruta'), accion('logistica.crear'), accion('logistica.cerrar'), accion('logistica.exportar')],
};
const CATALOGOS = { modulo: 'catalogos_compartidos', funciones: [accion('catalogos.leer'), accion('catalogos.exportar')] };
const GENERAL = { modulo: 'general', funciones: [pagina('pagina.dashboard')] };

describe('dependencias (HU #12717)', () => {
  it('pantallasDe: solo las `tipo: pagina`, en su orden', () => {
    assert.deepEqual(pantallasDe(LOGISTICA).map((p) => p.codigo), ['pagina.flito_logistica', 'pagina.flito_logistica_ruta']);
    assert.deepEqual(pantallasDe(CATALOGOS), []);
  });

  it('sin pantalla marcada, deshabilitado; con la pantalla marcada, habilitado (reglas 1 y 2)', () => {
    assert.equal(moduloHabilitado(IMPUESTOS, new Set()), false);
    assert.equal(moduloHabilitado(IMPUESTOS, new Set(['impuestos.pagar'])), false);
    assert.equal(moduloHabilitado(IMPUESTOS, new Set(['pagina.flito_impuestos'])), true);
  });

  it('con dos pantallas basta una marcada (regla 3)', () => {
    assert.equal(moduloHabilitado(LOGISTICA, new Set(['pagina.flito_logistica_ruta'])), true);
    assert.equal(moduloHabilitado(LOGISTICA, new Set(['pagina.flito_logistica'])), true);
    assert.equal(moduloHabilitado(LOGISTICA, new Set(['logistica.crear'])), false);
  });

  it('sin pantalla no hay dependencia: habilitado, sin huérfanas, sin explicación (regla 6)', () => {
    assert.equal(moduloHabilitado(CATALOGOS, new Set()), true);
    assert.deepEqual(accionesSinPantalla(CATALOGOS, new Set(['catalogos.leer'])), []);
    assert.equal(explicacionModulo(CATALOGOS), null);
  });

  it('desmarcar la única pantalla desmarca todas las acciones del módulo y devuelve un Set nuevo (regla 4)', () => {
    const antes = new Set(['pagina.flito_impuestos', 'impuestos.pagar', 'impuestos.exportar', 'pagina.dashboard']);
    const despues = desmarcarPantalla(IMPUESTOS, antes, 'pagina.flito_impuestos');
    assert.deepEqual([...despues].sort(), ['pagina.dashboard']);
    // La entrada no se muta (el borrador de React es inmutable por contrato).
    assert.equal(antes.size, 4);
    assert.notEqual(despues, antes);
  });

  it('con dos pantallas, quitar una no toca las acciones; quitar la última sí (reglas 4 y 5)', () => {
    const base = new Set(['pagina.flito_logistica', 'pagina.flito_logistica_ruta', 'logistica.crear', 'logistica.cerrar', 'logistica.exportar']);
    const sinRuta = desmarcarPantalla(LOGISTICA, base, 'pagina.flito_logistica_ruta');
    assert.deepEqual([...sinRuta].sort(), ['logistica.cerrar', 'logistica.crear', 'logistica.exportar', 'pagina.flito_logistica']);
    const sinNinguna = desmarcarPantalla(LOGISTICA, sinRuta, 'pagina.flito_logistica');
    assert.deepEqual([...sinNinguna], []);
  });

  it('desmarcar una pantalla de otro módulo no toca este', () => {
    const base = new Set(['pagina.flito_impuestos', 'impuestos.pagar', 'pagina.dashboard']);
    const s = desmarcarPantalla(GENERAL, base, 'pagina.dashboard');
    assert.deepEqual([...s].sort(), ['impuestos.pagar', 'pagina.flito_impuestos']);
  });

  it('accionesSinPantalla: solo las marcadas y solo sin ninguna pantalla marcada (regla 7)', () => {
    assert.deepEqual(accionesSinPantalla(IMPUESTOS, new Set(['impuestos.pagar'])), ['impuestos.pagar']);
    assert.deepEqual(accionesSinPantalla(IMPUESTOS, new Set(['impuestos.pagar', 'impuestos.exportar'])), ['impuestos.pagar', 'impuestos.exportar']);
    assert.deepEqual(accionesSinPantalla(IMPUESTOS, new Set(['pagina.flito_impuestos', 'impuestos.pagar'])), []);
    assert.deepEqual(accionesSinPantalla(IMPUESTOS, new Set()), []);
    assert.deepEqual(accionesSinPantalla(LOGISTICA, new Set(['pagina.flito_logistica_ruta', 'logistica.crear'])), []);
    assert.deepEqual(accionesSinPantalla(LOGISTICA, new Set(['logistica.crear'])), ['logistica.crear']);
    assert.deepEqual(accionesSinPantalla(GENERAL, new Set()), []);
  });

  it('marcarModulo incluye la(s) pantalla(s) y las acciones (regla del «Marcar todas»)', () => {
    assert.deepEqual(marcarModulo(LOGISTICA), ['pagina.flito_logistica', 'pagina.flito_logistica_ruta', 'logistica.crear', 'logistica.cerrar', 'logistica.exportar']);
    assert.deepEqual(marcarModulo(CATALOGOS), ['catalogos.leer', 'catalogos.exportar']);
    // Y lo que marca deja el módulo habilitado y sin huérfanas.
    const s = new Set(marcarModulo(LOGISTICA));
    assert.equal(moduloHabilitado(LOGISTICA, s), true);
    assert.deepEqual(accionesSinPantalla(LOGISTICA, s), []);
  });

  it('explicación por módulo: una pantalla vs dos (§14.5)', () => {
    assert.equal(explicacionModulo(IMPUESTOS), COPY_MARCA_PRIMERO_PANTALLA);
    assert.equal(explicacionModulo(LOGISTICA), COPY_MARCA_PRIMERO_UNA_PANTALLA);
    assert.equal(COPY_MARCA_PRIMERO_PANTALLA, 'Marca primero la pantalla para poder marcar estas acciones.');
    assert.equal(COPY_MARCA_PRIMERO_UNA_PANTALLA, 'Marca primero una de las dos pantallas para poder marcar estas acciones.');
  });

  it('aviso de carga inconsistente: singular/plural, una o dos pantallas, por nombre de negocio (§14.5)', () => {
    assert.equal(avisoSinPantalla(IMPUESTOS, 4), '4 acciones marcadas sin la pantalla. Marca «Entrar al portal de Impuestos» o desmárcalas.');
    assert.equal(avisoSinPantalla(IMPUESTOS, 1), '1 acción marcada sin la pantalla. Marca «Entrar al portal de Impuestos» o desmárcala.');
    assert.equal(avisoSinPantalla(LOGISTICA, 3), '3 acciones marcadas sin ninguna de sus pantallas. Marca «Entrar a Logística» o «Entrar a la ruta», o desmárcalas.');
    assert.equal(avisoSinPantalla(LOGISTICA, 1), '1 acción marcada sin ninguna de sus pantallas. Marca «Entrar a Logística» o «Entrar a la ruta», o desmárcala.');
    assert.ok(!avisoSinPantalla(IMPUESTOS, 2).includes('pagina.'));
  });

  it('botón y sufijo del encabezado', () => {
    assert.equal(botonDesmarcar(1), 'Desmarcarla');
    assert.equal(botonDesmarcar(2), 'Desmarcarlas');
    assert.equal(sufijoSinPantalla(1), '· 1 sin pantalla');
    assert.equal(sufijoSinPantalla(4), '· 4 sin pantalla');
  });
});
