# Diseño slim — HU #11893 · contenedor Ayuda FLITO

Feature #11892. Sin backend. Esta HU no redacta las 18 fichas (HU 2/3).

## Patrón reutilizado

| Pieza | Path real | Qué se copia |
|---|---|---|
| Registro de página | `packages/shared-types/src/permissions.ts` (`PAGES` + comentario de `flito_comparendos`) | Slug nuevo en `PAGES`. **No** entra en `ROLE_DEFAULT_PAGES` ni en `PAGE_GROUPS` (a diferencia de comparendos: aquella SÍ se concede a mano; Ayuda no). `admin` lo obtiene solo por `Object.keys(PAGES)`. |
| Ruta lazy | `apps/web/src/App.tsx` (`ProtectedRoute` + `lazy()` + `Lazy`) | Misma cáscara. El **gate no es** `hasPage(user, 'flito_ayuda')` — ver permiso derivado. |
| Nav | `apps/web/src/components/shell/navItems.ts` + `useNavSections.ts` + `CommandPalette.tsx` | Ítem sin `roles:`. El filtro actual `allowed.has(it.page)` **no basta** (solo `admin` tendría el slug). Extraer un helper de visibilidad y usarlo en los dos filtros (hoy están duplicados). |
| Shell UI | `apps/web/src/components/flit/PageHeaderCard.tsx`, tokens de `navItems`/`flitPageKit` | Título en tarjeta, 4 estados, contraste del kit. |
| Test de catálogo | `packages/shared-types/__tests__/comparendos-paginas.test.ts` | Mismo estilo, asertos **invertidos** respecto a `PAGE_GROUPS`. |
| Skill | `.claude/skills/flit-intake/SKILL.md` (frontmatter `name`/`description` + cuerpo) | Solo la cáscara; el texto largo lo escribe frontend/hilo. |

**No** copiar `LaftManual` (PDF + API). **No** API, schema ni migraciones.

## Decisiones (una opción anclada)

### 1. Dónde viven los `.md`

`apps/web/src/content/ayuda/`. Vite (`apps/web/vite.config.ts`) solo resuelve fiable dentro de `apps/web/src`. `docs/ayuda/` exigiría `server.fs.allow` / alias frágil: se descarta.

- Plantilla AC6: `apps/web/src/content/ayuda/_plantilla.md` (prefijo `_` → no es ficha).
- Índice: `apps/web/src/content/ayuda/catalogo.ts` (TS explícito, no inferido del filesystem). Esta HU **no** crea los 18 `.md` de ficha.
- Carga: `import.meta.glob('../content/ayuda/*.md', { query: '?raw', import: 'default' })` (lazy, no eager). El catálogo nombra el archivo; el glob lo resuelve. Archivo ausente = estado vacío de esa ficha, no error de build.

### 2. Render sin XSS (sin dependencia nueva)

**Parser mínimo propio** → AST → React. **Cero** `dangerouslySetInnerHTML`. **Cero** DOMPurify / `react-markdown` / `marked`.

Subset (el de la plantilla): `h1`–`h3`, párrafos, listas `-`/`*` y `1.`, `**negrita**`, `` `código` ``, fences ` ``` `, enlaces `[texto](url)` solo si `url` cumple `^https?:\/\/` o `^\//`. HTML crudo del `.md` se pinta como **texto**. Sin imágenes, tablas ni HTML embebido en v1.

ADR: **no aplica** (no hay sanitizer ni HTML crudo).

### 3. Permiso del contenedor (derivado)

- `PageSlug` `flito_ayuda` → etiqueta `Ayuda FLITO`, ruta `/flito/ayuda`.
- **No** en `ROLE_DEFAULT_PAGES` (ninguna fila). **No** en `PAGE_GROUPS` → no aparece en el picker de `Users.tsx` (ese UI itera grupos, no `Object.keys(PAGES)`).
- Visibilidad menú / paleta / índice = `getEffectivePages(user) ∩ permisos del catálogo` no vacío.
- Gate de ruta: si la intersección es vacía → `<NoAccess page="flito_ayuda" />` (mismo rechazo que el resto). **Prohibido** `ProtectedRoute page="flito_ayuda"`: eso dejaría la pantalla solo a `admin`.
- Nav item **sin** `roles:` (`section: 'general'`).

**Excepción de catálogo:** `siigo_credenciales` **no** es `PageSlug` en este worktree (es tabla/servicio Siigo). En el catálogo de 18 fichas su `permiso` (clave para la intersección) es `siigo_parametrizacion`. No crear el slug `siigo_credenciales` en esta HU.

### 4. Skill (solo paths; no el texto)

Ver lista de archivos. El cuerpo de `SKILL.md` lo escribe frontend/hilo (AC7).

### 5. Sin backend

db-review: no aplica. security P5: copy / md in-app; el único riesgo es XSS del render (mitigado por AST→React).

## Contrato delta

| Contrato | Valor |
|---|---|
| Ruta | `/flito/ayuda` (opcional `/flito/ayuda/:ficha` con clave del catálogo, no PII) |
| `PageSlug` contenedor | `flito_ayuda` |
| Glob md | `apps/web/src/content/ayuda/*.md` vía `import.meta.glob` + `?raw` |
| Catálogo | 18 claves abajo; `permiso` = slug si existe en `PAGES`, si no el alias |

