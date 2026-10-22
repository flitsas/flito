# UX slim — Cola de comprobantes: estado de asociación, chip «Aplicados», enlace al trámite (HU #12635 · Feature #12606 · Épica #12245)

> **Delta de la ficha full** [`flito-comprobantes-carga-y-asociacion.md`](./flito-comprobantes-carga-y-asociacion.md)
> **§5** (cola), **§6** (modal de carga) y **§7.3/§7.8** (cabecera del detalle), y del slim
> [`flito-comprobantes-panel-asociacion-12634-slim.md`](./flito-comprobantes-panel-asociacion-12634-slim.md).
> Donde este doc dice algo distinto, **manda este doc**. Lo que no se nombra aquí **no cambia**.
>
> Contrastado contra el código de la rama `HU/12635` (HEAD 4923027): `pages/FlitoComprobantes.tsx`,
> `components/flito/CargaComprobantes.tsx`, `components/flito/DetalleComprobante.tsx`,
> `components/flit/VisorSoportes.tsx`, `pages/FlitoTramites.tsx`, `shared-types/flito-comprobantes.ts`
> (`ASOCIACIONES_COMPROBANTE`, `AsociacionComprobante`, `ItemCargaComprobante`,
> `ResultadoCargaComprobantes.aplicados`) y `flito-comprobantes.service.ts` (`condicionAsociacion`).
>
> Público: operador interno (`financiera`, `admin`). Tono de la cola y del modal: **tutea** (el de la
> ficha y el de la pantalla). La ficha de Ayuda trata de **usted**. No es canal Cliente.
>
> Nota: no pude leer los AC1..AC5 en ADO desde este hilo (sin `az`). Este delta se ancla al contrato en
> código y a los seis puntos del pedido; si un AC contradice una decisión de abajo, gana el AC y se
> anota aquí.

---

## Oficio (respondido antes de dibujar)

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer quien abre esto? | **Igual que en la ficha**: resolver pendientes fila a fila. Lo nuevo responde tres preguntas de esa misma visita: (a) *«¿cuáles de estos son rechazos de pago y cuáles solo esperan asociación?»* (selector + chip), (b) *«¿qué aplicó FLITO solo en la carga que acabo de subir?»* (chip Aplicados del resultado), (c) *«¿qué trámite es y qué documentos tiene ya?»* sin salir de la cola (enlace + Ver soportes). |
| ¿Qué se ve primero? | La cola de Pendientes, como hoy. El selector «Estado de asociación» va **pegado a las pills** porque las afina; el chip de la fila **dice más con el mismo espacio** (sustituye el rótulo, no añade columna). |
| ¿Qué se calla y dónde vive? | «Ver soportes» **no** va en la fila (vive en el detalle): la fila conserva una sola acción. El uuid del trámite va en la ruta del API del visor, nunca en la URL del SPA. La placa va en `?buscar=` de Gestión Trámites (no es PII; ya se muestra en la fila). |
| ¿Cuál es la única primaria? | **No cambia**: «Cargar comprobantes» en la página; «Subir y procesar» → «Listo» en el modal; «Aplicar/Adjuntar» en el panel. «Ver trámite» y «Ver soportes» son enlaces de texto. |
| ¿Vacío y error dicen el siguiente paso? | Sí: el vacío filtrado nombra los filtros y «Limpiar filtros»; el error de la cola no cambia (Reintentar); el visor de soportes trae su propio vacío. |
| ¿Efectos o patrón nuevo? | Ninguno. `<select>` `flitInp` como los dos que ya hay, `StatusChip` con tonos del kit, `VisorSoportes` tal cual (una clave más en `ORIGEN_SOPORTE`). |

---

## Superficie tocada

| Superficie | Qué cambia | Qué no |
|---|---|---|
| **Cola** `/flito/comprobantes` (`FlitoComprobantes.tsx`) | (1) selector «Estado de asociación» en la tarjeta de filtros, con `?asociacion=` en la URL; (2) el chip de la columna Estado pasa de 3 rótulos a 6; (3) enlace «Ver trámite» en la celda Trámite; (4) copy del vacío filtrado | Pills, selects Concepto y Motivo, chip de carga, «Limpiar filtros», paginación, agrupación por carga, «Asociar»/«Ver», toast y región `status`, esqueleto, error, subtítulo (ver D-9) |
| **Modal de carga** (`CargaComprobantes.tsx`) | Chip «Aplicados {n}» **primero** y filas «Aplicado» primero en la tabla de resultado | Picker, `RanuraCargaMasiva`, progreso, «Listo», duplicados con «Ver el original», fallidos |
| **Detalle** (`DetalleComprobante.tsx`, cabecera) | Mismo chip de 6 rótulos que la fila; línea de enlaces «Ver trámite {idFlit} ↗ · Ver soportes» | Panel de asociación de #12634 entero (tres decisiones, combobox, campos, motivo, pie, códigos 409); ficha de solo lectura §7.8 salvo el chip |
| **`VisorSoportes.tsx`** | `ORIGEN_SOPORTE.comprobante = 'Comprobante'` | Todo lo demás |
| **Ficha de Ayuda** `content/ayuda/flito_comprobantes.md` | Tres frases (§6) | Estructura y el resto del texto |

