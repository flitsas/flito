// HU #12872 (AC8): test del gate `check:roles-web`. Corre con `node --test` (sin Vitest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analizar, verificar, EXCEPCIONES } from './check-roles-web.mjs';

const reglas = (codigo, fichero) => analizar(codigo, fichero).map((h) => h.regla);

test('R1: comparar el rol contra un literal se reporta (mata M1: quitar R1)', () => {
  assert.deepEqual(reglas(`const a = user.role === 'admin';`), ['R1']);
  assert.deepEqual(reglas(`if (user?.role !== 'cliente') {}`), ['R1']);
  assert.deepEqual(reglas(`const a = 'financiera' == me.rolCodigo;`), ['R1']);
  assert.deepEqual(reglas(`function f(role: string) { return role === 'x'; }`), ['R1']);
  assert.deepEqual(reglas(`switch (user.role) { case 'admin': break; }`), ['R1']);
});

test('R1 con su línea: el hallazgo nombra fichero:línea', () => {
  const [h] = analizar(`const a = 1;\nconst b = user.role === 'transito';\n`, 'x.ts');
  assert.equal(h.linea, 2);
  assert.equal(h.regla, 'R1');
});

test('R2: includes/has del rol', () => {
  assert.deepEqual(reglas(`const ok = it.roles.includes(user.role);`), ['R2']);
  assert.deepEqual(reglas(`const ok = ROL_PERMITIDO.has(user.role);`), ['R2']);
});

test('R3: predicado puede/es/tiene/is/has/can con el rol como argumento', () => {
  assert.deepEqual(reglas(`puedeConciliar(user?.role);`), ['R3']);
  assert.deepEqual(reglas(`const x = puedeMutarTraspaso(user.role, estado, 'generar');`), ['R3']);
  assert.deepEqual(reglas(`isAllowed(u.rol);`), ['R3']);
});

test('R4: `roles: [...]` en un objeto literal', () => {
  assert.deepEqual(reglas(`const it = { page: 'x', roles: ['mensajero'] };`), ['R4']);
});

test('R5: constantes ROLES_* / ROL_* con textos', () => {
  assert.deepEqual(reglas(`export const ROLES_BOLSAS = ['admin', 'financiera'];`), ['R5']);
  assert.deepEqual(reglas(`const ROL_PERMITIDO = new Set(['compliance', 'admin']);`), ['R5']);
  assert.deepEqual(reglas(`const ROLES_X = ['admin'] as const;`), ['R5']);
});

test('no cuenta: comentarios (mata M2: escanear texto en vez de AST)', () => {
  assert.deepEqual(reglas(`// if (user.role === 'admin') {}\n/* roles: ['admin'] */\nconst a = 1;`), []);
});

test('no cuenta: pintar, estilizar, etiquetar, comparar rol contra rol, role JSX, filtro vacío', () => {
  assert.deepEqual(reglas(`const v = <span role="status">{user?.role ?? '—'}</span>;`, 'a.tsx'), []);
  assert.deepEqual(reglas(`const c = ROLE_TONE[u.role]; const l = ROLE_LABELS;`), []);
  assert.deepEqual(reglas(`const e = etiquetaRol(u.role, catalogo);`), []);
  assert.deepEqual(reglas(`if (f.role !== user.role) body.role = f.role;`), []);
  assert.deepEqual(reglas(`const filtrado = rol !== '';`), []);
  assert.deepEqual(reglas(`const ok = hasFuncion('soat.cola.ver');`), []);
});

test('excepción declarada: exenta con su número exacto; sin ella se reporta (mata M3)', () => {
  const rel = 'apps/web/src/pages/TransitoTraspasoExpediente.tsx';
  const ficheros = [{ rel, codigo: `const p = puedeMutarTraspaso(user.role, e, 'generar_legal');` }];
  assert.deepEqual(verificar({ ficheros }).errores, []);
  assert.equal(verificar({ ficheros }).exentos.length, 1);
  assert.equal(verificar({ ficheros, excepciones: {} }).errores.length, 1);
});

test('excepción no es cheque en blanco: un hallazgo de más en el fichero exento es rojo', () => {
  const rel = 'apps/web/src/pages/TransitoTraspasoExpediente.tsx';
  const codigo = `puedeMutarTraspaso(user.role, e, 'a');\nconst x = user.role === 'transito';`;
  const { errores } = verificar({ ficheros: [{ rel, codigo }] });
  assert.ok(errores.some((e) => e.includes('declara 1')));
});

test('solo la excepción de traspaso existe (decisión de la HU #12872)', () => {
  assert.deepEqual(Object.keys(EXCEPCIONES), ['apps/web/src/pages/TransitoTraspasoExpediente.tsx']);
});

test('el árbol real de apps/web/src está limpio', () => {
  const { errores } = verificar();
  assert.deepEqual(errores, []);
});
