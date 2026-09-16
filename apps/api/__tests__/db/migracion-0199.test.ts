// HU #12619 (Feature #12617, Épica #12244) — Migración 0199: la tabla `flito_tramite_viajes_logistica`
// (7 CHECKs + UNIQUE, iguales en Drizzle y en SQL) y las TRES operaciones `logistica.viajes.*`,
// repartidas SOLO a admin (decisión del líder: el administrador reparte desde el panel). Calco de
// migracion-0198.test.ts y de la 0193 (tabla + siembra en un archivo).
//
// Se afirma «la anterior es 0198_» y NUNCA «la 0199 es la última»: congelar el tip pone rojo el CI del
// PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). Mutantes nombrados (AC1, AC11):
//   · Quitar una `op(...)` del catálogo → «paridad SQL ≠ catálogo» cae (y el arranque también).
//   · Cambiar un texto de nombre/descripción → «byte a byte del catálogo».
//   · Añadir `('financiera', 'logistica.viajes.ver')` al reparto → «reparte SOLO a admin» cae, y también
//     «n_reparto <> 3» del resumen (el DO cuenta por rol_codigo = 'admin').
//   · Quitar un CHECK del SQL o del Drizzle → «7 CHECKs iguales» cae por el lado que falte.
//   · Añadir un índice extra por tramite_id → «sin índice aparte» cae (el UNIQUE lo lleva primero).
process.env.TZ = 'UTC';

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRepartoSembrado, leerRetirosSembrados, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import { flitoTramiteViajesLogistica } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0199_tramite_viajes_logistica.sql';
const ANTERIOR = '0198_flito_comprobantes.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0199 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0199.replace(/--[^\n]*/g, '');

const TABLA = 'flito_tramite_viajes_logistica';
const FICHERO = 'flito-logistica/flito-logistica-viajes.routes.ts';
const OPS = ['logistica.viajes.ver', 'logistica.viajes.registrar', 'logistica.viajes.quitar'] as const;
const RUTAS: Record<(typeof OPS)[number], string> = {
  'logistica.viajes.ver': `${FICHERO} GET /tramites/:tramiteId/viajes`,
  'logistica.viajes.registrar': `${FICHERO} POST /tramites/:tramiteId/viajes`,
  'logistica.viajes.quitar': `${FICHERO} DELETE /tramites/:tramiteId/viajes/:viajeId`,
};
const CHECKS = [
  'flito_tramite_viajes_log_numero_chk', 'flito_tramite_viajes_log_valor_chk', 'flito_tramite_viajes_log_modo_chk',
  'flito_tramite_viajes_log_motivo_chk', 'flito_tramite_viajes_log_motivo_detalle_chk',
  'flito_tramite_viajes_log_tarifa_inicial_chk', 'flito_tramite_viajes_log_valor_inicial_chk',
];
const UNIQUE = 'flito_tramite_viajes_log_tramite_numero_uq';

