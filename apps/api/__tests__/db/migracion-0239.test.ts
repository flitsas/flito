// HU #13429 (ADR-0025, diseño §5-quater.4 y §5-quater.6) — Migración 0239: «Administrar» de PESV por regla de dato
// (P-24, A1), la cadena de roles y usuarios y el retiro de los transitorios. Estática (el CI no levanta Postgres):
// SQL ↔ generador, sin literales de rol, idempotencia por construcción y la PARIDAD (AC9/AC10) del mundo de hoy
// 0001..0239 plegado contra el catálogo del código. La doble aplicación real, en el HANDOFF (P6).
// TCs: TC-07, TC-21, TC-23, TC-24.
//
// Mutantes nombrados:
//   · quitar la condición `tmp_primera_13429` del paso C2 → la segunda corrida devolvería un `menu.*` quitado
//     desde el panel; cae «la cadena solo se reparte en la primera pasada».
//   · quitar `tmp_requisito_13429` → cae «el helper de paridad lee la regla» y la paridad del pliegue.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_ROLES } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { sqlRepartoLegado } from '../../src/modules/permisos/arbol/sql-legado.js';
import { ACCIONES_POR_AREA, paginaDeAccion, predecesoresDe } from '../../src/modules/permisos/arbol/expansion.js';
import { FAMILIA_ADMINISTRACION_PESV, TRANSITORIOS_RETIRADOS } from '../../src/modules/permisos/arbol/acciones-legado.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, bloqueGenerado, bloquesInsertSiRolExiste, leerFuncionesSembradas, leerRepartoSembrado,
  legadoDeSql, literalesDeRol, reglaTodosDeSql,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0239_permisos_arbol_legado_reparto.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');
const AREA = ACCIONES_POR_AREA.legado;
const i = (re: RegExp) => SIN_COMENTARIOS.search(re);

