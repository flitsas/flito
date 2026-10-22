# UX slim — Reporte de costos: valor documental (origen, «Difiere de tarifa», filtro «Con diferencias», «Aceptar diferencia») (Épica #12245 · Feature #12607 «F3 valor documental en el reporte»)

> Modo **slim**: la pantalla existe (`/finanzas/reporte-costos`, `FinanzasReporteCostos.tsx`,
> `components/finanzas/TablaReporteCostos.tsx`, `FiltrosReporteCostos.tsx`, `Monto.tsx`,
> `MarcaSoatConciliado.tsx`) y **no gana columnas**: la compacta sigue en **9 de 29**
> (`-tabla-recorte.md`, D-14; memoria «pantalla compacta»). Lo que no se nombra aquí no cambia.
> Tono de la pantalla: **tutea** (se calca). Ficha de Ayuda: **usted**.
>
> Carga y asociación de comprobantes: [`flito-comprobantes-carga-y-asociacion.md`](./flito-comprobantes-carga-y-asociacion.md).
> Contrato: `docs/diseno-epica-12245-comprobantes-universales.md` §«Reporte, liquidación y Excel» y
> ADR-0018 §5. §7 lista lo que **no casa**.
>
> **Fuera de alcance:** columna nueva en el Excel (sin VoBo del PO, C9: **no se dibuja**);
> «Ajuste por comprobante» en Siigo (decisión humana pendiente, C6); tocar el consolidado;
> cambiar la compacta; reversar o descartar comprobantes desde el reporte.

---

## Superficie tocada

| | |
|---|---|
| Página / slug | `/finanzas/reporte-costos` · `finanzas_reporte_costos`, **sin cambios** |
| Celdas **Trámite digital** y **Logística** (grupo Valores, **solo vista ampliada**) | Ganan una **marca bajo el importe** (patrón exacto de `MarcaSoatConciliado`: debajo del valor, `justify-end`, nada cuando no aplica). Tres lecturas: origen documento sin diferencia · **Difiere de tarifa** · **Diferencia aceptada** |
| Celda **Serv. adic.** (ampliada) | Misma marca con rótulo **«Difiere del catálogo»**; el importe pintado **sigue siendo el del catálogo** (C6: en SA el documental **no manda**) |
| Celda **Logística** con **Autogestiona** | Sigue diciendo **Autogestiona**; si hay documentación adjunta, `title` **«Autogestiona · comprobante adjunto»**. **Ningún estado nuevo** |
| Tarjeta de filtros, banda superior | Una casilla más, gemela de «Solo con soportes completos»: **«Con diferencias»** |
| Celda **Acciones** (compacta y ampliada) | Un botón secundario más, **solo** en filas con alguna diferencia **sin aceptar**: **«Aceptar diferencia»** |
| Modal nuevo | `FlitModal` (ancho por defecto) **«Aceptar diferencia · FLIT-10234 · ABC123»** |
| Excel | **Sin cambio** |
| Ficha de ayuda | `finanzas_reporte_costos.md`: paso 4 y una viñeta en «Qué no hace» |
| Kit | `StatusChip`, `Monto`, `FlitModal`, `flitInp`, `flitBtnSecondary`, tokens. **Cero patrones nuevos**: la marca es `MarcaSoatConciliado` generalizada (misma pinta, mismo `role="note"` + `aria-label` + globo `aria-hidden`) |

---

## Delta de claridad (qué se ve / qué se calla)

**A qué se entra (sin cambio):** a cerrar el mes: ver qué vale cada trámite, en qué estado de
liquidación está, y **Liquidar / Facturar / Enviar a facturación**. Lo nuevo que hay que decidir
en esa visita: **si el valor que llegó por comprobante y no cuadra con la tarifa se acepta tal
cual** (D2: manda el documento, tolerancia 0, no bloquea sellar).

