# UX slim — Solicitud «Por validar» cuando el RUNT no responde (Feature #12841)

Épica #12616 · módulo **`flito-soat`**, canal Cliente (`/api/flito/soat/cliente/*`) y cola `/flito/soat`.
Modo **slim**: se extienden dos pantallas que ya existen y se reutiliza el kit. No hay ruta ni `PageSlug` nuevos.

| Superficie | Archivo | Qué cambia |
|---|---|---|
| A · Formulario de solicitud | `apps/web/src/pages/FlitoSoatSolicitud.tsx` (bloque 1 + barra de envío) | Con un 503 `runt_no_disponible`, la solicitud se puede **guardar pendiente de validar**. Tras guardar se muestra una **tarjeta de confirmación** |
| B · Cola SOAT | `FlitoSoat.tsx`, `components/flito/soat/TablaColaSoat.tsx`, `ChipEstadoSoat.tsx`, `tipos.ts` | Dos estados nuevos («Por validar» y «Descartada»), sus pastillas, la acción de fila **Reintentar consulta** y un toast por desenlace |
| C · Detalle (`DetalleSoat`) | `components/flito/soat/DetalleSoat.tsx` | La incompleta explica qué datos faltan. La descartada dice cuándo, por qué y quién la descartó |

**Fuera de alcance, como dice el pedido:** alertas por color, continuar el flujo normal sin RUNT y reintento automático. No se toca el bloque 2 (factura), el bloque 3 (propietario), la carga masiva ni la barra de selección.

---

## 1. Delta de claridad

**Qué vino a hacer cada quien:**
- **En A:** el Cliente vino a pedir el SOAT. Si el RUNT está caído, necesita saber que **lo que digitó no se perdió** y qué pasa ahora.
- **En B:** quien tiene el permiso vino a ver qué solicitudes siguen esperando al RUNT y a reintentarlas.

**Qué se ve primero:**
- **A:** la banda del bloque 1, ya existente y con tono `warning`, gana **una frase** que abre la salida. Después de guardar, la tarjeta de confirmación **reemplaza el formulario**.
- **B:** en la columna Estado, que ya es la 2.ª, el chip «Por validar» con icono. En la última celda, el botón «Reintentar consulta» junto a «Ver».

**Qué se calla:**
- En la fila **no** van el número de intentos, el código del RUNT ni la hora exacta del fallo. El último intento va en una línea tenue bajo el chip y el historial va al detalle.
- La ficha del vehículo no se pinta con seis «—». Se pinta **una frase** que dice qué falta y por qué (§5).
- Las descartadas **no** aparecen en «Todos». Tienen su pastilla al final (P-3).

**Densidad:**
- **Tabla:** sin cambio, porque no se añade ninguna columna. El chip entra en la columna Estado y el botón en la celda de acciones, que hoy tiene «Ver» y a veces el comprobante. Una fila «Por validar» **no tiene comprobante**, así que la celda nunca lleva tres botones.
- **Pastillas:** empeora en +2 (de 5 a 7 con «Todos»). Se acepta porque son estados con trabajo propio, y la barra ya envuelve. Si David prefiere 6, «Descartadas» sale a un filtro del panel de filtros (P-3).

**Primaria única:**
- **B:** la cola sigue igual. «Solicitar SOAT» para el Cliente y «Cargar facturas (masivo)» para Operaciones. «Reintentar consulta» es **secundaria de fila** (`flitBtnSecondarySm`).
- **A:** el peso cambia **una sola vez**. Mientras falten datos, «Volver a consultar» (renglón del VIN) sigue siendo la primaria. Cuando el formulario está completo con el RUNT caído, la primaria pasa a la barra con el rótulo «Guardar pendiente de validar» y «Volver a consultar» baja a secundaria. Es el mismo relevo que hoy ocurre cuando la consulta sale bien.
- **Tarjeta de confirmación:** «Ir a mis SOAT» es la primaria y «Solicitar otro SOAT» la secundaria.

---

