// HU #12611 (Feature #12605, Épica #12245) — Migración 0198: la tabla `flito_comprobantes` (5 índices,
// 9 CHECKs, iguales en Drizzle y en SQL), la página `pagina.flito_comprobantes` (finanzas) y las CINCO
// operaciones del módulo `comprobantes`, repartidas a admin + financiera. Calco de migracion-0197.test.ts
// y de la 0193 (tabla + siembra en un archivo).
//
// Se afirma «la anterior es 0197_» y NUNCA «la 0198 es la última»: congelar el tip pone rojo el CI del
// PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima). Mutantes nombrados:
//   · Quitar una `op(...)` del catálogo → «paridad SQL ≠ catálogo» cae (y el arranque también:
//     `verificarCatalogoAlArrancar` compara base y código).
//   · Cambiar un texto de nombre/descripción → «byte a byte del catálogo».
//   · Añadir `('auditor', 'comprobantes.cola.ver')` al reparto → «reparte a admin y financiera» cae.
//   · Quitar un CHECK del SQL o del Drizzle → «9 CHECKs iguales» cae por el lado que falte.
//   · Añadir `ALTER TABLE flito_soportes` → «flito_soportes no se toca» cae.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRepartoSembrado, leerRetirosSembrados, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import { flitoComprobantes } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0198_flito_comprobantes.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0198 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0198.replace(/--[^\n]*/g, '');

const PAGINA = 'pagina.flito_comprobantes';
const OPS = [
  'comprobantes.lote.cargar', 'comprobantes.cola.ver', 'comprobantes.comprobante.ver',
  'comprobantes.archivo.descargar', 'comprobantes.comprobante.releer',
] as const;
const RUTAS: Record<(typeof OPS)[number], string> = {
  'comprobantes.lote.cargar': 'flito-comprobantes/flito-comprobantes.routes.ts POST /',
  'comprobantes.cola.ver': 'flito-comprobantes/flito-comprobantes.routes.ts GET /',
  'comprobantes.comprobante.ver': 'flito-comprobantes/flito-comprobantes.routes.ts GET /:id',
  'comprobantes.archivo.descargar': 'flito-comprobantes/flito-comprobantes.routes.ts GET /:id/archivo',
  'comprobantes.comprobante.releer': 'flito-comprobantes/flito-comprobantes.routes.ts POST /:id/releer',
};
const INDICES = [
  'idx_flito_comprobantes_lote', 'idx_flito_comprobantes_pendientes', 'idx_flito_comprobantes_tramite',
  'idx_flito_comprobantes_soporte', 'idx_flito_comprobantes_valor_documental',
];
const CHECKS = [
  'flito_comprobantes_estado_chk', 'flito_comprobantes_concepto_chk', 'flito_comprobantes_cruce_chk',
  'flito_comprobantes_aplicado_chk', 'flito_comprobantes_valor_pago_chk', 'flito_comprobantes_descartado_chk',
  'flito_comprobantes_pendiente_chk', 'flito_comprobantes_diferencia_chk', 'flito_comprobantes_paginas_chk',
];

