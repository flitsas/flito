// HU #13427 (ADR-0025, diseño §5-bis) — Migración 0235: el paso de Finanzas al árbol («todos» si modifica,
// «alguna» si es de lectura) y el retiro de lo absorbido, incluido el transitorio `siigo.parametrizacion.administrar`.
// Estática (el CI no levanta Postgres): SQL ↔ generador, sin literales de rol, y la PARIDAD (AC9) del mundo
// de hoy 0001..0235 plegado contra el catálogo del código. La doble aplicación sobre la base local, en el HANDOFF (P6).
//
// Mutantes nombrados:
//   · quitar el `WHERE fn NOT IN ('pagina.finanzas_gastos_diarios')` → el pliegue retira la página y cae la paridad AC9.
//   · quitar una acción de `tmp_lectura_13427` → cae «la lectura del SQL es la de Finanzas» y la paridad.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { accionesSembradasDe, sqlRepartoArbol } from '../../src/modules/permisos/arbol/sql-arbol.js';
import { ACCIONES_LECTURA, predecesoresDe } from '../../src/modules/permisos/arbol/expansion.js';
import { absorbidosVivos } from '../../src/modules/permisos/arbol/reparto-arbol.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, bloqueGenerado, bloquesInsertSiRolExiste, leerFuncionesSembradas, leerRepartoSembrado, literalesDeRol, reglaTodosDeSql,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0235_permisos_arbol_finanzas_reparto.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');
// HU #13889: las del área que sembró y repartió la 0235 (las del expediente documental nacen en la 0248).
const FINANZAS = accionesSembradasDe('finanzas');

