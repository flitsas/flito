// FLITO comparendos — coherencia entre la clave de página y el rol que exige el router (HU #11559).
//
// El hecho «quién puede entrar a comparendos» está escrito en DOS sitios y en dos lenguajes: el
// catálogo de páginas de `packages/shared-types/src/permissions.ts`, que decide qué ve la interfaz,
// y las guardas `exigirFuncion('comparendos.…')` de cada ruta de `flito-comparendos.routes.ts` (con
// los roles de partida de la foto `inventario.generado.ts`, HU #12083), que deciden quién obtiene datos. Conceder la página a un rol que el router no admite no rompe nada al compilar: crea
// una pantalla que carga y responde 403 en cada petición, que es la peor de las dos opciones —peor
// incluso que no dársela— porque el usuario cree que el permiso está y el administrador también.
//
// Qué mutación se está cazando, y por qué el aserto obvio no basta. El test de AC1
// (`packages/shared-types/__tests__/comparendos-paginas.test.ts`) ya afirma que `auditor` no tiene
// el slug, y hace falta; pero es una LISTA DE EXCLUSIONES: el día que alguien haga «añadirle al
// auditor las vistas FLITO que faltan» se encontrará con un `not.toContain` sin contexto y lo
// borrará junto al cambio que lo rompió. Este test, en cambio, DERIVA el permiso del router: falla
// señalando el 403 concreto, y si algún día producto abre la lectura al auditor y se cambia el
// router PRIMERO, deja de bloquear solo, sin que nadie lo edite. Fija la regla, no el valor.
//
// Se comprueba sobre TODOS los roles y no solo sobre `auditor`, para que el próximo slug FLITO con
// router de rol único nazca protegido por la misma regla.
//
// Es análisis estático: no toca la base ni levanta Express. El router se lee de disco a propósito
// —importarlo arrastraría media API y sus efectos de arranque— y el catálogo se importa, que es
// donde vive de verdad.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';
import { llaveDe } from '../../src/modules/permisos/inventario-guardas.js';
import { fileURLToPath } from 'node:url';
import { USER_ROLES, getEffectivePages, type UserRole } from '@operaciones/shared-types';

const RUTA_ROUTER = fileURLToPath(
  new URL('../../src/modules/flito-comparendos/flito-comparendos.routes.ts', import.meta.url),
);
const RUTA_APP_TSX = fileURLToPath(new URL('../../../web/src/App.tsx', import.meta.url));
const RUTA_PAGINA = fileURLToPath(new URL('../../../web/src/pages/FlitoComparendos.tsx', import.meta.url));

const SLUG = 'flito_comparendos';

/**
 * Roles que el router del módulo admite: la unión de los roles de PARTIDA (foto) de los códigos que
 * cada ruta monta con `exigirFuncion('comparendos.…')` (HU #12083: la guarda va ruta a ruta, ya no
 * hay `router.use(requireRole(...))`). Si alguna ruta del fichero no llevara guarda, o montara un
 * código que la foto no conoce, la función devuelve `null` y el test falla pidiendo que alguien
 * mire por qué: perder una guarda es justo el cambio que no puede pasar callado.
 */
function rolesQueAdmiteElRouter(): UserRole[] | null {
  const fuente = readFileSync(RUTA_ROUTER, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const rutas = [...fuente.matchAll(/router\.(get|post|put|patch|delete)\(\s*'[^']*'\s*,\s*([\w.]+(?:\('[^']*'\))?)/g)];
  if (rutas.length === 0) return null;
  const codigoDeLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o.codigo]));
  const rolesPorCodigo = new Map(GUARDAS_MEDIDAS
    .filter((g) => g.fichero === 'flito-comparendos/flito-comparendos.routes.ts')
    .map((g) => [codigoDeLlave.get(llaveDe(g))!, g.roles]));
  const roles = new Set<UserRole>();
  for (const r of rutas) {
    const m = /^exigirFuncion\('(comparendos\.[a-z_]+\.[a-z_]+)'\)$/.exec(r[2]);
    if (!m || !rolesPorCodigo.has(m[1])) return null;
    for (const rol of rolesPorCodigo.get(m[1])!) roles.add(rol as UserRole);
  }
  return roles.size > 0 ? [...roles] : null;
}

