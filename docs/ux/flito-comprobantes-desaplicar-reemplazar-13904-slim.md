# UX slim — Comprobantes: desaplicar y reemplazar un comprobante aplicado (HU #13904)

Feature #13886 · módulo FLITO `flito-comprobantes` (`/api/flito/comprobantes`), no el legacy.
Contrato: `DesaplicarComprobanteDto` / `ReemplazarComprobanteDto` y sus `Resultado*` en
`packages/shared-types/src/flito-comprobantes.ts` (HU #13903). Público: operador interno.

> **Tono: tú, no usted.** El pedido decía «usted como el resto de la pantalla». Lo revisé y la
> pantalla tutea: el subtítulo de `FlitoComprobantes` («lo asocias desde aquí»), todo
> `PanelAsociacion` («Elige el trámite…», «Escribe por qué cambias…», «Tu usuario…») y
> `DetalleComprobante` («Inténtalo más tarde»). Hasta los textos del AC5 («Corrige el pago en su
> módulo») vienen en tú. Calco el tú en la pantalla (`_principios-flito.md` §Voz). La ficha de
> Ayuda sí va en **usted** (§5).

## 1. Superficie tocada

- `DetalleComprobante.tsx`, rama de **solo lectura** con `estado === 'aplicado'`. Hoy esa ficha
  no tiene botones (UX §7.8). Esta HU le pone un pie con dos acciones. Pendiente y descartado no
  cambian.
- `FlitoComprobantes.tsx`: el toast de la página gana el ✕ y se ve **por encima** del modal.
  Además entra un aviso de saldo negativo (AC6).
- `PanelAsociacion.tsx`: solo cambia lo que pasa tras un 200 de *aplicar* (AC6).

## 2. Delta de claridad

**Qué vino a hacer el usuario:** corregir un comprobante que quedó mal aplicado. Puede quitarlo
(desaplicar) o cambiarlo por el correcto (reemplazar).

**Qué se ve primero:** lo mismo que hoy. Cabecera con chip de estado, la línea
`Comprobante de pago · {Concepto} · {idFlit} · {placa}`, el valor, el motivo y los datos leídos.
Las acciones van **al final, en un pie fijo**. El modelo es el pie de `PanelAsociacion`: la
lectura es lo primero y la corrección viene después.

```
… datos leídos (desplaza) …
───────────────────────────────────────────────
                         [Desaplicar] [Reemplazar]      ← ambos flitBtnSecondary
```

- **AC1.** Cada botón **existe** solo si se cumplen las dos condiciones: `detalle.estado === 'aplicado'` y
  `hasFuncion('comprobantes.comprobante.desaplicar' | '.reemplazar')`. Sin la función, el botón no
  existe (no se muestra deshabilitado). Si no hay ninguna de las dos funciones, no hay pie.
- **Sin primaria en la ficha.** Abrir un aplicado es casi siempre consultarlo. La primaria vive en
  cada bloque de acción, una por bloque.
- **Dos bloques, uno a la vez, dentro de la columna «Lectura».** Ninguno es un modal anidado:
  `FlitModal` ya ocupa la pantalla y un modal encima rompería el foco. Abrir un bloque oculta los
  dos botones del pie. `Esc` o «Cancelar» lo cierran y el foco vuelve al botón que lo abrió (como
  hoy con Descartar).
  - **Desaplicar** es corto y **se vuelve el pie**: el mismo patrón que «Descartar» en el panel.
  - **Reemplazar** trae una lista, así que **toma la columna**: la lista ocupa el área que
    desplaza y el motivo y los botones quedan en el pie.
- **Cuál es la primaria.**
  - En Reemplazar, el botón «Reemplazar» va en `flitBtnPrimary`: es la única primaria de esa vista
    y su resultado es un comprobante aplicado.
  - En Desaplicar, el botón «Desaplicar» va en `flitBtnSecondary` con tinta `--flit-danger-ink`.
    Es el patrón que este panel ya usa para lo destructivo («Descartar», «Descartar el anterior y
    aplicar»).
- **Validar al pulsar.** Ningún botón se apaga por validación (criterio #11915). Se valida al
  pulsar: `aria-invalid`, `<p role="alert">` y foco al primer error. Si el motivo tiene menos de 5
  caracteres, no se envía nada (AC2).
- **Densidad.** No hay columnas ni filtros nuevos en la cola. La ficha suma un pie de dos botones,
  así que la densidad queda **sin cambio**.

### 2.1 Bloque Desaplicar (pie)

```
¿A dónde va este comprobante?  *
 ( ) Volver a la cola   — Queda pendiente para asociarlo otra vez.
 ( ) Descartar          — Queda descartado y su archivo se podrá volver a cargar.
Motivo (mínimo 5 caracteres)
[____________________________]
{AYUDA_MOTIVO}
Se deshace lo que este comprobante registró en {idFlit} · {Concepto}.
                                   [Cancelar] [Desaplicar]
```

- Ninguna opción viene marcada: el AC dice «el usuario elige».
- El foco va al primer radio al abrir.
- Errores en línea:
  - Sin destino: «Elige si el comprobante vuelve a la cola o se descarta.»
  - Motivo corto: «Escribe el motivo para desaplicar (mínimo 5 caracteres).»
- Mientras envía, el botón dice «Desaplicando…».
- **Si sale bien (AC2):**
  - El detalle se repinta con `r.comprobante` (`setDetalle`, sin recargar) y la cola se refresca.
    Si el destino fue pendiente, el detalle pasa a `PanelAsociacion`. Si fue descartado, queda en
    solo lectura de descartado con su motivo.
  - El detalle **no se cierra**.
  - Toast:
    - destino pendiente: «Comprobante desaplicado de {idFlit}: volvió a la cola.»
    - destino descartado: «Comprobante desaplicado de {idFlit} y descartado.»

### 2.2 Vista Reemplazar (toma la columna)

```
Reemplazar el comprobante de {idFlit} · {Concepto}
Elige el comprobante pendiente que va en su lugar. Este quedará descartado
y el que elijas se aplicará a {idFlit} · {Concepto}.
Comprobante que va en su lugar  *                       ← fieldset/legend, radiogroup
 ( ) recibo-derechos-0412.pdf   [Coincide con {idFlit}]
     Cargado el 22 oct · Derechos · $ 95.000
 ( ) escaneo-17.jpg
     Cargado el 21 oct · Sin concepto leído · Sin valor leído
 …(desplaza)…
───────────────────────────────────────────────
Motivo del reemplazo (mínimo 5 caracteres)
[____________________________]
                                   [Cancelar] [Reemplazar]   ← primaria
```

- **Datos.** Se usa el mismo `GET ${RUTA_COMPROBANTES}?…` de la cola, filtrado a pendientes. Es
  el filtro de estado que la página ya manda; no lleva texto libre ni PII en el query, y **no hay
  endpoint nuevo**.
- **Orden de la lista.**
  - Primero los que **coinciden** con el trámite: `idFlitLeido` igual al `idFlit` del original, o
    `placaLeida` igual a su placa. Llevan el chip `StatusChip` neutral «Coincide con {idFlit}».
  - Después, el resto por fecha de carga, del más reciente al más antiguo.
- **Qué muestra cada fila:** nombre del archivo, fecha de carga, concepto leído y valor leído.
  Nada de PII.
- Si la página trae más de lo que se muestra: «Se muestran los {n} pendientes más recientes. Si no
  ves el que buscas, revisa la cola.» (ver Nota de QA 9).
- Errores en línea:
  - Sin elegir: «Elige el comprobante que va en su lugar.»
  - Motivo corto: «Escribe el motivo del reemplazo (mínimo 5 caracteres).»
- Mientras envía, el botón dice «Reemplazando…».
- **Si sale bien (AC3):**
  - El detalle se repinta con `r.original`, que ahora está descartado y muestra su motivo.
  - La cola se refresca.
  - Toast: «Comprobante reemplazado: {nombre del reemplazo} quedó aplicado a {idFlit} · {Concepto}.»

## 3. Estados (4) + copy

**Selector de reemplazo (AC3).** El motivo escrito se conserva en los cuatro estados.

| Estado | Qué se ve |
|---|---|
| Cargando | Esqueleto de 3 filas con la misma estructura (dos líneas cada una, `animate-pulse motion-reduce:animate-none`, como el esqueleto del detalle). `aria-busy` en el grupo. |
| Error | `role="alert"`: «No se pudieron cargar los comprobantes pendientes.» y el botón **Reintentar**, que relanza solo la lista. |
| Vacío | «No hay comprobantes pendientes para usar en su lugar. Carga el comprobante correcto y vuelve aquí; si solo quieres quitar este, usa Desaplicar.» Con la lista vacía **no se pintan** ni el motivo ni el botón «Reemplazar», porque no hay nada que confirmar. Solo queda «Cancelar», que devuelve el pie con «Desaplicar». |
| Lleno | La lista radio de §2.2. |

**Ficha aplicada:** sus cuatro estados no cambian.

**Bloque Desaplicar:** no carga datos, así que no tiene estado de lista.

**Errores de las dos acciones.** Se decide por `codigo`, **nunca** se muestra `err.error` crudo.

| Código / caso | Dónde va | Copy |
|---|---|---|
| `periodo_cerrado` `{bolsaId, periodo}` (AC4) | **Aviso en la ficha**: se cierra el bloque y queda `role="alert"` sobre el pie mientras el detalle siga abierto | «No se puede corregir este comprobante: su descuento cae en {octubre de 2026} de la bolsa {nombre de la bolsa}, y ese periodo ya está cerrado.» El periodo `AAAA-MM` se muestra como «mes de año». |
| `dueno_no_reversible` | Aviso en la ficha | «Este pago no se deshace desde Comprobantes. Corrige el pago en su módulo ({Concepto}).» |
| `servicio_no_reversible` | Aviso en la ficha | «Este pago se aplicó antes de que FLITO guardara el valor anterior del servicio, así que no se puede deshacer aquí. Corrige el valor en Servicios adicionales.» |
| `tramite_liquidado` | Aviso en la ficha y, si `hasPage(user, 'finanzas_reporte_costos')`, el enlace «Ir al reporte de costos» (el patrón del panel) | «La liquidación de {idFlit} está sellada. Reversa la liquidación en el reporte de costos y vuelve a intentarlo.» |
| `no_aplicado` | Aviso en la ficha con el botón **Actualizar**, que recarga el detalle y la cola | «Este comprobante ya no está aplicado: otro usuario lo desaplicó o lo reemplazó mientras lo tenías abierto.» |
| `ya_resuelto` sobre el reemplazo elegido | En la vista Reemplazar: se recarga la lista y se conservan el motivo y la vista | «El comprobante que elegiste ya no está pendiente. Elige otro.» |
| `valor_requerido` sobre el reemplazo elegido | En la vista Reemplazar, en línea | «El comprobante que elegiste no tiene valor leído. Asócialo desde la cola para escribir el valor, o elige otro.» |
| `destino_no_admite`, `ya_pagado` o `valor_ya_documentado` sobre el reemplazo | En la vista Reemplazar, en línea | «{idFlit} no admite este comprobante como pago de {Concepto}. Elige otro.» |
| 403 | En el bloque, en línea | «Tu usuario ya no puede corregir comprobantes. Vuelve a entrar para actualizar tus permisos.» |
| 404 | Aviso en la ficha con «Actualizar la cola» | «Este comprobante ya no existe.» (copy existente) |
| Red, 5xx o cualquier otro código (AC7) | En el bloque, `role="alert"`; el bloque **sigue abierto con el motivo, el destino o la selección intactos**, y el botón de confirmar pasa a decir **Reintentar** | «No se pudo desaplicar. Revisa tu conexión y vuelve a intentarlo.» / «No se pudo reemplazar. Revisa tu conexión y vuelve a intentarlo.» |

**Por qué estos avisos van en la ficha y no en un toast.** Los avisos persistentes (periodo,
dueño, servicio, liquidado, `no_aplicado`) describen un estado que sigue siendo cierto mientras
la ficha esté abierta. Los botones del pie se mantienen.

## 4. Toast vs aviso

| Qué | Patrón |
|---|---|
| Desaplicado o reemplazado (200) | **Toast** de una frase con ✕, **visible por encima del modal**. Hoy la región `role="status"` de la página queda tapada por `FlitModal` y no tiene ✕. Se usa la misma región y la misma duración (8 s), con capa sobre el modal y el botón ✕ `aria-label="Cerrar aviso"`. |
| Errores de código persistentes (tabla §3) | Aviso en la ficha (`role="alert"`). |
| Validación, red o 5xx | En línea dentro del bloque. |
| **Saldo negativo (AC6, D4)** | Solo cuando la respuesta 200 de **aplicar** trae `comprobante.bolsa.alertas[]` no vacío. En el panel eso ocurre al cerrar tras `onResuelto`. Decisión: también aplica a la respuesta de **reemplazar**, porque ese camino *es* aplicar; si el PO lo quiere solo en aplicar, se quita. Va como **aviso en la página de la cola** (`role="status"`, cerrable con ✕), bajo la cabecera, **además** del toast de aplicado, porque son dos hechos distintos. No bloquea nada y desaparece al cerrarlo o en la siguiente acción. El GET del detalle no lo trae y la ficha no lo vuelve a pintar. |

Copy del saldo negativo, una línea por bolsa:
«La bolsa {nombre} quedó en saldo negativo: {−$ 120.000}. El comprobante se aplicó igual.»

**Requerimiento de datos (backend/architecture).** El AC4 y el AC6 piden **nombrar la bolsa**,
pero el contrato solo trae `bolsaId` (en el 409 y en `alertas[]`) y no un nombre que se pueda
mostrar. Hay que añadir `bolsaNombre` en los dos sitios. Mientras falte, el frontend **no debe
mostrar el uuid**: el fallback es «la bolsa del cliente» o la etiqueta de `alcance`. El fallback
no cumple el AC tal como está escrito.

## 5. Responsive y feedback

- **Móvil (<`lg`).**
  - El modal ya apila: visor arriba con `max-h-[45vh]` y «Lectura» debajo.
  - El pie usa `flex-wrap`; en 360 px los botones caen a una línea propia, alineados a la derecha.
  - Los radios del destino se apilan.
  - Cada fila del selector envuelve: nombre del archivo en una línea (con `break-words`) y el chip
    debajo.
  - La lista desplaza dentro de la columna, nunca la página.
- **Feedback.**
  - Botones: hover y `flit-focus` del kit (`flitBtnPrimary` / `flitBtnSecondary`).
  - Fila del selector: toda la fila es `<label>` clicable, con hover `--flit-bg-hover`; la
    seleccionada lleva velo `--flit-bg-app` y borde `--flit-border-input`; el radio usa
    `flit-focus`. Todo con tokens que tienen par oscuro.
  - ✕ del toast y del aviso: hover sutil y foco visible.
  - Sin animaciones nuevas.
- **A11y.**
  - Fieldset con legend en el destino y en el selector (`radiogroup`).
  - Cada textarea con su `<label>` y `aria-describedby` (ayuda y error).
  - Foco al abrir: primer radio. Al cerrar: el botón que abrió el bloque.
  - Tras un 200, el foco va al título de la ficha repintada.
  - El esqueleto va `aria-hidden` y el grupo `aria-busy`.

## 6. Permiso y slug

- La página y su slug no cambian.
- Funciones nuevas: `comprobantes.comprobante.desaplicar` y `comprobantes.comprobante.reemplazar`.
  El frontend debe confirmar que existen en el árbol de permisos de shared-types; si faltan, es un
  requerimiento para la HU de backend.
- El selector usa la lectura de la cola que ya tiene quien abre la página.
- Roles: los de `USER_ROLES` que tengan esas funciones. No se diseña nada para el rol `operaciones`.

## 7. Delta de la ficha de ayuda (`apps/web/src/content/ayuda/flito_comprobantes.md`, en usted)

La ficha existe y **contradice** esta HU. Ese delta es la entrada de la skill `flit-ayuda-flito`.

- **Quitar** de «Qué no hace» la línea «No deshace una aplicación: un comprobante aplicado se ve
  en solo lectura.»
- **Añadir** una sección después de «Asociar y aplicar»:

```markdown
## Corregir un comprobante aplicado

Si un comprobante quedó aplicado al trámite o con el concepto equivocado, ábralo con **Ver**:

1. **Desaplicar**: elija si vuelve a la cola (para asociarlo otra vez) o se descarta, escriba el
   motivo (mínimo 5 caracteres) y confirme. Se deshace lo que el comprobante registró en el trámite.
2. **Reemplazar**: elija el comprobante pendiente que va en su lugar y escriba el motivo. El
   original queda descartado y el nuevo se aplica al mismo trámite y concepto. Si no hay
   pendientes, cargue primero el comprobante correcto.

No siempre se puede corregir aquí: si el descuento cae en un periodo cerrado de la bolsa, si el
pago se corrige en su propio módulo, si el trámite ya está liquidado o si es un pago de servicios
adicionales que se corrige en **Servicios adicionales**, FLITO se lo explica y no cambia nada.
```

- En «Estados» no hace falta nada: los chips no cambian.
- Si la ficha tiene un diagrama del camino, sería deseable añadir la flecha
  «aplicado → pendiente / descartado». Es opcional y no bloquea.

## 8. Notas para QA (≤10)

1. Sin la función, el botón **no existe en el DOM**. Se comprueba con una sola función y luego
   con la otra.
2. En pendiente y en descartado no aparece ni Desaplicar ni Reemplazar.
3. Desaplicar con el motivo de 4 caracteres: no sale ninguna petición y aparece el error en línea
   con foco. Lo mismo si no se elige destino.
4. Tras un 200, el detalle sigue abierto y repintado (pendiente → panel de asociación;
   descartado → solo lectura). El toast se ve encima del modal y se cierra con ✕.
5. Reemplazar con cero pendientes: aparece el vacío y no se pintan ni el motivo ni el botón
   «Reemplazar».
6. El 409 `periodo_cerrado` muestra el periodo como «mes de año» y el nombre de la bolsa, nunca
   el uuid ni `AAAA-MM`.
7. Cada código del AC5 muestra su copy. Ningún aviso contiene `err.error`, el código ni el JSON.
8. Si la red falla (offline), el motivo, el destino o la selección siguen ahí y «Reintentar»
   reenvía lo mismo.
9. El saldo negativo aparece tras *aplicar* con `bolsa.alertas` y no reaparece al volver a abrir
   el detalle. Limitación: la lista solo trae la primera página de pendientes; si el reemplazo
   esperado no aparece, no es un fallo de esta HU (Nota).
10. Revisar la ficha y el bloque en 375 px y en tema oscuro (tokens, no `red-600`).
