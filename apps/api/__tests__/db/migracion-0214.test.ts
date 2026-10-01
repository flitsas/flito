// HU #13061 (Feature #13057, Épica #12736) — Migración 0214: tabla `flito_sync_flit2_acceso` y las
// funciones `tramites.flit2.ver_acceso` / `tramites.flit2.guardar_acceso`, sembradas SOLO a admin.
// Calco de migracion-0212.test.ts.
//
// Se afirma «la anterior es 0213_» y NUNCA «la 0214 es la última» (memoria:
// test-de-migracion-no-exigir-es-la-ultima). La 0213 es de la HU #13070 y en esta rama todavía no
// existe: mientras falte, el caso comprueba que la anterior sea la 0212 (el tip de develop al abrir
// la rama). Con la 0213 en disco —tras rebasear sobre develop— exige la 0213 sin tocar el test.

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
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import { flitoSyncFlit2Acceso } from '../../src/db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0214_flit2_acceso.sql';
const DIR = path.resolve(__dirname, '../../src/db/migrations');
const SQL_0214 = readFileSync(path.join(DIR, ARCHIVO), 'utf8');
const SIN_COMENTARIOS = SQL_0214.replace(/--[^\n]*/g, '');
const SQLS = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

const VER = 'tramites.flit2.ver_acceso';
const GUARDAR = 'tramites.flit2.guardar_acceso';
const LLAVES: Record<string, string> = {
  [VER]: 'flito-sync/flit2.routes.ts GET /acceso',
  [GUARDAR]: 'flito-sync/flit2.routes.ts PUT /acceso',
};