| Siempre visible (esta visita) | Se calla, y dónde vive |
|---|---|
| En la fila, en **ambos** modos: que hay una diferencia sin aceptar → el botón **«Aceptar diferencia»** en Acciones (existe solo si la hay) | El importe de la diferencia en compacta: en el **`title`/nombre accesible del botón** y en el **modal** (que es donde se acepta) |
| En ampliada: bajo el valor de TD/LG/SA, la marca con el **importe con signo** | Quién aceptó, cuándo y por qué: en el **globo** de la marca «Diferencia aceptada» |
| El filtro **«Con diferencias»** para encontrarlas | Origen «tarifa»: **nada** (es lo de siempre); origen «documento» sin diferencia: una palabra tenue bajo el valor, solo en ampliada |
| El valor de TD/LG **ya es el documental** cuando lo hay (lo hace el servidor con `COALESCE`) | El n.º de comprobante: en el globo; el comprobante entero: en `/flito/comprobantes` («Ver») |

**Por qué el importe no va en compacta.** La compacta son las nueve que caben en 1366 (D-14) y
TD/LG **no están** en ella; el precedente de `MarcaSoatConciliado` ya es «marca de concepto → solo
en ampliada» (QA 8 de `-tabla-compacta.md`). Meter el ±$ en «Servicio» o «Total» sería pintar un
dato de un concepto en la celda de otro. En compacta la fila **sí** avisa (el botón) y el modal
enseña documento, tarifa y diferencia antes de aceptar: nadie acepta a ciegas.

**Primaria:** **Liquidar** (fila / lote), sin cambio. «Aceptar diferencia» es `flitBtnSecondary`
como «Soporte» y «Servicios». Dentro del modal, la única primaria es **«Aceptar diferencia»**.

**Densidad:** en Acciones **empeora un punto en las filas con diferencia** (hoy caben dos botones
por línea y envuelven con `flex-wrap`; el tercero baja de línea, como ya pasa con «Servicios ·
n»). Es el precio del AC y se contiene porque el botón **no existe** en el resto de filas. En
1366 la compacta **no** gana ancho: Acciones ya tiene 148 px y envuelve; QA 1 lo mide. Las tres
marcas solo viven en ampliada, que desborda por decisión (D-11).

---

## Wireframes (lo único que se dibuja)

### Celda TD / LG en ampliada — las tres lecturas

```
│ Trámite digital │ Logística     │
│      $ 80.000   │    $ 30.000   │   ← origen tarifa: como hoy, nada debajo
│      $ 95.000   │    $ 30.000   │
│      Comprobante│               │   ← origen documento = tarifa: text-xs secundario, sin chip
│      $ 95.000   │    $ 25.000   │
│ [Difiere de     │ [Difiere de   │   ← chip warning bajo el valor; el importe lleva signo
│  tarifa +$15.000]│ tarifa −$5.000]│
│      $ 95.000   │               │
│ [Dif. aceptada  │               │   ← chip neutral; globo con quién/cuándo/por qué
│  +$15.000]      │               │
```

| Lectura | Condición (campos de la fila) | Qué se pinta bajo el `Monto` | Nombre accesible (`role="note"`, `aria-label`) y globo |
|---|---|---|---|
| Tarifa | `origenTd = 'tarifa'` o null | **Nada** | — |
| Documento, igual | `origenTd = 'documental'` y `diferenciaTd = 0` | Texto **Comprobante** (`text-xs`, `--flit-text-secondary`, sin chip) | `title` **«Valor del comprobante N.º {numeroDocumento}»** (texto, no control) |
| **Difiere de tarifa** | `origenTd = 'documental'`, `diferenciaTd ≠ 0` (o tarifa null), `diferenciaAceptadaTd = false` | `StatusChip warning` **Difiere de tarifa {±$}** | **«Trámite digital: el comprobante dice {pesos(valor)} y la tarifa {pesos(tarifa)}. Diferencia {±pesos}. Sin aceptar.»** Globo: `Comprobante $ 95.000 · Tarifa $ 80.000 · N.º FS-1023` |
| Tarifa **no configurada** y hay documento | `tarifaReferencia = null` | `StatusChip warning` **Sin tarifa {+$}** (la diferencia es el valor entero) | **«… no hay tarifa configurada. Diferencia {+pesos}. Sin aceptar.»** Globo: `Comprobante $ 95.000 · Sin tarifa configurada` |
| **Diferencia aceptada** | `diferenciaAceptadaTd = true` | `StatusChip neutral` **Diferencia aceptada {±$}** | **«… Diferencia {±pesos}, aceptada por {nombre} el {fecha}: «{motivo}».»** Globo: `Aceptada por Ana Pérez · 16 sep 2026 · «Factura del proveedor con IVA»` |

