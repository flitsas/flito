# UX slim: buscador de trámite en Revisiones OCR (BUG #14569, punto 8)

Mockup: `docs/ux/mockups/flito-revisiones-buscador-tramite.html` (pendiente: lo genera el hilo con este brief)
Modo: **slim**. Es una extensión de `apps/web/src/pages/FlitoRevisiones.tsx`, componente `Formulario`.
Público: operador interno (`admin` resuelve; auditor en solo lectura). Tono de la pantalla: **tú**
(«Selecciona el trámite…», «Escribe el valor correcto», «Deja constancia de qué validaste»). La ficha de
ayuda va en **usted**.

---

## Superficie tocada

Solo el campo **«Trámite contra el que se concilia \*»** del panel de detalle, más un aviso debajo
de él. No cambian la cola, el visor, la tabla Placa/VIN «Trámite vs Leído del PDF», los campos
editables ni los botones. Hoy el campo es un `<select>` nativo con hasta 200 candidatos traídos del
cliente: `GET /flito/soat?estado=solicitado&pageSize=200`, `GET /flito/impuestos?pageSize=200`
filtrado en el cliente, y `GET /flito/derechos/candidatos/:placa` (este último con la placa en el
path, que la regla 14 no permite). Ese `<select>` se reemplaza por un **combobox con búsqueda en el
servidor**, igual en los cuatro flujos (SOAT, impuestos, factura de venta y derechos).

Patrón base: `components/flit/FlitOrganismoCombobox.tsx`. El campo cerrado es un botón con el valor
elegido; al abrirlo se despliega un panel con un input de búsqueda y la lista. Se reutilizan su
estructura y sus tokens, con tres cambios de oficio: (a) la búsqueda va al servidor (asíncrona),
(b) se corrige el ARIA, porque el original anida `<button>` dentro de `role="option"` y no tiene
`aria-activedescendant`, y (c) el resaltado usa el token `--flit-bg-hover` en lugar del `rgba(...)`
en línea, que no tiene par oscuro. Componente sugerido: `components/flit/FlitTramiteCombobox.tsx`.
Recibe props, no consulta la API por su cuenta: la página le pasa `buscar(texto)`.

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer el revisor:** decir a qué trámite pertenece este documento y confirmarlo.
Primero ve el campo de trámite con la elección ya hecha cuando hay una sola opción posible. Si hay
varias, ve la lista ya filtrada por la placa o el VIN del documento.

- **Siempre visible en cada opción, en este orden:**
  1. **Número FLIT** (`idFlit`, en mono y semibold). Es el identificador que el revisor dicta y
     busca en el resto de FLITO.
  2. **Placa** (tabular). Es la llave del cruce.
  3. **Chip de coincidencia** a la derecha, solo si aplica: `Coincide placa y VIN` (success),
     `Coincide placa` (success) o `Coincide VIN` (success). Se compara contra lo que está **ahora**
     en los campos (leído o corregido), no contra el OCR original.
- **Segunda línea, en gris y truncada.** Es lo que distingue dos trámites con la misma placa:
  - SOAT: `marca línea · VIN …F21893`
  - Impuestos y factura de venta: `VIN …F21893` (con `marca línea` delante si la API la trae)
  - Derechos: `tipo de trámite · organismo` (sin VIN: el flujo de derechos no lo compara)
  - VIN **abreviado a los últimos 6**. El completo ya está en la tabla de comparación al elegir.
- **Lo que no se muestra:** el **estado** del trámite. Todos los candidatos de un flujo están en el
  mismo estado (`solicitado` en SOAT e impuestos, `pendiente` en factura de venta, vivo en derechos),
  así que no distingue nada. **Excepción en derechos:** un trámite que **ya tiene su derecho**
  aparece deshabilitado con el chip `Ya tiene derecho` (neutral), en vez de desaparecer. Si no
  aparece, quien busca ese número FLIT ve «sin resultados» y cree que el número está mal. Hoy se
  excluye: ver «Decisiones abiertas».
- **Densidad:** **se alivia.** Se pasa de 200 opciones sin buscador a como máximo 20 filtradas y
  ordenadas. No se añade ningún botón ni columna al panel.
