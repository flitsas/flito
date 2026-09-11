// HU #12083 — La 0181: las once funciones que el catálogo de la 0179 no tenía (dos de impuestos, ocho
// de `users/`, una guarda en línea de trámites) y su reparto de partida, solo `admin`.
//
// Dos mitades, igual que la 0179 y la 0180:
//   · **Estática** (siempre corre, también en CI): lo que el `.sql` siembra es EXACTAMENTE lo que el
//     catálogo del código (foto ampliada + `catalogo-operaciones.ts`) produce para esas once, y las
//     reglas del archivo (sin BEGIN, sin ALTER TYPE, sin ADD COLUMN, sin DELETE/UPDATE, dollar-quoting
//     etiquetado, ON CONFLICT DO NOTHING en las dos siembras).
//   · **Contra PostgreSQL de verdad** (solo si hay base): las once existen, `admin` las tiene y nadie
//     más, y la idempotencia fuerte. Se activa con la URL de una base con la cadena al día:
//         TEST_DATABASE_URL='postgres://operaciones_app:…@127.0.0.1:5434/operaciones_db' \
//         npm run test -w apps/api -- __tests__/db/migracion-0181.test.ts
//     Sin esa variable se SALTA en vez de fallar: el CI no levanta Postgres.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { scanForTxControl } from '../../src/scripts/db-apply.js';
import { catalogoCompleto, repartoDePartida } from '../../src/modules/permisos/catalogo.js';
import { leerFuncionesSembradas, leerRepartoSembrado } from '../helpers/permisos-seed-sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVO = '0181_permisos_reconduccion.sql';
const RUTA = path.resolve(__dirname, '../../src/db/migrations', ARCHIVO);
const SQL_0181 = readFileSync(RUTA, 'utf8');
const SIN_COMENTARIOS = SQL_0181.replace(/--[^\n]*/g, '');

/** Las once, por su nombre: la lista es la afirmación de la HU, no se deriva de nada. */
export const FUNCIONES_0181 = [
  'impuestos.tramite.asumir', 'impuestos.tramite.devolver',
  'tramite.tramite.forzar_continuar',
  'usuarios.contrasena.cambiar_ajena', 'usuarios.sesiones.invalidar', 'usuarios.usuario.activar',
  'usuarios.usuario.crear', 'usuarios.usuario.editar', 'usuarios.usuario.exportar',
  'usuarios.usuario.listar', 'usuarios.usuario.ver_resumen',
] as const;

