# UX slim — SOAT inicial en masa y pendientes en Por validar (HU #14137)

Feature #14014 · Épica #13760. Parte de lo aprobado en `docs/ux/flito-soat-carga-masiva-renovaciones.md` (HU #14134) y de `DetalleIncompletaSoat` / `FilaIncompletaSoat` (HU #12997/#12998).
Mockup HTML autocontenido: `docs/ux/flito-soat-inicial-masiva-y-pendientes.mockup.html`. Mockup publicado: _(el hilo pega aquí el link del Artifact)_.

Público: Cliente de una compañía con «Solicitar SOAT sin trámite» (`soat.solicitud.crear`); Operaciones/admin llegan por la misma pantalla y eligen compañía. Tratamiento: **usted**. Sin slug ni ruta nueva.

**Ajustes del humano (rev. 2):** (1) espacio entre la divisoria y los botones del pie del modal; (2) la primaria se llama **«Crear solicitud»**; (3) patrón reutilizable **AvisoProcesando** para todo lo que «se está analizando/procesando» en esta HU.

## Superficie tocada

1. `ModalidadRenovacion` (selector «Forma de cargar») y `PanelMasivoRenovacion` / `ResumenLote` / `TablaFilasLote` / `COPY_MASIVO.inicial`.
2. `FilaIncompletaSoat` (motivo visible en la fila).
3. `DetalleIncompletaSoat` (completar: factura → advertencias → formulario → crear solicitud).
4. Nuevo componente de presentación `AvisoProcesando` (ver «Aviso de procesamiento»).

## Delta de claridad (qué se ve / qué se calla)

### AC1 · Cómo se elige Inicial en masivo: una sola opción

**Se muestra «Forma de cargar» (Individual / Masiva) con cualquiera de los dos tipos; la plantilla la decide el «Tipo de SOAT» ya elegido arriba.** No hay selector nuevo.
Justificación: el Cliente ya declaró el tipo en el primer paso; un segundo selector «Plantilla Inicial / Renovación» le preguntaría lo mismo dos veces y abriría el error «plantilla equivocada» a propósito. Con esta opción la vista masiva se reutiliza tal cual (`tipo` ya es prop). Descartado: selector de plantilla dentro del panel (duplica la decisión).

- `ModalidadRenovacion` deja de devolver `children` cuando `tipo !== RENOVACION`: el selector aparece con ambos tipos. La descripción de «Masiva» cambia por tipo: Inicial «Hasta 200 vehículos desde un Excel» · Renovación «Hasta 200 renovaciones desde un Excel» (ya existente). Individual: «Un vehículo» en ambos.
- Cambiar de tipo con la forma Masiva activa: el panel se remonta con el copy del otro tipo (clave = tipo). La forma elegida se conserva. Con lote en curso, el cambio de tipo pide el mismo modal ya aprobado «¿Salir de la carga en masa?» (Quedarme / Salir).
- Panel Inicial: título «SOAT inicial en masa». Paso 1 **«Descargue la plantilla y escriba el VIN de cada vehículo, una fila por vehículo.»** + línea de ayuda en `--flit-text-secondary`: **«La factura de venta se carga después, en Por validar.»** (dice el siguiente paso y evita que el Cliente busque dónde ponerla). Paso 2 «Suba el archivo con los vehículos.» Caja «Elegir archivo de vehículos» · hint «Excel .xlsx · hasta 200 filas». Botón «Cargar vehículos». Archivo de plantilla `plantilla-inicial.xlsx`.
- Tabla: columna clave **VIN** (en vez de Placa) · Vehículo (RUNT) · Estado · Detalle. En Inicial, «Vehículo (RUNT)» = `marca línea · modelo · placa` cuando el RUNT ya respondió (la placa solo aquí, en el cuerpo de la respuesta; nunca en URL). Título del detalle: «Detalle por VIN».
- Se calla: documento del propietario, id del lote, historial, y cualquier campo de factura (la factura no existe en este paso).

### Resumen del lote (AC1 + AC2)

Mismas tres cifras aprobadas, pero «enviadas a Por validar» pasa a **«n en Por validar»** con una línea que dice **por qué** (solo los motivos con n > 0, separados por « · »):

| Motivo (`porValidar*`) | Texto |
|---|---|
| `porValidarFactura` | «n esperan la factura de venta» |
| `porValidarPropietario` | «n faltan datos del propietario» |
| RUNT sin respuesta (resto) | «n esperan al RUNT» |