## 2. Superficie A — el formulario con el RUNT caído (CF-01)

### 2.1 Banda del bloque 1 (503 `runt_no_disponible`, en la consulta)

Mismo sitio, tono y foco que hoy (foco en «Volver a consultar»). Cambia la frase de detalle:

```
┌ bg-app · border-soft ─────────────────────────────────────────────────────────────┐
│ (●CircleAlert warning)  El RUNT no está respondiendo en este momento.              │  título text-primary
│                         Puede volver a consultar, o completar la factura y el      │  text-secondary
│                         propietario y guardar la solicitud pendiente de validar.   │
│                         Lo que escriba no se pierde.                               │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- La salida **solo se abre con `runt_no_disponible`**. `DESENLACE_SIN_RED` (no llegamos a FLITO) y `GENERICO` no cambian: si FLITO no responde, tampoco podría guardar nada.
- `runt_no_cuadra` y `runt_sin_registro` **no** abren la salida. Son respuestas del RUNT, no silencio.

### 2.2 Barra de envío en «modo RUNT caído»

| Situación | Botón de la barra | Frase de la barra (`frasePendientes`) |
|---|---|---|
| Faltan datos | `aria-disabled`, rótulo **«Guardar pendiente de validar»** | La de hoy, con los campos que faltan |
| Todo completo | **Primario activo**, «Guardar pendiente de validar» (icono `Save`) | «El RUNT no respondió: la solicitud quedará pendiente de validar y se consultará de nuevo antes de enviarla al gestor.» |
| Guardando | `disabled`, `Loader2` + «Guardando…» | — |

- Si el Cliente vuelve a consultar y el RUNT responde, todo vuelve al flujo normal: «Enviar al gestor», ficha, tarjeta «SOAT activo» si aplica.
- Si **edita el VIN**, la consulta pasa a `invalidada` como hoy y la salida se cierra hasta volver a consultar. El 503 era de **otro** VIN.
- **Requisito de API R1:** el alta vuelve a consultar el RUNT en el servidor. Si ahora responde, sigue el flujo normal (toast «enviada» de hoy). Si sigue caído, guarda la incompleta y lo dice en la respuesta. La pantalla **no decide** el desenlace, solo lo lee.
- Si el RUNT se cae **entre la consulta OK y el envío**, el alta devuelve el mismo desenlace «incompleta» y se muestra la tarjeta 2.3. Hoy ese caso tumba la consulta y hace resubir el PDF. Con esto deja de pasar.

### 2.3 Tarjeta de confirmación (sustituye al formulario)

Es un **aviso de página** y no un toast: es un estado que sigue siendo cierto y lo más importante de la visita. Un toast de 4 s mientras se navega se pierde, y el Cliente creería que se envió al gestor.

```
┌ FlitCard · role="status" ─────────────────────────────────────────────────────────┐
│ (●ShieldQuestion warning)  Su solicitud quedó guardada, pendiente de validar       │ h2, tabIndex -1, recibe el foco
│                                                                                    │
│ El RUNT no respondió, así que todavía no la enviamos al gestor. Guardamos el VIN,  │
│ la factura y los datos del propietario: no tiene que volver a escribirlos.         │
│ Cuando el RUNT responda, la consulta se repite desde «Mis SOAT» con                │
│ «Reintentar consulta».                                                             │
│                                                                                    │
│ VIN  9FKRG2222T2042405  (mono)                                                     │
│                                                                                    │
│                       [ Solicitar otro SOAT ]   [ Ir a mis SOAT ▸ ]                │ secundaria · PRIMARIA
└────────────────────────────────────────────────────────────────────────────────────┘
```

- La última frase del cuerpo se ramifica según el permiso:
  - **Con el permiso de reintentar:** «…desde «Mis SOAT» con «Reintentar consulta».».
  - **Sin él:** «FLITO volverá a consultar el RUNT y usted verá el cambio de estado en «Mis SOAT».».
- «Ir a mis SOAT» navega a la cola con la pastilla **«Por validar»** ya aplicada (estado de router, **no** query: el VIN nunca va en la URL).
- «Solicitar otro SOAT» limpia el formulario entero (es otra solicitud) y enfoca el VIN.
- La tarjeta **no** vuelve atrás: el registro ya existe. «Volver a mis SOAT» del encabezado sigue funcionando y ya no pide confirmación de salida (`hayDatos` = falso tras guardar).

---

## 3. Superficie B — la cola

### 3.1 Estados y marca en la tabla (CF-03)

| Estado (API) | Rótulo visible (P-1) | Tono `StatusChip` | Icono lucide | Línea tenue bajo el chip |
|---|---|---|---|---|
| `incompleta` | **Por validar** | `warning` | `ShieldQuestion` | «Último intento: {fecha corta}» (`--flit-text-muted`, `text-[11px]`) |
| `descartada` | **Descartada** | `draft` (neutro) | `CircleSlash` | — (el motivo va al detalle) |

- La marca **no depende del color**: el texto del chip, el icono y, en la incompleta, la línea del último intento. Con los estilos apagados se lee igual.
- **Celda del vehículo de una incompleta:** placa, marca y línea llegan `null`. `CeldaVehiculoSoat` pinta el **VIN** como identificador (mono) y una sola línea tenue: «Datos del RUNT pendientes». **No** «—» en tres líneas.

```
┌──────────────────────┬───────────────────────────┬────────────┬────────┬──────────────────────────────────┐
│ 9FKRG2222T2042405    │ [⛨? Por validar]          │ —          │ —      │ [↻ Reintentar consulta] [Ver ▸]  │
│ Datos del RUNT       │ Último intento: 28/09 9:14│            │        │                                  │
│ pendientes           │                           │            │        │                                  │
├──────────────────────┼───────────────────────────┼────────────┼────────┼──────────────────────────────────┤
│ 9BWZZZ377VT004251    │ [⊘ Descartada]            │ —          │ —      │                          [Ver ▸] │
└──────────────────────┴───────────────────────────┴────────────┴────────┴──────────────────────────────────┘
```

Solicitado y Pagado muestran «—» (la incompleta no se ha enviado) y la `AntiguedadPill` no se pinta. Casillas de selección: una incompleta **no es seleccionable** para el envío masivo, porque no tiene RUNT resuelto.

### 3.2 Pastillas y filtro por defecto

- **Cliente:** `Por validar · Pendiente · Solicitado · Con novedad · Pagado · Descartadas` (más «Todos», que es el defecto de hoy). «Por validar» va primero porque es la única que puede tener trabajo de su lado.
- **Admin:** el mismo orden. **Gestor:** sin cambios, porque las incompletas nunca le llegan.
- **«Todos» excluye las descartadas (P-3).** Solo se ven con su pastilla. Una descartada es un cierre, no un pendiente, y nunca se borra: sigue ahí y se puede consultar.
- La pastilla «Por validar» **no** lleva contador nuevo. Si las pastillas ya muestran conteos, sigue ese patrón; si no, no se inventa.

### 3.3 «Reintentar consulta» (CF-04, CF-05, CF-06, CF-07)

**Dónde vive:** en la **fila**, porque así lo pide el CF-03, y en el **detalle**, donde es la acción principal del modal cuando la solicitud está `incompleta`. Solo se pinta con el permiso (§6). Sin permiso **no se pinta**: no se deja deshabilitado.

| Fase | Fila | Detalle |
|---|---|---|
| Reposo | `flitBtnSecondarySm` · `RotateCw` + «Reintentar consulta» | Primaria del modal, `RotateCw` + «Reintentar consulta» |
| En vuelo | `disabled` + `aria-busy`, `Loader2` (`motion-reduce:animate-none`) + «Consultando…». **Solo esa fila**: el resto de la cola sigue operable | Igual, y el modal no se puede cerrar con la consulta en vuelo: el ✕ queda `disabled` (puede tardar hasta un minuto) |
| Resuelto | Se refresca la cola y se emite **un** toast (tabla de abajo). El foco vuelve al botón «Ver» de esa fila, o a las pastillas si la fila salió de la vista | El modal se refresca en su sitio con el nuevo estado. Mismo toast |

**Desenlaces: toast cerrable, una frase.** El copy es **impersonal** a propósito: la cola tutea a Operaciones y trata de usted al Cliente, y así una sola cadena sirve a los dos.

| Desenlace | Toast | Copy literal |
|---|---|---|
| CF-05 OK, sin SOAT próximo a vencer | `toastOk` (~4 s) | «El RUNT respondió: la solicitud del VIN …{últimos 4} pasó a Solicitado.» |
| CF-05 OK, con `vigenciaProxima` | `toastOk` (~4 s) | «El RUNT respondió: la solicitud pasó a Solicitado. El SOAT actual vence el {14 de octubre de 2026}.» Si el detalle está abierto, pinta además la `TarjetaSoatActivo` variante **aviso** (la de la HU #12844, sin cambios) sobre sus datos |
| CF-06 SOAT vigente que bloquea | `toastError` (hasta cerrarlo, ≥ 6 s) | «La solicitud quedó descartada: el vehículo ya tiene SOAT activo hasta el {14 de marzo de 2027}. Puede verla en «Descartadas».» |
| CF-06 VIN inexistente | `toastError` | «La solicitud quedó descartada: el RUNT no tiene registrado ese VIN. Puede verla en «Descartadas».» |
| CF-07 RUNT sigue caído | `toastError` con tono de aviso si el kit lo tiene; si no, `toastError` | «El RUNT sigue sin responder. La solicitud se conserva por validar; intente más tarde.» |
| Sin red / fallo desconocido | `toastError` | «No pudimos reintentar la consulta. Revise su conexión e intente de nuevo.» (Operaciones: «Revisa tu conexión…» — única cadena que se ramifica) |
| Otro ya la resolvió (conflicto) | `toastError` | «Esta solicitud ya había cambiado de estado. La lista se actualizó.» |

- En los toasts **nunca** va el mensaje crudo del API, el código del RUNT, el nombre del propietario ni el VIN completo. De la matrícula solo van los **4 últimos** caracteres del VIN, porque la incompleta no tiene placa.
- **¿Por qué toast y no aviso de página?** El resultado persistente ya lo muestra la fila, que cambia de chip. El toast solo dice qué acaba de pasar, y es uno por acción.

---

## 4. Estados (4) de lo nuevo + copy

| Superficie | Cargando | Error (+ reintento) | Vacío (+ siguiente paso) | Lleno |
|---|---|---|---|---|
| Cola, pastilla «Por validar» | `PageContentSkeleton` de hoy | Tarjeta de error de hoy, con «Reintentar» (sin cambio) | «No hay solicitudes por validar. Cuando el RUNT no responde al pedir un SOAT, la solicitud queda aquí para volver a consultarla.» | Filas con chip «Por validar» y, con permiso, el botón de reintento |
| Cola, pastilla «Descartadas» | Igual | Igual | «No hay solicitudes descartadas. Aquí quedan, sin borrarse, las que el RUNT no dejó continuar.» | Filas con chip «Descartada» y «Ver» |
| Reintento (acción de fila y de detalle) | Botón en vuelo (§3.3) | Toasts de §3.3. El botón vuelve a reposo y **es** el reintento | — | Toast de éxito + fila actualizada |
| Formulario, modo RUNT caído | «Guardando…» en la barra | Si el alta falla por otra causa, se usa el `encajarFallo` de hoy (sin cambio). Envío incierto: la tarjeta de hoy | — | Tarjeta de confirmación 2.3 |
| Detalle de una incompleta o descartada | Sin estado propio: se pinta con la fila, como hoy | Toasts del reintento | Datos del vehículo pendientes: frase §5, no «—» | §5 |

El vacío de una pastilla **con búsqueda o filtros** sigue diciendo el texto de hoy («Ningún SOAT coincide con los filtros.» + «Quite algún filtro…»).

---

## 5. Detalle (`DetalleSoat`) — incompleta y descartada

**Incompleta.** En lugar de la rejilla de datos del vehículo:

```
┌ bg-app · border-soft ─────────────────────────────────────────────────────────────┐
│ (●ShieldQuestion warning)  Pendiente de validar con el RUNT                        │ h3
│ La placa, la marca, la línea y la ficha técnica las trae el RUNT. Aparecerán aquí  │
│ cuando la consulta responda.                                                       │
│ Último intento: 28 de septiembre de 2026, 9:14 a. m.                               │
│                                              [ ↻ Reintentar consulta ]  (primaria) │ solo con permiso
└────────────────────────────────────────────────────────────────────────────────────┘
VIN · Compañía · Propietario (lo que ya muestra hoy) · Factura («Ver soporte»)
```

Lo digitado (VIN, propietario y factura) se muestra como hoy, porque es la prueba de que no se perdió nada. **Sin permiso** no se pinta el botón, y la frase final pasa a ser «FLITO volverá a consultar el RUNT.»

**Descartada** (CF-06: quién, cuándo, por qué):

```
┌ bg-app · border-soft ─────────────────────────────────────────────────────────────┐
│ (●CircleSlash neutro)  Solicitud descartada                                        │
│ Motivo    El vehículo ya tenía SOAT activo hasta el 14 de marzo de 2027.            │ o: «El RUNT no tiene registrado ese VIN.»
│ Cuándo    28 de septiembre de 2026, 9:20 a. m.                                     │
│ Quién     Laura Gómez                                                              │ ver P-4 para el Cliente
│ La solicitud no se borra: queda aquí como constancia.                              │
└────────────────────────────────────────────────────────────────────────────────────┘
```

La descartada **no tiene acción**. Si el VIN estaba mal, el siguiente paso es «Solicitar SOAT» de nuevo, desde la cabecera de la cola.

---

## 6. Permiso / slug

- **Sin `PageSlug` nuevo.** Sigue la página `soat` (cola) y la ruta `/flito/soat/solicitud`.
- **Función nueva (R0, requisito para architecture):** una función del catálogo para reintentar, por ejemplo `soat.solicitud.reintentar_runt`. El nombre lo fija el arquitecto. **Nace por migración de siembra** (como las `pagina.*`/funciones de la 0184/0192). Sin ella, el botón no aparece a nadie.
- Guarda en el front con `hasFuncion(...)`. Sin la función, el botón **no se pinta**, ni en la fila ni en el detalle. La visibilidad de las filas depende de P-2.
- **PII:** nada nuevo en la URL. La navegación a «Por validar» usa el estado del router. El VIN no entra en `aria-label` (se usa «Reintentar consulta» + `aria-describedby` a la celda del vehículo), ni en la consola, ni completo en el toast.

## 7. Responsive (<lg), feedback y tema

- **<lg:**
  - La tabla sigue con el scroll de `FlitTable`. La celda de acciones mantiene `whitespace-nowrap` y a 375 px el reintento queda a un desplazamiento, igual que «Ver» hoy.
  - En la tarjeta de confirmación, los dos botones se apilan a ancho completo con la primaria **arriba** (`flex-col-reverse sm:flex-row`).
  - Las pastillas envuelven (`flex-wrap`, como hoy).
  - En el bloque del detalle, el botón pasa a ancho completo.
- **Feedback:** todos los botones nuevos usan `flitBtnSecondarySm`, `flitBtnPrimary` o `flitBtnSecondary`, con `transition-colors`, hover `--flit-bg-hover` y `flit-focus`. El `h2` de la confirmación muestra el foco solo con `focus-visible`. Una sola altura de control por fila (`h-7` del kit).
- **Tema oscuro:**
  - Superficies con `--flit-bg-app` y `--flit-border-soft`. Textos con `--flit-text-primary`, `-secondary` y `-muted`.
  - Las insignias de icono usan `--flit-chip-warning-bg` + `--flit-warning-ink` y el tono `draft` de `StatusChip`.
  - **Prohibido** usar `--flit-warning-ink` como tinta de texto (no tiene par oscuro), además de `bg-white`, HEX y `slate-*`/`gray-*`.
  - Verificar a 1366 px en claro y en oscuro, y a 375 px en claro.

## 8. Accesibilidad

- El chip lleva texto y el icono va con `aria-hidden`.
- El botón de fila se llama «Reintentar consulta», con `aria-describedby` al identificador de la celda del vehículo, para que el lector distinga filas **sin** meter el VIN en `aria-label`.
- En vuelo: `aria-busy` en el botón y un `role="status"` único y oculto en la página con «Consultando el RUNT…». No va uno por fila.
- La tarjeta de confirmación es `role="status"` y el foco va a su `h2` (`tabIndex={-1}`).
- Contraste ≥ 4.5:1 en texto y ≥ 3:1 en la insignia y el foco, en los dos temas.

## 9. Requisitos de datos para architecture/backend (no son endpoints)

| # | Qué necesita la UI |
|---|---|
| R0 | Función de permiso para reintentar, sembrada por migración |
| R1 | Que el alta del canal Cliente acepte un envío con la preconsulta caída, vuelva a consultar el RUNT y devuelva un desenlace distinguible: `creada` (flujo normal) o `incompleta` |
| R2 | Dos estados nuevos visibles en la cola, `incompleta` y `descartada`, con etiqueta en `ESTADO_SOAT_LABEL` (P-1). En `SoatItem`: `ultimoIntentoRuntEn`. Si es `descartada`: `descarte: { en, motivo: 'soat_vigente' \| 'vin_sin_registro', vence?: fecha, porNombre? }` (P-4) |
| R3 | Una acción de reintento por solicitud con respuesta tipada: `completada` (+ `vigenciaProxima?` con la forma de la #12842), `descartada` (+ motivo y fecha), `sigue_incompleta`, y conflicto si otro la resolvió |
| R4 | Filtro de estado: «Todos» sin descartadas. Pastillas `incompleta` y `descartada` aceptadas por el filtro del API |
| R5 | Si es incompleta, `placa`, `marca`, `linea` y los datos técnicos llegan `null`. Si la cola muestra conteos por estado, que incluya los nuevos |

## 10. Preguntas para David (una ronda, cada una con recomendación)

1. **P-1 · Nombres visibles.** Se recomienda **«Por validar»** para la incompleta y **«Descartada»** para la descartada, **iguales para el Cliente y para Operaciones**: una sola etiqueta en `ESTADO_SOAT_LABEL` y un solo término en `docs/dominio.md`.
   - Se descarta «Incompleta»: da a entender que el Cliente dejó algo sin llenar, y aquí lo que falta es la respuesta del RUNT.
   - Se descarta «Sin RUNT» solo para Operaciones: serían dos nombres para una misma fila.
   - «Descartada» ya es el término de conciliación. Se descartan «Anulada» y «Rechazada», que sugieren una decisión humana en contra y reviven un estado que se retiró con la #12080.
2. **P-2 · ¿Quién ve las filas incompletas?** Se recomienda: **las ve todo el que ya ve esa cola** (el Cliente ve las de su compañía), y **solo el botón** depende del permiso. Si solo la vieran quienes tienen el permiso, el Cliente sin permiso guardaría una solicitud y no la encontraría, y la tarjeta 2.3 le mentiría.
3. **P-3 · ¿Descartadas en «Todos»?** Se recomienda **no**: van en su pastilla, al final. La alternativa, si 7 pastillas le parecen muchas, es un filtro «Ver descartadas» dentro del panel de filtros.
4. **P-4 · «Quién» descartó, visto por el Cliente.** Se recomienda mostrar el nombre si la persona es de **su** compañía y «FLITO» si fue un usuario interno. Nombrar al operador interno es jerga de trastienda en el canal Cliente. Operaciones ve siempre el nombre.
5. **P-5 · ¿La incompleta ocupa el VIN (RN-01)?** Se recomienda **sí**: una segunda solicitud del mismo VIN mientras la primera espera al RUNT sería un duplicado, y lo ataja el `ModalVinEnCola` de hoy. La descartada **no** ocupa el VIN.
6. **P-6 · ¿Se guarda también si el RUNT cae en el ENVÍO tras una consulta OK?** Se recomienda **sí** (§2.2): es el mismo silencio del RUNT y evita resubir la factura.
7. **P-7 · Reintento con SOAT próximo a vencer.** Se recomienda que el toast lleve la fecha de vencimiento y que la `TarjetaSoatActivo` (aviso) se pinte en el detalle si está abierto. Para verla después, la solicitud tendría que guardar esos datos (amplía R3). Si no se guardan, basta con el toast.
8. **P-8 · ¿Operaciones también reintenta?** Se recomienda que el permiso sea una función del catálogo que el admin reparte en el panel, sin decidir roles en el diseño. La tarjeta 2.3 ya se ramifica según quien la ve tenga o no el permiso.

## 11. Notas para QA (≤10)

1. Preconsulta 503 `runt_no_disponible` → la banda dice «puede… guardar la solicitud pendiente de validar». Con todo completo, la barra dice «Guardar pendiente de validar» y está activa. `sin_red`, `no_cuadra` y `sin_registro` **no** la activan.
2. Editar el VIN tras el 503 cierra la salida hasta volver a consultar.
3. Alta con desenlace `incompleta` → tarjeta 2.3 con el foco en el `h2`. «Ir a mis SOAT» abre la cola en «Por validar» y la URL **no** lleva el VIN. No hay toast.
4. En la fila, la incompleta muestra el chip «Por validar» con icono, el último intento, el VIN como identificador y «Datos del RUNT pendientes». No es seleccionable.
5. Sin la función de reintento, el botón no existe, ni en la fila ni en el detalle (no está deshabilitado: no está).
6. Un reintento en vuelo solo bloquea su fila. Los cuatro desenlaces de CF-05, CF-06 y CF-07, más conflicto y sin red, dan **un** toast cada uno con el copy literal de §3.3, sin VIN completo ni mensaje crudo.
7. Una descartada no está en «Todos», sí en «Descartadas». El detalle muestra motivo, cuándo y quién (P-4). Nunca desaparece.
8. Reintento OK con `vigenciaProxima` → pasa a Solicitado y el toast lleva la fecha. En el detalle abierto aparece la tarjeta aviso de la #12844.
9. Vacíos de «Por validar» y «Descartadas» con el copy de §4. El error de carga sigue con «Reintentar».
10. A 1366 y 375 px en claro y a 1366 px en oscuro: sin desborde, contraste ≥ 4.5:1, hover y foco en todos los botones nuevos. La ficha de ayuda `content/ayuda/soat.md` necesita su delta (`flit-ayuda-flito`).

## 12. Decisiones y descartes

- **La confirmación es una tarjeta en página y no un toast + navegar:** el estado sigue siendo cierto, es el mensaje central de CF-01 y un toast efímero haría creer al Cliente que se envió al gestor.
- **La salida degradada solo se abre con 503 del RUNT:** «continuar sin RUNT» está fuera de alcance. Aquí no se continúa, se **guarda**, y el flujo normal solo sigue cuando el RUNT responde.
- **Sin columna nueva ni banner en la cola:** el chip y la pastilla bastan. Un banner de «tiene N por validar» competiría con la primaria de la cabecera.
- **Sin adorno:** ninguna animación salvo el `Loader2`, que es feedback de espera y respeta `prefers-reduced-motion`. Sin colores nuevos: todo sale de tokens con par oscuro.
- **Copy impersonal en los toasts** para no mezclar usted y tú en una cola que se ramifica por rol.
