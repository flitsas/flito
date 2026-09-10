// HU #12375 — La 0184: la página `flito_tarifas` (configurador de tarifas, `/flito/tarifas`) entra al
// motor de permisos como `pagina.flito_tarifas`, repartida a `admin` y `financiera`.
//
// Solo la mitad ESTÁTICA (siempre corre, también en CI): reglas del archivo (sin BEGIN, dollar-quoting
// etiquetado, numeración), la fila de `permisos_funciones` es EXACTAMENTE la que el catálogo del
// código produce para ese slug (módulo del grupo «Finanzas», label de `PAGES`), y el reparto es el que
// `rolesQueConcedenLaPagina` deriva de `DEFAULTS_POR_ROL`. Mutantes nombrados:
//   · M1 — quitar `('financiera', 'pagina.flito_tarifas')` del INSERT: cae «el reparto es admin y financiera».
//   · M2 — quitar `flito_tarifas` de la fila `financiera` de DEFAULTS_POR_ROL: cae el mismo aserto por el
//     lado del catálogo (roles === ['admin']) y la paridad de migracion-0179.test.ts.
// La idempotencia contra PostgreSQL (dos pasadas, una sola fila) se acredita a mano en una transacción
// con ROLLBACK sobre la base local: el CI no levanta Postgres.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, PAGE_GROUPS, paginasPorDefecto } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, leerFuncionesSembradas, leerRepartoSembrado, leerRetirosSembrados,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0184_pagina_flito_tarifas.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0184 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0184.replace(/--[^\n]*/g, '');

const SLUG = 'flito_tarifas';
const CODIGO = `pagina.${SLUG}`;

describe('0184 — reglas del archivo y lo que siembra (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0184)).toEqual([]);
    expect(SQL_0184).toMatch(/DO \$resumen0184\$/);
    expect(SQL_0184).toMatch(/END \$resumen0184\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0184.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12365/);
    expect(cabecera).toMatch(/HU #12375/);
  });

  it('el número es 0184, sigue a la 0183 de la HU #12374 sin hueco y no colisiona', () => {
    // No exige «es la última»: eso congela el tip y caería con la 0185 de auditoría (#12171).
    // La convención pide max+1 EN SU MOMENTO: la anterior es la 0183 y nadie más lleva el 0184.
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0184_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0183_tarifas_vigencias_desde_siempre\.sql$/);
    expect(SQL_0184).toMatch(/0183_tarifas_vigencias_desde_siempre\.sql/);
  });

  it('el slug está en PAGES, en el grupo «Finanzas» de PAGE_GROUPS (una sola vez) y en los defaults de `financiera`', () => {
    expect(PAGES[SLUG]).toBe('Finanzas — Tarifas');
    const grupos = PAGE_GROUPS.filter((g) => g.pages.includes(SLUG)).map((g) => g.label);
    expect(grupos).toEqual(['Finanzas']);
    expect(paginasPorDefecto('financiera')).toContain(SLUG);
    // Y NO en el auditor: la 0182 le retiró `parametrizacion.tarifas.listar`; la pantalla le daría 403.
    expect(paginasPorDefecto('auditor')).not.toContain(SLUG);
  });

  it('siembra exactamente la función de la página con los textos del catálogo del código (módulo `finanzas`, tipo `pagina`)', () => {
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    const sembradas = leerFuncionesSembradas([ARCHIVO]);
    expect([...sembradas.keys()]).toEqual([CODIGO]);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO);
    expect(f, `${CODIGO} en el catálogo del código`).toBeDefined();
    expect(f!.tipo).toBe('pagina');
    expect(f!.modulo).toBe('finanzas');
    expect(sembradas.get(CODIGO)).toEqual({ codigo: CODIGO, modulo: f!.modulo, nombre: f!.nombreNegocio, descripcion: f!.descripcion, tipo: 'pagina' });
  });

  it('el reparto es admin y financiera, igual en el SQL que en el catálogo del código (mutantes M1 y M2)', () => {
    const reparto = leerRepartoSembrado([ARCHIVO]);
    expect([...reparto.keys()].sort()).toEqual(['admin', 'financiera']);
    expect([...reparto.get('admin')!]).toEqual([CODIGO]);
    expect([...reparto.get('financiera')!]).toEqual([CODIGO]);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(f.roles).toEqual(['admin', 'financiera']);
  });

  it('no retira nada, y el helper de paridad la lee (está en MIGRACIONES_CON_REPARTO)', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    // Plegadas todas las migraciones con reparto, la página sigue concedida a los dos roles.
    const total = leerRepartoSembrado();
    expect(total.get('admin')!.has(CODIGO)).toBe(true);
    expect(total.get('financiera')!.has(CODIGO)).toBe(true);
    expect(total.get('auditor')?.has(CODIGO) ?? false).toBe(false);
  });

  it('el resumen final revienta si la función o el reparto quedaron inconsistentes (no hay verde silencioso)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_funcion <> 1 OR n_reparto <> 2 THEN\s*RAISE EXCEPTION/);
  });
});
