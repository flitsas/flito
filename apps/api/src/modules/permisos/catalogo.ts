// HU #12081 — El catálogo de funciones y el reparto de partida, construidos desde el código.
//
// Aquí se juntan las dos mitades:
//   · las PÁGINAS salen de `PAGES` / `PAGE_GROUPS` / `ROLE_DEFAULT_PAGES` (shared-types);
//   · las OPERACIONES salen de cruzar el lector de guardas (`inventario-guardas.ts`, que aporta los
//     roles) con la tabla de nombres del producto (`catalogo-operaciones.ts`).
//
// Nada de esto se teclea dos veces: el seed de la migración 0179 es la SALIDA de este módulo
// (`npm run permisos:seed -w apps/api`), y la comprobación de arranque del AC6 vuelve a construirlo
// para compararlo con lo que hay en la base.
import { PAGES, PAGE_GROUPS, USER_ROLES, paginasPorDefecto, type PageSlug } from '@operaciones/shared-types';
import { llaveDe, type GuardaLeida } from './inventario-guardas.js';
// El SNAPSHOT y no el lector de fuentes: la imagen de producción no lleva los `.ts` (el Dockerfile
// copia `dist` y poco más), así que un `readFileSync` de una ruta `.routes.ts` reventaría en el
// contenedor. Que el snapshot siga siendo fiel a las guardas lo comprueba `permisos-catalogo.test.ts`,
// que sí relee los ficheros — en CI el árbol está y en el contenedor no hace falta.
import { GUARDAS_MEDIDAS } from './inventario.generado.js';
import { OPERACIONES_DECLARADAS } from './catalogo-operaciones.js';

export interface FuncionCatalogo {
  codigo: string;
  modulo: string;
  nombreNegocio: string;
  descripcion: string;
  tipo: 'pagina' | 'operacion';
  /** Roles a los que el estado de HOY concede esta función (CF-16). */
  roles: string[];
}

/**
 * El slug que NO entra al catálogo, y por qué (AC2-bis).
 *
 * `flito_ayuda` existe SOLO para la etiqueta de `NoAccess` y el ítem de menú: su visibilidad es
 * DERIVADA (`puedeVerAyudaFlito` = ≥1 slug del catálogo de fichas), y ni el gate de ruta
 * (`App.tsx`) ni el del menú (`navItems.ts:51`) usan `hasPage('flito_ayuda')` — medido el 9/09/2026.
 * Concederla a mano no habilita nada, así que sembrarla sería una casilla que miente en la pantalla
 * de permisos. Por eso NO está en `PAGE_GROUPS` desde la HU #11893, y por eso tampoco entra aquí.
 *
 * Esto NO es «un defecto del catálogo de origen» —el enunciado de esta HU lo decía y se corrigió el
 * 9/09/2026—: es una decisión escrita en `permissions.ts`, encima de su declaración.
 */
export const PAGINAS_NO_CONCEDIBLES: readonly PageSlug[] = ['flito_ayuda'];

