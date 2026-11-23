# UX slim — Corregir o reintentar número, fecha y avalúo de la factura (HU #14664)

Feature #14662 · Épica #14164. Público: operador interno (Administrador o Gestor de Impuestos
con el permiso `impuestos.tramite.certificar`) — no es canal Cliente.

## Superficie tocada

**Corrección de candidata:** el prompt proponía `apps/web/src/pages/FlitoImpuestosCertificarEditor.tsx`,
pero esa página es la de **«Certificar sin trámite»** (`flito_impuestos_certificacion_directa`,
flujo independiente de alta/consulta RUNT) y no tiene nada que ver con `NumeroFactura`/`FechaFactura`/
`AvaluoComercial`. Esos tres campos viven en `flito_impuestos.extraccion_factura_venta`
(`ExtraccionFacturaVentaImpuesto`, `apps/api/src/db/schema/flito-impuestos.ts`), que es la lectura
post-envío de la **cola principal de Impuestos** — la misma que ya pinta el semáforo RUNT.

**Pantalla correcta:** `apps/web/src/components/flito/DetalleImpuesto.tsx` (el modal de detalle que
abre `FlitoImpuestos.tsx` desde la fila de la cola). Es la misma superficie donde hoy viven
`SeccionValidacion` (RUNT, `ValidacionRunt.tsx`) y `DireccionComprador` (`DireccionComprador.tsx`) —
ambas leen del mismo `extraccion_factura_venta` / detalle del impuesto. Esta HU agrega una **sección
nueva** entre esas dos, sin tocar su interior.

No es ruta nueva, no es `PageSlug` nuevo: el modal ya existe, el permiso ya existe
(`impuestos.tramite.certificar`, ya usado en `FlitoImpuestos.tsx:342` para «Reintentar validación»).
Por eso slim, no full.

## Delta de claridad (qué se ve / qué se calla)

**Qué vino a hacer quien abre esto:** el gestor/admin que abrió el detalle de un impuesto porque algo
de la factura (número, fecha o avalúo) está mal o nunca se leyó — típicamente para corregir el Excel
de la cola o para que una lectura vieja (anterior a que el sistema capturara estos 3 campos) se
vuelva a intentar ahora que sí los captura.

**Siempre visible (en el detalle, al abrirlo):** los 3 valores con su indicador de confiabilidad —
igual que hoy «Validación» y «Dirección» se ven siempre sin un clic extra.

**Se calla / va a la sección (no compite con el `<dl>` de arriba):** la mecánica de corrección (el
formulario con motivo) solo aparece tras pulsar «Corregir» o «Reintentar lectura»; el historial
completo no existe — solo el **último** movimiento, una línea (ver «Decisiones y descartes»).

**Densidad:** el modal ya tiene `<dl>` + validación + dirección + soportes + acciones de gestión; es
largo pero cada sección es plegada a su tema. La sección nueva sigue el mismo peso que «Dirección del
comprador» (una h3 + dato + acción condicionada al permiso): no añade otra fila al `<dl>` ni infla la
cabecera de chips.

## Dónde queda (wireframe del delta)

Solo se dibuja el tramo que cambia; el resto del modal (chips de arriba, `<dl>`, soportes, acciones
de gestión al final) **no se toca** y no se redibuja aquí.

