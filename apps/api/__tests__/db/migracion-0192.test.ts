// HU #12542 — La 0192: la página `flito_servicios_adicionales` (catálogo de servicios adicionales,
// `/flito/servicios-adicionales`) entra al motor de permisos como `pagina.flito_servicios_adicionales`,
// repartida a `admin` y `financiera`. Calco de migracion-0184.test.ts (HU #12375).
//
// Solo la mitad ESTÁTICA (siempre corre, también en CI): reglas del archivo (sin BEGIN, dollar-quoting
// etiquetado, numeración), la fila de `permisos_funciones` es EXACTAMENTE la que el catálogo del
// código produce para ese slug (módulo del grupo «Finanzas», label de `PAGES`), y el reparto es el que
// `rolesQueConcedenLaPagina` deriva de `DEFAULTS_POR_ROL`. Mutantes nombrados:
//   · M1 — quitar `('financiera', 'pagina.flito_servicios_adicionales')` del INSERT: cae «el reparto es
//     admin y financiera».
//   · M2 — quitar `flito_servicios_adicionales` de la fila `financiera` de DEFAULTS_POR_ROL: cae el mismo
//     aserto por el lado del catálogo (roles === ['admin']) y la paridad de migracion-0179.test.ts.
// La idempotencia contra PostgreSQL (dos pasadas, una sola fila) se acredita a mano sobre la base
// local: el CI no levanta Postgres.
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
const ARCHIVO = '0192_pagina_flito_servicios_adicionales.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0192 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0192.replace(/--[^\n]*/g, '');

const SLUG = 'flito_servicios_adicionales';
const CODIGO = `pagina.${SLUG}`;

describe('0192 — reglas del archivo y lo que siembra (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0192)).toEqual([]);
    expect(SQL_0192).toMatch(/DO \$resumen0192\$/);
    expect(SQL_0192).toMatch(/END \$resumen0192\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    // Ningún comentario nombra la etiqueta ni lleva un `$` (regla del README de migraciones).
    expect(SQL_0192.match(/--[^\n]*\$/g)).toBeNull();
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0192.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12540/);
    expect(cabecera).toMatch(/HU #12542/);
  });

  it('el número es 0192, sigue a la 0191 de la HU #12541 sin hueco y no colisiona', () => {
    // No exige «es la última»: eso congela el tip y caería con la siguiente migración de otra HU.
    // La convención pide max+1 EN SU MOMENTO: la anterior es la 0191 y nadie más lleva el 0192.
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0192_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^0191_servicios_adicionales_tipos\.sql$/);
  });

  it('el slug está en PAGES, en el grupo «Finanzas» de PAGE_GROUPS (una sola vez, tras `flito_tarifas`) y en los defaults de `financiera`', () => {
    expect(PAGES[SLUG]).toBe('Finanzas — Servicios adicionales');
    const grupos = PAGE_GROUPS.filter((g) => g.pages.includes(SLUG)).map((g) => g.label);
    expect(grupos).toEqual(['Finanzas']);
    const finanzas = PAGE_GROUPS.find((g) => g.label === 'Finanzas')!.pages;
    expect(finanzas.indexOf(SLUG)).toBe(finanzas.indexOf('flito_tarifas') + 1);
    expect(paginasPorDefecto('financiera')).toContain(SLUG);
    // Y NO en el auditor: la 0191 no le concede `parametrizacion.servicios_adicionales.listar`; la
    // pantalla le daría 403.
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
    expect(sembradas.get(CODIGO)!.descripcion).toBe('Entrar a la pantalla «Finanzas — Servicios adicionales».');
  });

  it('el reparto es admin y financiera, igual en el SQL que en el catálogo del código (mutantes M1 y M2)', () => {
    const reparto = leerRepartoSembrado([ARCHIVO]);
    expect([...reparto.keys()].sort()).toEqual(['admin', 'financiera']);
    expect([...reparto.get('admin')!]).toEqual([CODIGO]);
    expect([...reparto.get('financiera')!]).toEqual([CODIGO]);
    const f = catalogoCompleto().find((c) => c.codigo === CODIGO)!;
    expect(f.roles).toEqual(['admin', 'financiera']);
  });

  it('no retira nada, y el helper de paridad la lee (está en MIGRACIONES_CON_REPARTO, después de la 0191)', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0191_servicios_adicionales_tipos.sql') + 1);
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
