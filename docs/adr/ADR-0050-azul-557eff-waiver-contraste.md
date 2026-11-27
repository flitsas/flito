# ADR-0050: azul principal `#557eff` en el tema claro, con waiver de contraste acotado

- **Estado:** Aceptado (David Chica, Líder Técnico, 2026-11-26)
- **Fecha:** 2026-11-26
- **Épica:** ADO #14707, bloque 4 (rediseño de Gestión Trámites). Rama `EPICA/14707-davidchica-…`.
- **Decisión humana de origen:** David, 2026-11-26. Es la R3 de [`docs/ux/flito-tramites-rediseno.md`](../ux/flito-tramites-rediseno.md) §6, explícita, tomada con el impacto a la vista y confirmada dos veces sobre la maqueta `docs/ux/mockups/flito-tramites-rediseno.html`.
- **Supersedes:** ninguno. **Relacionados:** Épica #14560 (UI Kit 2026, [`docs/ux/rediseno-2026/README.md`](../ux/rediseno-2026/README.md)), Bugs #11720, #11766 y #11767 (origen del gate `check:contraste`), HU #11650 (helper axe de E2E).
- **Alcance:** kit común de `apps/web` (todas las pantallas, FLITO y legacy, porque el kit es uno). No toca `apps/api`.
- **Diseño que lo aplica:** [`docs/diseno/epica-14707-bloque4-rediseno-tramites.md`](../diseno/epica-14707-bloque4-rediseno-tramites.md) §1.

## Contexto

1. **La marca es `#557eff`, pero el tema claro pinta `#1d53ff`.** El kit trae `--kit-azul: #557eff` como base. El bloque final de contraste de la propuesta (`ui-kit-2026.css`, repo `flit`, rama `propuesta-2`) lo sobrescribe en el tema claro con `#1d53ff`/`#1746e0` para que el texto azul y el blanco sobre botón azul lleguen al 4,5:1. David decide que **todo** el azul del tema claro vuelva a `#557eff`. Eso incluye `--kit-azul`, `--kit-azul-hover`, `--color-action`, `--gradient-action(-hover)`, `--color-highlight(-display)`, `--color-heading`, `--color-info` y `--kit-azul-relleno`, que es el relleno de botón de los dos temas.
2. **AGENTS.md §12 exige un contraste de 4,5:1 y lo hace bloqueante.** Con `#557eff` estos pares quedan por debajo. Los medí con la misma fórmula del gate:

   | Par (tema claro, salvo que se indique) | `#1d53ff` hoy | `#557eff` |
   |---|---|---|
   | Texto azul sobre `--color-surface-elevated` (`#ffffff`) | 5,62 | **3,61** |
   | Texto azul sobre `--color-surface` (`#e6f0ff`) | 4,89 | **3,14** |
   | Texto azul sobre `--kit-hover` (`#e1ebfb`) | 4,68 | **3,00** |
   | Etiqueta «info» (`--ct` sobre `color-mix(--c 10 %, superficie)`) | 4,85 | **3,23** |
   | Blanco sobre botón azul y sobre las cabeceras azules (`.menu-usuario__cabeza`, `.dock__cabeza`), **en los dos temas** | 5,62 | **3,61** |
   | Blanco sobre el hover del botón (`color-mix(#557eff 86 %, tinta)`); el gate no lo mide | — | 4,34 |

   **Hallazgo que la maqueta no recoge.** El texto azul sobre un fondo teñido de azul cae por debajo incluso de 3:1. Sobre la barra de selección (`color-mix(--color-action 10 %, --color-surface)`) da **2,84:1**, y sobre un tinte del 20 % (`--color-accent-soft`, `chip[aria-pressed]`) da **2,56–2,88:1**. Ese caso queda **fuera** del waiver (§Decisión, punto 4).