Claves del catálogo (rótulo visible = `PAGES[permiso]` salvo `siigo_credenciales` → rótulo propio «Credenciales Siigo»; grupo = el de `PAGE_GROUPS` o Finanzas):

`flito_tramites`, `soat`, `flito_impuestos`, `flito_derechos`, `flito_revisiones`, `flito_compuerta`, `flito_tablero`, `flito_bitacora`, `flito_logistica`, `flito_logistica_ruta`, `flito_comparendos`, `clients`, `flito_bolsas`, `flito_conciliacion`, `finanzas_reporte_costos`, `siigo_parametrizacion`, `siigo_operacion`, `siigo_credenciales`.

Deep-link a una ficha cuyo `permiso` el usuario no tiene: el contenedor sigue (si la intersección no es vacía) y esa ficha no se lista / estado vacío. No `fetch` suelto; no `api.ts`.

## Archivos a crear/modificar

**Crear**

- `apps/web/src/content/ayuda/catalogo.ts`
- `apps/web/src/content/ayuda/_plantilla.md`
- `apps/web/src/lib/ayudaMarkdown.ts` (parser AST puro)
- `apps/web/src/components/ayuda/AyudaMarkdown.tsx` (AST → React; sin innerHTML)
- `apps/web/src/pages/FlitoAyuda.tsx`
- `apps/web/e2e/tests/flito-ayuda.spec.ts`
- `packages/shared-types/__tests__/ayuda-paginas.test.ts`
- `.claude/skills/flit-ayuda-flito/SKILL.md`

**Modificar**

- `packages/shared-types/src/permissions.ts` — `PAGES.flito_ayuda`; comentario de que **no** va a grupos ni defaults
- `apps/web/src/App.tsx` — `lazy` + ruta + gate por intersección (helper, no `page="flito_ayuda"`)
- `apps/web/src/components/shell/navItems.ts` — ítem Ayuda, `section: 'general'`, sin `roles`
- `apps/web/src/components/shell/useNavSections.ts` y `CommandPalette.tsx` — mismo helper de visibilidad
- `apps/web/src/vite-env.d.ts` — `declare module '*.md?raw'`
- `AGENTS.md` — fila en «Equipo de agentes y skills» + fila en la matriz de invocación
- `.claude/skills/flit-modo-desarrollo-auto/SKILL.md` — bullet en la lista de ejecutores (paso 2c / orquestación)

**No tocar:** `apps/api/**`, `schema.ts`, `migrations/`, `ROLE_DEFAULT_PAGES` (ninguna fila), `PAGE_GROUPS`, `package.json` / lockfile.

## ADR: no aplica

No hay HTML crudo ni sanitizer nuevo. Si alguien reabriera DOMPurify + innerHTML, eso **sí** exigiría ADR en `Propuesto`.

## Notas operativas (frontend-agent)

1. **Permiso derivado.** Helper único, p.ej. `puedeVerAyuda(user)` = intersección `effectivePages` ∩ `CATALOGO_AYUDA[].permiso`. Usarlo en: gate de ruta, nav, paleta, lista de fichas. No usar `hasPage(..., 'flito_ayuda')` para dejar entrar.
2. **4 estados** en `FlitoAyuda` (AGENTS.md §9): cargando (Suspense + carga del `?raw`); error de import con **reintento**; vacío (ficha sin `.md` — el caso normal de esta HU — o catálogo filtrado sin artículos); lleno (índice + artículo). Copy de vacío ≠ copy de error.
3. **Datos.** Solo glob + catálogo. Prohibido `fetch` suelto y `api.ts`.
4. **XSS.** El renderer solo crea elementos React (`h1`, `p`, `ul`, `pre`, `a`, …). Aserto de code-review: cero `dangerouslySetInnerHTML` en estos paths. Enlaces `javascript:` / `data:` → no son `href`, se muestran como texto.
5. **a11y.** `<nav>` del índice con nombre; artículo con `aria-labelledby`; foco visible; contraste del kit.
6. **shared-types.** Tras añadir el slug, `grep` de `PageSlug` / `PAGES` en `apps/web` (regla 7). Test `ayuda-paginas.test.ts`: existe en `PAGES`; **ausente** de `PAGE_GROUPS` y de toda fila no-admin de `ROLE_DEFAULT_PAGES`; `admin` lo tiene por `Object.keys`.
7. **P1.** `npm run test:shared-types` (o el archivo de test nuevo) + `npm run typecheck -w apps/web` + E2E `flito-ayuda.spec.ts`. No glob de módulos API. Impl no muta.
8. **Skill.** Frontmatter + disparador (ficha de ayuda / actualizar Ayuda FLITO / `_plantilla.md`). No diseñar el manual largo aquí. Enganchar matriz + modo-auto como en la lista de archivos.
9. **Plantilla AC6.** Secciones en markdown: título, para qué sirve, quién la ve, flujo, errores frecuentes, fuera de alcance. La skill (HU 2/3) copia esa plantilla a `{slug}.md`.
10. **ux-agent.** Esta HU abre ruta + `PageSlug` nuevos; el umbral de matriz es ux **full** si no hay `docs/ux/` aún. El hilo lo declara; este slim no sustituye ese gate.