Ejemplo Inicial: «**2 esperan la factura de venta.** Ver en Por validar →». Se redacta en singular/plural («1 falta…», «2 faltan…»; «1 espera…», «2 esperan…»).

**Única primaria (cambia el peso, declarado):**
- Hay rechazadas → «Descargar rechazadas» (sin cambio).
- Sin rechazadas pero con pendientes de factura/propietario → **«Ir a Por validar»** pasa a primaria y «Cargar otro archivo» a secundaria (el trabajo que queda es completarlas; antes era solo un enlace). Afecta también a Renovación con `porValidarPropietario`.
- Nada que hacer → «Cargar otro archivo» (sin cambio).
«Ver en Por validar →» sigue como enlace dentro de la frase; ambos abren `navigate('/flito/soat', { state: { pastilla: 'incompleta' } })`.

### Copy `COPY_MASIVO.inicial` (reemplaza el TODO #14137)

El bloque ya escrito en `copyMasivo.ts` se confirma tal cual salvo `paso1`, que pasa a «Descargue la plantilla y escriba el VIN de cada vehículo, una fila por vehículo.» (nuevo campo `notaPaso1`: «La factura de venta se carga después, en Por validar.»; vacío en renovación).

| Clave | Texto |
|---|---|
| tituloSeccion | SOAT inicial en masa |
| etiquetaCaja | Elegir archivo de vehículos |
| botonCargar | Cargar vehículos |
| paso2 | Suba el archivo con los vehículos. |
| toastRecibido | Archivo recibido. Estamos procesando los vehículos. |
| archivoVacio (`archivo_vacio`) | El archivo no tiene vehículos. Llene al menos una fila de la plantilla. |
| plantillaEquivocada | Este archivo es de la plantilla de Renovación. Elija Renovación o descargue la plantilla Inicial. |
| noEncontrada | No encontramos esta carga. Cargue el archivo de nuevo si no ve sus solicitudes en la lista. |

Los errores comunes (`.xlsx`, >200 filas, red, avance, `lote_activo`, 503) no cambian.

### AC2 · Fila en Por validar (`FilaIncompletaSoat`)

Dentro de la celda Estado (bajo el chip) el motivo se dice con texto, 12 px, `--flit-text-secondary`:
- `falta_factura_venta` → **«Falta factura de venta»** (Inicial).
- `faltan_datos_propietario` → **«Faltan datos del propietario»** (Renovación pendiente).
- `runt_sin_respuesta` → sin cambio («El RUNT no respondió» + «Último intento»).

Para los dos motivos nuevos **se retiran** de esa fila: «Datos del RUNT pendientes» (es falso: el RUNT sí respondió), «Último intento» y «Reintentar consulta» (el motivo no es el RUNT). La acción pasa a ser **«Completar ›»** (secundaria `sm`, ocupa el lugar de «Ver»; abre el mismo modal). Sin permiso `soat.solicitud.crear` queda «Ver» y el modal no muestra formulario (solo el motivo y el texto «Quien solicita SOAT en su compañía puede completar esta solicitud.»). La densidad de la fila no empeora: cambia una línea por otra.

### Completar (`DetalleIncompletaSoat`)

El modal ancho existente se reutiliza. Orden y qué se calla:

1. Cabecera igual (chip «Por validar» + etiqueta de tipo). El bloque «Pendiente de validar con el RUNT» solo se pinta con `runt_sin_respuesta`.
2. Bloque del motivo (`Seccion` tipo caja ya usada en el modal):
   - **Inicial / «Falta la factura de venta»:** «Cargue la factura de venta en PDF. Revisaremos que el VIN coincida y llenaremos los datos del propietario por usted.» + caja de carga PDF («Elegir la factura de venta (PDF)», hint «PDF · hasta 15 MB»). **Al elegir el archivo se envía solo** (sin botón intermedio) y aparece el aviso de procesamiento «Leyendo la factura…». El formulario **no existe** hasta que la factura se haya recibido.
   - **Renovación / «Faltan datos del propietario»:** formulario vacío visible desde el inicio + caja opcional «Elegir la factura de venta (PDF, opcional)» con la frase «Si tiene la factura de venta, puede cargarla (opcional) y llenamos los datos por usted.»