- Formato del importe: `pesos()` del reporte con signo explícito: **`+$ 15.000`** / **`−$ 5.000`**
  (menos tipográfico U+2212, como las cifras negativas del consolidado). En el chip **no** hay
  espacio entre signo y `$`.
- **El `Monto` no cambia**: sigue pintando `f.tramiteDigital` (que ya trae el documental por
  `COALESCE`). Nunca dos cifras en la celda (una verdad; §12-D7 de servicios adicionales).
- **Fila sellada** (Liquidado/Facturado): las marcas se pintan igual leyendo las mismas columnas;
  «Aceptar diferencia» **sigue disponible** (aceptar no toca el valor ni el sello).

### Celda Serv. adic. en ampliada

```
│ Serv. adic.   │
│   $ 125.000   │   ← el importe es Σ catálogo (no cambia)
│   2 servicios │
│ [Difiere del  │   ← chip warning; el documento dijo $ 105.000
│  catálogo −$20.000]│
```

Mismas cuatro lecturas con **«Difiere del catálogo»** / **«Diferencia aceptada»** y nombre
accesible **«Servicios adicionales: el comprobante dice {pesos(valor)} y el catálogo suma
{pesos(Σ)}. Diferencia {±pesos}. Sin aceptar.»** Sin lectura «Comprobante» cuando cuadran (no
cambia nada: el catálogo manda). El globo añade **«El cobro sigue siendo el del catálogo.»**

### Logística autogestionada

```
│ Logística     │
│ Autogestiona  │   ← igual que hoy; title «Autogestiona · comprobante adjunto» si lo hay
```

Ni chip ni importe: un comprobante de pago **no puede aplicarse** a logística autogestionada
(`destino_no_admite`); solo puede haber **documentación** adjunta, y eso no es un valor.

### Tarjeta de filtros (banda superior)

```
(● Todos 312) (Listos para liquidar 41) (Incompletos 18) (Por facturar 9) (Facturados 244)
☐ Solo con soportes completos   ☐ Con diferencias                        [Limpiar filtros]
```

- Casilla **«Con diferencias»**, `title` **«Trámites con un comprobante cuyo valor no cuadra con
  la tarifa o el catálogo y que nadie ha aceptado todavía.»** Viaja como `conDiferencias=1`.
  Cuenta como filtro para «Limpiar filtros». **Sin contador** (no es una etapa).
- Semántica: **sin aceptar**. Las aceptadas dejan de salir (ya no hay nada que decidir). Quien
  quiera ver las aceptadas las encuentra por la marca en ampliada o en `/flito/comprobantes`.

### Celda Acciones (compacta y ampliada)

```
│ [Soporte] [Servicios · 2] [Liquidar]            │   ← sin diferencia: como hoy
│ [Soporte] [Servicios] [Liquidar]                │
│ [Aceptar diferencia]  Falta: SOAT               │   ← con diferencia sin aceptar: tercer botón, envuelve
```

- Sitio: después de «Servicios», antes de la primaria: **consultar → decidir → operar**. Orden de
  foco `Soporte → Servicios → Aceptar diferencia → Liquidar/Facturar → Reversar → Enviar → ¿Por qué no?`.
- Rótulo fijo **«Aceptar diferencia»** (también si hay dos: el modal las lista). `aria-label`
  empieza por el texto visible: **«Aceptar diferencia de FLIT-10234: trámite digital +$ 15.000»** /
  **«…: trámite digital +$ 15.000 y logística −$ 5.000»**. `title` con el mismo texto sin el prefijo.
- Se pinta si `hasFuncion('comprobantes.diferencia.aceptar')` **y** la fila tiene ≥ 1 diferencia
  sin aceptar. `auditor` no tiene la función: para él la fila solo lleva las marcas (ampliada).

### Modal «Aceptar diferencia»

