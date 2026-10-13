// HU #12873 (ADR-0025) — Migración 0233: el reparto «todos los del grupo» y el retiro de lo absorbido.
// Estática (el CI no levanta Postgres): SQL ↔ generador, sin literales de rol, y la PARIDAD del mundo
// de hoy — todas las migraciones plegadas contra el catálogo del código (AC9: lo que el arranque
// compara con la base). La doble aplicación sobre la base local va en el HANDOFF (P6).
//
// Mutantes nombrados:
//   · `HAVING count(DISTINCT …) >= (umbral)` → `>= 1`: cae «una sola forma canónica»; quitar una acción de
//     `tmp_lectura_12873` → cae «la lectura del SQL es `ACCIONES_LECTURA`» y, plegado, la paridad.
//   · quitar el `DELETE FROM permisos_funciones …`: cae «el paso 3 retira de las tres tablas».
//   · quitar una conjunción del generador: el pliegue deja `pedir_ambos` y cae la paridad AC9.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { sqlRepartoArbol } from '../../src/modules/permisos/arbol/sql-arbol.js';
import { ACCIONES_LECTURA, CODIGOS_ABSORBIDOS, predecesoresDe, ACCIONES_ARBOL } from '../../src/modules/permisos/arbol/expansion.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, bloqueGenerado, bloquesInsertSiRolExiste, leerFuncionesSembradas, leerRepartoSembrado, literalesDeRol, reglaTodosDeSql,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0233_permisos_arbol_gestion_reparto.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

