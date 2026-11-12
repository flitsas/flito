import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularAlcance, esDocumentacion } from './ci-alcance.mjs';

test('un PR que solo trae ADR y AGENTS.md no es código', () => {
  const r = calcularAlcance(['docs/adr/ADR-0042-x.md', 'AGENTS.md', '.claude/skills/a/SKILL.md']);
  assert.equal(r.codigo, false);
});

test('las fichas de ayuda de apps/web sí son código (las testea la API)', () => {
  assert.equal(esDocumentacion('apps/web/src/content/ayuda/soat.md'), false);
  assert.equal(calcularAlcance(['apps/web/src/content/ayuda/soat.md']).codigo, true);
});

test('un .md en packages/ es código', () => {
  assert.equal(esDocumentacion('packages/shared-types/README.md'), false);
});

test('basta un archivo de código para correr todo', () => {
  assert.equal(calcularAlcance(['docs/a.md', 'scripts/check-ui.mjs']).codigo, true);
  assert.equal(calcularAlcance(['docs/a.md', '.github/workflows/ci.yml']).codigo, true);
  assert.equal(calcularAlcance(['docs/a.md', 'package-lock.json']).codigo, true);
});

test('falla seguro: lista vacía o con solo líneas en blanco = código', () => {
  assert.equal(calcularAlcance([]).codigo, true);
  assert.equal(calcularAlcance(['', '  ']).codigo, true);
});
