// HU #13588 (P-35..P-37) — Migración 0240: el ítem «Rendimiento», su reparto a quien tenía `rum.resumen.ver` y el
// retiro de los 5 permisos sueltos. Estática (el CI no levanta Postgres): forma del SQL, sin literales de rol,
// idempotencia por construcción y la PARIDAD del mundo de hoy (0001..0240 plegadas) contra el catálogo del código.
// La doble aplicación real va en el HANDOFF (P6).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_ROLES } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { SUELTAS_INCORPORADAS_13588, expandir } from '../../src/modules/permisos/arbol/expansion.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, bloquesInsertSiRolExiste, copiasDeReparto, leerFuncionesSembradas, leerRepartoSembrado, literalesDeRol,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0240_permisos_sueltos_a_su_item.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');
const i = (re: RegExp) => SIN_COMENTARIOS.search(re);
const SUELTAS = [...SUELTAS_INCORPORADAS_13588].map((c) => `'${c}'`).join(', ');

describe('0240 — análisis estático', () => {
  it('sin BEGIN/COMMIT propio; número único; la anterior es la 0239; cabecera', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0240_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0239_permisos_arbol_legado_reparto.sql');
    expect(SQL.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL.split('\n').slice(0, 7).join('\n')).toMatch(/HU #13588[\s\S]*^-- Autor: /m);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0239_permisos_arbol_legado_reparto.sql') + 1);
  });

  it('AC9: sin literales de rol sueltos; el único rol nombrado es `admin` por JOIN a permisos_roles; sin unaccent()', () => {
    expect(literalesDeRol(SQL)).toEqual([]);
    for (const rol of USER_ROLES.filter((r) => r !== 'admin')) expect(SIN_COMENTARIOS.includes(`'${rol}'`), rol).toBe(false);
    const bloques = bloquesInsertSiRolExiste(SQL);
    expect(bloques).toHaveLength(1);
    expect([...bloques[0]!.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['admin pagina.admin_rendimiento', 'admin menu.administracion']);
    expect(SIN_COMENTARIOS.split("'admin'").length - 1).toBe(2);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent\(/i);
  });

  it('AC8: el ítem y su elemento se COPIAN de `rum.resumen.ver` (regla de dato, no lista de roles)', () => {
    expect(copiasDeReparto(SQL)).toEqual([{ origen: 'rum.resumen.ver', destinos: ['pagina.admin_rendimiento', 'menu.administracion'] }]);
    // El ítem nace con su cadena: nivel 2 bajo Administración.
    expect(SIN_COMENTARIOS).toMatch(/\('pagina\.admin_rendimiento', 'administracion', 'Rendimiento', [^)]*'pagina', 'menu\.administracion', '2', '40'\)/);
  });

  it('AC9 idempotencia: upsert con IS DISTINCT FROM; todo reparto sale de `rum.resumen.ver`, que el retiro borra al FINAL', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO UPDATE SET [^;]*IS DISTINCT FROM/);
    const repartos = SIN_COMENTARIOS.match(/INSERT INTO permisos_(rol|usuario)_funcion[^;]*;/g)!
      .filter((r) => !r.includes('JOIN permisos_roles')); // la marca de `admin` (2b), aparte
    expect(repartos).toHaveLength(3);
    for (const r of repartos) {
      expect(r).toMatch(/funcion_codigo = 'rum\.resumen\.ver'/);
      expect(r).toMatch(/ON CONFLICT \([a-z_]+, funcion_codigo\) DO NOTHING;$/);
    }
    const rol = i(new RegExp(`DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN \\(${SUELTAS.replace(/[.()]/g, '\\$&')}\\);`));
    const usr = i(new RegExp(`DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN \\(${SUELTAS.replace(/[.()]/g, '\\$&')}\\);`));
    const fun = i(new RegExp(`DELETE FROM permisos_funciones WHERE codigo IN \\(${SUELTAS.replace(/[.()]/g, '\\$&')}\\);`));
    expect(rol).toBeGreaterThan(i(/'revocar'\s+FROM/));
    expect(usr).toBeGreaterThan(rol);
    expect(fun).toBeGreaterThan(usr);
  });

  it('usuarios: el `conceder` no pisa una fila propia (revocación explícita); el `revocar` pasa al ítem solo si su rol lo recibe', () => {
    expect(SIN_COMENTARIOS).toMatch(/NOT EXISTS \(SELECT 1 FROM permisos_usuario_funcion x WHERE x\.user_id = k\.user_id AND x\.funcion_codigo = v\.fn\)/);
    expect(SIN_COMENTARIOS).toMatch(/SELECT k\.user_id, 'pagina\.admin_rendimiento', 'revocar'[\s\S]*rx\.funcion_codigo = 'rum\.resumen\.ver'/);
  });
});

describe('AC6 / AC8 — el mundo de hoy (0001..0240 plegadas) = el catálogo del código', () => {
  it('mismos códigos, módulo y tipo; el ítem «Rendimiento» existe y las 5 sueltas ya no', () => {
    const sembradas = leerFuncionesSembradas();
    const codigo = catalogoCompleto();
    expect([...sembradas.keys()].sort()).toEqual(codigo.map((f) => f.codigo).sort());
    for (const f of codigo) expect(sembradas.get(f.codigo)!.tipo, f.codigo).toBe(f.tipo);
    expect(sembradas.get('pagina.admin_rendimiento')).toMatchObject({ modulo: 'administracion', tipo: 'pagina' });
    for (const s of SUELTAS_INCORPORADAS_13588) expect(sembradas.has(s), s).toBe(false);
  });

  it('el reparto plegado es el reparto de partida del código', () => {
    const plegado = leerRepartoSembrado();
    const aPares = (m: Map<string, Set<string>>) => [...m.entries()].flatMap(([r, cs]) => [...cs].map((c) => `${r} ${c}`)).sort();
    expect(aPares(plegado)).toEqual(repartoDePartida().map(([r, c]) => `${r} ${c}`).sort());
  });

  it('AC8: todo rol que tenía `rum.resumen.ver` tras la 0239 tiene el ítem con su cadena y conserva el acceso', () => {
    const antes = leerRepartoSembrado(MIGRACIONES_CON_REPARTO.filter((m) => m < '0240'));
    const despues = leerRepartoSembrado();
    const conRum = [...antes].filter(([, cs]) => cs.has('rum.resumen.ver')).map(([r]) => r);
    expect(conRum.length).toBeGreaterThan(0);
    for (const rol of conRum) {
      const d = despues.get(rol)!;
      expect(d.has('pagina.admin_rendimiento') && d.has('menu.administracion'), rol).toBe(true);
      expect(d.has('rum.resumen.ver'), `${rol}: sin fila directa`).toBe(false);
      expect(expandir(d).has('rum.resumen.ver'), rol).toBe(true);
    }
    for (const [rol, cs] of despues) for (const s of SUELTAS_INCORPORADAS_13588) expect(cs.has(s), `${rol} ${s}`).toBe(false);
  });
});