- **Orden de resultados (servidor):** placa y VIN > solo placa > solo VIN > coincidencia del texto
  por prefijo de número FLIT o placa > el resto. Dentro de cada grupo, el más reciente primero.
- **Primaria:** no cambia. Sigue siendo **Confirmar y resolver**, habilitado solo con un trámite
  elegido. El combobox no lleva botones con peso; «Cambiar» y «Reintentar» son enlaces o botones
  secundarios.

### Cómo se calcula la búsqueda (texto efectivo)

| Situación | Qué busca la lista |
|---|---|
| El revisor escribió en el input del panel (≥ 3 caracteres) | Ese texto, contra placa, VIN y número FLIT |
| No escribió nada y hay placa o VIN en los campos | **Auto-filtro**: la placa y el VIN de los campos (leídos o corregidos) |
| No escribió nada y no hay placa ni VIN | Nada: pista para escribir (no se lista todo) |

Normalización (en la API y en la comparación del chip): mayúsculas, sin espacios ni guiones, igual
que `norm()` de la página. Debounce de 300 ms al escribir y al corregir un campo.

### Auto-filtro y preselección

- Se evalúa al abrir la revisión y cada vez que cambian los campos **Placa** o **VIN**, después del
  debounce.
- **Si queda exactamente un candidato seleccionable** y no hay una elección del revisor
  (`revision.registroId` vacío y nadie eligió a mano), se preselecciona. Debajo del campo aparece
  el aviso de elección automática (ver copy). Desde ahí se aplica todo lo demás: la tabla de
  comparación aparece y **Confirmar y resolver** se habilita.
- **Con 0 o 2 o más candidatos** no se preselecciona. Al abrir el panel, la lista ya viene
  filtrada.
- Nunca se pisa una elección hecha a mano, ni un `revision.registroId` que ya traía la revisión.

### Si el revisor corrige la placa después de elegir (recomendación)

Se distinguen dos orígenes de la selección:

| Selección | El revisor corrige Placa o VIN en los campos | Por qué |
|---|---|---|
| **Automática** (por auto-filtro) | **La selección sigue a los campos.** Si con el valor nuevo hay otro único candidato, se cambia y el aviso se actualiza. Si hay 0 o varios, se **quita** la selección y el aviso dice que hay que elegir. | La eligió el sistema por la placa; si la placa cambia, la razón de esa elección ya no existe. |
| **Manual** | **No se cambia.** Si la placa o el VIN del trámite elegido dejan de cruzar con los campos, aparece un aviso de advertencia con la acción `Buscar con <PLACA>`, que abre el panel filtrado por el valor nuevo. | El revisor decidió con el documento a la vista. Cambiarle la decisión por una tecla es peor que avisarle. La tabla de comparación ya marca ✗, y el aviso dice qué hacer. |

El aviso de discrepancia **no bloquea** Confirmar y resolver: el revisor puede tener razón (el OCR
leyó otra placa y él corrigió un dato que no es la llave). Queda escrito y él decide.

---

## Wireframes (ancho del panel de detalle)

Cerrado, sin selección (hay varios candidatos o no hay placa):

```
Trámite contra el que se concilia *
┌──────────────────────────────────────────────────────┐
│ Selecciona el trámite…                             ▾ │
└──────────────────────────────────────────────────────┘
```

**1. Abierto, sin texto y sin placa ni VIN en los campos (pista):**

```
┌──────────────────────────────────────────────────────┐
│ Selecciona el trámite…                             ▴ │
├──────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────┐ │
│ │ Placa, VIN o número FLIT                         │ │
│ └──────────────────────────────────────────────────┘ │
│  Escribe al menos 3 caracteres de la placa, el VIN   │
│  o el número FLIT para buscar el trámite.            │
└──────────────────────────────────────────────────────┘
```

**2. Escribiendo / cargando** (esqueleto de 3 filas con la forma de la opción, sin spinner):

