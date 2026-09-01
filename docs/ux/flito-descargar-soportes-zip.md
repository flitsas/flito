# UX slim — Descargar soportes en ZIP (HU #11910, Feature #11908)

> **Qué es este documento.** La entrada del `frontend-agent` que implemente la HU #11910. Modo
> **slim**: tres pantallas que ya existen ganan **una casilla más ancha** y **una acción**; lo nuevo
> de verdad es **un diálogo de tipos de documento**.
>
> **Eslabón previo, y la regla que manda:** la HU #11909 (`docs/ux/flito-soat-impuestos-export-excel.md`)
> acaba de estrenar en estas mismas colas el patrón de acción de cabecera —botón secundario sin icono,
> línea de ayuda debajo, banda de resultado separada, `role="status"` sr-only siempre montada +
> `role="alert"`, candado de `ref` contra el doble clic—. **Esta acción es hermana de aquella y debe
> parecerlo.** El código vive en `apps/web/src/components/flito/ExportarCola.tsx` y esta HU **lo
> comparte**, no lo clona: abajo se dice exactamente qué se exporta y qué se generaliza.
>
> **Fuera de alcance, escrito para que nadie lo amplíe de paso:** no se tocan columnas, buscador,
> pastillas, presets, filtros, ni los modales de detalle; no se arregla el esqueleto ausente de
> Impuestos (deuda ya declarada en la #11909); no se añade descarga de soportes al `auditor` ni al
> `cliente`; no se toca `columnasComunes.tsx`.

---

## Superficie tocada

| | SOAT | Impuestos | Gestión de trámites |
|---|---|---|---|
| Página | `/flito/soat` | `/flito/impuestos` | `/flito/tramites` |
| Archivo | `apps/web/src/pages/FlitoSoat.tsx` | `apps/web/src/pages/FlitoImpuestos.tsx` | `apps/web/src/pages/FlitoTramites.tsx` |
| Superficie 1 — **casillas** | cabecera `FlitoSoat.tsx:517-523`, fila `:539-546` | cabecera `FlitoImpuestos.tsx:448-453`, fila `:466-471` | cabecera `FlitoTramites.tsx:457-463`, fila `:502-509` |
| Superficie 2 — **barra de selección** | `BarraEnvio`, `FlitoSoat.tsx:473-476` y `:605-641` | `BarraSeleccion`, `FlitoImpuestos.tsx:419-424` y `:556-642` | barra inline, `FlitoTramites.tsx:372-384` |
| Superficie 3 — **diálogo de tipos** | *(no se abre: un solo tipo, ver Decisión 3)* | nuevo | nuevo |
| Superficie 4 — **banda de resultado** | la que ya monta `AvisoExportCola` (`FlitoSoat.tsx:371-379`) | ídem (`FlitoImpuestos.tsx:342-350`) | nueva; hoy la pantalla solo tiene `{error && <FlitCard>…}` (`FlitoTramites.tsx:370`) |
| Slug / permiso | `flito_soat` — **sin cambios** | `flito_impuestos` — **sin cambios** | `flito_tramites` — **sin cambios** |

**Cero componentes visuales nuevos salvo el diálogo, que es `FlitModal` + casillas del kit.**

---

## Lo que existe hoy y esta HU sustituye

**El botón «Descargar facturas (zip)»** — `FlitoTramites.tsx:380`, dentro de la barra de selección
que solo ve Operaciones (`:372-384`). Lo que hace hoy, línea a línea (`:293-299`):

- filtra la selección a las filas **con impuesto y con `facturaVentaFlitId`** (`:294`);
- si no queda ninguna, escribe en la banda de error de la pantalla
  **«Ninguno de los seleccionados tiene factura de venta en FLIT.»** (`:295`) — **este copy es el
  antepasado directo del AC6 y su forma se conserva**;
- si quedan, `api.downloadPost('/flito/impuestos/facturas-venta/zip', 'facturas-venta.zip', { ids })`
  (`:297`), con el nombre del archivo **escrito en el cliente**;
- sin estado ocupado, sin candado de doble clic, sin banda de éxito: si el ZIP tarda 40 s, la pantalla
  no dice nada.

En el servidor: `flito-impuestos.routes.ts:136-167`. Tope de **100 ids** (`:137`), `archiver`,
`Content-Disposition: filename="facturas-venta.zip"` (`:145`), **omite el documento que falla en vez
de tumbar el ZIP** (`:165`) y audita `incluidas/solicitadas` (`:167`). Ese comportamiento parcial ya
existe y no está dicho en ninguna parte de la interfaz — el AC6 es la ocasión de decirlo.

> **Decisión 1 — el botón desaparece, pero el sitio no.** «Descargar soportes» ocupa **la misma
> posición de la misma barra** (`FlitoTramites.tsx:380`), con el mismo estilo secundario. Quien lo
> tenía memorizado hace el mismo gesto en el mismo píxel; lo que se encuentra es un diálogo con
> **«Factura de venta» ya marcada**, así que confirmar sin leer produce **al menos** lo de antes.
> Lo que cambia y hay que declarar: (a) el ZIP puede traer más documentos si no desmarca nada, y
> (b) **el archivo ya no se llama `facturas-venta.zip`** sino `soportes_AAAAMMDD-HHmm.zip`, así que
> cualquier macro o carpeta que dependiera de ese nombre deja de encajar. En el diálogo de trámites,
> una línea de transición lo dice (ver «El diálogo»).
> Descartes: (a) dejar los dos botones —dos caminos al mismo ZIP, y el viejo miente en cuanto haya
> tres tipos—; (b) quitarlo sin sustituto en el mismo sitio —el usuario busca donde estaba—.

---

## El problema de esta HU: 8 marcadas, «Enviar» dice 3

El AC1 abre la casilla a **cualquier fila visible**. Hoy la casilla es la del trabajo que se puede
hacer con ella, y las tres pantallas lo dicen de tres maneras:

- **SOAT** solo pinta la casilla en las `PENDIENTE` (`FlitoSoat.tsx:541`) y el `seleccionables` es
  literalmente «los pendientes» (`:325`).
- **Impuestos** ya admite dos clases de fila —enviables y certificables (`:267-272`)— y resuelve la
  ambigüedad con la regla escrita en `BarraSeleccion` (`:548-550`): **una acción se ofrece solo si
  aplica a TODA la selección**; si no, aparece «La selección mezcla estados con acciones distintas»
  (`:628-632`) y **no se ofrece ninguna**.
- **Trámites** apaga la casilla de lo no accionable: `disabled={!esAccionable(f)}` con
  `title="Solo Asignado con empresa y secretaría emparejadas"` (`FlitoTramites.tsx:505`).

Con el AC1, la regla de «toda la selección» se vuelve dañina: marcar una sola fila Pagada para meter
su comprobante en el ZIP **haría desaparecer «Enviar al gestor»**, que es la acción del día. Y el
«Seleccionar todo» de la cabecera pasaría a marcar filas de todos los estados, o sea que dejaría la
barra muda siempre.

> **Decisión 2 — la acción se ofrece si aplica a **alguna** fila marcada, y el rótulo dice a cuántas.**
> No hay patrón nuevo: cambia el **número entre paréntesis** que el botón de certificar ya lleva
> (`Certificar (${ids.length})`, `FlitoImpuestos.tsx:618`).
>
> | Caso | Rótulo |
> |---|---|
> | Todas las marcadas admiten la acción | **`Enviar al gestor (8)`** · **`Certificar (8)`** — como hoy |
> | Solo algunas | **`Enviar al gestor (3 de 8)`** · **`Certificar (5 de 8)`** |
> | Ninguna | el botón **no se pinta** (como hoy) |
>
> El «de 8» va **dentro del rótulo** y no solo en una línea de ayuda a propósito: el rótulo es el
> nombre accesible del botón y es lo que se lee en el instante de decidir; una línea auxiliar se
> pierde al envolver la barra en pantalla estrecha.
>
> Y una línea de ayuda debajo de la barra, **solo cuando hay desajuste**:
> **«De las 8 filas marcadas, 3 están Pendientes y son las únicas que se envían. Descargar soportes
> usa las 8.»** (en Impuestos, «…5 admiten certificación y son las únicas que se certifican…»).
>
> **La petición manda solo los ids aplicables.** Marcar más filas no amplía nunca el alcance de
> `POST /flito/soat/enviar`, `/flito/impuestos/enviar` ni `/flito/impuestos/certificar`. Es la
> regresión más cara de esta HU y por eso se comprueba **sobre el cuerpo de la petición**, no sobre
> el rótulo (QA 3).
>
> **`sobreElTope` cambia de sujeto.** Hoy es `todosCertificables && ids.length > TOPE_LOTE_CERTIFICACION`
> (`FlitoImpuestos.tsx:573`). Pasa a medir **los certificables**, no la selección entera: con 12
> marcadas de las que 3 se certifican, el tope de 10 no debe bloquear nada. El copy conserva su forma:
> **«Máximo 10 por lote. De las 14 marcadas, 12 se certifican.»**
>
> Descartes: (a) mantener «toda la selección» —el AC1 la vuelve un candado—; (b) apagar las casillas
> de otros estados al marcar la primera —la interfaz se movería sola bajo el cursor, ya descartado en
> `FlitoImpuestos.tsx:545-546`—; (c) un modal de confirmación «vas a enviar 3 de 8» —una pantalla más
> para un dato que cabe en el rótulo—.

### El «Seleccionar todo» de la cabecera

Cambia de sentido en las tres, y con él su nombre accesible:

| Hoy | Ahora |
|---|---|
| `Seleccionar todos los pendientes` (`FlitoSoat.tsx:519`) | **`Seleccionar las filas de esta página`** |
| `Seleccionar todos los que admiten acción masiva` (`FlitoImpuestos.tsx:450`) | ídem |
| `Seleccionar accionables` (`FlitoTramites.tsx:459`) | ídem |

Y su `checked` se calcula contra **todas** las filas visibles, no contra el subconjunto accionable.
En trámites desaparecen además el `disabled` y el `title` de la casilla de fila (`:505`).
**La selección sigue siendo de la página**: los efectos que la vacían al cambiar filtro o página ya
existen (`FlitoSoat.tsx:246`) y no se tocan.

---

## El diálogo — la pieza nueva

**Se reutiliza `FlitModal`** (`components/flit/FlitModal.tsx`), compacto (sin `wide`), que es el
diálogo de todo el producto: `role="dialog"`, `aria-modal`, nombre accesible desde `title` (`:70`),
foco atrapado y restaurado (`useFocusTrap`, `:49`), Esc que cierra **solo el de más arriba** (`:43-46`)
y cierre por backdrop. **No hay en el repo un componente de «modal con casillas»**: lo más cercano es
`ThFiltroMulti`, que es un desplegable de filtro de tabla y no un diálogo. Se compone con lo que ya
hay —`FlitModal` + `<input type="checkbox">` con `label` del kit, como el «Elegir fecha»
(`FlitoTramites.tsx:343-346`) o el «sin marca de agua» (`FlitoImpuestos.tsx:888`)— y **no se crea un
componente de diálogo nuevo**.

```
┌ Documentos del ZIP ─────────────────────────────────────── [X] ┐
│                                                                │
│  Antes este botón traía solo las facturas de venta. Ahora      │  ← solo en Trámites
│  eliges qué documentos entran.                                 │     (línea de transición)
│                                                                │
│  ┌ Qué se descarga de las 8 filas marcadas ─────────────────┐  │  ← <legend> del fieldset
│  │ [x] Factura de venta                                     │  │
│  │     La que emite el concesionario y llega de FLIT.       │  │
│  │ [x] Recibo del impuesto                                  │  │
│  │     El comprobante que el organismo emite al pagar.      │  │
│  │ [x] Comprobante del SOAT                                 │  │  ← solo en Trámites
│  │     La póliza/factura de la aseguradora.                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  Se descarga un solo ZIP. Cada archivo va con el nombre        │
│  PLACA-ORGANISMO.                                              │
│                                                                │
│                              [ Cancelar ]  [ Descargar ]       │
└────────────────────────────────────────────────────────────────┘
```

**Copy de las opciones, con las palabras que el usuario ya ve en pantalla:**

| Tipo (`flito-estados.ts:295-305`) | Rótulo | Por qué esa palabra |
|---|---|---|
| `factura_venta` | **Factura de venta** | Es como se llama en las tres pantallas: «Sin factura en FLIT» (`FlitoImpuestos.tsx:740`), `CeldaFacturaVenta` (`FlitoTramites.tsx:533`) |
| `recibo_impuesto` **+** `recibo_impuesto_sin_marca_agua` | **Recibo del impuesto** | El AC lo llama «comprobante de pago»; en la pantalla el usuario lee «Cargar recibos (masivo)» (`FlitoImpuestos.tsx:326`) y «Este impuesto no tiene ningún recibo cargado todavía» (`:758`). Manda la palabra de la pantalla; la del AC va en la línea de ayuda |
| `factura_soat` | **Comprobante del SOAT** | El AC4 lo nombra así. En el detalle del SOAT se lee «Ver soporte» / «Cargar factura» (`FlitoSoat.tsx:781`, `:821`); «factura del SOAT» se confundiría con la factura de venta en un diálogo donde salen las dos |

**Qué diálogo sale en cada pantalla:** SOAT → **ninguno** (un solo tipo). Impuestos → dos casillas.
Trámites → tres.

> **Decisión 3 — en SOAT no hay diálogo, y no es una excepción escrita a mano.** El componente
> compartido recibe la lista de tipos de la pantalla y **abre el diálogo solo si `tipos.length > 1`**;
> con uno, el clic descarga. Un diálogo cuya única respuesta posible es «sí» es un clic que no decide
> nada, y además tendría que llegar con la casilla marcada y sin posibilidad de desmarcarla.
> Lo que sí cambia en SOAT es la **línea de ayuda** bajo el botón, que dice qué trae:
> **«Se descargan los comprobantes de pago cargados en las filas marcadas.»**
> El día que SOAT tenga un segundo tipo, el diálogo aparece solo. **No entra el comprobante PSE de la
> conciliación** (`soportes-consulta.ts:86-124`, ADR-0006 §7.5): el AC2 pide los comprobantes de pago
> cargados en el SOAT y meter aquí el de la boleta reabriría una discusión de permisos que ya está
> cerrada.

**Estado por defecto: todas marcadas.** El caso frecuente es «todo lo que tenga de estas filas» —el
AC3 lo llama «ambos» y lo pide explícitamente— y así el gesto memorizado del botón viejo sigue
trayendo su factura de venta. **Si el usuario desmarca todas**, el botón «Descargar» queda `disabled`
y aparece, en el mismo bloque, **«Elige al menos un tipo de documento.»** con `role="status"` (un
botón deshabilitado no anuncia por qué lo está). No se cierra el diálogo, no se manda nada.

**Botones:** **«Descargar»** primario (`flitBtnPrimary`) y **«Cancelar»** secundario. `Cancelar`
además del aspa de `FlitModal`: es un diálogo de decisión, no un visor.

**Al confirmar, el diálogo se cierra** y el trabajo se ve en el botón de la barra y en la banda.
Un ZIP de 100 PDF puede tardar; retener la pantalla tras un modal todo ese rato es peor que el
problema, y el patrón no bloqueante ya está estrenado en la #11909. El foco vuelve solo al botón que
abrió el diálogo (`useFocusTrap`), que es justo el que pasa a `aria-busy`.

**La descarga NO limpia la selección ni refresca la cola** —a diferencia de enviar y certificar
(`FlitoSoat.tsx:475`, `FlitoImpuestos.tsx:638`)—: quien descarga suele descargar dos veces seguidas,
y perder 40 filas marcadas por haber pedido un ZIP es caro y no lo pide ningún AC.

---

## Estados (4) + copy

### El botón de la barra de selección (las tres pantallas)

**(a) Reposo.** Rótulo **«Descargar soportes (8)»** — el número es el de filas marcadas, y aquí sí es
el total, porque la acción **sí** aplica a todas (esa es la diferencia con «Enviar» y es lo que hace
comprensible el desajuste de la Decisión 2). Habilitado siempre que haya selección; **no** se
deshabilita por «ninguna tiene documentos»: el cliente no sabe qué soportes existen y adivinarlo lo
llevaría a apagar botones sin motivo.

```
┌ FlitCard ──────────────────────────────────────────────────────────────────────┐
│ 8 seleccionado(s)   [Enviar al gestor (3 de 8)]  [Certificar (5 de 8)]         │
│                     [Descargar soportes (8)]     [Limpiar]                     │
│ De las 8 filas marcadas, 3 están Pendientes y son las únicas que se envían.    │
│ Descargar soportes usa las 8.                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

**(b) Generando.** Rótulo **«Preparando el ZIP…»**, `disabled` + `aria-busy` (mismo par que
`BotonExportarCola`, `ExportarCola.tsx:296-299`), y candado de `ref` (`useExportCola`, `:255-262`).
Un ZIP tarda más que un Excel, así que aquí **sí** hay una línea visible mientras trabaja, en el
mismo hueco donde la barra pinta sus avisos:
**«Estamos armando el ZIP. Puede tardar; puedes seguir en la cola mientras tanto.»**
(precedente del mismo tipo: el `title` de certificar, `FlitoImpuestos.tsx:617`).
Anuncio sr-only en la región `role="status"` siempre montada:
**«Preparando el ZIP con los soportes de 8 filas.»**
La cola no se bloquea; sí se bloquea **este** botón, no los demás.

**(c) Éxito.** Banda neutra, misma tarjeta que `AvisoVisible` (`ExportarCola.tsx:351-399`), leída por
la región polite:

| Caso | Copy |
|---|---|
| Completo (8 de 8 aportaron documento) | **«ZIP descargado: soportes_20260830-1412.zip»** `[Cerrar el aviso]` |
| **Parcial** (2 de 5) | **«ZIP descargado: soportes_20260830-1412.zip — 2 de las 5 filas marcadas tenían recibo del impuesto; las otras 3 no.»** `[Cerrar el aviso]` |

**(d) Error.** Banda `role="alert"`, tinta `--flit-danger-ink` (nunca `--flit-danger` a 14 px,
Bug #11604).

| Caso | Copy | ¿Reintentar? |
|---|---|---|
| **AC6 — ninguna marcada tiene ese tipo** (422 `zip_sin_soportes`, texto del servidor) | **«Ninguna de las 8 filas marcadas tiene recibo del impuesto cargado. No se descargó nada.»** — respaldo del cliente sin cifras: **«Ninguna de las filas marcadas tiene los documentos que elegiste. No se descargó nada.»** | **No.** Repetir da lo mismo; lo que hay que cambiar es la selección o el tipo |
| Demasiadas filas para un ZIP (422 `zip_demasiadas_filas`) | Texto del servidor, con su cifra. Respaldo: **«Marcaste más filas de las que admite un ZIP. Descarga en dos tandas.»** | No |
| 429 · 403 · corte de conexión · genérico | **Los mismos textos de `avisoDeError`** (`ExportarCola.tsx:180-224`) — se reutiliza la función, no se reescriben | Como allí |

> **Decisión 4 (a confirmar con el PO) — el caso parcial descarga lo que hay y lo dice.** El AC6 solo
> habla del caso vacío. Con 5 marcadas y 2 con documento se propone **descargar el ZIP con los 2 y
> avisar con la cifra en la banda de éxito**, porque (a) es lo que el backend ya hace hoy —omite el
> documento que falla y sigue (`flito-impuestos.routes.ts:165`), y lo audita como `incluidas/total`
> (`:167`)—, y (b) negar la descarga entera por un documento ajeno bloquearía la conciliación de los
> otros cuatro. **Lo que no se acepta es la versión silenciosa**: un ZIP más corto de lo esperado sin
> decirlo es la misma trampa que el «Excel truncado» que la #11909 prohibió; la diferencia es que aquí
> se declara con números. Si el PO prefiere «todo o nada», el cambio es un `if` en el backend y esta
> banda pasa a ser un error.

### Las casillas (superficie 1)

| Estado | Qué se ve |
|---|---|
| **Cargando** | El de la cola, sin cambios: `PageContentSkeleton` en SOAT (`FlitoSoat.tsx:471`); Impuestos sigue sin esqueleto (deuda declarada en la #11909, no se paga aquí) |
| **Error** | El de la cola, sin cambios (`FlitoSoat.tsx:457-466`) |
| **Vacío** | Sin filas no hay columna de casillas ni barra; los textos de vacío no se tocan |
| **Lleno** | Casilla en **todas** las filas visibles para quien puede descargar; barra con los rótulos de la Decisión 2 |

### El diálogo

| Estado | Qué se ve |
|---|---|
| **Reposo** | Las 2 o 3 casillas, todas marcadas; «Descargar» habilitado |
| **Cargando** | **No tiene.** No pide nada al abrirse: los tipos son una lista fija del producto, no un dato del servidor |
| **Error / vacío** | Cero tipos marcados → «Descargar» `disabled` + «Elige al menos un tipo de documento.» El error de la descarga **no se pinta aquí**: el diálogo ya se cerró y el aviso vive en la banda |
| **Confirmado** | Se cierra, foco al botón, `aria-busy` |

---

## Permiso / slug y visibilidad por rol

Slugs **sin cambios**: `flito_soat`, `flito_impuestos`, `flito_tramites`
(`packages/shared-types/src/permissions.ts:102,117,118`). **No se crea ningún predicado nuevo**: se
reutiliza el que cada pantalla ya escribió para el export de la #11909.

```
SOAT       →  puedeDescargarSoportes = esOperaciones || esGestor   // = FlitoSoat.tsx:321
Impuestos  →  puedeDescargarSoportes = esOperaciones || esGestor   // = FlitoImpuestos.tsx:249
Trámites   →  puedeDescargarSoportes = esOperaciones               // = la guarda de la barra, :372
```

| Rol | SOAT | Impuestos | Trámites |
|---|---|---|---|
| `admin` | casillas **sí** · acción **sí** | sí · sí | sí · sí |
| `proveedor` (gestor SOAT) | **sí · sí** — *hoy no ve casillas (`FlitoSoat.tsx:539`); las gana, y son suyas: necesita los comprobantes de sus SOAT* | no entra | no entra |
| `gestor_impuestos` | no entra | sí · sí (ya tenía casillas para certificar) | no entra |
| `auditor` | **NO · NO** (AC7) | **NO · NO** | **NO · NO** (hoy tampoco, `:457`) |
| `cliente` | **NO · NO** — fuera por construcción de la guarda, igual que en la #11909 (Decisión 2 de aquel doc) | no entra | no entra |

> **AC7 — no se pinta, no se pinta deshabilitada.** Ni el botón ni la columna de casillas. En
> Impuestos eso obliga a un cambio concreto: la columna hoy se pinta si `seleccionables.length > 0`
> (`:448`, `:466`), un cálculo que para el auditor da vacío **por casualidad** —porque ninguna de sus
> filas admite enviar ni certificar—. Pasa a depender de `puedeDescargarSoportes`, que es la
> afirmación que se quiere sostener. La banda de resultado se monta **solo donde se monta el botón**.

---

## Datos — tres endpoints que **no existen** (requerimiento para architecture/backend)

| Necesidad | Estado hoy | Qué hace falta |
|---|---|---|
| `POST /flito/soat/soportes/zip` | **No existe** | `{ ids: uuid[], tipos: ['factura_soat'] }` |
| `POST /flito/impuestos/soportes/zip` | **No existe** | `{ ids, tipos: ('factura_venta' \| 'recibo_impuesto')[] }` |
| `POST /flito/tramites/soportes/zip` | **No existe** | `{ ids: tramiteId[], tipos: ('factura_venta' \| 'recibo_impuesto' \| 'factura_soat')[] }` |
| Molde de los tres | `flito-impuestos.routes.ts:136-167` | `archiver`, tope de ids, omitir el que falla, `audit({ action: 'export' })` |
| Fuente de los documentos | `soportes-consulta.ts` | `soportesDeSoat` (`:245`), `soportesDeImpuesto` (`:265`), `soportesDeTramite` (`:284`) — **la misma consulta que ya alimenta el visor**, no una segunda |
| Factura de venta del flujo de trámite | `flito-impuestos.routes.ts:136` | No está en `flito_soportes`: llega de FLIT por `facturaVentaFlitId`. El ZIP de trámites la toma de donde la toma hoy |
| `zip_sin_soportes` (AC6) | — | 422 con `codigo` estable y mensaje con las cifras del caso. Molde de códigos: `avisoDeError` mira `codigo`, **nunca el texto** (`ExportarCola.tsx:140-143`) |
| Conteo del caso parcial | — | Cabecera de respuesta **`X-Soportes-Incluidos: 2`**. El cliente ya sabe cuántas filas mandó; solo le falta cuántas aportaron. (Si el API queda tras un origen distinto, va en `Access-Control-Expose-Headers`) |
| Nombre del ZIP | — | `Content-Disposition`, **`soportes_AAAAMMDD-HHmm.zip`**, sello en hora de Colombia y **sin placa, VIN, NIT ni documento**. Validado en el cliente antes de aceptarlo, generalizando `esNombreDeExport` con la extensión como parámetro (`ExportarCola.tsx:111-121`) — **no una segunda expresión regular** |
| Nombre de cada archivo **dentro** del ZIP (AC5) | — | **`PLACA-ORGANISMO.pdf`**, lo escribe el **servidor** (el cliente solo manda ids). Sanitizado: mayúsculas, sin tildes, espacios y `/` a `-`. Colisión → sufijo **`-2`, `-3`** en orden **determinista** (`subidoEn` ascendente), para que dos descargas iguales den dos ZIP iguales |
| Fila sin placa | — | Hay filas con `placa: null` (`FlitoSoat.tsx:42`). Propuesta: **`SIN-PLACA-<idFlit>`**. *Decisión a confirmar* |
| Tope de filas | `max(100)` (`:137`) | Se conserva, pero el rechazo debe ser un **422 `zip_demasiadas_filas`** con su cifra, no el 400 crudo de Zod: un 400 sin `codigo` cae en el genérico y el usuario lee «avisa a soporte» por haber marcado 120 filas |
| `POST /flito/impuestos/facturas-venta/zip` | Existe; **su único llamador es `FlitoTramites.tsx:297`** | Tras esta HU no lo llama nadie. Que se retire o se reescriba como el nuevo lo decide architecture; **desde la UI no queda ninguna pantalla que dependa de él** |

> **PII (AGENTS.md §14, Ley 1581).** Los ids viajan en el **cuerpo** del POST, como ya hacen
> (`FlitoTramites.tsx:297`); no hay variante `GET` y no la puede haber. **La placa entra en el nombre
> de cada entrada del ZIP —eso es el AC5 y es lo que hace útil el archivo para conciliar— pero NO en
> el nombre del ZIP**, que es lo que acaba en asuntos de correo y carpetas compartidas. Ni el nombre
> del comprador ni su documento aparecen en ningún nombre de archivo.

> **Pregunta abierta (no bloquea la implementación).** Un impuesto puede tener el recibo **con y sin
> marca de agua** (`TipoSoporte.RECIBO_IMPUESTO` y `…_SIN_MARCA_AGUA`, `flito-estados.ts:298-299`).
> Se propone que **«Recibo del impuesto» traiga los dos** —el desempate `-2` es justamente para eso—
> en vez de añadir una tercera casilla que obligaría al usuario a saber qué es una marca de agua.
> Si el PO quiere solo uno, es un filtro en el backend y el diálogo no cambia.

---

## Qué se comparte con la #11909 (para que nadie clone)

`components/flito/ExportarCola.tsx` ya resuelve cinco de las seis piezas. **Se reutiliza, se exporta
lo que falte y se generaliza lo mínimo; no se copia el archivo.**

| Pieza | Qué hacer |
|---|---|
| Candado de doble clic + estado ocupado | **Mismo patrón que `useExportCola`** (`:252-277`): `ref` síncrona **además** del `disabled`. Un hook hermano `useDescargaZip` con la misma forma |
| Copy de errores comunes (429, 403, corte, genérico) | **Llamar a `avisoDeError`** (`:180-224`), que ya está exportada. El envoltorio del ZIP solo añade los dos 422 propios. El 422 `export_demasiado_grande` no llega nunca desde este endpoint: esa rama queda inerte, no estorba |
| Banda de resultado | **Exportar `AvisoVisible`** (`:351-399`, hoy privada) y usarla tal cual. Clonar la tarjeta es garantizar que dentro de tres meses tengan bordes distintos |
| Las dos regiones ARIA | **Mismo reparto que `AvisoExportCola`** (`:329-349`): `role="status"` sr-only **siempre montada** para «preparando» y para el éxito; `role="alert"` solo en la banda visible del error, **sin repetirlo** en la polite |
| Validación del nombre servido | **Generalizar `esNombreDeExport(prefijo, nombre)`** (`:111-121`) con la extensión como tercer parámetro |
| Botón + línea de ayuda | `BotonExportarCola` (`:288-308`) **no se reutiliza**: aquel vive en el slot `actions` del `PageHeaderCard` y este vive en la barra de selección, junto a «Enviar» y «Certificar», porque **actúa sobre la selección y no sobre el filtro**. Se copian el estilo (`flitBtnSecondary`), el `aria-busy` y el hueco de la línea de ayuda |

---

## Accesibilidad

- **Diálogo:** todo lo trae `FlitModal` y **no se reimplementa nada**: `role="dialog"` + `aria-modal`
  (`:68-70`), nombre accesible = el `title` (**«Documentos del ZIP»**), foco que entra, se atrapa y
  se restaura (`useFocusTrap`, `:49`), Esc que cierra **solo el diálogo de más arriba** (`:43-46`) y
  cierre por backdrop. **No se pasa `restoreFocusRef`**: el botón que abre sigue montado al cerrar
  —la descarga no refresca la cola (Decisión 3)— y el respaldo solo hace falta cuando el disparador
  desaparece.
- **Las casillas van en un `<fieldset>` con `<legend>`** («Qué se descarga de las 8 filas marcadas»):
  es lo que da contexto al grupo cuando se recorren una a una con lector. Cada `<input>` con su
  `<label>` asociado; la línea de ayuda de cada opción, con `aria-describedby`.
- **El «Elige al menos un tipo de documento.» lleva `role="status"`**: aparece a la vez que el botón
  se deshabilita, y un `disabled` no dice por qué.
- **Resultado anunciado fuera del diálogo**, en la región polite de la pantalla, porque el diálogo ya
  se cerró cuando llega. El foco no se mueve al terminar: se queda en el botón.
- **Nombres accesibles distintos en la misma pantalla:** «Reintentar la descarga» (banda) sigue sin
  colisionar con el «Reintentar» de la cola (`FlitoSoat.tsx:463`). El botón nuevo se llama
  **«Descargar soportes (8)»** y no «Descargar» a secas — en Impuestos convive con «Descargar
  certificado» por fila.
- axe: `QA_AXE_CDN=1` o salen ~10 rojos que no son regresión de nada.

---

## Notas para QA (10)

1. **AC7 como ausencia del DOM, en las tres pantallas.** Con `auditor`:
   `getByRole('button', { name: /Descargar soportes/ })` → `toHaveCount(0)` **y**
   `getByRole('checkbox', { name: /^Seleccionar/ })` → `toHaveCount(0)` en `/flito/soat`,
   `/flito/impuestos` y `/flito/tramites`. *Mutante:* pintarlo `disabled` — `toBeDisabled()` lo daría
   por bueno, `toHaveCount(0)` lo mata. Comprobar además que el auditor **sí sigue viendo la cola y
   sus filtros**: sin ese segundo aserto, «esconder media pantalla» también pasaría.
2. **AC7 por el lado positivo, o el test no prueba nada.** `admin` en las tres; `proveedor` en SOAT
   (**gana casillas que hoy no tiene**); `gestor_impuestos` en Impuestos. *Mutante:*
   `{esOperaciones && …}` a secas — deja al gestor sin casillas y solo se ve probando con él.
3. **La regresión cara, medida sobre la PETICIÓN.** Marcar 8 filas de las que solo 3 son Pendientes:
   el rótulo dice `Enviar al gestor (3 de 8)` **y el cuerpo de `POST /flito/soat/enviar` lleva 3
   ids**, los de las Pendientes. Igual con `Certificar (5 de 8)` y `POST /flito/impuestos/certificar`.
   *Mutantes:* mandar `[...seleccion]` entero (el rótulo seguiría verde si solo se mira el texto);
   volver a la regla «toda la selección» —entonces con 8 marcadas no se pinta ningún botón, y eso
   también hay que asertarlo por el lado de que **sí** se pinta.
4. **El tope de certificación mide los certificables.** 14 marcadas, 12 certificables, tope 10 →
   botón bloqueado y **«Máximo 10 por lote. De las 14 marcadas, 12 se certifican.»** Con 14 marcadas
   y 3 certificables → **no** hay bloqueo. *Mutante:* dejar `ids.length > TOPE` (`FlitoImpuestos.tsx:573`).
5. **AC5 — el nombre, comprobado descomprimiendo.** Descargar un ZIP, abrirlo y leer las entradas:
   todas encajan con `PLACA-ORGANISMO(-\d+)?\.(pdf|jpg|png)`. Con dos documentos de la misma
   placa+organismo, las entradas son `ABC123-BOGOTA.pdf` y **`ABC123-BOGOTA-2.pdf`**; con tres,
   además `-3`. Repetir la descarga: **el mismo orden** (`subidoEn` ascendente). *Mutantes:* nombre
   por id de soporte; segundo archivo que **sobrescribe** al primero dentro del ZIP —el ZIP tendría
   una entrada menos y el aserto de conteo es el que lo mata—; orden no determinista.
6. **AC6 — no hay ZIP vacío en silencio.** Marcar filas sin ningún recibo y elegir solo «Recibo del
   impuesto»: **no hay descarga**, sale la banda `role="alert"` con «Ninguna de las N filas marcadas
   tiene recibo del impuesto cargado. No se descargó nada.» y **no** hay «Reintentar la descarga».
   *Mutantes:* entregar un ZIP de 0 bytes; entregar un ZIP con solo el directorio central; ofrecer
   reintento.
7. **El caso parcial (Decisión 4).** 5 marcadas, 2 con documento: **sí** hay descarga, el ZIP trae
   **2** entradas y la banda de éxito dice **«2 de las 5 filas marcadas…»**. *Mutante:* banda de
   éxito genérica sin cifras — verde hoy, y el día que falten 3 documentos nadie se entera.
8. **Doble clic = una sola petición**, y el diálogo. Dos clics seguidos en «Descargar» del diálogo →
   **una** petición a la red. *Mutante:* quitar la `ref` y quedarse con el `disabled`, que llega un
   commit tarde (`ExportarCola.tsx:236-241`).
9. **El diálogo, entero.** (a) Se abre con **todas** las casillas marcadas; (b) desmarcar todas
   deshabilita «Descargar» y muestra el aviso; (c) **Esc cierra** y el foco vuelve al botón que lo
   abrió; (d) con el visor de documentos abierto encima, Esc cierra **solo el de arriba**
   (`FlitModal.tsx:43-46`); (e) **en SOAT no se abre ningún diálogo**: el clic descarga.
   *Mutante:* diálogo también en SOAT «por consistencia».
10. **Lo que desaparece y lo que se queda.** `getByRole('button', { name: 'Descargar facturas (zip)' })`
    → `toHaveCount(0)` en `/flito/tramites`. Y tras una descarga correcta, **la selección sigue
    marcada** y la cola **no se recargó**. *Mutante:* llamar a `limpiar()`/`refrescar()` al terminar,
    copiado de `ejecutar()` (`FlitoTramites.tsx:268-273`).

> **Recordatorio de infraestructura:** el CI solo corre **un** spec E2E (el visor de PDF). Cualquier
> spec de estas tres pantallas está en la lista fija del **nocturno**: verde en el PR no significa que
> nadie lo haya ejecutado. Quien cierre la HU lo corre a mano.

---

## Decisiones y descartes (citables en el PR)

| # | Decisión | Descarte |
|---|---|---|
| 1 | «Descargar soportes» ocupa **el mismo sitio** del viejo «Descargar facturas (zip)», con «Factura de venta» marcada por defecto y una línea de transición en el diálogo | Dejar los dos botones; o quitarlo sin sustituto en su sitio |
| 2 | La acción se ofrece si aplica a **alguna** marcada, y el rótulo dice **«(3 de 8)»**; la petición manda solo los ids aplicables | Mantener «toda la selección» (el AC1 la vuelve un candado); apagar casillas al vuelo; un modal de confirmación |
| 3 | **En SOAT no hay diálogo**, por la regla general «diálogo solo si `tipos.length > 1`» | Un diálogo con una casilla marcada e indesmarcable |
| 4 | **Caso parcial: se descarga lo que hay y se dice con cifras** — *a confirmar con el PO* | Descargar en silencio (la trampa del «Excel truncado»); o no descargar nada |
| 5 | Todas las casillas **marcadas por defecto**; con cero, botón `disabled` + aviso `role="status"` | Ninguna marcada (dos clics siempre y regresión del gesto memorizado) |
| 6 | Rótulos con **la palabra de la pantalla**: «Recibo del impuesto», no «comprobante de pago» | El vocabulario del AC, que en esa pantalla nadie usa |
| 7 | El nombre del ZIP y el de cada entrada los escribe el **servidor**; el cliente **valida la forma** del nombre servido | Fabricar el nombre en el navegador (hora del equipo de quien descarga) |
| 8 | **Placa dentro del ZIP, nunca en el nombre del ZIP** | `soportes-ABC123.zip` — el nombre acaba en asuntos de correo (Ley 1581) |
| 9 | La descarga **no limpia la selección ni refresca** la cola | Copiar el `ejecutar()` de enviar/certificar «por simetría» |
| 10 | Se **comparten** `avisoDeError`, `AvisoVisible` y `esNombreDeExport` con la #11909, exportando y generalizando lo mínimo | Clonar `ExportarCola.tsx` — dos maquetas que se separan y nadie se entera |
| 11 | El comprobante **PSE** de la conciliación **no entra** en el ZIP de SOAT | Meterlo «ya que está en la misma consulta»: reabre una discusión de permisos cerrada (ADR-0006 §7.5) |

---

## Handoff

```
HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: docs/ux/flito-descargar-soportes-zip.md
  Pantallas: 3 (FlitoSoat, FlitoImpuestos, FlitoTramites) + 1 diálogo nuevo
  Requerimientos nuevos de datos: 3 endpoints ZIP, 2 códigos 422 (zip_sin_soportes,
             zip_demasiadas_filas), cabecera X-Soportes-Incluidos, nombres PLACA-ORGANISMO
             con desempate determinista
  Siguiente: architecture-agent / backend (endpoints, códigos, nombres, retiro de
             /flito/impuestos/facturas-venta/zip) → frontend-agent.
             Preguntas al PO: (1) caso parcial — ¿descargar lo que hay y avisar, o todo o nada?
             (Decisión 4); (2) recibo con y sin marca de agua, ¿los dos en el ZIP?;
             (3) fila sin placa — ¿`SIN-PLACA-<idFlit>`?
```
