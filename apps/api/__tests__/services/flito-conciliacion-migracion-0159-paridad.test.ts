// FLITO Conciliación — paridad entre la 0159 (grants de página) y el catálogo de permisos + el
// router del módulo (HU #11680).
//
// La 0159 hace UNA cosa: darle el slug `flito_conciliacion` a los administradores que ya existían
// cuando llegó la pantalla (AC1: «sin intervención manual»). Es una línea de SQL, y precisamente
// por eso no la vigila nada más: no crea tablas (no hay `schema.ts` que contradecir), no la ejecuta
// ningún test de servicio y su efecto —un menú con una opción de más o de menos— no rompe ninguna
// petición. Calcado del guardián de la 0155, que cuida la misma clase de archivo.
//
// Qué mutación se está cazando. Las tres que dejan la migración VÁLIDA y la promesa ROTA:
//
//   · **El slug mal escrito.** `flito_conciliacio`, `flito-conciliacion`, `flito_conciliacion `. El
//     `UPDATE` corre, reporta filas actualizadas y concede en silencio un permiso que no existe en
//     `PAGES`. No falla nada: la pantalla simplemente no aparece, y el fallo se descubre cuando
//     alguien la busca. Aquí el literal del `.sql` se contrasta contra las CLAVES de
//     `packages/shared-types/src/permissions.ts`, que es el catálogo real.
//
//   · **La página concedida a un rol al que el backend le responde 403.** Las nueve rutas de
//     `/flito/conciliacion` llevan la misma constante, `requireRole('admin', 'financiera')` (CF-08).
//     Añadir `auditor` al `UPDATE` —o a `ROLE_DEFAULT_PAGES`, que es el otro camino a la misma
//     pantalla— no filtraría datos, pero le pondría en el menú una vista que revienta al abrirla.
//     Los roles permitidos se leen del ROUTER, no se copian aquí: si mañana el módulo se abre o se
//     cierra a un rol, este test sigue exigiendo que los dos caminos digan lo mismo.
//
//   · **La guarda de idempotencia borrada.** Sin `AND NOT (<slug> = ANY(allowed_pages))` la
//     migración sigue sin fallar en la segunda pasada... y con `array_append` DUPLICA el slug en la
//     fila de cada admin. Lo que se pide es lo fuerte: que la segunda pasada no cambie NADA. Y el
//     `SET` debe seguir leyendo `allowed_pages`, porque una asignación que no lo lea le borraría al
//     admin sus permisos personalizados.
//
// Análisis estático puro: NO toca la base. Si este test se pone rojo y el error está en una 0159 ya
// aplicada, lo que toca es una migración NUEVA (regla del repo: no se reescribe una aplicada).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAGES, ROLE_DEFAULT_PAGES, USER_ROLES } from '@operaciones/shared-types';
// El guarda de ADR-DB-001 tal como lo aplica el runner, no una reimplementación. Importar
// `db-apply.ts` no conecta a nada: el cliente de postgres se abre en `main()`.
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO_0159 = '0159_flito_conciliacion_pages_grants.sql';
const SLUG = 'flito_conciliacion';

const ruta = (relativa: string) => fileURLToPath(new URL(relativa, import.meta.url));

const sql0159 = readFileSync(ruta(`../../src/db/migrations/${ARCHIVO_0159}`), 'utf8');
const routes = readFileSync(
  ruta('../../src/modules/flito-conciliacion/flito-conciliacion.routes.ts'), 'utf8',
);

/**
 * Quita los comentarios `--` conservando los saltos de línea.
 *
 * Imprescindible y no cosmético: la cabecera de la 0159 nombra en prosa a `financiera`, a
 * `auditor`, a `array_agg` y al propio slug, justo para explicar POR QUÉ no están en el código. Sin
 * esta poda, la explicación de lo que la migración no hace se leería como si lo hiciera.
 */
const codigo = sql0159.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

/** Sentencias reales del archivo (sin comentarios, sin vacías). */
const sentencias = codigo.split(';').map((s) => s.trim()).filter((s) => s.length > 0);

