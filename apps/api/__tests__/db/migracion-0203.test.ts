// Bug #12642 (Feature #11908) — Migración 0203: las DOS funciones que abren el archivo AMPLIADO de las
// colas de SOAT e Impuestos (`incluirPago: true`: valor pagado, fechas de solicitud/pago y
// trazabilidad), sembradas SOLO a admin. Calco de migracion-0201.test.ts: la 0203 NO crea ni altera.
//
// Se afirma «la anterior es 0202_» y NUNCA «la 0203 es la última»: congelar el tip pone rojo el CI del
// PR siguiente (memoria: test-de-migracion-no-exigir-es-la-ultima).
//
// Mutantes nombrados:
//   · Quitar una `op(...)` del catálogo → «paridad SQL ≠ catálogo» cae (y el arranque también:
//     `verificarCatalogoAlArrancar` compara base y código).
//   · Cambiar un texto de nombre/descripción → «byte a byte del catálogo».
//   · Añadir `('proveedor', 'soat.excel.exportar_pago')` al reparto → «solo admin (2 filas)» cae y la
//     paridad de la 0179 (permisos-seed-sql) también.
//   · Añadir `ALTER TABLE flito_soat` → «no crea ni altera» cae.
//   · Contar `n_ops` por `modulo = 'soat'` → «por código exacto» cae.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import {
  MIGRACIONES_CON_REPARTO, funcionesDeSql, leerRepartoSembrado, leerRetirosSembrados, repartoDeSql,
} from '../helpers/permisos-seed-sql.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0203_permiso_excel_exportar_pago.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0203 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0203.replace(/--[^\n]*/g, '');

const OPS = ['soat.excel.exportar_pago', 'impuestos.excel.exportar_pago'] as const;
const MODULO: Record<(typeof OPS)[number], string> = {
  'soat.excel.exportar_pago': 'soat',
  'impuestos.excel.exportar_pago': 'impuestos',
};
// La llave lleva la condición entre corchetes: es una guarda EN LÍNEA (`tieneFuncion` dentro del
// handler de `POST /export`), como `[_forzarContinuar]`. Sin corchetes colisionaría con la llave de
// `soat.excel.exportar`, que es la ruta que la contiene.
const LLAVES: Record<(typeof OPS)[number], string> = {
  'soat.excel.exportar_pago': 'flito-soat/flito-soat.routes.ts POST /export [incluirPago]',
  'impuestos.excel.exportar_pago': 'flito-impuestos/flito-impuestos.routes.ts POST /export [incluirPago]',
};
const NOMBRES: Record<(typeof OPS)[number], string> = {
  'soat.excel.exportar_pago': 'Exportar la cola de SOAT a Excel con datos de pago y trazabilidad',
  'impuestos.excel.exportar_pago': 'Exportar la cola de impuestos a Excel con datos de pago y trazabilidad',
};

