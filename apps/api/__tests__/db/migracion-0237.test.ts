// HU #13428 (ADR-0025, diseño §5-ter) — Migración 0237: paso de los permisos de Administración, Clientes y
// proveedores, Bitácora, Tablero y Perfil al árbol. Estática (el CI no levanta Postgres): SQL ↔ generador, sin
// literales de rol, reparto universal de Perfil (P-22) y la PARIDAD (AC9) del mundo de hoy 0001..0237 plegado
// contra el catálogo del código. La doble aplicación sobre la base local, en el HANDOFF (P6).
//
// Mutantes nombrados:
//   · quitar el `NOT EXISTS (… v.accion)` del paso 1b → la segunda corrida devuelve Perfil a un rol que lo perdió
//     desde el panel; cae «el paso 1b solo reparte si ningún rol tenía la acción».
//   · quitar una acción de `tmp_lectura_13428` → cae «la lectura del SQL es la del área» y la paridad.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_ROLES } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { sqlRepartoArbol } from '../../src/modules/permisos/arbol/sql-arbol.js';
import { ACCIONES_LECTURA, ACCIONES_POR_AREA, predecesoresDe } from '../../src/modules/permisos/arbol/expansion.js';
import { absorbidosVivos } from '../../src/modules/permisos/arbol/reparto-arbol.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, bloqueGenerado, bloquesInsertSiRolExiste, bloquesRepartoUniversal, leerFuncionesSembradas,
  leerRepartoSembrado, literalesDeRol, reglaTodosDeSql,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0237_permisos_arbol_administracion_reparto.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');
const AREA = ACCIONES_POR_AREA.administracion;