```
│ ┌──────────────────────────────────────────────────┐ │
│ │ KPX4                                             │ │
│ └──────────────────────────────────────────────────┘ │
│  ▒▒▒▒▒▒▒▒▒▒ · ▒▒▒▒▒▒                                 │
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                                  │
│  ▒▒▒▒▒▒▒▒▒▒ · ▒▒▒▒▒▒                                 │
│  …                                    (Buscando…  sr)│
```

**3. Con resultados (auto-filtro por la placa del documento):**

```
│ ┌──────────────────────────────────────────────────┐ │
│ │ Placa, VIN o número FLIT                         │ │
│ └──────────────────────────────────────────────────┘ │
│  Filtrado por la placa KPX482 y el VIN del documento │
├──────────────────────────────────────────────────────┤
│▌F-24-001532 · KPX482           [Coincide placa y VIN]│ ← resaltada
│▌Chevrolet Spark GT · VIN …F21893                     │
├──────────────────────────────────────────────────────┤
│ F-24-001498 · KPX482               [Coincide placa]  │
│ Chevrolet Spark GT · VIN …A07714                     │
├──────────────────────────────────────────────────────┤
│ F-24-000977 · KPX428                                 │
│ Renault Logan · VIN …C33120                          │
└──────────────────────────────────────────────────────┘
```

La opción ya elegida lleva ✓ al inicio y `aria-selected="true"`. La resaltada por teclado o
puntero lleva el velo `--flit-bg-hover`.

**4. Sin resultados:**

```
│ │ KPX999                                           │ │
│  No hay trámites por elegir con «KPX999».            │
│  Revisa la placa o busca por el número FLIT. Si el   │
│  documento no es de ningún trámite, descártalo.      │
```

**5. Error con reintento** (dentro del panel, fuera del `listbox`):

```
│ │ KPX482                                           │ │
│  No pudimos buscar los trámites.   [ Reintentar ]    │
```

**6. Preseleccionado por auto-filtro** (cerrado):

```
Trámite contra el que se concilia *
┌──────────────────────────────────────────────────────┐
│ F-24-001532 · KPX482 · Chevrolet Spark GT          ▾ │
└──────────────────────────────────────────────────────┘
ⓘ Elegido automáticamente: es el único trámite con la placa
  KPX482. Cambiar
┌ tabla Campo | Trámite | Leído del PDF (sin cambios) ┐
```

**6b. Elección manual que ya no cruza con lo corregido:**

```
┌──────────────────────────────────────────────────────┐
│ F-24-001498 · KPX482 · Chevrolet Spark GT          ▾ │
└──────────────────────────────────────────────────────┘
⚠ La placa de los campos (KPX428) no es la del trámite
  elegido (KPX482). Revisa cuál corresponde.  Buscar con KPX428
```

**7. Resultado truncado** (pie del panel, después de la opción 20):

```
│ F-24-000611 · KPX4A1                                 │
├──────────────────────────────────────────────────────┤
│  Hay más trámites que coinciden. Escribe más de la   │
│  placa, el VIN o el número FLIT para afinar.         │
```

**8. Deshabilitado (Solo lectura o revisión Resuelta):**

```
Trámite contra el que se concilia *
┌──────────────────────────────────────────────────────┐
│ F-24-001532 · KPX482 · Chevrolet Spark GT            │  (sin ▾, opacity del kit)
└──────────────────────────────────────────────────────┘
```

Sin trámite asociado (por ejemplo, una revisión descartada): `Sin trámite asociado`. No se abre el
panel, no hay avisos de auto-filtro y la tabla de comparación se sigue mostrando si hay trámite.

**Opción deshabilitada (solo derechos):**

```
│ F-24-000812 · KPX482                [Ya tiene derecho] │  (texto muted, aria-disabled)
│ Traspaso · 05001                                       │
```

## Estados (4) + copy exacto (tú)

