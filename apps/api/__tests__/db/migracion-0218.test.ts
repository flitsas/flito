// HU #13255 — La 0218: la página `perfil` (pantalla Perfil, HU #13256; Feature #13254) entra al motor
// de permisos como `pagina.perfil`, repartida SOLO a `admin`: no va en los defaults de ningún otro rol
// (DEFAULTS_POR_ROL no cambia; `cliente` tampoco la recibe); la concede el admin desde el panel de
// roles. Calco de migracion-0200.test.ts (HU #12623).
//
// Solo la mitad ESTÁTICA (siempre corre, también en CI): reglas del archivo (sin BEGIN, dollar-quoting
// etiquetado, numeración), la fila de `permisos_funciones` es EXACTAMENTE la que el catálogo del
// código produce para ese slug (módulo del grupo «General», label de `PAGES`), y el reparto es el que
// `rolesQueConcedenLaPagina` deriva de `DEFAULTS_POR_ROL` (solo admin). Mutantes nombrados:
//   · M1 — añadir `('cliente', 'pagina.perfil')` al INSERT: cae «el reparto es solo admin».
//   · M2 — meter `perfil` en `ROLE_DEFAULT_PAGES` de `cliente`: cae el mismo aserto por el lado del
//     catálogo (roles !== ['admin']) y la paridad de migracion-0179.test.ts.
// La idempotencia contra PostgreSQL (dos pasadas, una sola fila) se acredita a mano sobre la base
// local: el CI no levanta Postgres.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, PAGE_GROUPS, USER_ROLES, paginasPorDefecto } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, leerFuncionesSembradas, leerRepartoSembrado, leerRetirosSembrados,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0218_pagina_perfil.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0218 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0218.replace(/--[^\n]*/g, '');

const SLUG = 'perfil';
const CODIGO = `pagina.${SLUG}`;

describe('0218 — reglas del archivo y lo que siembra (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0218)).toEqual([]);
    expect(SQL_0218).toMatch(/DO \$resumen0218\$/);
    expect(SQL_0218).toMatch(/END \$resumen0218\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    // Ningún comentario nombra la etiqueta ni lleva un `$` (regla del README de migraciones).
    expect(SQL_0218.match(/--[^\n]*\$/g)).toBeNull();
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0218.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #13254/);
    expect(cabecera).toMatch(/HU #13255/);
  });

  it('el número es 0218, sigue a la 0217 sin hueco y no colisiona', () => {
    // No exige «es la última»: eso congela el tip y caería con la siguiente migración de otra HU.
    // La convención pide max+1 EN SU MOMENTO: la anterior es la 0217 y nadie más lleva el 0218.
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0218_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0217_sync_interruptor_fuente\.sql$/);
  });

  it('el slug está en PAGES, en el grupo «General» de PAGE_GROUPS (una sola vez, tras `dashboard`) y en los defaults de NINGÚN rol', () => {
    expect(PAGES[SLUG]).toBe('Perfil');
    const grupos = PAGE_GROUPS.filter((g) => g.pages.includes(SLUG)).map((g) => g.label);
    expect(grupos).toEqual(['General']);
    const general = PAGE_GROUPS.find((g) => g.label === 'General')!.pages;
    expect(general.indexOf(SLUG)).toBe(general.indexOf('dashboard') + 1);
    // AC1: ni `cliente` ni ningún rol de negocio la trae por defecto. `admin` no tiene fila en
    // `ROLE_DEFAULT_PAGES` (recibe todas las de PAGE_GROUPS por el generador).
    for (const rol of USER_ROLES) expect(paginasPorDefecto(rol).includes(SLUG), rol).toBe(false);
  });

  it('siembra exactamente la función de la página con los textos del catálogo del código (módulo `general`, tipo `pagina`)', () => {
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    const sembradas = leerFuncionesSembradas([ARCHIVO]);
    expect([...sembradas.keys()]).toEqual([CODIGO]);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO);
    expect(f, `${CODIGO} en el catálogo del código`).toBeDefined();
    expect(f!.tipo).toBe('pagina');
    expect(f!.modulo).toBe('general');
    expect(sembradas.get(CODIGO)).toEqual({ codigo: CODIGO, modulo: f!.modulo, nombre: f!.nombreNegocio, descripcion: f!.descripcion, tipo: 'pagina' });
    expect(sembradas.get(CODIGO)!.descripcion).toBe('Entrar a la pantalla «Perfil».');
  });

  it('el reparto es SOLO admin, igual en el SQL que en el catálogo del código (mutantes M1 y M2)', () => {
    const reparto = leerRepartoSembrado([ARCHIVO]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!]).toEqual([CODIGO]);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(f.roles).toEqual(['admin']);
  });

  it('no retira nada, y el helper de paridad la lee (está en MIGRACIONES_CON_REPARTO, después de la 0217)', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0217_sync_interruptor_fuente.sql') + 1);
    // Plegadas todas las migraciones con reparto, la página sigue concedida solo a admin.
    const total = leerRepartoSembrado();
    expect(total.get('admin')!.has(CODIGO)).toBe(true);
    for (const rol of [...total.keys()].filter((r) => r !== 'admin')) {
      expect(total.get(rol)!.has(CODIGO), rol).toBe(false);
    }
  });

  it('el resumen final revienta si la función o el reparto quedaron inconsistentes (no hay verde silencioso)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_funcion <> 1 OR n_reparto <> 1 THEN\s*RAISE EXCEPTION/);
  });
});
