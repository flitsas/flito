// Ayuda FLITO — plantilla, skill y cableado de matriz (HU #11893, AC6 y AC7).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/fixtures';

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

function leer(rel: string): string {
  return readFileSync(resolve(raiz, rel), 'utf8');
}

test.describe('FLITO — Ayuda · artefactos AC6/AC7', () => {
  test('AC6 — la plantilla trae las seis secciones, tono usted, sin capturas ni endpoints', () => {
    const plantilla = leer('apps/web/src/content/ayuda/_plantilla.md');
    for (const h of ['## Qué es', '## Para quién', '## Cómo se entra', '## Pasos', '## Estados', '## Qué no hace']) {
      expect(plantilla, h).toContain(h);
    }
    expect(plantilla).toMatch(/\busted\b/i);
    expect(plantilla).not.toMatch(/!\[[^\]]*\]\(/);
    expect(plantilla).not.toMatch(/\/api\//);
    expect(plantilla).not.toMatch(/\b(CREATE TABLE|FROM public\.|pg_)/i);
  });

  test('AC7 — skill flit-ayuda-flito con frontmatter y gate duro', () => {
    const skill = leer('.claude/skills/flit-ayuda-flito/SKILL.md');
    expect(skill).toMatch(/^---\nname: flit-ayuda-flito\n/m);
    expect(skill).toMatch(/^description:/m);
    expect(skill).toMatch(/ficha|ayuda FLITO|docs\/usuario|cambio visible|pre-PR/i);
    expect(skill).toMatch(/gate duro/i);
    expect(skill).toMatch(/no se abre el PR/i);
    expect(skill).toMatch(/BACKEND-only/);
    expect(skill).toMatch(/CHORE/);
    expect(skill.split('\n').length).toBeLessThan(500);
  });

  test('AC7 — fila nueva en la matriz de AGENTS.md', () => {
    const agents = leer('AGENTS.md');
    expect(agents).toMatch(/flit-ayuda-flito/);
    expect(agents).toMatch(/\| Pre-PR \(ayuda in-app\) \|/);
    expect(agents).toMatch(/\| \*\*Skill\*\* `flit-ayuda-flito` \|/);
    expect(agents).toMatch(/Ficha de ayuda in-app/);
  });

  test('AC7 — mención en el ciclo pre-PR de flit-modo-desarrollo-auto', () => {
    const modo = leer('.claude/skills/flit-modo-desarrollo-auto/SKILL.md');
    expect(modo).toMatch(/flit-ayuda-flito/);
    expect(modo).toMatch(/paso 4b/);
    expect(modo).toMatch(/Skill flit-ayuda-flito/);
  });

  test('HU #11894 AC5 — las 12 fichas de gestión existen en disco', () => {
    const gestion = [
      'flito_tramites', 'soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones',
      'flito_compuerta', 'flito_tablero', 'flito_bitacora', 'flito_logistica',
      'flito_logistica_ruta', 'flito_comparendos', 'clients',
    ];
    for (const c of gestion) {
      const md = leer(`apps/web/src/content/ayuda/${c}.md`);
      expect(md.length, c).toBeGreaterThan(0);
      expect(md).toContain('## Qué es');
    }
  });

  test('AC6 — el catálogo lista 18 claves y no aliasa credenciales a parametrización', () => {
    const catalogo = leer('apps/web/src/content/ayuda/catalogo.ts');
    const claves = [
      'flito_tramites', 'soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones',
      'flito_compuerta', 'flito_tablero', 'flito_bitacora', 'flito_logistica',
      'flito_logistica_ruta', 'flito_comparendos', 'clients', 'flito_bolsas',
      'flito_conciliacion', 'finanzas_reporte_costos', 'siigo_parametrizacion',
      'siigo_operacion', 'siigo_credenciales',
    ];
    for (const c of claves) {
      expect(catalogo).toContain(`clave: '${c}'`);
    }
    expect(catalogo).toMatch(/clave: 'siigo_credenciales', grupo: 'administracion'/);
    expect(catalogo).not.toMatch(/clave: 'siigo_credenciales'[^}]*permiso:/);
  });
});
