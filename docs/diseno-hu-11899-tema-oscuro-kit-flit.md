# Diseño slim — HU #11899 · Tema oscuro completo (kit FLIT + login)

Feature #11898. 100 % front. Pedido PO 2026-08-26 (C3) cerrado: no reabrir alcance.
Spec: `docs/ux/shell-tema-y-responsive.md`. Hallazgo 5 de `docs/ux/paleta-accesible-kit-flit.md` **revocado**.

**Hex oscuros: no se inventan aquí.** Frontend los pinta y `npm run check:contraste` los mide en los dos temas (4.5:1 texto, 3:1 gráficos/foco). Prohibido `#4FD4CC` como fondo de botón con texto blanco.

## Patrón reutilizado

| Pieza | Path real | Qué se copia |
|---|---|---|
| Atributo de tema | `apps/web/src/lib/theme.tsx` + bootstrap en `apps/web/index.html` | Misma clave `aura-theme`, mismos tres modos, mismo `ThemeToggle` (solo topbar). **Cambia** `applyDocumentTheme`: nunca quita `data-theme`; escribe `light`\|`dark` resuelto (OS si `system`). |
| Pares CSS | `apps/web/src/styles/tokens.css` (`:root[data-theme='dark']` **separado** del `@media`) | **El mismo selector** para `--flit-*` en `flit-tokens.css`. No mezclar con coma en una sola lista (bug Aura ya documentado). |
| Scopes FLIT | `.flit-app`, `.flit-auth`, `.flit-modal` en `flit-tokens.css` | Siguen; al invertir tokens en `:root`, el modal en `body` (ModalPortal) hereda pares oscuros **junto** con Aura. |
| Gate | `scripts/check-contraste-paleta.mjs` | Misma maquinaria (cascada + `var()` + 15 CASOS ⌘K + gradientes `-ink`). Se **extiende** a pares `--flit-*` oscuros; no se reabren #11720/#11767. |

**No** inventar otro sistema de tema, ni paleta Aura (`--color-*`), ni gemelo `@media` para FLIT (ver § Estrategia `system`).

## Contrato delta — tokens `--flit-*` con par oscuro

Bloque nuevo **solo** `:root[data-theme='dark'] { … }` al final de `flit-tokens.css` (después de `:root` claro). Familia cool navy FLIT, no cream Aura.

