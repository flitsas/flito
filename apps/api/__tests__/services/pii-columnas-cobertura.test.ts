// Feature #13978, HU #13987 AC5 (ADR-0034 D5) — prueba de cobertura del inventario de columnas cifradas.
// Cinco capas: esquema Drizzle, migraciones SQL, fuentes, tipo en los escritores y paridad. Cada detector
// tiene su autoprueba: una tabla y una fuente sintéticas deben reportarse como no cubiertas.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, integer, PgTable, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import { DESCRIPTORES } from '../../src/modules/privacy/rotacion/descriptores.js';
import { COLUMNAS_CIFRADAS_PII, ESCRITORES, FUERA_DE_ALCANCE } from '../../src/shared/utils/pii-columnas.js';

const SRC = path.resolve(__dirname, '../../src');
const RUNBOOK = path.resolve(__dirname, '../../../../docs/arquitectura/runbook-rotacion-llave-pii.md');

const RE_NOMBRE_CIFRADO = /(_cipher|_enc|_encrypted|_cifrado)$|^cifrado_/;

const cubiertas = new Set<string>([
  ...COLUMNAS_CIFRADAS_PII.flatMap((c) => c.fisicas.map((f) => `${c.tabla}.${f}`)),
  ...Object.keys(FUERA_DE_ALCANCE),
]);

const esSospechosa = (nombre: string, tipo: string) => tipo.toLowerCase() === 'bytea' || RE_NOMBRE_CIFRADO.test(nombre);

const sinCubrir = (columnas: string[], cubierto: Set<string> = cubiertas) => columnas.filter((c) => !cubierto.has(c)).sort();

// ── Capa 1: Drizzle ────────────────────────────────────────────────────────────────────────────────

function sospechosasDrizzle(tablas: unknown[]): string[] {
  const salida = new Set<string>();
  for (const t of tablas) {
    if (!is(t, PgTable)) continue;
    const { name, columns } = getTableConfig(t);
    for (const c of columns) if (esSospechosa(c.name, c.getSQLType())) salida.add(`${name}.${c.name}`);
  }
  return [...salida];
}

async function tablasDelEsquema(): Promise<unknown[]> {
  const modulos: Record<string, unknown>[] = [schema as Record<string, unknown>];
  const dir = path.join(SRC, 'db/schema');
  for (const archivo of readdirSync(dir)) {
    if (archivo.endsWith('.ts')) modulos.push(await import(path.join(dir, archivo)) as Record<string, unknown>);
  }
  return modulos.flatMap((m) => Object.values(m));
}

// ── Capa 2: migraciones SQL ────────────────────────────────────────────────────────────────────────

const NOMBRE = /"?([a-zA-Z_][a-zA-Z0-9_]*)"?/.source;
const TABLA = `(?:public\\.)?${NOMBRE}`;
const NO_COLUMNA = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)\b/i;

