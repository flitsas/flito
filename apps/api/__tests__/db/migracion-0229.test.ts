// HU #13422 (Feature #13413, ADR-0023) — La 0229: Mantenimiento, Vehículos, Flota, RNDC, Rutas,
// Liquidación, Finanzas y Clientes piden permiso, no rol. Siembra las 3 páginas por ítem del menú
// Mantenimiento con reparto COPIADO de `pagina.maintenance` (roles y excepciones por usuario), y las 13
// operaciones (10 transitorios «Administrar <ítem>» + 3 permanentes) con la lista literal de su
// `requireRole`. `admin` recibe todo lo nuevo en el mismo archivo (AC7, ADR-0022).
//
// Solo la mitad ESTÁTICA (el CI no levanta Postgres). La idempotencia y el control de paridad del
// bloque DO se acreditan a mano sobre la base local (dos pasadas). Mutantes nombrados:
//   · M1 — quitar una página del VALUES de la copia de roles: cae «la copia lleva las 3 páginas».
//   · M2 — quitar `('admin', 'fleet.flota.administrar')`: cae «admin recibe todo lo nuevo» (AC7).
//   · M3 — añadir `('auditor', 'clients.clientes.administrar')`: cae «el reparto de cada operación es
//     el del catálogo» (sería una ganancia, AC5).
//   · M6 — volver a `INSERT INTO permisos_rol_funcion (…) VALUES (…)` con roles literales: cae el aserto
//     del JOIN con permisos_roles (lección del CD de DEV con la 0227).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, PAGINAS_MANTENIMIENTO_POR_ITEM } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, copiasDeReparto, leerFuncionesSembradas, leerRenombresSembrados,
  leerRepartoSembrado, leerRetirosSembrados,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0229_permisos_operacion_por_item.sql';
const ANTERIOR = '0228_permiso_logistica_operar_ajenas.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

const PAGINAS = PAGINAS_MANTENIMIENTO_POR_ITEM.map((s) => `pagina.${s}`);
const CATALOGO = catalogoCompleto();
const PERMANENTES = ['clients.clientes.ver', 'finanzas.reporte_costos.ver', 'vehicles.propietario.ver_documento'];
const OPERACIONES = CATALOGO.filter((f) => f.tipo === 'operacion'
  && /^(maintenance|vehicles|fleet|rndc|rutas|liquidacion\.pago_manual|finanzas\.reporte_costos|clients)\./.test(f.codigo));

describe('0229 — reglas del archivo (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    expect(SQL).toMatch(/DO \$resumen0229\$/);
    expect(SQL).toMatch(/END \$resumen0229\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL.match(/--[^\n]*\$/g)).toBeNull();
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #13413/);
    expect(cabecera).toMatch(/HU #13422/);
  });

  it('el número no colisiona y la anterior es la 0228 (sin hueco)', () => {
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0229_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe(ANTERIOR);
  });

  it('idempotente: todo INSERT con ON CONFLICT DO NOTHING; ni UPDATE, ni DELETE, ni tablas temporales', () => {
    const inserts = SIN_COMENTARIOS.match(/INSERT INTO permisos_/g) ?? [];
    expect(inserts).toHaveLength(5);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \([a-z_, ]+\) DO NOTHING;/g)).toHaveLength(5);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE|UPDATE permisos_|DELETE FROM|CREATE TEMP/);
  });

  it('M6: toda fila de rol LITERAL pasa por JOIN con permisos_roles (solo entra si el rol existe en el ambiente)', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/INSERT INTO permisos_rol_funcion\s*\([^)]*\)\s*VALUES/);
    const conJoin = [...SIN_COMENTARIOS.matchAll(/INSERT INTO permisos_rol_funcion \(rol_codigo, funcion_codigo\)\s+SELECT v\.rol, v\.fn FROM \(VALUES([\s\S]*?)\) AS v\(rol, fn\)\s+JOIN permisos_roles r ON r\.codigo = v\.rol\s+ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/g)];
    expect(conJoin).toHaveLength(1);
    const filas = [...conJoin[0]![1]!.matchAll(/\('([a-z_]+)', '[a-z0-9_.]+'\)/g)].map((m) => m[1]!);
    const porRol = filas.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
    expect(porRol).toEqual({ admin: 16, auditor: 2, financiera: 2 });
    // Ningún otro INSERT en permisos_rol_funcion nombra un rol entre comillas: los demás copian de filas existentes.
    const otros = [...SIN_COMENTARIOS.matchAll(/INSERT INTO permisos_rol_funcion[\s\S]*?;/g)].map((m) => m[0]).filter((b) => !/JOIN permisos_roles r/.test(b));
    expect(otros).toHaveLength(1);
    for (const b of otros) expect(b).not.toMatch(/'(admin|auditor|financiera|lider_pesv|supervisor_flota)'/);
  });

  it('las operaciones se cuentan con la lista CERRADA de las 13, no por prefijo', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE/);
    const listas = [...SIN_COMENTARIOS.matchAll(/codigo IN \(('[a-z_.]+'(?:,'[a-z_.]+')*)\)/g)]
      .map((m) => m[1]!.split(',').map((x) => x.slice(1, -1)))
      .filter((l) => l.some((c) => !c.startsWith('pagina.')));
    expect(listas).toHaveLength(2);
    for (const l of listas) expect([...l].sort()).toEqual(OPERACIONES.map((f) => f.codigo).sort());
  });
});