3. Tras la lectura: el bloque pasa a «Revise los datos del propietario» + «Los leímos de la factura de venta (nombre-del-archivo.pdf). Revíselos antes de crear la solicitud.» (con la caja en estado verificado; pulsarla cambia la factura). Después **las advertencias** (arriba del formulario, no escondidas en el pie) y el **formulario prellenado**.
4. Abajo, `dl` con VIN/placa, compañía, solicitado por y fecha (igual que hoy). El VIN de la solicitud se repite en la advertencia de VIN dudoso. No se muestra el documento fuera del campo del formulario.

Formulario (un solo `<form aria-label="Datos del propietario">`, rejilla 1 col <`sm`, 2 col ≥`sm`): Tipo de documento, Número de documento, Nombres, Apellidos (o Razón social cuando el tipo de documento es NIT), Correo electrónico, Celular, Dirección, Municipio, Departamento. Cada campo con `<label>`. Los campos son los del body de `/confirmar`; no hay otros.

**Advertencias (`role="status"`, una por caso; pueden coexistir):**

| Caso (API) | Tono | Texto exacto |
|---|---|---|
| `vinVerificado:false` (decisión a) | aviso (warning) | «No pudimos confirmar el VIN de la factura; compárelo con el de la solicitud.» + línea «VIN de la solicitud: 9ZZDEMO…» |
| `lectura:'no_disponible'` (b) | neutro | «No pudimos leer la factura, pero quedó guardada. Escriba los datos del propietario a mano.» (formulario vacío; «Crear solicitud» deshabilitado con razón hasta completar) |
| `documentoDifiere` (c) | aviso | «El documento de la factura es distinto al que consultamos en el RUNT. Dejamos el del RUNT; revise que sea correcto.» (el campo conserva el del RUNT, sin sobrescribir) |

**Creación explícita (d):** el botón se llama **«Crear solicitud»** y es la **única primaria** del modal (con la advertencia de VIN dudoso presente sigue siendo la primaria; no se bloquea). Línea previa: «Al pulsar «Crear solicitud», la solicitud sale al gestor.» **Sin ese clic nunca sale al gestor** (el body sigue llevando `confirmado:true`, que solo el clic arma). «Cerrar» es la secundaria. En vuelo: el botón muestra spinner + **«Creando solicitud…»**, `aria-busy`, deshabilitado, y los campos quedan `readonly`.

### Espaciado del pie del modal (ajuste 1, para frontend-agent)

El pie de «Completar» (Cerrar + «Crear solicitud») queda **separado de la línea divisoria superior**: contenedor del pie con `mt-4 border-t pt-4` (borde `--flit-border-soft`) — es decir, 16 px entre la divisoria y los botones, **igual en escritorio y móvil, claro y oscuro** (solo tokens, el espacio no cambia con el tema). Aplica a todas las variantes del pie: formulario, «Actualizar lista» del caso 409 y cualquier pie futuro del modal. En móvil el pie apila los botones a ancho completo con `gap-2` y mantiene los mismos 16 px arriba. Debajo del pie, el `dl` de datos conserva `mt-4`. El mockup lo refleja (`.modal .acc`).

### Aviso de procesamiento (ajuste 3): patrón `AvisoProcesando`

Problema: «Leyendo la factura…» como texto plano no deja ver que el sistema trabaja. Patrón reutilizable, sin patrón visual ajeno: es una **pastilla al estilo de «Por validar» / «SOAT inicial»** (`StatusChip`) con spinner.

