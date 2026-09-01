# Diseño slim — HU #11901 · búsqueda en el índice Ayuda FLITO

Feature #11892. Sin backend. Sin query en la URL. Sin reescribir `siigo_credenciales` / `catalogo.ts` / el gate de `ayudaFlito.ts`.

## Patrón reutilizado

| Pieza | Path real | Qué se copia |
|---|---|---|
| Índice y 4 estados | `apps/web/src/pages/FlitoAyuda.tsx` (`Indice`) | Misma cáscara: skeleton → error+Reintentar → vacío de permiso → lista agrupada. La búsqueda **no** es un quinto estado de carga: vive dentro de **lleno** (y del vacío de coincidencias). |
| Carga lazy `?raw` | `apps/web/src/content/ayuda/cargarFichas.ts` (`leerFichaMd`, `verificarBundleAyuda`, `existeFichaMd`) | Mismo glob. **No** pasar a `eager`. El índice ahora pide el cuerpo de los capítulos **ya visibles**, no de todo el catálogo. |
| Gate | `apps/web/src/lib/ayudaFlito.ts` (`capitulosVisibles` → `puedeVerEntradaAyuda` → `puedeVerAyudaFlito`) | El universo del filtro es **solo** esa lista. `siigo_credenciales` sigue saliendo si `user.role === 'admin'`. **Prohibido** alias a `siigo_parametrizacion` y prohibido rellenar `permiso` en el catálogo en esta HU. |
| Normalización | `apps/web/src/components/flit/FlitOrganismoCombobox.tsx` (`normalizeSearch`) | `toLowerCase()` + `normalize('NFD')` + quitar `[\u0300-\u036f]`. `includes` sobre haystack. |
| Input | `flitInp` + `type="search"` (p. ej. `FlitoDerechos.tsx`) | `<label>` asociado (`htmlFor` / `id`). Tokens del kit. |
| Vacío | `FlitEmpty` del mismo índice | Copy de «ninguna coincidencia» ≠ copy de «no hay capítulos para su permiso» ≠ error. |