3. **Dónde vive el azul:**
   - `apps/web/src/styles/kit/kit-variables.css` y `kit-ui.css` son **generados** por `docs/ux/rediseno-2026/generadores/gen-css.cjs` desde la propuesta y llevan la marca «No editar a mano».
   - `tokens.css` y `kit-react.css` se escriben a mano.
   - Lo comprobé en un directorio temporal: con `propuesta-2` en `89fbacc78`, regenerar da `kit-variables.css` y `kit-propuesta.css` **idénticos** a los del repo. `kit-ui.css` difiere en una sola línea, el cursor de marca, que se retiró a mano en S0 y no está en el generador. Ya existe, por tanto, un precedente de parche manual sobre un archivo generado, y se perdería en silencio si alguien regenerara.
   - Aparece `1d53ff`/`1746e0` en estos puntos: `kit-variables.css:282-284, 287`, `kit-ui.css:569, 570, 585 (×2), 611 (×2), 613`, `tokens.css:35, 49`, `kit-react.css:29 (×2)` y `kit-react.css:184` (en un comentario).
4. **Hay dos gates de contraste:**
   - `npm run check:contraste` (`scripts/check-contraste-paleta.mjs`, `AA = 4.5`) se pone en rojo con el cambio, en los casos 2, 3 y 4.
   - `esperarSinViolacionesGraves` (`apps/web/e2e/helpers/axe.ts`) hace fallar cualquier violación `serious`. `color-contrast` es `serious`, y la usan 27 specs.

## Alternativas

### A. Dónde se cambia el azul

| Opción | Pros | Contras | Esfuerzo | Riesgos |
|---|---|---|---|---|
| **A1. Editar a mano los generados** (`kit-variables.css`, `kit-ui.css`) | Diff mínimo | Viola «No editar a mano». La próxima regeneración devuelve `#1d53ff` **en silencio** y el gate de contraste pasaría a verde por la razón equivocada | S | Deriva silenciosa (ya pasó con el cursor) |
| **A2. Capa de sobrescritura escrita a mano** (variables en `tokens.css`, reglas en `kit-react.css`, que cargan después) | No toca los generados | `grep 1d53ff` nunca queda vacío (condición 4 de la UX §6.2). Quedan dos verdades en cascada, y quien lea `kit-ui.css` ve un azul que no se pinta | S | Ambigüedad en la cascada. El gate lee los 6 archivos y resolvería bien, pero las personas no |
| **A3. Parche determinista en el generador** (`gen-css.cjs` aplica una tabla `MARCA_FLITO` de sustituciones exactas con su conteo esperado y aborta si no cuadra), regenerar y editar a mano solo los archivos manuales | Una sola verdad. Sobrevive a la regeneración. Recoge también el parche del cursor. `grep` queda vacío. Si la propuesta cambia, el generador falla en voz alta | Hay que tocar el generador (37 líneas, en `docs/`) | S | Que la propuesta `propuesta-2` se haya movido desde S0. Lo mitiga que la regeneración sin parche reproduce hoy el repo byte a byte, salvo el cursor |

**Elegida: A3.**

### B. Excepción en `check:contraste`

| Opción | Veredicto |
|---|---|
| B1. Bajar `AA` a 3 o apagar los casos 2 y 3 | **Rechazada:** abre la puerta a cualquier par nuevo bajo 4,5. Lo prohíbe la UX §6.2 |
| B2. Comodín por color («todo lo que lleve `#557eff` pasa») | **Rechazada:** no es una lista de pares |
| **B3. Lista explícita de pares** (tema + clave del caso + ratio mínimo), **atada al valor `#557eff`** y **con trinquete de obsolescencia** | **Elegida** |

### C. Escaneos axe de E2E

| Opción | Veredicto |
|---|---|
| C1. `disableRules: ['color-contrast']` en el helper o por spec | **Rechazada:** apaga el contraste de toda la app |
| C2. `exclude` de selectores por spec | **Rechazada:** son 27 specs, cada una con su lista, y se excluye el nodo entero, incluidas otras reglas |
| **C3. Filtro por nodo en `correrAxe`:** se descarta un nodo de `color-contrast` solo si su par (`fgColor`/`bgColor` de axe) está en la lista del waiver y su `contrastRatio` es mayor o igual al piso. Los nodos descartados se **imprimen** | **Elegida** |

## Decisión