- **Nombre y ubicación propuestos:** `AvisoProcesando` en `apps/web/src/components/flit/AvisoProcesando.tsx` (kit; no depende de SOAT).
- **Props:** `texto: string` (obligatoria; frase completa con puntos suspensivos) · `tono?: 'activo' | 'neutro'` (default `activo`) · `className?`. Sin más: no acepta iconos ni animaciones distintas.
- **Aspecto:** `inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold`; spinner `Loader2` 14 px a la izquierda (`animate-spin motion-reduce:animate-none`). Con `prefers-reduced-motion` el icono **no gira**: queda estático (el texto sigue siendo el portador del estado, y puede añadirse «…» tipográfico). Tono `activo`: fondo `--flit-chip-active-bg`, texto e icono `--flit-chip-active-ink`, borde = esa tinta al ~45 % (`color-mix`). Tono `neutro`: `--flit-chip-draft-bg` / `--flit-chip-draft-ink`.
- **Contraste ≥ 4.5:1** con los pares ya medidos del `StatusChip`: claro #1D4FB8 sobre #E1ECFF ≈ 6,4:1; oscuro #BFD5FF sobre #1B3563 ≈ 8:1; neutro claro #4A5568 sobre #EEF1F6 ≈ 6,9:1; oscuro #D3DCEB sobre #2A3956 ≈ 8,5:1. Sin HEX nuevos.
- **Accesibilidad:** contenedor `role="status" aria-live="polite"` (un anuncio al aparecer, sin repetir el texto cada vez que cambia el spinner); el spinner `aria-hidden`. En el avance del lote, el texto cambia cada sondeo («12 de 40» → «20 de 40»): el `aria-live` anuncia el cambio, por lo que se mantiene el criterio ya aprobado de **no** reanunciar cada 2,5 s — solo se actualiza `aria-live` cuando cambia el estado del lote (en curso → terminado) y el número se actualiza visualmente sin re-anunciar (`aria-atomic="false"` y texto numérico en un `<span aria-hidden>` con el anuncio en un `sr-only` aparte).
- **Móvil (<`lg`):** la pastilla pasa a bloque de ancho completo (`flex w-full`), `rounded-2xl`, el texto envuelve (no se trunca) y el spinner queda alineado arriba-izquierda.
- **Dentro de un botón:** no se usa la pastilla; el botón pierde el icono y muestra el spinner `Loader2` (16 px, mismo `motion-reduce`) + texto («Creando solicitud…», «Cargando…»), `aria-busy`, deshabilitado. Mismo patrón que «Consultando…» de `FilaIncompletaSoat`.
- **Dentro de un chip de fila:** el estado `Consultando` de la tabla del lote lleva un spinner de 10 px en lugar del punto del `StatusChip`.

**Dónde se aplica en esta HU (y solo aquí):**

