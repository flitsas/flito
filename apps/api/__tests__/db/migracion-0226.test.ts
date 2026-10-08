// HU #13421 (Feature #13413, ADR-0023) — La 0226: PESV, Jornadas, Conductores y RUM piden permiso,
// no rol. Siembra las 21 páginas por ítem del menú PESV con reparto COPIADO de `pagina.pesv` (roles y
// excepciones por usuario), renombra `pagina.pesv` a «Tablero PESV», y siembra los 24 transitorios
// «Administrar <ítem>» más la operación permanente `rum.resumen.ver` con la lista literal de su
// `requireRole`. `admin` recibe todo lo nuevo en el mismo archivo (AC7, ADR-0022).
//
// NÚMERO PROVISIONAL: en el rebase previo al PR se renombra el archivo, este test, la entrada de
// MIGRACIONES_CON_REPARTO y el aserto de «la anterior» (ADR-0023 §D5).
//
// Solo la mitad ESTÁTICA (el CI no levanta Postgres). La idempotencia y el control de paridad del
// bloque DO se acreditan a mano sobre la base local (dos pasadas). Mutantes nombrados:
//   · M1 — quitar una página del VALUES de la copia de roles: cae «la copia lleva las 21 páginas».
//   · M2 — quitar `('admin', 'pesv.comite.administrar')`: cae «admin recibe todo lo nuevo» (AC7).
//   · M3 — añadir `('compliance', 'pesv.plan.administrar')`: cae «el reparto de cada operación es
//     el del catálogo» (sería una ganancia, AC5).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, PAGINAS_PESV_POR_ITEM } from '@operaciones/shared-types';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto } from '../../src/modules/permisos/catalogo.js';
import {
  MIGRACIONES_CON_REPARTO, copiasDeReparto, leerFuncionesSembradas, leerRenombresSembrados,
  leerRepartoSembrado, leerRetirosSembrados,
} from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0226_permisos_pesv_por_item.sql';
const ANTERIOR = '0223_flito_soportes_documentos_adicionales_carga_eliminar.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL.replace(/--[^\n]*/g, '');

const PAGINAS = PAGINAS_PESV_POR_ITEM.map((s) => `pagina.${s}`);
const CATALOGO = catalogoCompleto();
const OPERACIONES = CATALOGO.filter((f) => f.tipo === 'operacion' && /^(pesv|drivers|jornadas|rum)\./.test(f.codigo));

describe('0226 — reglas del archivo (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL)).toEqual([]);
    expect(SQL).toMatch(/DO \$resumen0226\$/);
    expect(SQL).toMatch(/END \$resumen0226\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL.match(/--[^\n]*\$/g)).toBeNull();
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #13413/);
    expect(cabecera).toMatch(/HU #13421/);
  });

  it('el número no colisiona y la anterior en este árbol es la 0223 (provisional: 0224/0225 son de otras HUs)', () => {
    const sqls = readdirSync(path.dirname(RUTA)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0226_'))).toEqual([ARCHIVO]);
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe(ANTERIOR);
  });

  it('idempotente: todo INSERT con ON CONFLICT DO NOTHING, sin DO UPDATE ni DELETE', () => {
    const inserts = SIN_COMENTARIOS.match(/INSERT INTO permisos_/g) ?? [];
    expect(inserts).toHaveLength(5);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \([a-z_, ]+\) DO NOTHING;/g)).toHaveLength(5);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE|DELETE FROM/);
    expect(SIN_COMENTARIOS).toMatch(/IS DISTINCT FROM/);
  });
});