1. **Valores (tema claro):**
   - `--kit-azul: #557eff` y `--kit-azul-hover: color-mix(in srgb, var(--kit-azul) 86%, var(--kit-tinta))`.
   - `--color-action`, `--color-heading`, `--color-highlight`, `--color-highlight-display` y `--color-info` pasan a `var(--kit-azul)`.
   - `--gradient-action: linear-gradient(var(--kit-azul), var(--kit-azul))`, y lo mismo con `-hover`.

   **Relleno, en los dos temas:** `--kit-azul-relleno: #557eff`.
   - Se declara **literal** en `tokens.css` `:root`, y no como `var(--kit-azul)`. `tokens.css` carga después de `kit-variables.css` con la misma especificidad que `[data-theme="dark"]`, así que su `:root` **gana también en oscuro**. Con `var(--kit-azul)`, el relleno oscuro sería `#8fb0ff` y el blanco encima daría 2,2:1. El gate lo detectaría, pero conviene no caer en ello.

   **Tema oscuro:** sin cambio, salvo el relleno (`#8fb0ff` sigue siendo el azul de texto).
2. **Vía (A3):**
   - `gen-css.cjs` gana un paso final `marcaFlito(archivo, css)` con una tabla de sustituciones exactas: archivo, texto original, reemplazo y número de apariciones esperado.
   - El paso aborta si alguna sustitución no encuentra su conteo. También aborta si, al terminar, queda `/1d53ff|1746e0/i` en la salida.
   - La tabla incluye el cursor de `.kit-cuerpo` (S0) para que regenerar sea idempotente.
   - `tokens.css:35, 49` y `kit-react.css:29, 184` se editan a mano. Son archivos manuales.
   - `docs/ux/rediseno-2026/README.md` §1 y §2.1 se actualizan con los valores nuevos y una línea: «el generador aplica la marca FLITO (ADR-0050)».
3. **Excepción en el gate (B3).** Va en un archivo nuevo, `scripts/contraste-waivers.json`. Es la **única** fuente, y la leen el gate y el helper de axe:

   ```json
   {
     "adr": "docs/adr/ADR-0050-azul-557eff-waiver-contraste.md",
     "decision": "Waiver de contraste: decisión de David, 2026-11-26, docs/ux/flito-tramites-rediseno.md §6 (R3)",
     "color": "#557eff",
     "piso": 3.0,
     "pares": [
       { "tema": "claro",  "caso": "azul-texto/superficie",        "minimo": 3.61 },
       { "tema": "claro",  "caso": "azul-texto/fondo",             "minimo": 3.14 },
       { "tema": "claro",  "caso": "azul-texto/hover",             "minimo": 3.00 },
       { "tema": "claro",  "caso": "etiqueta/info",                "minimo": 3.23 },
       { "tema": "claro",  "caso": "blanco/boton-azul",            "minimo": 3.61 },
       { "tema": "claro",  "caso": "blanco/cabecera-menu-usuario", "minimo": 3.61 },
       { "tema": "claro",  "caso": "blanco/cabecera-dock",         "minimo": 3.61 },
       { "tema": "oscuro", "caso": "blanco/boton-azul",            "minimo": 3.61 },
       { "tema": "oscuro", "caso": "blanco/cabecera-menu-usuario", "minimo": 3.61 },
       { "tema": "oscuro", "caso": "blanco/cabecera-dock",         "minimo": 3.61 }
     ]
   }
   ```

   Reglas del gate:
   - `AA = 4.5` **no cambia**. Cada `caso()` del script gana una `clave` estable (la de la tabla), porque el `nombre` lleva el HEX y cambiaría con él.
   - **Atada al valor.** Una entrada solo aplica si el texto o el fondo del par resuelto es exactamente `color`. Si el azul se mueve a otro valor, ninguna entrada aplica y los pares vuelven a medirse contra 4,5.
   - **Piso por par.** Un par en la lista con un ratio menor que su `minimo` sigue siendo `FALLA`.
   - **Trinquete de obsolescencia.** El gate termina con `exit 1` en dos casos: si una entrada no corresponde a ningún caso medido, o si su par ya cumple 4,5. El mensaje es «retira la entrada del waiver». Así, volver a `#1d53ff` obliga a borrar el waiver en el mismo PR.
   - **Salida visible.** Cada par cubierto se imprime como `WAIVER 3.61:1 … (ADR-0050)`, no como `OK`, y el resumen da el conteo aparte (`n pares cumplen AA · m bajo waiver ADR-0050`).
   - La cabecera del script cita la decisión y este ADR.