describe('0237 — análisis estático', () => {
  it('sin BEGIN/COMMIT propio; número único; la anterior es la 0236; cabecera', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0237_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0236_permisos_arbol_administracion_siembra.sql');
    expect(SQL.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL.split('\n').slice(0, 7).join('\n')).toMatch(/HU #13428[\s\S]*^-- Autor: /m);
  });

  it('el bloque entre marcas es EXACTAMENTE la salida del generador (`--arbol administracion --reparto`)', () => {
    expect(bloqueGenerado(SQL)).toBe(sqlRepartoArbol('administracion'));
  });

  it('sin literales de rol sueltos; el único VALUES con rol es el de admin por JOIN a permisos_roles (AC7); sin unaccent()', () => {
    expect(literalesDeRol(SQL)).toEqual([]);
    expect(SIN_COMENTARIOS).not.toMatch(/rol_codigo\s*=\s*'/);
    for (const rol of USER_ROLES) expect(SIN_COMENTARIOS.includes(`'${rol}'`) && rol !== 'admin', rol).toBe(false);
    const bloques = bloquesInsertSiRolExiste(SQL);
    expect(bloques).toHaveLength(1);
    const pares = [...bloques[0]!.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => [m[1], m[2]]);
    expect([...new Set(pares.map(([r]) => r))]).toEqual(['admin']);
    expect(pares.map(([, a]) => a).sort()).toEqual([...AREA]);
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_usuario_funcion[^;]*VALUES/);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent\(/i);
  });

  it('P-22 — paso 1b: Perfil y su página a CADA rol de permisos_roles, solo si la acción existe y ningún rol la tenía', () => {
    expect(bloquesRepartoUniversal(SQL)).toEqual([
      ['accion.perfil.cambiar_contrasena', 'accion.perfil.cambiar_contrasena'],
      ['accion.perfil.cambiar_contrasena', 'pagina.perfil'],
      ['accion.perfil.ver_datos', 'accion.perfil.ver_datos'],
      ['accion.perfil.ver_datos', 'pagina.perfil'],
    ]);
    expect(SIN_COMENTARIOS).toMatch(/SELECT r\.codigo, v\.fn\s+FROM permisos_roles r\s+CROSS JOIN/);
    expect(SIN_COMENTARIOS).toMatch(/WHERE EXISTS \(SELECT 1 FROM permisos_funciones f WHERE f\.codigo = v\.accion\)\s+AND NOT EXISTS \(SELECT 1 FROM permisos_rol_funcion x WHERE x\.funcion_codigo = v\.accion\)/);
    // Antes de los usuarios y de admin (2b): si 2b fuera antes, admin ya tendría la acción y nadie más la recibiría.
    const i = (re: RegExp) => SIN_COMENTARIOS.search(re);
    const universal = i(/FROM permisos_roles r\s+CROSS JOIN/);
    expect(universal).toBeGreaterThan(i(/HAVING count\(DISTINCT rf\.funcion_codigo\)/));
    expect(i(/INSERT INTO permisos_usuario_funcion/)).toBeGreaterThan(universal);
    expect(i(/JOIN permisos_roles r ON r\.codigo = v\.rol/)).toBeGreaterThan(universal);
  });

  it('tablas temporales propias (sufijo 13428); lo absorbido DESPUÉS del recorte; retiro en orden de FK', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/_1287[0-9]\b|_13427\b/);
    const i = (re: RegExp) => SIN_COMENTARIOS.search(re);
    const recorte = i(/DELETE FROM tmp_arbol_13428 t WHERE t\.accion IN/);
    const llenado = i(/INSERT INTO tmp_absorbidas_13428 \(fn\) SELECT DISTINCT fn FROM tmp_arbol_13428;/);
    expect(recorte).toBeGreaterThan(0);
    expect(llenado).toBeGreaterThan(recorte);
    const admin = i(/JOIN permisos_roles r ON r\.codigo = v\.rol/);
    const rol = i(/DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN \(SELECT fn FROM tmp_absorbidas_13428\);/);
    const usr = i(/DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN \(SELECT fn FROM tmp_absorbidas_13428\);/);
    const fun = i(/DELETE FROM permisos_funciones WHERE codigo IN \(SELECT fn FROM tmp_absorbidas_13428\);/);
    expect(admin).toBeGreaterThan(i(/INSERT INTO permisos_usuario_funcion/));
    expect(rol).toBeGreaterThan(admin);
    expect(usr).toBeGreaterThan(rol);
    expect(fun).toBeGreaterThan(usr);
  });

  it('el helper de paridad lee la regla: grupos = predecesores (sin las universales), lectura = la del área, absorbidos', () => {
    const r = reglaTodosDeSql(SQL)!;
    expect([...r.grupos.keys()].sort()).toEqual(AREA.filter((a) => !a.startsWith('accion.perfil.')));
    for (const [a, g] of r.grupos) expect([...g].sort(), a).toEqual([...predecesoresDe(a)].sort());
    expect([...r.lectura].sort()).toEqual(AREA.filter((a) => ACCIONES_LECTURA.has(a)));
    expect([...r.absorbidos].sort()).toEqual([...absorbidosVivos(undefined, AREA)].sort());
    for (const c of ['clients.clientes.administrar', 'pagina.flito_tablero', 'usuarios.usuario.editar', 'permisos.cuadro.guardar']) {
      expect(r.absorbidos.has(c), c).toBe(true);
    }
    for (const c of ['pagina.users', 'pagina.roles_permisos', 'pagina.clients', 'pagina.perfil', 'pagina.dashboard']) expect(r.absorbidos.has(c), c).toBe(false);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0236_permisos_arbol_administracion_siembra.sql') + 1);
  });
});

describe('AC9 — el mundo de hoy (0001..0237 plegadas) = el catálogo del código', () => {
  it('mismos códigos, mismo módulo y mismo tipo; fuera el transitorio y la página del Tablero FLITO', () => {
    const sembradas = leerFuncionesSembradas();
    const codigo = catalogoCompleto();
    expect([...sembradas.keys()].sort()).toEqual(codigo.map((f) => f.codigo).sort());
    for (const f of codigo) {
      expect(sembradas.get(f.codigo)!.modulo, f.codigo).toBe(f.modulo);
      expect(sembradas.get(f.codigo)!.tipo, f.codigo).toBe(f.tipo);
    }
    expect(sembradas.has('clients.clientes.administrar')).toBe(false);
    expect(sembradas.has('pagina.flito_tablero')).toBe(false);
    expect(sembradas.has('pagina.perfil')).toBe(true);
  });

  it('el reparto plegado es el reparto de partida del código; Perfil llega a los 12 roles', () => {
    const plegado = leerRepartoSembrado();
    const aPares = (m: Map<string, Set<string>>) => [...m.entries()].flatMap(([r, cs]) => [...cs].map((c) => `${r} ${c}`)).sort();
    expect(aPares(plegado)).toEqual(repartoDePartida().map(([r, c]) => `${r} ${c}`).sort());
    for (const rol of USER_ROLES) {
      for (const c of ['accion.perfil.cambiar_contrasena', 'accion.perfil.ver_datos', 'pagina.perfil']) expect(plegado.get(rol)?.has(c), `${rol} ${c}`).toBe(true);
    }
  });
});