describe('0226 — lo que siembra es lo que el catálogo del código declara', () => {
  // Lo que ESTE archivo añade al catálogo plegado (el UPDATE de `pagina.pesv` necesita la 0179 detrás).
  const previas = leerFuncionesSembradas(MIGRACIONES_CON_REPARTO.filter((m) => m !== ARCHIVO));
  const sembradas = new Map([...leerFuncionesSembradas()].filter(([c]) => !previas.has(c)));

  it('siembra exactamente las 21 páginas y las 25 operaciones, con los textos y el módulo del catálogo', () => {
    expect([...sembradas.keys()].sort()).toEqual([...PAGINAS, ...OPERACIONES.map((f) => f.codigo)].sort());
    expect(OPERACIONES).toHaveLength(25);
    for (const [codigo, f] of sembradas) {
      const c = CATALOGO.find((x) => x.codigo === codigo)!;
      expect(f, codigo).toEqual({ codigo, modulo: c.modulo, nombre: c.nombreNegocio, descripcion: c.descripcion, tipo: c.tipo });
    }
    for (const p of PAGINAS) expect(sembradas.get(p)!.modulo, p).toBe('pesv');
  });

  it('los nombres de las páginas son «PESV — <label del menú>» y los transitorios llevan el sufijo `.administrar`', () => {
    for (const s of PAGINAS_PESV_POR_ITEM) expect(PAGES[s], s).toMatch(/^PESV — /);
    expect(OPERACIONES.filter((f) => !f.codigo.endsWith('.administrar')).map((f) => f.codigo)).toEqual(['rum.resumen.ver']);
    for (const f of OPERACIONES.filter((x) => x.codigo.endsWith('.administrar'))) {
      expect(f.nombreNegocio, f.codigo).toMatch(/^Administrar /);
      expect(f.descripcion, f.codigo).toMatch(/^Transitorio \(retira la HU #13429\)/);
    }
  });

  it('`pagina.pesv` se renombra al ítem raíz «Tablero PESV» (no se retira)', () => {
    expect(leerRenombresSembrados([ARCHIVO])).toEqual(new Map([
      ['pagina.pesv', { nombre: 'PESV — Tablero PESV', descripcion: 'Entrar a la pantalla «PESV — Tablero PESV».' }],
    ]));
    expect(PAGES.pesv).toBe('PESV — Tablero PESV');
    expect(leerRetirosSembrados([ARCHIVO])).toEqual({ funciones: new Set(), reparto: new Set() });
  });
});

describe('0226 — reparto con paridad (AC5) y admin explícito (AC7)', () => {
  it('la copia de roles va de `pagina.pesv` a las 21 páginas (M1)', () => {
    expect(copiasDeReparto(SQL)).toEqual([{ origen: 'pagina.pesv', destinos: PAGINAS }]);
  });

  it('las excepciones por usuario se copian con su `efecto` (conceder y revocar) a las mismas 21 páginas', () => {
    const m = /INSERT INTO permisos_usuario_funcion \(user_id, funcion_codigo, efecto\)\s+SELECT o\.user_id, v\.fn, o\.efecto FROM permisos_usuario_funcion o CROSS JOIN \(VALUES([\s\S]*?)\) AS v\(fn\)\s+WHERE o\.funcion_codigo = 'pagina\.pesv'\s+ON CONFLICT \(user_id, funcion_codigo\) DO NOTHING;/.exec(SIN_COMENTARIOS);
    expect(m).not.toBeNull();
    expect([...m![1]!.matchAll(/'([a-z_.]+)'/g)].map((x) => x[1])).toEqual(PAGINAS);
  });

  it('admin recibe TODO lo nuevo en este mismo archivo (M2)', () => {
    const admin = leerRepartoSembrado([ARCHIVO]).get('admin')!;
    for (const c of [...PAGINAS, ...OPERACIONES.map((f) => f.codigo)]) expect(admin.has(c), c).toBe(true);
  });

  it('el reparto literal de cada operación es EXACTAMENTE el del catálogo, y ninguna página nueva va literal a otro rol que admin (M3)', () => {
    const literal = leerRepartoSembrado([ARCHIVO]);
    for (const f of OPERACIONES) {
      const roles = [...literal.entries()].filter(([, cs]) => cs.has(f.codigo)).map(([r]) => r).sort();
      expect(roles, f.codigo).toEqual([...f.roles].sort());
    }
    for (const [rol, cs] of literal) {
      if (rol === 'admin') continue;
      expect([...cs].filter((c) => c.startsWith('pagina.')), rol).toEqual([]);
    }
  });

  it('plegadas todas las migraciones, cada rol que tiene `pagina.pesv` tiene las 21 páginas, y nadie más las tiene', () => {
    expect(MIGRACIONES_CON_REPARTO).toContain(ARCHIVO);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf(ANTERIOR) + 1);
    const total = leerRepartoSembrado();
    for (const [rol, cs] of total) {
      for (const p of PAGINAS) expect(cs.has(p), `${rol} ${p}`).toBe(cs.has('pagina.pesv'));
    }
  });

  it('el bloque DO revienta si una página nueva queda con menos reparto que `pagina.pesv` o sin admin', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_cortas <> 0 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_sin_admin <> 0 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_paginas <> 21 OR n_ops <> 25 THEN\s*RAISE EXCEPTION/);
  });
});
