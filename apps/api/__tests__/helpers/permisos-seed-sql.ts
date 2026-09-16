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
//
// Tercer verbo desde la HU #12716: la 0205 REAGRUPA (`UPDATE permisos_funciones AS f SET modulo =
// v.modulo FROM (VALUES …) AS v(codigo, modulo) …`). Se pliega como cambio de `modulo` sobre la fila
// ya sembrada —un UPDATE sobre un código no sembrado es error de orden, no se ignora— y
// `leerReagrupacionesSembradas()` devuelve el mapa `codigo → modulo` para que el test de la 0179 sepa
// qué migración cambió el módulo de una fila suya. Solo se reconoce ESA forma canónica: un UPDATE
// escrito de otra manera no se plegaría y la paridad contra lo generado saldría en rojo.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRACIONES = path.resolve(__dirname, '../../src/db/migrations');

/** Las migraciones que siembran, retiran o reagrupan funciones y reparto, en orden de aplicación. */
// Una migración por línea: dos ramas que añaden la suya no deben conflictar.
export const MIGRACIONES_CON_REPARTO = [
  '0179_permisos_modelo.sql',
  '0181_permisos_reconduccion.sql',
  '0182_tarifas_vigencias.sql',
  '0184_pagina_flito_tarifas.sql',
  '0185_permisos_auditoria.sql',
  '0186_permisos_roles_mantenimiento.sql',
  '0187_pagina_roles_permisos.sql',
  '0190_users_baja_logica.sql',
  '0200_pagina_finanzas_gastos_diarios.sql',
  '0203_permiso_excel_exportar_pago.sql',
  '0205_permisos_reagrupar_modulos.sql',
] as const;

function sinComentariosSql(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * En release (promoción selectiva del Feature 12072) la 0205 viaja BYTE A BYTE igual que en staging,
 * pero sin las migraciones 0191-0202: estos 9 códigos de su VALUES no existen en release (servicios
 * adicionales y comprobantes no suben), así que su UPDATE es no-op en la base y el generador no los
 * produce. Es la ÚNICA tolerancia del plegado: cualquier otro código no sembrado sigue reventando.
 * Pares `codigo → modulo` exactamente como los escribe la 0205, ordenados por código.
 */
export const REAGRUPACIONES_AUSENTES_EN_RELEASE: ReadonlyMap<string, string> = new Map([
  ['finanzas.servicios_adicionales.asignar', 'servicios_adicionales'],
  ['finanzas.servicios_adicionales.quitar', 'servicios_adicionales'],
  ['finanzas.servicios_adicionales.ver', 'servicios_adicionales'],
  ['pagina.flito_comprobantes', 'comprobantes'],
  ['pagina.flito_servicios_adicionales', 'servicios_adicionales'],
  ['parametrizacion.servicios_adicionales.crear', 'servicios_adicionales'],
  ['parametrizacion.servicios_adicionales.dar_de_baja', 'servicios_adicionales'],
  ['parametrizacion.servicios_adicionales.editar', 'servicios_adicionales'],
  ['parametrizacion.servicios_adicionales.listar', 'servicios_adicionales'],
]);

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

/**
 * Cada bloque `UPDATE permisos_funciones AS f SET modulo = v.modulo FROM (VALUES … ) AS v(codigo, modulo)
 * WHERE f.codigo = v.codigo AND f.modulo IS DISTINCT FROM v.modulo;` del archivo (HU #12716). La forma
 * canónica es la que emite `generar-seed-permisos.ts --reagrupar`; devuelve el interior del VALUES.
 */
function bloquesUpdateModulo(sql: string): string[] {
  const re = /UPDATE permisos_funciones AS f\s+SET modulo = v\.modulo\s+FROM \(VALUES([\s\S]*?)\) AS v\(codigo, modulo\)\s+WHERE f\.codigo = v\.codigo\s+AND f\.modulo IS DISTINCT FROM v\.modulo\s*;/g;
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
    for (const bloque of bloquesUpdateModulo(sql)) {
      for (const [codigo, modulo] of tuplas(bloque)) {
        const fila = funciones.get(codigo!);
        // En release (promoción selectiva del Feature 12072): no-op solo para los 9 ausentes nombrados.
        if (!fila && modulo && REAGRUPACIONES_AUSENTES_EN_RELEASE.get(codigo!) === modulo) continue;
        if (!fila || !modulo) throw new Error(`UPDATE de modulo sobre una función no sembrada antes: ${codigo}`);
        fila.modulo = modulo;
      }
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

/** Lo que las migraciones REAGRUPARON (los UPDATE de `modulo`): `codigo → modulo`, el último gana. */
export function leerReagrupacionesSembradas(archivos: readonly string[] = MIGRACIONES_CON_REPARTO): Map<string, string> {
  const reagrupadas = new Map<string, string>();
  for (const archivo of archivos) {
    for (const bloque of bloquesUpdateModulo(leer(archivo))) {
      for (const [codigo, modulo] of tuplas(bloque)) reagrupadas.set(codigo!, modulo!);
    }
  }
  return reagrupadas;
}