Sin ruta nueva, sin `PageSlug` nuevo, sin migración, sin endpoint nuevo.

---

## Delta de claridad (qué se ve / qué se calla)

| | Hoy (#12634) | Con #12635 |
|---|---|---|
| Filtros | Pills · Concepto · Motivo · chip de carga · Limpiar | Pills · **Estado de asociación** · Concepto · Motivo · chip de carga · Limpiar. El selector va **entre las pills y Concepto** porque afina la pill (estado grueso → estado fino); Concepto y Motivo siguen siendo «de qué» y «por qué» |
| Columna Estado | `Pendiente` / `Aplicado` / `Descartado` + segundo renglón | **Seis rótulos** en el mismo chip; el segundo renglón ya no repite «automático»/«manual» porque lo dice el chip. **Sustituye**, no acompaña: un chip por fila (dos chips en 210 px no se leen) |
| Columna Trámite | `idFlit` y placa | `idFlit`, placa y, cuando hay placa y la persona tiene la página, tercer renglón `text-xs` **Ver trámite ↗** |
| Acción de la fila | Asociar / Ver | **Igual.** «Ver soportes» **no** entra en la fila |
| Resultado de la carga | Pendientes · Duplicados · Fallidos | **Aplicados** · Pendientes · Duplicados · Fallidos (orden de la ficha §6.2, ya escrito allí como contrato) |
| Densidad | 7 columnas ≈ 1020 px | **Sin columna nueva.** El tercer renglón de Trámite añade ≈ 16 px de alto solo en filas con trámite y placa (en Pendientes son pocas: las que cruzaron). La tarjeta de filtros pasa de ≈ 930 px a ≈ 1200 px en una línea (cabe en los 1258 px del contenedor a 1366); con el chip de carga presente **envuelve a dos líneas** (`flex-wrap`, ya está) |

---

## 1. Cola — selector «Estado de asociación»

### 1.1 Wireframe de la tarjeta de filtros (1366, sin chip de carga)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ (● Pendientes 37) (Aplicados) (Descartados) (Todos)  [Todos los estados de asociación ▾]        │
│ [Todos los conceptos ▾]  [Todos los motivos ▾]                               [Limpiar filtros] │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Con `asociacion = rechazado_pago` (la pill se mueve sola a Pendientes, ver 1.3):

```
│ (● Pendientes 37) (Aplicados) (Descartados) (Todos)  [Rechazado como pago ▾]                    │
│ [Todos los conceptos ▾]  [Todos los motivos ▾]                               [Limpiar filtros] │
```

- `<select>` `flitInp w-auto py-1.5` con `<span class="sr-only">Estado de asociación</span>` dentro del
  `label`, calco exacto de Concepto y Motivo (mismo componente, mismo alto).
- **Opciones, en este orden** (sigue el orden de las pills, no el de la constante):

| Valor (`AsociacionComprobante`) | Rótulo de la opción | Pill que implica |
|---|---|---|
| `''` | **Todos los estados de asociación** | la que esté |
| `pendiente` | **Pendiente de asociar** | Pendientes |
| `rechazado_pago` | **Rechazado como pago** | Pendientes |
| `aplicado_automatico` | **Aplicado automático** | Aplicados |
| `aplicado_manual` | **Aplicado manual** | Aplicados |
| `adjuntado` | **Adjuntado** | Aplicados |
| `descartado` | **Descartado** | Descartados |

Los seis rótulos viven en **una** constante exhaustiva `ASOCIACION_COMPROBANTE_LABEL:
Record<AsociacionComprobante, string>` (shared-types, calco de `MOTIVO_PENDIENTE_COMPROBANTE_LABEL`) y
se usan en el selector, en el chip de la fila y en el chip del detalle. Un rótulo, tres sitios.

### 1.2 Cómo conviven selector y pills (AC1)

Regla única: **la pill es el estado grueso; el selector, el fino; nunca se contradicen.**

| Gesto | Qué pasa |
|---|---|
| Elegir una opción del selector | La pill **salta** a la que esa opción implica (tabla 1.1). Si salta fuera de Pendientes, Motivo se vacía (regla que ya existe en `cambiarPill`). `page = 1` |
| Elegir «Todos los estados de asociación» | El selector se vacía; la pill se queda donde está |
| Pulsar una pill | Si la opción elegida **pertenece** a esa pill (o la pill es **Todos**), se conserva; si no, el selector vuelve a «Todos los estados de asociación». Ej.: con «Rechazado como pago» pulsar Aplicados → selector vacío, pill Aplicados |
| «Limpiar filtros» | Vuelve a Pendientes sin concepto, motivo, carga **ni asociación** (y borra `?asociacion=`) |
| Petición | `estado` de la pill (si no es Todos) **y** `asociacion` si hay opción. Coherentes por construcción; `condicionAsociacion` del servidor no necesita cambios |
| Contador de la pill Pendientes | **No cambia**: es el `total` de `estado=pendiente` sin más filtros; con asociación puesta, se conserva el último (`hayFiltros` es `true`) |

Con `rechazado_pago` el select Motivo sigue visible (es Pendientes) aunque sea redundante: no se
añade una regla para esconderlo. Si la persona elige un motivo distinto de «El trámite no admite este
concepto», ve el vacío filtrado de 1.5 y «Limpiar filtros».

### 1.3 URL: `?asociacion=`

Calco de `?alerta=` en `FlitoTramites.tsx`: **derivado** de `useSearchParams`, no copiado a un
`useState`.

- Al entrar con `?asociacion=aplicado_manual`: selector en «Aplicado manual», **pill Aplicados** (la que
  implica), consulta con `estado=aplicado&asociacion=aplicado_manual`.
- Al entrar con un valor que **no está** en `ASOCIACIONES_COMPROBANTE` (`?asociacion=foo`): se ignora
  (selector en «Todos…», pill Pendientes), **no** se reescribe la URL al entrar; el parámetro desaparece
  en el primer cambio de filtro.
- Cambiar el selector: `setSearchParams(next, { replace: true })`; «Todos…», «Limpiar filtros» o una
  pill que no la contenga hacen `next.delete('asociacion')`.
- Pill, concepto, motivo y chip de carga **siguen en estado local** (no entran en la URL en esta HU;
  ampliarlo es otra decisión).
- `page` no va en la URL (como hoy).

### 1.4 Chip de la fila y del detalle: seis rótulos

Función única `asociacionDe(c): AsociacionComprobante` en `lib/comprobantes.ts`, espejo **exacto** de
`condicionAsociacion` del servidor (una fila devuelta por `?asociacion=X` tiene que pintar el chip X):

| Orden | Condición sobre `ComprobanteListaDto` | Valor | Rótulo | Tono |
|---|---|---|---|---|
| 1 | `estado === 'descartado'` | `descartado` | **Descartado** | `neutral` |
| 2 | `estado === 'pendiente'` y `motivoPendiente === 'destino_no_admite'` | `rechazado_pago` | **Rechazado como pago** | `warning` |
| 3 | `estado === 'pendiente'` (resto) | `pendiente` | **Pendiente de asociar** | `warning` |
| 4 | `estado === 'aplicado'` y `esPago === false` | `adjuntado` | **Adjuntado** | `active` |
| 5 | `estado === 'aplicado'` y `aplicadoAutomaticamente` | `aplicado_automatico` | **Aplicado automático** | `success` |
| 6 | `estado === 'aplicado'` (resto) | `aplicado_manual` | **Aplicado manual** | `success` |

`esPago === null` en un aplicado no debería existir (aplicar lo fija); si llega, cae en 5/6 como pago,
igual que en el servidor un `es_pago` nulo no entra en `adjuntado`.

**Segundo renglón de Estado** (`textoEstado`, `text-xs` tenue) — se recorta lo que el chip ya dice:

| Chip | Segundo renglón |
|---|---|
| Pendiente de asociar | `detallePendiente ?? MOTIVO_PENDIENTE_COMPROBANTE_LABEL[motivo]` (**igual que hoy**) |
| Rechazado como pago | `detallePendiente` («Ese SOAT ya está pagado») o, si no viene, el label «El trámite no admite este concepto» (**igual que hoy**) |
| Aplicado automático | **`{fecha}`** (antes «automático · {fecha}»: la palabra se fue al chip) |
| Aplicado manual | **`por {aplicadoPorNombre} · {fecha}`** (igual que hoy) |
| Adjuntado | **`por {aplicadoPorNombre} · {fecha}`**; si `aplicadoAutomaticamente`, **`{fecha}`** |
| Descartado | `{fecha}` (**igual que hoy**) |

**Cabecera del detalle** (`DetalleComprobante.tsx:130-133`): el mismo chip y el mismo segundo texto,
tomados de la misma función. La frase «manual · por X» desaparece (lo dice el chip). El resto de la
cabecera («Carga …», «Leído: …», la línea «Comprobante de pago · SOAT · FLIT-… · cruce por placa») no
cambia.

Ancho: «Rechazado como pago» es el rótulo más largo (≈ 150 px en `StatusChip`); la columna Estado
tenía 210 px estimados. Cabe.

### 1.5 Estados (4) de la cola con el filtro nuevo

| Estado | Qué se ve | Siguiente paso |
|---|---|---|
| **Cargando** | `PageContentSkeleton` con `aria-busy`, **igual que hoy**; la tarjeta de filtros (con el selector) sigue pintada y usable | Esperar |
| **Error** | **«No se pudo cargar la cola de comprobantes.» + mensaje + Reintentar**, **igual que hoy**; el selector conserva su valor y la URL no se toca | Reintentar |
| **Vacío filtrado** (cualquier filtro distinto del arranque: pill, asociación, concepto, motivo, carga) | `FlitEmpty`, dos líneas: **«Ningún comprobante coincide con los filtros.»** / **«Cambia el estado de asociación, el concepto o el motivo, o pulsa Limpiar filtros.»** El botón **Limpiar filtros** es el de la tarjeta (ya visible, `ml-auto`); **no se duplica** dentro del vacío | Limpiar filtros |
| **Vacío sin filtros** | **Igual que hoy** («No hay comprobantes por asociar.» + «Cuando cargues documentos…») | Cargar comprobantes |
| **Lleno** | Wireframe 1.6 | Asociar / Ver |

### 1.6 Wireframe — fila con trámite (pill Aplicados, selector «Todos…»)

```
┌──────────────────┬──────────────┬───────────────┬─────────────┬───────────┬──────────────────────┬──────────┐
│ DOCUMENTO        │ LEÍDO        │ CONCEPTO      │ TRÁMITE     │ VALOR     │ ESTADO               │          │
├──────────────────┴──────────────┴───────────────┴─────────────┴───────────┴──────────────────────┴──────────┤
│ Carga 16 sep 2026 · 10:42 · Ana Pérez · 37 documentos en 12 archivos                    Solo esta carga     │
├──────────────────┬──────────────┬───────────────┬─────────────┬───────────┬──────────────────────┬──────────┤
│ soat-sep.pdf     │ Factura SOAT │ SOAT          │ FLIT-10234  │ $ 950.000 │ [● Aplicado automát…]│ [Ver]    │
│                  │ Pago         │               │ ABC123      │           │ 16 sep 2026          │          │
│                  │              │               │ Ver trámite↗│           │                      │          │
│ transf-0912.png  │ Transferenc… │ Logística     │ FLIT-10250  │ $ 80.000  │ [● Aplicado manual]  │ [Ver]    │
│                  │ Pago         │               │ JKL456      │           │ por Ana Pérez · 16 s…│          │
│                  │              │               │ Ver trámite↗│           │                      │          │
│ cedula-cert.pdf  │ No es un pago│ Trámite digi… │ FLIT-10250  │ —         │ [● Adjuntado]        │ [Ver]    │
│                  │ Documentación│               │ JKL456      │           │ por Ana Pérez · 16 s…│          │
│                  │              │               │ Ver trámite↗│           │                      │          │
└──────────────────┴──────────────┴───────────────┴─────────────┴───────────┴──────────────────────┴──────────┘
```

Y en Pendientes, una fila «Rechazado como pago» (tiene trámite porque el cruce sí se fijó):

```
│ soat-sep.pdf     │ Factura SOAT │ SOAT          │ FLIT-10234  │ $ 950.000 │ [● Rechazado como pa…]│ [Asociar]│
│                  │ Pago         │               │ ABC123      │           │ Ese SOAT ya está pag…│          │
│                  │              │               │ Ver trámite↗│           │                      │          │
```

---

## 2. Modal de carga — chip «Aplicados»

### 2.1 Resultado (todas las tandas 200)

```
│  41 documentos leídos en 37 archivos                                          │
│  [Aplicados 22] [Pendientes 15] [Duplicados 3] [Fallidos 1]                   │
│  ┌ ARCHIVO           │ RESULTADO    │ DETALLE                               ┐ │
│  │ soat-abc123.pdf   │ [Aplicado]   │ SOAT · FLIT-10234 · $ 950.000         │ │
│  │ consolidado.pdf   │ [Aplicado]   │ Impuesto · FLIT-10250 · $ 312.000     │ │
│  │ p. 1-2            │              │                                       │ │
│  │ cedula-cert.pdf   │ [Aplicado]   │ Documentación · FLIT-10250 · Trámite… │ │
│  │ consolidado.pdf   │ [Pendiente]  │ Varios trámites posibles              │ │
│  │ p. 3-4            │              │                                       │ │
│  │ …                                                                        │ │
│  [ Listo ]                                                                   │
```

- **Chip**: `StatusChip tone="success"` **«Aplicados {resultado.aplicados.length}»**, **primero** de los
  cuatro; siempre se pinta, aunque valga 0 (regla de la ficha: los cuatro fijos). Orden fijo:
  Aplicados · Pendientes · Duplicados · Fallidos.
- **Tabla**: las filas de `aplicados` van **primero** con chip `success` **«Aplicado»**; `esDuplicado:
  false`. Después pendientes, duplicados, fallidos (sin cambio).
- **Detalle**: se pinta **`detalle` del servidor tal cual** (`ItemCargaComprobante.detalle`, contrato ya
  escrito en shared-types: `{Concepto} · {idFlit} · {pesos(valor)}`; documentación `Documentación ·
  {idFlit} · {Concepto}`). **No** se recompone en el front con `concepto`/`idFlit` del ítem.
- **Sin enlace** desde la fila «Aplicado» del resultado: al pulsar «Listo» la cola queda filtrada por
  esa carga y allí está «Ver» y «Ver trámite». No se duplica.
- El comentario `«Aplicados» no se pinta en este Feature` de `CargaComprobantes.tsx:87` se retira.
- **«Listo»** sigue igual: chip de carga + pill Pendientes. Si todo se aplicó, se ve el vacío filtrado
  («Ningún comprobante coincide…») **con el chip de carga** para quitarlo o con la pill Aplicados a un
  clic. No se salta a Aplicados por la persona (D4 de la ficha, se confirma).

### 2.2 Estados del modal

**No cambian** (§6.3 de la ficha). El único caso nuevo es *lleno con aplicados*, arriba.

---

## 3. Enlace «Ver trámite» y botón «Ver soportes»

### 3.1 «Ver trámite» — en la fila y en el detalle

| | Fila (celda Trámite, tercer renglón `text-xs`) | Detalle (cabecera, línea de enlaces) |
|---|---|---|
| Texto visible | **Ver trámite ↗** | **Ver trámite FLIT-10234 ↗** |
| Nombre accesible | `aria-label="Ver trámite FLIT-10234"` (empieza por el texto visible; el `idFlit` está en la línea de arriba de la misma celda, no se repite en pantalla) | el propio texto |
| Se pinta si | `c.tramite !== null` **y** `c.tramite.placa !== null` **y** `hasPage(user, 'flito_tramites')` | ídem con `detalle.tramite` |
| Destino | `/flito/tramites?buscar={encodeURIComponent(placa)}` | ídem |
| Cómo | `<a href target="_blank" rel="noopener">` con estilo de enlace de texto (`flit-focus underline`, `--flit-blue-text`) | ídem |

- **Sin placa no hay enlace** (tampoco apagado): `?buscar=` vacío abriría Gestión Trámites sin filtro y
  la persona tendría que buscar a mano lo que ya tenía delante. Es el requisito del pedido.
- **Sin la página `flito_tramites` no hay enlace**: el destino daría 403. Guarda por `hasPage`, no por
  rol (`financiera` puede no tener Gestión Trámites).
- `FlitoTramites.tsx:119` **ya lee `?buscar=`** al montar (`new URLSearchParams(window.location.search)`)
  y el servidor busca por placa con guiones tolerados. **No hace falta tocar `FlitoTramites`.**
- **Nueva pestaña** (`↗`): la cola es una visita de fila en fila con filtros en estado local; navegar en
  la misma pestaña los perdería. Mismo gesto que «Abrir el archivo original ↗».
- En un **pendiente**, el enlace apunta a `detalle.tramite` (el cruce fijado por el servidor), **no** al
  trámite que la persona elija en el combobox. El frontend no lo enlaza al combobox.

### 3.2 «Ver soportes» — solo en el detalle

```
│ [● Aplicado automático] 16 sep 2026                                          │
│ Carga 16 sep 2026 · 10:42 · Ana Pérez                                        │
│ Leído: Factura SOAT [Alta]                                                   │
│ Comprobante de pago · SOAT · FLIT-10234 · ABC123 · cruce por placa           │
│ Ver trámite FLIT-10234 ↗ · Ver soportes                                      │
│ ─────────────────────────────────────────────────────────────────────────    │
│ Valor al aplicar      $ 950.000                                              │
```

- Botón de texto (`flit-focus underline`, mismo estilo que «Ver el soporte aplicado ↗»), rótulo
  **«Ver soportes»**, sin flecha (abre un modal, no una pestaña).
- Se pinta si `detalle.tramite !== null` **y** `hasFuncion('tramites.tramite.ver_soportes')`. Sin la
  función **no existe** (la ruta `GET /flito/tramites/:id/soportes` la exige con `exigirFuncion`). No
  depende de la placa.
- Abre `VisorSoportes` con `ruta="/flito/tramites/{tramite.id}/soportes"` y `titulo={idFlit}` → título
  **«Documentos de FLIT-10234»**. El uuid va en la ruta del **API**, no en la URL del SPA.
- Es un `FlitModal full` **encima** del detalle (dos `[data-flit-modal]`), como ya ocurre con «Ver el
  original» desde el modal de carga (nota QA 7 de la ficha). Esc cierra solo el de arriba. Se acepta
  porque la alternativa (cerrar el detalle para ver soportes) rompe la visita.
- `VisorSoportes.ORIGEN_SOPORTE` gana **`comprobante: 'Comprobante'`**: hoy un soporte con
  `origen: 'comprobante'` (lo escribe `soportes-consulta.ts:116`) se rotula con el literal crudo.
  Un renglón, y lo heredan Gestión Trámites, el reporte y la tabla de derechos.
- Estados del visor: los suyos (Cargando… / error / `FlitEmpty` «Este trámite no tiene ningún documento
  cargado todavía.» / lista + `VisorPdf`). No se tocan.
- Línea de enlaces: separador ` · ` en texto tenue; si solo hay uno de los dos, sin separador; si no hay
  ninguno, la línea no se monta. Va **antes** de «Valor al aplicar» en solo lectura y **antes** de las
  tres decisiones en un pendiente (es cabecera).

### 3.3 Por qué «Ver soportes» no va en la fila

La fila tiene **una** acción (`Asociar`/`Ver`). Un segundo botón por fila en 37 filas es ruido para una
pregunta que se hace *después* de abrir una: «¿qué documentos tiene ya este trámite?». Y la guarda
`ver_soportes` no la tiene toda Financiera: en la fila se vería una columna a medias.

---

## 4. Copy exacto (resumen)

| Elemento | Copy |
|---|---|
| Selector (label sr-only) | **Estado de asociación** |
| Opción vacía | **Todos los estados de asociación** |
| Opciones | **Pendiente de asociar** · **Rechazado como pago** · **Aplicado automático** · **Aplicado manual** · **Adjuntado** · **Descartado** |
| Chip de fila / detalle | los mismos seis rótulos |
| Vacío filtrado | **Ningún comprobante coincide con los filtros.** / **Cambia el estado de asociación, el concepto o el motivo, o pulsa Limpiar filtros.** |
| Chip del resultado | **Aplicados {n}** |
| Chip de fila del resultado | **Aplicado** |
| Enlace en fila | **Ver trámite ↗** (`aria-label` **Ver trámite {idFlit}**) |
| Enlace en detalle | **Ver trámite {idFlit} ↗** |
| Botón en detalle | **Ver soportes** |
| Título del visor | **Documentos de {idFlit}** (lo pone `VisorSoportes`) |
| Origen en el visor | **Comprobante** |
| Segundo renglón, aplicado automático | **{fecha}** |

Tono: la cola y el detalle tutean («Cambia…», «pulsa…»), como el resto de la pantalla.

---

## 5. Qué NO cambia (escrito para que nadie lo amplíe de paso)

- El **panel de asociación** de #12634 entero: tres decisiones, combobox, campos, motivo, pie, 409 con
  camino, Releer, Descartar en línea. Solo cambia la **cabecera** (chip + línea de enlaces).
- Las **pills** existentes, su contador y la regla «Motivo solo en Pendientes».
- Selects **Concepto** y **Motivo**, chip de carga, «Solo esta carga», «Limpiar filtros» (salvo que ahora
  también borra la asociación).
- Las **siete columnas** y su orden. Ninguna columna nueva.
- Modal de carga: picker, validación, progreso, «Listo», duplicados y fallidos.
- Endpoints: `GET /flito/comprobantes` ya acepta `asociacion` (HU #12629 AC8); `GET
  /flito/tramites/:id/soportes` ya existe con su guarda. **Ningún requerimiento nuevo de datos.**
- No se guarda pill/concepto/motivo en la URL. No se añade `?tramiteId=` a la cola.

---

## 6. Ficha de Ayuda (`content/ayuda/flito_comprobantes.md`, usted) — tres cambios

1. **Pasos · 3** — sustituir el arranque por: «Al terminar, lea el resultado por documento: **Aplicado**
   (FLITO lo cruzó con un único trámite y ya quedó en su concepto; el detalle dice cuál y por cuánto),
   **Pendiente** (leído, con el motivo por el que espera: …)» — el resto de la frase, igual.
2. **Pasos · 4** — añadir tras «…filtra por esa carga;»: «el selector **Estado de asociación** separa
   los pendientes de asociar de los rechazados como pago, y los aplicados automáticos de los manuales y
   de los adjuntados como documentación; los selectores **Concepto** y **Motivo** afinan lo que ve. En
   una fila con trámite, **Ver trámite** abre Gestión Trámites filtrada por esa placa en otra pestaña.»
3. **Pasos · 5** — añadir al final: «En la cabecera, **Ver soportes** muestra todos los documentos que
   ese trámite ya tiene (SOAT, impuesto, derecho, logística y comprobantes), si su usuario puede
   verlos.»

En **Estados · Lleno**: «…el estado (pendiente de asociar, rechazado como pago, aplicado automático o
manual, adjuntado, descartado) y su motivo…».

---

## Permiso / slug

Sin cambios de página: `pagina.flito_comprobantes` (0198). Funciones y páginas que deciden lo nuevo,
siempre con `hasFuncion` / `hasPage`, nunca por rol:

| Control | Se pinta si |
|---|---|
| Selector «Estado de asociación» | siempre (misma guarda que la cola: `comprobantes.cola.ver`) |
| «Ver trámite» (fila y detalle) | `tramite?.placa` **y** `hasPage(user, 'flito_tramites')` |
| «Ver soportes» (detalle) | `tramite` **y** `hasFuncion('tramites.tramite.ver_soportes')` |

Sin la guarda el control **no existe**, no se apaga. Para el e2e, `tramites.tramite.ver_soportes` y la
página `flito_tramites` entran en `FUNCIONES_POR_ROL` / `loginAs` del helper (memoria: un código nuevo
va al helper, no al spec).

---

## Notas para QA (≤ 10) — aserto y mutante

| # | Aserto | Mutante que debe matar |
|---|---|---|
| 1 | Entrar con `?asociacion=aplicado_manual` → pill **Aplicados** `aria-pressed=true`, `select[name≈Estado de asociación]` con valor `aplicado_manual`, **una** petición con `estado=aplicado&asociacion=aplicado_manual`; Motivo **no** existe | Pill fija en Pendientes con `asociacion` de aplicados (vacío falso) |
| 2 | Entrar con `?asociacion=foo` → selector en «Todos…», pill Pendientes, petición **sin** `asociacion`; la URL sigue diciendo `foo` hasta que se cambia un filtro | Enviar el valor desconocido al API (400) |
| 3 | En Pendientes elegir «Rechazado como pago» → URL `?asociacion=rechazado_pago`, petición con `estado=pendiente&asociacion=rechazado_pago`, `page=1`; pulsar **Aplicados** → selector vuelve a «Todos…» y la URL pierde `asociacion` | Conservar una asociación de otra pill |
| 4 | «Limpiar filtros» con asociación puesta → URL sin `asociacion`, selector «Todos…», pill Pendientes | Limpiar sin tocar la URL |
| 5 | Fila `{estado:'aplicado', esPago:false, aplicadoAutomaticamente:false}` → chip **Adjuntado** (`active`); `{aplicado, esPago:true, auto:true}` → **Aplicado automático** y segundo renglón **sin** la palabra «automático»; `{pendiente, motivo:'destino_no_admite'}` → **Rechazado como pago**. Test unitario: para cada `AsociacionComprobante` X, una fila construida para X devuelve `asociacionDe(fila) === X` (paridad con `condicionAsociacion`) | Orden de condiciones cambiado (adjuntado evaluado después de automático) |
| 6 | Vacío con selector puesto → `FlitEmpty` contiene «Cambia el estado de asociación» y hay **un solo** botón «Limpiar filtros» en la página | Duplicar el botón dentro del vacío |
| 7 | Resultado de carga con `aplicados:[…2]`, `pendientes:[…1]` → chips en orden **Aplicados 2 · Pendientes 1 · Duplicados 0 · Fallidos 0**; las dos primeras filas de la tabla dicen «Aplicado» y su celda Detalle es **exactamente** `item.detalle` del mock (p. ej. `SOAT · FLIT-10234 · $ 950.000`) | Recomponer el detalle en el front; chip Aplicados al final |
| 8 | Fila con `tramite:{placa:'ABC123'}` y sesión con página `flito_tramites` → `a[aria-label="Ver trámite FLIT-10234"]` con `href` que termina en `/flito/tramites?buscar=ABC123`, `target=_blank`, `rel=noopener`; con `placa:null` → **0** enlaces; sin la página → **0** enlaces | Enlace con `?buscar=` vacío; `?buscar=FLIT-…` |
| 9 | Detalle con `tramite` y sesión con `tramites.tramite.ver_soportes` → botón «Ver soportes»; pulsarlo → `GET /flito/tramites/{tramite.id}/soportes` y un segundo `[data-flit-modal]` con título «Documentos de FLIT-10234»; Esc cierra solo el de arriba. Sin la función → **0** botones (ni `disabled`) | Botón apagado; pedir soportes por `idFlit` |
| 10 | Mock de soportes con `origen:'comprobante'` → la tarjeta del visor dice **Comprobante**, no `comprobante` | Clave sin rótulo en `ORIGEN_SOPORTE` |

`QA_AXE_CDN=1` para los E2E de accesibilidad. Prohibido meter el uuid del trámite o del comprobante en
`aria-label`, `title`, `href` del SPA o `data-*` visibles (la ruta del API del visor no es el DOM).

---

## Decisiones y descartes

| # | Decisión | Descarte |
|---|---|---|
| D-1 | Selector **entre las pills y Concepto**; la pill **sigue** a la opción y la opción se **vacía** si la pill la deja fuera | Selector con opciones filtradas por pill (dos listas distintas según dónde estés; más reglas que valor); selector independiente que permite combinaciones vacías |
| D-2 | El chip de la fila **sustituye** el rótulo (6 en vez de 3) y el segundo renglón deja de decir «automático/manual» | Dos chips por fila (no caben en 210 px sin envolver); columna nueva «Asociación» (8.ª columna en una tabla que ya tiene 7) |
| D-3 | Una función `asociacionDe` para fila y detalle, espejo de `condicionAsociacion`, con test de paridad | Derivar en dos sitios; leer el chip del servidor (no viene y no hace falta pedirlo) |
| D-4 | `?asociacion=` **derivado** de la URL (calco de `?alerta=`), valor desconocido = ausente sin reescribir | Copiar a `useState` y sincronizar (desincroniza la barra y la tabla); reescribir la URL al entrar (pisa lo que la persona pegó) |
| D-5 | «Ver trámite» en la fila como **tercer renglón** de Trámite, en nueva pestaña, solo con placa y página | En la columna Acción (dos acciones por fila); mismo tab (pierde los filtros locales); `?buscar={idFlit}` (el pedido fija placa; cambiarlo es una línea si el PO lo prefiere) |
| D-6 | «Ver soportes» **solo en el detalle**, modal sobre modal | En la fila (segunda acción y columna a medias por la guarda); cerrar el detalle para abrir el visor |
| D-7 | `ORIGEN_SOPORTE.comprobante = 'Comprobante'` en el componente compartido | Mapear el rótulo solo en Comprobantes (las otras cuatro pantallas seguirían mostrando el literal) |
| D-8 | Chip «Aplicados» **primero**, siempre pintado; detalle del servidor tal cual | Recomponer «{Concepto} · {idFlit} · {pesos}» en el front (dos fuentes de verdad para el mismo texto) |
| D-9 | **Subtítulo de la página y párrafo del modal**: hoy dicen «Lo leído queda en Pendientes…», que con la aplicación automática ya no es verdad. Se recomienda el copy de la ficha (§5.1 y §6.1): subtítulo **«Sube cualquier comprobante o soporte de un trámite; FLITO lo lee y lo aplica solo cuando cruza con un único trámite. Lo que no, lo asocias desde aquí.»** y en el modal **«…FLITO aplica solo lo que cruza con un único trámite; el resto queda en Pendientes.»** Es corregir lo existente, no agregar; si el hilo lo considera fuera del AC, se deja y se anota deuda de copy | Dejar un subtítulo que contradice el chip «Aplicados» de al lado |
| D-10 | Sin efectos: sin transición al cambiar el chip, sin badge de conteo en el selector, sin resaltar filas «rechazadas» | Contadores por opción del selector (seis consultas para adornar) |

---

```
HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: /home/david/flit/flito-comprobantes-web/docs/ux/flito-comprobantes-cola-asociacion-12635-slim.md (delta de §5, §6 y §7.3/§7.8 de flito-comprobantes-carga-y-asociacion.md y del slim de #12634; manda donde difiere)
  Oficio: primaria única sin cambio (Cargar comprobantes · Subir y procesar/Listo · Aplicar/Adjuntar; lo nuevo son enlaces de texto) | jerarquía dicha (selector afina la pill; chip sustituye, no apila; Ver soportes al detalle) | vacío con siguiente paso (nombra los filtros + Limpiar filtros) | sin efectos ni patrón nuevo
  Densidad: sin cambio de columnas; tarjeta de filtros cabe en una línea a 1366 (≈1200/1258 px) y envuelve con el chip de carga; +16 px de alto solo en filas con trámite y placa
  Pantallas: 3 tocadas (cola · modal de carga · cabecera del detalle) + 1 renglón en VisorSoportes | Requerimientos nuevos de datos: ninguno (asociacion ya está en GET /; soportes ya existe con su guarda; FlitoTramites ya lee ?buscar=)
  Rótulos finales: «Estado de asociación» · «Todos los estados de asociación» · «Pendiente de asociar» · «Rechazado como pago» · «Aplicado automático» · «Aplicado manual» · «Adjuntado» · «Descartado» · «Aplicados {n}» · «Aplicado» · «Ver trámite ↗» / «Ver trámite {idFlit} ↗» · «Ver soportes» · «Comprobante» · vacío «Ningún comprobante coincide con los filtros.» / «Cambia el estado de asociación, el concepto o el motivo, o pulsa Limpiar filtros.»
  Siguiente: frontend-agent con D-1..D-10 y las 10 notas QA; el hilo pega AC1..AC5 y anota aquí si alguno contradice una D-n (en especial D-5 placa vs idFlit y D-9 copy del subtítulo)
```

## Ajustes en implementación (donde manda el AC)

- **D-5 → AC3:** el enlace «Ver trámite» va a `/flito/tramites?placa={placa}` (no `?buscar=`); `FlitoTramites` lee `placa` al montar como ya lee `alerta` y lo traduce al mismo buscador.
- **D-4 → AC2:** el chip «Aplicados {n}» solo se pinta con `aplicados.length > 0`; con `[]` no aparece.
- **D-9 aplicado:** subtítulo de la página y párrafo del modal ya no dicen «Lo leído queda en Pendientes…».