```
┌ FlitModal "Impuesto · ABC123" ──────────────────────────────────────────┐
│ [chips estado] [ChipDocumentos]                                         │
│ <dl> VIN · Trámite FLIT · Compañía · Organismo · … (sin cambios)        │
│                                                                           │
│ ── Validación factura ↔ RUNT ── (sin cambios; "Reintentar validación"   │
│    vive AQUÍ, en rojo, cuando aplica)                                   │
│                                                                           │
│ ┌─ NÚMERO, FECHA Y AVALÚO DE LA FACTURA ─────────────────────────┐ ← NUEVA│
│ │ Estos datos no afectan el semáforo ni la certificación.         │      │
│ │                                                                   │      │
│ │ Número de factura     FE-2024-00912        [100% · confiable]   │      │
│ │ Fecha de la factura    03 may 2024          [100% · confiable]   │      │
│ │ Avalúo comercial       $ 85.000.000         [62% · no confiable]│      │
│ │                                                                   │      │
│ │ Último cambio: corregido por Laura Gómez el 12 nov 2026, 9:40a — │      │
│ │ "el avalúo venía mal transcrito"                                 │      │
│ │                                                                   │      │
│ │ [Corregir]  [Reintentar lectura]   ← solo con el permiso         │      │
│ └───────────────────────────────────────────────────────────────┘      │
│                                                                           │
│ ── Dirección del comprador ── (sin cambios)                             │
│ … soportes / acciones de gestión / historial de estados (sin cambios)   │
└───────────────────────────────────────────────────────────────────────┘
```

**Al pulsar «Corregir»** (reemplaza el bloque de valores, mismo lugar — como `FormDireccion` hace con
«Dirección del comprador»):

```
│ Número de factura   [ FE-2024-00912________________ ]                   │
│ Fecha de la factura  [ 2024-05-03 ▾ ]   (input date; vacío = sin dato)  │
│ Avalúo comercial     [ 85000000____________ ]        (vacío = sin dato) │
│                                                                           │
│ Motivo de la corrección (mín. 5 caracteres)                             │
│ [ textarea________________________________________ ]                   │
│ ⚠ role=alert si falla el guardado                                       │
│                                                                           │
│ [ Guardar corrección ]  [ Cancelar ]   ← primaria = Guardar corrección  │
```

**Al pulsar «Reintentar lectura»** (no hay inputs de valor; solo el motivo — es un «vuelve a leer la
factura», no una edición manual):

```
│ Vuelve a leer la factura de venta solo para estos tres datos. No toca   │
│ el semáforo, la certificación ni la comparación con el RUNT.            │
│                                                                           │
│ Motivo del reintento (mín. 5 caracteres)                                │
│ [ textarea________________________________________ ]                   │
│                                                                           │
│ [ Reintentar lectura ]  [ Cancelar ]   ← primaria = Reintentar lectura  │
```

Solo una de las dos formas puede estar abierta a la vez, y ninguna convive con otra acción del
detalle (rechazar/asumir/reversar/etc.): reutiliza el mismo interruptor de estado `accion` que ya
tiene `DetalleImpuesto.tsx` (hoy `'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'asumir' |
'devolver'`), con dos valores más (p. ej. `'corregirFactura' | 'reintentarFactura'`). Así «Guardar
corrección» / «Reintentar lectura» del formulario es la única primaria visible en ese momento — igual
que ya ocurre con «Confirmar» en `FormMotivo`.

## Estados (4) + copy

| Estado | Qué se ve | Copy |
|---|---|---|
| **Cargando** | Misma estructura de 3 filas, sin valores (texto "…" o fila atenuada); sin spinner genérico aislado — calca el patrón de los hermanos (`SeccionValidacion`/`DireccionComprador`: `role="status"` + `Girador` + frase) | "Cargando los datos de la factura…" |
| **Error** (la petición del detalle falló) | Igual que `EstadoCargaDireccion`/`EstadosCarga`: `role="alert"` + botón | "No se pudo cargar los datos de la factura. Inténtalo de nuevo." + botón **Volver a cargar** |
| **Vacío** (sin lectura de estos 3 campos — típico en un certificado anterior a que el sistema los capturara, o análisis aún no corrido) | Sin filas de valor; el botón **Reintentar lectura** es el siguiente paso, visible (con permiso) | "Esta factura no se ha leído para el número, la fecha y el avalúo." + "Reintentar lectura" como CTA. Sin permiso: mismo texto, sin botón (no se añade un aviso de "pide permiso" — no es un bloqueo de flujo, es un dato que falta) |
| **Lleno** | 3 filas con valor (o "Sin dato en la factura" si esa clave vino `null`) + chip de confiabilidad por fila + línea de auditoría del último cambio (si existe) + **Corregir** / **Reintentar lectura** (con permiso) | Chip: `{confianza%} · confiable` (tone `success`) o `{confianza%} · no confiable` (tone `warning`); sin lectura de ESE campo puntual (null dentro de un registro que sí tiene los otros dos): chip `tone="neutral"` "Sin dato en la factura" |