describe('0229 — lo que siembra es lo que el catálogo del código declara', () => {
  const previas = leerFuncionesSembradas(MIGRACIONES_CON_REPARTO.filter((m) => m !== ARCHIVO));
  const sembradas = new Map([...leerFuncionesSembradas()].filter(([c]) => !previas.has(c)));

  it('siembra exactamente las 3 páginas y las 13 operaciones, con los textos y el módulo del catálogo', () => {
    expect([...sembradas.keys()].sort()).toEqual([...PAGINAS, ...OPERACIONES.map((f) => f.codigo)].sort());
    expect(OPERACIONES).toHaveLength(13);
    for (const [codigo, f] of sembradas) {
      const c = CATALOGO.find((x) => x.codigo === codigo)!;
      expect(f, codigo).toEqual({ codigo, modulo: c.modulo, nombre: c.nombreNegocio, descripcion: c.descripcion, tipo: c.tipo });
    }
    for (const p of PAGINAS) expect(sembradas.get(p)!.modulo, p).toBe('mantenimiento');
  });

  it('los nombres de las páginas son «Mantenimiento — <label del menú>» y los transitorios llevan el sufijo `.administrar`', () => {
    expect(PAGINAS_MANTENIMIENTO_POR_ITEM.map((s) => PAGES[s])).toEqual([
      'Mantenimiento — Mantenimiento', 'Mantenimiento — Órdenes de trabajo', 'Mantenimiento — Indicadores mant.',
    ]);
    expect(OPERACIONES.filter((f) => !f.codigo.endsWith('.administrar')).map((f) => f.codigo).sort()).toEqual(PERMANENTES);
    for (const f of OPERACIONES.filter((x) => x.codigo.endsWith('.administrar'))) {
      expect(f.nombreNegocio, f.codigo).toMatch(/^Administrar /);
      expect(f.descripcion, f.codigo).toMatch(/^Transitorio \(retira la HU #13429\)/);
    }
  });

  it('no renombra ni retira nada: `pagina.maintenance` se conserva tal cual', () => {
    expect(leerRenombresSembrados([ARCHIVO])).toEqual(new Map());
    expect(leerRetirosSembrados([ARCHIVO])).toEqual({ funciones: new Set(), reparto: new Set() });
    expect(previas.has('pagina.maintenance')).toBe(true);
  });
});

describe('0229 — reparto con paridad (AC5) y admin explícito (AC7)', () => {
  it('la copia de roles va de `pagina.maintenance` a las 3 páginas (M1)', () => {
    expect(copiasDeReparto(SQL)).toEqual([{ origen: 'pagina.maintenance', destinos: PAGINAS }]);
  });

  it('las excepciones por usuario se copian con su `efecto` (conceder y revocar) a las mismas 3 páginas', () => {
    const m = /INSERT INTO permisos_usuario_funcion \(user_id, funcion_codigo, efecto\)\s+SELECT o\.user_id, v\.fn, o\.efecto FROM permisos_usuario_funcion o CROSS JOIN \(VALUES([\s\S]*?)\) AS v\(fn\)\s+WHERE o\.funcion_codigo = 'pagina\.maintenance'\s+ON CONFLICT \(user_id, funcion_codigo\) DO NOTHING;/.exec(SIN_COMENTARIOS);
    expect(m).not.toBeNull();
    expect([...m![1]!.matchAll(/'([a-z_.]+)'/g)].map((x) => x[1])).toEqual(PAGINAS);
  });

  it('admin recibe TODO lo nuevo en este mismo archivo (M2)', () => {
    const admin = leerRepartoSembrado([ARCHIVO]).get('admin')!;
    for (const c of [...PAGINAS, ...OPERACIONES.map((f) => f.codigo)]) expect(admin.has(c), c).toBe(true);
  });

  it('el reparto literal de cada operación es EXACTAMENTE el del catálogo (la lista de su requireRole), y ninguna página nueva va literal a otro rol que admin (M3)', () => {
    const literal = leerRepartoSembrado([ARCHIVO]);
    for (const f of OPERACIONES) {
      const roles = [...literal.entries()].filter(([, cs]) => cs.has(f.codigo)).map(([r]) => r).sort();
      expect(roles, f.codigo).toEqual([...f.roles].sort());
    }
    expect(OPERACIONES.find((f) => f.codigo === 'clients.clientes.ver')!.roles).toEqual(['admin', 'auditor', 'financiera']);
    expect(OPERACIONES.find((f) => f.codigo === 'finanzas.reporte_costos.ver')!.roles).toEqual(['admin', 'auditor', 'financiera']);
    for (const f of OPERACIONES.filter((x) => !['clients.clientes.ver', 'finanzas.reporte_costos.ver'].includes(x.codigo))) {
      expect(f.roles, f.codigo).toEqual(['admin']);
    }
    for (const [rol, cs] of literal) {
      if (rol === 'admin') continue;
      expect([...cs].filter((c) => c.startsWith('pagina.')), rol).toEqual([]);
    }
  });

  it('plegadas todas las migraciones, cada rol que tiene `pagina.maintenance` tiene las 3 páginas, y nadie más las tiene', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf(ANTERIOR) + 1);
    const total = leerRepartoSembrado();
    for (const [rol, cs] of total) {
      for (const p of PAGINAS) expect(cs.has(p), `${rol} ${p}`).toBe(cs.has('pagina.maintenance'));
    }
  });

  it('el bloque DO revienta si una página nueva queda con menos reparto que `pagina.maintenance` o sin admin', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_cortas <> 0 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_sin_admin <> 0 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_paginas <> 3 OR n_ops <> 13 THEN\s*RAISE EXCEPTION/);
  });
});