/** Literales entrecomillados del SQL, partidos en «roles» y «lo demás» (que deben ser slugs). */
const literales = [...codigo.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
const esRol = (l: string) => (USER_ROLES as readonly string[]).includes(l);
const slugsDelSql = [...new Set(literales.filter((l) => !esRol(l)))];
const rolesDelSql = new Set(literales.filter(esRol));

// El router, sin comentarios: hoy este test caería en rojo, sin causa real, ante un comentario tan
// plausible como `// ojo: no usar requireRole('auditor') aquí`.
const routesCodigo = routes
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const guard = routesCodigo.match(/const\s+(\w+)\s*=\s*requireRole\(([^)]*)\)/);
const nombreGuard = guard?.[1];
const rolesDelRouter = guard ? [...guard[2].matchAll(/'([a-z_]+)'/g)].map((r) => r[1]) : [];

describe('0159 — grants de la página de conciliación', () => {
  describe('ADR-DB-001', () => {
    it('no declara control de transacción propio (el runner ya envuelve el archivo)', () => {
      expect(scanForTxControl(ARCHIVO_0159, sql0159)).toEqual([]);
    });
  });

  describe('el slug que se concede', () => {
    it('es una clave REAL del catálogo de páginas', () => {
      expect(slugsDelSql.length, 'la 0159 debería conceder al menos un slug').toBeGreaterThan(0);
      for (const literal of slugsDelSql) {
        expect(
          Object.keys(PAGES),
          `la 0159 concede '${literal}', que NO es una clave de PAGES: sería un permiso fantasma `
          + '(el UPDATE corre, nadie ve la pantalla)',
        ).toContain(literal);
      }
    });

    it('es exactamente el de esta HU y ningún otro', () => {
      expect(slugsDelSql).toEqual([SLUG]);
    });
  });

  describe('a quién se le concede', () => {
    it('el router del módulo exige `admin` y `financiera` (premisa del resto)', () => {
      // Si el guard desapareciera, `rolesDelRouter` sería `[]` y todo lo de abajo se volvería
      // vacuo: por eso se afirma que existe ANTES de usarlo como referencia.
      expect(guard, 'el módulo perdió su constante `requireRole(...)`').not.toBeNull();
      expect(new Set(rolesDelRouter)).toEqual(new Set(['admin', 'financiera']));
    });

    it('ninguna ruta del módulo se salta ese guard', () => {
      // Una constante de rol que solo se aplica a ocho de nueve rutas convierte la premisa de
      // arriba en una media verdad, y la novena en un agujero.
      const rutas = [...routesCodigo.matchAll(
        /router\.(get|post|put|patch|delete)\(\s*'[^']*'\s*,\s*(\w+)/g,
      )];
      expect(rutas.length, 'no se encontró ninguna ruta en el router').toBeGreaterThan(0);
      for (const r of rutas) {
        expect(r[2], `la ruta ${r[1].toUpperCase()} no arranca con ${nombreGuard}`)
          .toBe(nombreGuard);
      }
    });

    it('la migración solo toca filas de roles que el backend admite', () => {
      // Subconjunto, no igualdad (aquí se separa de la 0155): `financiera` recibe la página por
      // `ROLE_DEFAULT_PAGES`, y materializársela en `allowed_pages` la desataría del rol —quien
      // cambiara de rol se la llevaría puesta—. Ver la cabecera de la 0131, que zanjó esto.
      for (const rol of rolesDelSql) expect(rolesDelRouter).toContain(rol);
      expect(rolesDelSql, 'la 0159 debe escribir sobre algún rol').not.toEqual(new Set());
    });

    it('el predicado del rol es una IGUALDAD, no una negación ni un comodín', () => {
      // El conjunto de literales de rol no ve el OPERADOR, y ahí viven los dos peores mutantes
      // posibles: `WHERE role <> 'admin'` le da la página a TODOS LOS DEMÁS y a ningún admin, y
      // `WHERE (role = 'admin' OR true)` se la da a todo el mundo. Los dos dejan intacto el
      // conjunto {'admin'} y los dos sobrevivirían a la afirmación de arriba.
      expect(sentencias[0]).toMatch(/WHERE\s+role\s*=\s*'admin'/i);
      expect(sentencias[0]).not.toMatch(/role\s*(<>|!=)/i);
      const predicado = sentencias[0].slice(sentencias[0].search(/\bWHERE\b/i));
      expect(predicado).not.toMatch(/\bOR\b/i);
      expect(predicado).not.toMatch(/\btrue\b/i);
    });

    it('los dos caminos a la pantalla, juntos, dan exactamente los roles del router', () => {
      // `ROLE_DEFAULT_PAGES` es el otro camino. `admin` no aparece en su fila con el slug escrito a
      // mano —su fila es `Object.keys(PAGES)`, la página entra sola—, así que llega por el SQL;
      // `financiera` llega por su fila. Ni un rol de más (menú roto) ni uno de menos (pantalla
      // invisible para quien el backend sí atiende).
      const porDefaults = (Object.keys(ROLE_DEFAULT_PAGES) as (keyof typeof ROLE_DEFAULT_PAGES)[])
        .filter((rol) => rol !== 'admin')
        .filter((rol) => (ROLE_DEFAULT_PAGES[rol] as readonly string[]).includes(SLUG));
      expect(new Set([...porDefaults, ...rolesDelSql])).toEqual(new Set(rolesDelRouter));
    });

    it('`admin` la obtiene por tenerlas todas, sin escribirla en su fila', () => {
      expect(ROLE_DEFAULT_PAGES.admin).toContain(SLUG);
      expect(Object.keys(PAGES)).toEqual([...ROLE_DEFAULT_PAGES.admin]);
    });
  });

  describe('idempotencia fuerte (la segunda pasada no cambia ni una fila)', () => {
    it('es un único UPDATE sobre `users` y no hace DDL', () => {
      expect(sentencias).toHaveLength(1);
      expect(sentencias[0]).toMatch(/^UPDATE\s+users\b/i);
      expect(codigo).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|INSERT|GRANT|REVOKE)\b/i);
    });

    it('lleva la guarda que excluye a quien ya tiene la página', () => {
      // Sin esto la migración sería «no falla dos veces», que no es lo que se pide.
      expect(sentencias[0]).toMatch(new RegExp(String.raw`NOT\s*\(\s*'${SLUG}'\s*=\s*ANY\s*\(`, 'i'));
    });

    it('el SET conserva las páginas que el usuario ya tenía', () => {
      // Un `SET allowed_pages = ARRAY['flito_conciliacion']` cumpliría lo de conceder y borraría
      // los permisos personalizados de cada admin.
      const set = sentencias[0].match(/SET\s+allowed_pages\s*=([\s\S]*?)\bWHERE\b/i);
      expect(set, 'no se encontró el SET de allowed_pages en la 0159').not.toBeNull();
      expect(set![1]).toMatch(/\ballowed_pages\b/);
    });

    it('el SET AÑADE al arreglo en vez de re-agregarlo entero', () => {
      // La distinción que ninguna de las afirmaciones de arriba ve, y que solo se nota con un
      // arreglo en orden NO alfabético. Medido contra la base local sobre
      // `{users,dashboard,flito_tablero}`:
      //   array_append → {users,dashboard,flito_tablero,flito_conciliacion}
      //   array_agg    → {dashboard,flito_conciliacion,flito_tablero,users}  (la fila entera, otra)
      // Ambas conceden el permiso; solo la primera deja el resto del dato como estaba. Es una
      // decisión, está argumentada en la cabecera de la 0159 y viene de la 0155 — si algún día se
      // revierte a conciencia, hay que borrar esta afirmación leyendo antes ese porqué.
      const set = sentencias[0].match(/SET\s+allowed_pages\s*=([\s\S]*?)\bWHERE\b/i)![1];
      expect(set).toMatch(/\barray_append\s*\(/i);
      expect(set).not.toMatch(/\b(array_agg|unnest|DISTINCT|ORDER\s+BY)\b/i);
    });
  });
});