```
┌ Aceptar diferencia · FLIT-10234 · ABC123                                 ✕ ┐
│  El valor del comprobante se mantiene en el reporte y en la liquidación.    │
│  Aceptar solo deja constancia de que la diferencia es correcta.             │
│                                                                             │
│  ☑ Trámite digital     Comprobante $ 95.000 · Tarifa $ 80.000   +$ 15.000   │
│                        Comprobante N.º FS-1023 · 12 sep 2026                │
│  ☑ Logística           Comprobante $ 25.000 · Tarifa $ 30.000   −$ 5.000    │
│                        Comprobante N.º TR-7781 · 12 sep 2026                │
│                                                                             │
│  Por qué se acepta *                                                        │
│  [                                                                        ] │
│  Mínimo 5 caracteres. Queda en la auditoría del comprobante.        0/500   │
│                                                                             │
│                                       [ Cancelar ]  [ Aceptar diferencia ]  │
└─────────────────────────────────────────────────────────────────────────────┘
```

- Con **una** diferencia: la lista es una línea **sin casilla**. Con dos o tres (TD, LG, SA):
  casillas todas marcadas; desmarcar todas apaga la primaria (aquí sí: no hay nada que explicar,
  la casilla lo dice). El motivo es **uno** y se envía a cada `POST /flito/comprobantes/{id}/diferencia/aceptar`
  marcado, **en secuencia**.
- SA se lista como **«Servicios adicionales · Comprobante $ 105.000 · Catálogo $ 125.000 · −$ 20.000»**.
- Sin tarifa: **«Comprobante $ 95.000 · Sin tarifa configurada · +$ 95.000»**.
- Foco al abrir: al `textarea` (lo único que hay que escribir; la lista se lee antes por orden de
  DOM con Shift+Tab, y el `dialog` lleva el título como nombre). Al cerrar: al botón de la fila
  (sigue existiendo si se canceló) o, si se aceptó y el filtro «Con diferencias» sacó la fila,
  `restoreFocusRef` al `h1` de la página.
- Validación al pulsar: motivo < 5 → `aria-invalid` + `<p role="alert">` **«Escribe por qué se
  acepta (mínimo 5 caracteres).»**, foco al textarea, **cero POST**.

| Respuesta | Copy (`role="alert"` en el modal salvo éxito) | Qué más |
|---|---|---|
| **200** (todas) | Toast `role="status"` **«Diferencia aceptada en FLIT-10234.»** | Cierra; `refrescar()` de la página (no `ejecutar()`: no vacía la selección) |
| **200 parcial** (2.ª falla) | El modal **no cierra**: la aceptada pasa a texto **«Aceptada»** sin casilla; bajo la otra, el error de su código | La primaria vuelve a decir «Aceptar diferencia» para lo que queda |
| **409 `sin_diferencia`** | **«Esa diferencia ya estaba aceptada o el comprobante cambió. La fila se actualizó.»** | `refrescar()`; el modal cierra si no queda ninguna |
| **404** | **«Ese comprobante ya no existe. La fila se actualizó.»** | ídem |
| **403** | **«Tu usuario no puede aceptar diferencias. Vuelve a entrar para actualizar tus permisos.»** | Sin Reintentar |
| **500 / red** | **«No se pudo aceptar. Vuelve a intentarlo.»** + mensaje del servidor | La primaria sigue encendida; lo escrito se conserva |

---

## Estados (4) + copy — de lo tocado

| Estado | Qué se ve | Cambio |
|---|---|---|
| **Cargando** | Como hoy (sin esqueleto del detalle; deuda declarada) | Ninguno |
| **Error** | Banda roja + Reintentar, como hoy | Ninguno |
| **Vacío · con «Con diferencias»** | `FlitEmpty` **«No hay trámites con diferencias sin aceptar en este filtro.»** + el botón **Limpiar filtros** de la tarjeta (ya visible) | **Nuevo copy** (el genérico «No hay trámites que coincidan con los filtros.» sigue para el resto) |
| **Lleno** | Compacta: 9 columnas + botón en Acciones en las filas con diferencia. Ampliada: además las marcas bajo TD/LG/SA | **Nuevo** |
| Modal | Cargando: no aplica (los datos vienen en la fila). Error: tabla de arriba. Vacío: no se puede abrir (el botón no existe sin diferencia). Lleno: wireframe | **Nuevo** |

