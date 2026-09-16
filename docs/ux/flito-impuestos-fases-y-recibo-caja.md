# UX slim — Impuestos: fase del recibo, chip/filtro de liquidados y recibo de caja (HU #12592)

Feature #12589 · Épica #12585. Público: operador interno (Operaciones/admin y gestor de impuestos). Tono de la pantalla: **tú** («Sube varios PDF…», «Sincroniza desde el Tablero»); se calca.
Endpoints ya expuestos (tip 3bd19dba): `POST /flito/impuestos/recibos` (campo `fase`), resumen con `liquidados`, filas con `liquidadoEn` + `documentos` (`'liquidacion'|'pago'|'ambos'|null`), query `liquidadoPendientePago=true`, `POST /flito/impuestos/:id/recibo-caja` → `ResultadoReciboCaja` / `{error, codigo}`.

## Superficie tocada

`apps/web/src/pages/FlitoImpuestos.tsx`, cuatro sitios; ninguna ruta, slug ni columna nueva.

| Sitio | Se quita | Se añade |
|---|---|---|
| Modal `CargaRecibos` (L936-996) | Checkbox «Archivos sueltos sin marca de agua (en ZIP se deduce por carpeta)» y la frase «los que cuadran pasan a Pagado» del párrafo intro | Selector **Fase del recibo** (Pago por defecto) + ayuda del ZIP; chip «Liquidados» en el resumen y fila «Liquidado» en `TablaResultadoOcr` |
| Barra de filtros (L421-428) | — | Checkbox «Liquidado, pendiente de pago» junto a «Solo sin gestión»; entra en `hayFiltros`, `limpiarFiltros`, `filtrosExport` y el reset de página |
| Tabla, celda Estado (L527-533) | — | Chip de documentos en la pila existente (solo si `documentos !== null`) |
| `DetalleImpuesto` (L794-827) | — | Chip de documentos en la fila de chips; `Dato «Liquidado el»`; botón «Cargar recibo de caja» junto a «Ver soporte»; modal `ReciboCaja` |

## Delta de claridad (qué se ve / qué se calla)

- Quien abre la cola viene a **saber qué le falta a cada impuesto en gestión**: ahora la pila de Estado dice «Liquidación» (falta el pago), «Pago» o «Ambos». La fecha de liquidación **se calla** en la tabla (va en `title` del chip y como dato del detalle); no se añade columna. Densidad: sin columnas nuevas, +1 chip en una pila que ya existe → **sin cambio**.
- Quien abre el modal masivo viene a **declarar qué está subiendo**. La fase deja de ser una casilla negativa («sin marca de agua») y pasa a ser la pregunta directa. Sin promesa de detección automática: la carpeta del ZIP manda y lo demás lo decide el operador.
- Quien abre el detalle de un Solicitado con liquidación viene a **cerrar el pago en ventanilla**: el botón está al lado de la evidencia («Ver soporte»), no en la fila de acciones de gestión (Rechazar/Asumir/Reversar), que son otra visita.
- Primaria: la de la página sigue siendo «Cargar recibos (masivo)». Dentro de cada modal hay una sola: «Subir y procesar» / «Cargar» / «Listo». «Cargar recibo de caja» en el detalle es **secundario** (`flitBtnSecondary`), como el resto de acciones del detalle.

## Forma de cada pieza

**Selector de fase — radios nativos en `fieldset`, no `<select>`.** Dos opciones fijas, siempre visibles, sin abrir nada; flechas cambian de valor en un solo paso y el lector anuncia «Fase del recibo, Pago, 2 de 2». Un select esconde la opción elegida y exige dos teclas. Mismo aspecto de línea que la casilla que reemplaza (texto `text-sm`, color secundario).
```
Fase del recibo   ( ) Liquidación   (•) Pago
                  ⓘ En un ZIP manda la carpeta de cada recibo («sin marca» → Liquidación; «con marca» o «pagado» → Pago). La fase elegida aplica a los recibos sueltos y a las entradas del ZIP sin carpeta reconocible.
```
La ayuda del ZIP va **siempre** bajo el selector (la regla aplica antes de elegir el archivo), en `text-xs` secundario, sin icono decorativo (el ⓘ del esquema es solo notación). Párrafo intro queda: «Sube varios PDF/imágenes o un ZIP. FLITO abre el ZIP en tu computador y sube sus recibos de 5 en 5, conservando la carpeta de cada uno. El OCR cruza cada recibo con su impuesto en gestión por la placa. En fase Liquidación deja el impuesto liquidado (valor y fecha) sin pagarlo; en fase Pago, los que cuadran pasan a Pagado y el resto va a revisión.»