| Estado | Dónde | Copy |
|---|---|---|
| Cargando | Panel (esqueleto de 3 filas) + región `role="status"` | sr: `Buscando trámites…` |
| Error | Panel, encima del listbox | `No pudimos buscar los trámites.` + botón secundario **Reintentar** (repite la última búsqueda) |
| Vacío (sin texto ni placa) | Panel | `Escribe al menos 3 caracteres de la placa, el VIN o el número FLIT para buscar el trámite.` |
| Vacío (sin resultados) | Panel | `No hay trámites por elegir con «<texto>».` / `Revisa la placa o busca por el número FLIT. Si el documento no es de ningún trámite, descártalo.` |
| Lleno | Listbox | Opciones como en el wireframe 3. Encabezado de auto-filtro: `Filtrado por la placa <PLACA> del documento`, `Filtrado por el VIN …<6> del documento` o `Filtrado por la placa <PLACA> y el VIN del documento` |
| Truncado | Pie del panel | `Hay más trámites que coinciden. Escribe más de la placa, el VIN o el número FLIT para afinar.` |

Otro copy:

- Trigger sin selección: `Selecciona el trámite…` (se mantiene).
- Placeholder del input: `Placa, VIN o número FLIT`.
- Etiqueta del trigger con selección: `<idFlit> · <placa> · <marca línea | tipo de trámite>`
  (truncada con ellipsis).
- Aviso de auto-selección (`role="status"`, tono info, con el patrón de aviso en página de la
  propia pantalla): `Elegido automáticamente: es el único trámite con la placa <PLACA>.` + botón
  de texto **Cambiar**, que abre el panel. Si el cruce fue por VIN: `…es el único trámite con el VIN …<6>.`
- Auto-selección retirada (la placa cambió y ya no hay uno solo):
  `Cambiaste la placa y ya no hay un único trámite que coincida. Elige uno.`
- Discrepancia con elección manual (tono warning, tinta `--flit-warning-*`/`--flit-danger-ink` del
  kit, nunca `text-red-600`):
  `La placa de los campos (<PLACA_CAMPO>) no es la del trámite elegido (<PLACA_TRÁMITE>). Revisa cuál corresponde.` + **Buscar con <PLACA_CAMPO>**.
  En VIN: `El VIN de los campos (…<6>) no es el del trámite elegido (…<6>). Revisa cuál corresponde.`
- Chips: `Coincide placa y VIN` · `Coincide placa` · `Coincide VIN` · `Ya tiene derecho`.

**Notificaciones:** ninguna acción de este control lanza toast. La auto-selección y la discrepancia
son estado que sigue siendo cierto mientras miras la página, así que van en **aviso en página**. El
error de búsqueda va en línea dentro del panel. El resultado de Resolver/Descartar no cambia (sigue
su flujo actual).

## Interacción y teclado (patrón combobox ARIA 1.2, con lista de selección y filtro)

Estructura (calca la de `FlitOrganismoCombobox`, con el ARIA corregido):

- **Label:** el rótulo de `FlitField` es un `<label htmlFor={triggerId}>`. Si `FlitField` no lo
  asocia, se pasa `id` + `aria-labelledby`. El trigger lleva `aria-required="true"`.
- **Trigger** `<button type="button">`: `aria-haspopup="listbox"`, `aria-expanded`,
  `aria-controls={listboxId}`, `aria-describedby` → id del aviso (auto-selección o discrepancia)
  cuando existe.
- **Input de búsqueda** en el panel: `role="combobox"`, `aria-expanded="true"`,
  `aria-controls={listboxId}`, `aria-autocomplete="list"`,
  `aria-activedescendant={id de la opción resaltada}`,
  `aria-label="Buscar trámite por placa, VIN o número FLIT"`, `autoComplete="off"`.
- **Listbox** `<ul role="listbox" aria-label="Trámites">`: cada opción es
  `<li role="option" id=… aria-selected>`. **Sin `<button>` dentro**: el clic va en el `li`. Las
  opciones no seleccionables llevan `aria-disabled="true"`.
- **Región viva** (`role="status"`, `aria-live="polite"`, visualmente oculta) con
  `Buscando trámites…`, `<n> trámites` o `Hay más de 20 trámites; afina la búsqueda`, y el texto
  de sin resultados.

