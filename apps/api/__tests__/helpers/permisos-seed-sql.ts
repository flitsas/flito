// HU #12083 — El lado «motor» del test de paridad: lo que las migraciones SEMBRARON, leído del SQL.
//
// Parsea los bloques `INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES …` de la
// 0179 y de la 0181 sin base de datos. Es una fuente INDEPENDIENTE de la foto (`inventario.generado.ts`)
// y del catálogo: si alguien borra una fila del seed, aquí desaparece y el motor de la paridad dice
// NO donde la foto dice SÍ (mutación nombrada del AC8). Las migraciones son texto congelado: una
// aplicada no se edita, así que este lector no tiene que seguir a nadie.
//
// Ya NO es solo aditivo (HU #12373): la 0182 RETIRA `parametrizacion.tarifas.borrar` y le quita al
// auditor `parametrizacion.tarifas.listar`. Los `DELETE … WHERE (rol_codigo, funcion_codigo) IN (…)` y
// `DELETE FROM permisos_funciones WHERE codigo IN (…)` se pliegan en orden de archivo sobre lo sembrado,
// igual que los haría Postgres. `leerRetirosSembrados()` devuelve lo retirado, para que el test de la
// 0179 pueda distinguir «esta fila ya no la genera nadie» de «esta fila la retiró una migración».
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRACIONES = path.resolve(__dirname, '../../src/db/migrations');

/** Las migraciones que siembran (o retiran) el reparto rol × función, en orden de aplicación. */
export const MIGRACIONES_CON_REPARTO = [
  '0179_permisos_modelo.sql',
  '0181_permisos_reconduccion.sql',
  '0182_tarifas_vigencias.sql',
  '0184_pagina_flito_tarifas.sql',
  '0182_permisos_auditoria.sql',
] as const;

function sinComentariosSql(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Cada bloque `INSERT INTO <tabla> (…) VALUES … ;` del archivo, ya sin comentarios. */
function bloquesInsert(sql: string, tabla: string): string[] {
  const re = new RegExp(`INSERT INTO ${tabla}\\s*\\([^)]*\\)\\s*VALUES([\\s\\S]*?);`, 'g');
  return [...sinComentariosSql(sql).matchAll(re)].map((m) => m[1]!);
}

/**
 * Cada bloque `DELETE FROM <tabla> WHERE <columnas> IN ( … );` del archivo, ya sin comentarios. La forma
 * canónica es la de la 0182: tuplas entre paréntesis (o valores sueltos) dentro del `IN (…)`.
 */
function bloquesDelete(sql: string, tabla: string): string[] {
  const re = new RegExp(`DELETE FROM ${tabla}\\s+WHERE\\s+[^;]*?IN\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'g');
  return [...sinComentariosSql(sql).matchAll(re)].map((m) => m[1]!);
}

const literales = (texto: string): string[] =>
  [...texto.matchAll(/'((?:[^']|'')*)'/g)].map((c) => c[1]!.replace(/''/g, "'"));

/**
 * Las tuplas `('a', 'b', …)` de un bloque VALUES o de un `IN (…)`, con las comillas dobladas ya
 * deshechas. Un `IN ('a', 'b')` de una sola columna (sin paréntesis interiores) son tuplas de uno.
 */
function tuplas(bloque: string): string[][] {
  if (!bloque.includes('(')) return literales(bloque).map((l) => [l]);
  const salida: string[][] = [];
  for (const m of bloque.matchAll(/\(((?:'(?:[^']|'')*'\s*,?\s*)+)\)/g)) salida.push(literales(m[1]!));
  return salida;
}

const leer = (archivo: string): string => readFileSync(path.join(MIGRACIONES, archivo), 'utf8');

/** `rol → conjunto de códigos` que dejan esos textos SQL aplicados en orden: INSERT suma, DELETE resta. */
export function repartoDeSql(sqls: readonly string[], nombre = 'sql'): Map<string, Set<string>> {
  const reparto = new Map<string, Set<string>>();
  for (const sql of sqls) {
    for (const bloque of bloquesInsert(sql, 'permisos_rol_funcion')) {
      for (const [rol, codigo] of tuplas(bloque)) {
        if (!rol || !codigo) throw new Error(`${nombre}: fila de permisos_rol_funcion incompleta`);
        if (!reparto.has(rol)) reparto.set(rol, new Set());
        reparto.get(rol)!.add(codigo);
      }
    }
    for (const bloque of bloquesDelete(sql, 'permisos_rol_funcion')) {
      for (const [rol, codigo] of tuplas(bloque)) reparto.get(rol!)?.delete(codigo!);
    }
  }
  return reparto;
}

/** `rol → conjunto de códigos` tal como lo dejan las migraciones con reparto, en orden de aplicación. */
export function leerRepartoSembrado(archivos: readonly string[] = MIGRACIONES_CON_REPARTO): Map<string, Set<string>> {
  return repartoDeSql(archivos.map(leer), archivos.join('+'));
}

export interface FuncionSembrada { codigo: string; modulo: string; nombre: string; descripcion: string; tipo: string }

/** Las filas de `permisos_funciones` que dejan esos textos SQL aplicados en orden, por código. */
export function funcionesDeSql(sqls: readonly string[]): Map<string, FuncionSembrada> {
  const funciones = new Map<string, FuncionSembrada>();
  for (const sql of sqls) {
    for (const bloque of bloquesInsert(sql, 'permisos_funciones')) {
      for (const [codigo, modulo, nombre, descripcion, tipo] of tuplas(bloque)) {
        funciones.set(codigo!, { codigo: codigo!, modulo: modulo!, nombre: nombre!, descripcion: descripcion!, tipo: tipo! });
      }
    }
    for (const bloque of bloquesDelete(sql, 'permisos_funciones')) {
      for (const [codigo] of tuplas(bloque)) funciones.delete(codigo!);
    }
  }
  return funciones;
}

/** Las filas de `permisos_funciones` que siembran esas migraciones (menos las retiradas después), por código. */
export function leerFuncionesSembradas(archivos: readonly string[] = MIGRACIONES_CON_REPARTO): Map<string, FuncionSembrada> {
  return funcionesDeSql(archivos.map(leer));
}

export interface RetirosSembrados {
  /** Códigos de `permisos_funciones` que alguna migración retiró. */
  funciones: Set<string>;
  /** Pares `'<rol> <codigo>'` de `permisos_rol_funcion` que alguna migración retiró. */
  reparto: Set<string>;
}

/** Lo que las migraciones RETIRARON (los DELETE), sin restarlo de nada: la contraparte de las dos anteriores. */
export function leerRetirosSembrados(archivos: readonly string[] = MIGRACIONES_CON_REPARTO): RetirosSembrados {
  const retiros: RetirosSembrados = { funciones: new Set(), reparto: new Set() };
  for (const archivo of archivos) {
    const sql = leer(archivo);
    for (const bloque of bloquesDelete(sql, 'permisos_funciones')) {
      for (const [codigo] of tuplas(bloque)) retiros.funciones.add(codigo!);
    }
    for (const bloque of bloquesDelete(sql, 'permisos_rol_funcion')) {
      for (const [rol, codigo] of tuplas(bloque)) retiros.reparto.add(`${rol} ${codigo}`);
    }
  }
  return retiros;
}