El estado de la petición (cargando/error/lleno) es el **mismo fetch** que ya resuelve el detalle
(`useDetalleValidacion` / `carga`, compartido con `SeccionValidacion` y `DireccionComprador` en
`DetalleImpuesto.tsx`) — no un segundo round-trip. Ver «Datos» más abajo.

## Cómo se distingue de «Reintentar validación» (para que no se confundan)

«Reintentar validación» (HU #12832, `ValidacionRunt.tsx`) vive **dentro** de la sección «Validación
factura ↔ RUNT», solo aparece en rojo, y se **niega** si el impuesto ya está certificado (409
`YA_CERTIFICADO`). Esta sección nueva es justo lo contrario en los tres puntos, y la spec lo marca
así para que no se lean como el mismo botón con otro nombre:

1. **Sección propia, separada espacialmente.** Nunca dentro de la caja roja de validación ni en el
   hueco `accionReintento` del modal (`ModalValidacion`/`SeccionValidacion`). Encabezado propio:
   «Número, fecha y avalúo de la factura» (nunca "Validación").
2. **Sin vocabulario de semáforo.** Cero `StatusChip tone="danger"|"warning"` de semáforo
   (verde/naranja/rojo), cero `SEMAFORO_IMPUESTO_LABEL`. El chip aquí es de **confiabilidad del OCR**
   (`confiable`/`no confiable`), el mismo lenguaje que `FlitoRevisiones.tsx` ya usa para
   `CampoExtraido` — no se inventa un color nuevo.
3. **Copy explícito de alcance**, primera línea de la sección: *"Estos datos no afectan el semáforo
   ni la certificación."* Una frase, sin exigir que el usuario infiera la diferencia.
4. **Funciona certificado o no.** Nunca se niega por `YA_CERTIFICADO`; eso es precisamente lo que
   esta HU corrige (hoy esos 3 datos son invisibles incluso cuando el impuesto ya se certificó).
5. **Copy del botón distinto:** "Reintentar lectura" (nunca "Reintentar validación"), con el mismo
   glifo `Icono nombre="reintento"` que ya usa `FlitoRevisiones.tsx` para su propio «Reintentar
   lectura» — mismo verbo para la misma acción (releer un documento), icono consistente en todo el
   producto, pero la etiqueta completa más el encabezado de sección dejan claro que es otro objeto.

## Responsive (<lg)

Una línea: el modal ya es `wide` y de ancho fijo con scroll propio; la sección nueva apila sus 3
filas en una columna en cualquier ancho (no es una rejilla), y el formulario de «Corregir» (3 inputs)
pasa de 3 columnas a 1 bajo `sm` (`grid-cols-1 sm:grid-cols-3`), igual que `FormDireccion` hace con sus
3 campos. Los botones de acción (`flex flex-wrap gap-2`) envuelven como ya hace la fila de acciones
de gestión del propio modal.

## Interacción y notificaciones

- **Hover/foco:** "Corregir" y "Reintentar lectura" son `GradientButton` (`variant="secondary"`);
  dentro de los formularios, "Guardar corrección" / "Reintentar lectura" son `GradientButton`
  primario, "Cancelar" secundario — todos ya traen hover + foco del kit, ningún control nuevo plano.
  Los `input`/`textarea` usan `flitInp` (foco del kit incluido).
- **Notificación — Corregir guardado:** **toast** cerrable, una frase: *"Corrección guardada."* —
  resultado puntual, igual que `toastOk('Dirección guardada.', …)` en `DireccionComprador.tsx`. El
  valor nuevo y la línea de auditoría quedan en la página (estado persistente), el toast solo confirma
  que se envió.
- **Notificación — Reintentar lectura:** si la relectura es síncrona y devuelve los 3 valores de una
  vez → **toast** *"Lectura actualizada."* (mismo patrón). Si en la implementación resulta que la
  relectura queda en cola/asíncrona (como el análisis RUNT), el copy del toast cambia a algo como
  *"Relectura en cola. Los datos se actualizan solos en cuanto termine."* — decisión de
  `architecture-agent`/`backend-agent` según cómo quede el endpoint; en cualquier caso **toast**, no
  aviso en página, porque es la confirmación de que la acción se envió, no el dato final.
- **Error de guardado o de relectura:** en línea dentro del formulario abierto, `role="alert"`, texto
  claro (nunca el `e.message` crudo) — igual que `falloGuardado()` en `DireccionComprador.tsx` decide
  el texto por `status`, no por el mensaje del API.

## Permiso y comportamiento por rol

- Permiso: `impuestos.tramite.certificar` (el mismo slug que ya gatea «Reintentar validación» en
  `FlitoImpuestos.tsx:342` — reusar esa misma lectura de `hasFuncion`, no duplicar la constante).
- **Con permiso:** ve los 3 valores + chips + botones "Corregir"/"Reintentar lectura" (si aplica
  según estado).
- **Sin permiso:** ve los 3 valores + chips, **sin** botones. No se pinta aviso de "pide permiso a
  alguien" (a diferencia de `AvisoDireccion`, que sí lo hace porque ahí hay una dirección **pendiente
  de revisión** que bloquea algo; aquí no hay nada pendiente ni bloqueado — es una corrección
  opcional). Si el PO quiere ese aviso, es un ajuste de copy, no de estructura.