function sinComentarios(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Corta el cuerpo de un `CREATE TABLE` en sus definiciones, respetando paréntesis. */
function definiciones(sql: string, desde: number): string[] {
  const partes: string[] = [];
  let nivel = 1;
  let inicio = desde;
  for (let i = desde; i < sql.length; i += 1) {
    if (sql[i] === '(') nivel += 1;
    if (sql[i] === ')') nivel -= 1;
    if ((sql[i] === ',' && nivel === 1) || nivel === 0) {
      partes.push(sql.slice(inicio, i).trim());
      inicio = i + 1;
    }
    if (nivel === 0) break;
  }
  return partes;
}

/**
 * Aplica las sentencias en orden para quedarse con el estado final: una columna que una migración borró
 * después ya no cifra nada. Reconoce CREATE TABLE, ADD/DROP/RENAME COLUMN, RENAME TO y DROP TABLE.
 */
function sospechosasEnMigraciones(sqls: string[]): string[] {
  const tablas = new Map<string, Map<string, string>>();
  const re = new RegExp([
    `CREATE TABLE (?:IF NOT EXISTS )?${TABLA}\\s*\\(`,
    `DROP TABLE (?:IF EXISTS )?${TABLA}`,
    `ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${TABLA}\\s+RENAME TO ${NOMBRE}`,
    `ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${TABLA}\\s+([^;]*)`,
  ].join('|'), 'gi');
  for (const crudo of sqls) {
    const sql = sinComentarios(crudo);
    for (const m of sql.matchAll(re)) {
      if (m[1]) {
        const columnas = tablas.get(m[1].toLowerCase()) ?? new Map<string, string>();
        for (const def of definiciones(sql, (m.index as number) + m[0].length)) {
          if (NO_COLUMNA.test(def)) continue;
          const col = new RegExp(`^${NOMBRE}\\s+([a-zA-Z]+)`).exec(def);
          if (col) columnas.set(col[1].toLowerCase(), col[2]);
        }
        tablas.set(m[1].toLowerCase(), columnas);
      } else if (m[2]) {
        tablas.delete(m[2].toLowerCase());
      } else if (m[3]) {
        const columnas = tablas.get(m[3].toLowerCase());
        tablas.delete(m[3].toLowerCase());
        if (columnas) tablas.set(m[4].toLowerCase(), columnas);
      } else if (m[5]) {
        const columnas = tablas.get(m[5].toLowerCase()) ?? new Map<string, string>();
        tablas.set(m[5].toLowerCase(), columnas);
        const acciones = m[6];
        for (const a of acciones.matchAll(new RegExp(`ADD COLUMN (?:IF NOT EXISTS )?${NOMBRE}\\s+([a-zA-Z]+)`, 'gi'))) {
          columnas.set(a[1].toLowerCase(), a[2]);
        }
        for (const a of acciones.matchAll(new RegExp(`DROP COLUMN (?:IF EXISTS )?${NOMBRE}`, 'gi'))) {
          columnas.delete(a[1].toLowerCase());
        }
        const ren = new RegExp(`RENAME (?:COLUMN )?${NOMBRE} TO ${NOMBRE}`, 'i').exec(acciones);
        if (ren && columnas.has(ren[1].toLowerCase())) {
          columnas.set(ren[2].toLowerCase(), columnas.get(ren[1].toLowerCase()) as string);
          columnas.delete(ren[1].toLowerCase());
        }
      }
    }
  }
  const salida: string[] = [];
  for (const [tabla, columnas] of tablas) {
    for (const [col, tipo] of columnas) if (esSospechosa(col, tipo)) salida.push(`${tabla}.${col}`);
  }
  return salida;
}

function migraciones(): string[] {
  const dir = path.join(SRC, 'db/migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(path.join(dir, f), 'utf8'));
}

// ── Capa 3: fuentes ────────────────────────────────────────────────────────────────────────────────

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = path.join(dir, nombre);
    if (statSync(ruta).isDirectory()) return archivosTs(ruta);
    return nombre.endsWith('.ts') ? [ruta] : [];
  });
}