describe('0199 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único; la anterior es la 0198', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0199)).toEqual([]);
    expect(SQL_0199).toMatch(/DO \$resumen0199\$/);
    expect(SQL_0199).toMatch(/END \$resumen0199\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0199.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0199_'))).toEqual([ARCHIVO]);
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe(ANTERIOR);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Épica/Feature/HU) y autor', () => {
    const cabecera = SQL_0199.split('\n').slice(0, 14).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Epica #12244/);
    expect(cabecera).toMatch(/Feature #12617/);
    expect(cabecera).toMatch(/HU #12619/);
  });

  it('la tabla: IF NOT EXISTS, las columnas del diseño, FK tramite CASCADE y users RESTRICT, COMMENTs', () => {
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${TABLA} \\(`));
    expect(SIN_COMENTARIOS).toMatch(/tramite_id uuid NOT NULL REFERENCES flito_tramites\(id\) ON DELETE CASCADE/);
    expect(SIN_COMENTARIOS).toMatch(/numero integer NOT NULL/);
    expect(SIN_COMENTARIOS).toMatch(/modo varchar\(10\) NOT NULL/);
    expect(SIN_COMENTARIOS).toMatch(/valor numeric\(14,2\) NOT NULL/);
    expect(SIN_COMENTARIOS).toMatch(/tarifa_vigente numeric\(14,2\),/);
    expect(SIN_COMENTARIOS).toMatch(/motivo varchar\(30\) NOT NULL/);
    expect(SIN_COMENTARIOS).toMatch(/motivo_detalle text,/);
    expect(SIN_COMENTARIOS).toMatch(/registrado_por_id integer REFERENCES users\(id\) ON DELETE RESTRICT/);
    expect(SIN_COMENTARIOS).toMatch(/registrado_en timestamptz NOT NULL DEFAULT now\(\)/);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`COMMENT ON TABLE ${TABLA} IS '`));
    for (const col of ['numero', 'modo', 'valor', 'tarifa_vigente', 'motivo', 'registrado_por_id']) {
      expect(SIN_COMENTARIOS).toMatch(new RegExp(`COMMENT ON COLUMN ${TABLA}\\.${col} IS '`));
    }
  });

  it('7 CHECKs + el UNIQUE (tramite_id, numero), con los mismos nombres en el SQL y en db/schema/flito-logistica-viajes.ts; sin índice aparte', () => {
    for (const chk of CHECKS) expect(SIN_COMENTARIOS).toMatch(new RegExp(`CONSTRAINT ${chk} CHECK \\(`));
    expect(SIN_COMENTARIOS.match(/CONSTRAINT flito_tramite_viajes_log_\w+_chk CHECK/g)).toHaveLength(7);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(numero >= 2\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(valor >= 0\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(modo IN \('inicial', 'manual'\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(motivo IN \('devolucion', 'segunda_entrega', 'documento_faltante', 'otro'\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(motivo <> 'otro' OR \(motivo_detalle IS NOT NULL AND btrim\(motivo_detalle\) <> ''\)\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(modo = 'manual' OR tarifa_vigente IS NOT NULL\)/);
    expect(SIN_COMENTARIOS).toMatch(/CHECK \(modo <> 'inicial' OR valor = tarifa_vigente\)/);
    expect(SIN_COMENTARIOS).toMatch(new RegExp(`CONSTRAINT ${UNIQUE} UNIQUE \\(tramite_id, numero\\)`));
    // El UNIQUE lleva tramite_id primero: ES el índice de lectura por trámite. Ninguno aparte.
    expect(SIN_COMENTARIOS).not.toMatch(/CREATE (UNIQUE )?INDEX/);

    const cfg = getTableConfig(flitoTramiteViajesLogistica);
    expect(cfg.name).toBe(TABLA);
    expect(cfg.checks.map((c) => c.name).sort()).toEqual([...CHECKS].sort());
    expect(cfg.indexes).toHaveLength(0);
    expect(cfg.uniqueConstraints.map((u) => u.name)).toEqual([UNIQUE]);
    expect(cfg.uniqueConstraints[0]!.columns.map((c) => c.name)).toEqual(['tramite_id', 'numero']);
    const fks = cfg.foreignKeys.map((fk) => ({ col: fk.reference().columns[0]!.name, onDelete: fk.onDelete }));
    expect(fks.find((f) => f.col === 'tramite_id')!.onDelete).toBe('cascade');
    expect(fks.find((f) => f.col === 'registrado_por_id')!.onDelete).toBe('restrict');
  });

  it('siembra las TRES operaciones (modulo logistica, tipo operacion) con los textos byte a byte del catálogo; sin página', () => {
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).not.toMatch(/'pagina'/);
    const funciones = funcionesDeSql([SQL_0199]);
    expect([...funciones.keys()].sort()).toEqual([...OPS].sort());
    const catalogo = catalogoCompleto();
    for (const codigo of OPS) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo);
      expect(op, codigo).toBeDefined();
      expect(op!.llave).toBe(RUTAS[codigo]);
      expect(funciones.get(codigo)).toEqual({ codigo, modulo: 'logistica', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion' });
      const f = catalogo.find((c) => c.codigo === codigo);
      expect(f, codigo).toBeDefined();
      expect(f!.tipo).toBe('operacion');
      expect(f!.modulo).toBe('logistica');
    }
  });

  it('reparte SOLO a admin (3 filas), igual en el SQL que en el catálogo; ningún otro rol (AC11)', () => {
    const reparto = repartoDeSql([SQL_0199]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!].sort()).toEqual([...OPS].sort());
    // Leído del SQL con regex: cada tupla del reparto empieza por ('admin', …).
    const tuplas = SIN_COMENTARIOS.match(/\('\w+', 'logistica\.viajes\.\w+'\)/g) ?? [];
    expect(tuplas).toHaveLength(3);
    for (const t of tuplas) expect(t).toMatch(/^\('admin', /);
    const catalogo = catalogoCompleto();
    for (const codigo of OPS) {
      expect(catalogo.find((c) => c.codigo === codigo)!.roles, codigo).toEqual(['admin']);
      expect(repartoDePartida().filter(([, c]) => c === codigo).map(([r]) => r)).toEqual(['admin']);
    }
  });

  it('los cardinales del catálogo: 3 operaciones logistica.viajes.*, y las 3 llaves del fichero de rutas', () => {
    expect(catalogoCompleto().filter((c) => c.tipo === 'operacion' && c.codigo.startsWith('logistica.viajes.'))).toHaveLength(3);
    expect(OPERACIONES_DECLARADAS.filter((o) => o.llave.startsWith(`${FICHERO} `))).toHaveLength(3);
  });

  it('no retira nada y el helper de paridad la lee justo después de la 0198; plegado, admin sí y nadie más', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf(ANTERIOR) + 1);
    const total = leerRepartoSembrado();
    for (const codigo of OPS) {
      for (const [rol, funciones] of total) expect(funciones.has(codigo), `${rol} ${codigo}`).toBe(rol === 'admin');
    }
  });

  it('el resumen final revienta si no cuadra tabla + 3 funciones + 3 de reparto a admin, y el NOTICE dice que el reparto es solo a admin', () => {
    expect(SIN_COMENTARIOS).toMatch(/WHERE codigo LIKE 'logistica\.viajes\.%' AND tipo = 'operacion'/);
    expect(SIN_COMENTARIOS).toMatch(/WHERE funcion_codigo LIKE 'logistica\.viajes\.%' AND rol_codigo = 'admin'/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_tabla <> 1 OR n_funcion <> 3 OR n_reparto <> 3 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).toMatch(/RAISE NOTICE '0199: [^']*reparto solo a admin; el administrador reparte desde el panel'/);
  });
});