**Resumen de carga.** Chip nuevo primero: `<StatusChip tone="active">Liquidados N</StatusChip>`, luego los cinco existentes sin cambio. En la tabla, fila «Liquidado» tono `active`. Acumula por tandas igual que las otras cinco claves (`enviarCargaEnTandas` debe sumar `liquidados`).

**Chip por fila — reuso de `StatusChip`, texto manda.** `liquidacion` → «Liquidación» `active` (el único azul de la pila: es el que dice «falta pagar»); `pago` → «Pago» `success`; `ambos` → «Ambos» `success`; `null` → nada. `title="Liquidado el 12/09/2026, 10:15"` solo cuando `liquidadoEn` no es null. En el detalle, el mismo chip en la fila de chips y `Dato k="Liquidado el" v={fecha(imp.liquidadoEn)}` a continuación de «Valor liquidado» (muestra «—» si no hay).

**Filtro.** Casilla «Liquidado, pendiente de pago» (`liquidadoPendientePago`) a la derecha de «Solo sin gestión». Combinable; el servidor ya restringe a `solicitado AND liquidado_en IS NOT NULL`, así que con la píldora «Pagado» devuelve vacío — es correcto y el vacío lo explica. El total de `Paginacion` («N impuestos») es el contador que refleja el filtro; no hay contador de filtros activos en esta pantalla.

**Botón deshabilitado con motivo — texto visible + `aria-describedby`, sin `title`.** `title` no se ve con teclado ni táctil y duplicaría el texto. Se usa `aria-disabled="true"` (no `disabled`) para que siga siendo alcanzable con Tab y el motivo se lea.
```
SOPORTE
Ver soporte   [Cargar recibo de caja]
              Primero carga la liquidación del impuesto.     ← solo si liquidadoEn es null
```
Se pinta solo si `hasFuncion('impuestos.recibos.cargar_caja') && imp.estado === 'solicitado'`; en cualquier otro estado o sin la función, no se pinta (no gris). `esGestor` no la tiene hoy (inventario: `admin`), así que el gestor no ve el botón.

## Modal «Recibo de caja · ABC123» (`FlitModal`, sin `wide`) — 4 estados

```
Placa ABC123 · Organismo Secretaría de Movilidad de Bogotá · Valor liquidado $ 412.300
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
   Recibo de caja                       ← FlitUploadBox, accept .pdf,.png,.jpg,.jpeg
   PDF, JPG o PNG · máximo 15 MB
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
recibo-caja-abc123.pdf · 1,2 MB                  ← nombre y tamaño del elegido
[Cargar]  [Cancelar]
```
1. **Inicial.** «Cargar» deshabilitado hasta elegir archivo. Validación local antes de enviar (tipo y ≤ 15 MB) con el mismo copy de `archivo_invalido`. Escape, Cancelar y la X cierran.
2. **Cargando.** Caja en `uploading`, «Cargar» → «Cargando…» y Cancelar deshabilitados; `aria-busy` en el cuerpo. Escape y X **no cierran** durante la petición (no se puede abortar y cerrar escondería el desenlace).
3. **Resultado.** Reemplaza el cuerpo; una sola acción «Listo» (primaria).
   - `pagado`: `StatusChip success` «Pagado» · «Valor pagado $ 412.300 · Fecha de pago 15/09/2026». Si `marcadoPorDiferencia`: `StatusChip warning` «Diferencia de valor» + «El valor pagado difiere del liquidado por encima de la tolerancia. Queda marcado para revisión.» «Listo» → cierra modal y llama `onCambio` (cierra detalle, refresca cola: la fila ya no es Solicitado).
   - `en_revision`: `StatusChip warning` «En revisión» · «El recibo quedó guardado. La lectura no fue concluyente y pasó a la cola de revisión; el impuesto sigue Solicitado.» «Listo» → cierra modal, refresca cola sin cerrar el detalle (`onTraspaso`), el chip pasa a «Ambos».
4. **Error.** `role="alert"`, texto por `codigo` y la acción que corresponde (nunca solo «Ocurrió un problema»):

| `codigo` / caso | Copy | Acción |
|---|---|---|
| 409 `sin_liquidacion` | Este impuesto no tiene liquidación cargada. Súbela primero desde «Cargar recibos (masivo)» con la fase Liquidación. | Cerrar |
| 409 `estado_no_permitido` | El impuesto ya no está en gestión. Cierra y revisa su estado en la cola. | Cerrar (+ refrescar cola) |
| 409 `duplicado` | Ese archivo ya está registrado como recibo. Elige otro archivo. | Elegir otro (vuelve a inicial sin archivo) |
| 400 `archivo_invalido` (o validación local) | El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo. | Elegir otro |
| 404 `no_encontrado` | Este impuesto no está disponible para tu usuario. | Cerrar |
| 403 | Tu usuario no tiene la función para cargar recibos de caja. Pídela al administrador. | Cerrar |
| 503 | El lector de recibos no respondió. No se guardó nada; reintenta en unos minutos. | Reintentar (mismo archivo) |
| Sin respuesta / otro | No se pudo completar la carga. Revisa tu conexión y reintenta. | Reintentar |