describe('0203 — análisis estático', () => {
  it('sin BEGIN/COMMIT del archivo; DO etiquetado; sin `$` en comentarios; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0203)).toEqual([]);
    expect(SQL_0203).toMatch(/DO \$resumen0203\$/);
    expect(SQL_0203).toMatch(/END \$resumen0203\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQL_0203.match(/--[^\n]*\$/g)).toBeNull();
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(sqls.filter((f) => f.startsWith('0203_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0202_ (HU #12654) — nunca «es la última»', () => {
    const sqls = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    // No exige «es la última»: la convención pide max+1 EN SU MOMENTO.
    // En release (promoción selectiva del Feature 12072) no existen 0191-0202: la anterior es la 0190,
    // o la 0200 desde la promoción selectiva de la Épica #12248 (gastos diarios).
    expect(sqls[sqls.indexOf(ARCHIVO) - 1]).toMatch(/^(0202|0200|0190)_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (Bug/Feature) y autor', () => {
    const cabecera = SQL_0203.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Bug #12642/);
    expect(cabecera).toMatch(/Feature #11908/);
  });

  it('NO crea ni altera nada (ni flito_soat ni flito_impuestos): solo dos INSERT (siembra) y el DO', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/\b(CREATE|ALTER|DROP)\b/i);
    expect(SIN_COMENTARIOS).not.toMatch(/flito_soat|flito_impuestos/);
    expect(SIN_COMENTARIOS.match(/INSERT INTO permisos_/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING/);
  });

  it('siembra las DOS operaciones (una por módulo, tipo operacion) con los textos byte a byte del catálogo', () => {
    const funciones = funcionesDeSql([SQL_0203]);
    expect([...funciones.keys()].sort()).toEqual([...OPS].sort());
    const catalogo = catalogoCompleto();
    for (const codigo of OPS) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo);
      expect(op, codigo).toBeDefined();
      expect(op!.llave).toBe(LLAVES[codigo]);
      expect(op!.nombre).toBe(NOMBRES[codigo]);
      expect(funciones.get(codigo)).toEqual({ codigo, modulo: MODULO[codigo], nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion' });
      const f = catalogo.find((c) => c.codigo === codigo);
      expect(f, codigo).toBeDefined();
      expect(f!.tipo).toBe('operacion');
      expect(f!.modulo).toBe(MODULO[codigo]);
    }
  });

  it('la foto (GUARDAS_MEDIDAS) las lleva como guardas en línea con condicion `incluirPago`, junto a la ruta que las contiene', () => {
    for (const codigo of OPS) {
      const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === LLAVES[codigo]);
      expect(g, codigo).toBeDefined();
      expect(g!.condicion).toBe('incluirPago');
      expect(g!.roles).toEqual(['admin']);
      expect(g!.heredada).toBe(false);
      // La ruta que la contiene sigue con su propia guarda y su propio reparto (no se toca).
      const contenedora = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === LLAVES[codigo].replace(' [incluirPago]', ''));
      expect(contenedora, codigo).toBeDefined();
      expect(contenedora!.roles).toContain('admin');
      expect(contenedora!.roles.length).toBeGreaterThan(1);
    }
  });

  it('reparte SOLO a admin (2 filas), igual en el SQL que en el catálogo; ni proveedor, ni gestor_impuestos, ni auditor', () => {
    const reparto = repartoDeSql([SQL_0203]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!].sort()).toEqual([...OPS].sort());
    expect([...reparto.values()].reduce((n, s) => n + s.size, 0)).toBe(2);
    const catalogo = catalogoCompleto();
    for (const codigo of OPS) {
      expect(catalogo.find((c) => c.codigo === codigo)!.roles, codigo).toEqual(['admin']);
      expect(repartoDePartida().filter(([, c]) => c === codigo).map(([r]) => r)).toEqual(['admin']);
    }
  });

  it('no retira nada y el helper de paridad la lee detrás de la 0202; plegado, admin sí y los gestores de partida no', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    // Posición RELATIVA (detrás de la 0202), no «es la última» de la lista.
    // En release (promoción selectiva del Feature 12072) la 0202 no existe: va detrás de la 0190, o de
    // la 0200 desde la promoción selectiva de la Épica #12248.
    expect(MIGRACIONES_CON_REPARTO[MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO) - 1]).toMatch(/^(0202|0200|0190)_/);
    const total = leerRepartoSembrado();
    for (const codigo of OPS) {
      expect(total.get('admin')!.has(codigo)).toBe(true);
      expect(total.get('proveedor')?.has(codigo) ?? false).toBe(false);
      expect(total.get('gestor_impuestos')?.has(codigo) ?? false).toBe(false);
      expect(total.get('auditor')?.has(codigo) ?? false).toBe(false);
    }
  });

  it('el resumen final revienta si no cuadra 2 ops + 2 de reparto, contando por código exacto (no por módulo ni prefijo)', () => {
    expect(SIN_COMENTARIOS).toMatch(/IF n_ops <> 2 OR n_reparto <> 2 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).not.toMatch(/n_ops FROM permisos_funciones WHERE modulo = /);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE '(soat|impuestos)\.%'/);
    expect(SIN_COMENTARIOS).toMatch(/INTO n_ops FROM permisos_funciones WHERE tipo = 'operacion' AND codigo IN\s*\('soat\.excel\.exportar_pago', 'impuestos\.excel\.exportar_pago'\)/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0203 — aplicar ×2 sobre BD ya migrada (P6)', () => {
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

  it('segunda pasada no rompe ni duplica: 2 funciones, 2 de reparto (solo admin)', async () => {
    await enTx(async (tx) => {
      await tx.unsafe(SQL_0203);
      await tx.unsafe(SQL_0203);
      const [funciones] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo IN ${tx([...OPS])}`;
      expect(funciones!.n).toBe(2);
      const reparto = await tx<{ rol_codigo: string; n: number }[]>`
        SELECT rol_codigo, count(*)::int AS n FROM permisos_rol_funcion WHERE funcion_codigo IN ${tx([...OPS])} GROUP BY rol_codigo ORDER BY rol_codigo`;
      expect(reparto).toEqual([{ rol_codigo: 'admin', n: 2 }]);
    });
  }, 60_000);
});