describe('0214 — análisis estático', () => {
  it('sin BEGIN/COMMIT; DO etiquetado; sin `$$` sin etiqueta; número único', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0214)).toEqual([]);
    expect(SQL_0214).toMatch(/DO \$resumen0214\$/);
    expect(SQL_0214).toMatch(/END \$resumen0214\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
    expect(SQLS.filter((f) => f.startsWith('0214_'))).toEqual([ARCHIVO]);
  });

  it('la anterior es la 0213_ (HU #13070) — o la 0212_ mientras la 0213 no esté en la rama; nunca «es la última»', () => {
    const anterior = SQLS[SQLS.indexOf(ARCHIVO) - 1];
    const hay0213 = SQLS.some((f) => f.startsWith('0213_'));
    expect(anterior).toMatch(hay0213 ? /^0213_/ : /^0212_/);
  });

  it('la cabecera cumple la convención del README: archivo, motivo (HU/Feature) y autor', () => {
    const cabecera = SQL_0214.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/HU #13061/);
    expect(cabecera).toMatch(/Feature #13057/);
  });

  it('crea la tabla del diseño, idempotente, con índice único parcial de la fila activa', () => {
    expect(SIN_COMENTARIOS).toMatch(/CREATE TABLE IF NOT EXISTS flito_sync_flit2_acceso \(/);
    expect(SIN_COMENTARIOS).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_sync_flit2_acceso_activo\s+ON flito_sync_flit2_acceso \(activo\) WHERE activo;/,
    );
    for (const col of [
      'client_id', 'secret_cipher', 'secret_iv', 'secret_auth_tag', 'aad_nonce', 'key_version', 'activo',
      'rechazado_en', 'rechazo_motivo', 'bloqueado_hasta', 'bloqueo_motivo',
      'descifrado_fallido_en', 'descifrado_fallido_motivo', 'created_at', 'created_by', 'updated_at', 'updated_by',
    ]) {
      expect(SIN_COMENTARIOS).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(SIN_COMENTARIOS).toMatch(/rechazo_motivo IN \('invalid_client', 'secret_rotation_required'\)/);
    expect(SIN_COMENTARIOS).toMatch(/bloqueo_motivo IN \('client_locked', 'rate_limited'\)/);
    // Ninguna columna en claro para la contraseña.
    expect(SIN_COMENTARIOS).not.toMatch(/\bclient_secret\b|\bsecret\s+(text|varchar)/);
  });

  it('el esquema Drizzle declara las mismas columnas e índice', () => {
    const cfg = getTableConfig(flitoSyncFlit2Acceso);
    expect(cfg.name).toBe('flito_sync_flit2_acceso');
    const columnas = cfg.columns.map((c) => c.name).sort();
    for (const col of columnas) expect(SIN_COMENTARIOS).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    expect(columnas).toHaveLength(18);
    expect(cfg.indexes.map((i) => i.config.name)).toContain('uq_flito_sync_flit2_acceso_activo');
  });

  it('siembra DOS operaciones del módulo tramites con los textos byte a byte del catálogo', () => {
    const funciones = funcionesDeSql([SQL_0214]);
    expect([...funciones.keys()].sort()).toEqual([GUARDAR, VER]);
    for (const codigo of [VER, GUARDAR]) {
      const op = OPERACIONES_DECLARADAS.find((o) => o.codigo === codigo);
      expect(op).toBeDefined();
      expect(op!.llave).toBe(LLAVES[codigo]);
      expect(funciones.get(codigo)).toEqual({
        codigo, modulo: 'tramites', nombre: op!.nombre, descripcion: op!.descripcion, tipo: 'operacion',
      });
      const f = catalogoCompleto().find((c) => c.codigo === codigo)!;
      expect(f.modulo).toBe('tramites');
      expect(f.tipo).toBe('operacion');
    }
    expect(funciones.get(VER)!.nombre).toBe('Ver el acceso a FLIT 2');
    expect(funciones.get(GUARDAR)!.nombre).toBe('Guardar el acceso a FLIT 2');
  });

  it('la foto las lleva como guardas de ruta con roles de partida = solo admin', () => {
    for (const [codigo, llave] of Object.entries(LLAVES)) {
      const g = GUARDAS_MEDIDAS.find((x) => llaveDe(x) === llave);
      expect(g).toBeDefined();
      expect(g!.heredada).toBe(false);
      expect([...g!.roles]).toEqual(['admin']);
      expect(repartoDePartida().filter(([, c]) => c === codigo).map(([r]) => r)).toEqual(['admin']);
    }
  });

  it('reparto: SOLO admin; nadie más las recibe', () => {
    const r = repartoDeSql([SQL_0214]);
    expect([...r.keys()]).toEqual(['admin']);
    expect([...r.get('admin')!].sort()).toEqual([GUARDAR, VER]);
    const total = leerRepartoSembrado();
    for (const codigo of [VER, GUARDAR]) {
      expect([...total.entries()].filter(([, fs]) => fs.has(codigo)).map(([rol]) => rol)).toEqual(['admin']);
    }
  });

  it('no retira nada y el helper de paridad la lee después de la 0212', () => {
    const retiros = leerRetirosSembrados([ARCHIVO]);
    expect(retiros.funciones.size).toBe(0);
    expect(retiros.reparto.size).toBe(0);
    expect(MIGRACIONES_CON_REPARTO.indexOf(ARCHIVO))
      .toBeGreaterThan(MIGRACIONES_CON_REPARTO.indexOf('0212_permiso_soat_reintentar_runt.sql'));
  });

  it('idempotente y con resumen que revienta si no cuadra', () => {
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING/);
    expect(SIN_COMENTARIOS.match(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING/g)).toHaveLength(1);
    expect(SIN_COMENTARIOS).not.toMatch(/DO UPDATE/);
    expect(SIN_COMENTARIOS).not.toMatch(/\bDELETE\b|\bDROP\b|\bALTER\b/);
    expect(SIN_COMENTARIOS).toMatch(/IF n_tabla <> 1 OR n_ops <> 2 OR n_reparto <> 2 THEN\s*RAISE EXCEPTION/);
    expect(SIN_COMENTARIOS).not.toMatch(/LIKE 'tramites\.%'/);
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_BASE)('0214 — aplicar ×2 sobre BD ya migrada (P6)', () => {
  let sql: postgres.Sql;
  const ROLLBACK = Symbol('rollback');

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  it('segunda pasada no rompe ni duplica; solo admin las tiene; una sola fila activa', async () => {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(SQL_0214);
        await tx.unsafe(SQL_0214);
        const [f] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM permisos_funciones WHERE codigo IN (${VER}, ${GUARDAR})`;
        expect(f!.n).toBe(2);
        const roles = await tx<{ rol_codigo: string }[]>`SELECT DISTINCT rol_codigo FROM permisos_rol_funcion WHERE funcion_codigo IN (${VER}, ${GUARDAR})`;
        expect(roles.map((r) => r.rol_codigo)).toContain('admin');
        const fila = { client_id: 'x', secret_cipher: Buffer.from('c'), secret_iv: Buffer.from('i'), secret_auth_tag: Buffer.from('t'), aad_nonce: '00000000-0000-4000-8000-000000000001' };
        await tx`INSERT INTO flito_sync_flit2_acceso ${tx(fila)}`;
        await expect(tx.savepoint((sp) => sp`INSERT INTO flito_sync_flit2_acceso ${sp({ ...fila, aad_nonce: '00000000-0000-4000-8000-000000000002' })}`))
          .rejects.toMatchObject({ code: '23505' });
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }, 60_000);
});