---

## Permiso / slug

`finanzas_reporte_costos`, sin cambio. El botón y el modal dependen de
**`comprobantes.diferencia.aceptar`** (módulo `comprobantes`, migración 0198; `admin` y
`financiera` de partida). Es una función de **otro módulo** dentro de `finanzas/` (mismo caso que
R1 de servicios adicionales): si el panel de roles la quita, el botón desaparece y las marcas
siguen; no hay 403 sorpresa. `auditor`: marcas sí, botón no, filtro sí.

---

## Datos: qué hace falta en la fila del reporte

El diseño técnico (`SELECT_VALORES_DOCUMENTALES`) entrega `origenTd/Lg`, `diferenciaTd/Lg`,
`diferenciaAceptadaTd/Lg`. Para pintar y aceptar hace falta **más** (§7):

| Campo por concepto (`Td`, `Lg`, `Sa`) | Para qué |
|---|---|
| `origen*`: `'documental' ∣ 'tarifa' ∣ null` | Lectura «Comprobante» / nada |
| `diferencia*`: number ∣ null | Chip con signo |
| `tarifaReferencia*`: number ∣ null | Globo y modal («Tarifa $ 80.000» / «Sin tarifa configurada») |
| `diferenciaAceptada*`: boolean | Chip neutral vs warning; existencia del botón |
| `diferenciaAceptadaPorNombre*`, `diferenciaAceptadaEn*`, `diferenciaAceptadaMotivo*` | Globo de «Diferencia aceptada» |
| `comprobante*Id`, `comprobante*Numero`, `comprobante*Fecha` | `POST /:id/diferencia/aceptar` y la línea del modal |
| `logisticaDocumentacionAdjunta`: boolean | `title` «Autogestiona · comprobante adjunto» |
| Query `conDiferencias=1` en `GET /finanzas/reporte-costos` | Filtro |

**PII:** nada nuevo. El nombre de quien aceptó es un usuario interno (criterio de «Añadió Ana
Pérez»). Ningún uuid en pantalla ni en la URL (el filtro es un booleano).

---

## Ficha de ayuda (`finanzas_reporte_costos.md`, usted)

**Paso 4** — añadir al final:

> Cuando un concepto de **Trámite digital** o **Logística** llegó por comprobante (pantalla
> **Comprobantes**), el reporte usa el valor del documento en lugar de la tarifa; bajo el valor, con
> **Mostrar todas las columnas**, lee **Comprobante** o, si no cuadra con la tarifa, **Difiere de
> tarifa** con la diferencia y su signo. En **Serv. adic.** manda siempre el catálogo: un comprobante
> distinto se marca **Difiere del catálogo** sin cambiar el cobro. La casilla **Con diferencias**
> acota a los trámites con una diferencia sin aceptar. En la fila, **Aceptar diferencia** abre un
> diálogo con el valor del comprobante, la tarifa y la diferencia; escriba **por qué se acepta** y
> confirme: el valor no cambia, solo queda constancia, y la marca pasa a **Diferencia aceptada**.
> Un concepto que la compañía autogestiona sigue en blanco aunque tenga un comprobante adjunto.

**«Qué no hace»** — una viñeta:

> - No cambia el valor al aceptar una diferencia ni reemplaza un comprobante: eso se hace en
>   **Comprobantes**. El Excel no trae todavía el origen de cada valor.

---

## Notas para QA (≤10)

