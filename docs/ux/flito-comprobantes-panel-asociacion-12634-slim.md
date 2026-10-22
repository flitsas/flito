# UX slim — Panel de asociación de comprobantes (HU #12634 · Feature #12606 · Épica #12245)

> **Delta de la ficha full** [`flito-comprobantes-carga-y-asociacion.md`](./flito-comprobantes-carga-y-asociacion.md)
> **§7** (panel) y **§8** (a11y). Donde este doc dice algo distinto, **manda este doc**: está contrastado
> contra el contrato que **ya entró** con la HU #12629 (`flito-comprobantes.routes.ts`,
> `flito-comprobantes.aplicar.ts`, `flito-comprobantes.cruce.ts`, `shared-types/flito-comprobantes.ts`) y
> contra lo que #12612 ya pintó en `components/flito/DetalleComprobante.tsx`. Lo que no se nombra aquí
> **no cambia** respecto a §7/§8.
>
> Público: operador interno (`financiera`, `admin`). Tono: **tutea** (el de la ficha y el de
> `DetalleComprobante.tsx`). No es canal Cliente.
>
> Nota: no pude leer los AC1..AC8 en ADO desde este hilo (sin `az`). Este delta se ancla al contrato en
> código y a los siete puntos del pedido; si un AC contradice una decisión D-n de abajo, gana el AC y se
> anota aquí.

---

## Superficie tocada

`DetalleComprobante.tsx` (ya existe: `FlitModal full`, visor 55 % | lectura 45 %, «Releer», solo
lectura) **crece** para que un **pendiente** tenga, a la derecha, las tres decisiones + campos editables
+ pie con **una** primaria. Aplicados y descartados siguen en solo lectura (§7.8), sin botones.

Nada nuevo fuera del panel: ni columna, ni filtro, ni ruta, ni slug.

## Delta de claridad (qué se ve / qué se calla)