describe('0181 — el archivo siembra lo que el catálogo del código declara (análisis estático)', () => {
  it('no trae control de transacción propio (ADR-DB-001) y el bloque DO lleva dollar-quoting etiquetado', () => {
    expect(scanForTxControl(ARCHIVO, SQL_0181)).toEqual([]);
    expect(SQL_0181).toMatch(/DO \$resumen0181\$/);
    expect(SQL_0181).toMatch(/END \$resumen0181\$;/);
    expect(SIN_COMENTARIOS).not.toMatch(/\$\$/);
  });

  it('la cabecera cumple la convención 5 del README: archivo, motivo y autor', () => {
    const cabecera = SQL_0181.split('\n').slice(0, 12).join('\n');
    expect(cabecera.split('\n')[0]).toBe(`-- ${ARCHIVO}`);
    expect(cabecera).toMatch(/^-- Autor: /m);
    expect(cabecera).toMatch(/Feature #12072/);
    expect(cabecera).toMatch(/HU #12083/);
  });

  it('el número es 0181 y no colisiona con ningún otro archivo', () => {
    const con0181 = readdirSync(path.dirname(RUTA)).filter((f) => f.startsWith('0181_'));
    expect(con0181).toEqual([ARCHIVO]);
  });

  it('nada de ALTER TYPE, ADD COLUMN, DELETE ni UPDATE: solo dos INSERT con ON CONFLICT DO NOTHING', () => {
    expect(SIN_COMENTARIOS).not.toMatch(/ALTER\s+TYPE|ADD\s+COLUMN|CREATE\s+TABLE|\bDELETE\b|\bUPDATE\b/i);
    expect(SIN_COMENTARIOS.match(/INSERT INTO/g)).toHaveLength(2);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_funciones \(codigo, modulo, nombre_negocio, descripcion, tipo\) VALUES/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(codigo\) DO NOTHING;/);
    expect(SIN_COMENTARIOS).toMatch(/INSERT INTO permisos_rol_funcion \(rol_codigo, funcion_codigo\) VALUES/);
    expect(SIN_COMENTARIOS).toMatch(/ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
    // Sin bump de sesiones: el JWT no lleva permisos y la caché es de 60 s.
    expect(SIN_COMENTARIOS).not.toMatch(/session_invalidated_at/);
  });

  it('siembra exactamente las once funciones, con el módulo, el nombre y la descripción del catálogo del código', () => {
    const sembradas = leerFuncionesSembradas([ARCHIVO]);
    expect([...sembradas.keys()].sort()).toEqual([...FUNCIONES_0181].sort());
    const catalogo = new Map(catalogoCompleto().map((f) => [f.codigo, f]));
    for (const codigo of FUNCIONES_0181) {
      const f = catalogo.get(codigo);
      expect(f, `${codigo} en el catálogo del código`).toBeDefined();
      expect(sembradas.get(codigo)).toEqual({
        codigo, modulo: f!.modulo, nombre: f!.nombreNegocio, descripcion: f!.descripcion, tipo: 'operacion',
      });
    }
  });

  it('el reparto es `admin` × las once, y nadie más: lo que la foto dice de cada una', () => {
    const reparto = leerRepartoSembrado([ARCHIVO]);
    expect([...reparto.keys()]).toEqual(['admin']);
    expect([...reparto.get('admin')!].sort()).toEqual([...FUNCIONES_0181].sort());
    const desdeElCodigo = repartoDePartida().filter(([, c]) => (FUNCIONES_0181 as readonly string[]).includes(c));
    expect(desdeElCodigo.map(([r, c]) => `${r} ${c}`).sort())
      .toEqual([...FUNCIONES_0181].map((c) => `admin ${c}`).sort());
  });

  it('ninguna de las once estaba ya en la 0179', () => {
    const en0179 = leerFuncionesSembradas(['0179_permisos_modelo.sql']);
    for (const codigo of FUNCIONES_0181) expect(en0179.has(codigo), codigo).toBe(false);
  });

  it('0179 + 0181 producen el mismo reparto que el generador sobre la foto ampliada', () => {
    const sembrado = leerRepartoSembrado();
    const pares = [...sembrado.entries()].flatMap(([r, cs]) => [...cs].map((c) => `${r} ${c}`)).sort();
    expect(pares).toEqual(repartoDePartida().map(([r, c]) => `${r} ${c}`).sort());
  });
});

const URL_BASE = process.env.TEST_DATABASE_URL;
const ROLLBACK = Symbol('rollback');

describe.skipIf(!URL_BASE)('0181 — contra la base real (catálogo, reparto e idempotencia)', () => {
  let sql: postgres.Sql;

  beforeAll(() => { sql = postgres(URL_BASE!, { max: 1, onnotice: () => {} }); });
  afterAll(async () => { await sql?.end(); });

  async function enTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let salida!: T;
    try {
      await sql.begin(async (tx) => { salida = await fn(tx); throw ROLLBACK; });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return salida;
  }

  it('las once existen como operaciones activas', async () => {
    const filas = await sql`SELECT codigo, tipo, activo FROM permisos_funciones WHERE codigo IN ${sql([...FUNCIONES_0181])} ORDER BY codigo`;
    expect(filas.map((f) => f.codigo)).toEqual([...FUNCIONES_0181].sort());
    expect(filas.every((f) => f.tipo === 'operacion' && f.activo === true)).toBe(true);
  });

  it('`admin` las tiene y ningún otro rol', async () => {
    const filas = await sql`SELECT rol_codigo, funcion_codigo FROM permisos_rol_funcion WHERE funcion_codigo IN ${sql([...FUNCIONES_0181])} ORDER BY funcion_codigo`;
    expect(filas.map((f) => f.funcion_codigo)).toEqual([...FUNCIONES_0181].sort());
    expect(new Set(filas.map((f) => f.rol_codigo))).toEqual(new Set(['admin']));
  });

  it('idempotencia fuerte: aplicar el archivo por segunda vez no cambia ni una fila', async () => {
    const { antes, despues } = await enTx(async (tx) => {
      const huella = async () => (await tx`
        SELECT
          (SELECT md5(string_agg(codigo||modulo||nombre_negocio||descripcion||tipo||activo::text, ',' ORDER BY codigo)) FROM permisos_funciones) AS f,
          (SELECT md5(string_agg(rol_codigo||funcion_codigo, ',' ORDER BY rol_codigo, funcion_codigo)) FROM permisos_rol_funcion) AS r
      `)[0];
      const a = await huella();
      await tx.unsafe(SQL_0181);
      const d = await huella();
      return { antes: a, despues: d };
    });
    expect(despues).toEqual(antes);
  }, 60_000);
});