Sin `codigo` en el cuerpo se cae al último caso (mismo criterio que `aResultadoIntento`).

## Foco y teclado

- Escape lo gestiona `FlitModal` (solo el de más arriba: cierra el recibo de caja, no el detalle). En «cargando» el `onClose` es no-op.
- Al cerrar en inicial, `en_revision` o error, el foco vuelve al botón «Cargar recibo de caja» (restauración de `useFocusTrap`; el botón sigue en el DOM).
- Al cerrar tras `pagado` el botón desaparece (estado ≠ solicitado) y el detalle se cierra: `restoreFocusRef` al encabezado de la tabla (`tabIndex={-1}`), como en comparendos (HU #11562).
- Radios: `fieldset` + `legend` «Fase del recibo»; Tab entra una vez, flechas eligen. Casilla del filtro: `label` envolvente como «Solo sin gestión».
- Botón con motivo: `aria-disabled` + `aria-describedby` al `<p>` del motivo; Enter/clic no hacen nada.

## Copy exacto (resumen)

Selector: «Fase del recibo» · «Liquidación» · «Pago». Resumen: «Liquidados N» / fila «Liquidado». Chip fila: «Liquidación» · «Pago» · «Ambos»; title «Liquidado el {fecha}». Detalle: «Liquidado el». Filtro: «Liquidado, pendiente de pago». Botón: «Cargar recibo de caja»; motivo: «Primero carga la liquidación del impuesto.» Modal: título «Recibo de caja · {placa|vin}», caja «Recibo de caja» / «PDF, JPG o PNG · máximo 15 MB», botones «Cargar» · «Cancelar» · «Listo» · «Reintentar» · «Elegir otro» · «Cerrar».
Vacío del filtro (sustituye a «Ningún impuesto coincide con los filtros.» cuando la casilla está marcada): «Ningún impuesto liquidado está pendiente de pago con estos filtros. Quita el filtro o carga liquidaciones desde «Cargar recibos (masivo)».» + botón «Limpiar filtros» ya existente.

## Permiso/slug

Página `impuestos` sin cambio. Función nueva ya sembrada: `impuestos.recibos.cargar_caja` (migración 0197, hoy `admin`). Carga masiva y filtro: funciones existentes (`impuestos.recibos.cargar`, `impuestos.cola.ver`).

## Notas para QA

1. Selector por defecto en «Pago»; el form envía `fase=pago|liquidacion` y ya no `sinMarcaDeAgua`.
2. ZIP con carpeta «SIN MARCA/» y selector en Pago → esas entradas quedan liquidadas (carpeta manda); entradas sin carpeta siguen el selector.
3. Resumen con dos tandas: «Liquidados» suma ambas; el resto no retrocede.
4. Fila `documentos: 'liquidacion'` → chip azul con texto; `null` → sin chip; `title` solo si hay `liquidadoEn`.
5. Filtro + píldora «Pagado» → vacío específico con «Limpiar filtros»; «Limpiar filtros» desmarca la casilla; el total de paginación baja al marcarla.
6. Detalle Solicitado sin liquidación → botón alcanzable con Tab, `aria-disabled`, motivo leído; con liquidación → habilitado. Estado Pagado/Pendiente/Con novedad o usuario gestor → no existe el botón.
7. Modal: archivo de 16 MB o .docx → copy `archivo_invalido` sin llamada al API.
8. Respuestas 409 ×3, 400, 403, 404, 503 y red → mensaje y acción de la tabla; 503 conserva el archivo elegido para «Reintentar».
9. `pagado` con `marcadoPorDiferencia` → dos chips y aviso; «Listo» cierra modal y detalle y la fila sale de «Solicitado».
10. Escape con el modal de recibo abierto cierra solo ese modal; durante «Cargando…» no cierra; foco vuelve al botón (o al encabezado de tabla tras `pagado`).

## Decisiones y descartes

- Radios y no select: dos valores, ambos visibles, un solo gesto. Tampoco `FlitPillGroup`: son botones, no un grupo de radio, y ya significan «vista de la cola».
- Chip en la pila de Estado y no columna nueva: la tabla ya tiene 13 columnas; la fecha va al `title` y al detalle.
- Motivo como texto visible sin `title`: el AC exige «visible»; `title` ni se ve con teclado ni suma nada.
- Modal propio y no reutilizar `CargaRecibos`: un archivo, un impuesto, un veredicto; la masiva es otra visita (tandas, ZIP, tabla de resultados).
- Sin animación de progreso ni ilustración de éxito: caja `uploading` + botón «Cargando…» y chips del kit.
