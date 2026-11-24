# TCs — HU #13764 · [FRONTEND] – Dr. Flit: botón flotante y panel lateral en todas las pantallas

> **qa-agent modo A** · contexto `desarrollo-gate` · 2026-10-21 · Feature #13694 (Épica #12757) · HU `Active`.
> **Fuente de los AC:** borrador `docs/ado-drafts/epic-12756-12757/HUS-F3-13694.md` §HU-1 (9 AC Gherkin).
> El MCP `ado` no estaba expuesto en esta invocación del subagente: **los AC no se contrastaron contra ADO**.
> Antes del modo B, el hilo confirma que el texto de ADO #13764 coincide con el borrador (si difiere, manda ADO
> y esta matriz se ajusta).
> **Spec:** `docs/ux/flito-dr-flit.md` (full) · `docs/diseno/feature-13694-dr-flit-panel-slim.md` (slim).
> **Spec E2E destino:** `apps/web/e2e/tests/dr-flit-panel.spec.ts` (lo crea `frontend-agent` en la rama
> `HU/13764-davidchica-dr-flit-boton-panel`). Este documento no escribe código ni ADO.

## Datos y entorno de prueba (sintéticos)

| Dato | Valor | Uso |
|---|---|---|
| `U-FIN` | `FINANCIERA_USER` de `e2e/helpers/ayuda-fixtures.ts` (rol `financiera`, ≥1 ficha visible) | Usuario con botón (AC1, AC3–AC9) |
| `U-CLI` | Usuario sintético con `tipoEnlace = 'cliente'` y página `flito_soat` (0 fichas visibles por D2). Si `ayuda-fixtures` no lo exporta, se añade ahí (no helper nuevo) | AC2 |
| `U-ADM` | Usuario `admin` de los fixtures (dock con fila completa) | AC7 (convivencia con el dock) |
| Viewport lg+ | `1440×900` | AC1, AC3–AC6, AC7 (dock) |
| Viewport <lg | `375×812` (y `360×740` para «Cerrar» visible) | AC7 |
| Pantalla con tabla | Una pantalla de financiera con tabla del kit (p. ej. la usada en `finanzas-*.spec.ts`) | AC3 |
| Pantalla con diálogo de página | Una pantalla de financiera con modal `z-50` que cierra con Esc | AC4 |
| Locators | botón `getByRole('button', { name: 'Abrir Dr. Flit' })`; panel `getByRole('complementary', { name: 'Dr. Flit' })`; `getByRole('button', { name: 'Cerrar' })`; `getByRole('link', { name: 'Abrir la Ayuda FLITO' })` | Todos |
| Ruta del chunk | `page.route('**/DrFlitPanel*.js', …)` (ajustar al nombre real del chunk en el build) | AC8, AC9 |

Ningún dato real de personas ni credenciales.

## Matriz AC → TC

| AC | TC | Tipo | Resultado esperado |
|---|---|---|---|
| AC1 | TC-01, TC-02 | happy | — |
| AC2 | TC-03, TC-04, TC-05 | borde / error | — |
| AC3 | TC-06, TC-07 | happy | — |
| AC4 | TC-08, TC-09, TC-10 | happy / borde | — |
| AC5 | TC-11 | happy | — |
| AC6 | TC-12 | happy | — |
| AC7 | TC-13, TC-14, TC-15 | borde | — |
| AC8 | TC-16, TC-17 | borde | — |
| AC9 | TC-18, TC-19 | error | — |
| Transversal (a11y) | TC-20 | borde | — |

Estado de todos: **pendiente** (modo A; se ejecutan en modo B tras la impl P1).

---

### AC1 — Botón visible con al menos una ficha

**TC-01 · `[HU 13764] AC1 — financiera ve "Abrir Dr. Flit" abajo a la derecha en pantallas autenticadas`**
- Pre: `U-FIN`, viewport 1440×900.
- Pasos: login → recorrer 3 rutas autenticadas del menú de financiera (incluida la de inicio).
- Esperado: en cada una, el botón es visible; su `boundingBox` cumple `x + width ≥ viewport.width - 40` y
  `y + height ≥ viewport.height - 40` (esquina inferior derecha); `aria-expanded="false"`.

**TC-02 · `[HU 13764] AC1 — el botón también está en /flito/ayuda`**
- Pre: `U-FIN`.
- Pasos: `abrirAyuda(page, FINANCIERA_USER)` (o navegar a `/flito/ayuda`).
- Esperado: botón visible, mismo nombre accesible.

### AC2 — Sin fichas visibles no hay botón, ni por un instante

**TC-03 · `[HU 13764] AC2 — usuario con enlace de cliente nunca ve el botón`**
- Pre: `U-CLI`.
- Pasos: login → recorrer sus pantallas (≥2 rutas).
- Esperado: `getByRole('button', { name: 'Abrir Dr. Flit' })` con `toHaveCount(0)` en cada una.