/** El módulo con el que se agrupa cada página: su grupo de `PAGE_GROUPS`, normalizado. */
function moduloDeGrupo(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Las funciones de tipo `pagina`: una por slug CONCEDIBLE, con el label de `PAGES` como nombre.
 *
 * Se recorre `PAGE_GROUPS` y NO `PAGES` porque el grupo es lo que da el `modulo`. Ese recorrido tiene
 * una trampa medida el 8/09/2026: `PAGE_GROUPS` trae 44 entradas para 43 slugs únicos porque
 * `transito` aparece en «Operaciones» y otra vez en «Tránsito». Un recorrido ingenuo crearía dos
 * funciones con el mismo código —y la PK lo rechazaría a mitad del seed—, así que la primera
 * aparición gana y la segunda se ignora. Se queda con «Operaciones» por ser donde el slug vive junto
 * a los demás de la bandeja diaria; la elección solo afecta a cómo se agrupa en pantalla.
 */
export function catalogoDePaginas(): FuncionCatalogo[] {
  const vistos = new Set<string>();
  const salida: FuncionCatalogo[] = [];
  for (const grupo of PAGE_GROUPS) {
    for (const slug of grupo.pages) {
      if (vistos.has(slug)) continue;
      vistos.add(slug);
      if (PAGINAS_NO_CONCEDIBLES.includes(slug)) continue;
      salida.push({
        codigo: `pagina.${slug}`,
        modulo: moduloDeGrupo(grupo.label),
        nombreNegocio: PAGES[slug],
        descripcion: `Entrar a la pantalla «${PAGES[slug]}».`,
        tipo: 'pagina',
        // Los roles del producto que hoy conceden el slug por defecto. `admin` YA NO sale de un
        // comodín: desde esta HU no tiene fila en ROLE_DEFAULT_PAGES y recibe todas las páginas
        // concedibles una a una, que es justo lo que sostiene CF-13/RN-A1.
        roles: rolesQueConcedenLaPagina(slug),
      });
    }
  }
  return salida;
}

/** Los roles de sistema a los que hoy corresponde este slug. */
function rolesQueConcedenLaPagina(slug: PageSlug): string[] {
  // `admin` los recibe todos: es la materialización del comodín que esta HU retira. Los otros once,
  // lo que diga su fila. `paginasPorDefecto` y no la indexación directa: la tabla ya es parcial.
  return USER_ROLES.filter((rol) => rol === 'admin' || paginasPorDefecto(rol).includes(slug)).slice();
}

export class CatalogoIncoherenteError extends Error {}

/**
 * Las funciones de tipo `operacion`: el cruce del lector de guardas con la tabla de nombres.
 *
 * Las dos comprobaciones de este cruce SON el AC6 en su forma más temprana —antes de arrancar el API
 * y antes de sembrar—: una guarda sin nombre declarado es una operación que el catálogo no declara, y
 * un nombre sin guarda viva es una función que ninguna guarda usa. Las dos revientan aquí.
 */
export function catalogoDeOperaciones(guardas: GuardaLeida[] = GUARDAS_MEDIDAS): FuncionCatalogo[] {
  const declaradas = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o]));
  const usadas = new Set<string>();
  const salida: FuncionCatalogo[] = [];
  const sinNombre: string[] = [];

  for (const g of guardas) {
    const llave = llaveDe(g);
    const decl = declaradas.get(llave);
    if (!decl) { sinNombre.push(llave); continue; }
    usadas.add(llave);
    if (!decl.codigo.startsWith(`${g.modulo}.`)) {
      throw new CatalogoIncoherenteError(
        `El código «${decl.codigo}» no empieza por el módulo «${g.modulo}» de ${llave}.`,
      );
    }
    salida.push({
      codigo: decl.codigo,
      modulo: g.modulo,
      nombreNegocio: decl.nombre,
      descripcion: decl.descripcion,
      tipo: 'operacion',
      roles: g.roles,
    });
  }

  const huerfanas = OPERACIONES_DECLARADAS.filter((o) => !usadas.has(o.llave)).map((o) => o.llave);
  if (sinNombre.length || huerfanas.length) {
    throw new CatalogoIncoherenteError(
      'El catálogo de funciones y las guardas del código no coinciden.\n' +
      (sinNombre.length ? `  Guardas SIN función declarada (${sinNombre.length}):\n    ${sinNombre.join('\n    ')}\n` : '') +
      (huerfanas.length ? `  Funciones declaradas SIN guarda viva (${huerfanas.length}):\n    ${huerfanas.join('\n    ')}\n` : '') +
      '  Se declaran en apps/api/src/modules/permisos/catalogo-operaciones.ts.',
    );
  }
  return salida;
}

/**
 * El catálogo entero. Falla si dos funciones comparten código: la PK lo rechazaría igual, pero aquí
 * el error dice CUÁL, y no «duplicate key value violates unique constraint» a mitad del seed.
 */
export function catalogoCompleto(guardas?: GuardaLeida[]): FuncionCatalogo[] {
  const todas = [...catalogoDePaginas(), ...catalogoDeOperaciones(guardas)];
  const cuenta = new Map<string, number>();
  for (const f of todas) cuenta.set(f.codigo, (cuenta.get(f.codigo) ?? 0) + 1);
  const repetidos = [...cuenta.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  if (repetidos.length) {
    throw new CatalogoIncoherenteError(`Códigos de función repetidos: ${repetidos.join(', ')}.`);
  }
  return todas.sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/** El reparto rol × función que se siembra: `[rol, codigo]` ordenado y sin repetir. */
export function repartoDePartida(catalogo = catalogoCompleto()): [string, string][] {
  const pares: [string, string][] = [];
  for (const f of catalogo) for (const rol of f.roles) pares.push([rol, f.codigo]);
  return pares.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}