**No** API, `fetch` suelto ni `api.ts`. **No** `useSearchParams` / `?q=`. **No** tocar `apps/api/**`. **No** alinear «Ir a la pantalla» de credenciales (eso es deuda de #11890 vs catálogo; fuera de alcance).

## Decisión de carga

Hoy el índice espera `verificarBundleAyuda()` y solo mira `existeFichaMd` (sync). `leerFichaMd` corre al abrir la ficha. Filtrar por título mientras el cuerpo llega **no** cumple el AC: una consulta de cuerpo devolvería 0 hasta que cargue, o un subconjunto a medias.

**Una opción:** en el `useEffect` de `Indice`, con `capitulos = capitulosVisibles(user)` ya calculado:

1. `verificarBundleAyuda()` (bundle roto ≠ ficha pendiente).
2. `Promise.all(capitulos.map((c) => leerFichaMd(c.clave)))` — **solo claves visibles**. Un helper `leerFichasMd(slugs)` en `cargarFichas.ts` encapsula el `Map`.
3. Guardar `Map<clave, string | null>` (`null` = pendiente, sin archivo).
4. Recién entonces `estado = 'listo'`. El `PageContentSkeleton` cubre 1+2.

Si **cualquier** `leerFichaMd` **lanza** → `estado = 'error'` + Reintentar. No pintar lista filtrable a medias. Ausencia de archivo (`null`) no es error.

`Ficha` sigue con su propio `leerFichaMd` al deep-link; el cache de Vite reutiliza el chunk si el usuario vino del índice. No hace falta un store compartido.

**Nunca** llamar `leerFichaMd` / meter en el Map una clave que no esté en `capitulosVisibles`. Financiera no indexa `siigo_credenciales.md` aunque el chunk exista en el bundle.

## Criterio de match

```
normalizar(s) = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
q = normalizar(consulta).trim()
q vacío → todas las filas visibles (comportamiento actual del índice)
q no vacío → haystack = normalizar(etiqueta) + normalizar(resumen) + normalizar(cuerpo ?? '')
             coincide si haystack.includes(q)
```

- Cuerpo = Markdown **crudo** (el `string` de `leerFichaMd`). No parsear AST: `**Cargar factura**` contiene `Cargar factura`.
- Ficha pendiente (`cuerpo === null`): solo etiqueta + resumen.
- Grupos sin filas tras el filtro: no se pintan (igual que hoy).
- Consulta solo en `useState` del `Indice`. Al navegar a la ficha y volver, se pierde (aceptable: no hay URL).

Anclas (únicas en el corpus actual; no reescribir los `.md`):

| Consulta | Capítulo | Quién la ve (gate actual) |
|---|---|---|
| `Cargar factura` | `soat.md` | `hasPage('soat')` (p. ej. proveedor, admin) |
| `Credenciales RNDC` | `siigo_credenciales.md` | **solo** `puedeVerEntradaAyuda` → `role === 'admin'` |
| `Asentar corrección` / `asentar correccion` | `flito_bolsas.md` | `hasPage('flito_bolsas')` (p. ej. financiera, admin) |

Contrapruebas de gate: financiera con `Credenciales RNDC` → 0 filas de credenciales (y no se cargó ese `.md`). Proveedor con `Asentar corrección` → no Bolsas.

## Contrato delta

| Contrato | Valor |
|---|---|
| Rutas | Sin cambio: `/flito/ayuda`, `/flito/ayuda/:slug`. **Sin** query. |
| Superficie nueva | Input de búsqueda en el índice **lleno** (también visible cuando hay capítulos pero 0 coincidencias). |
| Label | Visible, asociado: **Buscar en las guías**. Placeholder: **Título, resumen o contenido**. |
| Copy 0 coincidencias | Título **Ningún capítulo coincide con la búsqueda.** Cuerpo: **Pruebe otra palabra o borre el recuadro para ver las guías que usted ya puede abrir.** Sin Reintentar. |
| `aria-live="polite"` | Frase corta de recuento («N capítulos») al filtrar; no `assertive`. |
| Permiso | Sin cambio. Índice y búsqueda ⊆ `capitulosVisibles`. Deep-link sin permiso = `NoAccess` como hoy. |

## Archivos a crear/modificar

**Crear**

- `docs/diseno-hu-11901-busqueda-ayuda.md` (este documento)
- `apps/web/src/lib/ayudaBusqueda.ts` — `normalizarBusquedaAyuda` + `entradaCoincideBusqueda(entrada, cuerpo, consulta)` (~20 líneas). Separado de `ayudaFlito.ts` para no tocar el gate de credenciales.

**Modificar**

- `apps/web/src/content/ayuda/cargarFichas.ts` — añadir `leerFichasMd(slugs)` = `Promise.all` de `leerFichaMd`. Comentario de cabecera: el índice pide cuerpos de **visibles**.
- `apps/web/src/pages/FlitoAyuda.tsx` — `Indice`: Map de cuerpos, input, filtro, vacío de coincidencias. **No** cambiar `Ficha` ni `puedeVerEntradaAyuda`.
- `apps/web/e2e/tests/flito-ayuda-indice.spec.ts` — casos de las 3 anclas + NFD + gate (financiera / proveedor) + query no persiste en URL.
- `apps/web/e2e/tests/flito-ayuda-a11y.spec.ts` — índice con búsqueda: label asociado, foco en el input, contraste del campo, axe en lleno-con-filtro y en 0 coincidencias.

**No tocar**

- `apps/web/src/content/ayuda/catalogo.ts`, `ayudaFlito.ts` (gate), los 18 `.md`, `App.tsx`, `apps/api/**`, `schema.ts`, `shared-types` (salvo que un test de catálogo se rompa: no debería).
- `docs/ux/flito-ayuda.md`: sigue diciendo «no hay búsqueda»; es deuda de UX doc, no de esta HU. No reabrir ux-agent.

## ADR: no aplica

Filtro en cliente sobre Markdown ya empaquetado. Sin HTML crudo nuevo, sin sanitizer, sin GET+query con PII, sin dependencia nueva.

## Notas operativas (frontend-agent)

1. **Orden de implementación.** Helpers de match → `leerFichasMd` → `Indice` (carga + UI) → E2E. No filtrar con `capitulos` crudos mientras `estado === 'cargando'`.
2. **`siigo_credenciales`.** El PageSlug y `/siigo/credenciales` ya existen (#11890). El catálogo de ayuda **aún** no pone `permiso` ni `to`. Esta HU usa el gate que hay (`admin`). No inventar `hasPage('siigo_credenciales')` en el índice ni alias a parametrización. Financiera no ve el capítulo ni al buscar «Credenciales RNDC».
3. **4 estados.** Cargando sigue cubriendo bundle + cuerpos. Error sigue siendo fallo de lectura, no «0 hits». Vacío de permiso (0 `capitulosVisibles`) **no** muestra el input. Vacío de búsqueda sí, para poder borrar.
4. **a11y.** Label visible (no solo `aria-label`). `type="search"`. Foco visible (`flit-focus`). Contraste del placeholder ≥ 4.5 si el AC de a11y lo exige; si el token muted del kit ya está en deuda heredada, no cambiar el kit — Nota P4, no HU extra.
5. **P1.** `npx playwright test e2e/tests/flito-ayuda-indice.spec.ts e2e/tests/flito-ayuda-a11y.spec.ts` (desde `apps/web` o el wrapper del repo) + `npm run typecheck -w apps/web`. No glob del resto de specs de ayuda. Impl no muta.
6. **ux/architecture.** Extensión del índice existente: ux **omit** (declarar en el PR). architecture = este slim.
7. **security.** Copy/UI + Markdown estático ya en el cliente. Sin rutas nuevas, sin PII en URL. `security-agent`: no aplica (P5), declarado.
8. **db-review:** no aplica.