**TC-04 · `[HU 13764] AC2 — fail-closed mientras /permisos/mios no responde`** (borde, fija la ventana de carga)
- Pre: `U-FIN` **y** `U-CLI` (parametrizado).
- Pasos: `page.route('**/permisos/mios', r => setTimeout(() => r.continue(), 2000))` → login → durante la
  demora, muestrear el DOM (≥3 muestras / `page.waitForFunction` que falle si aparece el botón).
- Esperado: el botón tiene `count = 0` durante toda la demora; tras resolver, `U-FIN` lo ve y `U-CLI` no.
- Debe matar el mutante M1 (ver abajo).

**TC-05 · `[HU 13764] AC2 — error de /permisos/mios deja el botón oculto`** (error)
- Pre: `U-FIN`.
- Pasos: `page.route('**/permisos/mios', r => r.fulfill({ status: 500 }))` → login.
- Esperado: botón con `count = 0` (`permisosError` ⇒ oculto).

### AC3 — Abrir sin bloquear el fondo

**TC-06 · `[HU 13764] AC3 — abrir: panel "Dr. Flit", foco dentro y aria-expanded=true`**
- Pre: `U-FIN`, lg+, pantalla con tabla.
- Pasos: clic en «Abrir Dr. Flit».
- Esperado: panel `complementary` con nombre «Dr. Flit» visible; `document.activeElement` está dentro del
  panel; el botón tiene `aria-expanded="true"` y `aria-controls` = id del panel.

**TC-07 · `[HU 13764] AC3 — la tabla de fondo sigue usable con el panel abierto (no modal)`**
- Pre: TC-06.
- Pasos: scroll de la tabla; clic en un control de la tabla fuera de los ~400 px del panel (p. ej. ordenar una
  columna o una fila); `Tab` desde el panel hasta salir de él.
- Esperado: la tabla reacciona; el panel sigue visible; no hay `aria-modal="true"` ni overlay/backdrop; el foco
  puede salir del panel (sin trampa).

### AC4 — Cerrar con botón o Esc

**TC-08 · `[HU 13764] AC4 — "Cerrar" cierra el panel y devuelve el foco al botón`**
- Pasos: abrir → clic «Cerrar».
- Esperado: panel oculto (`toBeHidden`); foco en «Abrir Dr. Flit»; `aria-expanded="false"`.

**TC-09 · `[HU 13764] AC4 — Esc con foco dentro cierra el panel y devuelve el foco`**
- Pasos: abrir → `keyboard.press('Escape')` con foco en el panel.
- Esperado: igual que TC-08.
- Borde extra: con el panel abierto y el foco **fuera** (en la página), Esc **no** cierra el panel (el Esc vive en
  el `onKeyDown` del panel, no en `window`).

**TC-10 · `[HU 13764] AC4 — con un diálogo de página abierto, Esc cierra el diálogo y no el panel`** (borde)
- Pre: `U-FIN`, panel abierto, luego abrir un diálogo de la página (modal `z-50`) desde la pantalla.
- Pasos: `Escape` con el foco en el diálogo.
- Esperado: el diálogo se cierra; el panel sigue visible y `aria-expanded="true"`. Un segundo Esc con el foco
  devuelto a la página no cierra el panel.
- Debe matar el mutante M2.

### AC5 — Bienvenida

**TC-11 · `[HU 13764] AC5 — panel recién abierto muestra saludo y "Abrir la Ayuda FLITO"`**
- Pre: sesión nueva (sin conversación en `sessionStorage`).
- Pasos: abrir panel.
- Esperado: texto de saludo de Dr. Flit (comienza «Hola, soy Dr. Flit») visible; enlace «Abrir la Ayuda FLITO»
  con `href` que termina en `/flito/ayuda` **sin query string** (regla 14).

### AC6 — El panel se mantiene al navegar

**TC-12 · `[HU 13764] AC6 — en lg+ el panel sigue abierto al cambiar de pantalla desde el menú`**
- Pre: `U-FIN`, 1440×900, panel abierto; marcar el scroll interno del panel (p. ej. `scrollTop` > 0 si hay
  contenido) o un `data-*` estable.
- Pasos: navegar a otra pantalla desde el dock.
- Esperado: URL cambia; panel sigue visible sin re-render del Suspense (no aparece «Abriendo Dr. Flit…»);
  botón visible y con `aria-expanded="true"`.

### AC7 — Responsive

**TC-13 · `[HU 13764] AC7 — <lg el panel ocupa todo el ancho sin scroll horizontal y con "Cerrar" visible`**
- Pre: `U-FIN`, 375×812 y 360×740.
- Pasos: abrir panel.
- Esperado: `panel.boundingBox().width ≈ viewport.width` (±1 px); `document.documentElement.scrollWidth ≤
  clientWidth`; «Cerrar» visible y dentro del viewport; el botón flotante se oculta mientras el panel está abierto.

**TC-14 · `[HU 13764] AC7 — <lg sigue no modal: sin trampa de foco y la pantalla intacta al cerrar`**
- Pasos: abrir → `Tab` repetido hasta salir del panel (sin aria-modal/backdrop) → «Cerrar».
- Esperado: el foco alcanza elementos fuera del panel; tras cerrar, el botón reaparece y recibe el foco; la URL,
  el scroll de la página y un valor escrito antes en un input de la pantalla siguen iguales.