| Tecla | Trigger (cerrado) | Input (abierto) |
|---|---|---|
| `Enter` / `Space` / `↓` | Abre el panel; el foco va al input; se resalta la opción elegida o la primera | `Enter`: elige la resaltada (si no está deshabilitada), cierra y devuelve el foco al trigger |
| `↓` / `↑` | — | Mueve el resaltado (salta las deshabilitadas, no da la vuelta) y desplaza la lista para mantenerla visible |
| `Home` / `End` | — | En el input mueven el cursor del texto (no la lista) |
| `Esc` | — | Cierra **sin cambiar** la selección y devuelve el foco al trigger. Un segundo `Esc` no hace nada más |
| `Tab` | Sigue el orden normal | Cierra sin elegir y continúa al siguiente control |
| Clic fuera | — | Cierra sin elegir |

Elegir una opción a mano marca la selección como **manual** y quita el aviso de auto-selección.

**Feedback (obligatorio):** el trigger lleva hover con borde `--flit-border-input` → tono de hover
del kit y `flit-focus`. Las opciones llevan hover y resaltado con el velo `--flit-bg-hover` y
`transition-colors` corta. Los botones de texto «Cambiar», «Buscar con …» y «Reintentar» llevan
hover con subrayado o velo y `flit-focus`. El chevron puede girar como en el original; es feedback
de estado y no adorno, pero sin animación extra. Deshabilitado: `disabled` nativo y la opacidad
del kit, sin hover.

## Responsive (<lg) y táctil

- El panel de detalle ya cae debajo del visor en pantallas pequeñas: el combobox ocupa el **100 %
  del ancho** de la columna. A 375 px, sin `min-w`.
- **Bajo `lg`:** el trigger, el input y cada opción con **mínimo 44 px de alto** (táctil).
  «Cambiar», «Buscar con …» y «Reintentar» con área táctil de 44 px (padding, no tamaño de letra).
- La lista: `max-h` de ~`60vh` bajo `lg` (`max-h-52` en escritorio, como el original), con scroll
  interno. Nunca desborda la página.
- La opción a 375: la línea 1 (`idFlit · placa`) no se trunca. El chip de coincidencia **pasa
  debajo** de la línea 1 (`flex-wrap`) en vez de comérsela. La línea 2 se trunca con ellipsis.
- El panel no se convierte en hoja inferior ni en modal: el mismo desplegable bajo el campo, como
  `FlitOrganismoCombobox`.
- Los avisos envuelven en varias líneas. La acción («Cambiar», «Buscar con …») baja de línea si no
  cabe.

## Permiso/slug

Sin cambio: la misma página y el mismo `PageSlug` de Revisiones OCR. `admin` busca y elige. El
**auditor** (`soloLectura`) ve el trigger deshabilitado con el trámite asociado y no dispara
búsquedas ni auto-selección. Revisión `resuelto`: igual que el auditor.

## Datos: requerimiento para architecture-agent / backend-agent

No existe un endpoint que busque candidatos en servidor en los cuatro flujos. Hoy se paginan 200 en
el cliente, y en derechos la placa va en el path (`/flito/derechos/candidatos/:placa`), cosa que
prohíbe `AGENTS.md` §14. Propuesta (a confirmar por architecture):

- `POST /api/flito/revisiones/:id/candidatos/buscar` (módulo `flito-revisiones`). Con el `:id` de la
  revisión (uuid opaco) el servidor sabe el flujo y el estado de los candidatos válidos.
- **Body** (no query, por §14): `{ texto?: string, placa?: string, vin?: string, limite?: 20 }`.
  `texto` busca por prefijo o contenido en placa, VIN e `idFlit`. `placa` y `vin` son el auto-filtro.
- **Respuesta:** `{ items: CandidatoTramite[], hayMas: boolean }`, con
  `CandidatoTramite = { id, idFlit, placa, vinUltimos6, detalle, coincide: 'placa_vin'|'placa'|'vin'|null, seleccionable: boolean, motivoNoSeleccionable?: 'ya_tiene_derecho' }`.
  `detalle` lo arma el servidor por flujo (`marca línea` / `tipo de trámite · organismo`).
  **SOAT necesita `idFlit`** en el DTO: el `SoatItem` actual no lo tiene.
