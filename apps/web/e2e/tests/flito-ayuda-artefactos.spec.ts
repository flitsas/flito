// Ayuda FLITO — plantilla, skill y cableado de matriz (HU #11893, AC6 y AC7).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/fixtures';
import { parsearFicha, fechaFichaLegible } from '../../src/lib/ayudaFicha';
import { CATALOGO_AYUDA } from '../../src/content/ayuda/catalogo';

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

  test('HU #11894 AC5 — las fichas de gestión existen en disco (sin Compuerta desde la HU #13431)', () => {
    const gestion = [
      'flito_tramites', 'soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones',
      'flito_tablero', 'flito_bitacora', 'flito_logistica',
      'flito_logistica_ruta', 'flito_comparendos', 'clients',
    ];
    for (const c of gestion) {
      const md = leer(`apps/web/src/content/ayuda/${c}.md`);
      expect(md.length, c).toBeGreaterThan(0);
      expect(md).toContain('## Qué es');
    }
  });

  test('AC6 — el catálogo lista sus claves y no aliasa credenciales a parametrización', () => {
    const catalogo = leer('apps/web/src/content/ayuda/catalogo.ts');
    const claves = [
      'flito_tramites', 'soat', 'flito_impuestos', 'flito_derechos', 'flito_revisiones',
      'flito_tablero', 'flito_bitacora', 'flito_logistica',
      'flito_logistica_ruta', 'flito_comparendos', 'clients', 'flito_bolsas',
      'flito_conciliacion', 'finanzas_reporte_costos', 'siigo_parametrizacion',
      'siigo_operacion', 'siigo_credenciales',
    ];
    for (const c of claves) {
      expect(catalogo).toContain(`clave: '${c}'`);
    }
    // HU #13431: la Compuerta no es un ítem del menú; su capítulo se retiró.
    expect(catalogo).not.toContain("clave: 'flito_compuerta'");
    expect(catalogo).toMatch(/clave: 'siigo_credenciales', grupo: 'administracion'/);
    // HU #12872: la ficha cuelga de SU slug y enlaza la pantalla real. Nunca alias a parametrización
    // (Financiera la tiene y vería credenciales).
    expect(catalogo).toMatch(/clave: 'siigo_credenciales'[^}]*to: '\/siigo\/credenciales'/);
    expect(catalogo).toMatch(/clave: 'siigo_credenciales'[^}]*permiso: 'siigo_credenciales'/);
    expect(catalogo).not.toMatch(/clave: 'siigo_credenciales'[^}]*permiso: 'siigo_parametrizacion'/);
  });

  // HU #13704 AC4: el +100 de «título igual a la consulta» deja cada ficha primera al buscar su
  // etiqueta. Dos etiquetas iguales (sin tildes ni mayúsculas) romperían esa garantía.
  test('HU #13704 AC4 — claves y etiquetas del catálogo son únicas', () => {
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const claves = CATALOGO_AYUDA.map((e) => e.clave);
    const etiquetas = CATALOGO_AYUDA.map((e) => norm(e.etiqueta));
    expect(new Set(claves).size, 'claves únicas').toBe(claves.length);
    expect(new Set(etiquetas).size, 'etiquetas únicas').toBe(etiquetas.length);
  });

  // Feature #13691 · HU #13703 AC4/AC5: encabezado obligatorio y estricto en cada ficha.
  const dirFichas = resolve(raiz, 'apps/web/src/content/ayuda');
  const fichas = readdirSync(dirFichas).filter((f) => f.endsWith('.md') && !f.startsWith('_'));

  test('HU #13703 AC4 — toda ficha trae encabezado válido (resumen, palabras_clave, consultas, version, fecha)', () => {
    expect(fichas.length).toBeGreaterThanOrEqual(22);
    for (const f of fichas) {
      const { encabezado, errores } = parsearFicha(readFileSync(resolve(dirFichas, f), 'utf8'));
      expect(errores, f).toEqual([]);
      expect(encabezado, f).not.toBeNull();
      expect(encabezado!.resumen.length, f).toBeGreaterThan(0);
      expect(encabezado!.palabrasClave.length, f).toBeGreaterThanOrEqual(1);
      expect(encabezado!.consultas.length, f).toBeGreaterThanOrEqual(1);
      expect(encabezado!.version, f).toMatch(/^\d+\.\d+$/);
      // El encabezado no se filtra al cuerpo: nada de `---` ni claves al inicio.
      expect(parsearFicha(readFileSync(resolve(dirFichas, f), 'utf8')).cuerpo, f).not.toMatch(/^---|^resumen:/);
    }
  });

  test('HU #13703 AC4 — el parser es estricto: falta, clave desconocida, versión o fecha inválidas', () => {
    const ok = [
      '---', 'resumen: Uno: con dos puntos, y coma.', 'palabras_clave:', '  - a', 'consultas:', '  - b',
      'version: 1.0', 'fecha: 2026-10-20', '---', '## Qué es', '',
    ].join('\n');
    const p = parsearFicha(ok);
    expect(p.errores).toEqual([]);
    expect(p.encabezado?.resumen).toBe('Uno: con dos puntos, y coma.');
    expect(p.cuerpo).toBe('## Qué es\n');
    expect(fechaFichaLegible('2026-10-20')).toBe('20/10/2026');

    const conCambio = (de: string, a: string) => parsearFicha(ok.replace(de, a)).errores;
    expect(conCambio('version: 1.0', 'version: 1')).not.toEqual([]);
    expect(conCambio('fecha: 2026-10-20', 'fecha: 2026-02-30')).not.toEqual([]);
    expect(conCambio('fecha: 2026-10-20', 'fecha: 20/10/2026')).not.toEqual([]);
    expect(conCambio('resumen: Uno: con dos puntos, y coma.', 'resumen:')).not.toEqual([]);
    expect(conCambio('  - a\n', '')).not.toEqual([]);
    expect(conCambio('  - b\n', '')).not.toEqual([]);
    expect(conCambio('version: 1.0', 'version: 1.0\nautor: x')).toEqual(expect.arrayContaining([expect.stringMatching(/desconocida/)]));
    const sinBloque = parsearFicha('## Qué es\n');
    expect(sinBloque.encabezado).toBeNull();
    expect(sinBloque.cuerpo).toBe('## Qué es\n');
    expect(sinBloque.errores).not.toEqual([]);
  });

  test('HU #13703 AC2/AC3 — resumen de fuente única: con .md no hay resumenPendiente; sin .md es obligatorio', () => {
    for (const e of CATALOGO_AYUDA) {
      const tieneMd = existsSync(resolve(dirFichas, `${e.clave}.md`));
      if (tieneMd) expect(e.resumenPendiente, e.clave).toBeUndefined();
      else expect(e.resumenPendiente?.trim().length ?? 0, e.clave).toBeGreaterThan(0);
    }
  });

  test('HU #13703 AC6 — plantilla y skill documentan el encabezado y que version y fecha suben en cada cambio', () => {
    const plantilla = leer('apps/web/src/content/ayuda/_plantilla.md');
    expect(parsearFicha(plantilla).errores).toEqual([]);
    expect(plantilla).toMatch(/suba la version y ponga la fecha/);
    const skill = leer('.claude/skills/flit-ayuda-flito/SKILL.md');
    for (const clave of ['resumen', 'palabras_clave', 'consultas', 'version', 'fecha']) {
      expect(skill).toContain(`\`${clave}\``);
    }
    expect(skill).toMatch(/se actualizan en cada cambio de la ficha/);
  });
});
