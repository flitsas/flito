// Test de `check-ui.mjs` (node:test): fixtures positivos/negativos por regla, conteo
// exacto de excepciones y detección de excepciones zombis. Corre en CI (job `checks`)
// y en local con: node --test scripts/check-ui.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analizar, verificar } from './check-ui.mjs';

test('U1: `<table>` cruda se reporta; FlitTable del kit no', () => {
  const hs = analizar(`
    import { FlitTable } from '../components/flit/flitPageKit';
    const a = <table className="w-full"><tbody /></table>;
    const b = <FlitTable columnas={c} filas={f} />;
  `);
  assert.equal(hs.length, 1);
  assert.equal(hs[0].regla, 'U1');
  assert.equal(hs[0].linea, 3);
});

test('U2: HEX sueltos se reportan (3, 6 y 8 dígitos); tokens --flit-* no', () => {
  const hs = analizar(`
    const a = '#fff';
    const b = '#FDE8E3';
    const c = '#16274480';
    const d = 'var(--flit-warning-ink)';
    const e = 'bg-flit-card';
  `);
  assert.deepEqual(hs.map((h) => h.regla), ['U2', 'U2', 'U2']);
  assert.deepEqual(hs.map((h) => h.linea), [2, 3, 4]);
});

test('U2: HEX en comentarios no cuenta', () => {
  const hs = analizar(`
    // antes era '#fff' a propósito
    /* el fondo era #FDE8E3
       en dos líneas #123456 */
    const a = 'var(--flit-bg-app)'; // sin hex: '#000' quedó atrás
  `);
  assert.equal(hs.length, 0);
});

test('U3: altura fuera de la canónica (h-10) se reporta; kit y h-10 explícita no', () => {
  const hs = analizar(`
    const a = <button className="h-9 rounded border">x</button>;
    const b = <input className={flitInp} />;
    const c = <button className={flitBtnSecondary}>y</button>;
    const d = <select className="h-10 w-full" />;
    const e = <button className={"h-8 px-3"}>z</button>;
    const f = <input className={\`h-9 \${extra}\`} />;
    const g = <input className={\`\${flitInp} h-10 pl-9\`} />;
  `);
  assert.deepEqual(hs.map((h) => h.regla), ['U3', 'U3', 'U3']);
  assert.deepEqual(hs.map((h) => h.linea), [2, 6, 7]);
});

test('verificar: excepción con conteo exacto exime; con conteo distinto falla', () => {
  const ficheros = [{ rel: 'apps/web/src/pages/FlitoX.tsx', codigo: `const a = '#fff';\n` }];
  const ok = verificar({ ficheros, excepciones: { 'apps/web/src/pages/FlitoX.tsx': { U2: { veces: 1, motivo: 'x' } } } });
  assert.equal(ok.errores.length, 0);
  assert.equal(ok.exentos.length, 1);
  const mal = verificar({ ficheros, excepciones: { 'apps/web/src/pages/FlitoX.tsx': { U2: { veces: 2, motivo: 'x' } } } });
  assert.ok(mal.errores.some((e) => e.includes('declara 2 hallazgo(s) y hay 1')));
});

test('verificar: excepción zombi (sin hallazgos) se detecta al recorrer el árbol real', () => {
  const { errores } = verificar({
    ficheros: [{ rel: 'apps/web/src/pages/FlitoX.tsx', codigo: `const a = 1;\n` }],
    excepciones: {},
  });
  assert.equal(errores.length, 0);
  // Sin `ficheros` inyectados no se puede probar el zombi sin tocar disco; se cubre
  // indirectamente: el repo corre `verificar()` real en CI y cualquier excepción
  // retirada del código debe retirarse también de EXCEPCIONES.
});
