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
//
// Desde la HU #12716 el `modulo` de cada función es el de AGRUPACIÓN (el que pinta la pantalla de
// permisos y nombra la bitácora del 403), aplicado con `catalogo-agrupacion.ts` DESPUÉS de construir
// cada mitad. El prefijo del código sigue siendo el módulo del FICHERO: esa comprobación se conserva.
import {
  ARBOL_ITEMS_Y_ACCIONES, ELEMENTOS_PERMISOS, PAGES, PAGE_GROUPS, PREFIJO_ACCION, PREFIJO_ELEMENTO, USER_ROLES, paginasPorDefecto,
  type NodoArbolDef, type PageSlug,
} from '@operaciones/shared-types';
import { llaveDe, type GuardaLeida } from './inventario-guardas.js';
// El SNAPSHOT y no el lector de fuentes: la imagen de producción no lleva los `.ts` (el Dockerfile
// copia `dist` y poco más), así que un `readFileSync` de una ruta `.routes.ts` reventaría en el
// contenedor. Que el snapshot siga siendo fiel a las guardas lo comprueba `permisos-catalogo.test.ts`,
// que sí relee los ficheros — en CI el árbol está y en el contenedor no hace falta.
import { GUARDAS_MEDIDAS } from './inventario.generado.js';
import { FUNCIONES_EXCLUSIVAS_ADMIN, OPERACIONES_DECLARADAS } from './catalogo-operaciones.js';
import { AGRUPACION_DE_OPERACION, AGRUPACION_DE_OPERACION_LEGADO, AGRUPACION_DE_PAGINA, moduloAgrupado } from './catalogo-agrupacion.js';
import {
  ACCIONES_ARBOL, ACCIONES_POR_ALGUNA, ACCIONES_UNIVERSALES, CODIGOS_ABSORBIDOS, claseDe, esUniversal, operacionesDe,
  PADRE, PADRES_DE_OPCIONAL, paginaDeAccion, PARTIDAS_DE_OPERACIONES_NUEVAS as PARTIDA_DE_OPERACION_NUEVA, predecesoresDe,
  ROL_CON_TODAS_LAS_ACCIONES,
} from './arbol/expansion.js';
import { ITEMS_LEGADO_OPS } from './arbol/acciones-legado.js';
import { ACCIONES_NACIDAS_TRAS_LA_SIEMBRA, OPERACIONES_NACIDAS_EN_EL_ARBOL } from './arbol/acciones-finanzas.js';
import { ITEMS_ADMINISTRACION_OPS } from './arbol/acciones-administracion.js';
import { NOMBRES_LEGADO } from './catalogo-operaciones.legado.js';