describe('AC1/AC2 — la página de comparendos no se concede a quien el router rechaza', () => {
  it('cada ruta del router declara su guarda de función, con un código que la foto conoce', () => {
    expect(rolesQueAdmiteElRouter()).not.toBeNull();
  });

  it('todo rol con la página está entre los que el router admite', () => {
    const admitidos = new Set(rolesQueAdmiteElRouter() ?? []);
    const conLaPagina = USER_ROLES.filter((role) => getEffectivePages({ role }).includes(SLUG));

    // HU #12081 AC4: `admin` ya NO la tiene por comodín, así que este conjunto es hoy VACÍO y el
    // `toBeGreaterThan(0)` de antes ya no se sostiene. Lo que sigue valiendo —y es lo que este caso
    // protege— es que nadie que el router rechace la reciba. Quien se la da a `admin` es el reparto
    // sembrado, y su coherencia con el router se comprueba en `__tests__/db/migracion-0179.test.ts`.
    const incoherentes = conLaPagina.filter((role) => !admitidos.has(role));
    expect(
      incoherentes,
      `Estos roles reciben la página "${SLUG}" pero /flito/comparendos solo admite `
      + `[${[...admitidos].join(', ')}]: verían una pantalla que responde 403 en cada petición. `
      + 'Si el acceso se quiere abrir de verdad, se concede primero la función en el panel de permisos.',
    ).toEqual([]);
  });

  it('el catálogo no concede la página por defecto a ningún rol fuera del router', () => {
    // Complemento del anterior por el otro lado. Antes de la HU #12081 `admin` era el único que
    // salía aquí, por su comodín; retirado el comodín, el módulo puro no concede la página a NADIE
    // por defecto —que es lo correcto: la página es de `admin` y solo por reparto sembrado—.
    const porDefecto = USER_ROLES.filter((role) => getEffectivePages({ role }).includes(SLUG));
    expect(porDefecto).toEqual([]);
  });
});

describe('AC2/AC3 — cómo queda declarada la página en el web', () => {
  it('la ruta va con guarda de permiso y con lazy(), como el resto de App.tsx', () => {
    const app = readFileSync(RUTA_APP_TSX, 'utf8');

    // La guarda ENVUELVE al elemento. El elemento `lazy` se crea al evaluar el JSX, pero
    // `ProtectedRoute` devuelve `NoAccess` en su lugar y por tanto nunca lo monta; como
    // `React.lazy` dispara el `import()` en el montaje, sin permiso ni se descarga el chunk ni sale
    // una petición. Con la guarda DENTRO de la página —el patrón que provoca el fetch fugado del
    // AC2— este aserto se pone rojo.
    expect(app).toMatch(
      /<Route\s+path="\/flito\/comparendos"\s+element=\{<ProtectedRoute\s+page="flito_comparendos">/,
    );
    // Y la página no viaja en el chunk de /login.
    expect(app).toMatch(/const FlitoComparendos = lazy\(\(\) => import\('\.\/pages\/FlitoComparendos'\)\)/);
    expect(app).not.toMatch(/^import FlitoComparendos from/m);
  });

  it('el ítem de menú no duplica la regla de permiso con un campo `roles`', async () => {
    const { NAV_ITEMS } = await import('../../../web/src/components/shell/navItems');
    const item = NAV_ITEMS.find((it) => it.page === SLUG);

    expect(item).toBeDefined();
    expect(item?.to).toBe('/flito/comparendos');
    expect(item?.section).toBe('gestion');
    // `roles` restringe DENTRO de quienes ya tienen el slug. Aquí el slug ya es la regla entera:
    // repetirla crearía dos sitios que pueden divergir.
    expect(item?.roles).toBeUndefined();
  });

  it('ningún componente del módulo ramifica por rol: esta pantalla no tiene modo lectura', () => {
    // Quien entra puede todo lo que la pantalla ofrece —lo decide la guarda de la ruta, no un `if`
    // dentro de un componente—. Un condicional por rol aquí sería código muerto que un día miente.
    // El barrido incluye la página de hoy y la carpeta del módulo cuando la #11560 la cree.
    const fuentes = [RUTA_PAGINA, ...archivosDelModulo()];
    for (const ruta of fuentes) {
      const src = readFileSync(ruta, 'utf8');
      expect(src, `${ruta} ramifica por rol`).not.toMatch(/\brole\s*===|user\?\.role|puedeOperar\(/);
    }
  });
});

/** Los componentes de `apps/web/src/components/comparendos/`, si la carpeta ya existe (#11560). */
function archivosDelModulo(): string[] {
  const dir = fileURLToPath(new URL('../../../web/src/components/comparendos/', import.meta.url));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).map((f) => `${dir}${f}`);
}