describe('0233 — análisis estático', () => {
  it('sin BEGIN/COMMIT propio; número único; la anterior es la 0232', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0233_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0232_permisos_arbol_gestion_siembra.sql');
    expect(SQL.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL.split('\n').slice(0, 6).join('\n')).toMatch(/HU #12873[\s\S]*^-- Autor: /m);
  });

  it('el bloque entre marcas es EXACTAMENTE la salida del generador (`--arbol gestion --reparto`)', () => {
    expect(bloqueGenerado(SQL)).toBe(sqlRepartoArbol());
  });

  it('sin literales de rol: ni `VALUES (\'<rol>\'…)` ni `rol_codigo = \'<rol>\'`; todo reparto es INSERT … SELECT', () => {
    expect(literalesDeRol(SQL)).toEqual([]);
    // El detector ve un literal de rol en una sentencia de reparto (control positivo).
    expect(literalesDeRol("INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) SELECT 'admin', 'x';")).toEqual(['admin']);
    expect(literalesDeRol("INSERT INTO permisos_funciones (codigo, modulo) VALUES ('x', 'transito');")).toEqual([]);
    // La forma guardada por JOIN a `permisos_roles` no es un literal suelto (0 filas si el rol no existe).
    expect(literalesDeRol("INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo)\nSELECT v.rol, v.fn FROM (VALUES\n  ('admin', 'x')\n) AS v(rol, fn)\nJOIN permisos_roles r ON r.codigo = v.rol\nON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;")).toEqual([]);
    expect(SIN_COMENTARIOS).not.toMatch(/rol_codigo\s*=\s*'/);
    // El único VALUES de reparto es el del paso 2b, guardado por `JOIN permisos_roles` (AC8).
    const sinGuardado = SIN_COMENTARIOS.replace(/INSERT INTO permisos_rol_funcion \(rol_codigo, funcion_codigo\)\nSELECT v\.rol, v\.fn FROM \(VALUES[\s\S]*?\) AS v\(rol, fn\)\nJOIN permisos_roles r ON r\.codigo = v\.rol\n[^;]*;/, '');
    expect(sinGuardado).not.toBe(SIN_COMENTARIOS);
    expect(sinGuardado).not.toMatch(/INSERT INTO permisos_rol_funcion[^;]*VALUES/);
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_usuario_funcion[^;]*VALUES/);
  });

  it('una sola forma canónica de la regla (todos / alguna por umbral) para roles y para el paso de usuarios', () => {
    // Umbral por acción: |grupo| si modifica, 1 si está en `tmp_lectura_12873` (decisión del PO del 2026-10-13).
    expect(SIN_COMENTARIOS).toMatch(/CREATE TEMP TABLE tmp_umbral_12873 AS\nSELECT t\.accion, CASE WHEN l\.accion IS NULL THEN count\(\*\) ELSE 1 END AS k\n {2}FROM tmp_arbol_12873 t LEFT JOIN tmp_lectura_12873 l ON l\.accion = t\.accion\n GROUP BY t\.accion, l\.accion;/);
    expect(SIN_COMENTARIOS).toMatch(/GROUP BY rf\.rol_codigo, t\.accion\nHAVING count\(DISTINCT rf\.funcion_codigo\) >= \(SELECT u\.k FROM tmp_umbral_12873 u WHERE u\.accion = t\.accion\)/);
    expect(SIN_COMENTARIOS).toMatch(/\) >= a\.k AS todos,/);
    expect(SIN_COMENTARIOS).toMatch(/CROSS JOIN tmp_umbral_12873 a/);
    // El umbral se calcula DESPUÉS de descartar las acciones sin grupo entero (idempotencia).
    expect(SIN_COMENTARIOS.search(/CREATE TEMP TABLE tmp_umbral_12873/)).toBeGreaterThan(SIN_COMENTARIOS.search(/DELETE FROM tmp_arbol_12873 t WHERE/));
    expect(SIN_COMENTARIOS).toMatch(/WHERE o\.todos <> o\.rol_tiene/);
    // Idempotencia: solo las acciones cuyo grupo existe ENTERO.
    expect(SIN_COMENTARIOS).toMatch(/DELETE FROM tmp_arbol_12873 t WHERE t\.accion IN \(\n\s+SELECT x\.accion FROM tmp_arbol_12873 x\n\s+WHERE NOT EXISTS \(SELECT 1 FROM permisos_funciones f WHERE f\.codigo = x\.fn\)\);/);
  });

  it('AC8 (PO, 2026-10-13): el paso 2b marca a `admin` TODAS las acciones, por JOIN a permisos_roles, después de los usuarios y antes del retiro', () => {
    const bloques = bloquesInsertSiRolExiste(SQL);
    expect(bloques).toHaveLength(1);
    const pares = [...bloques[0]!.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => [m[1], m[2]]);
    expect([...new Set(pares.map(([r]) => r))]).toEqual(['admin']);
    expect(pares.map(([, a]) => a).sort()).toEqual(Object.keys(ACCIONES_ARBOL).sort());
    expect(pares.map(([, a]) => a)).toContain('accion.soat.solicitar_sin_tramite');
    const i = (re: RegExp) => SIN_COMENTARIOS.search(re);
    const usuarios = i(/INSERT INTO permisos_usuario_funcion/);
    const admin = i(/JOIN permisos_roles r ON r\.codigo = v\.rol/);
    const retiro = i(/DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN/);
    expect(admin).toBeGreaterThan(usuarios);
    expect(retiro).toBeGreaterThan(admin);
  });

  it('lo absorbido se llena DESPUÉS del recorte de grupos incompletos (un grupo incompleto no pierde miembros)', () => {
    const recorte = SIN_COMENTARIOS.search(/DELETE FROM tmp_arbol_12873 t WHERE t\.accion IN/);
    const llenado = SIN_COMENTARIOS.search(/INSERT INTO tmp_absorbidas_12873 \(fn\) SELECT DISTINCT fn FROM tmp_arbol_12873;/);
    const conjuncion = SIN_COMENTARIOS.search(/HAVING bool_and\(EXISTS \(SELECT 1 FROM tmp_arbol_12873 t WHERE t\.accion = c\.accion\)\)/);
    expect(recorte).toBeGreaterThan(0);
    expect(llenado).toBeGreaterThan(recorte);
    expect(conjuncion).toBeGreaterThan(llenado);
    expect(SIN_COMENTARIOS.match(/INSERT INTO tmp_absorbidas_12873/g)).toHaveLength(2);
  });

  it('el paso 3 retira lo absorbido de las tres tablas, en orden de FK (marcas antes que el catálogo)', () => {
    const i = (re: RegExp) => SIN_COMENTARIOS.search(re);
    const rol = i(/DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN \(SELECT fn FROM tmp_absorbidas_12873\);/);
    const usr = i(/DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN \(SELECT fn FROM tmp_absorbidas_12873\);/);
    const fun = i(/DELETE FROM permisos_funciones WHERE codigo IN \(SELECT fn FROM tmp_absorbidas_12873\);/);
    expect(rol).toBeGreaterThan(0);
    expect(usr).toBeGreaterThan(rol);
    expect(fun).toBeGreaterThan(usr);
  });

  it('el helper de paridad lee la regla: los grupos son los predecesores del código, lo absorbido es `CODIGOS_ABSORBIDOS`', () => {
    const r = reglaTodosDeSql(SQL)!;
    expect([...r.grupos.keys()].sort()).toEqual(Object.keys(ACCIONES_ARBOL).sort());
    for (const [a, g] of r.grupos) expect([...g].sort(), a).toEqual([...predecesoresDe(a)].sort());
    expect([...r.absorbidos].sort()).toEqual([...CODIGOS_ABSORBIDOS].sort());
    expect([...r.lectura].sort()).toEqual([...ACCIONES_LECTURA].sort());
    expect(r.absorbidos.has('logistica.actas.operar_ajenas')).toBe(false);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0232_permisos_arbol_gestion_siembra.sql') + 1);
  });
});

describe('AC9 — el mundo de hoy: todas las migraciones plegadas = el catálogo del código', () => {
  it('mismos códigos, mismo módulo y mismo tipo (lo que compara el arranque, más el tipo)', () => {
    const sembradas = leerFuncionesSembradas();
    const codigo = catalogoCompleto();
    expect([...sembradas.keys()].sort()).toEqual(codigo.map((f) => f.codigo).sort());
    for (const f of codigo) {
      expect(sembradas.get(f.codigo)!.modulo, f.codigo).toBe(f.modulo);
      expect(sembradas.get(f.codigo)!.tipo, f.codigo).toBe(f.tipo);
    }
  });

  it('el reparto plegado es el reparto de partida del código (la regla «todos» en SQL y en TS dicen lo mismo)', () => {
    const aPares = (m: Map<string, Set<string>>) => [...m.entries()].flatMap(([r, cs]) => [...cs].map((c) => `${r} ${c}`)).sort();
    expect(aPares(leerRepartoSembrado())).toEqual(repartoDePartida().map(([r, c]) => `${r} ${c}`).sort());
  });
});