| Familia | Tokens | Rol en oscuro | Umbral |
|---|---|---|---|
| Fondos | `--flit-bg-app`, `--flit-bg-modal`, `--flit-bg-card`, `--flit-bg-table-header` | Página / modal / tarjeta+inputs+tabla / cabecera. Card **más clara** que app (misma jerarquía que blanco vs `#EAF2FF`). | — |
| Topbar | `--flit-bg-topbar` **nuevo** | Sustituye `rgba(234, 242, 255, 0.85)` hardcode en `FlitTopbar`. Par oscuro = mismo matiz que `--flit-bg-app` con alfa. **No** `color-mix` hasta que el gate lo sepa parsear. | — |
| Texto | `--flit-text-primary`, `--flit-text-secondary`, `--flit-text-muted`, `--flit-text-brand-title`, `--flit-blue-text` | Sobre **app, card y modal**. `muted` y `blue-text` deben pasar en los tres (lección #11604: no medir solo sobre blanco). | ≥ 4.5:1 |
| Bordes | `--flit-border-soft`, `--flit-border-input`, `--flit-border-focus` | Contra la superficie adyacente (card/app). | ≥ 3:1 |
| Sombras | `--flit-shadow-card`, `--flit-shadow-modal`, `--flit-shadow-button` | Pueden oscurecerse; no son texto. | — |

**No se toca**

- `*-ink` ni `--flit-gradient-*` (tinta para **texto blanco**; #11766 vigente).
- `--flit-cyan` / `--flit-blue` / `--flit-green` (marca de superficie).
- `--flit-text-inverse` (sigue blanco sobre gradiente).
- Radios, tipo, motion, alturas.
- `--color-capture-*` (fuera del bloque dark de Aura **y** de FLIT).
- `.flit-focus-light` (blanco sobre drawer de marca).

Anillo `.flit-focus`: hoy `rgba(79, 116, 201, 0.85)` hardcode. Pasar a `var(--flit-border-focus)` (con alfa en el token o sombra que el gate pueda parsear) para que el 3:1 se mida también en oscuro.

`.flit-modal` viaja **en el mismo cambio**: no hace falta otra clase. Con `--flit-bg-modal` + `--flit-text-primary` oscuros, desaparece el bug histórico (tinta Aura `#f0eee9` sobre modal celeste). Actualizar el comentario de `flit-tokens.css` que dice que las superficies FLIT son fijas.

## Estrategia `system`: `data-theme` siempre — sin gemelo FLIT

Hoy:

1. Bootstrap `index.html`: si `aura-theme` es `light`\|`dark` → atributo; si `system` o ausente → **no** setea (Aura cae al `@media` `:root:not([data-theme])`).
2. `applyDocumentTheme('system')` **quita** el atributo.
3. El `useEffect` de `ThemeProvider` depende solo de `theme`, no de `systemPref`.

C3:

1. **Bootstrap:** siempre `setAttribute('data-theme', resolved)` donde `resolved` = stored si `light`\|`dark`, si no `matchMedia('(prefers-color-scheme: dark)')`. Si `localStorage` lanza, igual resolver por OS. Clave `aura-theme` **no** cambia.
2. **`applyDocumentTheme`:** `setAttribute` a `light`\|`dark` (OS si `mode === 'system'`). Nunca `removeAttribute`.
3. **Effect:** `[theme, systemPref]` (o `resolvedTheme`) para que un cambio de OS en vivo actualice el atributo.

**¿Gemelo `@media` para `--flit-*`?** No. Con el atributo siempre puesto (bootstrap + JS), `:root[data-theme='dark']` basta. El gemelo Aura (`tokens.css` L175–226) **se deja**: cubre `--color-*` si el script no corre; no es trabajo de esta HU duplicarlo ni borrarlo. Meter FLIT en un `@media` además haría **invisible** el par al gate (`reglas()` descarta at-rules).

Login: sin `ThemeToggle`. Sigue storage + bootstrap. Panel izquierdo = isla `--flit-gradient-sidebar` (`bg-white/15` sobre el ramo **se queda**).

## Mapa `bg-white` / hex → token (kit)

Sustituto default: `bg-white` / `#fff` / `background: '#fff'` → `bg-[color:var(--flit-bg-card)]` o `background: 'var(--flit-bg-card)'`. `hover:bg-white` → hover con `--flit-bg-card` (o `--flit-bg-app` si el padre ya es card). Tailwind `bg-white` **no sigue el tema**.

| Archivo | Qué migrar |
|---|---|
| `FlitTopbar.tsx` | Fondo hardcode → `--flit-bg-topbar`. Trigger ⌘K, menú, `hover:bg-white` → card. |
| `flitPageKit.tsx` | `flitInp`, `FlitTable`, `FlitCard`, `flitBtnSecondary(Sm)`, `flitPillBtn(true)` (`background: '#fff'`). |
| `FlitModal.tsx` | `hover:bg-white` del cierre. Dialog ya usa `--flit-bg-modal`. |
| `Login.tsx` | Tarjeta e inputs `bg-white` → card. **No** el `bg-white/15` del panel de marca. |
| `KpiCard.tsx`, `PageHeaderCard.tsx`, `FlitAcordeon.tsx` | Superficie `bg-white`. |
| `FlitSelect.tsx`, `FiltrosInteligentes.tsx`, `ThFiltroMulti.tsx`, `RangoFechas.tsx`, `RangoFechaFilter.tsx`, `FlitOrganismoCombobox.tsx` | Trigger, panel y campos `bg-white`. |
| `FlitUploadBox.tsx` | Idle `#fff` → `--flit-bg-card` (kit; no estaba en el prompt). Tintes verified/rejected se quedan. |
| `FlitWizardSidebar.tsx` | Círculo pendiente `#fff` → `--flit-bg-card`. Done/active (superficie + blanco) **no** se tocan. |

**No migrar (excepción o isla)**

- `VisorPdf.tsx` `bg-white` — lienzo del documento.
- `CedulaCaptureOverlay` / `--color-capture-*`.
- `FlitSidebar.tsx` `bg-white/10|15|20` sobre el gradiente.
- Login aside `bg-white/15`.

**Deuda (fuera de esta HU):** `bg-white` residual en páginas de módulo (PESV, LAFT, Siigo, RNDC, `RoadIncidents`, etc.). No listar ~40. Se cierra al tocar esa pantalla.

**Fuera (HU #11900):** rail, dock por ancho, columnas comparendos, affordance scroll de `FlitTable`.

## Reabsorción dock / ⌘K (`index.css`)

Hoy hay **dos fuentes**: tokens claros invariantes + parches `[data-theme='dark']` con hex medidos sobre un shell que **no** invertía. En C3 `.flit-app` sí invierte: esos hex **quedan mal** y hay que remedir.

1. Reglas base `.flit-shell-*` (muted/primary/secondary/accent, sunken, nav, palette, kbd, placeholder) → `var(--flit-*)`. Nav y palette: `--flit-bg-card` (+ `backdrop-filter` si se conserva el blur). Sunken/kbd: `--flit-bg-app` (jerarquía tecla más oscura que el panel, igual que en claro).
2. **Borrar** los bloques `[data-theme='dark']` de pills, nav, palette, kbd, placeholder y tintas (L255–261, L312–316, L347–417). No dejar parche divergente.
3. `.flit-shell-overlay` `rgba(22,39,68,0.45)` puede quedarse (velo, no texto).
4. `.flit-shell-hover` / `.flit-shell-active`: si un rgba no sale de un token, o token `--flit-bg-hover` con par, o un único `color-mix` **después** de enseñar al gate. Prohibido hex suelto que no coincida con el par.
5. No reabrir la lógica de #11720/#11767: los 15 CASOS y los e2e `command-palette-*.spec.ts` siguen siendo el oráculo; se actualizan números, no el modelo de capas.

`CommandPalette.tsx`: sin cambio de markup salvo comentarios obsoletos («shell no invierte»).

## Extender `check-contraste-paleta.mjs`

**Hoy comprueba**

1. 15 puntos de CommandPalette en claro y oscuro (cascada `ganadora`, composición de velos). En oscuro lee parches de `index.css`; la página bajo el overlay es `.flit-app` → `--flit-bg-app` **claro** (invariante).
2. Los 4 `--flit-gradient-*` admiten blanco ≥ 4.5:1 (21 muestras/tramo).
3. `.flit-focus-light` ≥ 3:1 sobre `--flit-gradient-sidebar`.

`resolverVar` toma el **primer** `--flit-*:` del archivo → siempre el `:root` claro. `reglas()` ignora `@media`.

**Añadir (mínimo)**

1. **Resolver por tema:** `tokenEnTema('--flit-…', 'claro'|'oscuro')` lee el cuerpo de `:root` vs `:root[data-theme='dark']`. Sin bloque dark → el gate **falla** (no aprueba por omisión). Encadenar `var()`.
2. **Página en oscuro:** `medirTema('oscuro')` compone sobre `--flit-bg-app` **oscuro** (el shell ya no es `#EAF2FF`).
3. **Tras reabsorber:** si desaparecen selectores `[data-theme='dark'] .flit-shell-*`, `variantes()` cae a la clase base + `var()`; `resolverVar` en oscuro debe usar (1). No borrar los 15 CASOS.
4. **Pares de producto (bloque nuevo, los dos temas):**
   - Texto: primary/secondary/muted/brand-title/blue-text × fondos app, card, modal → ≥ 4.5:1.
   - Bordes: soft/input/focus × superficie adyacente → ≥ 3:1.
   - `--flit-text-inverse` (blanco) × muestras de los 4 gradientes → ya cubierto; **assert** que ninguna parada resuelve a `#4FD4CC`.
5. Gradientes e `-ink`: **sin cambio de valores**; seguir midiendo contra `:root` (no hay par oscuro).
6. No parsear `@media` ni añadir gemelo FLIT para «cubrir» el gate.

Oráculo píxel: e2e paleta claro/oscuro. Comentario de `command-palette-claro.spec.ts` («`system` quita `data-theme`») queda **falso** — actualizar. AC2: `aura-theme=system` + `emulateMedia({ colorScheme: 'dark' })` → `html[data-theme=dark]`.

## Archivos a crear/modificar

**Crear:** ninguno de producto.

**Modificar**

- `apps/web/index.html` — bootstrap siempre escribe `light`\|`dark`.
- `apps/web/src/lib/theme.tsx` — `applyDocumentTheme` + effect con preferencia OS.
- `apps/web/src/styles/flit-tokens.css` — pares oscuros, `--flit-bg-topbar`, anillo `.flit-focus`, comentario `.flit-modal`.
- `apps/web/src/index.css` — reabsorber; borrar parches dark de dock/⌘K.
- Kit listado arriba (incl. `FlitUploadBox`, `FlitWizardSidebar`).
- `apps/web/src/pages/Login.tsx` — tarjeta/inputs; sin toggle.
- `scripts/check-contraste-paleta.mjs` — § anterior.
- `apps/web/e2e/tests/command-palette-claro.spec.ts`
- `apps/web/e2e/tests/command-palette-oscuro.spec.ts`

**No tocar:** `tokens.css` (Aura + capture), `VisorPdf.tsx`, `CedulaCaptureOverlay.tsx`, `FlitSidebar.tsx` (salvo que un comentario mienta), API/schema/`shared-types`, páginas de módulo.

## ADR: no aplica

Extensión del patrón ya aceptado en `tokens.css` (`data-theme` + pares). No hay tradeoff de persistencia, auth ni PII. No se abre ADR.

## Notas operativas

**Frontend**

- P1: `npm run check:contraste` (ambos temas) + e2e paleta; `typecheck -w apps/web`. Hex a ojo = FAIL del gate.
- `ThemeToggle` solo en topbar. Login no lo importa.
- Drawer = isla de marca. PDF y captura = fuera.
- Comentarios que digan «FLIT es invariante» / «Hallazgo 5» / «system quita data-theme»: actualizar o borrar.
- `flit-ayuda-flito`: N/A si no hay ficha de «tema»; el toggle ya existe. Declarar en PR.
- architecture/ux full: no. security/db: no aplica (P5, copy/CSS/tokens).

**Backend:** no aplica.

**QA:** AC1–**AC8** Gherkin del WI (el WI se corrigió el 26 ago: AC7 reescrito — el gate hoy NO mide ningún par `--flit-*` y por eso ya está verde — y **AC8 nuevo**: revertir el bloque `[data-theme='dark']` de `flit-tokens.css` tiene que hacer FALLAR `check:contraste`; si sigue verde, mide otra cosa). Mutantes ≤3 sobre P1 (p. ej. quitar `data-theme` en `system`, devolver un `bg-white` del kit, parada de gradiente a cian).