| | Antes (#12612) | Ahora (#12634) |
|---|---|---|
| Se ve primero | Chip de estado + motivo · carga · «Leído: tipo» | **Igual.** Debajo, en este orden: **(1) ¿pago o documentación?** · **(2) Trámite** (combobox con sugeridos) · **(3) Concepto** · «Datos leídos» · pie |
| Se calla | `extraccion` cruda; uuid; porcentajes | **Igual.** Se añade: `admite` de un candidato **solo** para el concepto elegido (una palabra por opción, no la matriz de seis) |
| Primaria | ninguna (solo lectura) | **Aplicar** / **Adjuntar** (un botón; el rótulo sigue a (1)). «Releer» (si `ocr_no_disponible`) y «Descartar» son secundarios |
| Densidad | ficha de lectura | **No empeora**: mismo grid, la columna derecha desplaza, el pie es fijo. La lista de candidatos va **en flujo** (empuja, no flota) |

---

## 1. Contrato real ↔ ficha §7: discrepancias resueltas

| # | Ficha §7 decía | Contrato (#12629) | Decisión |
|---|---|---|---|
| **D-1** | «Sugerido único» = `candidatos.length === 1`, preseleccionado | El servidor **fija** el cruce en `detalle.tramite` (uno solo, o desempatado entre varios); con ambigüedad `tramite = null` y los candidatos vienen igual en `detalle.candidatos[]` | **Preseleccionado ⇔ `detalle.tramite !== null`** (el campo muestra `idFlit · placa`). Con `tramite = null` y candidatos: campo vacío, lista abierta. Todos los candidatos llevan chip **«Sugerido»** |
| **D-2** | Chip «Sugerido · por {placa ∣ VIN ∣ ID FLIT}» sale del `cruce` de cada candidato | `CandidatoTramiteDto` **no trae** `cruce`; solo el comprobante lo trae (`detalle.cruce`) y solo cuando está fijado | La llave se **deriva en el front** sin dato nuevo: si `detalle.cruce` viene, se usa; si no, por candidato: `idFlit === idFlitLeido` → «por ID FLIT», `vin === vinLeido` → «por VIN», `placa === placaLeida` → «por placa» (ese orden); si nada casa, solo «Sugerido». **No se pide endpoint** |
| **D-3** | Motivo obligatorio si cambia (1), (2), (3) o un campo | `aplicarSchema`: motivo obligatorio **solo** si `campos` no está vacío; `aplicar()`: obligatorio si `tramiteId !== detalle.tramite.id` (incluye elegir **uno de varios** candidatos cuando el cruce no quedó fijado). Cambiar `concepto` o `esPago` **no** lo exige | **Se calca el contrato.** El `textarea` de motivo se monta cuando **(a)** el trámite elegido ≠ `detalle.tramite?.id` **o (b)** hay algún campo editado. Cambiar concepto o la marca pago/documentación **no** monta motivo (esa es la decisión de la visita, no una corrección de lectura). Se corrige §7.4 y §7.5 |
| **D-4** | Rótulo «Por qué cambias lo leído» | El motivo también cubre «elegí otro trámite» | Rótulo **«Motivo»**. Ayuda (`aria-describedby`): **«Mínimo 5 caracteres. Queda en la auditoría del comprobante. No escribas datos personales (nombres, cédulas, teléfonos).»** `maxLength=500` (el servidor corta en 500) |
| **D-5** | §7.5: tabla de campos **por concepto** (N.º de póliza, Aseguradora…), «obligatorios si es pago» | El detalle trae `campos[]` = los **10 universales siempre** + `destino.*` **solo si** hubo extracción especializada. `campos` del body admite claves universales y `destino.*`; una clave que no venga del extractor **no la leerá nadie** | **Se pintan los `campos[]` que vienen, tal cual** (como ya hace `DetalleComprobante`), sin inventar campos por concepto. Editables: `valorTotal`, `fechaPago`, `numeroDocumento`, `emisor` y todo `destino.*`. **Solo lectura con chip:** `placa`, `vin`, `idFlit` (explican el «Sugerido»); `tipoDocumento`, `esComprobantePago`, `concepto` **no** se listan como campo: ya están en la cabecera y en (1)/(3). La tabla por concepto de §7.5 queda para HU-2/HU-3 (cada dueño dirá qué `destino.*` exige) |
| **D-6** | Preselección de (1) y (3) «solo si confiable» leyendo `campos[].confiable` | `detalle.esPago` y `detalle.concepto` **ya son** `valorConfiable(...)` del servidor (`null` cuando no es confiable) | Preselección: (1) = `detalle.esPago` (`true` pago · `false` documentación · `null` ninguno); (3) = `detalle.concepto` (`null` → «Elige el concepto…»). Los chips de confianza salen de `campos[]` (`esComprobantePago`, `concepto`). Nota QA 8 de la ficha se lee así |
| **D-7** | Body `campos` = todos los valores | `confirmar()` pone en confianza 1 con firma **lo que venga** en `campos` | Se envía **solo el delta** (claves editadas, valor `trim()`); si no hay ninguna, `campos` **no va**. Un campo vaciado a mano no se envía (no hay «borrar lectura» en el contrato) |
| **D-8** | 409 `destino_no_admite` «sin botón» salvo detalle «autogestionada» | En #12629 **todo pago** responde `409 destino_no_admite { error: 'El pago de {concepto} aún no se aplica desde aquí', detalle: 'Los pagos se aplican en la siguiente entrega', puedeAdjuntar: true }`. `ErrorComprobanteDto.puedeAdjuntar` existe para `ya_pagado` **y** `destino_no_admite` | **Regla única:** cualquier 409 con **`puedeAdjuntar: true`** se pinta como **camino, no error** (bloque sin rojo, `role="alert"`): **«{idFlit} no admite {Concepto} como pago: {detalle ?? error}. Puedes adjuntar este documento como documentación del trámite.»** + botón **[ Adjuntar como documentación ]** (marca (1) = documentación y reenvía con `esPago: false`; el motivo y los campos escritos se conservan). Con `puedeAdjuntar` ausente/false: mismo copy sin la segunda frase ni botón; la persona cambia trámite o concepto |
| **D-9** | `POST /tramites/buscar` devuelve lista | Devuelve **`{ candidatos: CandidatoTramiteDto[] }`**, ≤ 20, body `{ buscar }` con **3..60** caracteres (400 `datos_invalidos` fuera de eso) | Input con `maxLength=60`; se dispara con ≥ 3 caracteres tras `useDebounce` 300 ms. Un 400 (no debería llegar) se pinta como el error del combobox con el `error` del servidor |
| **D-10** | `POST /:id/aplicar` → 200 «comprobante» | `{ resultado: 'aplicado', comprobante: ComprobanteDetalleDto }` | El toast usa `comprobante.tramite.idFlit` y `comprobante.concepto`. En **esta HU solo puede ocurrir para documentación**: toast **«Documentación adjuntada a {idFlit}.»** El toast de pago (con o sin diferencia) queda escrito en §7.6 para HU-2/HU-3 |
| **D-11** | `POST /:id/descartar` → 200 | `{ ok: true }`; motivo **5..500** | Toast **«Comprobante descartado.»**; `maxLength=500` |
| **D-12** | 404 = «Este comprobante ya no existe» | `no_encontrado` también sale por **«El trámite no existe»** y «El archivo del comprobante no existe» | 404: se pinta el **`error` del servidor** tal cual + **[ Actualizar la cola ]** (cierra y refresca). Sin decidir por texto |
| **D-13** | 400 `datos_invalidos` «Revisa los datos marcados» | Mensajes reales: «Asociar a un trámite distinto del sugerido exige motivo», «Confirmar campos exige motivo», «Campo desconocido: x», «Cuerpo inválido» | El cliente valida motivo **antes** de enviar (D-3), así que estos son red de seguridad: se pintan en el `role="alert"` del pie con el `error` del servidor y foco al `textarea` de motivo si está montado |
| **D-14** | §7.9 vacío: «sin Releer hasta que exista endpoint» (D18) | `POST /:id/releer` **existe** y `DetalleComprobante` ya lo pinta | **D18 queda superada.** En `ocr_no_disponible` el bloque «FLITO no pudo leer este documento.» + **Releer** (secundario) se mantiene **encima** del formulario; el resto del panel (decisiones, combobox, campos vacíos, Aplicar) se pinta igual. Tras releer con éxito el panel se repinta con el detalle nuevo (candidatos incluidos) |
| **D-15** | §7.4: sin `tramites.buscar` «escribir muestra el 403» | El 403 de `exigirFuncion` es `{ error, funcion, motivo }`; no hace falta provocarlo | Sin la función **no se llama nunca** al buscador: el combobox es **de solo selección** (input `readOnly`, `aria-autocomplete="none"`, placeholder «Elige un trámite sugerido»; ↓/clic abren la lista de `candidatos`). El copy 403 de §7.4 se reserva a la carrera (función revocada con el panel abierto) |

Códigos que **no** cambian: `tramite_liquidado`, `valor_ya_documentado` (+ `comprobanteAnteriorId`,
que el DTO ya declara), `ya_resuelto`, 403, 500/red — copy y acción de §7.6 se confirman tal cual.

---

## 2. Combobox de trámite: qué se reusa de `FlitOrganismoCombobox.tsx` y qué no

**Se reusa (calco):**
- Forma del `onKeyDown`: `↓`/`↑` mueven el activo con tope, `Enter` elige el activo, `Esc` cierra la
  lista con `e.preventDefault()` **y `e.stopPropagation()`** (el `useEscape` de `FlitModal` escucha en
  `window`; parar la propagación en el input basta para que el panel no se cierre). Con la lista
  cerrada, `Esc` **no** se intercepta: llega al modal y lo cierra (comportamiento normal).
- `ul role="listbox"` con `aria-label`, `li role="option"`, `aria-selected`, `max-h-52 overflow-auto`,
  `onMouseEnter` que mueve el activo, el mismo resaltado del activo/elegido que usa el precedente, la
  fila de dos renglones (principal + `text-[10px]` secundario).
- `useId()` para `listboxId` y los `id` de opción; `autoComplete="off"`.

**No se copia:**
- **El botón disparador + input interno.** Aquí el **input es el combobox** (`role="combobox"` en el
  `<input>`, `aria-expanded`, `aria-controls={listboxId}`, `aria-autocomplete="list"`,
  **`aria-activedescendant={idOpcionActiva}`**, `aria-haspopup="listbox"`). Un solo control: escribir y
  elegir es el mismo gesto (D9 de la ficha).
- **Opciones con `<button>` dentro del `li role="option"`.** El texto va directo en el `li` (rol
  válido; un botón dentro de una opción duplica el rol). Se elige con `onMouseDown` (no `onClick`) para
  que el `blur` del input no cierre la lista antes de registrar la elección.
- **La lista `absolute z-50` con `shadow-lg`.** Aquí va **en flujo**: dentro de una columna con
  `overflow-auto` una lista flotante se recorta; en flujo empuja «Concepto» hacia abajo mientras está
  abierta, que es exactamente lo que dibuja §7.1. Sin sombra extra, sin chevron giratorio ni
  `transition-*`.
- **El listener global de `mousedown`** para cerrar al clic fuera. Se cierra por `Esc`, elección o
  `blur` (con `onMouseDown` en las opciones el orden es seguro).
- **El input oculto `required`** para validación HTML5. La validación es al pulsar (D12 de la ficha).
- **El filtrado en cliente de un catálogo estático** (`normalizeSearch`). Aquí el servidor busca; el
  cliente solo **filtra los sugeridos** por el texto escrito (siguen primeros mientras coincidan con
  `idFlit`, `placa` o `vin`; con el campo vacío se muestran todos).

**Nombre y `aria`:** `<label for>` visible **«Trámite»** (con asterisco visual y `aria-required`); el
`role="combobox"` toma el nombre del label. El texto de cada opción (lo que lee el lector) es:
`Sugerido · por placa · FLIT-10250 · XYZ789 · Traspaso · Renting Andino · Impuesto: admite`.

**Botón «Quitar trámite»** (✕ dentro del campo, `aria-label="Quitar trámite"`): solo con trámite
elegido; vacía el campo, reabre la lista, devuelve el foco al input.

### Wireframe compacto — los estados del combobox (dentro de la columna derecha, ≈ 560 px en 1366)

```
Trámite *
[ ID FLIT, placa o VIN                                        ]   ← (a) campo vacío, sin candidatos
  Ningún trámite coincide con lo leído. Busca por ID FLIT,
  placa o VIN.                                                     ← vacío, en flujo, texto secundario

[ FLIT-10250 · XYZ789                                      ✕ ]   ← (b) sugerido fijado (detalle.tramite)

[ XYZ7                                                        ]   ← (c) escribiendo, ≥ 3 chars, 300 ms
  Buscando…                                                        ← role="status"

[ XYZ789                                                      ]   ← (d) lleno: sugeridos + resultados
  ┌──────────────────────────────────────────────────────────┐
  │ Sugerido · por placa   FLIT-10250 · XYZ789               │  ← option activa (aria-activedescendant)
  │ Traspaso · Renting Andino                Impuesto: admite│
  │ Sugerido · por placa   FLIT-10198 · XYZ789               │
  │ Matrícula · Renting Andino           Impuesto: ya pagado │
  │ FLIT-09877 · XYZ789                                      │  ← resultado del buscador (sin chip)
  │ Traspaso · Andina Leasing          Impuesto: no gestionado│
  └──────────────────────────────────────────────────────────┘

[ ZZZ999                                                      ]   ← (e) sin resultados
  Ningún trámite coincide con «ZZZ999».

[ XYZ789                                                      ]   ← (f) error de red / 5xx
  No se pudo buscar. Vuelve a intentarlo.                          ← role="alert"; seguir escribiendo reintenta

Trámite *                                                          ← (g) SIN candidatos y SIN función buscar
  No hay trámites sugeridos para este documento y tu usuario no
  puede buscar trámites. Pídele a un administrador la función
  «Buscar trámites para un comprobante», o descarta el comprobante.
```

En **(g)** el input **no se pinta** (no hay nada que escribir ni elegir) y la **primaria tampoco**
(nunca podría completarse): el pie queda con **Descartar**. Es el único caso en que el pie de un
pendiente no tiene primaria, y lo dice la línea de texto.

`{Concepto}: {admisión}` en la 2.ª línea de cada opción se pinta **solo cuando (3) tiene concepto**;
sin concepto elegido la 2.ª línea es solo `tipoTramite · empresa`. Labels de `AdmisionConcepto`
(constante `ADMISION_LABEL` en `lib/comprobantes.ts`): `admite` → **admite** · `ya_pagado` → **ya
pagado** · `no_gestionado` → **no gestionado** · `estado_no_permitido` → **estado no permitido** ·
`liquidado` → **liquidado** · `ya_documentado` → **ya documentado**. Los mismos textos son el sufijo
` · {admisión}` de las opciones del `<select>` Concepto cuando ≠ `admite` (§7.4 (3), se confirma).

---

## 3. Estados (4) — combobox y panel

### Combobox (lo que cambia respecto a §7.4)

| Estado | Copy | Semántica |
|---|---|---|
| Cargando | **Buscando…** | `role="status" aria-live="polite"`, en el sitio de la lista; la petición anterior se descarta si llega tarde (último texto gana) |
| Error | **No se pudo buscar. Vuelve a intentarlo.** | `role="alert"`; sin botón (seguir escribiendo reintenta). 400 del servidor: su `error` («Escribe entre 3 y 60 caracteres») |
| Vacío (sin candidatos, sin texto) | **Ningún trámite coincide con lo leído. Busca por ID FLIT, placa o VIN.** | texto secundario en flujo, no es alerta |
| Sin resultados (con texto ≥ 3) | **Ningún trámite coincide con «{texto}».** | `role="status"` |
| Lleno | lista (d) | `listbox` con sugeridos primero |
| (g) sin candidatos + sin función | ver wireframe | texto secundario; sin input, sin primaria |

### Panel (§7.9, confirmado con dos precisiones)

| Estado | Precisión |
|---|---|
| Cargando | El esqueleto ya existe en `DetalleComprobante` (6 líneas, `aria-busy`); se mantiene |
| Error | Ya existe: «No se pudo abrir el comprobante.» + Reintentar · 404 + Actualizar la cola. Se mantiene |
| Vacío (`ocr_no_disponible`) | «FLITO no pudo leer este documento.» + **Releer** (D-14) **y debajo el formulario entero** con chips «Sin lectura», (1) sin marcar, combobox en (a) o (g), campos vacíos. Siguiente paso: completar a mano y Aplicar, Releer, o Descartar |
| Lleno | §7.1 con D-1..D-8 |

---

## 4. Motivo — cuándo se monta y cómo se escribe

- Se monta (D-3) cuando `tramiteElegido !== detalle.tramite?.id` **o** `Object.keys(delta).length > 0`.
  Si deja de cumplirse (la persona vuelve al sugerido y deshace la edición) se **desmonta** y su texto
  se descarta.
- Rótulo **«Motivo»** · `textarea` `flitInp min-h-[64px]` · `maxLength=500` · ayuda con
  `aria-describedby`: **«Mínimo 5 caracteres. Queda en la auditoría del comprobante. No escribas datos
  personales (nombres, cédulas, teléfonos).»**
- La **misma ayuda** (mismo texto) va en el `textarea` de **Descartar** (§7.6) y en el de **«Motivo para
  descartar el anterior»** (`valor_ya_documentado`). Una sola constante `AYUDA_MOTIVO` en el componente.
- Validación al pulsar: **«Escribe el motivo (mínimo 5 caracteres).»** (`aria-invalid`, `<p role="alert">`,
  foco al `textarea`). Sustituye a «Escribe por qué cambias lo leído (mínimo 5 caracteres)» de §7.6.

---

## 5. Copy exacto del pie y de las respuestas (§7.6 confirmado / corregido)

| Elemento | Copy | Nota |
|---|---|---|
| Primaria (`flitBtnPrimary`) | **Aplicar** ⇄ **Adjuntar** según (1); en vuelo **Aplicando…** / **Adjuntando…** (`disabled`) | Confirmado. Con (1) sin marcar, dice **Aplicar** |
| Secundaria | **Descartar** | Confirmado; abre el bloque en línea de §7.6 (Cancelar / Descartar con `--flit-danger-ink`) |
| Secundaria condicional | **Releer** | Solo `ocr_no_disponible` + `comprobante.releer` (ya existe) |
| Validación (1) | **Di si es un comprobante de pago o documentación.** | Confirmado |
| Validación (2) | **Elige el trámite al que pertenece.** | Confirmado |
| Validación (3) | **Elige el concepto.** | Confirmado |
| Validación valor (pago) | **Escribe el valor pagado: sin valor no se puede aplicar un pago.** | Confirmado; aplica a `valorTotal` (y el servidor responde 400 `valor_requerido` con el mismo trato) |
| Validación motivo | **Escribe el motivo (mínimo 5 caracteres).** | **Corregido** (D-4) |
| 200 (documentación) | Toast **Documentación adjuntada a {idFlit}.** | Único 200 posible en esta HU |
| 409 con `puedeAdjuntar: true` (`ya_pagado` o `destino_no_admite`) | **{idFlit} no admite {Concepto} como pago: {detalle ?? error}. Puedes adjuntar este documento como documentación del trámite.** + **[ Adjuntar como documentación ]** | **Regla única** (D-8). Bloque sin rojo, `role="alert"`. Para `ya_pagado` el `detalle` del servidor ya dice «Ese SOAT ya está pagado» |
| 409 sin `puedeAdjuntar` | **{idFlit} no admite {Concepto} como pago: {detalle ?? error}.** | Sin botón |
| 409 `tramite_liquidado` | **La liquidación de {idFlit} está sellada. Reversa la liquidación en el reporte de costos y vuelve a aplicar.** + enlace **Ir al reporte de costos** | Confirmado |
| 409 `valor_ya_documentado` | **{idFlit} ya tiene un valor de {Concepto} documentado con otro comprobante. Para usar este, descarta el anterior.** + **[ Reemplazar ]** → motivo → **[ Descartar el anterior y aplicar ]** | Confirmado; `comprobanteAnteriorId` ya está en el DTO |
| 409 `ya_resuelto` | **Alguien resolvió este comprobante mientras lo tenías abierto.** + **[ Actualizar la cola ]** | Confirmado |
| 404 | `error` del servidor + **[ Actualizar la cola ]** | **Corregido** (D-12) |
| 400 `datos_invalidos` | `error` del servidor en el `alert` del pie; foco al motivo si está montado | **Corregido** (D-13) |
| 403 | **Tu usuario no puede aplicar comprobantes. Vuelve a entrar para actualizar tus permisos.** | Confirmado |
| 500 / red | **No se pudo aplicar. Vuelve a intentarlo.** + mensaje | Confirmado |
| Descartar 200 | Toast **Comprobante descartado.** | Confirmado |

El `{idFlit}` de los 409 es el del trámite **elegido en (2)** (el servidor no lo devuelve en el error).

---

## 6. Cabe en 1366 · vive en `FlitModal full` · foco

- **Contenedor:** `FlitModal full` = `max-w-[min(96rem,96vw)]`, `h-[calc(100dvh-3rem)]`. En 1366×768:
  ≈ 1311 px de ancho, 1263 útiles tras `px-6`; columna derecha (45 %, `gap-4`) ≈ **560 px**. La opción
  más larga del combobox (`Sugerido · por placa   FLIT-10250 · XYZ789` / `Traspaso · Renting Andino
  Impuesto: no gestionado`) cabe en dos renglones sin truncar; `empresa` se trunca con `truncate` si
  pasa. Alto útil ≈ 660 px: cabecera (3 líneas) + (1) + (2) cerrado + (3) ≈ 280 px; los campos y el
  motivo **desplazan** dentro de la columna; el pie (**Descartar · Aplicar**) es **fijo** (`shrink-0`,
  borde superior `--flit-border-soft`). No se toca el grid de `DetalleComprobante`.
- **Foco al abrir** (§8): al **input del combobox** (`ref.focus()` tras montar el detalle); en (g) o en
  solo lectura, al `dialog` (lo que `FlitModal` ya hace). (1) queda antes en el orden de tabulación.
- **Esc:** con lista abierta cierra la lista (D-2 de §2); con bloque de Descartar abierto lo cierra y
  devuelve el foco a «Descartar»; si no, cierra el panel (`FlitModal`).
- **Al aplicar/descartar con éxito:** cierra; `restoreFocusRef` al `h1` de la página (ya cableado en
  #12612). La cola refresca y anuncia por su `role="status"` sr-only.
- **Sin efectos:** sin animación al abrir la lista ni al montar el motivo; sin sombra en la lista en
  flujo; chips y botones del kit.

---

## Permiso / slug

Sin cambios: `pagina.flito_comprobantes` (0198). Funciones que decide el panel con `hasFuncion`:
`comprobantes.comprobante.ver` (abrir) · `comprobantes.tramites.buscar` (input editable vs solo
selección, D-15) · `comprobantes.comprobante.aplicar` (primaria; sin ella «Tu usuario puede ver este
comprobante pero no aplicarlo.») · `comprobantes.comprobante.descartar` (Descartar) ·
`comprobantes.archivo.descargar` (visor, ya) · `comprobantes.comprobante.releer` (Releer, ya).
Sin la función el control **no existe**, no se apaga.

---

## Notas para QA (≤ 10)

| # | Aserto | Mutante |
|---|---|---|
| 1 | Detalle con `tramite` fijado → el combobox muestra `idFlit · placa` y **no** monta motivo; al pulsar Adjuntar el body **no lleva `motivo`** y `tramiteId === detalle.tramite.id` | Exigir motivo con el sugerido |
| 2 | Detalle con `tramite = null` y 2 candidatos → campo vacío, lista abierta, ambos con «Sugerido · por placa» (derivado de `placaLeida`); elegir uno **monta** el motivo y Adjuntar sin él → alert «Escribe el motivo…», foco al textarea, **0** POST | Enviar sin motivo → 400 del servidor |
| 3 | Editar `valorTotal` → body `campos === { valorTotal: '312000' }` (solo el delta) + `motivo`; sin editar nada → **sin clave `campos`** | Enviar los 10 campos |
| 4 | Cambiar (3) o (1) respecto a `detalle.concepto`/`detalle.esPago` **no** monta motivo | Motivo por concepto |
| 5 | Escribir «XYZ7» → **una** `POST /tramites/buscar` `{buscar:'XYZ7'}` tras 300 ms, «Buscando…» en `role="status"`, resultados **debajo** de los sugeridos; `input[maxlength=60]` | GET con query; sin debounce |
| 6 | Esc con lista abierta → lista cerrada, `[role=dialog]` sigue; Esc de nuevo → panel cerrado | Propagación al `useEscape` |
| 7 | `aria-activedescendant` del input = `id` de la opción activa tras ↓; `li[role=option]` sin `<button>` dentro | Copiar el `li > button` del precedente |
| 8 | 409 `{codigo:'destino_no_admite', puedeAdjuntar:true, detalle:'…'}` → bloque con «Puedes adjuntar…» y botón; pulsarlo → segundo POST con `esPago:false` y el mismo `motivo`; el bloque no usa rojo. Mismo test con `codigo:'ya_pagado'` | Tratar `destino_no_admite` como error sin botón |
| 9 | Sesión sin `comprobantes.tramites.buscar` y detalle sin candidatos → no hay `input[role=combobox]`, no hay «Aplicar», se lee «Pídele a un administrador…», sí hay «Descartar»; con candidatos → input `readonly` y **0** POST al escribir | Llamar al buscador y pintar 403 |
| 10 | Los tres `textarea` de motivo (aplicar, descartar, reemplazar) tienen `aria-describedby` que contiene «No escribas datos personales» y `maxlength=500` | Ayuda solo en uno |

---

```
HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: /home/david/flit/flito-comprobantes-web/docs/ux/flito-comprobantes-panel-asociacion-12634-slim.md (delta de §7/§8 de flito-comprobantes-carga-y-asociacion.md; manda sobre la ficha donde difiere)
  Oficio: primaria única (Aplicar/Adjuntar; en (g) ninguna, dicho) | jerarquía dicha (estado+motivo → 3 decisiones → campos → pie) | vacío/error con siguiente paso (combobox 6 estados, panel 4, 409 con camino) | sin efectos (lista en flujo, sin sombra, sin animación)
  Densidad: sin cambio (mismo grid de DetalleComprobante; la lista empuja, no apila)
  Pantallas: 1 (panel) | Requerimientos nuevos de datos: ninguno (la llave del «Sugerido» se deriva en el front; todo lo demás está en el contrato de #12629)
  Siguiente: frontend-agent con D-1..D-15 y las 10 notas QA; el hilo pega AC1..AC8 y anota aquí si alguno contradice una D-n
```
