# UX slim — «Estado en la fuente» completo en la tabla de Registros (HU #11777)

> **Qué es este documento.** Una decisión sobre **una sola celda** de la tabla del visor de
> comparendos, con las alternativas que se descartaron y por qué. Es la entrada del `frontend-agent`
> que implemente la HU [#11777](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/11777)
> (hija del Feature #11563).
>
> **Extiende `docs/ux/flito-comparendos-visor.md` y REVOCA tres frases suyas.** Están listadas al
> final, en «Qué queda desactualizado». No se reescribe aquel documento desde aquí: lo que se decidió
> un día y se revocó otro es parte del expediente, y esa es la convención que ese archivo ya sigue.
>
> Modo **slim**: solo se especifica lo que cambia. El resto de la tabla —columnas, orden, niveles
> A/B, permisos, filtros, paginación, los cuatro estados de la página— sigue tal cual está escrito en
> el documento del visor.

---

## Superficie tocada

| | |
|---|---|
| Página | `/flito/comparendos`, pestaña **Registros** |
| Componente | `apps/web/src/components/flito/comparendos/TablaComparendos.tsx` |
| Celda | Columna **«Estado en la fuente»** (nivel B), hoy en la línea ~225 |
| Slug / permiso | `flito_comparendos`, **sin cambios**. Solo `admin` (el router exige `requireRole('admin')`). Ni un condicional de rol nuevo |
| Endpoints | **Ninguno nuevo.** `estadoFuente` ya viaja en `ComparendoRegistro` desde la HU #11712 |
| Export | **Sin cambios.** Un `.xlsx` no tiene recorte tipográfico; el problema es solo de pantalla |

Lo que hay hoy, y es todo el defecto:

```tsx
<CeldaB><span className="line-clamp-1 max-w-[11rem]">{c.estadoFuente ?? SIN_DATO}</span></CeldaB>
```

### Los tres hechos que mandan sobre la decisión

1. **El dato está acotado por el esquema: `estado_fuente` es `varchar(80)`** (`apps/api/src/db/schema.ts:4388`).
   El peor caso no es «un texto largo», es **80 caracteres**, y eso es una cantidad que se puede
   dibujar. Los valores reales observados son mucho más cortos: «Pagado» (6), «Se adeuda» (9),
   «Notificado» (10), «EN COBRO COACTIVO» (17), «Pendiente de pago» (17).
2. **El alto de fila uniforme ya no existe en esta tabla, y no lo rompe esta HU.** La celda del NIT
   añade una segunda línea cuando hay alias; la de «Gestión» añade otra cuando hay
   `gestionActualizadaEn`. Hoy conviven filas de ~44 px con filas de ~62 px según los datos. El
   argumento de la #11713 —«que una frase de 80 caracteres no convierta una fila en cuatro»— seguía
   siendo bueno, pero **defendía una cota, no una uniformidad**: lo que había que impedir era el
   crecimiento *sin techo*, no el crecimiento.
3. **El ancho es el recurso escaso, no el alto.** Trece columnas (catorce con «Inactivado») dentro de
   un `overflow-x-auto` que a 1280 px ya desplaza. La #11713 pagó las dos columnas nuevas retirando
   «Organismo». Cualquier alternativa que compre ancho vuelve a abrir esa negociación; las que pagan
   en alto, no.

---

## Alternativas evaluadas

Se ordenan por lo que cuestan, no por lo que gustan. «Ancho» es ancho añadido a la tabla; «peor caso»
es el estado de 80 caracteres.

| # | Alternativa | Ancho | Peor caso | Veredicto |
|---|---|---|---|---|
| 1 | **`line-clamp-2` a 11 rem** | 0 | ~50 de 80 caracteres | **Descartada.** Es la peor de todas: sigue habiendo recorte, sigue sin anunciarse y sigue sin `title`. Muestra más y **miente igual**. El PO pidió el estado completo, no más estado |
| 2 | **Envolver sin ningún límite a 11 rem** | 0 | 4 líneas (~100 px) | **Descartada como está**, pero es la base de la elegida. Le faltan dos cosas: un techo por si el contrato del campo cambia, y qué hacer con una palabra de 80 caracteres sin espacios (rompe el ancho de la columna) |
| 3 | **Ensanchar a 21 rem con `line-clamp-2`** | +10 rem | 2 líneas, alto casi estable | **Descartada.** 10 rem es casi lo que costaba «Organismo», la columna que la #11713 retiró para hacer sitio a esta. Reabrir esa negociación por una línea de alto es cambiar el recurso escaso por el abundante |
| 4 | **Subir la columna de nivel B a nivel A** | +0, pero empuja | idéntico | **Descartada, y no resuelve nada.** El recorte lo causa el ancho de la celda, no el breakpoint. Además empujaría a la derecha columnas de nivel A dentro de un scroll que ya desplaza — el argumento con el que la #11713 la puso al principio del bloque B, palabra por palabra |
| 5 | **Revelación progresiva accesible** (botón «ver estado completo» + popover) | 0 | completo, oculto por defecto | **Descartada por tres motivos independientes.** Para cumplir a11y hace falta un `<button>` real por fila: **+50 paradas de tabulador** en una tabla que fija *una por fila* (#11562, AC1 y AC8). No existe patrón de popover en `components/flit/` — sería inventar uno (regla 3). Y **esconde por defecto justo el dato que el PO llama vital**: convierte un problema de lectura en un problema de descubrimiento |
| 6 | **Fila expandible (acordeón)** | 0 | completo | **Descartada.** Patrón nuevo, estado por fila, y compite con el panel de detalle: dos maneras de abrir la misma fila es cómo se aprende a no usar ninguna |
| 7 | **Chip con el estado** | +padding | idéntico | **Descartada.** La decisión 9 del visor prohíbe darle tono cromático a `estadoFuente` —no está enumerado, y el proveedor que mañana escriba «PAGADO PARCIAL» caería en el color de «PAGADO»—. Y un chip no acorta el texto: lo alarga con su relleno |
| 8 | **Alto uniforme mayor: todas las filas a 3 líneas** | 0 | completo, alto estable | **Descartada.** Recupera la uniformidad a un precio absurdo: ~36 px × 50 filas ≈ **1.800 px más de scroll vertical en cada página**, para un caso que afecta a unas pocas filas. Pagar en todas las filas un problema de unas pocas |
| 9 | **Bajar esa celda a `text-xs`** | 0 | ~65 de 80 caracteres | **Descartada.** Gana un 15 % de caracteres por línea, no llega a 80, y deja la única columna de la tabla con letra más pequeña que las demás: una jerarquía visual que nadie decidió |
| 10 | **Normalizar o truncar en el servidor** | 0 | — | **Descartada por contrato.** «Texto tal cual» es una restricción de producto: el operador puede tener que citarle el estado al organismo |
| 11 | **Ancho variable por breakpoint** (`14rem` / `2xl:20rem`) | variable | 3 líneas a 1280, 2 a 1920 | **Descartada.** Un ancho que depende del viewport hace que **el alto de fila dependa del viewport**, y las pruebas que miden altos tendrían que fijar dos anchos y dos expectativas. El beneficio —una línea menos en un caso raro y en pantallas grandes— no paga esa complejidad |

---

## La decisión

> **Se muestra entero, envolviendo el texto, con la columna a 14 rem y un tope de 4 líneas que dentro
> del contrato nunca llega a actuar.**
>
> **Frase citable en el PR:** *el estado de la fuente está acotado a 80 caracteres por el esquema
> (`varchar(80)`), que a 14 rem caben en tres líneas; la fila crece 36 px en el peor caso —menos de
> lo que ya crece hoy una fila que trae alias y gestión— y a cambio desaparece el único recorte de la
> tabla que no se anunciaba de ninguna manera.*

**Es una solución total, no parcial**, y la palabra «total» tiene un alcance exacto: **para todo dato
que el contrato actual puede producir**. Un `varchar(80)` no puede entregar 81 caracteres. El tope de
4 líneas es un **airbag**, no un recorte: solo actúa si algún día el backend amplía la columna sin
avisar, y en ese caso el valor completo sigue estando en el panel de detalle. Esa es toda la parte
«parcial» que queda, y está condicionada a que el servidor rompa su propia cota.

**Lo que se pierde, dicho sin adornos:**

- **La uniformidad del alto de fila como invariante**, que es lo que afirma hoy la prueba `AC2+AC5`.
  Una fila con un estado de 80 caracteres medirá ~80 px frente a los ~44 px de una corta.
  Atenuante: esa uniformidad ya estaba rota por el alias del NIT y por la segunda línea de «Gestión»,
  así que lo que se pierde es una regla que la tabla no cumplía.
- **48 px más de desplazamiento horizontal a 1280 px.** Se declara y se acepta: es el 22 % de lo que
  la #11713 liberó al retirar «Organismo», gastado en la columna que ocupó su sitio.
- **El ritmo de lectura «una fila, una línea»** en páginas con estados largos. Lo compensa el
  `align-top` (abajo): con todas las celdas alineadas arriba, una fila alta se lee como un bloque y
  no como columnas flotando a distintas alturas.

---

## Detalle accionable

### La celda

> ### Corrección medida al implementar (HU #11777, 24 ago 2026)
>
> La decisión —mostrarlo entero, envolviendo, a 14 rem, con un tope que dentro del contrato no
> actúa— **se implementó tal cual**. Lo que no sobrevivió al navegador fueron **dos números y una
> clase que faltaba**. Se corrige aquí en vez de dejar que el código y el documento digan cosas
> distintas:
>
> | Lo que decía | Lo medido en Chromium (`text-sm`, interlínea 20 px, viewport 1280/1600/1920/2400) |
> |---|---|
> | ~~`class="line-clamp-4 max-w-[14rem] wrap-anywhere"`~~ | **`line-clamp-6 min-w-[14rem] max-w-[14rem] wrap-anywhere`** |
> | ~~«80 caracteres caben en 3 líneas a 14 rem»~~ | **4 líneas** con un estado real de 80 caracteres; **5 líneas** con el peor caso que el contrato admite (`'W'.repeat(80)`, legal en un `varchar(80)`) |
> | ~~«el tope de 4 líneas tiene margen de sobra»~~ | Un `line-clamp-4` **recorta** el peor caso (`scrollHeight` 100 px contra `clientHeight` 80) → **AC1 falso**. Con `-6` queda una línea de margen sobre lo medido |
> | ~~`schema.ts:4368`~~ | El `varchar(80)` está en **`schema.ts:4388`** — verificado con `grep`. El tipo era correcto; la línea, no |
> | El `max-w-[14rem]` como único control del ancho | **No basta**: la tabla es de layout automático y a 1280-1600 px **ya desborda**, así que el reparto aprieta cada columna contra su mínimo, y con `wrap-anywhere` el mínimo es *un carácter*. Sin `min-w`, la columna se quedaba en **49 px** de contenido y el estado seguía recortado a 4 líneas: **el defecto intacto**. Con `min-w` la tabla pasa de 1728 a 1776 px = **exactamente los +48 px** que este documento ya declaraba |
>
> Lo que **no** cambió: el ancho de 14 rem, el coste de 48 px, `wrap-anywhere` (sin él, 734 px de
> texto en una caja de 224 → corte horizontal mudo), el `align-top`, las prohibiciones de `title` y
> `text-transform`, y que el tope sea un airbag que dentro de `varchar(80)` nunca actúa.
>
> Moraleja para la próxima decisión de este tipo: **`max-width` no es un ancho de columna en una
> tabla `auto` que ya desborda**, y el ancho medio de carácter no acota nada — lo que acota es el
> carácter más ancho.

```tsx
{/* HU #11777. Se envuelve hasta MOSTRARLO ENTERO, no se recorta a una línea.
    · `wrap-anywhere` (Tailwind v4.1) y no `break-words`: además de partir la palabra que no cabe,
      es el único que NO infla la contribución de tamaño mínimo de la celda, y esta tabla es de
      layout automático. Un estado de 80 caracteres sin un solo espacio —los hay— ensancharía la
      columna hasta romper el reparto, o quedaría cortado en horizontal por el `overflow` del clamp.
    · `line-clamp-4` es un AIRBAG, no un recorte: `estado_fuente` es `varchar(80)` (schema.ts:4388)
      y 80 caracteres caben en 3 líneas a 14 rem, así que dentro del contrato nunca actúa. Existe
      para que ampliar la columna en la base no convierta una fila en quince líneas sin que nadie
      se entere. Si algún día actúa, el valor entero sigue en el panel de detalle.
    · Sigue SIN `title` y SIN transformación de texto: las dos prohibiciones de la #11713 siguen
      vigentes y por las mismas razones. */}
<CeldaB>
  {/* line-clamp-4 → line-clamp-6 y + min-w-[14rem]: ver la corrección medida de arriba. */}
  <span className="line-clamp-6 min-w-[14rem] max-w-[14rem] wrap-anywhere">{c.estadoFuente ?? SIN_DATO}</span>
</CeldaB>
```

### La alineación vertical de la fila

Con una celda que puede medir tres líneas, `vertical-align: middle` —el valor por defecto que la
tabla usa hoy— deja el número del comparendo flotando en mitad de la fila. Se pasa la fila entera a
`align-top`, que **no es un patrón nuevo**: es el que ya usan `ResultadoSyncComparendos.tsx` (en este
mismo módulo), `columnasComunes.tsx`, `FlitoTramites.tsx` y `BolsaMovimientos.tsx`.

| Dónde | Cambio |
|---|---|
| `const CELDA` (línea ~36) | `'px-4 py-2.5 text-sm'` → `'px-4 py-2.5 text-sm align-top'` |
| `<td>` de «Monitoreo» (línea ~195) | `"px-4 py-2.5"` → `"px-4 py-2.5 align-top"` |
| `<td>` de «Gestión» (línea ~200) | `"whitespace-nowrap px-4 py-2.5"` → `"whitespace-nowrap px-4 py-2.5 align-top"` |
| `TablaComparendosCargando` | **No se toca.** Todas sus celdas miden lo mismo; el `align-top` no cambiaría un píxel |

### Los tres casos de ancho

Números indicativos: `text-sm` = 14 px con interlínea 20 px; el ancho medio de carácter en mayúsculas
ronda 8,4 px. **El `frontend-agent` no tiene que confiar en estas cuentas** — el tope de 4 líneas
tiene margen de sobra sobre las 3 que salen del cálculo, y la prueba mide lo que el navegador pinta.

| Viewport | Qué pasa |
|---|---|
| **< 1280 px** | La columna **no existe** (`hidden xl:table-cell`, sin cambios). El valor vive entero en el panel de detalle. Esta HU no toca el móvil ni la tablet |
| **1280 px justos** | La columna aparece (`xl:` es `min-width: 1280px`). La tabla ya desplazaba en horizontal y ahora desplaza **48 px más** (11 rem → 14 rem). El contenedor de `FlitTable` es `tabIndex=0` cuando desborda (`useDesbordaX`), así que ese ancho extra **sigue siendo alcanzable con teclado**: no hace falta nada nuevo |
| **1920 px** | Sobra sitio: los 48 px salen del espacio libre y **ninguna otra columna pierde contenido** (layout automático con `w-full`). El `max-w-[14rem]` **no crece** con el viewport, así que un estado de 80 caracteres sigue ocupando 3 líneas: el alto de fila **no depende del viewport**, que es justo lo que descartó la alternativa 11 |
| **80 caracteres sin un solo espacio** | `wrap-anywhere` parte la palabra donde toque. La columna queda acotada a `14 rem + px-4 × 2` = **16 rem** y el reparto del resto de columnas no se mueve. Sin esa clase, o la columna se ensancha ~672 px y descuadra la tabla, o el `overflow: hidden` del clamp corta el texto **en horizontal y sin aviso** — el defecto que esta HU viene a cerrar, reaparecido de lado |

### Alto de fila resultante

| Fila | Antes | Después |
|---|---|---|
| Estado corto («Se adeuda»), sin alias ni gestión | ~44 px | ~44 px (**sin cambio**) |
| Con alias y con gestión (dos líneas en dos celdas) | ~62 px | ~62 px (**sin cambio**) |
| Estado de 80 caracteres | ~44 px | ~80 px |
| Estado fuera de contrato (>108 caracteres) | ~44 px | ~100 px (**tope duro**: el airbag) |

---

## Estados (4) — solo lo que cambia

| Estado | Cambia | Qué |
|---|---|---|
| **1 · Cargando** | **No** | Ocho filas fantasma con `h-4` por celda. Su alto sigue siendo un **suelo, no una promesa**: el salto al llegar los datos ya existía y esta HU no lo agranda de forma apreciable, porque solo las filas con estados largos crecen. Subir el esqueleto a tres líneas sería mentir sobre la densidad de la página en el 95 % de los casos |
| **2 · Error** | **No** | La tabla anterior se borra entera; no hay celda que pintar |
| **3 · Vacío** | **No** | Ambos vacíos (A: «Todavía no hay comparendos registrados»; B: por filtros) se pintan sin `<tbody>` de datos |
| **4 · Lleno** | **Sí, y es el único** | La celda envuelve hasta mostrar el estado completo. `null` → **«—»** (constante `SIN_DATO`), igual que hoy y que el resto del módulo: una celda vacía se leería «no debe nada» en vez de «la fuente no dijo nada» |

**Copy: no se añade ni se cambia ni una cadena.** En particular, **el `caption` de la tabla se queda
como está**, con sus tres advertencias —incluida «puede venir vacío»—: siguen siendo ciertas y la
prueba `AC5` del caption sigue verde sin tocarla.

### Accesibilidad — lo que esta HU no puede pagar

- **Cero paradas de tabulador nuevas.** La celda sigue siendo un `<td>` mudo: ni `tabIndex`, ni
  `<button>`, ni control dentro. Una parada por fila, la del número (#11562, AC1 y AC8).
- **Sin `title`, sin `aria-label`, sin `data-*` con el valor.** Prohibido el `title` por la #11713
  (no lo ve el teclado, no lo anuncia bien un lector, no existe en táctil) y prohibido meter el valor
  en atributos porque **los selectores de axe arrastran valores de atributo**: un estado que dijera
  «SALDO DEL NIT 900123456» acabaría en el informe de a11y.
- **Seleccionable y copiable, y ahora de verdad.** El texto envuelto se selecciona y se copia entero;
  el ajuste de línea no inserta saltos en el portapapeles. Hasta hoy lo copiable estaba en el DOM
  pero **oculto tras el recorte**, que es justo lo que el operador no podía ver para citarlo.
- **Sin `capitalize` ni `uppercase`** en la celda ni en nada de lo que lleva dentro. «Se Adeuda» ya no
  es lo que dijo la fuente.

---

## Impacto declarado sobre la prueba `AC2+AC5` existente

`apps/web/e2e/tests/flito-comparendos-visor.spec.ts`, test
**`AC2+AC5 — «Estado en la fuente» tal cual, sin title, a una línea y sin mover el alto`** (líneas
~811-873). **Dejan de ser ciertos exactamente tres asertos** — los tres que afirman el recorte:

| Línea | Aserto | Qué le pasa |
|---|---|---|
| ~860 | `expect(clamp.desbordado).toBe(true)` (`scrollHeight > clientHeight`) | **Se invierte.** Pasa a `toBe(false)`: dentro del contrato **no queda nada oculto**. Este aserto invertido es el corazón de la HU |
| ~861 | `expect(clamp.alto).toBeLessThanOrEqual(Math.ceil(clamp.linea) + 1)` (una línea) | **Se sustituye** por una cota superior de 3 líneas — que sigue siendo una cota, solo que otra |
| ~872 | `expect(Math.abs(largo - corto)).toBeLessThanOrEqual(1)` (el alto de fila no se mueve) | **Se sustituye** por una cota: la fila larga **crece**, pero no más de 4 líneas respecto de la corta |

**Y ocho asertos del mismo test SOBREVIVEN sin tocarse** — conviene decirlo porque marcan lo que la
HU **no** puede aflojar de paso: el texto tal cual (`toHaveText('Se adeuda')`), la ausencia de
`text-transform` en todo lo que hay dentro de la celda, el `null` → «—», el valor completo
(`toHaveText(ESTADO_LARGO)`), las dos comprobaciones de que no hay `title` y la de que `innerText`
conserva los 80 caracteres. Ninguno de esos seis se relaja: **el título del test cambia, sus
prohibiciones no.**

También se renombra el test: *«…tal cual, sin `title`, **entero y con el alto acotado**»*. Un test
cuyo nombre siga diciendo «a una línea» es una mentira archivada, y en este repo lo que más miente
son las frases.

> **Ningún otro test se ve afectado.** El `AC5` del caption, el `AC1+AC3` de «Tipo», el `AC2` de
> «Monitoreo» y el `AC4+AC5` de las paradas de tabulador no miden altos ni el recorte. El
> `flito-comparendos-visor-a11y.spec.ts` tampoco: no se añade ningún atributo ni ningún control.
> **Ojo con el detalle de infraestructura:** ese spec necesita `QA_AXE_CDN=1` o salen ~10 rojos que
> no son regresión de esta HU.

---

## Notas QA (9)

Cada punto nombra **el mutante que debe poner la prueba en rojo**. Un aserto que no mata a nadie es
decoración.

1. **Fixture nuevo, con su longitud autocomprobada.** `ESTADO_SIN_ESPACIOS = 'PENDIENTEDEPAGOPORRESOLUCIONDECOBROCOACTIVONOTIFICADAPORAVISO'.padEnd(80, 'X')`
   más un `expect(ESTADO_SIN_ESPACIOS).toHaveLength(80)` en el propio test: sin eso, alguien recorta
   la constante un día y el caso peor deja de serlo sin que nadie lo note.
2. **Fixture fuera de contrato:** `ESTADO_FUERA_DE_CONTRATO = 'RESOLUCION DE COBRO COACTIVO '.repeat(11)`
   (~319 caracteres). La base no puede producirlo hoy, **pero la red sí lo entrega** — es el mismo
   argumento con el que este archivo ya justifica `FILA_SIN_TIPO`.
3. **Página propia** (`PAGINA_ESTADOS_LARGOS`) para los casos que miden altos y anchos: meterlos en
   `PAGINA_TIPOS` movería los altos que miden los otros tests del bloque, que es la razón por la que
   `FILA_SIN_TIPO` ya vive aparte.
4. **Mutante «reponer `line-clamp-1`» (o `-2`):** `scrollHeight <= clientHeight` en la fila de 80
   caracteres. Rojo inmediato. *Honestidad sobre el alcance:* un `line-clamp-3` **no** lo mata,
   porque con 3 líneas el valor tampoco se recorta — y lo que la HU exige es que no se recorte, no
   que la clase diga «4».
5. **Mutante «quitar el `line-clamp-4`»:** con `ESTADO_FUERA_DE_CONTRATO`, el airbag **tiene** que
   actuar → `clientHeight <= 4 × lineHeight + 2` **y** `scrollHeight > clientHeight`. Sin el clamp la
   fila mide quince líneas y el primer aserto cae.
6. **Mutante «quitar `wrap-anywhere`»:** con `ESTADO_SIN_ESPACIOS`, `span.scrollWidth <= span.clientWidth + 1`.
   Sin la clase, el `overflow: hidden` del clamp corta la palabra en horizontal y `scrollWidth` se
   dispara. Es el mutante más silencioso de los seis: sin este aserto, el defecto vuelve de lado.
7. **Mutante «quitar el `max-w-[14rem]`»:** el `boundingBox().width` del `<td>` del estado
   `<= 16rem + 1 px` en la fila de 80 caracteres. Sin la cota, la columna se estira a la longitud del
   texto y le come el sitio a las demás.
8. **Mutante «estrechar a 11 rem»:** el `clientHeight` del span en la fila de 80 caracteres
   `<= 3 × lineHeight + 2`. A 11 rem hacen falta 4 líneas y el aserto cae. Va junto al del punto 7:
   uno acota por arriba el ancho y el otro por arriba el alto, y **hace falta la pareja** — cada uno
   por separado se satisface haciendo la columna absurda en la otra dimensión.
9. **Mutante «quitar el `align-top`»:** en la fila de 80 caracteres, la `y` del botón del número y la
   `y` de la celda del estado no difieren en más de 4 px. Con `middle`, el botón cae ~20 px por
   debajo del inicio del estado.

**No hace falta e2e nuevo de a11y.** No hay atributo, control ni parada de tabulador nueva que
auditar. Y conviene recordar que **el CI no corre e2e**: estas pruebas solo se ejecutan en el
nocturno, y `flito-comparendos-visor.spec.ts` está en la lista fija. Verde en el PR no significa que
nadie las haya ejecutado.

---

## Recomendación aparte: la columna «Infracción» — **NO se le aplica este patrón**

La columna «Infracción» usa el mismo `line-clamp-1 max-w-[22rem]` y **queda fuera del alcance de la
HU #11777**. Pero la recomendación no es «hacer lo mismo cuando toque», sino lo contrario, y por un
motivo verificable:

> **`descripcion_infraccion` es `text()` en el esquema (`schema.ts:4383`): no tiene ninguna cota.**

Toda esta decisión se apoya en que 80 caracteres caben en tres líneas. En «Infracción» no hay número
que sustituya al 80 —el propio documento del visor menciona descripciones de 300 caracteres, que
serían **siete líneas**—, así que ahí un `line-clamp` **sí sería un recorte real** y quitarlo sí
convertiría una fila en siete. Lo que se generaliza es el **método**, no la solución:

1. Buscar la cota del campo en el esquema.
2. Si existe y es pequeña, elegir el ancho que la haga caber en 2-3 líneas y poner el clamp como
   airbag, por encima de lo que la cota necesita.
3. **Si no existe cota, el problema no es de UX: es de contrato.** Mostrar entero un campo sin techo
   exige primero ponerle uno —en el contrato o en el esquema— y eso es un requerimiento para
   `architecture-agent`, no una clase de Tailwind.

---

## Qué queda desactualizado en `docs/ux/flito-comparendos-visor.md`

Tres frases de ese documento pasan a ser falsas con esta decisión. Quien implemente la #11777 debe
**tacharlas en sitio y remitir aquí**, que es la convención que ese archivo ya usa para sus propias
revocaciones (bloque del 21 ago 2026):

| Dónde | Qué dice hoy | Qué pasa |
|---|---|---|
| «Enmienda del 21 ago 2026», apartado **«Lo que NO cambia»** (~línea 438) | «…**sin recorte en el DOM** y sin `title`—, **a una línea con `line-clamp-1`** por la misma razón que la infracción: el alto de la fila» | La parte del `line-clamp-1` y la equiparación con la infracción quedan **revocadas** por la HU #11777. El «sin `title`» y el «sin `capitalize`» **siguen en pie** |
| Bloque de comentario de `TablaComparendos.tsx`, líneas ~218-224 | «Una línea con `line-clamp-1` —eso mantiene el alto de la fila—…» | Se reescribe con la justificación de la celda que hay más arriba en este documento. **No basta con cambiar la clase y dejar el comentario**: un comentario que explica una decisión revocada es exactamente el tipo de frase que en este repo miente más que el código |
| Tabla de columnas, fila «Estado en la fuente» (~línea 361) | — | Añadir la remisión a este documento junto a la de la #11713 |

Y en la cabecera de la sección «Columnas y prioridad visual» conviene enlazar este archivo:
`> Ver también: docs/ux/flito-comparendos-estado-fuente.md (HU #11777) — por qué «Estado en la fuente» se muestra completo.`
