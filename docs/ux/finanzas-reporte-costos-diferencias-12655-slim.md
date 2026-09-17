# UX slim — Reporte de costos: origen del valor, chips de diferencia, filtro «Con diferencias» y «Aceptar diferencia» (HU #12655 · Feature #12607 · Épica #12245)

> Modo **slim**. Es el **delta** sobre [`finanzas-reporte-costos-valor-documental.md`](./finanzas-reporte-costos-valor-documental.md)
> (D-27..D-37), validada contra los AC1..AC6 de la HU y contra el código real de la rama
> `HU/12655` (`TablaReporteCostos.tsx`, `FiltrosReporteCostos.tsx`, `tiposReporteCostos.ts`,
> `FinanzasReporteCostos.tsx`, `ValoresDocumentalesDeFila` en `shared-types/flito-comprobantes.ts`,
> `POST /flito/comprobantes/:id/diferencia/aceptar`, query `conDiferencias=si`).
> Lo que la ficha previa dice y aquí no se corrige, **sigue valiendo**. Lo que aquí se corrige, manda.
>
> Público: operador Financiero (interno). Tono de la pantalla: **tutea** (se calca). Ficha de Ayuda: **usted**.
> Regla dura: la compacta sigue en **9 columnas** y cabe en 1366; el Excel sigue en **32 cabeceras**.

---

## 0. Validación de la ficha previa contra los AC — qué cambia