- **Trámite ya asociado:** la revisión (o un `GET …/:id/candidato-actual`) debe traer el resumen del
  `registroId` (`idFlit`, `placa`, `detalle`). Así el trigger muestra la etiqueta en Resuelta / Solo
  lectura y cuando el trámite no está entre los resultados. Hoy, si el trámite no está entre los
  200, el `<select>` lo muestra vacío.
- `authMiddleware` + `requireRole` igual que la cola. Placa y VIN son datos del vehículo, no del
  titular. `security-agent` diff-scoped decide si aplica `logPiiAccess` (ruta nueva: el gate de
  seguridad dispara).
- Comprobación de tipos: en cuanto `CandidatoTramite` entre a `shared-types`, grep de sus usos en
  `apps/web`.

## Notas para QA (≤10)

1. En los 4 flujos, abrir una revisión con placa leída y **un** solo candidato: queda preseleccionado,
   se ve el aviso «Elegido automáticamente…», la tabla de comparación aparece y Confirmar y resolver
   se habilita.
2. Con 2 o más candidatos de la misma placa: no se preselecciona. Al abrir el panel se ve la lista
   filtrada, con el chip correcto y el orden placa y VIN > placa > VIN.
3. Buscar por número FLIT, por placa parcial (≥ 3) y por VIN completo: encuentra trámites fuera de
   los primeros 200 del módulo.
4. Corregir la placa con una selección **automática**: la selección se reevalúa (cambia, o se quita
   con su aviso). Con una selección **manual**: se mantiene y aparece el aviso de discrepancia con
   «Buscar con …».
5. Nunca se pisa un `registroId` que ya traía la revisión.
6. Más de 20 coincidencias: se ve el pie «Hay más trámites…».
7. Error de red en la búsqueda: se ve el mensaje del panel y **Reintentar** repite la búsqueda. No
   hay toast ni texto crudo del API.
8. Teclado completo sin ratón: abrir, filtrar, ↓/↑, Enter, Esc devuelve el foco al trigger sin
   cambiar la selección. Un lector de pantalla anuncia la opción activa (`aria-activedescendant`) y
   el número de resultados.
9. Auditor y Resuelta: el trigger está deshabilitado con la etiqueta del trámite asociado y no hay
   búsquedas en la red.
10. A 375 px: controles de 44 px, sin desborde horizontal, el chip baja de línea. Revisar en tema
    claro y oscuro (resaltado con token, no fosforescente).

## Delta para la ficha de ayuda (`apps/web/src/content/ayuda/flito_revisiones.md`, paso 3)

Reemplazar el paso 3 por (usted):

> 3. En **Trámite contra el que se concilia**, el trámite aparece elegido cuando es el único que
> coincide con la placa o el VIN del documento; lo indica el aviso **Elegido automáticamente**, y
> puede pulsar **Cambiar** para elegir otro. Si no viene elegido, pulse el campo y escriba la placa,
> el VIN o el número FLIT: la lista muestra el número FLIT y la placa de cada trámite, y marca
> **Coincide placa**, **Coincide VIN** o **Coincide placa y VIN**. Si aparece **Hay más trámites
> que coinciden**, escriba más caracteres para afinar. Al elegirlo, aparece una tabla que compara
> **Placa** y **VIN** del trámite con lo **Leído del PDF**, con ✓ si cruzan y ✗ si no. Corrija en
> cada campo el valor que no corresponda; si corrige la placa y ya no es la del trámite elegido, un
> aviso se lo dice y **Buscar con** la placa nueva le muestra los trámites que sí coinciden.

Y además:

- En **Estados → Error**, añadir: `Si la búsqueda de trámites falla, el campo muestra **No pudimos
  buscar los trámites.** con **Reintentar**.`
- Subir `version` a `1.3` y actualizar la `fecha`.
- **Recapturar** `./flito_revisiones/02-revisar-campos.png` con el combobox (el alt pasa a «Trámite
  elegido automáticamente en el buscador y tabla que compara placa y VIN…»).
- Añadir a `consultas`: `cómo busco el trámite de un documento en revisión`.

## Decisiones y descartes

- **Combobox en vez de `<select>` con más opciones:** con 200 o más opciones y sin búsqueda, el
  `<select>` no escala. El kit ya tiene el patrón (`FlitOrganismoCombobox`) y se reutiliza, no se
  inventa.