- `soloLectura` (Auditoría): igual que el resto del modal, sin botones de acción — la sección se
  comporta como "sin permiso" para Auditoría también.

## Datos (endpoint / requerimiento para architecture-agent)

No defino contrato (no es mi rol), pero dejo la pregunta concreta para que no se improvise en
implementación:

1. **Lectura:** recomiendo que los 3 campos (con su `CampoExtraido` completo: `valor`, `confianza`,
   `confiable`) viajen en el **mismo payload** que ya trae `useDetalleValidacion`/`carga` (el detalle
   compartido por `SeccionValidacion` y `DireccionComprador`), no en un fetch aparte — eso es lo que
   permite reusar directamente los 4 estados (`cargando`/`error`/`listo`) que ese hook ya resuelve, en
   vez de montar una segunda máquina de carga para la misma vista. Si por tamaño o por capa el
   backend prefiere un endpoint propio, los 4 estados de todos modos se escriben igual (cargando
   propio, error propio con su "Volver a cargar") — se pierde la reutilización, no la spec.
2. **Auditoría (AC5):** no existe hoy un campo "quién corrigió este dato a mano" en
   `ExtraccionFacturaVentaImpuesto`/`CampoExtraido` (solo trae `confirmadoPor`/`confirmadoEn`, que es
   de otro flujo — confirmación en `flito-revisiones`). Esta HU necesita que el backend persista,
   para el **último** cambio sobre estos 3 campos: quién, cuándo y el motivo (ya sea un campo nuevo
   en el jsonb, ya sea una fila de auditoría consultable). La UI solo pide **el último movimiento**
   (una línea), no un historial completo — ver «Decisiones y descartes».
3. **Corregir:** body esperado `{ numeroFactura?, fechaFactura?, avaluoComercial?, motivo }` — los 3
   valores son independientes y opcionales (un campo puede quedar vacío a propósito si la factura de
   verdad no lo trae), `motivo` obligatorio (mín. 5 caracteres, igual que el resto del motivo en este
   módulo: `FormMotivo`, `DireccionComprador`).
4. **Reintentar lectura:** body esperado `{ motivo }`; la respuesta debe traer los 3 `CampoExtraido`
   actualizados (para pintar "lleno" sin recargar todo el detalle), igual que `certificar()` en
   `FlitoImpuestos.tsx` parcha la fila con lo que devuelve el POST en vez de recargar la cola entera.