describe('0235 — análisis estático', () => {
  it('sin BEGIN/COMMIT propio; número único; la anterior es la 0234; cabecera', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0235_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0234_permisos_arbol_finanzas_siembra.sql');
    expect(SQL.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(SQL.split('\n').slice(0, 6).join('\n')).toMatch(/HU #13427[\s\S]*^-- Autor: /m);
  });

  it('el bloque entre marcas es EXACTAMENTE la salida del generador (`--arbol finanzas --reparto`)', () => {
    expect(bloqueGenerado(SQL)).toBe(sqlRepartoArbol('finanzas'));
  });

  it('sin literales de rol sueltos; el único VALUES de reparto es el de admin por JOIN a permisos_roles (AC7)', () => {
    expect(literalesDeRol(SQL)).toEqual([]);
    expect(SIN_COMENTARIOS).not.toMatch(/rol_codigo\s*=\s*'/);
    const bloques = bloquesInsertSiRolExiste(SQL);
    expect(bloques).toHaveLength(1);
    const pares = [...bloques[0]!.matchAll(/\('([^']+)', '([^']+)'\)/g)].map((m) => [m[1], m[2]]);
    expect([...new Set(pares.map(([r]) => r))]).toEqual(['admin']);
    expect(pares.map(([, a]) => a).sort()).toEqual([...FINANZAS]);
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_usuario_funcion[^;]*VALUES/);
  });

  it('tablas temporales propias (sufijo 13427) y la regla canónica por umbral; lo absorbido DESPUÉS del recorte', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/_12873\b/);
    expect(SIN_COMENTARIOS).toMatch(/CREATE TEMP TABLE tmp_umbral_13427 AS\nSELECT t\.accion, CASE WHEN l\.accion IS NULL THEN count\(\*\) ELSE 1 END AS k/);
    expect(SIN_COMENTARIOS).toMatch(/HAVING count\(DISTINCT rf\.funcion_codigo\) >= \(SELECT u\.k FROM tmp_umbral_13427 u WHERE u\.accion = t\.accion\)/);
    const recorte = SIN_COMENTARIOS.search(/DELETE FROM tmp_arbol_13427 t WHERE t\.accion IN/);
    const llenado = SIN_COMENTARIOS.search(/INSERT INTO tmp_absorbidas_13427 \(fn\) SELECT DISTINCT fn FROM tmp_arbol_13427\n WHERE fn NOT IN \('pagina\.finanzas_gastos_diarios'\);/);
    expect(recorte).toBeGreaterThan(0);
    expect(llenado).toBeGreaterThan(recorte);
    // Sin conjunciones en Finanzas: no hay bloque `VALUES` vacío (SQL inválido).
    expect(SIN_COMENTARIOS).not.toMatch(/AS c\(fn, accion\)/);
  });

  it('el paso 3 retira de las tres tablas, en orden de FK; admin (2b) después de los usuarios', () => {
    const i = (re: RegExp) => SIN_COMENTARIOS.search(re);
    const usuarios = i(/INSERT INTO permisos_usuario_funcion/);
    const admin = i(/JOIN permisos_roles r ON r\.codigo = v\.rol/);
    const rol = i(/DELETE FROM permisos_rol_funcion WHERE funcion_codigo IN \(SELECT fn FROM tmp_absorbidas_13427\);/);
    const usr = i(/DELETE FROM permisos_usuario_funcion WHERE funcion_codigo IN \(SELECT fn FROM tmp_absorbidas_13427\);/);
    const fun = i(/DELETE FROM permisos_funciones WHERE codigo IN \(SELECT fn FROM tmp_absorbidas_13427\);/);
    expect(admin).toBeGreaterThan(usuarios);
    expect(rol).toBeGreaterThan(admin);
    expect(usr).toBeGreaterThan(rol);
    expect(fun).toBeGreaterThan(usr);
  });

  it('el helper de paridad lee la regla: grupos = predecesores, lectura = la de Finanzas, absorbidos sin la página', () => {
    const r = reglaTodosDeSql(SQL)!;
    expect([...r.grupos.keys()].sort()).toEqual([...FINANZAS]);
    for (const [a, g] of r.grupos) expect([...g].sort(), a).toEqual([...predecesoresDe(a)].sort());
    expect([...r.lectura].sort()).toEqual(FINANZAS.filter((a) => ACCIONES_LECTURA.has(a)));
    expect([...r.absorbidos].sort()).toEqual([...absorbidosVivos(undefined, FINANZAS)].sort());
    expect(r.absorbidos.has('pagina.finanzas_gastos_diarios')).toBe(false);
    expect(r.absorbidos.has('siigo.parametrizacion.administrar')).toBe(true);
    expect(r.absorbidos.has('siigo.conceptos.confirmar')).toBe(false); // opcional (P-16)
    expect(r.absorbidos.has('liquidacion.pago_manual.administrar')).toBe(false); // P-14
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0234_permisos_arbol_finanzas_siembra.sql') + 1);
  });
});

describe('AC9 — el mundo de hoy (0001..0235 plegadas) = el catálogo del código', () => {
  it('mismos códigos, mismo módulo y mismo tipo', () => {
    const sembradas = leerFuncionesSembradas();
    const codigo = catalogoCompleto();
    expect([...sembradas.keys()].sort()).toEqual(codigo.map((f) => f.codigo).sort());
    for (const f of codigo) {
      expect(sembradas.get(f.codigo)!.modulo, f.codigo).toBe(f.modulo);
      expect(sembradas.get(f.codigo)!.tipo, f.codigo).toBe(f.tipo);
    }
    expect(sembradas.has('siigo.parametrizacion.administrar')).toBe(false);
    expect(sembradas.has('pagina.finanzas_gastos_diarios')).toBe(true);
  });

  it('el reparto plegado es el reparto de partida del código (la regla en SQL y en TS dicen lo mismo)', () => {
    const aPares = (m: Map<string, Set<string>>) => [...m.entries()].flatMap(([r, cs]) => [...cs].map((c) => `${r} ${c}`)).sort();
    expect(aPares(leerRepartoSembrado())).toEqual(repartoDePartida().map(([r, c]) => `${r} ${c}`).sort());
  });
});