- **Descartado listar todo al abrir sin texto:** sin placa no hay un orden útil, y traer cientos
  repite el problema. Se muestra una pista para escribir.
- **Descartado autocompletar el texto del input con la placa leída:** el filtro se dice en un
  encabezado («Filtrado por la placa…») y el input queda libre. Así se distingue «lo que yo escribí»
  de «lo que filtró el sistema».
- **Descartado un toast para la auto-selección:** es estado persistente y va en aviso en página
  (principios, Notificaciones).
- **Descartado el estado en la opción:** no distingue nada dentro de un flujo y solo agrega ruido.
- **Descartado resaltar la subcadena encontrada:** el chip de coincidencia ya dice lo importante.
  Menos marcas.
- **La discrepancia con una elección manual no bloquea la primaria:** la decisión es del revisor, y
  la tabla ✓/✗ más el aviso bastan.
- Sin animaciones, sombras ni efectos nuevos: la sombra del panel es la del kit
  (`--flit-shadow-card`).

### Decisiones abiertas (para el PO)

1. **Derechos: ¿mostrar deshabilitado («Ya tiene derecho») el trámite que ya tiene su derecho, o
   seguir ocultándolo?** Recomiendo mostrarlo deshabilitado: evita un «sin resultados» engañoso
   cuando se busca ese número FLIT.
2. **Derechos sin placa leída:** hoy no se ofrece ningún candidato («se resuelve desde el trámite»).
   Con el buscador, el revisor podría buscar por número FLIT. Recomiendo permitirlo: es lo que pide
   la decisión 1 del humano, «todos los módulos».

---

## Brief de mockup

Archivo: `docs/ux/mockups/flito-revisiones-buscador-tramite.html` (autocontenido, clases Tailwind y
tokens `--flit-*` de `flit-tokens.css`, sin HEX sueltos y sin JS de negocio). Capturas a 1366×768 y
375×812, en tema claro y oscuro: `docs/ux/mockups/flito-revisiones-buscador-tramite-<estado>.png`.

- **Contexto fijo en cada vista:** el panel de detalle de `Formulario`, con los chips `Comprobante
  SOAT` (neutral) y `Varias coincidencias` (warning), una línea de detalle, el campo **Trámite contra
  el que se concilia \***, la tabla Campo/Trámite/Leído del PDF (cuando hay selección), dos campos
  (Placa, VIN) con su `StatusChip` de confianza, y los botones **Confirmar y resolver**
  (`flitBtnPrimary`) y **Descartar documento** (`flitBtnSecondary`). El visor y la cola no se
  dibujan: basta un borde de columna.
- **Componentes:** `FlitField`, `flitInp`, el trigger y el panel calcados de `FlitOrganismoCombobox`
  (resaltado con `--flit-bg-hover`), `StatusChip` (success para coincidencias, neutral para «Ya
  tiene derecho»), los botones del kit y el aviso en página de la propia pantalla (borde
  `--flit-border-soft`).
- **Vistas (una sección cada una):** 1 abierto con la pista · 2 cargando con esqueleto · 3 resultados
  filtrados por placa (3 opciones, wireframe 3) · 4 sin resultados · 5 error con Reintentar ·
  6 preseleccionado con el aviso y **Cambiar** · 6b discrepancia con una elección manual ·
  7 truncado con el pie · 8 deshabilitado (Resuelta) · 9 opción de derechos «Ya tiene derecho» ·
  10 el estado 3 a 375 px con el chip bajo la línea 1.
- **Datos ficticios** (sin PII real): números FLIT `F-24-001532`, `F-24-001498`, `F-24-000977`,
  `F-24-000812`; placas `KPX482`, `KPX428`, `KPX999`; VIN terminados en `…F21893`, `…A07714`,
  `…C33120`; `Chevrolet Spark GT`, `Renault Logan`; derechos `Traspaso · 05001`.
- **Copy:** exactamente el de «Estados (4) + copy exacto».
- **Qué no se muestra:** el estado del trámite, el VIN completo en la lista, toasts, columnas o
  botones nuevos.