**TC-15 · `[HU 13764] AC7 — lg+ el botón no se solapa con el dock`**
- Pre: `U-ADM` (dock más ancho) y `U-FIN`, 1440×900.
- Pasos: medir `boundingBox` del botón y del contenedor del dock (`FlitNavBar`).
- Esperado: sin intersección de rectángulos; el botón está a la derecha del borde derecho del dock.

### AC8 — Carga diferida y bundle intacto

**TC-16 · `[HU 13764] AC8 — sin abrir el panel no se descarga su código`**
- Pre: build de producción (`npm run build:web` + preview) o dev con chunks; `U-FIN`.
- Pasos: `page.on('request')` registrando URLs → login → navegar 2 pantallas sin abrir el panel → abrir el panel.
- Esperado: antes del clic ninguna URL contiene `DrFlitPanel`; tras el clic sí hay exactamente la petición del
  chunk del panel.
- Debe matar el mutante M3.

**TC-17 · `[HU 13764] AC8 — check:bundle en verde y chunk de /login sin crecer`** (no E2E)
- Comandos: `npm run build:web && npm run check:bundle`.
- Esperado: exit 0; el tamaño del chunk de `/login` reportado por `check:bundle` igual al de `develop`
  (`a32dbb39`) — comparar con la misma salida en `develop` si `check:bundle` no imprime el delta.

### AC9 — Cargando y error del panel

**TC-18 · `[HU 13764] AC9 — carga lenta muestra indicador "Abriendo Dr. Flit…"`**
- Pasos: `page.route('**/DrFlitPanel*', r => setTimeout(() => r.continue(), 1500))` → abrir panel.
- Esperado: indicador de carga visible (texto «Abriendo Dr. Flit…», con `role="status"` o `aria-busy`); luego la
  bienvenida.

**TC-19 · `[HU 13764] AC9 — fallo del chunk muestra "Reintentar" y el reintento muestra la bienvenida`** (error)
- Pasos: `page.route` que **aborta** el chunk del panel la 1.ª vez y lo deja pasar la 2.ª → abrir panel →
  clic «Reintentar».
- Esperado: aviso «No se pudo abrir Dr. Flit» + botón «Reintentar»; tras el clic, bienvenida (TC-11) visible;
  la página de fondo no muestra el `ErrorBoundary` de página (el boundary es local al panel); sin error crudo.
- Debe cubrir el problema de `React.lazy` cacheando la promesa rechazada (si el reintento re-renderiza el mismo
  `lazy`, este TC falla).

### Transversal — accesibilidad

**TC-20 · `[HU 13764] a11y — axe sin violaciones graves con el panel abierto (lg+ y <lg)`**
- Pasos: `cargarAxe` + `correrAxe` + `esperarSinViolacionesGraves` de `e2e/helpers/axe.ts` con el panel abierto.
- Esperado: sin violaciones serious/critical; botón con nombre accesible; foco visible en botón, «Cerrar» y enlace.

---

## Mutantes previstos para el modo B (tope 3, P2)

| # | Mutación (en la rama de la HU, temporal) | Debe matarlo | Comando |
|---|---|---|---|
| M1 | En `DrFlitMontaje.tsx`, quitar `funciones !== null &&` de la condición de visibilidad | TC-04 | `npx playwright test e2e/tests/dr-flit-panel.spec.ts -g "AC2"` (desde `apps/web`) |
| M2 | Mover el manejador de Esc del `onKeyDown` del panel a `window.addEventListener('keydown', …)` | TC-10 (y borde de TC-09) | `… -g "AC4"` |
| M3 | Import estático de `DrFlitPanel` en `DrFlitMontaje.tsx` en lugar de `lazy()` | TC-16 | `… -g "AC8"` |

## Comandos del modo B (P1)

```bash
npm run typecheck -w apps/web
cd apps/web && npx playwright test e2e/tests/dr-flit-panel.spec.ts
npm run build:web && npm run check:bundle   # AC8 (HU toca el shell)
```

Suite completa y `test:e2e:smoke`: solo si el diff toca router/login (no previsto: `Layout.tsx` sí es shell; el
gate decide en modo B si basta el spec + `check:bundle`, y lo declara).

## Riesgos / notas para la implementación

- `U-CLI` puede no existir aún en los fixtures: añadirlo en `e2e/helpers/ayuda-fixtures.ts` con datos sintéticos.
- El nombre exacto del chunk depende de Vite; el spec debe usar un patrón robusto (`/DrFlitPanel/`) y fallar si
  no encuentra ninguna petición tras el clic (para que TC-16 no pase en vacío).
- TC-10 requiere una pantalla de financiera con modal cerrable por Esc; si no hay una estable, el spec puede abrir
  la paleta ⌘K (`z-[100]`) como diálogo de página equivalente — declararlo en el spec.