4. **axe (C3).** `correrAxe` (`apps/web/e2e/helpers/axe.ts`) lee el mismo JSON.
   - Dentro del `evaluate` y **antes** de `resumir`, en las violaciones `color-contrast` descarta los nodos cuyo `any[0].data` cumple `fgColor === color` (texto azul) o `fgColor === '#ffffff' && bgColor === color` (blanco sobre relleno), siempre que además `contrastRatio >= piso` (3,0).
   - Si todos los nodos de la violación se descartan, la violación desaparece.
   - Los nodos descartados se imprimen como `[a11y · waiver ADR-0050] n nodos` (sin colores de fondo adicionales y con la redacción de selectores de siempre).
   - Cualquier otro nodo de `color-contrast`, o uno azul por debajo de 3,0, sigue fallando. No se toca ningún spec para apagar la regla.
   - Lo que el piso deja fuera: el texto azul sobre un tinte azul (2,56–2,84:1, Contexto §2) **no** queda cubierto. Donde la maqueta lo ponga (barra de selección, chip pulsado), la implementación usa un texto que cumpla. La pregunta 2 decide cuál.
5. **`grep -rni "1d53ff\|1746e0" apps/web/src` queda vacío** como criterio de aceptación del bloque.
6. **AGENTS.md §12 no se toca** en este ADR. La pregunta 1 queda para David.

## Consecuencias

- **Positivas:**
  - La marca es la del manual.
  - El generador vuelve a ser la única verdad, y su ejecución es idempotente, incluido el cursor.
  - La excepción es auditable: un archivo, diez pares, un color y su ADR.
  - El trinquete impide que el waiver sobreviva a su causa.
- **Negativas:**
  - Enlaces, botones secundarios y ghost, pestañas, chips `info` y `filtro-activo`, el paso actual y el texto de los primarios quedan entre 3,0 y 3,61:1, **en toda la app** (FLITO y legacy) y también en el canal Cliente del SOAT, cuyo público es externo.
  - Por debajo de AA para texto de tamaño normal (1.4.3). Cumplen 1.4.11 (no texto, ≥ 3) y el criterio de texto grande.
- **Neutras:** el tema oscuro queda igual, salvo el relleno de los botones, que pasa de 5,62 a 3,61 con texto blanco.
- **Riesgo normativo (no lo decide este ADR):** si algún cliente o contrato exige WCAG 2.x AA (por ejemplo, un cliente que sea sujeto obligado de la Resolución MinTIC 1519 de 2020), este waiver lo incumple en el texto azul. Hay que revisarlo antes de exponer más pantallas a público externo.

## Respuestas de David (2026-11-26)

1. **AGENTS.md §12:** sí, gana una línea de excepción acotada que remite a este ADR y a `scripts/contraste-waivers.json`. Solo los pares listados quedan exceptuados; todo lo demás sigue exigiendo 4,5:1. La línea entra en el mismo PR que el gate.
2. **Superficies con tinte azul** (barra de selección, chips pulsados): el texto va en **tinta** y se conserva el tinte. El waiver **no** se amplía por debajo de 3:1.
3. **Canal Cliente del SOAT:** el waiver aplica igual. Hay una sola marca visual en toda la app.

## Preguntas originales (ya respondidas arriba)

1. **¿AGENTS.md §12 gana una línea de excepción?** Propuesta: «… contraste ≥ 4.5:1, salvo los pares del waiver de ADR-0050 (`scripts/contraste-waivers.json`)». Sin esa línea, el agente de `flit-code-review` que aplique §12 al pie de la letra marcará cada PR que pinte texto azul.
2. **Texto azul sobre un tinte azul (2,56–2,84:1, por debajo incluso de 3:1).** ¿Qué se hace en la barra de selección y en los chips pulsados? Por defecto propongo que esas superficies usen el texto en tinta (`--color-text-primary`) y conserven el tinte, sin ampliar el waiver por debajo de 3:1.
3. **Canal Cliente del SOAT (público externo, trato de usted).** ¿El waiver aplica también ahí? Por defecto, sí: el azul es global y separarlo por canal sería drift del kit.
