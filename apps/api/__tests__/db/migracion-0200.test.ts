// HU #12623 — La 0200: la página `finanzas_gastos_diarios` (dashboard de gastos diarios de Finanzas,
// `/finanzas/gastos-diarios`, HU #12624) entra al motor de permisos como `pagina.finanzas_gastos_diarios`,
// repartida SOLO a `admin`: no va en los defaults de ningún otro rol (DEFAULTS_POR_ROL no cambia); la
// concede el admin desde el panel de roles. Calco de migracion-0192.test.ts (HU #12542) sin la parte
// «defaults de financiera».
//
// Solo la mitad ESTÁTICA (siempre corre, también en CI): reglas del archivo (sin BEGIN, dollar-quoting
// etiquetado, numeración), la fila de `permisos_funciones` es EXACTAMENTE la que el catálogo del
// código produce para ese slug (módulo del grupo «Finanzas», label de `PAGES`), y el reparto es el que
// `rolesQueConcedenLaPagina` deriva de `DEFAULTS_POR_ROL` (solo admin). Mutantes nombrados:
//   · M1 — añadir `('financiera', 'pagina.finanzas_gastos_diarios')` al INSERT: cae «el reparto es solo
//     admin» (el SQL trae dos roles) y el resumen `n_reparto <> 1`.
//   · M2 — meter `finanzas_gastos_diarios` en la fila `financiera` de DEFAULTS_POR_ROL: cae el mismo
//     aserto por el lado del catálogo (roles !== ['admin']) y la paridad de migracion-0179.test.ts.
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
const ARCHIVO = '0200_pagina_finanzas_gastos_diarios.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0200 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0200.replace(/--[^\n]*/g, '');

const SLUG = 'finanzas_gastos_diarios';
const CODIGO = `pagina.${SLUG}`;

describe('0200 — reglas del archivo y lo que siembra (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0200)).toEqual([]);
    expect(SQL_0200).toMatch(/DO \$resumen0200\$/);
    expect(SQL_0200).toMatch(/END \$resumen0200\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    // Ningún comentario nombra la etiqueta ni lleva un `$` (regla del README de migraciones).
    expect(SQL_0200.match(/--[^\n]*\$/g)).toBeNull();
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0200.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12621/);
    expect(cabecera).toMatch(/HU #12623/);
  });

  it('el número es 0200, sigue a la 0199 de la HU #12620 sin hueco y no colisiona', () => {
    // No exige «es la última»: eso congela el tip y caería con la siguiente migración de otra HU.
    // La convención pide max+1 EN SU MOMENTO: la anterior es la 0199 y nadie más lleva el 0200.
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0200_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0199_tramite_viajes_logistica\.sql$/);
  });

  it('el slug está en PAGES, en el grupo «Finanzas» de PAGE_GROUPS (una sola vez, tras `finanzas_reporte_costos`) y en los defaults de NINGÚN rol', () => {
    expect(PAGES[SLUG]).toBe('Finanzas — Gastos diarios');
    const grupos = PAGE_GROUPS.filter((g) => g.pages.includes(SLUG)).map((g) => g.label);
    expect(grupos).toEqual(['Finanzas']);
    const finanzas = PAGE_GROUPS.find((g) => g.label === 'Finanzas')!.pages;
    expect(finanzas.indexOf(SLUG)).toBe(finanzas.indexOf('finanzas_reporte_costos') + 1);
    // Reparto solo admin: `financiera` y `auditor` (los lectores del reporte de costos) NO la reciben
    // por defecto; la HU lo deja en manos del panel de roles. `admin` no tiene fila en
    // `ROLE_DEFAULT_PAGES` (recibe todas las de PAGE_GROUPS por el generador), así que aquí NINGÚN
    // rol la trae; que admin sí la concede lo dice `catalogoCompleto()` en el aserto de reparto.
    for (const rol of USER_ROLES) expect(paginasPorDefecto(rol).includes(SLUG), rol).toBe(false);
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
    expect(sembradas.get(CODIGO)!.descripcion).toBe('Entrar a la pantalla «Finanzas — Gastos diarios».');
  });

  it('el reparto es SOLO admin, igual en el SQL que en el catálogo del código (mutantes M1 y M2)', () => {
    const reparto = leerRepartoSembrado([ARCHIVO]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!]).toEqual([CODIGO]);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(f.roles).toEqual(['admin']);
  });

  it('no retira nada, y el helper de paridad la lee (está en MIGRACIONES_CON_REPARTO, después de la 0199)', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0199_tramite_viajes_logistica.sql') + 1);
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