1. **Ancho (gate):** 1366×768, compacta, 10 filas con una que tenga «Aceptar diferencia» + Soporte + Servicios · 2 + Liquidar + «Falta: SOAT»: la región de `FlitTable` sigue con `scrollWidth === clientWidth` y sin `tabindex`. *Mutante:* botón con `whitespace-nowrap` que ensancha Acciones.
2. Compacta: **no** hay `th` «Trámite digital» ni «Logística» y **no** existe ningún nodo con «Difiere de»; el botón «Aceptar diferencia» **sí** está en la fila con `diferenciaAceptadaTd=false`. *Mutante:* marca pintada en Servicio/Total.
3. Ampliada, fila con `origenTd='documental', diferenciaTd=15000, diferenciaAceptadaTd=false`: bajo el valor hay `role="note"` cuyo `aria-label` contiene «comprobante dice $ 95.000», «tarifa $ 80.000», «+$ 15.000» y «Sin aceptar»; el chip dice «Difiere de tarifa +$15.000»; Tab lo enfoca y muestra el globo; Esc lo cierra sin mover el foco. *Mutante:* `tabIndex` quitado (solo ratón).
4. Fila con `diferenciaTd=0` y origen documental: texto «Comprobante» y **ningún** chip ni botón. Fila con `origenTd='tarifa'`: **nada** debajo. *Mutante:* chip con «+$0».
5. Fila con `diferenciaAceptadaTd=true`: chip «Diferencia aceptada +$15.000» tono neutral, `aria-label` con el nombre, la fecha y el motivo; **sin** botón «Aceptar diferencia». *Mutante:* botón visible tras aceptar.
6. Serv. adic. con `diferenciaSa=-20000`: el `Monto` sigue mostrando Σ catálogo ($ 125.000); chip «Difiere del catálogo −$20.000»; globo con «El cobro sigue siendo el del catálogo». *Mutante:* pintar el documental en la celda.
7. Logística `Autogestiona` con `logisticaDocumentacionAdjunta=true`: el texto sigue «Autogestiona» y el `title` dice «Autogestiona · comprobante adjunto»; sin chip. *Mutante:* estado nuevo «Adjunto».
8. Casilla «Con diferencias»: la petición lleva `conDiferencias=1`; «Limpiar filtros» la desmarca; con 0 resultados se lee «No hay trámites con diferencias sin aceptar en este filtro.». *Mutante:* casilla sin efecto en la query.
9. Modal con dos diferencias: dos casillas marcadas; motivo de 3 caracteres → alert y **cero POST**; con motivo válido → **dos** `POST /flito/comprobantes/{id}/diferencia/aceptar` en secuencia con el **mismo** `motivo`, toast «Diferencia aceptada en FLIT-…», `refrescar()` (la selección de liquidación **no** se vacía). Segunda respuesta 409 `sin_diferencia` → el modal sigue abierto con el copy bajo esa línea. *Mutante:* `ejecutar()` en vez de `refrescar()`.
10. `auditor`: marcas visibles en ampliada, casilla «Con diferencias» usable, **ningún** botón «Aceptar diferencia» (`toHaveCount(0)`, incluidos deshabilitados). Excel: cabeceras **sin** «Origen valores» (32 literales, sin cambio). *Mutante:* guardar por rol en vez de `hasFuncion`.

---

## Decisiones (continúan las D del reporte)

| # | Decisión | Descarte |
|---|---|---|
| D-27 | Marca **bajo el valor** en TD/LG/SA, patrón `MarcaSoatConciliado` (chip + `role="note"` + globo `aria-hidden`); **solo ampliada** | Columna «Origen»; icono en el valor; marca en compacta bajo Servicio/Total (dato de un concepto en la celda de otro) |
| D-28 | Tres lecturas + «Sin tarifa»; origen tarifa **no pinta nada**; documento igual a tarifa pinta la palabra **Comprobante** sin chip | Chip «Documental» en todas las filas con comprobante (ruido en el caso feliz) |
| D-29 | Importe **con signo** en el chip y en el modal (`+$ 15.000` / `−$ 5.000`); el `Monto` no cambia (una verdad) | Dos cifras en la celda (documento y tarifa) |
| D-30 | SA: el importe es el catálogo; el chip dice **«Difiere del catálogo»**; el globo lo explica | Cambiar el importe por el documental (rompe `servicios_no_cuadran` en Siigo, C6) |
| D-31 | Autogestionado: **sin estado nuevo**; `title` «Autogestiona · comprobante adjunto» | Chip «Adjunto» (no es un valor; no hay nada que decidir) |
| D-32 | Filtro = **casilla** junto a «Solo con soportes completos», semántica «sin aceptar» | Etapa nueva en las pills (las etapas son excluyentes y cubren el cobro; esto es transversal); filtro que incluya las aceptadas |
| D-33 | **Un** botón por fila, rótulo fijo, `aria-label` con los importes; **solo** si hay diferencia sin aceptar y `hasFuncion` | Botón por concepto (hasta tres en Acciones); botón siempre visible apagado |
| D-34 | Modal `FlitModal` (no en línea): hay que leer tres cifras y escribir un motivo; la confirmación en línea de «Reversar» es para un solo texto | Confirmación en línea en Acciones (no caben tres cifras en 148 px); aceptar desde el chip (la marca es lectura) |
| D-35 | Con varias diferencias: casillas + **un** motivo + un POST por comprobante en secuencia; fallo parcial se queda en el modal | Un motivo por línea (ruido); un endpoint de lote (no existe y no hace falta) |
| D-36 | Excel **sin** columna hasta VoBo del PO (C9). La ficha de Ayuda lo dice | Dibujarla «para cuando llegue» |
| D-37 | Aceptar **no** toca el valor ni el sello; disponible también en filas liquidadas/facturadas | Bloquear aceptar tras sellar (D2 dice que no bloquea y la constancia sirve igual después) |

