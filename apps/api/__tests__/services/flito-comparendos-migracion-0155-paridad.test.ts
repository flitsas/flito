// FLITO comparendos — paridad entre la 0155 (grants de página) y el catálogo de permisos + el
// router del módulo (HU #11559).
//
// La 0155 hace UNA cosa: darle el slug `flito_comparendos` a los administradores que ya existían
// cuando llegó la pantalla. Es una línea de SQL, y precisamente por eso no la vigila nada más: no
// crea tablas (no hay `schema.ts` que contradecir), no la ejecuta ningún test de servicio y su
// efecto —un menú con una opción de más o de menos— no rompe ninguna petición.
//
// Qué mutación se está cazando. Las tres que dejan la migración VÁLIDA y la promesa ROTA:
//
//   · **El slug mal escrito.** `flito_comparendo`, `flito-comparendos`, `flito_comparendos `. El
//     `UPDATE` corre, reporta filas actualizadas y concede en silencio un permiso que no existe en
//     `PAGES`. No falla nada: simplemente la pantalla no aparece, y el fallo se descubre cuando
//     alguien la busca. Aquí el literal del `.sql` se compara contra las CLAVES de
//     `packages/shared-types/src/permissions.ts`, que es el catálogo real.
//
//   · **La página concedida a un rol que el backend rechaza.** El router de comparendos gatea
//     entero con `requireRole('admin')`: cualquier otro rol recibe 403 en TODAS sus rutas. Añadir
//     `auditor` al `UPDATE` —o a `ROLE_DEFAULT_PAGES`, que es el otro camino por el que se llega a
//     la misma página— no filtraría datos, pero pondría en su menú una pantalla que revienta al
//     abrirla. El rol permitido se lee del ROUTER, no se copia aquí: si mañana el módulo se abre a
//     otro rol, este test deja de exigir la exclusividad por sí solo.
//
//   · **La guarda de idempotencia borrada.** Sin `AND NOT (<slug> = ANY(allowed_pages))` la
//     migración sigue sin fallar en la segunda pasada... y reescribe la fila de todos los admin
//     cada vez (con `array_append`, además, duplicando el slug). El AC4 pide lo fuerte: que la
//     segunda pasada no cambie NADA. Y el `SET` debe seguir mencionando `allowed_pages`, porque una
//     asignación que no lo lea le borraría al admin sus permisos personalizados.
//
// No se solapa con `flito-comparendos-migracion-0154-paridad.test.ts`: aquella vigila FORMA
// (columnas, enum, FK) de otra migración; esta vigila DATOS y permisos de la 0155. Lo único que
// comparten es el guarda de ADR-DB-001, que se afirma por archivo.
//
// Análisis estático puro: NO toca la base. Si este test se pone rojo y el error está en la 0155 ya
// aplicada, lo que toca es una migración NUEVA (regla del repo: no se reescribe una aplicada).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAGES, ROLE_DEFAULT_PAGES, USER_ROLES } from '@operaciones/shared-types';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación. Importar
// `db-apply.ts` no conecta a nada: el cliente de postgres se abre en `main()`.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO_0155 = '0155_flito_comparendos_pages_grants.sql';
const SLUG = 'flito_comparendos';

const ruta = (relativa: string) => fileURLToPath(new URL(relativa, import.meta.url));

const RUTA_0155 = ruta(`../../src/db/migrations/${ARCHIVO_0155}`);
const RUTA_ROUTES = ruta('../../src/modules/flito-comparendos/flito-comparendos.routes.ts');

const sql0155 = readFileSync(RUTA_0155, 'utf8');
const routes = readFileSync(RUTA_ROUTES, 'utf8');

/**
 * Quita los comentarios `--` conservando los saltos de línea.
 *
 * Imprescindible y no cosmético: la cabecera de la 0155 nombra en prosa a `auditor`, a
 * `compliance`, a `array_agg`, a otras migraciones y al propio slug, justo para explicar POR QUÉ no
 * están en el código. Sin esta poda, la explicación de lo que la migración no hace se leería como
 * si lo hiciera.
 */