export interface FuncionCatalogo {
  codigo: string;
  modulo: string;
  nombreNegocio: string;
  descripcion: string;
  tipo: 'pagina' | 'operacion' | 'accion' | 'elemento';
  /** Roles a los que el estado de HOY concede esta función (CF-16). */
  roles: string[];
  /** HU #12873 (ADR-0025): los nodos del árbol y, desde la #13429, los opcionales (padre = su acción o ítem). */
  padre?: string;
  nivel?: number;
  orden?: number;
  /** HU #13944: solo `admin` la tiene y nadie se la asigna ni se la quita (`FUNCIONES_EXCLUSIVAS_ADMIN`). Ausente = no. */
  exclusivaAdmin?: true;
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

/**
 * El módulo ESTRUCTURAL de una página: su grupo de `PAGE_GROUPS`, normalizado. Es lo que conserva
 * una página sin acciones (`pagina.dashboard` → `general`); las demás lo cambian por el de sus
 * acciones vía `moduloAgrupado` (HU #12716). Exportado para que los tests midan las dos cuentas.
 */
export function moduloDeGrupo(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * HU #13588 — Páginas que nacen DESPUÉS del mundo plano (la 0240 siembra «Rendimiento»): no son de
 * `catalogoPlano()` (que sigue siendo exactamente lo sembrado por las migraciones ≤ 0231) y entran en
 * `catalogoCompleto()` como ítem del árbol.
 */
export const PAGINAS_NACIDAS_EN_EL_ARBOL: readonly PageSlug[] = ['admin_rendimiento'];

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
export function catalogoDePaginas(nacidasEnElArbol: 'fuera' | 'solo' = 'fuera'): FuncionCatalogo[] {
  const vistos = new Set<string>();
  const salida: FuncionCatalogo[] = [];
  for (const grupo of PAGE_GROUPS) {
    for (const slug of grupo.pages) {
      if (vistos.has(slug)) continue;
      vistos.add(slug);
      if (PAGINAS_NO_CONCEDIBLES.includes(slug)) continue;
      if (PAGINAS_NACIDAS_EN_EL_ARBOL.includes(slug) !== (nacidasEnElArbol === 'solo')) continue;
      const codigo = `pagina.${slug}`;
      salida.push({
        codigo,
        modulo: moduloAgrupado(codigo, moduloDeGrupo(grupo.label)),
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
  // Tiempo de SIEMBRA, no de petición: `admin` recibe en la siembra todo lo que exista; después es un
  // rol editable más (HU #13424, ADR-0022 §D1 — nada lo concede en runtime por su nombre). Los otros
  // once, lo que diga su fila. `paginasPorDefecto` y no la indexación directa: la tabla ya es parcial.
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
  // HU #13421 (ADR-0023): varias guardas pueden exigir el MISMO código (el transitorio «Administrar
  // <ítem>» cubre todas las rutas del ítem que hoy exigen rol). Se emite UNA función por código y se
  // exige IGUALDAD —no unión— de nombre, descripción, módulo y roles entre sus guardas: una unión
  // daría el permiso a quien solo pasaba alguna de las rutas (ganancia silenciosa, AC5).
  const porCodigo = new Map<string, { llave: string; f: FuncionCatalogo }>();

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
    const f: FuncionCatalogo = {
      codigo: decl.codigo,
      // El prefijo ya quedó comprobado contra `g.modulo` (estructural); lo que se guarda es el de
      // agrupación, que para 23 operaciones es otro (HU #12716).
      modulo: moduloAgrupado(decl.codigo, g.modulo),
      nombreNegocio: decl.nombre,
      descripcion: decl.descripcion,
      tipo: 'operacion',
      roles: g.roles,
    };
    const previa = porCodigo.get(decl.codigo);
    if (previa) {
      const firma = (x: FuncionCatalogo) => JSON.stringify([x.modulo, x.nombreNegocio, x.descripcion, [...x.roles].sort()]);
      if (firma(previa.f) !== firma(f)) {
        throw new CatalogoIncoherenteError(
          `El código «${decl.codigo}» lo exigen guardas con distinto nombre o reparto: ${previa.llave} ` +
          `[${previa.f.roles.join(',')}] y ${llave} [${f.roles.join(',')}]. Un código, un reparto.`,
        );
      }
      continue;
    }
    porCodigo.set(decl.codigo, { llave, f });
    salida.push(f);
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
 * El catálogo PLANO (páginas + operaciones, el de antes del árbol). Falla si dos funciones comparten código: la PK lo rechazaría igual, pero aquí
 * el error dice CUÁL, y no «duplicate key value violates unique constraint» a mitad del seed.
 */
export function catalogoPlano(guardas?: GuardaLeida[]): FuncionCatalogo[] {
  const todas = [...catalogoDePaginas(), ...aCodigoDePartida(catalogoDeOperaciones(guardas))];
  const cuenta = new Map<string, number>();
  for (const f of todas) cuenta.set(f.codigo, (cuenta.get(f.codigo) ?? 0) + 1);
  const repetidos = [...cuenta.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  if (repetidos.length) {
    throw new CatalogoIncoherenteError(`Códigos de función repetidos: ${repetidos.join(', ')}.`);
  }
  // HU #12716: toda clave de los mapas de agrupación debe existir en el catálogo. Una entrada muerta
  // (código retirado o mal escrito) no se ignora: sería una reagrupación que la 0205 escribe sobre
  // nada y un mapa que miente sobre lo que agrupa.
  const declaradas = [
    ...Object.keys(AGRUPACION_DE_PAGINA).map((slug) => `pagina.${slug}`),
    ...Object.keys(AGRUPACION_DE_OPERACION),
    ...Object.keys(AGRUPACION_DE_OPERACION_LEGADO),
  ];
  const muertas = declaradas.filter((c) => !cuenta.has(c));
  if (muertas.length) {
    throw new CatalogoIncoherenteError(
      `Agrupación declarada para un código que no existe: ${muertas.join(', ')}. ` +
      'Se corrige en apps/api/src/modules/permisos/catalogo-agrupacion.ts.',
    );
  }
  return todas.sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/**
 * HU #13427 (diseño §5-bis.1) — El mundo PLANO no conoció las operaciones nuevas que parten una guarda
 * vieja (`finanzas.reporte_costos.exportar`, las de `siigo.parametrizacion.administrar`…): se leen con su
 * código de PARTIDA (mismo reparto de la foto) y las de página (`finanzas.gastos_diarios.ver`) no se leen.
 * Así `catalogoPlano()` sigue siendo exactamente lo que sembraron las migraciones ≤ 0231.
 */
function aCodigoDePartida(operaciones: FuncionCatalogo[]): FuncionCatalogo[] {
  const salida = new Map<string, FuncionCatalogo>();
  // HU #13428: una partida que SIGUE teniendo guarda propia (`parametrizacion.companias.editar`, partida de
  // `[autogestion]` y `[sinTramite]`) se lee de esa guarda; las nuevas solo comprueban que el reparto cuadre.
  const vivas = new Map(operaciones.filter((f) => !(f.codigo in PARTIDA_DE_OPERACION_NUEVA)).map((f) => [f.codigo, f]));
  for (const f of [...operaciones].sort((a, b) => Number(a.codigo in PARTIDA_DE_OPERACION_NUEVA) - Number(b.codigo in PARTIDA_DE_OPERACION_NUEVA))) {
    const partida = PARTIDA_DE_OPERACION_NUEVA[f.codigo];
    if (partida?.startsWith('pagina.')) continue;
    if (OPERACIONES_NACIDAS_EN_EL_ARBOL.has(f.codigo)) continue; // HU #13889: sin partida, no existieron en el plano
    const viva = partida ? vivas.get(partida) : undefined;
    const g = !partida ? f : viva ? { ...viva, roles: f.roles } : deOperacionLegado(partida, f.roles);
    const previa = salida.get(g.codigo);
    if (previa && [...previa.roles].sort().join() !== [...g.roles].sort().join()) {
      throw new CatalogoIncoherenteError(`«${f.codigo}» parte «${g.codigo}» con otro reparto: [${f.roles.join(',')}] frente a [${previa.roles.join(',')}].`);
    }
    if (!previa) salida.set(g.codigo, g);
  }
  return [...salida.values()];
}

function deOperacionLegado(codigo: string, roles: string[]): FuncionCatalogo {
  const n = NOMBRES_LEGADO[codigo];
  if (!n) throw new CatalogoIncoherenteError(`Código de partida sin nombre en NOMBRES_LEGADO: ${codigo}`);
  return { codigo, modulo: moduloAgrupado(codigo, codigo.split('.')[0]!), nombreNegocio: n.nombre, descripcion: n.descripcion, tipo: 'operacion', roles };
}

/**
 * HU #13427 — Las operaciones nuevas tal como las exigen las guardas de hoy: nacen absorbidas (no se
 * conceden directo ni se siembran), pero el 403 y la expansión las conocen. `modulo` = el de su partida.
 */
export function catalogoOperacionesNuevas(guardas?: GuardaLeida[]): FuncionCatalogo[] {
  const plano = new Map(catalogoPlano(guardas).map((f) => [f.codigo, f]));
  return catalogoDeOperaciones(guardas)
    .filter((f) => f.codigo in PARTIDA_DE_OPERACION_NUEVA || OPERACIONES_NACIDAS_EN_EL_ARBOL.has(f.codigo))
    .map((f) => ({ ...f, modulo: plano.get(PARTIDA_DE_OPERACION_NUEVA[f.codigo] ?? '')?.modulo ?? f.modulo }));
}

/** Los nodos de acción del árbol (shared-types), en el orden del árbol. */
const NODOS_ACCION: readonly NodoArbolDef[] = ARBOL_ITEMS_Y_ACCIONES.filter((n) => n.tipo === 'accion');

/**
 * HU #12873 (ADR-0025) — Las acciones (nivel 3) como funciones del catálogo. `modulo` = el de la página
 * de su ítem (así el panel plano las pinta junto a ella hasta la #13430); `roles` = la regla «todos»
 * sobre los roles de partida de su grupo, la misma que aplica la 0233 sobre la base.
 */
export function catalogoDeAcciones(plano: FuncionCatalogo[] = catalogoPlano()): FuncionCatalogo[] {
  const porCodigo = new Map(plano.map((f) => [f.codigo, f]));
  const nuevas = new Set([...Object.keys(PARTIDA_DE_OPERACION_NUEVA), ...OPERACIONES_NACIDAS_EN_EL_ARBOL]);
  const nodos = new Map(ARBOL_ITEMS_Y_ACCIONES.map((n) => [n.codigo, n]));
  const enArbol = new Set(NODOS_ACCION.map((n) => n.codigo));
  const errores: string[] = [];
  for (const a of Object.keys(ACCIONES_ARBOL)) if (!enArbol.has(a)) errores.push(`acción sin nodo en el árbol: ${a}`);
  for (const a of enArbol) if (!(a in ACCIONES_ARBOL)) errores.push(`nodo de acción sin operaciones: ${a}`);
  for (const a of Object.keys(ACCIONES_ARBOL)) {
    // HU #13889: una acción nacida tras la siembra no tiene predecesores (nadie la tenía): solo la recibe `admin`.
    if (predecesoresDe(a).length === 0 && !esUniversal(a) && !ACCIONES_NACIDAS_TRAS_LA_SIEMBRA.has(a)) errores.push(`acción sin operaciones: ${a}`);
    for (const op of operacionesDe(a)) if (!porCodigo.has(op) && !nuevas.has(op)) errores.push(`${a} concede un código inexistente: ${op}`);
    for (const p of predecesoresDe(a)) if (!porCodigo.has(p)) errores.push(`${a} tiene un predecesor que el mundo plano no conoce: ${p}`);
    for (const op of ACCIONES_ARBOL[a]!.opcionales ?? []) {
      if (!porCodigo.has(op)) errores.push(`${a} declara un opcional inexistente: ${op}`);
      if (CODIGOS_ABSORBIDOS.has(op)) errores.push(`${a} declara opcional un código que otra acción absorbe: ${op}`);
    }
  }
  for (const f of plano) {
    if (f.codigo.startsWith(PREFIJO_ACCION) || f.codigo.startsWith(PREFIJO_ELEMENTO)) errores.push(`operación con prefijo de nodo: ${f.codigo}`);
  }
  if (errores.length) throw new CatalogoIncoherenteError(`El árbol de permisos y el catálogo no coinciden:\n  ${errores.join('\n  ')}`);

  const item = (n: NodoArbolDef): NodoArbolDef => (n.tipo === 'item' ? n : item(nodos.get(n.padre!)!));
  return NODOS_ACCION.map((n) => {
    const pagina = porCodigo.get(item(n).codigo)!;
    const grupos = predecesoresDe(n.codigo).map((p) => porCodigo.get(p)!.roles);
    return {
      codigo: n.codigo,
      modulo: pagina.modulo,
      nombreNegocio: n.nombre,
      descripcion: n.descripcion ?? n.nombre,
      tipo: 'accion' as const,
      // La regla del paso (`cumpleGrupo`) sobre los roles de partida: de lectura → unión; si modifica → intersección.
      // HU #13428 (P-22): la de reparto universal, a todos los roles. HU #13429 (A1): `alguna` también es
      // unión, y `exigeItem` la deja solo a quien ya tiene la página del ítem.
      roles: [...new Set([
        ...(esUniversal(n.codigo) ? USER_ROLES
          : ACCIONES_POR_ALGUNA.has(n.codigo) ? grupos.flat() : (grupos[0] ?? []).filter((r) => grupos.every((g) => g.includes(r))))
          .filter((r) => !ACCIONES_ARBOL[n.codigo]!.exigeItem || pagina.roles.includes(r)),
        ROL_CON_TODAS_LAS_ACCIONES,
      ])].sort(),
      padre: n.padre!,
      nivel: 3,
      orden: n.orden,
    };
  });
}

/** Los ítems del árbol (FLITO y antiguos) con su nodo: padre (`menu.*`) y orden. */
const ITEMS_ARBOL = new Map(ARBOL_ITEMS_Y_ACCIONES.filter((n) => n.tipo === 'item').map((n) => [n.codigo, n]));

/**
 * HU #13429 — Las operaciones que expande algún ítem antiguo → esos ítems (orden alfabético; el primero es el de
 * paso). HU #13588: también «Rendimiento» (Administración), que concede `rum.resumen.ver` sin nivel 3.
 */
const ITEMS_DE_OPERACION_LEGADA: ReadonlyMap<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  const poner = (op: string, item: string) => m.set(op, [...(m.get(op) ?? []), item].sort());
  for (const [item, i] of Object.entries(ITEMS_LEGADO_OPS)) for (const op of i.operaciones) poner(op, item);
  // HU #13588 (AC8): quien tenía `rum.resumen.ver` recibe «Rendimiento». Las 4 de ítems antiguos NO dan el ítem a
  // quien las tenía sin él: es la pérdida declarada (AC3, AC7) — la 0240 solo borra sus filas.
  for (const [item, i] of Object.entries(ITEMS_ADMINISTRACION_OPS)) for (const op of i.operaciones) poner(op, item);
  return m;
})();

/**
 * El catálogo entero: el plano MENOS lo que absorbió el árbol (operaciones de acciones y de ítems antiguos,
 * y las páginas que absorbe una acción) MÁS las acciones y, desde la #13429, los elementos `menu.*`. Es lo
 * que la base debe tener (arranque, AC9) y lo que siembran las migraciones.
 *
 * HU #13429 (§5-quater.6) — el reparto que deja la 0239: (1) el rol con una operación de ítem antiguo sin el
 * ítem recibe el ítem; (2) el rol con una acción recibe la página de su ítem; (3) el rol con algún ítem recibe
 * el elemento (`menu.*`, incluido `menu.perfil` a todos). Toda página es ítem y toda operación viva es opcional
 * (de su acción o ítem; desde la #13588 no hay transversales): lo contrario es `CatalogoIncoherenteError` (una página que no esté en
 * el árbol nacería muerta en silencio).
 */
export function catalogoCompleto(guardas?: GuardaLeida[]): FuncionCatalogo[] {
  const plano = [...catalogoPlano(guardas), ...catalogoDePaginas('solo')]; // HU #13588: + «Rendimiento»
  const acciones = catalogoDeAcciones(plano);
  // HU #13428 (P-22): la página de una acción de reparto universal (`pagina.perfil`) viaja con ella a todos los roles.
  const universales = new Set(ACCIONES_UNIVERSALES.map((u) => u.pagina));
  const vivas = plano.filter((f) => !CODIGOS_ABSORBIDOS.has(f.codigo));
  const errores: string[] = [];
  const rolesPorCodigo = new Map<string, Set<string>>();
  for (const f of vivas) if (f.tipo === 'pagina') rolesPorCodigo.set(f.codigo, new Set(universales.has(f.codigo) ? USER_ROLES : f.roles));
  for (const f of plano) {
    const items = ITEMS_DE_OPERACION_LEGADA.get(f.codigo);
    if (!items) continue;
    for (const r of f.roles) if (!items.some((i) => rolesPorCodigo.get(i)?.has(r))) rolesPorCodigo.get(items[0]!)?.add(r);
  }
  for (const a of acciones) for (const r of a.roles) rolesPorCodigo.get(paginaDeAccion(a.codigo))?.add(r);

  const salida: FuncionCatalogo[] = [...acciones];
  for (const f of vivas) {
    if (f.tipo === 'pagina') {
      const nodo = ITEMS_ARBOL.get(f.codigo);
      if (!nodo) { errores.push(`página sin ítem en el árbol: ${f.codigo}`); continue; }
      salida.push({ ...f, roles: [...rolesPorCodigo.get(f.codigo)!].sort(), padre: nodo.padre!, nivel: 2, orden: nodo.orden });
      continue;
    }
    const clase = claseDe(f.codigo);
    if (clase === 'opcional') salida.push({ ...f, padre: PADRES_DE_OPCIONAL.get(f.codigo)![0]! });
    else errores.push(`operación viva sin clase (ni nodo del menú ni opcional de un ítem o acción): ${f.codigo}`);
  }
  for (const e of ELEMENTOS_PERMISOS.filter((x) => !x.derivado)) {
    const roles = new Set<string>();
    for (const [pagina, rs] of rolesPorCodigo) if (PADRE.get(pagina) === e.codigo) for (const r of rs) roles.add(r);
    salida.push({
      codigo: e.codigo, modulo: e.codigo.slice(PREFIJO_ELEMENTO.length), nombreNegocio: e.nombre,
      descripcion: `Ver la sección «${e.nombre}» del menú.`, tipo: 'elemento', roles: [...roles].sort(), nivel: 1, orden: e.orden,
    });
  }
  if (errores.length) throw new CatalogoIncoherenteError(`El árbol de permisos y el catálogo no coinciden:\n  ${errores.join('\n  ')}`);
  return marcarExclusivasAdmin(salida).sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/**
 * HU #13944 — marca `exclusivaAdmin` en las funciones de `FUNCIONES_EXCLUSIVAS_ADMIN`. Una exclusiva que no está en el
 * catálogo, o cuyo reparto de partida no es exactamente `['admin']`, es `CatalogoIncoherenteError`: sembrarla en otro
 * rol contradiría la marca desde el primer día.
 */
function marcarExclusivasAdmin(salida: FuncionCatalogo[]): FuncionCatalogo[] {
  const exclusivas = new Set(FUNCIONES_EXCLUSIVAS_ADMIN);
  if (exclusivas.size === 0) return salida;
  const porCodigo = new Map(salida.map((f) => [f.codigo, f]));
  const errores: string[] = [];
  for (const c of exclusivas) {
    const f = porCodigo.get(c);
    if (!f) errores.push(`exclusiva del Administrador que no está en el catálogo: ${c}`);
    else if (f.roles.length !== 1 || f.roles[0] !== 'admin') errores.push(`exclusiva del Administrador con reparto [${f.roles.join(',')}] (debe ser [admin]): ${c}`);
  }
  if (errores.length) throw new CatalogoIncoherenteError(`Funciones exclusivas del Administrador incoherentes:\n  ${errores.join('\n  ')}`);
  return salida.map((f) => (exclusivas.has(f.codigo) ? { ...f, exclusivaAdmin: true as const } : f));
}

/** El reparto rol × función que se siembra: `[rol, codigo]` ordenado y sin repetir. */
export function repartoDePartida(catalogo = catalogoCompleto()): [string, string][] {
  const pares: [string, string][] = [];
  for (const f of catalogo) for (const rol of f.roles) pares.push([rol, f.codigo]);
  return pares.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}