const RE_ESCRITOR = /\bencryptPii(?:Buffer|Text|TextConVersion)?\s*\(/;
const RE_PRIMITIVA = /\bcreate(?:Cipheriv|Decipheriv)\s*\(/;
const ARCHIVO_CRYPTO = 'shared/utils/crypto.ts';

function sinComentariosTs(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');
}

function analizarFuentes(fuentes: Record<string, string>, escritores: readonly string[]) {
  const noDeclarados: string[] = [];
  const primitivaFuera: string[] = [];
  const conEscritura = new Set<string>();
  for (const [archivo, crudo] of Object.entries(fuentes)) {
    if (archivo === ARCHIVO_CRYPTO) continue;
    const fuente = sinComentariosTs(crudo);
    if (RE_ESCRITOR.test(fuente)) {
      conEscritura.add(archivo);
      if (!escritores.includes(archivo)) noDeclarados.push(archivo);
    }
    if (RE_PRIMITIVA.test(fuente)) primitivaFuera.push(archivo);
  }
  const sobrantes = escritores.filter((e) => !conEscritura.has(e));
  return { noDeclarados, primitivaFuera, sobrantes };
}

function fuentesReales(): Record<string, string> {
  return Object.fromEntries(archivosTs(SRC).map((ruta) => [
    path.relative(SRC, ruta).split(path.sep).join('/'),
    readFileSync(ruta, 'utf8'),
  ]));
}

// ── Pruebas ────────────────────────────────────────────────────────────────────────────────────────

describe('capa 1: esquema Drizzle', () => {
  it('toda columna bytea o con nombre de cifrado está en el catálogo o fuera de alcance con motivo', async () => {
    expect(sinCubrir(sospechosasDrizzle(await tablasDelEsquema()))).toEqual([]);
  });

  it('autoprueba: detecta una tabla sintética con x_cipher y con cifrado_y', () => {
    const sintetica = pgTable('sintetica', { id: integer('id'), xCipher: text('x_cipher'), cifradoY: text('cifrado_y') });
    expect(sinCubrir(sospechosasDrizzle([sintetica]))).toEqual(['sintetica.cifrado_y', 'sintetica.x_cipher']);
  });
});

describe('capa 2: migraciones SQL', () => {
  it('lo mismo para lo que no llegó a Drizzle', () => {
    expect(sinCubrir(sospechosasEnMigraciones(migraciones()))).toEqual([]);
  });

  it('autoprueba: detecta CREATE TABLE y ADD COLUMN, y olvida lo borrado', () => {
    const r = sospechosasEnMigraciones([
      'CREATE TABLE IF NOT EXISTS sint (id int, a_cipher bytea, nota text, CONSTRAINT x_enc CHECK (id > 0));',
      'ALTER TABLE sint ADD COLUMN IF NOT EXISTS b_enc jsonb;',
      'ALTER TABLE sint ADD COLUMN c_cipher bytea, ADD COLUMN d text;',
      'ALTER TABLE sint DROP COLUMN c_cipher;',
      'CREATE TABLE sint2 (e_cifrado text); DROP TABLE sint2;',
      '-- ALTER TABLE sint ADD COLUMN comentario_cipher bytea;',
    ]);
    expect(r.sort()).toEqual(['sint.a_cipher', 'sint.b_enc']);
  });
});

describe('capa 3: fuentes', () => {
  it('todo archivo que cifra PII está en ESCRITORES, y ninguno sobra', () => {
    const { noDeclarados, sobrantes } = analizarFuentes(fuentesReales(), ESCRITORES);
    expect(noDeclarados).toEqual([]);
    expect(sobrantes).toEqual([]);
  });

  it('`createCipheriv` y `createDecipheriv` solo existen en crypto.ts', () => {
    expect(analizarFuentes(fuentesReales(), ESCRITORES).primitivaFuera).toEqual([]);
  });

  it('autoprueba: una fuente sintética con encryptPiiText( o createCipheriv( se reporta', () => {
    const r = analizarFuentes({
      'modules/x/nuevo.ts': "const v = encryptPiiText(valor, ctx);",
      'modules/y/propio.ts': "const c = crypto.createCipheriv('aes-256-gcm', k, iv);",
      'modules/z/solo-comentario.ts': '// se parece a encryptPiiText( pero es un comentario',
    }, []);
    expect(r.noDeclarados).toEqual(['modules/x/nuevo.ts']);
    expect(r.primitivaFuera).toEqual(['modules/y/propio.ts']);
  });
});

describe('capa 4: tipo en los escritores', () => {
  it('los `encrypt*` de PII exigen tabla y columna del catálogo (el gate real es build:api)', () => {
    const crypto = readFileSync(path.join(SRC, ARCHIVO_CRYPTO), 'utf8');
    expect(crypto).toMatch(/export function encryptPii\(plaintext: string, aadParts: AadPii\)/);
    expect(crypto).toMatch(/export function encryptPiiBuffer\(plain: Buffer, aadParts: AadPii\)/);
    expect(crypto).toMatch(/export function encryptPiiText\(plain: string, ctx: Omit<PiiTextContext, 'table' \| 'column'> & ParAadPii\)/);
  });
});

describe('capa 5: paridad', () => {
  it('catálogo y descriptores tienen las mismas entradas, con su id correcto', () => {
    expect(Object.keys(DESCRIPTORES).sort()).toEqual(COLUMNAS_CIFRADAS_PII.map((c) => c.id).sort());
    for (const [clave, d] of Object.entries(DESCRIPTORES)) expect(d.id).toBe(clave);
  });

  it('cada columna física del catálogo existe en el esquema real', async () => {
    const reales = new Set<string>();
    for (const t of await tablasDelEsquema()) {
      if (!is(t, PgTable)) continue;
      const { name, columns } = getTableConfig(t);
      for (const c of columns) reales.add(`${name}.${c.name}`);
    }
    const faltan = COLUMNAS_CIFRADAS_PII.flatMap((c) => c.fisicas.map((f) => `${c.tabla}.${f}`)).filter((c) => !reales.has(c));
    expect(faltan).toEqual([]);
  });

  it('cada entrada de FUERA_DE_ALCANCE tiene motivo y sigue existiendo', async () => {
    const reales = new Set([
      ...sospechosasDrizzle(await tablasDelEsquema()),
      ...sospechosasEnMigraciones(migraciones()),
    ]);
    for (const [columna, motivo] of Object.entries(FUERA_DE_ALCANCE)) {
      expect(motivo.length, columna).toBeGreaterThan(5);
      expect(reales.has(columna), columna).toBe(true);
    }
  });

  it('el inventario del runbook nombra cada columna del catálogo', () => {
    const runbook = readFileSync(RUNBOOK, 'utf8');
    const faltan = COLUMNAS_CIFRADAS_PII.map((c) => c.id).filter((id) => !runbook.includes(`\`${id}\``));
    expect(faltan).toEqual([]);
  });
});
