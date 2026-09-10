// HU #12083 — El lado «motor» del test de paridad: lo que las migraciones SEMBRARON, leído del SQL.
//
// Parsea los bloques `INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES …` de la
// 0179 y de la 0181 sin base de datos. Es una fuente INDEPENDIENTE de la foto (`inventario.generado.ts`)
// y del catálogo: si alguien borra una fila del seed, aquí desaparece y el motor de la paridad dice
// NO donde la foto dice SÍ (mutación nombrada del AC8). Las migraciones son texto congelado: una
// aplicada no se edita, así que este lector no tiene que seguir a nadie.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRACIONES = path.resolve(__dirname, '../../src/db/migrations');

/** Las migraciones que siembran el reparto rol × función. La #12086 y siguientes se añaden aquí. */
export const MIGRACIONES_CON_REPARTO = ['0179_permisos_modelo.sql', '0181_permisos_reconduccion.sql'] as const;

function sinComentariosSql(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Cada bloque `INSERT INTO <tabla> (…) VALUES … ;` del archivo, ya sin comentarios. */
function bloquesInsert(sql: string, tabla: string): string[] {
  const re = new RegExp(`INSERT INTO ${tabla}\\s*\\([^)]*\\)\\s*VALUES([\\s\\S]*?);`, 'g');
  return [...sinComentariosSql(sql).matchAll(re)].map((m) => m[1]!);
}

/** Las tuplas `('a', 'b', …)` de un bloque VALUES, con las comillas dobladas ya deshechas. */
function tuplas(bloque: string): string[][] {
  const salida: string[][] = [];
  for (const m of bloque.matchAll(/\(((?:'(?:[^']|'')*'\s*,?\s*)+)\)/g)) {
    salida.push([...m[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((c) => c[1]!.replace(/''/g, "'")));
  }
  return salida;
}

/** `rol → conjunto de códigos` tal como lo dejan las migraciones con reparto, en orden de aplicación. */
export function leerRepartoSembrado(archivos: readonly string[] = MIGRACIONES_CON_REPARTO): Map<string, Set<string>> {
  const reparto = new Map<string, Set<string>>();
  for (const archivo of archivos) {
    const sql = readFileSync(path.join(MIGRACIONES, archivo), 'utf8');
    for (const bloque of bloquesInsert(sql, 'permisos_rol_funcion')) {
      for (const [rol, codigo] of tuplas(bloque)) {
        if (!rol || !codigo) throw new Error(`${archivo}: fila de permisos_rol_funcion incompleta`);
        if (!reparto.has(rol)) reparto.set(rol, new Set());
        reparto.get(rol)!.add(codigo);
      }
    }
  }
  return reparto;
}

export interface FuncionSembrada { codigo: string; modulo: string; nombre: string; descripcion: string; tipo: string }

/** Las filas de `permisos_funciones` que siembran esas migraciones, por código. */
export function leerFuncionesSembradas(archivos: readonly string[] = MIGRACIONES_CON_REPARTO): Map<string, FuncionSembrada> {
  const funciones = new Map<string, FuncionSembrada>();
  for (const archivo of archivos) {
    const sql = readFileSync(path.join(MIGRACIONES, archivo), 'utf8');
    for (const bloque of bloquesInsert(sql, 'permisos_funciones')) {
      for (const [codigo, modulo, nombre, descripcion, tipo] of tuplas(bloque)) {
        funciones.set(codigo!, { codigo: codigo!, modulo: modulo!, nombre: nombre!, descripcion: descripcion!, tipo: tipo! });
      }
    }
  }
  return funciones;
}