describe('0239 — análisis estático', () => {
  it('sin BEGIN/COMMIT propio; número único; la anterior es la 0238; cabecera', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0239_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0238_permisos_arbol_legado_siembra.sql');
    expect(SQL.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL.split('\n').slice(0, 7).join('\n')).toMatch(/HU #13429[\s\S]*^-- Autor: /m);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0238_permisos_arbol_legado_siembra.sql') + 1);
  });

  it('TC-24: el bloque entre marcas es EXACTAMENTE la salida del generador (`--arbol legado --reparto`)', () => {
    expect(bloqueGenerado(SQL)).toBe(sqlRepartoLegado());
  });

  it('TC-24: sin literales de rol sueltos; el único VALUES con rol es el de admin por JOIN (las 20 «Administrar»); sin unaccent()', () => {
    expect(literalesDeRol(SQL)).toEqual([]);
    for (const rol of USER_ROLES) expect(SIN_COMENTARIOS.includes(`'${rol}'`) && rol !== 'admin', rol).toBe(false);
    const bloques = bloquesInsertSiRolExiste(SQL);
    expect(bloques).toHaveLength(1);
    const pares = [...bloques[0]!.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => [m[1], m[2]]);
    expect([...new Set(pares.map(([r]) => r))]).toEqual(['admin']);
    expect(pares.map(([, a]) => a).sort()).toEqual([...AREA]);
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_usuario_funcion[^;]*VALUES/);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent\(/i);
  });

  it('A1: el grupo de cada «Administrar» es la familia PESV con «alguna», y además la página de su ítem', () => {
    const r = reglaTodosDeSql(SQL)!;
    expect([...r.grupos.keys()].sort()).toEqual([...AREA]);
    for (const [a, g] of r.grupos) expect([...g].sort(), a).toEqual([...predecesoresDe(a)].sort());
    expect([...r.lectura].sort()).toEqual([...AREA]);
    for (const a of AREA) expect(r.requisitos.get(a), a).toEqual([paginaDeAccion(a)]);
    expect([...r.absorbidos].sort()).toEqual([...FAMILIA_ADMINISTRACION_PESV].sort());
  });

  it('TC-07: el paso D retira el resto de los 43 transitorios (con el pago manual) y no toca `siigo.conceptos.administrar`', () => {
    const leg = legadoDeSql(SQL)!;
    const retirados = new Set([...reglaTodosDeSql(SQL)!.absorbidos, ...leg.legado.map(([fn]) => fn)]);
    for (const t of TRANSITORIOS_RETIRADOS) expect(retirados.has(t), t).toBe(true);
    expect(retirados.has('liquidacion.pago_manual.administrar')).toBe(true);
    expect(SIN_COMENTARIOS).not.toContain("'siigo.conceptos.administrar'");
  });

  it('TC-21: la cadena solo se reparte en la primera pasada; el retiro va al final y en orden de FK', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE TEMP TABLE tmp_primera_13429 AS SELECT EXISTS \(SELECT 1 FROM permisos_funciones f JOIN tmp_legado_13429/);
    const insertsCadena = SIN_COMENTARIOS.match(/JOIN tmp_cadena_13429 c ON c\.codigo = (?:rf|k)\.funcion_codigo\s+WHERE [^;]*\(SELECT si FROM tmp_primera_13429\)/g);
    expect(insertsCadena).toHaveLength(4); // C1, C2 (roles) y C3 ítem/elemento (usuarios)
    const primera = i(/CREATE TEMP TABLE tmp_primera_13429/);
    const genericoBorra = i(/DELETE FROM permisos_funciones WHERE codigo IN \(SELECT fn FROM tmp_absorbidas_13429\);/);
    const rol = i(/DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN \(SELECT fn FROM tmp_legado_13429\);/);
    const usr = i(/DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN \(SELECT fn FROM tmp_legado_13429\);/);
    const fun = i(/DELETE FROM permisos_funciones WHERE codigo IN \(SELECT fn FROM tmp_legado_13429\);/);
    expect(primera).toBeGreaterThan(genericoBorra);
    expect(rol).toBeGreaterThan(i(/SELECT DISTINCT k\.user_id, c\.elemento/));
    expect(usr).toBeGreaterThan(rol);
    expect(fun).toBeGreaterThan(usr);
  });

  it('usuarios: no se concede un ancestro que el usuario tiene revocado (la revocación fue explícita)', () => {
    expect(SIN_COMENTARIOS.match(/NOT EXISTS \(SELECT 1 FROM permisos_usuario_funcion x WHERE x\.user_id = k\.user_id AND x\.funcion_codigo = c\.(item|elemento)\)/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/x\.funcion_codigo = l\.item AND x\.efecto = 'revocar'/);
  });
});

describe('AC9 / AC10 / TC-23 — el mundo de hoy (0001..0239 plegadas) = el catálogo del código', () => {
  it('mismos códigos, mismo módulo y mismo tipo; elementos sembrados; fuera los 43 transitorios', () => {
    const sembradas = leerFuncionesSembradas();
    const codigo = catalogoCompleto();
    expect([...sembradas.keys()].sort()).toEqual(codigo.map((f) => f.codigo).sort());
    for (const f of codigo) {
      expect(sembradas.get(f.codigo)!.modulo, f.codigo).toBe(f.modulo);
      expect(sembradas.get(f.codigo)!.tipo, f.codigo).toBe(f.tipo);
    }
    for (const t of TRANSITORIOS_RETIRADOS) expect(sembradas.has(t), t).toBe(false);
    expect(sembradas.has('menu.perfil')).toBe(true);
  });

  it('el reparto plegado es el reparto de partida del código; `menu.perfil` llega a los 12 roles', () => {
    const plegado = leerRepartoSembrado();
    const aPares = (m: Map<string, Set<string>>) => [...m.entries()].flatMap(([r, cs]) => [...cs].map((c) => `${r} ${c}`)).sort();
    expect(aPares(plegado)).toEqual(repartoDePartida().map(([r, c]) => `${r} ${c}`).sort());
    for (const rol of USER_ROLES) expect(plegado.get(rol)?.has('menu.perfil'), rol).toBe(true);
  });
});
