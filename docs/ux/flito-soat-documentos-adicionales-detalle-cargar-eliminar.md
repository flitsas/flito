# UX slim: Cargar y eliminar documentos adicionales desde el detalle del SOAT (HU #13365)

Feature #13361 · Épica #13201 · Módulo **FLITO** `flito-soat` (`/api/flito/soat`), no el legacy `soat`.
Modo **slim**: sin ruta, `PageSlug` ni pantalla nueva. Extiende la sección «Documentos adicionales» de
`components/flito/soat/DetalleSoat.tsx` (HU #13363). **Base obligatoria:** `docs/ux/flito-soat-documentos-adicionales.md`
(«spec #13363»): su §4 (lista, 4 estados, descarga) y su §3.3 (selector, validación, copy de motivos por `codigo`) **no se rediseñan**.
Contrato: HU #13364 (`POST` multipart y `DELETE` por `soporteId`). **No hace falta endpoint nuevo.**

Público: operación FLIT y proveedor SOAT (y quien tenga las funciones: el permiso es por función, no por rol).
Copy **neutro**, como el resto de la sección (el detalle lo abre también el Cliente). Se calcan las formas
imperativas que la sección ya usa («Intente de nuevo»).

---

## 1 · Superficie tocada

| Zona | Qué cambia |
|---|---|
| Cabecera de la sección (`DocumentosAdicionalesSeccion`) | El rótulo «Documentos adicionales» gana a su derecha el botón secundario **«Cargar documentos»**, solo con `soat.documentos_adicionales.cargar`. |
| Panel de carga **en línea** (nuevo, dentro de la sección, encima de la lista) | Reutiliza `DocumentosAdicionalesSelector` (controlado) + una fila de acciones «Cancelar» / «Cargar {n}». No es un modal: `DetalleSoat` ya es un modal y no se apila otro. |
| Fila de la lista (`DocumentosAdicionalesLista`, hueco `accionesExtra`) | Botón de icono **Eliminar** (papelera) a la derecha de ⬇, solo con `soat.documentos_adicionales.eliminar`. La confirmación **reemplaza la fila en línea** (patrón de `components/finanzas/FilaServicioAdicional.tsx`). |
| Aviso de resultado de la carga (nuevo, dentro de la sección) | `role="status"` entre la cabecera y la lista cuando la carga vuelve con descartes. |
| `documentosAdicionales.ts` | `motivoEnPantalla` y el texto del grupo de inválidos aceptan un contexto `'alta' | 'detalle'` (solo cambian 3 frases, §4). La lista expone una forma de **refrescarse sin esqueleto** (§3.3). |

---

## 2 · Delta de claridad

**Qué vino a hacer el operador:** revisar el caso. A veces, además, sumar un soporte que llegó por fuera
(un poder, una cédula) o quitar uno equivocado. Cargar y eliminar son **acciones ocasionales** sobre una
sección de consulta: no compiten con la acción del caso.

- **Qué se ve primero no cambia:** lo de hoy en el detalle; la sección sigue después de «Comprobante».
  Dentro de la sección, la lista.
- **Primaria:** el detalle ya tiene sus primarias del caso (cargar comprobante / la acción del pie). Por eso
  **nada de esta HU es primario**: «Cargar documentos», «Cargar {n}», «Cancelar» y «Eliminar» son
  secundarios (`flitBtnSecondarySm`). Dentro del panel, el botón que manda es «Cargar {n}» por posición
  (último, a la derecha), icono y rótulo con la cantidad, no por peso de primaria.
- **Qué se calla:** los códigos (`supera_tamano`…), el `motivo` de texto del servidor, el límite de 100 del
  servidor (413) y los hash. Igual que en la spec #13363.
- **Densidad:** +1 botón en la cabecera de la sección y +1 icono por fila, ambos condicionados a su
  función. El panel solo existe mientras se carga. **Sin cambio material**: no hay columnas ni filas nuevas.

---

## 3 · Cargar (AC1, AC2, AC3, AC6, AC7)

### 3.1 Cabecera (cerrado)

```
DOCUMENTOS ADICIONALES                                    [ ⬆ Cargar documentos ]
Poder autenticado                                          [ Ver ] [⬇] [🗑]
PDF · 1,2 MB · 07/10/2026 14:32 · Ana Pérez
──────────────────────────────────────────────────────────────────────────────
RUT                                                        [ Ver ] [⬇] [🗑]
Imagen PNG · 0,5 MB · 07/10/2026 14:32 · Ana Pérez
```

- Botón: icono `Upload` + **«Cargar documentos»**, `flitBtnSecondarySm`, `aria-expanded="false"` y
  `aria-controls` hacia el panel. Visible en los 4 estados de la lista (la carga no depende de haber leído la lista).
- Sin `.cargar`: ni botón ni panel en el DOM (AC2).

### 3.2 Panel abierto

```
DOCUMENTOS ADICIONALES
┌──────────────────────────────────────────────────────────────────────────┐
│ Cargar documentos adicionales                                            │
│  [ ⬆ Elegir más archivos ]                  2 archivos · 1,7 MB de 250 MB │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ poder-notaria.pdf                                 PDF · 1,2 MB [✕] │ │
│  │ Etiqueta (opcional)  [ Poder autenticado                      ]    │ │
│  ├────────────────────────────────────────────────────────────────────┤ │
│  │ rut.png                                    Imagen PNG · 0,5 MB [✕] │ │
│  │ Etiqueta (opcional)  [                                        ]    │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  No se van a cargar (1)                                                  │
│  │ ⚠ planilla.xlsx                                                 [✕] │ │
│  │   Formato no permitido. Use PDF, JPG, PNG, WEBP o HEIC.            │ │
│  Estos archivos no se cargan; los demás sí.                              │
│                                                                          │
│                                     [ Cancelar ]  [ ⬆ Cargar 2 ]         │
└──────────────────────────────────────────────────────────────────────────┘
(lista de documentos, sin cambios, debajo)
```

- Contenedor: `rounded-lg border` con `--flit-border-input` (el mismo de la confirmación en línea de
  `FilaServicioAdicional`). Título del panel **«Cargar documentos adicionales»** (`text-sm font-semibold`),
  que es el `aria-labelledby` de la región.
- Al abrir, el botón de la cabecera se **oculta** (el panel ya es esa acción) y el foco va a la caja
  **«Elegir archivos»** del selector.
- Selector: el mismo `DocumentosAdicionalesSelector` de la spec #13363 §3.1–3.3 (caja vacía, filas, etiqueta
  opcional con `maxLength` = `LARGO_ETIQUETA_ADICIONAL` (150), ✕ «Quitar», inválidos en grupo aparte). **Sin**
  el título numerado del alta. Contexto `detalle` → cambia solo lo de §4.
- Validación local (AC3), con `validarAdicionales(nuevos, presentesDeEstaCarga)`:
  - Formato, 15 MB por archivo, repetido **dentro de esta elección** (nombre + tamaño).
  - Los documentos ya guardados **no** se pasan como `presentes` ni `ajenos`: no hay techo acumulado y la
    lista no expone nombre original para comparar. El repetido contra lo guardado y contra la factura de la
    solicitud lo detecta el servidor por contenido y vuelve como descarte (§3.4).
  - Cupos **por carga**: los mismos que aplique el servidor a una petición (se asume 20 archivos y 250 MB,
    los de `MAX_ADICIONALES` / `MAX_TOTAL_ADICIONALES`). **El frontend refleja la constante del servidor de
    #13364; si allá el cupo por petición es otro, se usa ese** (ver Notas para el implementador).
- «Cargar {n}» (`n` = válidos; singular **«Cargar 1»**): icono `Upload`, deshabilitado con 0 válidos.
  `aria-label` = **«Cargar {n} documentos»** / **«Cargar 1 documento»**.
- «Cancelar»: cierra el panel, **descarta la elección sin confirmar** (se puede volver a elegir), vuelve a
  mostrar «Cargar documentos» y le devuelve el foco. `Esc` dentro del panel = Cancelar, con
  `stopPropagation` para **no cerrar el modal** (mismo truco que `FilaServicioAdicional`). Con la carga en
  curso, `Esc` y «Cancelar» no hacen nada.
- Envío: `FormData` con `adjuntarAdicionales` (archivos + etiquetas alineadas), `POST
  /api/flito/soat/:id/documentos-adicionales` por `api.ts` con el timeout largo de las cargas
  (`postConTimeout`, `TIMEOUT_ALTA_CON_ADICIONALES_MS`), igual que el alta con adicionales.

### 3.3 Ocupado (AC7)

- Candado por `ref` contra el doble envío (no solo `disabled`).
- «Cargar {n}» cambia a **«Cargando…»**, `disabled` + `aria-busy="true"`. «Cancelar», «Elegir más archivos»,
  los ✕ y las etiquetas quedan `disabled`.
- Línea bajo los botones, `role="status"`: **«Guardando {n} documentos… puede tardar si son pesados.»**
  (singular: **«Guardando 1 documento…»**).
- La lista de abajo sigue usable (ver, descargar, eliminar).

### 3.4 Resultado de la carga

| Desenlace | Qué pasa | Notificación y copy |
|---|---|---|
| **201, todo aceptado** | Panel se cierra, la lista se **refresca sin esqueleto** (la lista vieja sigue visible hasta que llega la nueva). Foco a «Cargar documentos». | **Toast** de éxito cerrable (~4 s): **«Se cargaron {n} documentos.»** / **«Se cargó 1 documento.»** |
| **201 con descartes** (algunos o todos) | Panel se cierra, la lista se refresca. Aparece el **aviso en la sección** (no toast: la página no navega y lo que no entró sigue siendo cierto mientras se mira). **Sin** toast de éxito: una notificación por acción. | Ver §3.5. |
| **Refresco de la lista falla tras un 201** | La lista queda como estaba (no pasa a error ni a esqueleto). | Aviso en la sección, `role="status"`: **«Los documentos se guardaron, pero la lista no se pudo actualizar.»** + «Reintentar» (relee la lista). |
| **Error** (red, 5xx, timeout, 413, 429, 403, 404) | El panel **sigue abierto** con la elección, etiquetas e inválidos intactos. La lista no cambia (AC6). | Mensaje en el panel, `role="alert"`, tinta `--flit-danger-ink`, encima de los botones. Copy en §3.6. |

### 3.5 Aviso de descartes (en la sección)

```
DOCUMENTOS ADICIONALES                                    [ ⬆ Cargar documentos ]
┌ ⚠ Se cargaron 2 de 3 documentos. ──────────────────────────────────── [✕] ┐
│ No se cargó:                                                              │
│ — foto.jpg: ya estaba en la solicitud                                     │
└───────────────────────────────────────────────────────────────────────────┘
(lista refrescada)
```

- `role="status"`, borde `--flit-border`, icono de aviso en `--flit-warning-*` si existe con par oscuro (si no,
  `--flit-text-secondary`); texto en `--flit-text-primary`. No es un error: los válidos entraron.
- Encabezado: **«Se cargaron {a} de {t} documentos.»**. Si no entró ninguno: **«No se cargó ningún documento.»**
- Subtítulo: **«No se cargó:»** (uno) / **«No se cargaron:»** (varios) + **lista completa**, un renglón por
  archivo: **«— {nombreArchivo}: {motivoEnFrase(codigo)}»** (minúscula, sin punto; el repetido dice «ya
  estaba en la solicitud»). Nunca el `motivo` de texto del servidor ni el código.
- Se cierra con ✕ (`aria-label="Cerrar aviso"`) o al abrir otra carga. No se cierra solo.

### 3.6 Copy de error de la carga (AC6)

| Caso | Copy | Acción |
|---|---|---|
| Red, 5xx, timeout | **«No se pudieron guardar los documentos. Intente de nuevo.»** | «Reintentar» (reenvía la misma elección) |
| 429 (limitador) | **«Se hicieron muchas cargas seguidas. Espere unos minutos e intente de nuevo.»** | «Reintentar» |
| 413 (más de los que acepta el servidor por petición) | **«Son demasiados archivos para una sola carga. Quite algunos e intente de nuevo.»** | «Reintentar» |
| 403 (perdió la función) | **«Este usuario ya no tiene permiso para cargar documentos.»** | Sin «Reintentar»; solo «Cancelar» |
| 404 (sin acceso a la solicitud) | **«Esta solicitud ya no está disponible. Cierre el detalle y vuelva a abrirlo.»** | Sin «Reintentar» |

«Reintentar» es `flitBtnSecondarySm` con `RotateCw`, junto al mensaje. Mientras está el mensaje, «Cargar {n}»
sigue disponible (hace lo mismo); si el usuario cambia la elección, el mensaje se borra.

---

## 4 · Copy del selector en contexto `detalle` (solo lo que cambia)

| Frase del alta (spec #13363) | En el detalle |
|---|---|
| «No se van a adjuntar ({n})» | **«No se van a cargar ({n})»** |
| «Puede enviar la solicitud igual: estos archivos no viajan.» | **«Estos archivos no se cargan; los demás sí.»** |
| «Ya hay 20 archivos, que es el máximo.» (`supera_cantidad`) | **«Se cargan hasta 20 archivos a la vez.»** |
| «Con este archivo se superarían los 250 MB en total.» (`supera_total`) | **«Con este archivo la carga pasaría de 250 MB.»** |

El resto (formato, 15 MB, «Ya lo eligió.», desconocido, «Elegir archivos», «Etiqueta (opcional)», nota de
pie de etiqueta) **igual que la spec #13363**. Las cifras salen de las constantes, no de literales.

---

## 5 · Eliminar (AC4, AC5, AC6, AC7)

### 5.1 Botón en la fila

- En `accionesExtra`, después de ⬇: icono `Trash2`, mismo `BOTON_ICONO` (40×40, `rounded-[999px]`, velo
  `--flit-bg-hover` al hover, `flit-focus`), tinta `--flit-text-secondary` (no rojo en reposo: no alarmar en una
  lista de consulta). `aria-label` y `title`: **«Eliminar {etiqueta}»**.
- Sin `.eliminar`: no se pasa `accionesExtra` (AC5).

### 5.2 Confirmación en línea (reemplaza la fila)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ¿Eliminar «Poder autenticado»?                                           │
│ Se borra de forma definitiva y no se puede recuperar.                    │
│                                          [ Cancelar ]  [ 🗑 Eliminar ]    │
└──────────────────────────────────────────────────────────────────────────┘
```

- Copy exacto: **«¿Eliminar «{etiqueta}»?»** + **«Se borra de forma definitiva y no se puede recuperar.»**
  La etiqueta con `break-words` (sin truncar: aquí hay que leer cuál es).
- Botones: «Cancelar» (`flitBtnSecondarySm`, **recibe el foco** al abrir) y «Eliminar» (`flitBtnSecondarySm`
  con tinta y borde `--flit-danger-ink`, como el «Quitar» de `FilaServicioAdicional`).
- Una sola confirmación abierta a la vez: abrir otra cierra la anterior.
- Cancelar o `Esc` (con `stopPropagation`, el modal no se cierra): vuelve la fila tal cual y el foco a su 🗑 (AC4).
- Contenedor con `role="group"` y `aria-labelledby` hacia la pregunta. No se usa `window.confirm` ni un modal sobre el modal.

### 5.3 Ocupado y resultado

- Al confirmar: candado por `ref`; «Eliminar» → **«Eliminando…»** + `aria-busy`, ambos botones `disabled`.
- **204:** la fila desaparece (se quita del estado local; no hace falta releer). Toast de éxito cerrable (~4 s):
  **«Se eliminó «{etiqueta}».»** Foco al 🗑 de la fila siguiente; si no hay, al de la anterior; si la lista queda
  vacía, a «Cargar documentos» o, sin esa función, al rótulo de la sección (`tabIndex=-1`). La lista vacía
  muestra el vacío de §6.
- **404** (ya no estaba): la fila se quita igual. Toast informativo: **«Ese documento ya no estaba en la solicitud.»**
- **Error** (red, 5xx, 429, 403): la confirmación **sigue abierta** y la lista no cambia (AC6). Mensaje dentro
  de la confirmación, `role="alert"`, `--flit-danger-ink`, y «Eliminar» pasa a **«Reintentar»**:

| Caso | Copy |
|---|---|
| Red, 5xx | **«No se pudo eliminar. Intente de nuevo.»** |
| 429 | **«Se hicieron muchos cambios seguidos. Espere unos minutos e intente de nuevo.»** |
| 403 | **«Este usuario ya no tiene permiso para eliminar documentos.»** (sin «Reintentar», solo «Cancelar») |

---

## 6 · Los 4 estados de la sección (lo que cambia)

| Estado | Sin funciones nuevas | Con `.cargar` |
|---|---|---|
| Cargando | Igual que hoy (esqueleto de 2 filas). Si hay `.eliminar`, el esqueleto suma una tercera caja de 40×40. | Igual + botón «Cargar documentos» en la cabecera. |
| Error | Igual que hoy («No se pudieron cargar los documentos adicionales.» + «Reintentar»). | Igual + botón en la cabecera. |
| Vacío | Igual que hoy («Sin documentos adicionales.» / «Aquí aparecen los que se adjunten en la solicitud.») | **«Sin documentos adicionales.»** + **«Para agregar soportes del caso, use «Cargar documentos».»** |
| Lleno | Igual que hoy (+ 🗑 por fila con `.eliminar`). | Igual + botón en la cabecera. |

---

## 7 · Responsive (<`lg`, 360 px) y feedback

**360 px (AC7):**
- Cabecera: rótulo y «Cargar documentos» en `flex flex-wrap items-center justify-between gap-2`; si no caben,
  el botón baja debajo del rótulo, alineado a la izquierda.
- Panel: ancho de la sección; filas del selector apiladas como en el alta (spec #13363 §6). Fila de acciones
  `flex-wrap justify-end`; en `<sm` los dos botones a `w-full`, con «Cargar {n}» **encima** de «Cancelar».
- Fila de la lista: el grupo Ver / ⬇ / 🗑 ya envuelve (`flex-wrap`) y baja bajo la etiqueta si no cabe.
- Confirmación y avisos: texto con `break-words`; nombres sin espacios con `break-all`. **Sin scroll horizontal**.
- Área de toque de los iconos: 40 px (la de `BOTON_ICONO`).

**Feedback (hover sutil + foco) en todo lo nuevo:**
- «Cargar documentos», «Cargar {n}», «Cancelar», «Reintentar», «Eliminar» de la confirmación: `flitBtnSecondarySm`
  + `hoverSecundario` + `flit-focus`. El «Eliminar» de confirmación hace hover con velo `--flit-bg-hover`, sin
  cambiar a fondo rojo.
- 🗑 y ✕ del aviso: velo `--flit-bg-hover`, `transition-colors`, `flit-focus`.
- `disabled` distinguible (opacidad del kit + `cursor-not-allowed`).
- Sin animaciones, barra de progreso, sombras ni colores nuevos. Solo tokens con par oscuro; revisar los dos temas.

**Notificaciones (resumen):** carga limpia → toast · carga con descartes → aviso en la sección (sin toast) ·
error de carga → `role="alert"` en el panel · eliminar ok → toast · eliminar 404 → toast informativo · error
de eliminar → `role="alert"` en la confirmación. Nunca `e.message` ni el `motivo` crudo.

---

## 8 · Permiso/slug

- Página y `PageSlug` sin cambio (`pagina.flito-soat`). La sección sigue con `soat.documentos_adicionales.ver`.
- **Cargar:** `hasFuncion('soat.documentos_adicionales.cargar')`. **Eliminar:** `hasFuncion('soat.documentos_adicionales.eliminar')`.
  Son independientes: ver sin cargar, cargar sin eliminar, etc. Las tres constantes junto a `FUNCION_VER_ADICIONALES`.
- Sin `.ver` la sección no existe, aunque se tenga `.cargar` o `.eliminar` (no hay dónde montar las acciones).
- PII: archivos y etiquetas solo en el cuerpo del `POST`; `DELETE` con uuids en el path. Nada al router.

---

## 9 · Notas para QA (≤10)

1. **AC1:** con `.cargar`, abrir el panel, elegir 2 archivos, etiquetar 1, «Cargar 2» → panel cerrado, toast «Se cargaron 2 documentos.», los 2 en la lista **sin recargar la página** y sin esqueleto. El multipart lleva etiquetas alineadas por índice.
2. **AC2/AC5:** sin `.cargar` → `toHaveCount(0)` en «Cargar documentos»; sin `.eliminar` → `toHaveCount(0)` en `Eliminar …`; con `.ver` sola, la lista se ve igual que en #13363.
3. **AC3 local:** `.xlsx`, PDF de 16 MB y el mismo PDF dos veces → 3 en «No se van a cargar» con su motivo exacto; «Cargar 1» habilitado y solo viaja el válido. 21 válidos → el 21.º dice «Se cargan hasta 20 archivos a la vez.»
4. **AC3 servidor:** interceptar un 201 con `descartados` (incluido un repetido) → aviso en la sección «Se cargaron {a} de {t} documentos.» + «— {nombre}: ya estaba en la solicitud», **sin** toast. 201 con todo descartado → «No se cargó ningún documento.» y la lista igual.
5. **AC4:** 🗑 → confirmación con la etiqueta y «definitiva»; foco en «Cancelar». Cancelar/`Esc` → fila igual, modal abierto, foco en su 🗑. Confirmar → 204, fila fuera, toast «Se eliminó «…».»
6. **AC6 carga:** forzar 500 y 429 → copy de §3.6 en `role="alert"`, panel con la elección intacta, lista sin cambios; «Reintentar» reenvía. 403 → sin «Reintentar».
7. **AC6 eliminar:** forzar 500 y 429 → copy de §5.3, la fila sigue, el botón dice «Reintentar». 404 en el DELETE → fila fuera + «Ese documento ya no estaba en la solicitud.»
8. **AC7 ocupado:** doble clic en «Cargar {n}» y en «Eliminar» → **una** petición (contar en la red); «Cargando…»/«Eliminando…» con `aria-busy`.
9. **AC7 a11y y 360 px:** Tab alcanza «Cargar documentos», el selector, «Cargar {n}», cada 🗑 y los botones de la confirmación con foco visible; `aria-label` en 🗑 y ✕; a 360 px sin scroll horizontal con una etiqueta de 150 caracteres sin espacios. Los dos temas.
10. Vacío con `.cargar` muestra «Para agregar soportes del caso, use «Cargar documentos».»; sin `.cargar`, el copy de #13363. `page.url()` nunca lleva nombres ni etiquetas.

---

## 10 · Decisiones y descartes

| Decisión | Descarte |
|---|---|
| Panel en línea dentro de la sección | Modal de carga encima de `DetalleSoat` (modal sobre modal: foco y `Esc` frágiles, y tapa la lista que se va a actualizar) |
| Todo secundario | `flitBtnPrimary` en «Cargar {n}»: el detalle ya tiene la primaria del caso; dos primarias en el mismo modal |
| Confirmación en línea, patrón de `FilaServicioAdicional` | `window.confirm` (sin estilo ni copy pulido) · modal de confirmación (no hay componente genérico en el kit y sería modal sobre modal) |
| Descartes en aviso de sección, sin toast | Toast (se va y el operador pierde qué no entró) · toast + aviso (dos notificaciones por una acción) |
| Error de carga dentro del panel, conservando la elección | Toast de error y panel cerrado: obliga a volver a elegir todo |
| No validar contra lo ya guardado | Pasar lo guardado como `presentes`: inventa un techo acumulado que el contrato no tiene, y la lista no trae el nombre original para comparar repetidos |
| 🗑 en tinta neutra | 🗑 rojo en cada fila: alarma en una lista de consulta |
| Cero animaciones, barra de progreso, sombras o ilustraciones | — |

## 11 · Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Revisar el caso; a veces sumar o quitar un soporte |
| ¿Qué se ve primero? ¿Qué se calla? | La lista de siempre; el panel solo al pedirlo. Se callan códigos, `motivo` crudo y el 413 técnico |
| ¿Única primaria? | La del detalle, sin cambio. Esta HU no añade primarias |
| ¿Vacío/error con siguiente paso? | Vacío con `.cargar` invita a cargar; errores con «Reintentar» o qué hacer (esperar, reabrir) |
| ¿Efectos o patrón nuevo? | Ninguno: selector y lista de #13363, confirmación en línea ya usada en finanzas, `BOTON_ICONO`, toasts del kit |
| ¿Móvil? | §7: cabecera y acciones envuelven, botones a ancho completo en `<sm`, sin desborde a 360 px |
| ¿Feedback? | §7: hover sutil + `flit-focus` en todo lo nuevo |
| ¿Notificación? | §7 resumen: toast para resultados limpios, aviso en sección para descartes, `role="alert"` en línea para errores |

### Notas para el implementador

- **Cupo por carga:** confirmar en el código de #13364 qué cupos aplica el servidor a **una** petición del
  detalle (cantidad y MB). Si son 20/250, se usan las constantes actuales; si son otros, se exportan desde
  `shared-types` y el selector los lee. No se pregunta al PO: es un dato del contrato.
- `DocumentosAdicionalesLista` necesita: refresco silencioso (sin pasar a `cargando`) y quitar una fila del
  estado local tras el 204. Manteniendo el archivo por debajo de 800 líneas; la confirmación puede ir en un
  componente propio (`ConfirmarEliminarAdicional`).