describe('0198 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único; la anterior es la 0197', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0198)).toEqual([]);
    expect(SQL_0198).toMatch(/DO \$resumen0198\$/);
    expect(SQL_0198).toMatch(/END \$resumen0198\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0198.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0198_'))).toEqual([ARCHIVO]);
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toBe('0197_permiso_recibo_caja.sql');
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Épica/HU) y autor', () => {
    const cabecera = SQL_0198.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Epica #12245/);
    expect(cabecera).toMatch(/HU #12611/);
  });

  it('la tabla: IF NOT EXISTS, las FK del diseño (soporte CASCADE, aplicado SET NULL, tramite CASCADE, cuatro parejas a users RESTRICT)', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_comprobantes \(/);
    expect(SIN_COMENTARIOS).toMatch(/soporte_id\s+UUID NOT NULL REFERENCES flito_soportes\(id\) ON DELETE CASCADE/);
    expect(SIN_COMENTARIOS).toMatch(/soporte_aplicado_id\s+UUID REFERENCES flito_soportes\(id\) ON DELETE SET NULL/);
    expect(SIN_COMENTARIOS).toMatch(/tramite_id\s+UUID REFERENCES flito_tramites\(id\) ON DELETE CASCADE/);
    const aUsers = SIN_COMENTARIOS.match(/REFERENCES users\(id\) ON DELETE RESTRICT/g) ?? [];
    expect(aUsers).toHaveLength(4); // diferencia_aceptada_por, aplicado_por, descartado_por, subido_por
    for (const col of ['diferencia_aceptada_por_id', 'aplicado_por_id', 'descartado_por_id', 'subido_por_id']) {
      expect(SIN_COMENTARIOS).toMatch(new RegExp(`${col}\\s+INTEGER (NOT NULL )?REFERENCES users\\(id\\) ON DELETE RESTRICT`));
    }
    expect(SIN_COMENTARIOS).toMatch(/extraccion\s+JSONB NOT NULL/);
  });

  it('5 índices y 9 CHECKs, con los mismos nombres en el SQL y en db/schema/flito-comprobantes.ts (lección 0157)', () => {
    for (const idx of INDICES) expect(SIN_COMENTARIOS).toMatch(new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS ${idx}\\s+ON flito_comprobantes`));
    expect(SIN_COMENTARIOS.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS idx_flito_comprobantes_/g)).toHaveLength(5);
    // El único parcial de valor documental: UNIQUE y con el predicado de los tres honorarios.
    expect(SIN_COMENTARIOS).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_flito_comprobantes_valor_documental\s+ON flito_comprobantes \(tramite_id, concepto\)\s+WHERE estado = 'aplicado' AND es_pago = true\s+AND concepto IN \('tramite_digital', 'logistica', 'servicios_adicionales'\)/);
    for (const chk of CHECKS) expect(SIN_COMENTARIOS).toMatch(new RegExp(`CONSTRAINT ${chk} CHECK \\(`));
    expect(SIN_COMENTARIOS.match(/CONSTRAINT flito_comprobantes_\w+_chk CHECK/g)).toHaveLength(9);

    const cfg = getTableConfig(flitoComprobantes);
    expect(cfg.name).toBe('flito_comprobantes');
    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([...INDICES].sort());
    expect(cfg.indexes.find((i) => i.config.name === 'idx_flito_comprobantes_valor_documental')!.config.unique).toBe(true);
    expect(cfg.checks.map((c) => c.name).sort()).toEqual([...CHECKS].sort());
    const fks = cfg.foreignKeys.map((fk) => {
      const r = fk.reference();
      return { col: r.columns[0]!.name, tabla: r.foreignTable[Symbol.for('drizzle:Name') as unknown as keyof typeof r.foreignTable] as unknown as string, onDelete: fk.onDelete };
    });
    expect(fks.find((f) => f.col === 'soporte_id')!.onDelete).toBe('cascade');
    expect(fks.find((f) => f.col === 'soporte_aplicado_id')!.onDelete).toBe('set null');
    expect(fks.find((f) => f.col === 'tramite_id')!.onDelete).toBe('cascade');
    for (const col of ['diferencia_aceptada_por_id', 'aplicado_por_id', 'descartado_por_id', 'subido_por_id']) {
      expect(fks.find((f) => f.col === col)!.onDelete).toBe('restrict');
    }
  });

  it('flito_soportes no se toca: ni ALTER, ni FK nueva, ni CHECK (grep vacío)', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/ALTER TABLE\s+flito_soportes/);
    // Solo las dos REFERENCES de la tabla nueva y la mención en el COMMENT: ningún DDL sobre ella.
    expect(SIN_COMENTARIOS.match(/REFERENCES flito_soportes\(id\)/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS.replace(/'[^']*'/g, '').match(/flito_soportes/g)).toHaveLength(2);
  });

  it('siembra la página (finanzas, tipo pagina) y las CINCO operaciones (comprobantes) con los textos byte a byte del catálogo', () => {
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(4);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    const funciones = funcionesDeSql([SQL_0198]);
    expect([...funciones.keys()].sort()).toEqual([PAGINA, ...OPS].sort());
    expect(funciones.get(PAGINA)).toEqual({
      codigo: PAGINA, modulo: 'finanzas', nombre: 'Finanzas — Comprobantes', descripcion: 'Entrar a la pantalla «Finanzas — Comprobantes».', tipo: 'pagina',
    });
    const catalogo = catalogoCompleto();
    const pagina = catalogo.find((c) => c.codigo === PAGINA);
    expect(pagina).toBeDefined();
    expect(pagina!.tipo).toBe('pagina');
    expect(pagina!.modulo).toBe('finanzas');
    expect(pagina!.nombreNegocio).toBe('Finanzas — Comprobantes');
    for (const codigo of OPS) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo);
      expect(op, codigo).toBeDefined();
      expect(op!.llave).toBe(RUTAS[codigo]);
      expect(funciones.get(codigo)).toEqual({ codigo, modulo: 'comprobantes', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion' });
      const f = catalogo.find((c) => c.codigo === codigo);
      expect(f, codigo).toBeDefined();
      expect(f!.tipo).toBe('operacion');
      expect(f!.modulo).toBe('comprobantes');
    }
  });

  it('reparte a admin y financiera (12 filas), igual en el SQL que en el catálogo; auditor NO', () => {
    const reparto = repartoDeSql([SQL_0198]);
    expect([...reparto.keys()].sort()).toEqual(['admin', 'financiera']);
    for (const rol of ['admin', 'financiera']) expect([...reparto.get(rol)!].sort()).toEqual([PAGINA, ...OPS].sort());
    expect(reparto.get('auditor')).toBeUndefined();
    const catalogo = catalogoCompleto();
    for (const codigo of [PAGINA, ...OPS]) {
      expect(catalogo.find((c) => c.codigo === codigo)!.roles, codigo).toEqual(['admin', 'financiera']);
      expect(repartoDePartida().filter(([, c]) => c === codigo).map(([r]) => r).sort()).toEqual(['admin', 'financiera']);
    }
  });

  it('los cardinales del catálogo: 9 operaciones de comprobantes (5 de la 0198 + 3 de la 0201 + 1 de la 0202, HU #12654), y las 9 llaves del fichero de rutas', () => {
    // 5 → 8 desde la HU #12629 (F2 #12606: buscar trámites, aplicar, descartar); 8 → 9 desde la HU #12654 (F3: aceptar diferencia). Las cinco de ESTA migración siguen siendo las de `OPS`.
    expect(catalogoCompleto().filter((c) => c.tipo === 'operacion' && c.modulo === 'comprobantes')).toHaveLength(9);
    expect(OPERACIONES_DECLARADAS.filter((o) => o.llave.startsWith('flito-comprobantes/flito-comprobantes.routes.ts '))).toHaveLength(9);
    for (const codigo of OPS) expect(OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo), codigo).toBeDefined();
  });

  it('no retira nada y el helper de paridad la lee justo después de la 0197; plegado, admin y financiera sí y auditor no', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO)).toBe(MIGRACIONES_CON_REPARTO.indexOf('0197_permiso_recibo_caja.sql') + 1);
    const total = leerRepartoSembrado();
    for (const codigo of [PAGINA, ...OPS]) {
      expect(total.get('admin')!.has(codigo)).toBe(true);
      expect(total.get('financiera')!.has(codigo)).toBe(true);
      expect(total.get('auditor')?.has(codigo) ?? false).toBe(false);
    }
  });

  it('el resumen final revienta si no cuadra tabla + 5 índices + 9 CHECKs + página + 5 ops + 12 de reparto, contando por código exacto', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_tabla <> 1 OR n_idx <> 5 OR n_chk <> 9 OR n_pagina <> 1 OR n_ops <> 5 OR n_reparto <> 12 THEN\s*RAISE EXCEPTION/);
    // Por código exacto, no por `modulo = 'comprobantes'`: la 0199 sembrará más `comprobantes.*` y una
    // re-pasada de la 0198 contaría 8 y lanzaría (AC1: la segunda pasada nunca falla).
    expect(SIN_COMENTARIOS).not.toMatch(/n_ops FROM permisos_funciones WHERE modulo = 'comprobantes'/);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE 'comprobantes\.%'/);
    expect(SIN_COMENTARIOS).toMatch(/INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN\s*\('comprobantes\.lote\.cargar', 'comprobantes\.cola\.ver', 'comprobantes\.comprobante\.ver', 'comprobantes\.archivo\.descargar', 'comprobantes\.comprobante\.releer'\)/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0198 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  it('segunda pasada no rompe ni duplica: tabla, 5 índices, 9 CHECKs, 6 funciones, 12 de reparto', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0198);
      await tx.unsafe(SQL_0198);
      const [idx] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'flito_comprobantes' AND indexname LIKE 'idx_flito_comprobantes_%'`;
      expect(idx!.n).toBe(5);
      const [chk] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'flito_comprobantes'::regclass AND contype = 'c'`;
      expect(chk!.n).toBe(9);
      const [funciones] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo IN ${tx([PAGINA, ...OPS])}`;
      expect(funciones!.n).toBe(6);
      const reparto = await tx<{ rol_codigo: string; n: number }[]>`
        SELECT rol_codigo, count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo IN ${tx([PAGINA, ...OPS])} GROUP BY rol_codigo ORDER BY rol_codigo`;
      expect(reparto).toEqual([{ rol_codigo: 'admin', n: 6 }, { rol_codigo: 'financiera', n: 6 }]);
    });
  }, 60_000);
});
