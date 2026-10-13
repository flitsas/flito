// HU #13428 (ADR-0025, diseño §5-ter) — Migración 0236: siembra de las acciones de Administración (Usuarios,
// Roles y permisos), Gestión · Clientes y proveedores y Bitácora, General · Tablero y Perfil. Estática: el CI
// no levanta Postgres; la doble aplicación sobre la base local va en el HANDOFF (P6).
//
// Se afirma «la anterior es 0235_» y NUNCA «la 0236 es la última».
// Mutantes nombrados:
//   · cambiar un nombre de acción en `administracion.ts` sin regenerar → cae «el bloque es la salida del generador».
//   · añadir una fila de reparto a un rol con nombre → cae «solo siembra; sin literales de rol».
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { sqlSiembraArbol } from '../../src/modules/permisos/arbol/sql-arbol.js';
import { ACCIONES_POR_AREA } from '../../src/modules/permisos/arbol/expansion.js';
import { bloqueGenerado, leerFuncionesSembradas, literalesDeRol } from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0236_permisos_arbol_administracion_siembra.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

describe('0236 — análisis estático', () => {
  it('sin BEGIN/COMMIT propio; número único; la anterior es la 0235 (no «es la última»)', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0236_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0235_permisos_arbol_finanzas_reparto.sql');
  });

  it('cabecera: archivo, HU y autor', () => {
    const cabecera = SQL.split('\n').slice(0, 6).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/HU #13428/);
    expect(cabecera).toMatch(/^-- Autor: /m);
  });

  it('el bloque entre marcas es EXACTAMENTE la salida del generador (`--arbol administracion`)', () => {
    expect(bloqueGenerado(SQL)).toBe(sqlSiembraArbol('administracion'));
  });

  it('siembra las 24 acciones del área (ni una de otra área), con upsert idempotente, y marca nivel 2 a sus 6 páginas', () => {
    const sembradas = leerFuncionesSembradas([ARCHIVO]);
    expect([...sembradas.keys()].sort()).toEqual([...ACCIONES_POR_AREA.administracion]);
    expect(sembradas.size).toBe(24);
    for (const f of sembradas.values()) expect(f.tipo, f.codigo).toBe('accion');
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO UPDATE SET/);
    expect(SIN_COMENTARIOS).toMatch(/IS DISTINCT FROM \(EXCLUDED\.modulo/);
    expect(SIN_COMENTARIOS).toMatch(/AND \(f\.nivel, f\.orden\) IS DISTINCT FROM/);
    for (const p of ['pagina.clients', 'pagina.dashboard', 'pagina.flito_bitacora', 'pagina.perfil', 'pagina.roles_permisos', 'pagina.users']) {
      expect(SIN_COMENTARIOS, p).toContain(`('${p}', '2', `);
    }
  });

  it('solo siembra: ni reparto, ni excepciones, ni borrados, ni DDL; sin literales de rol', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_rol_funcion|permisos_usuario_funcion|\bDELETE FROM\b|\bTRUNCATE\b|\bALTER TABLE\b/i);
    expect(literalesDeRol(SQL)).toEqual([]);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent\(/i);
  });
});
