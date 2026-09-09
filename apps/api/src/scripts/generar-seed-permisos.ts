// HU #12081 — El GENERADOR del seed de la migración 0179 (AC4: «el seed se genera desde el código,
// no se teclea; el script queda en el repo y se puede volver a correr»).
//
//   npm run permisos:seed -w apps/api        → escupe el bloque SQL por stdout
//   npm run permisos:inventario -w apps/api  → escupe el inventario de guardas medido, para el PR
//
// Lo que sale por stdout es EXACTAMENTE lo que está pegado entre las marcas «SEED GENERADO» de
// `0179_permisos_modelo.sql`. Volver a correrlo sobre el mismo código produce byte por byte el mismo
// texto: el orden es estable (código, y rol+código en el reparto) a propósito, para que un `diff`
// contra la migración diga si el código y el seed se han separado.
//
// El seed NO se aplica desde aquí. Escribir en la base es cosa del runner de migraciones, que es
// quien tiene la transacción y el registro de lo aplicado.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogoCompleto, repartoDePartida, type FuncionCatalogo } from '../modules/permisos/catalogo.js';
import { inventarioDeGuardas, llaveDe } from '../modules/permisos/inventario-guardas.js';

/** Literal SQL de una cadena: comilla simple doblada. Sin concatenar nada más (regla 3 de AGENTS). */
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function sqlFunciones(catalogo: FuncionCatalogo[]): string {
  const filas = catalogo.map((f) =>
    `  (${lit(f.codigo)}, ${lit(f.modulo)}, ${lit(f.nombreNegocio)}, ${lit(f.descripcion)}, ${lit(f.tipo)})`);
  return [
    '-- Catálogo de funciones (AC2). Generado: no editar a mano.',
    'INSERT INTO permisos_funciones (codigo, modulo, nombre_negocio, descripcion, tipo) VALUES',
    filas.join(',\n'),
    'ON CONFLICT (codigo) DO NOTHING;',
  ].join('\n');
}

function sqlReparto(pares: [string, string][]): string {
  const filas = pares.map(([rol, codigo]) => `  (${lit(rol)}, ${lit(codigo)})`);
  return [
    '-- Reparto de partida rol × función (AC4). Generado: no editar a mano.',
    'INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) VALUES',
    filas.join(',\n'),
    'ON CONFLICT (rol_codigo, funcion_codigo) DO NOTHING;',
  ].join('\n');
}

function seed(): string {
  const catalogo = catalogoCompleto();
  const pares = repartoDePartida(catalogo);
  const paginas = catalogo.filter((f) => f.tipo === 'pagina').length;
  const operaciones = catalogo.length - paginas;
  return [
    `-- ${catalogo.length} funciones: ${paginas} de tipo 'pagina' y ${operaciones} de tipo 'operacion'.`,
    `-- ${pares.length} filas de reparto. Regenerar con: npm run permisos:seed -w apps/api`,
    '',
    sqlFunciones(catalogo),
    '',
    sqlReparto(pares),
  ].join('\n');
}

/** El inventario medido, en texto plano. Es la evidencia del conteo de guardas que pide el AC. */
function inventario(): string {
  const guardas = inventarioDeGuardas();
  const porModulo = new Map<string, number>();
  for (const g of guardas) porModulo.set(g.modulo, (porModulo.get(g.modulo) ?? 0) + 1);
  return [
    `${guardas.length} rutas guardadas por requireRole en los ficheros del alcance.`,
    [...porModulo.entries()].map(([m, n]) => `  ${m}: ${n}`).join('\n'),
    '',
    ...guardas.map((g) => `${llaveDe(g)}  [${g.roles.join(', ')}]`),
  ].join('\n');
}

/**
 * Reescribe `modules/permisos/inventario.generado.ts`, el SNAPSHOT que usa el runtime.
 *
 * Hace falta porque la imagen de producción NO lleva los `.ts`: el Dockerfile copia `dist`, las
 * migraciones, `db/data` y `vendor`, y nada más. Un lector que en arranque hiciera `readFileSync` de
 * `flito-soat.routes.ts` reventaría con ENOENT en el contenedor y la comprobación del AC6 sería
 * ruido en vez de garantía. Medido leyendo el Dockerfile, no supuesto.
 *
 * Así que el lector de fuentes queda para el GENERADOR y para los tests —donde el árbol existe—, y
 * lo que viaja compilado es este snapshot. Que no se separe de las guardas lo comprueba
 * `permisos-catalogo.test.ts`, que vuelve a leer los ficheros y compara.
 */
function escribirSnapshot(): string {
  const guardas = inventarioDeGuardas();
  const destino = join(dirname(fileURLToPath(import.meta.url)), '../modules/permisos/inventario.generado.ts');
  const cuerpo = [
    '// GENERADO por `npm run permisos:generar -w apps/api`. NO EDITAR A MANO.',
    '//',
    '// Es la foto de qué roles exige hoy cada ruta guardada por `requireRole` en los ficheros del',
    '// alcance del Feature #12072. Existe porque la imagen de producción no lleva los `.ts` y el',
    '// runtime no puede releer las fuentes; el lector que las lee de verdad es `inventario-guardas.ts`,',
    '// y `permisos-catalogo.test.ts` comprueba que esta foto sigue siendo fiel.',
    "import type { GuardaLeida } from './inventario-guardas.js';",
    '',
    `/** ${guardas.length} rutas guardadas, medidas el día de la generación. */`,
    'export const GUARDAS_MEDIDAS: GuardaLeida[] = [',
    ...guardas.map((g) => `  { modulo: ${JSON.stringify(g.modulo)}, fichero: ${JSON.stringify(g.fichero)}, `
      + `metodo: ${JSON.stringify(g.metodo)}, ruta: ${JSON.stringify(g.ruta)}, `
      + `roles: ${JSON.stringify(g.roles)}, heredada: ${g.heredada} },`),
    '];',
    '',
  ].join('\n');
  writeFileSync(destino, cuerpo, 'utf8');
  return `${guardas.length} guardas escritas en ${destino}`;
}

const modo = process.argv[2];
const salida = modo === '--inventario' ? inventario()
  : modo === '--snapshot' ? escribirSnapshot()
    : seed();
process.stdout.write(salida + '\n');