const codigo = sql0155.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

/** Sentencias reales del archivo (sin comentarios, sin vacías). */
const sentencias = codigo.split(';').map((s) => s.trim()).filter((s) => s.length > 0);

describe('0155 — grants de la página de comparendos', () => {
  describe('ADR-DB-001', () => {
    it('no declara control de transacción propio (el runner ya envuelve el archivo)', () => {
      expect(scanForTxControl(ARCHIVO_0155, sql0155)).toEqual([]);
    });
  });

  describe('el slug que se concede', () => {
    it('es una clave REAL del catálogo de páginas', () => {
      // Todo literal entrecomillado del código que parezca un slug de página se contrasta con
      // `PAGES`. Un typo (`flito_comparendo`) o un espacio de más caen aquí.
      const literales = [...codigo.matchAll(/'([a-z0-9_]+)'/g)]
        .map((m) => m[1])
        // Los nombres de rol son el otro tipo de literal del archivo; se comprueban aparte.
        .filter((l) => !(USER_ROLES as readonly string[]).includes(l));

      expect(literales.length, 'la 0155 debería conceder al menos un slug').toBeGreaterThan(0);
      for (const literal of literales) {
        expect(
          Object.keys(PAGES),
          `la 0155 concede '${literal}', que NO es una clave de PAGES: sería un permiso fantasma `
          + '(el UPDATE corre, nadie ve la pantalla)',
        ).toContain(literal);
      }
    });

    it('es exactamente el de esta HU y ningún otro', () => {
      const literales = new Set(
        [...codigo.matchAll(/'([a-z0-9_]+)'/g)]
          .map((m) => m[1])
          .filter((l) => !(USER_ROLES as readonly string[]).includes(l)),
      );
      expect([...literales]).toEqual([SLUG]);
    });
  });

  describe('a quién se le concede', () => {
    // El rol exigido no se copia: se lee del router, que es quien de verdad decide quién recibe
    // algo distinto de un 403.
    //
    // Se ancla en la forma de nivel de ROUTER —`router.use(requireRole(…))`—, igual que
    // `flito-comparendos-pagina-router.test.ts`, y no en cualquier `requireRole` suelto: un guard
    // puesto en una ruta concreta no dice nada sobre el módulo entero. Y se lee sobre el archivo
    // SIN comentarios, por la misma razón por la que se podan los del `.sql`: hoy este test caería
    // en rojo, sin causa real, ante un comentario tan plausible como
    // `// ojo: no usar requireRole('auditor') aquí`.
    const routesCodigo = routes
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    const guardDelRouter = routesCodigo.match(/router\.use\(\s*requireRole\(([^)]*)\)\s*\)/);
    const rolesDelRouter = guardDelRouter
      ? [...guardDelRouter[1].matchAll(/'([a-z_]+)'/g)].map((r) => r[1])
      : [];

    it('el router del módulo exige `admin` y solo `admin` (premisa del resto)', () => {
      // Si el guard de router desapareciera, `rolesDelRouter` sería `[]` y todo lo de abajo se
      // volvería vacuo: por eso se afirma que existe ANTES de usarlo como referencia.
      expect(guardDelRouter, 'el módulo perdió su `router.use(requireRole(...))`').not.toBeNull();
      expect(new Set(rolesDelRouter)).toEqual(new Set(['admin']));
    });

    it('la migración solo toca filas de los roles que el backend admite', () => {
      const rolesDelSql = new Set(
        [...codigo.matchAll(/'([a-z0-9_]+)'/g)]
          .map((m) => m[1])
          .filter((l) => (USER_ROLES as readonly string[]).includes(l)),
      );
      expect(rolesDelSql).toEqual(new Set(rolesDelRouter));
    });

    it('el predicado del rol es una IGUALDAD, no una negación ni un comodín', () => {
      // El conjunto de literales de rol no ve el OPERADOR, y ahí viven los dos peores mutantes
      // posibles: `WHERE role <> 'admin'` le da la página a TODOS LOS DEMÁS y a ningún admin, y
      // `WHERE (role = 'admin' OR true)` se la da a todo el mundo. Los dos dejan intacto el
      // conjunto {'admin'} y los dos sobrevivirían a la afirmación de arriba.
      expect(sentencias[0]).toMatch(/WHERE\s+role\s*=\s*'admin'/i);
      expect(sentencias[0]).not.toMatch(/role\s*(<>|!=)/i);
      // El comodín no se cuela por el operador sino por el `WHERE`: cualquier `OR` en el predicado
      // ensancha lo que el `UPDATE` alcanza. Este archivo no tiene ninguno y no debe tenerlo.
      const predicado = sentencias[0].slice(sentencias[0].search(/\bWHERE\b/i));
      expect(predicado).not.toMatch(/\bOR\b/i);
      expect(predicado).not.toMatch(/\btrue\b/i);
    });

    it('ningún rol recibe la página por `ROLE_DEFAULT_PAGES` salvo los que el backend admite', () => {
      // El otro camino a la misma pantalla. `admin` la tiene porque su fila es `Object.keys(PAGES)`.
      const conLaPagina = (Object.keys(ROLE_DEFAULT_PAGES) as (keyof typeof ROLE_DEFAULT_PAGES)[])
        .filter((rol) => (ROLE_DEFAULT_PAGES[rol] as readonly string[]).includes(SLUG));
      expect(new Set(conLaPagina)).toEqual(new Set(rolesDelRouter));
    });
  });

  describe('idempotencia fuerte (AC4: la segunda pasada no cambia ni una fila)', () => {
    it('es un único UPDATE sobre `users` y no hace DDL', () => {
      expect(sentencias).toHaveLength(1);
      expect(sentencias[0]).toMatch(/^UPDATE\s+users\b/i);
      expect(codigo).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|INSERT|GRANT|REVOKE)\b/i);
    });

    it('lleva la guarda que excluye a quien ya tiene la página', () => {
      // Sin esto la migración sería «no falla dos veces», que no es lo que pide el AC.
      const guarda = new RegExp(
        String.raw`NOT\s*\(\s*'${SLUG}'\s*=\s*ANY\s*\(`, 'i',
      );
      expect(sentencias[0]).toMatch(guarda);
    });

    it('el SET conserva las páginas que el usuario ya tenía', () => {
      // Un `SET allowed_pages = ARRAY['flito_comparendos']` cumpliría el AC de conceder y borraría
      // los permisos personalizados de cada admin.
      const set = sentencias[0].match(/SET\s+allowed_pages\s*=([\s\S]*?)\bWHERE\b/i);
      expect(set, 'no se encontró el SET de allowed_pages en la 0155').not.toBeNull();
      expect(set![1]).toMatch(/\ballowed_pages\b/);
    });

    it('el SET AÑADE al arreglo en vez de re-agregarlo entero', () => {
      // La distinción que ninguna de las afirmaciones de arriba ve, y que solo se nota con un
      // arreglo en orden NO alfabético: la forma de la 0131,
      // `array_agg(DISTINCT p) FROM unnest(allowed_pages || ARRAY[<slug>])`, también lleva guarda y
      // también conserva las páginas... pero reordena y deduplica LA FILA ENTERA de cada admin que
      // actualiza. Medido sobre `{users,dashboard,flito_tablero}`:
      //   array_append → {users,dashboard,flito_tablero,flito_comparendos}
      //   array_agg    → {dashboard,flito_comparendos,flito_tablero,users}
      // Ambas conceden el permiso; solo la primera deja el resto del dato como estaba. Es una
      // decisión, y está argumentada en la cabecera de la 0155 — si algún día se revierte a
      // conciencia, hay que borrar esta afirmación leyendo antes ese porqué.
      const set = sentencias[0].match(/SET\s+allowed_pages\s*=([\s\S]*?)\bWHERE\b/i)![1];
      expect(set).toMatch(/\barray_append\s*\(/i);
      expect(set).not.toMatch(/\b(array_agg|unnest|DISTINCT|ORDER\s+BY)\b/i);
    });
  });
});