---

## 7. Dónde el diseño técnico y esta ficha no casan

| # | Qué falta | Qué se pide |
|---|---|---|
| S1 | `SELECT_VALORES_DOCUMENTALES` no trae **`tarifaReferencia*`**, **`comprobante*Id/Numero/Fecha`**, ni **quién/cuándo/motivo** de la aceptación | Ampliarlo (una subconsulta escalar más por campo, mismo patrón; el índice parcial garantiza ≤ 1 fila) o devolver un objeto `valorDocumental{Td,Lg,Sa}` por fila |
| S2 | El diseño dice «Servicios adicionales **no cambia** en F2 (C6)» y la Feature #12607 pide **«Difiere del catálogo»** | Confirmar que la marca de SA (sin cambiar el importe) entra en #12607: solo necesita `diferenciaSa`, `tarifaReferenciaSa` (= Σ catálogo) y `comprobanteSaId`; el `COALESCE` de SA **no** se toca |
| S3 | No hay parámetro **`conDiferencias`** en `GET /finanzas/reporte-costos` | Añadirlo (`EXISTS` sobre `flito_comprobantes … marcado_por_diferencia AND diferencia_aceptada_por_id IS NULL`); `finanzas/` está vallado: sin `requireRole` nuevo |
| S4 | «Autogestionado · comprobante adjunto» necesita saber si hay **documentación** (`es_pago = false`) de logística en el trámite | Booleano `logisticaDocumentacionAdjunta` en la fila, o se omite el `title` (la celda queda «Autogestiona» igual) |
| S5 | `aceptarDiferencia` dentro de `POST /:id/aplicar` queda **sin uso** en la UI (el panel de comprobantes no conoce la tarifa antes de aplicar) | Dejarlo o quitarlo; esta ficha acepta solo por `POST /:id/diferencia/aceptar` |
| S6 | El copy de Ayuda del reporte nombra la pantalla **Comprobantes**; existe solo si R0 de la otra ficha (0198) está | Orden de entrega: #12605 antes que #12607 |

```
HANDOFF
  Modo: slim
  Resultado: OK (S1–S4 son requerimientos de datos antes de implementar; ninguno cambia la forma)
  Entrega: /home/david/flit/flito/.claude/worktrees/agent-af9d13dad10006571/docs/ux/finanzas-reporte-costos-valor-documental.md
  Oficio: primaria única (Liquidar; «Aceptar diferencia» es secundario de fila; en el modal, una) | jerarquía dicha (botón en la fila en ambos modos; importe y origen bajo el concepto en ampliada; quién/por qué en el globo) | vacío con siguiente paso (Limpiar filtros) y errores por código con acción | sin efectos ni patrón nuevo (marca = MarcaSoatConciliado generalizada)
  Densidad: empeora un punto en Acciones solo en filas con diferencia (tercer botón envuelve); compacta sin columnas nuevas; medir QA 1
  Pantallas: 1 vista tocada + 1 modal | Requerimientos nuevos de datos: 4 (S1–S4) + confirmación de alcance S2
  Siguiente: architecture-agent (S1–S3) → frontend-agent con D-27..D-37 → qa-agent con las 10 notas; Excel espera VoBo del PO
```
