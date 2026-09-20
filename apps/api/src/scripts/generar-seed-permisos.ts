// HU #12081 / #12083 — El GENERADOR del seed de permisos (AC4 de la #12081: «el seed se genera desde
// el código, no se teclea; el script queda en el repo y se puede volver a correr»).
//
//   npm run permisos:seed -w apps/api        → escupe el bloque SQL por stdout
//   npm run permisos:seed -w apps/api -- --reagrupar
//       → solo el UPDATE de `modulo` de la HU #12716 (lo pegado en 0205_permisos_reagrupar_modulos.sql)
//
// Lo que sale por stdout es EXACTAMENTE lo que está pegado entre las marcas «SEED GENERADO» de
// `0179_permisos_modelo.sql` más las filas que la 0181 añadió. Volver a correrlo sobre el mismo
// código produce byte por byte el mismo texto: el orden es estable (código, y rol+código en el
// reparto) a propósito, para que un `diff` contra las migraciones diga si el código y el seed se
// han separado. Una función nueva se añade a la foto (`inventario.generado.ts`) y al catálogo, se
// corre esto, y las líneas nuevas van a la migración siguiente.
//
// Los modos `--snapshot` y `--inventario` de la #12081 se retiraron en la #12083: la foto ya no se
// genera desde el fuente (las rutas no llevan `requireRole`; regenerarla la vaciaría) y el inventario
// de guardas lo dan los tests de paridad y de cierre.
//
// El seed NO se aplica desde aquí. Escribir en la base es cosa del runner de migraciones, que es
// quien tiene la transacción y el registro de lo aplicado.
import { catalogoCompleto, repartoDePartida, type FuncionCatalogo } from '../modules/permisos/catalogo.js';
import { reagrupaciones } from '../modules/permisos/catalogo-agrupacion.js';

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

/**
 * HU #12716 — El overlay de agrupación: un solo `UPDATE … FROM (VALUES …)` con los pares de
 * `reagrupaciones()`, en la forma canónica que `__tests__/helpers/permisos-seed-sql.ts` sabe plegar.
 * `IS DISTINCT FROM` hace la segunda pasada un no-op (P6). Se valida contra el catálogo primero: una
 * entrada muerta del mapa revienta aquí antes de escribir una migración sobre nada.
 */
function reagrupar(): string {
  catalogoCompleto();
  const pares = reagrupaciones();
  const filas = pares.map(([codigo, modulo]) => `    (${lit(codigo)}, ${lit(modulo)})`);
  return [
    `-- ${pares.length} pares código → módulo de agrupación (HU #12716). Generado: no editar a mano.`,
    '-- Regenerar con: npm run permisos:seed -w apps/api -- --reagrupar',
    'UPDATE permisos_funciones AS f',
    '   SET modulo = v.modulo',
    '  FROM (VALUES',
    filas.join(',\n'),
    '  ) AS v(codigo, modulo)',
    ' WHERE f.codigo = v.codigo',
    '   AND f.modulo IS DISTINCT FROM v.modulo;',
  ].join('\n');
}

const modo = process.argv.includes('--reagrupar') ? reagrupar : seed;
process.stdout.write(modo() + '\n');