5. Confirmar con `security-agent`/`db-review-agent` si corresponde: `avaluoComercial` y `motivo` no
   son PII, pero el nombre de quien corrige sí identifica a un usuario interno — ya es el mismo
   patrón que `confirmadoPor`/`usuario` en `HistorialEstados`, no es un caso nuevo de PII.

## Accesibilidad

- Encabezado de sección `<h3>` con `id` propio (`validacion-{imp.id}` y `direccion-{imp.id}` ya
  existen; seguir el mismo patrón: `factura-datos-{imp.id}`) + `aria-labelledby` en el `<section>`.
- Cada chip de confiabilidad lleva el texto visible (no solo color): "62% · no confiable" se lee
  igual en lector de pantalla que en pantalla — ya es el comportamiento de `StatusChip`.
- Inputs del formulario de corrección: `<label>` asociado (vía `FlitField`, como `FormDireccion`),
  `aria-describedby` al error de campo si se valida en cliente, `textarea` del motivo con su propio
  `<label>` visible (no placeholder-como-label).
- Error de guardado / de relectura: `role="alert"` dentro del formulario (no en un `aria-live`
  genérico aparte, ya que el formulario entero puede desmontarse).
- Botones deshabilitados (`disabled`) cuando el motivo no cumple el mínimo — nunca clic silencioso que
  no hace nada.
- Contraste de los chips: reusa `success`/`warning`/`neutral` de `StatusChip`, ya verificado en claro
  y oscuro — no se introduce color nuevo.

## Notas para QA