| Texto | Superficie | Forma |
|---|---|---|
| «Leyendo la factura…» | Modal Completar, tras elegir el PDF | `AvisoProcesando` bajo la caja |
| «Creando solicitud…» | Botón «Crear solicitud» en vuelo | Spinner en el botón |
| «Recibiendo el archivo…» / «Cargando…» | Panel masivo al subir el Excel | `AvisoProcesando` + spinner en el botón |
| «Preparando el avance…» | Primer sondeo del lote | `AvisoProcesando` sobre las filas esqueleto |
| «Procesando: n de total filas. Puede salir de esta página; el proceso continúa.» | Avance del lote (sustituye al aviso de texto aprobado en #14134) | `AvisoProcesando` |
| Estado «Consultando» de una fila del lote | Tabla del lote | spinner mini en el chip |
| «Consultando…» (Reintentar consulta de la fila/modal) | Fila/modal ya existentes | ya tienen spinner; sin cambio |

**Fuera del alcance:** NO se rediseñan pantallas existentes fuera de esta HU (el formulario individual de solicitud conserva sus textos). Las cargas de datos con esqueleto o texto («Cargando las solicitudes…», «Cargando el propietario y la factura…») no cambian: son lectura, no procesamiento. El patrón queda disponible para extenderlo después si el humano lo pide.

## Estados (4) + copy

Mismos cuatro estados del detalle y de la lista; lo nuevo:

| Estado | Qué se ve | Copy |
|---|---|---|
| **Cargando** | Detalle: «Cargando el propietario y la factura…» (existente). Subir factura: caja inerte + `AvisoProcesando` «Leyendo la factura…». Crear: botón con spinner y «Creando solicitud…», campos `readonly`. Lista y panel masivo: sin cambio salvo el aviso de procesamiento | — |
| **Error** | Siempre en línea, `role="alert"`, nunca el mensaje del API, **sin perder lo escrito ni el archivo elegido**. | ver tabla |
| **Vacío** | Panel masivo: caja + «Elija un archivo para continuar.». Lista Por validar: sin cambio (al completar la última sale la lista vacía con su copy actual). Formulario sin lectura: campos vacíos y «Crear solicitud» deshabilitado con razón | «Complete los datos del propietario para crear la solicitud.» |
| **Lleno** | Resumen + tabla VIN; lista con motivo; formulario prellenado | — |

| Caso | Dónde | Copy | Acción |
|---|---|---|---|
| `422 vin_factura_no_coincide` (AC4) | Bajo la caja de carga; la caja se limpia, la pendiente no cambia, no aparece formulario | «El VIN de la factura no coincide con el de la solicitud. Cargue la factura correcta.» | Elegir otro PDF |
| Archivo no PDF / >15 MB / MIME inválido (400) | Bajo la caja | «Elija la factura en PDF, de hasta 15 MB.» | Elegir otro PDF |
| Red/5xx al cargar factura (AC7) | Bajo la caja, conserva el archivo | «No pudimos leer la factura. Revise su conexión e intente de nuevo.» | **Reintentar** (reenvía el mismo PDF) |
| OCR caído / ilegible (AC6) | 200: no es error, es la advertencia (b) | ver advertencias | Escribir a mano |
| Error de validación al crear | Por campo, `aria-invalid` + `aria-describedby`, foco al primero inválido | «Escriba un correo válido.» · «Escriba un celular de 10 dígitos.» · «Este dato es obligatorio.» | Corregir |
| `422 RUNT_NO_CUADRA` (u otro de la compuerta) | Aviso sobre el formulario + marca en Número de documento | «El documento no corresponde al registrado en el RUNT para este vehículo. Revise el número de documento.» | Corregir y volver a pulsar «Crear solicitud» |
| Red/5xx al crear (AC7) | Aviso sobre el formulario; campos intactos | «No pudimos crear la solicitud. Lo que escribió sigue aquí; intente de nuevo.» | **Reintentar** (repite el POST con lo escrito) |
| `404` (otra compañía) / `409` ya resuelta | Reemplaza el formulario | «Esta solicitud ya fue completada por otra persona. Actualice la lista para verla.» | **Actualizar lista** (cierra y recarga) |
| Falla al cargar el detalle | Existente | «No pudimos cargar el propietario y la factura.» | Reintentar |

## Responsive + feedback del delta

- **<`lg`:** selector de forma ya apila a 1 col; el panel Inicial es igual al aprobado (botones `w-full`). Resumen: cifras apiladas, la primaria arriba. Tabla con scroll del kit; **VIN y Estado primeras columnas**. Lista: la fila ya envuelve; «Completar ›» ocupa su línea. Modal: formulario 1 columna, caja de carga y botones a ancho completo (`w-full sm:w-auto`), la primaria primero, con los 16 px de aire sobre el pie. `AvisoProcesando` a ancho completo (ver arriba).
- **Hover/foco de lo nuevo:** caja PDF igual a `FlitUploadBox` (velo `--flit-bg-hover`, `focus-within` anillo); inputs/select con borde `--flit-border-input` y anillo `--flit-border-focus`; «Completar», «Crear solicitud», «Reintentar», «Actualizar lista» con los botones del kit (`flitBtn*`, `flit-focus`); enlace «Ver en Por validar →» subrayado al hover. `AvisoProcesando` no es interactivo: sin hover ni foco.
- **Notificaciones:** archivo de lote recibido → toast cerrable (existente). **Solicitud creada → toast cerrable de una frase «Solicitud creada y enviada al gestor.»** (se ajusta al nuevo verbo del botón: «Solicitud enviada al gestor.» solo habría sido correcto a medias, porque el botón dice «crear»; la frase mantiene lo que de verdad pasa: se crea y sale al gestor). El modal se cierra y la fila sale de la lista (el cambio persistente lo ve el usuario en la lista, por eso toast y no aviso). Factura cargada y leída → sin toast (el formulario aparece). Todo error → aviso en línea con Reintentar (tabla anterior), nunca toast. Estado persistente (motivo del pendiente, advertencias) → aviso en página/modal.

## Permiso/slug

Sin cambios de pantalla: `flito_soat`; ver cola con `soat.incompleta.ver`; completar/cargar factura/crear con **`soat.solicitud.crear`** (la misma `exigirFuncion` de las rutas `/factura` y `/confirmar`). Cliente con la función de su compañía; Operaciones/admin eligiendo compañía. Sin PII en URL: solo `:id` uuid; documento, correo, celular, dirección y factura viajan en el cuerpo; placa/VIN no en query.

## Notas para QA (≤10)

1. AC1: con tipo Inicial aparece «Forma de cargar»; Masiva muestra «SOAT inicial en masa», «Cargar vehículos», columna VIN; la plantilla descargada es la de solo VIN; Renovación no cambia.
2. AC1: archivo de Renovación en Inicial → «Este archivo es de la plantilla de Renovación…» y viceversa; archivo vacío → «El archivo no tiene vehículos…».
3. AC1: resumen Inicial dice «n esperan la factura de venta»; sin rechazadas y con pendientes la primaria es «Ir a Por validar».
4. AC2: la fila creada por la carga muestra «Falta factura de venta» (Inicial) / «Faltan datos del propietario» (Renovación) y «Completar»; no muestra «Reintentar consulta».
5. AC3: PDF con VIN igual → aviso «Leyendo la factura…» con spinner → formulario prellenado; «Crear solicitud» → toast, la fila sale. Sin ese clic nada sale al gestor.
6. AC4: VIN distinto → mensaje exacto; sigue en la lista, estado sin cambio, sin formulario.
7. AC5: Renovación: con y sin factura, escribir propietario y crear → sale de la lista.
8. AC6: `lectura:'no_disponible'` o PDF ilegible → advertencia y formulario vacío editable; `vinVerificado:false` → advertencia sin bloquear.
9. AC7: forzar 5xx en `/factura` y `/confirmar` → Reintentar conserva archivo y campos; 409 → «ya fue completada».
10. AC8 y ajustes: foco en cada control, labels, claro/oscuro, 375 px; pie del modal con 16 px entre divisoria y botones en ambos anchos; con `prefers-reduced-motion` ningún spinner gira; ninguna URL con placa/VIN/documento.

## Brief de mockup

`docs/ux/flito-soat-inicial-masiva-y-pendientes.mockup.html` (autocontenido, tokens `--flit-*` claro/oscuro; selectores de vista, tema, ancho y movimiento solo para revisión). Vistas: panel masivo Inicial (vacío, archivo elegido, subiendo, archivo vacío, plantilla equivocada, error de red, primer avance, en curso, error de avance, terminado con rechazadas, terminado sin rechazadas con pendientes, terminado sin pendientes, Renovación con propietario pendiente); lista Por validar (lleno, cargando, error, fila consultando); modal de completar (cargando, error, sin archivo, leyendo, VIN no coincide, red, prellenado, VIN dudoso, OCR caído, documento difiere, validación, creando solicitud, error de servidor, RUNT no cuadra, ya completada, éxito con toast, Renovación vacío y con factura); variantes de `AvisoProcesando` (tonos, texto largo, botón, chip, movimiento reducido). Kit: `Seccion`, `FlitUploadBox`, `FlitTable`, `StatusChip`, `FlitModal`, `flitBtnPrimary/Secondary(Sm)`, `AvisoProcesando` (nuevo, ver arriba). Datos ficticios (VIN 9ZZDEMO…, placas ZZA…, documento/correo/celular de demostración). No mostrar: documento fuera del formulario, id de lote, jerga (ANS, proveedor).

## Decisiones y descartes

- **Reutilizar el tipo ya elegido** en vez de un selector de plantilla (AC1).
- **Subida automática de la factura** al elegir el PDF: quita un botón y un paso; el error conserva el archivo y ofrece Reintentar.
- **El formulario no existe antes de leer la factura en Inicial** (nada que revisar, nada que confundir); en Renovación sí existe, porque puede completarse sin factura.
- **VIN dudoso avisa y no bloquea** (decisión a); la primaria no cambia de peso.
- **Fila: se cambia una línea por otra**, no se añade columna; «Reintentar consulta» desaparece donde no tiene sentido.
- **«Crear solicitud» en lugar de «Confirmar y enviar al gestor»** (pedido del humano): más corto y es el verbo del trámite; la explicitud se conserva con la línea previa y porque sin el clic no hay envío. Toast con «creada y enviada al gestor» para que no contradiga al botón ni oculte que sale al gestor.
- **AvisoProcesando es un solo componente con dos tonos**, no una familia de loaders; sin barra de progreso ni porcentaje; el giro respeta `prefers-reduced-motion`. Se descarta aplicarlo a cargas de lectura con esqueleto.
- Descartado: pantalla/ruta nueva para completar, barra de pasos, animaciones de adorno, mostrar el documento en la lista, toast para errores.
- Pregunta abierta para el hilo: ¿«Ir a Por validar» como primaria cuando solo hay pendientes (cambio de peso que también toca Renovación)? Se propone sí; si no, mantener «Cargar otro archivo».

HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: docs/ux/flito-soat-inicial-masiva-y-pendientes.md + .mockup.html (rev. 2)
  Oficio: primaria única | jerarquía dicha | vacío con siguiente paso | responsive dicho | feedback dicho | notificación elegida | sin efectos
  Densidad: sin cambio
  Mockup: brief listo
  Siguiente: hilo republica el Artifact y espera «ok» humano → frontend-agent
