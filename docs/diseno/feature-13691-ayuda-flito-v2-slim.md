# Diseño slim: Feature #13691, Ayuda FLITO v2

> **Modo:** slim. Extiende la Ayuda que ya existe (HU #11893, #11901, #13431). Todo es `apps/web`: no hay backend, esquema, migración ni cambio en `packages/shared-types`.
> **Entrada:** `docs/ado-drafts/epic-12756-12757/HUS-F1-13691.md` (HU-1 a HU-5 y las decisiones P9-1a, P9-2c, P9-3a y P9-4a).
> **Habla con:** el módulo de Ayuda FLITO del web (`/flito/ayuda`). No toca ningún módulo legacy.
> **Estado:** Propuesto. Lo aprueba el Líder Técnico humano.

## Patrón reutilizado

- **Parser propio sin dependencias:** `apps/web/src/lib/ayudaMarkdown.ts`, que produce un AST y lo pinta con elementos React, sin `dangerouslySetInnerHTML`. El encabezado, los callouts, las anclas y las imágenes se suman a este parser. **No se añade** `gray-matter`, `js-yaml`, `remark` ni Mermaid.
- **Carga diferida con glob:** `apps/web/src/content/ayuda/cargarFichas.ts`. Es el **único** archivo que usa `import.meta.glob`.
- **Visibilidad por `permiso` (PageSlug) de cada entrada del catálogo:** `apps/web/src/lib/ayudaFlito.ts` (`puedeVerEntradaAyuda`).
- **Spec Playwright que importa código de `src` y lee archivos con `fs`:** `e2e/tests/flito-ayuda-artefactos.spec.ts` (`fs`) y `e2e/tests/permisos-arbol.spec.ts` (`import … from '../../src/…'`).

**Regla transversal del diseño.** `ayudaFicha.ts`, `ayudaBusqueda.ts`, la parte de anclas de `ayudaMarkdown.ts` y `catalogo.ts` son **TypeScript puro**:
- sin React;
- sin `import.meta.*`;
- sin DOM;
- sin imports de runtime de `src/` (solo `import type`).

Así los importa Playwright en Node, y en el futuro F3. Solo `cargarFichas.ts` y los componentes conocen Vite y React.

---

## 1. Encabezado de ficha y parser

**Formato.** Un bloque delimitado por `---` en la **primera línea** del `.md`. Es un subconjunto estricto de YAML que se parsea a mano:

```markdown
---
resumen: Cómo despachar SOAT, impuestos y entregas.
palabras_clave:
  - despachar
  - sincronización
consultas:
  - cómo solicito un SOAT
  - por qué no veo un trámite de FLIT 2
version: 1.0
fecha: 2026-10-20
---
## Qué es
…
```

Reglas del subconjunto:
- Un escalar ocupa una línea: `clave: valor`. El valor es el resto de la línea, recortado y **sin comillas**. Así un `:` o una `,` dentro del resumen o de una consulta no rompen nada.
- Una lista es `clave:` vacía seguida de líneas `  - item`.
- No hay anidamiento, ni multilínea, ni comillas, ni comentarios.

Hay **cinco claves obligatorias**, y una clave desconocida es error:

| Clave | Regla |
|---|---|
| `resumen` | No vacío |
| `palabras_clave` | Al menos 1 |
| `consultas` | Al menos 1 |
| `version` | `^\d+\.\d+$` |
| `fecha` | `AAAA-MM-DD` válida (regex más ida y vuelta con `Date.UTC`) |

**Parser: `apps/web/src/lib/ayudaFicha.ts` (nuevo, puro).**

```ts
export interface EncabezadoFicha {
  resumen: string; palabrasClave: string[]; consultas: string[]; version: string; fecha: string /* ISO */;
}
export interface FichaParseada {
  encabezado: EncabezadoFicha | null;   // null si falta el bloque o es inválido
  cuerpo: string;                       // lo que hay después del `---` de cierre (o todo, si no hay bloque)
  errores: string[];                    // vacío = válido; lo consume la prueba de artefactos
}
export function parsearFicha(raw: string): FichaParseada;
export function fechaFichaLegible(iso: string): string; // 'dd/mm/aaaa'; sin `Date` local (sin desfase TZ)
```

Comportamiento:
- **En runtime es tolerante.** Si el encabezado es inválido, la ficha se pinta igual: el cuerpo, sin versión ni fecha, y con `resumen` vacío. No hay pantalla de error por un encabezado.
- **La prueba es estricta.** HU-1 AC4 falla si `errores.length > 0`.
- **El encabezado nunca llega a `parseMarkdown`.** `cargarFichas.ts` expone `leerFichaParseada(slug)`, que devuelve `FichaParseada | null`, y `leerFichasParseadas(slugs)`. Los dos envuelven a `leerFichaMd`/`leerFichasMd`, y la página consume solo esas funciones.

Además:
- **`_plantilla.md`** lleva el encabezado de ejemplo y queda excluida de la prueba, como hoy.
- **Relleno de las 22 fichas (P9-4a):**
  - la `fecha` sale de `git log -1 --format=%cs -- <archivo>`;
  - la `version` es `1.0`;
  - el `resumen` se **mueve** desde el catálogo (ver §2);
  - el cuerpo queda idéntico al byte. HU-1 AC5 se verifica con `git diff` del cuerpo.

## 2. Fuente única del resumen

**Decisión:** el resumen vive **en el encabezado** de la ficha. `EntradaAyuda.resumen` **desaparece** del catálogo y queda un campo opcional `resumenPendiente?: string`, que solo existe para entradas **sin** `.md`. Hoy son cero, porque las 22 tienen archivo.

Invariante, vigilado en `flito-ayuda-artefactos.spec.ts`:
- una entrada con `.md` **no** puede tener `resumenPendiente`;
- una entrada sin `.md` **debe** tenerlo.

Así nunca hay dos textos para la misma ficha.

Consumidores de `entrada.resumen`: solo `pages/FlitoAyuda.tsx` (4 usos) y `lib/ayudaBusqueda.ts`. Ningún otro archivo de `apps/web/src` ni de `e2e` lo usa (comprobado con grep). El índice ya espera a `leerFichasMd` de los capítulos visibles antes de pintar las filas, así que el resumen del encabezado está disponible sin otra petición.

*Alternativa descartada:* dejar el `resumen` en `catalogo.ts` y sacar del encabezado solo palabras clave y consultas. No se elige porque F2 tendría que editar dos archivos por ficha, y es justo lo que el Feature pide evitar.

## 3. `ordenarPorRelevancia`

**Dónde:** `apps/web/src/lib/ayudaBusqueda.ts`, que ya es puro. Reemplaza a `entradaCoincideBusqueda` y conserva `normalizarBusquedaAyuda`.

```ts
export interface DocumentoAyuda {
  clave: string;
  titulo: string;              // etiqueta del catálogo (= nombre del ítem del menú)
  palabrasClave: readonly string[];
  consultas: readonly string[];
  resumen: string;
  cuerpo: string;              // markdown sin encabezado
}
/** Filtra (todas las palabras deben aparecer en algún campo) y ordena. No muta. Determinista. */
export function ordenarPorRelevancia<T extends DocumentoAyuda>(docs: readonly T[], consulta: string): T[];
```

**Normalización:** la de hoy (minúsculas y NFD sin diacríticos), más `[^a-z0-9]+` → espacio. Con eso `·`, `/` y la puntuación no impiden el match. Los términos son las palabras de la consulta normalizada. Una consulta vacía devuelve `docs` tal cual, en el orden del índice.

**Puntaje:** cada término suma **una sola vez por nivel** (presencia, no frecuencia). Así un cuerpo largo no gana por repetir la palabra.

| Señal | Puntos |
|---|---|
| Consulta completa normalizada **igual** al título | +100 |
| Consulta completa contenida en el título | +30 |
| Término en el título | +8 |
| Término en `palabras_clave` | +4 |
| Término en `consultas` | +2 |
| Término en `resumen` | +2 |
| Término en el cuerpo | +1 |

- **Filtro (AND):** se excluye el documento si **algún** término no aparece en ningún campo. Con eso «xyzzy» da vacío y «credenciales siigo» sigue dependiendo solo de lo visible.
- **Desempate:** posición en `docs`. El llamador pasa las fichas visibles en el orden del índice (`GRUPOS_ORDEN` más el orden del catálogo), así que el resultado es estable y coincide con lo que el usuario ya ve.
- **Garantía de HU-2 AC4:** el +100 asegura que cada ficha queda primera al buscar su propio título. Dos etiquetas iguales romperían esa garantía. La prueba de artefactos ya vigila claves únicas; se añade «etiquetas únicas».
- **Permisos:** la función no sabe nada de ellos. El llamador le pasa solo `capitulosVisibles(user)`, igual que hoy (HU-2 AC5).

**Prueba por ficha:** `e2e/tests/flito-ayuda-busqueda.spec.ts` (nuevo). Importa `CATALOGO_AYUDA`, `parsearFicha` y `ordenarPorRelevancia` desde `../../src/…` y lee los `.md` con `fs`. Por cada ficha:
- la ficha es la `[0]` al buscar su `etiqueta`;
- la ficha está en el resultado de cada una de sus `consultas`.

Corre sin navegador. Además hay una prueba de UI para el orden, los vacíos y la etiqueta de grupo (P9-1a).

## 4. Anclas y `puedeEnlazarFichaAyuda`

**En `apps/web/src/lib/ayudaMarkdown.ts`:**

```ts
export function textoPlano(nodes: MdInline[]): string;            // concatena text/code/strong/a
export function anclaDeEncabezado(texto: string): string;         // slug base, sin sufijo
// MdBlock h1|h2|h3 gana `id: string`; parseMarkdown asigna ids únicos por ficha.
```

`anclaDeEncabezado` hace, en este orden:
1. `normalize('NFD')`;
2. quita `̀-ͯ`, con lo que `ñ` → `n` y `á` → `a`;
3. pasa a minúsculas;
4. cambia `[^a-z0-9]+` por `-`;
5. recorta los `-` de los extremos;
6. si queda vacío, devuelve `seccion`.

Ejemplos: `Cómo se entra` → `como-se-entra`, `Año ñandú` → `ano-nandu`.

**Duplicados:** `parseMarkdown` lleva un `Map<string, number>` y nombra `x`, `x-2`, `x-3`… en orden de aparición. Es la misma función que usará F3 para citar; para ser estable solo depende del texto y del orden de los encabezados.

**Render:**
- `AyudaMarkdown.tsx` pone `id` y `tabIndex={-1}` en `h2`/`h3`.
- `AyudaFicha` lee `useLocation().hash` **después** de cargar el cuerpo: si existe el `id`, hace `scrollIntoView` y `focus()`; si no existe, no hace nada (AC3).
- La tabla de contenido usa `<Link to={{ hash }}>` para no salir del router.

**Corrección de `puedeEnlazarFichaAyuda` en `apps/web/src/lib/ayudaFlito.ts`.** Falla cerrada para todo lo que empiece por `/flito/ayuda`:

```ts
// 1) No empieza por '/flito/ayuda' → true (no es asunto de la Ayuda; hrefPermitido ya filtró esquemas).
// 2) '/flito/ayuda' o '/flito/ayuda' + [?#…] → puedeVerAyudaFlito(user).
// 3) /^\/flito\/ayuda\/([^/?#]+)(?:[?#].*)?$/ → entrada por clave + puedeVerEntradaAyuda.
// 4) Cualquier otra forma bajo /flito/ayuda/ (segmentos extra, clave vacía) → false.
```

Hoy `#ancla` y `/flito/ayuda/x/y` caen en `return true`. Este cambio cierra los dos casos.

## 5. «Aplica para» (P9-2c)

El mapa ficha → PageSlug **ya existe**: es `EntradaAyuda.permiso` en `catalogo.ts`, y es obligatorio para que la ficha se liste. No se crea otro mapa.

Helper puro en `apps/web/src/lib/ayudaFlito.ts`:

```ts
export function rolesPorDefectoDePagina(slug: PageSlug): UserRole[];
```

- Recorre `USER_ROLES` en su orden y conserva los roles cuyo `paginasPorDefecto(rol)` (de `@operaciones/shared-types`) incluye `slug`.
- **`admin` va siempre primero.** No tiene fila en `ROLE_DEFAULT_PAGES` (`DEFAULTS_POR_ROL` es `Exclude<UserRole,'admin'>`): sus páginas las siembra la migración 0179 en `permisos_rol_funcion`, y el comentario de `siigo_credenciales` en `permissions.ts` confirma que admin tiene todas. Se documenta en el helper con esa referencia.
- `operaciones` no puede aparecer, porque no está en `USER_ROLES`.

Componente `components/ayuda/AyudaAplicaPara.tsx`. Recibe `entrada` y muestra:
- «Por defecto: {ROLE_LABELS…}. También quien tenga permiso a la pantalla {entrada.etiqueta}.»;
- con una sola entrada de rol, el mismo texto con ese rol.

**`packages/shared-types` no se modifica:** se usan los exports existentes `USER_ROLES`, `ROLE_LABELS` y `paginasPorDefecto`. La regla 7 no aplica.

## 6. Imágenes (HU-5)

**Decisión: los archivos van en `apps/web/public/ayuda/<clave>/<archivo>` y la URL se versiona con la `version` del encabezado.**

- **Sintaxis** en la ficha: `![alt](./<clave>/<archivo>)`. El parser acepta **solo** `^\.\/([a-z0-9_]+)\/([a-z0-9][a-z0-9_-]*\.(png|jpe?g|webp|svg))$`. Cualquier otra cosa (`http…`, `data:`, `/…`, `..`) produce el texto alternativo y no hace ninguna petición (AC6).
- **Nodo nuevo** `MdInline { type: 'img'; alt: string; src: string }`. Si el `alt` está vacío, no hay nodo: no se pinta nada, y la prueba falla (AC2).
- **URL final:** `/ayuda/<clave>/<archivo>?v=<version>`. El SW (`public/sw.js`, stale-while-revalidate) usa la URL completa como clave de caché. Por D7 la `version` sube en cada cambio de la ficha, así que una captura reemplazada con el mismo nombre se pide de nuevo y no se sirve la vieja.
  - **No se toca `sw.js`.**
  - Las entradas viejas quedan en `flit-sw-v1-assets` hasta el próximo cambio de `VERSION`. Es aceptable por tamaño.
  - El parser recibe la `version` como opción: `parseMarkdown(cuerpo, { versionFicha })`.
- **Render:** `<img loading="lazy" decoding="async" alt=… className="max-w-full h-auto">`, dentro de un `<figure>` del kit. `onError` cambia a un `<span>` con el alt (AC5). El componente lleva el estado `rota` por imagen.
- **Bundle:** nada entra al grafo de Vite, así que `check:bundle` (el entry de `/login`, 32 KB gzip) no cambia (AC3).
- **Prueba de artefactos:**
  - todo `![…](…)` tiene alt no vacío;
  - el `src` cumple la regex;
  - la carpeta es la `<clave>` de esa ficha;
  - el archivo existe en `public/ayuda/`.

  Esto además evita el caso en que el servidor devuelve `index.html` con 200 para una ruta inexistente y el SW lo cachea bajo la URL de la imagen.
- **SVG** solo como `<img>`, que no ejecuta scripts. Nunca inline.
- **Mermaid: no se añade.** Los diagramas se exportan a SVG o PNG.

**Alternativa descartada:** `import.meta.glob('./img/**', { query: '?url' })`, que da nombres con hash y resuelve el SW sola. Se descarta por dos motivos:
1. Vite incrusta como `data:` base64 en el chunk los archivos de menos de `assetsInlineLimit` (4 KB), lo que va contra AC3 salvo con `?no-inline` o un ajuste de config.
2. Mete el mapa de URLs en el chunk de la Ayuda.

`?v=` cubre la caché con menos piezas.

## 7. Partición de `FlitoAyuda.tsx` (375 líneas)

| Archivo | Contenido | HU que lo crea |
|---|---|---|
| `pages/FlitoAyuda.tsx` | Solo la decisión «índice o ficha» por `useParams`. Unas 30 líneas | HU-2 / HU-3 |
| `components/ayuda/AyudaEstados.tsx` | `SkeletonFicha`, `ErrorAyuda` (Reintentar), `AyudaSinModulos` (P9-3a), `AyudaSinResultados` | HU-2 |
| `components/ayuda/AyudaIndice.tsx` | `Indice` agrupado, más la lista plana por relevancia con la etiqueta de grupo (P9-1a) y `FilaFicha` | HU-2 |
| `components/ayuda/AyudaFicha.tsx` | `Ficha`, `VolverIndice`, versión y fecha bajo el título, foco en el ancla, Anterior/Siguiente | HU-1 (versión y fecha, en `FlitoAyuda.tsx`) → se mueve en HU-3 |
| `components/ayuda/AyudaTablaContenido.tsx` | `<nav aria-label="Contenido de la ficha">` con los `h2`/`h3` del AST | HU-3 |
| `components/ayuda/AyudaAplicaPara.tsx` | §5 | HU-4 |
| `components/ayuda/AyudaMarkdown.tsx` | Suma `id` en los encabezados, `callout` e `img` | HU-3 / HU-4 / HU-5 |

**Anterior/Siguiente:** helper puro `vecinasVisibles(visibles, clave): { anterior?, siguiente? }` en `lib/ayudaFlito.ts`. Se calcula sobre `capitulosVisibles(user)` en el orden del índice (`GRUPOS_ORDEN`, que hoy vive en la página, se mueve a `catalogo.ts`).

**P9-3a:** `AyudaFlitoGate` (`App.tsx`) deja de responder `NoAccess` cuando el usuario está autenticado y no tiene fichas visibles, y pinta la página con `AyudaSinModulos`. El ítem del menú sigue derivado de `puedeVerAyudaFlito` y queda oculto.

## 8. Contrato hacia F3 y F4 (Dr. Flit), sin diseñarlas

Lo que F3 y F4 pueden consumir tal cual, porque es puro y no depende de Vite:
- `parsearFicha` (texto del cuerpo, `palabras_clave`, `consultas`);
- `anclaDeEncabezado` / `parseMarkdown().id` (citas `/flito/ayuda/<clave>#<id>`);
- `ordenarPorRelevancia` (base determinista);
- `CATALOGO_AYUDA[].permiso` (mapa ficha → PageSlug).

Lo que F1 deja preparado para que F3 pueda **mover** esos módulos a un paquete compartido o generar un JSON en build, si su backend lo necesita, sin reescribirlos:
- **`catalogo.ts` sin dependencias del web.** Su `import type { PageSlug } from '../../lib/permissions'` pasa a `from '@operaciones/shared-types'`.
- **Los cuatro módulos puros solo importan entre sí o de `@operaciones/shared-types`.**

Restricción que F3 hereda y **no** resuelve F1: un backend que sirva texto de fichas tiene que volver a aplicar en el servidor `puedeVerEntradaAyuda`. Eso incluye la exclusión por `tipoEnlace` (D2) y el permiso por PageSlug sobre las páginas efectivas resueltas contra la BD. El vacío de P9-3a **no** es señal de visibilidad.

---

## Contrato delta (resumen)

- `.md` de ficha: encabezado obligatorio con 5 claves, callouts `> [!NOTA|IMPORTANTE|PRECAUCION]`, `![alt](./<clave>/<archivo>)`.
- `EntradaAyuda`: `- resumen`, `+ resumenPendiente?`.
- Nuevas: `parsearFicha`, `fechaFichaLegible`, `ordenarPorRelevancia`, `anclaDeEncabezado`, `textoPlano`, `rolesPorDefectoDePagina`, `vecinasVisibles`, `leerFichaParseada` / `leerFichasParseadas`.
- `MdBlock` h1–h3 `+ id`. `+ callout`. `MdInline + img`.
- `puedeEnlazarFichaAyuda`: falla cerrada bajo `/flito/ayuda/`.
- Sin cambios: API, esquema, `shared-types`, `sw.js`, `package*.json`.

## Archivos a crear/modificar

| Archivo | Acción | HU |
|---|---|---|
| `apps/web/src/lib/ayudaFicha.ts` | crear | 1 |
| `apps/web/src/content/ayuda/cargarFichas.ts` | modificar (`leerFicha(s)Parseada(s)`) | 1 |
| `apps/web/src/content/ayuda/catalogo.ts` | modificar (`resumen` → `resumenPendiente?`, `import type` desde shared-types, `GRUPOS_ORDEN`) | 1 (+2) |
| `apps/web/src/content/ayuda/*.md` (22) | modificar (solo el encabezado) | 1 |
| `apps/web/src/content/ayuda/_plantilla.md` | modificar | 1, 4, 5 |
| `.claude/skills/flit-ayuda-flito/SKILL.md` | modificar | 1, 5 |
| `apps/web/src/pages/FlitoAyuda.tsx` | modificar → reducir | 1, 2, 3 |
| `apps/web/e2e/tests/flito-ayuda-artefactos.spec.ts` | modificar | 1, 5 |
| `apps/web/src/lib/ayudaBusqueda.ts` | modificar (`ordenarPorRelevancia`) | 2 |
| `apps/web/src/components/ayuda/AyudaEstados.tsx`, `AyudaIndice.tsx` | crear | 2 |
| `apps/web/src/App.tsx` (`AyudaFlitoGate`) | modificar | 2 |
| `apps/web/e2e/tests/flito-ayuda-busqueda.spec.ts` | crear | 2 |
| `apps/web/e2e/tests/flito-ayuda-indice.spec.ts`, `flito-ayuda-acceso.spec.ts` | modificar (copy «ficha») | 2 |
| `apps/web/src/lib/ayudaMarkdown.ts` | modificar (ids, `anclaDeEncabezado`, `textoPlano`; luego `callout`; luego `img`) | 3, 4, 5 |
| `apps/web/src/lib/ayudaFlito.ts` | modificar (`puedeEnlazarFichaAyuda`, `vecinasVisibles`; luego `rolesPorDefectoDePagina`) | 3, 4 |
| `apps/web/src/components/ayuda/AyudaFicha.tsx`, `AyudaTablaContenido.tsx` | crear | 3 |
| `apps/web/src/components/ayuda/AyudaMarkdown.tsx` | modificar | 3, 4, 5 |
| `apps/web/e2e/tests/flito-ayuda-navegacion.spec.ts` | crear | 3 |
| `apps/web/src/components/ayuda/AyudaAplicaPara.tsx` | crear | 4 |
| `apps/web/e2e/tests/flito-ayuda-ficha.spec.ts` | crear | 4, 5 |
| `apps/web/public/ayuda/<clave>/<archivo>` (una imagen demo) | crear | 5 |

## ADR: no aplica

No hay modelo, contrato de API, dependencia ni tradeoff de PII o auth. La regla «imágenes en `public/` con `?v=`» queda documentada en la plantilla y en la skill.

## Notas operativas (frontend)

- **HU-1 es el cimiento.** Hasta que exista `parsearFicha`, nadie toca `ayudaBusqueda` ni `ayudaMarkdown`. El relleno de las 22 fichas se hace con un script **local y desechable** (no se commitea) y se verifica con `git diff --stat`: solo líneas añadidas al inicio de cada archivo.
- **Playwright importa `src`:** los módulos puros no pueden importar `../lib/api`, `react` ni nada que toque `import.meta.env`. Si uno lo necesita, va en el componente.
- **Callouts (HU-4):** `> [!TIPO]` solo cuando es la primera línea del bloque `>`. Las líneas `>` siguientes forman el cuerpo. Un `>` sin tipo, o con un tipo desconocido, se pinta como `p` con el texto sin el `>` (AC2). El tono sale de los tokens que ya usan `StatusChip` y los avisos del kit; nada de HEX.
- **Verificación P1:** `typecheck -w apps/web` más los specs `flito-ayuda-*` que toca cada HU. HU-5 añade `npm run build:web && npm run check:bundle`.
- **security-agent:** N/A en las 5 HUs mientras no entre ninguna dependencia ni SVG inline. El render sigue sin `dangerouslySetInnerHTML`.

## Riesgos abiertos

1. **«Por defecto: Administrador»** se afirma por convención (la siembra de 0179 da a admin todas las páginas) y no por una tabla compilada. Si una página futura no se siembra a admin, el texto mentiría para esa ficha. Mitigación: la frase «También quien tenga permiso a la pantalla X» y el comentario en el helper. Lo confirma el Líder Técnico.
2. **Roles con enlace (Cliente, Proveedor):** pueden aparecer en «Aplica para» de la ficha SOAT si `flito_soat` está en sus defaults, aunque D2 les oculte la Ayuda. Es coherente («aplica a la pantalla»), pero conviene que UX lo confirme.