| # | Ficha previa | AC / código real | Delta |
|---|---|---|---|
| V1 | D-28: origen `tarifa` **no pinta nada**; documental igual a tarifa pinta la palabra «Comprobante» sin chip | **AC1**: chips de origen **«Documento»** / **«Tarifa»** en TD y LG; SA sin chip de origen; «No configurado» sin chip | Se acata el AC: **chip** de origen en las dos lecturas, tono **neutral** (el más sutil del kit). «Comprobante» como palabra suelta **desaparece**. Ver P-01 |
| V2 | `Sin tarifa {+$}` | **AC2**: «Sin tarifa configurada» | Rótulo **«Sin tarifa configurada»**, sin importe en el chip (el importe de la diferencia es el valor entero que ya está encima) |
| V3 | Formato del importe en el chip `+$ 15.000` (con espacio) | **AC2**: `+$5.000` | En **chips**: `+$5.000` / `−$20.000` (signo pegado, sin espacio, menos tipográfico U+2212). En **modal, `title` y nombre accesible**: `pesos()` del reporte para los absolutos (`$ 95.000`) y el mismo `+$15.000` para la diferencia |
| V4 | «Difiere del catálogo» con globo «El cobro sigue siendo el del catálogo» | **AC2**: «Difiere del catálogo +$5.000» **con el importe del catálogo** | El `title`/nombre accesible lleva **Catálogo $ 125.000** además del comprobante. Se mantiene la frase del cobro |
| V5 | D-31: autogestionada con `title` «Autogestiona · comprobante adjunto» (necesitaba S4) | **AC3**: fila autogestionada **en blanco, sin chips**, aunque `valorDocumental.logistica` exista; el DTO ya trae `origenes.logistica = null` | **Se retira D-31.** La celda dice «Autogestiona» como hoy, sin `title` nuevo. S4 **cae** |
| V6 | Casilla con `title` largo; query `conDiferencias=1` | **AC4**: calco de «Solo con soportes completos», `aria-label`, ayuda «Solo trámites con al menos una diferencia sin aceptar»; el API lee **`conDiferencias=si`** (`paramsDeCriterios` ya vierte `true → 'si'`) | Copy del AC; viaja como booleano en `FiltrosDetalle` → `cuerpoDeExport` → `si`. **Sin `=1`** |
| V7 | `aria-label` «Aceptar diferencia de FLIT-10234: trámite digital +$ 15.000» | **AC5**: «Aceptar diferencia de <concepto> de <idFlit>» | Se acata: **«Aceptar diferencia de trámite digital de FLIT-10234»**; con dos pendientes, «…de trámite digital y logística de FLIT-10234». Los importes van al `title` |
| V8 | Errores con copy propio por código | **AC5**: 409/403/400 con `errorMessage` | La línea de error del modal pinta **`errorMessage(e)`** (el servidor ya habla en español: «El motivo va entre 5 y 500 caracteres», «La diferencia ya fue aceptada»). Lo que sí decide la pantalla es **qué pasa después** (§4) |
| V9 | Toast `role="status"` «Diferencia aceptada en FLIT-…» | La página ya tiene `aviso` (tarjeta azul) + `anuncio` (`role="status"`) | Se usa lo que existe: `setAviso(...)` — sin toast nuevo |
| V10 | S1–S3 (datos que faltaban) | El DTO `ValorDocumentalConcepto` trae `comprobanteId`, `numero`, `fecha`, `tarifaReferencia`, `diferencia`, `aceptada`, `aceptadaPorNombre/En/Motivo`; el filtro existe | **Resueltos.** Ningún requerimiento nuevo de datos |
| V11 | Acciones: «Soporte · Servicios · Liquidar» (dos secundarios) | Hoy hay **tres**: Soporte · Servicios · **Viajes** (HU #12628) | El cuarto secundario «Aceptar diferencia» va tras **Viajes** (`-viajes.md` ya lo deja en ese hueco) |

Lo demás de la ficha previa (D-27 marca bajo el valor solo en ampliada; D-29 el `Monto` no cambia;
D-30 SA pinta el catálogo; D-32 casilla, no etapa; D-33 un botón por fila; D-34 modal, no en línea;
D-35 varios conceptos = casillas + un motivo + un POST por comprobante; D-36 Excel sin columna;
D-37 aceptar no toca valor ni sello) **se mantiene**.

---

## 1. Superficie tocada

| | |
|---|---|
| Página / slug | `/finanzas/reporte-costos` · `finanzas_reporte_costos`, **sin cambios** |
| Celdas **Trámite digital** y **Logística** (grupo Valores, **solo ampliada**) | Bajo el importe, una línea de chips: **origen** (siempre que haya valor) y, si aplica, **diferencia** |
| Celda **Serv. adic.** (ampliada) | Sin chip de origen; solo el de **diferencia** («Difiere del catálogo» / «Diferencia aceptada») bajo los dos renglones que ya tiene |
| Tarjeta de filtros, banda superior | Casilla **«Con diferencias»** a la derecha de «Solo con soportes completos» |
| Celda **Acciones** (compacta y ampliada) | Botón secundario **«Aceptar diferencia»** solo en filas con ≥ 1 diferencia sin aceptar y con la función |
| Modal nuevo | `FlitModal` **«Aceptar diferencia · FLIT-10234 · ABC123»** |
| Vacío de la tabla | Un copy propio cuando la casilla «Con diferencias» está puesta |
| Ficha de ayuda | `finanzas_reporte_costos.md` (AC6): paso 4 y una viñeta en «Qué no hace» (texto en la ficha previa §«Ficha de ayuda», con dos retoques en §7) |
| Kit | `StatusChip` (`neutral` / `warning`), `Monto`, `FlitModal`, `flitInp`, `flitBtnSecondary`, `flitBtnPrimary`, `FlitEmpty`, patrón de `MarcaSoatConciliado` (`role="note"` + `aria-label` + globo `aria-hidden`). **Cero patrones nuevos** |

---

## 2. Delta de claridad de la celda (qué se ve / qué se calla)

**A qué se entra (sin cambio):** a cerrar el mes y Liquidar / Facturar. **Lo nuevo de esta visita:**
decidir si un valor que llegó por comprobante y no cuadra con la tarifa (o con el catálogo) **se acepta
tal cual**. Lo que se vino a ver está en **dos sitios y en este orden**: la fila avisa (botón en Acciones,
en los dos modos) y la celda del concepto explica (chips, solo en ampliada).

### 2.1 Cómo conviven importe + origen + diferencia en la celda (ampliada)

```
│ Trámite digital       │ Logística             │ Serv. adic.           │
│            $ 80.000   │            $ 30.000   │           $ 125.000   │
│            [Tarifa]   │            [Tarifa]   │           2 servicios │   ← origen tarifa: chip neutral; SA nunca lleva origen
│            $ 95.000   │            $ 25.000   │           $ 125.000   │
│         [Documento]   │ [Documento] [Difiere  │           2 servicios │
│                       │  de tarifa −$5.000]   │ [Difiere del catálogo │   ← diferencia pendiente: warning (la única llamada)
│                       │                       │  −$20.000]            │
│            $ 95.000   │                       │                       │
│ [Documento] [Diferencia                       │                       │   ← aceptada: neutral, quién/cuándo/motivo en el globo
│  aceptada +$15.000]   │                       │                       │
│            $ 95.000   │         Autogestiona  │                       │
│ [Documento] [Sin tarifa                       │                       │   ← sin tarifa: warning, sin importe (es el de arriba)
│  configurada]         │                       │                       │   ← autogestiona: EXACTAMENTE como hoy (AC3)
```

Reglas de la celda (frontend las implementa; no se dictan clases):

1. **Orden dentro de la celda:** importe (primer renglón, `Monto` sin cambio) → segundo renglón con
   los chips **alineado a la derecha** (`justify-end`, como `MarcaSoatConciliado`), primero **origen**
   y luego **diferencia**. Los chips pueden **envolver** a un tercer renglón si la columna es estrecha;
   nunca `whitespace-nowrap` en la celda entera.
2. **Máximo dos chips por celda** (origen + una lectura de diferencia). Las lecturas de diferencia son
   excluyentes: pendiente · aceptada · sin tarifa · ninguna.
3. **Cuándo se abrevia:** nunca en el rótulo. Lo que no cabe se **calla en el chip y vive en el
   `title` / nombre accesible**: importes del comprobante y de la tarifa (o catálogo), n.º y fecha
   del comprobante, quién/cuándo/motivo de la aceptación.
4. **Compacta:** TD, LG y Serv. adic. **no están** → ningún chip. La fila avisa con el botón
   «Aceptar diferencia» en Acciones. **No** se pinta ninguna marca en Servicio ni en Total (dato de un
   concepto en la celda de otro). Las 9 columnas **no ganan ancho**.
5. **Sin valor** (`Monto` pinta «No configurado», «Sin recibo», «Sin pagar», «Autogestiona», «No aplica»
   o «—»): **ningún chip** (AC1, AC3). El origen solo acompaña a un importe.
6. **Fila sellada** (Liquidado/Facturado): mismas reglas; origen del sello (`detalle.<concepto>.origenValor`);
   la aceptación se lee **en vivo** (una fila liquidada puede pasar de «Difiere» a «Diferencia aceptada»).

### 2.2 Jerarquía de tonos

| Lectura | Chip | Tono | Por qué |
|---|---|---|---|
| Origen tarifa | **Tarifa** | `neutral` | Es lo de siempre; no puede pesar más que el importe |
| Origen documento | **Documento** | `neutral` | Informa, no pide nada |
| Diferencia pendiente | **Difiere de tarifa +$5.000** / **Difiere del catálogo −$20.000** | `warning` | **La única llamada de atención de la celda**: hay algo que decidir |
| Sin tarifa con documento | **Sin tarifa configurada** | `warning` | También pendiente de aceptar (el API la marca) |
| Diferencia aceptada | **Diferencia aceptada +$15.000** | `neutral` | Ya se decidió; queda constancia, no alarma |

Ningún `danger`, ningún `success`, ningún color fuera de `StatusChip`. El signo va **escrito** en el
texto del chip: la lectura no depende del tono.

### 2.3 Copy exacto de la marca (chip visible · nombre accesible / globo)

Todos los chips de diferencia y el de aceptada son **marcas** (patrón `MarcaSoatConciliado`:
`role="note"`, `tabIndex=0`, `aria-label` completo, globo `aria-hidden` que se revela por foco y por
puntero y se cierra con Esc). Los chips de **origen** son texto plano (`StatusChip` sin rol ni foco):
no tienen nada que revelar.

| Chip | Nombre accesible (`aria-label`) | Globo (una línea) |
|---|---|---|
| Tarifa / Documento | — (texto del chip) | — |
| Difiere de tarifa +$15.000 | «Trámite digital: el comprobante dice $ 95.000 y la tarifa $ 80.000. Diferencia +$15.000. Sin aceptar.» | `Comprobante $ 95.000 · Tarifa $ 80.000 · N.º FS-1023` |
| Difiere del catálogo −$20.000 | «Servicios adicionales: el comprobante dice $ 105.000 y el catálogo suma $ 125.000. Diferencia −$20.000. Sin aceptar. El cobro sigue siendo el del catálogo.» | `Comprobante $ 105.000 · Catálogo $ 125.000 · N.º FS-1023 · El cobro sigue siendo el del catálogo` |
| Sin tarifa configurada | «Trámite digital: el comprobante dice $ 95.000 y no hay tarifa configurada. Diferencia +$95.000. Sin aceptar.» | `Comprobante $ 95.000 · Sin tarifa configurada · N.º FS-1023` |
| Diferencia aceptada +$15.000 | «Trámite digital: diferencia +$15.000 aceptada por ana.perez el 16 sep 2026: «Factura del proveedor con IVA».» | `Aceptada por ana.perez · 16 sep 2026 · «Factura del proveedor con IVA»` |

`numero` o `fecha` en null: se omite ese tramo (no «N.º null»). `aceptadaPorNombre` es el `username`
interno (sin PII). El concepto en el nombre accesible se toma de `CONCEPTO` («Trámite digital»,
«Logística») y «Servicios adicionales».

**Densidad:** en ampliada la fila con valor documental gana un renglón (dos si envuelve). La ampliada
ya desborda por decisión (D-11); en compacta **no cambia nada** salvo el botón. La única pregunta
abierta de densidad es P-01 (§8).

---

## 3. La acción «Aceptar diferencia»

**Dónde vive: en Acciones, no en el chip.** Razones: (a) en compacta la celda del concepto no existe
y la fila tiene que poder aceptarse igual; (b) el chip es **lectura** (`role="note"`) y para `auditor`
—que no tiene la función— se ve idéntico; un chip que a veces es botón y a veces no es un patrón nuevo;
(c) Acciones ya es la columna «consultar → decidir → operar» y cada fila tiene una sola acción de
decisión aunque tenga dos diferencias (D-33).

```
│ [Soporte] [Servicios · 2] [Viajes] [Liquidar]                  │  ← sin diferencia: como hoy
│ [Soporte] [Servicios] [Viajes] [Aceptar diferencia]            │  ← con diferencia sin aceptar: envuelve
│ [Liquidar]  Falta: SOAT                                        │
```

- **Sitio:** tras «Viajes», antes de la primaria. Orden de foco
  `Soporte → Servicios → Viajes → Aceptar diferencia → Liquidar/Facturar → Reversar → Enviar → ¿Por qué no?`.
- **Peso:** `flitBtnSecondary`, gemelo de Soporte/Servicios/Viajes. **Liquidar sigue siendo la
  primaria** de la fila y del lote; no cambia de peso ni de condición.
- **Rótulo fijo** «Aceptar diferencia» (también con dos pendientes).
- **`aria-label`** (AC5): «Aceptar diferencia de trámite digital de FLIT-10234» ·
  «Aceptar diferencia de logística de FLIT-10234» · «Aceptar diferencia de servicios adicionales de FLIT-10234» ·
  con dos o tres: «Aceptar diferencia de trámite digital y logística de FLIT-10234».
- **`title`:** «Trámite digital +$15.000» · «Trámite digital +$15.000 · Logística −$5.000».
- **Existe si** `hasFuncion('comprobantes.diferencia.aceptar')` **y** alguna `valorDocumental.*` tiene
  `diferencia !== null && !aceptada`. **Sin la función no se pinta** (ni apagado): el chip queda
  informativo (AC5). Sin diferencia pendiente tampoco (aceptada ⇒ el botón desaparece al refrescar).
- Se pinta **también en filas selladas** (D-37): aceptar es constancia, no dinero.
- `disabled` mientras `enProceso` de la página (como Liquidar), para no cruzar dos escrituras.

---

## 4. Modal «Aceptar diferencia»

`FlitModal` con `restoreFocusRef={tituloRef}` (el mismo respaldo de los paneles). Análogo del mismo
público: `DialogoDescartar` (motivo obligatorio, primaria apagada explicada por `role="status"`).

```
┌ Aceptar diferencia · FLIT-10234 · ABC123                                        ✕ ┐
│  El valor del comprobante se queda como está en el reporte y en la liquidación.   │
│  Aceptar solo deja constancia de que la diferencia es correcta.                   │
│                                                                                   │
│  Trámite digital                                                                  │
│  Comprobante $ 95.000 · Tarifa $ 80.000                                +$15.000   │
│  N.º FS-1023 · 12 sep 2026                                                        │
│                                                                                   │
│  Por qué se acepta (obligatorio)                                                  │
│  [                                                                              ] │
│  Entre 5 y 500 caracteres. Queda en la auditoría del comprobante.                 │
│  No escribas cédulas, teléfonos ni correos.                              0/500    │
│                                                                                   │
│  Escribe el motivo para poder aceptar.        [ Cancelar ]  [ Aceptar diferencia ]│
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Con dos o tres diferencias pendientes** (D-35): cada concepto es una línea con **casilla marcada**;
desmarcar todas apaga la primaria; **un** motivo; un `POST /flito/comprobantes/{comprobanteId}/diferencia/aceptar`
por línea marcada, **en secuencia**. Con una sola: sin casilla (el wireframe).

Líneas por concepto (copy exacto):

| Concepto | Línea 1 | Diferencia | Línea 2 |
|---|---|---|---|
| Trámite digital / Logística | «Comprobante $ 95.000 · Tarifa $ 80.000» | «+$15.000» | «N.º FS-1023 · 12 sep 2026» |
| Sin tarifa | «Comprobante $ 95.000 · Sin tarifa configurada» | «+$95.000» | ídem |
| Servicios adicionales | «Comprobante $ 105.000 · Catálogo $ 125.000» | «−$20.000» | «N.º FS-1023 · 12 sep 2026 · El cobro sigue siendo el del catálogo.» |

Campos y validación:

- `textarea` **«Por qué se acepta (obligatorio)»**, `rows=2`, `maxLength=500`, `aria-describedby` a la
  ayuda. Foco al abrir: **el textarea**.
- Primaria **«Aceptar diferencia»** (`flitBtnPrimary`), **deshabilitada** mientras `motivo.trim().length < 5`
  o no haya línea marcada o esté enviando. Junto a ella, `role="status"`:
  «Escribe el motivo para poder aceptar.» → «Motivo listo: ya se puede aceptar.»
  (con casillas y ninguna marcada: «Marca al menos una diferencia para poder aceptar.»).
- Secundaria **«Cancelar»** (`flitBtnSecondary`) y la ✕ del kit. Esc cierra. Al cancelar el foco vuelve
  al botón de la fila (sigue existiendo).
- **Una sola primaria** en la vista; Liquidar queda fuera del modal.

Estados del modal:

| Estado | Qué se ve |
|---|---|
| Cargando | No aplica: los datos vienen en la fila. |
| Enviando | Primaria «Aceptando…» + `aria-busy`, todo deshabilitado; lo escrito se conserva. |
| **Éxito** (todos los POST en 200) | Cierra; `setAviso('Diferencia de trámite digital de FLIT-10234 aceptada.')` (con dos: «Diferencias de trámite digital y logística de FLIT-10234 aceptadas.»); `refrescar()` — **no** `ejecutar()`: la selección de liquidación no se vacía. Foco: el botón de la fila ya no existe → `restoreFocusRef` al `h1`. |
| **400** (motivo fuera de 5–500) | `<p role="alert">` con `errorMessage(e)`; foco al textarea; la primaria sigue viva. (No debería pasar: la pantalla ya lo impide.) |
| **409** `sin_diferencia` (ya aceptada / comprobante cambió) | `role="alert"` con `errorMessage(e)` + «La fila se actualizó.»; esa línea pierde su casilla y se pinta «Aceptada»; `refrescar()` de fondo. Si no queda ninguna pendiente, la primaria se apaga y el estado dice «No queda nada por aceptar. Cierra el diálogo.» |
| **403** | `role="alert"` con `errorMessage(e)` + «Vuelve a entrar para actualizar tus permisos.»; primaria apagada; solo Cancelar. |
| **404** | Como 409: «Ese comprobante ya no existe.» viene del servidor; `refrescar()`. |
| **500 / red** | `role="alert"` con `errorMessage(e)`; la primaria vuelve a «Aceptar diferencia»; lo escrito se conserva (Reintentar = volver a pulsar). |
| Parcial (2.ª línea falla) | El modal **no cierra**; la aceptada pasa a texto «Aceptada» sin casilla; bajo la fallida, su error. |

Vacío del modal: **no existe** (el botón no se pinta sin diferencia pendiente).

---

## 5. Filtro «Con diferencias»

```
(● Todos 312) (Listos para liquidar 41) (Incompletos 18) (Por facturar 9) (Facturados 244)
☐ Solo con soportes completos   ☐ Con diferencias                             [Limpiar filtros]
```

- Calco exacto de «Solo con soportes completos»: `<label>` con `<input type="checkbox">`, `text-xs`,
  color secundario. Rótulo visible **«Con diferencias»**; `aria-label` **«Con diferencias»**;
  `title` (ayuda) **«Solo trámites con al menos una diferencia sin aceptar.»**
- Estado: `FiltrosDetalle.conDiferencias: boolean`, `false` en `filtrosIniciales()`, dentro de
  `claveDe()` (así cambia de página y vacía la selección como los demás), en `cuerpoDeExport` →
  `paramsDeCriterios` lo vierte como **`conDiferencias=si`**. Sin contador (no es una etapa).
- **Limpiar filtros:** vuelve a `filtrosIniciales()` → la casilla se desmarca; `hayFiltros` la cuenta
  porque `claveDe` la incluye. El botón «Limpiar filtros» se enciende con solo marcarla.
- Semántica: **sin aceptar**. Las aceptadas dejan de salir; quien las busca las ve por el chip en
  ampliada o en `/flito/comprobantes`.
- Se compone con las etapas, el estado, el periodo y «Solo con soportes completos» (AND).
- Alcanza al export del detalle y a los contadores de facturación electrónica, porque todos leen
  `params()`: el Excel **de este filtro** trae solo las filas con diferencias, con las 32 cabeceras
  de siempre.

---

## 6. Estados (4) de la tabla con el filtro

| Estado | Qué se ve | Cambio |
|---|---|---|
| **Cargando** | Como hoy (la tabla anterior sigue hasta que llega la nueva; sin esqueleto, deuda ya declarada en `-tabla-compacta.md`) | Ninguno |
| **Error** | Tarjeta roja con `errorMessage` como hoy | Ninguno (sin Reintentar propio: deuda existente, fuera de esta HU) |
| **Vacío con «Con diferencias» marcada** | `FlitEmpty`: **«No hay trámites con diferencias sin aceptar en este filtro. Desmarca «Con diferencias» o amplía el periodo.»** El botón «Limpiar filtros» de la tarjeta ya está encendido | **Nuevo copy** (solo con la casilla; el genérico «No hay trámites que coincidan con los filtros.» sigue para el resto) |
| **Lleno** | Compacta: 9 columnas + «Aceptar diferencia» en Acciones donde toca. Ampliada: además los chips bajo TD/LG/SA | **Nuevo** |

---

## 7. Copy exacto (todos los rótulos)

| Sitio | Texto |
|---|---|
| Chip origen | `Tarifa` · `Documento` |
| Chip diferencia | `Difiere de tarifa +$5.000` · `Difiere del catálogo −$20.000` · `Sin tarifa configurada` · `Diferencia aceptada +$15.000` |
| Botón de fila | `Aceptar diferencia` |
| `aria-label` botón | `Aceptar diferencia de trámite digital de FLIT-10234` (conceptos en minúscula, unidos con « y ») |
| Casilla | `Con diferencias` · ayuda `Solo trámites con al menos una diferencia sin aceptar.` |
| Vacío filtrado | `No hay trámites con diferencias sin aceptar en este filtro. Desmarca «Con diferencias» o amplía el periodo.` |
| Modal · título | `Aceptar diferencia · FLIT-10234 · ABC123` (sin placa: `Aceptar diferencia · FLIT-10234`) |
| Modal · intro | `El valor del comprobante se queda como está en el reporte y en la liquidación. Aceptar solo deja constancia de que la diferencia es correcta.` |
| Modal · rótulo campo | `Por qué se acepta (obligatorio)` |
| Modal · ayuda campo | `Entre 5 y 500 caracteres. Queda en la auditoría del comprobante. No escribas cédulas, teléfonos ni correos.` + `n/500` |
| Modal · estado | `Escribe el motivo para poder aceptar.` · `Motivo listo: ya se puede aceptar.` · `Marca al menos una diferencia para poder aceptar.` · `No queda nada por aceptar. Cierra el diálogo.` |
| Modal · botones | `Cancelar` · `Aceptar diferencia` · (enviando) `Aceptando…` |
| Modal · sufijos de error | 409/404: ` La fila se actualizó.` · 403: ` Vuelve a entrar para actualizar tus permisos.` (siempre tras `errorMessage(e)`) |
| Aviso de éxito | `Diferencia de trámite digital de FLIT-10234 aceptada.` · `Diferencias de trámite digital y logística de FLIT-10234 aceptadas.` |
| Ayuda (`finanzas_reporte_costos.md`, usted) | El texto de la ficha previa con dos retoques: «lee **Documento** o **Tarifa** bajo el valor» en vez de «lee Comprobante»; y quitar la frase «aunque tenga un comprobante adjunto» → «Un concepto que la compañía autogestiona sigue en blanco.» |

---

## 8. Qué NO cambia · preguntas

**No cambia:** las 9 columnas de la compacta y su ancho en 1366; el Excel (32 cabeceras literales,
sin «Origen»; solo obedece el filtro como todos); `Monto` (una cifra por celda; TD/LG ya traen el
documental por `COALESCE`; SA sigue siendo Σ catálogo); Liquidar / Facturar / Reversar / Enviar y sus
condiciones; el consolidado; las etapas y sus contadores; `MarcaSoatConciliado` en SOAT.

| # | Pregunta al PO | Recomendación mientras tanto |
|---|---|---|
| P-01 | AC1 pide chip **«Tarifa»** en toda fila con tarifa: en ampliada es un chip neutral en casi todas las filas (ruido en el caso feliz; la ficha previa lo descartaba en D-28). ¿Se mantiene? | Se implementa como dice el AC (solo ampliada, tono `neutral`). Si el PO lo retira, «Documento» solo y nada en tarifa: un `if` |
| P-02 | Con el valor documental y **sin tarifa configurada**, ¿el concepto sigue en `noConfigurados` (y bloquea Liquidar con «Falta: Trámite digital») o el documento lo resuelve? | Se pinta lo que diga el API: si viene en `noConfigurados`, `Monto` pinta «No configurado» y **no hay chip** (regla 2.1-5); si viene valor, chip «Sin tarifa configurada». Confirmar con backend, no inventar |

---

## 9. Permiso / slug

`finanzas_reporte_costos`, sin cambio. Botón y modal: **`comprobantes.diferencia.aceptar`**
(`admin` y `financiera` de partida; `exigirFuncion` en el API). Chips y casilla: para todo el que ve
la página (`auditor` incluido). Sin PII nueva: `username` interno en el globo, ningún uuid en pantalla
ni en la URL (el filtro es un booleano).

---

## 10. Notas para QA (≤10)

1. **Ancho (gate):** 1366×768, compacta, 10 filas con Soporte + Servicios · 2 + Viajes + **Aceptar diferencia** + Liquidar + «Falta: SOAT»: `FlitTable` con `scrollWidth === clientWidth` y sin `tabindex`. *Mutante:* `whitespace-nowrap` en Acciones.
2. Compacta: ningún nodo con «Difiere», «Documento», «Tarifa» ni «Diferencia aceptada»; el botón «Aceptar diferencia» **sí** existe en la fila con `valorDocumental.tramiteDigital.diferencia=15000, aceptada=false`. *Mutante:* chip pintado bajo Servicio/Total.
3. Ampliada, `origenes.tramiteDigital='documental'`, `diferencia=15000`, `aceptada=false`: chips «Documento» y «Difiere de tarifa +$15.000» (en ese orden); el segundo con `role="note"` y `aria-label` que contiene «$ 95.000», «$ 80.000», «+$15.000», «Sin aceptar»; Tab lo enfoca y revela el globo; Esc lo cierra sin mover el foco. *Mutante:* `tabIndex` quitado.
4. `origenes.logistica='tarifa'` → solo chip «Tarifa». `origenes.logistica=null` con `valorDocumental.logistica` no nulo (autogestionada) → celda «Autogestiona» **sin chips ni `title` nuevo** (AC3). `diferencia=0` documental → «Documento» y nada más. *Mutante:* chip «+$0».
5. `aceptada=true`: «Diferencia aceptada +$15.000» tono `neutral` con `aria-label` que incluye `aceptadaPorNombre`, fecha y motivo; **sin** botón. *Mutante:* botón visible tras aceptar.
6. SA con `diferencia=-20000`: `Monto` sigue en Σ catálogo ($ 125.000); chip «Difiere del catálogo −$20.000»; nombre accesible con «$ 125.000» y «El cobro sigue siendo el del catálogo»; **sin** chip de origen en SA. *Mutante:* pintar el documental en la celda.
7. `tarifaReferencia=null` con valor: chip «Sin tarifa configurada» (`warning`, sin importe) y botón; el modal dice «Comprobante $ 95.000 · Sin tarifa configurada · +$95.000». *Mutante:* rótulo «Sin tarifa +$95.000».
8. Casilla «Con diferencias»: la petición lleva **`conDiferencias=si`** (no `1`, no `true`); «Limpiar filtros» se enciende al marcarla y la desmarca; con 0 filas se lee el copy de §6. El export del detalle con la casilla lleva `conDiferencias: true` en el cuerpo. *Mutante:* casilla fuera de `claveDe`.
9. Modal: foco inicial en el textarea; con 3 caracteres la primaria está `disabled` y el `role="status"` dice «Escribe el motivo…» → **cero POST**; con motivo válido y dos líneas marcadas → **dos** `POST /flito/comprobantes/{comprobanteId}/diferencia/aceptar` en secuencia con el **mismo** `motivo`; luego `refrescar()` y la selección de liquidación **sigue**; aviso «Diferencias de … aceptadas.»; foco en el `h1`. Segunda respuesta 409 → el modal sigue abierto con `errorMessage` bajo esa línea. *Mutante:* `ejecutar()` en vez de `refrescar()`.
10. `auditor` (sin `comprobantes.diferencia.aceptar`): chips visibles en ampliada, casilla usable, **cero** botones «Aceptar diferencia» (`toHaveCount(0)`, apagados incluidos). Excel: 32 cabeceras, sin «Origen». *Mutante:* guardar por rol.

---

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer? | Cerrar el mes; y ahora, decidir si un valor documental que no cuadra se acepta. |
| ¿Qué se ve primero? ¿Qué se calla? | En la fila: el botón «Aceptar diferencia» (ambos modos). En la celda (ampliada): importe → chips. Se callan en el `title`/globo/modal: importes de referencia, n.º de comprobante, quién/cuándo/motivo. |
| ¿Única primaria? | Página: Liquidar (sin cambio). Modal: «Aceptar diferencia». |
| ¿Vacío y error con siguiente paso? | Vacío filtrado: desmarcar la casilla / ampliar el periodo / Limpiar filtros. Errores del modal: por código, con la acción posible. |
| ¿Efectos o patrón nuevo? | Ninguno: `StatusChip`, patrón `MarcaSoatConciliado`, `FlitModal`, `FlitEmpty`. |

```
HANDOFF
  Modo: slim
  Resultado: OK (P-01 y P-02 no bloquean: hay decisión por defecto)
  Entrega: /home/david/flit/flito-comprobantes-web/docs/ux/finanzas-reporte-costos-diferencias-12655-slim.md
  Oficio: primaria única (Liquidar; modal «Aceptar diferencia») | jerarquía dicha (botón en la fila; chips solo en ampliada; detalle en title/globo/modal) | vacío con siguiente paso | sin efectos ni patrón nuevo
  Densidad: sin cambio en compacta (botón envuelve en Acciones, QA 1); ampliada gana un renglón en filas con valor documental; P-01 al PO por el chip «Tarifa»
  Pantallas: 1 vista tocada + 1 modal | Requerimientos nuevos de datos: ninguno (S1–S3 resueltos en el DTO; S4 cae por AC3)
  Siguiente: frontend-agent con §2–§7 → qa-agent con las 10 notas; P-01/P-02 al PO en el PR
```
