// HU #13429 (ADR-0025, diseño §5-quater.6) — Migración 0238: elementos `menu.*`, la cadena de toda página, las
// acciones «Administrar» de PESV (P-24, A1) y el padre de los opcionales. Estática: el CI no levanta Postgres; la
// doble aplicación sobre la base local va en el HANDOFF (P6). TCs: TC-02, TC-21, TC-24.
//
// Se afirma «la anterior es 0237_» y NUNCA «la 0238 es la última».
// Mutantes nombrados:
//   · cambiar el nombre de un ítem en `legado.ts` sin regenerar → cae «el bloque es la salida del generador».
//   · sembrar `menu.ayuda` → cae «11 elementos, sin Ayuda».
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { sqlSiembraLegado } from '../../src/modules/permisos/arbol/sql-legado.js';
import { ACCIONES_POR_AREA } from '../../src/modules/permisos/arbol/expansion.js';
import { bloqueGenerado, leerFuncionesSembradas, literalesDeRol } from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0238_permisos_arbol_legado_siembra.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

describe('0238 — análisis estático', () => {
  it('sin BEGIN/COMMIT propio; número único; la anterior es la 0237 (no «es la última»); cabecera', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0238_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0237_permisos_arbol_administracion_reparto.sql');
    const cabecera = SQL.split('\n').slice(0, 7).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/HU #13429/);
    expect(cabecera).toMatch(/^-- Autor: /m);
  });

  it('TC-24: el bloque entre marcas es EXACTAMENTE la salida del generador (`--arbol legado`)', () => {
    expect(bloqueGenerado(SQL)).toBe(sqlSiembraLegado());
  });

  it('siembra 11 elementos (sin «Ayuda», derivada) y las 20 acciones «Administrar» de PESV; nada más', () => {
    const sembradas = leerFuncionesSembradas([ARCHIVO]);
    const elementos = [...sembradas.values()].filter((f) => f.tipo === 'elemento').map((f) => f.codigo).sort();
    expect(elementos).toHaveLength(11);
    expect(elementos).not.toContain('menu.ayuda');
    expect(elementos).toContain('menu.perfil');
    const acciones = [...sembradas.values()].filter((f) => f.tipo === 'accion').map((f) => f.codigo).sort();
    expect(acciones).toEqual([...ACCIONES_POR_AREA.legado]);
    expect(sembradas.size).toBe(31);
  });

  it('TC-02: toda página recibe su `menu.*` como padre y nivel 2 (FLITO y antiguas)', () => {
    for (const [p, m] of [['pagina.flito_soat', 'menu.gestion'], ['pagina.fleet', 'menu.flota'], ['pagina.pesv_plan', 'menu.pesv'],
      ['pagina.privacy', 'menu.administracion'], ['pagina.perfil', 'menu.perfil'], ['pagina.transito', 'menu.transito']]) {
      expect(SIN_COMENTARIOS, p).toMatch(new RegExp(`\\('${p}', '${m}', '2', '\\d+'\\)`));
    }
    expect(SIN_COMENTARIOS).toMatch(/AND \(f\.padre_codigo, f\.nivel, f\.orden\) IS DISTINCT FROM/);
  });

  it('los opcionales cuelgan de su acción o ítem; los transversales no se tocan', () => {
    expect(SIN_COMENTARIOS).toContain("('vehicles.propietario.ver_documento', 'pagina.vehicles')");
    expect(SIN_COMENTARIOS).toContain("('siigo.conceptos.confirmar', 'accion.facturacion_parametrizacion.ver')");
    expect(SIN_COMENTARIOS).not.toContain("'vehicles.vehiculos.consultar'");
  });

  it('TC-21: idempotente (upsert e UPDATE con IS DISTINCT FROM); solo siembra: ni reparto, ni borrados, ni DDL; sin literales de rol', () => {
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \(codigo\) DO UPDATE SET/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS.match(/IS DISTINCT FROM/g)!.length).toBeGreaterThanOrEqual(4);
    expect(SIN_COMENTARIOS).not.toMatch(/permisos_rol_funcion|permisos_usuario_funcion|\bDELETE FROM\b|\bTRUNCATE\b|\bALTER TABLE\b/i);
    expect(literalesDeRol(SQL)).toEqual([]);
    expect(SIN_COMENTARIOS).not.toMatch(/unaccent\(/i);
  });
});