1. Vacío: un impuesto certificado antes de que el sistema capturara estos 3 campos (p. ej. anterior a
   HU #14293) muestra el estado vacío, no "lleno con `null`×3".
2. Lleno con mezcla: un campo `confiable: false` y otro `null` en el mismo registro — deben
   distinguirse (chip "no confiable" vs chip "Sin dato en la factura"), no colapsar al mismo texto.
3. "Corregir" y "Reintentar lectura" **no aparecen** sin `impuestos.tramite.certificar` (ver también
   para `soloLectura`/Auditoría).
4. Guardar una corrección con un impuesto **ya certificado** funciona (a diferencia de «Reintentar
   validación», que ahí se niega con 409).
5. Dos pestañas/usuarios: reintentar lectura no debe pisar una corrección manual guardada
   simultáneamente sin que la UI lo refleje al refrescar — al menos verificar que el detalle se
   repinta con lo que devuelve el POST, no con el estado local viejo.
6. El motivo exige mínimo 5 caracteres en ambos flujos (Corregir y Reintentar lectura); probar borde
   (4 vs 5 caracteres, solo espacios).
7. El toast de "Corrección guardada" / "Lectura actualizada" es cerrable y no reaparece si se navega
   fuera y se vuelve a abrir el mismo detalle.
8. Verificar que NINGÚN texto de esta sección usa "validación" ni los colores de semáforo
   (verde/naranja/rojo) — grep rápido de `SEMAFORO_IMPUESTO_LABEL` o `tone="danger"` fuera de
   `ValidacionRunt.tsx` en el diff.
9. Auditoría (`soloLectura=true`): ve los 3 valores y chips, sin botones, sin error en consola.
10. Responsive 375 px: las 3 filas no desbordan, el formulario de corrección cae a 1 columna.

## Decisiones y descartes

- **Descartado:** reusar el patrón de `FlitoImpuestosCertificarEditor.tsx` (chip "Leído" + borde
  punteado + "Usar este dato") — ese patrón compara **lectura vs. formulario en edición** (alta de un
  registro nuevo); aquí no hay un formulario de alta abierto, hay un registro ya certificado o en
  gestión y un dato de solo-exhibición. Traerlo habría sido clonar un patrón para un problema distinto.
- **Elegido:** el patrón "confiable/no confiable" de `FlitoRevisiones.tsx` para el chip, porque es
  exactamente el mismo dato (`CampoExtraido.confiable` + `confianza`) con el mismo significado.
- **Elegido:** el patrón "sección con su propio fetch de detalle, cargando/error propios" de
  `SeccionValidacion`/`DireccionComprador` — ya resuelto en el mismo archivo, mismo público, misma
  pantalla; no se inventa una tercera forma de pintar cargando/error en este modal.
- **Descartado:** historial completo tipo `HistorialEstados` (acordeón con N entradas). AC5 solo
  exige que la corrección/reintento quede visible — "aunque sea una línea". Un acordeón de historial
  completo es más superficie, más permiso implícito de decisión de producto (¿cuántas entradas?,
  ¿se pagina?) y no lo pidió el AC. Si el producto luego quiere el histórico completo, es una
  extensión incremental sobre esta misma sección, no un rediseño.
- **Sin efectos:** sin animación de "chip pulsante" para "no confiable", sin color de advertencia
  nuevo (reusa `--kit-naranja-texto`/`tone="warning"` ya existente). Sin ilustración de vacío: el
  estado vacío es una frase + un botón, igual que sus hermanos en este mismo modal.
- **Una primaria por momento:** en reposo no hay primaria (dos botones secundarios, "Corregir" y
  "Reintentar lectura", al mismo nivel — ninguno es "más importante" a priori, el usuario elige según
  lo que necesite). Al abrir cualquiera de los dos formularios, ese formulario tiene exactamente una
  primaria ("Guardar corrección" / "Reintentar lectura" de confirmación) y un "Cancelar" secundario —
  mismo patrón que ya usa todo `DetalleImpuesto.tsx` para sus otras acciones (rechazar, asumir,
  reversar…).
- **Tratamiento de voz:** este modal ya tutea en varias piezas de copy existentes de Operaciones
  (p. ej. "Cárgala primero con..."); la sección nueva calca ese tono informal, no "usted" — es la
  misma pantalla, no se mezcla.

## Brief de mockup

**Si se decide maquetar:** basta con el `FlitModal` existente mostrando SOLO el tramo entre
«Validación factura ↔ RUNT» y «Dirección del comprador» (no hace falta rehacer el modal completo:
esas dos secciones ya están implementadas y no cambian). Una sola vista con 4 variantes apiladas
(cargando / error / vacío / lleno) basta — no hace falta una pantalla por estado.

- **Componentes del kit:** `FlitModal` (contexto, puede recortarse a solo el fragmento), `StatusChip`
  (`tone="success"|"warning"|"neutral"`), `GradientButton` (`variant="secondary"` para "Corregir"/
  "Reintentar lectura"; default/primary para "Guardar corrección"/"Reintentar lectura" de
  confirmación), `FlitField` + `flitInp` para los inputs del formulario, `Icono nombre="reintento"`,
  `Girador` para cargando, mismo `role="alert"`/`role="status"` que el resto del archivo.
- **Datos ficticios:** placa `ABC123`, número de factura `FE-2024-00912`, fecha `2024-05-03`, avalúo
  `$85.000.000` (confiable 62 % → "no confiable"), número y fecha en 100 % ("confiable"). Último
  cambio: "corregido por Laura Gómez el 12 nov 2026, 9:40 a. m. — \"el avalúo venía mal transcrito\"".
  Ningún dato real de un impuesto/placa/VIN existente.
- **Estados a mostrar:** los 4 de la tabla de arriba, con el copy exacto ahí escrito.
- **Qué NO mostrar:** el `<dl>` completo del modal, los soportes, el historial de estados, las
  acciones de gestión (rechazar/asumir/reversar) — no son parte de este delta y ya están
  implementados; mostrarlos de nuevo en la maqueta sería redibujar pantalla no tocada.

---

**Mockup:** no generado todavía — ver HANDOFF (el wireframe ASCII + los 4 estados de esta spec
bastan para decidir si hace falta antes de `frontend-agent`).
