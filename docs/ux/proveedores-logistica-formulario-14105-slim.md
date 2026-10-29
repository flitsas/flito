# UX slim — Clientes y proveedores: formulario de proveedor SOAT | Logística y proveedor por compañía (HU #14105)

Épica 13758 · Feature #14089 · Mockup: pendiente (lo publica el hilo).

## Superficie tocada

Página `apps/web/src/pages/Clients.tsx` (pestañas Clientes | Proveedores), sin pantalla nueva ni `PageSlug` nuevo:

1. `components/clientes/TabProveedores.tsx`: modal de alta/edición de proveedor (hoy solo SOAT: nombre, estrategia, umbral OCR, ANS) y lista.
2. Edición de compañía en `Clients.tsx`: bloque «Logística» (hoy casilla `logisticaAutogestionable`, pintada invertida: «FLITO gestiona») + chip y filtro en la lista de Clientes.
3. Diálogo de desactivar proveedor (`DialogoEstadoRegistro`), hoy ya con impacto.

Tono de la pantalla: **usted** (ya asentado en Clientes/Proveedores: «Cree el primero…»). Público: operador interno.
Qué vino a hacer: (a) dar de alta un proveedor del tipo correcto; (b) encender logística en una compañía y dejarle proveedor; (c) encontrar las compañías con logística que aún no tienen proveedor y asignárselo.
Mensajería propia: no hay transportadoras externas; el copy nunca dice «transportadora».

## Delta de claridad (qué se ve / qué se calla)

**Alta de proveedor (un solo formulario).** Primero, arriba, el selector **Tipo de proveedor** (`FiltroSegmentado` o radios del kit: «SOAT» | «Logística»), con SOAT preseleccionado. Los campos cambian según el tipo; los del otro tipo no se muestran ni se envían.

| Tipo | Campos visibles | Obligatorios |
|---|---|---|
| SOAT | Los actuales, sin cambio | Los actuales |
| Logística | Nombre, NIT, Contacto, Teléfono, Activo (`FlitSwitch`, por defecto encendido) | Nombre y NIT. Contacto y teléfono opcionales (rótulo «(opcional)») |

- NIT: `^\d{5,15}(-\d)?$` validado al salir del campo y al guardar. Error en línea: «Escriba el NIT solo con números, con dígito de verificación opcional (ej. 900123456-7).». Sin puntos ni espacios. Duplicado (409): bajo el campo NIT, patrón `ErrorNit` de `nitDuplicado.tsx`.
- En **edición** el tipo se muestra como texto fijo (chip «SOAT» / «Logística»), no editable: cambiar de tipo sería otro proveedor.
- Una sola primaria en el modal: «Crear proveedor» / «Guardar cambios»; «Cancelar» secundaria. La primaria de la pestaña sigue siendo «Nuevo proveedor» (no se añade otro botón).
- Aviso corto bajo el selector de tipo en Logística: «Presta el servicio de logística (viajes) a las compañías que lo tengan asignado.» (una frase, sin mecánica interna).

**Lista de proveedores.** Misma tabla; se añade solo la columna **Tipo** (chip) junto a Estado, y el filtro por tipo (pills Todos | SOAT | Logística) al lado del de estado. Estrategia/Umbral OCR/ANS siguen y muestran «—» en Logística (no se agrega una columna Contacto: va al modal de edición; se evita densidad). Para Logística, columna extra no: el número de compañías asignadas vive en el diálogo de baja y en el modal de edición («Asignado a 3 compañías»).

**Edición de compañía.** Bloque «Logística» con el switch «Logística» (la semántica de la columna invertida actual se conserva: encendido = FLITO gestiona logística, ver pregunta 1).
- Encendido: aparece `FlitSelect` **«Proveedor de logística»**, obligatorio (asterisco + `aria-required`), solo proveedores de tipo Logística y activos (más el actual si quedó inactivo, rotulado «(inactivo)»). Sin elegir, «Guardar» queda deshabilitado y el campo muestra «Elija el proveedor que atenderá los viajes de esta compañía.».
- Apagado: el selector se oculta y el texto de ayuda dice «Sin logística de FLITO, la compañía se encarga de sus viajes y no tendrá viajes en FLITO.». El proveedor asignado **no se borra**: se conserva en el servidor, y queda como línea de solo lectura «Proveedor conservado: X. Mientras esté asignado, no se puede inactivar.». Al volver a encender, el selector llega con ese valor.
- Sin proveedores de logística activos: el selector muestra el vacío «No hay proveedores de logística activos.» y, si tiene permiso, el enlace «Crear proveedor» (abre el modal de alta con tipo Logística preseleccionado); si no, «Pida a un administrador que cree uno.».

**Lista de Clientes: compañías sin proveedor (AC3).** No hay columna nueva. En la celda existente «Logística» (`CeldaFlag`), cuando está encendida y sin proveedor se muestra el chip de aviso **«Sin proveedor»** (`StatusChip`/`ChipSinGestion` en tono de atención, con texto, no solo color). Encima de la tabla, un filtro píldora **«Sin proveedor (N)»** junto a las pills de estado (patrón `EstadoRegistro`); al activarlo solo quedan esas compañías. Con el filtro activo, el chip abre directo la edición de esa compañía (con foco en el selector de proveedor). Aviso de página persistente (`role="status"`) sobre la tabla mientras N > 0: «N compañías con logística no tienen proveedor asignado. Asígneles uno para que puedan registrar viajes.» con el botón-enlace «Ver compañías». Desaparece cuando N = 0 (no es toast: sigue siendo cierto al mirar la página).

**Se calla / va al detalle:** contacto y teléfono de logística (solo en el modal de edición); historial de asignaciones; NIT del proveedor en la lista (el nombre identifica la fila); jerga como «ANS» ya existente no se extiende a Logística.

Densidad: **sin cambio relevante** (una columna Tipo, un filtro, un chip dentro de una celda existente). No se pide decisión al PO por esto.

## Estados (4) + copy

| Superficie | Cargando | Error | Vacío | Lleno |
|---|---|---|---|---|
| Lista de proveedores | Esqueleto de la tabla (`PageContentSkeleton`/filas; hoy es texto «Cargando proveedores…»: se conserva si el implementador no cambia el patrón) | «No pudimos cargar los proveedores.» + **Reintentar** (`role="alert"`) | Sin ninguno: «No hay proveedores. Cree el primero con «Nuevo proveedor».» (sin permiso: «No hay proveedores. Pida a un administrador que los registre.»). Con filtro de tipo/estado sin resultados: `VacioFiltro` «Ver todos» | Tabla con chip de tipo |
| Selector «Proveedor de logística» | «Cargando proveedores…» deshabilitado | «No pudimos cargar los proveedores de logística.» + Reintentar en línea; guardar deshabilitado | «No hay proveedores de logística activos.» + siguiente paso (arriba) | Opciones activas |
| Lista de Clientes con filtro «Sin proveedor» | El estado de carga existente de Clientes | El existente (Reintentar) | «Todas las compañías con logística tienen proveedor.» + botón «Ver todas» | Filas filtradas |
| Modal de proveedor al guardar | Botón «Guardando…» deshabilitado | Error de campo en línea; otro fallo: `role="alert"` en el modal «No pudimos guardar el proveedor. Intente de nuevo.» | n/a | n/a |

## Responsive + feedback del delta (qué pasa <lg; hover/focus de lo nuevo; toast vs aviso)

- <lg: el modal ocupa el ancho disponible y los campos van en una columna (`grid-cols-1`, `sm:grid-cols-2` solo para Contacto/Teléfono); el selector de tipo envuelve; las pills de filtro (estado, tipo, «Sin proveedor») envuelven con `flex-wrap`; la tabla usa el scroll horizontal de `FlitTable`; el aviso de página se apila y el botón-enlace queda debajo del texto.
- Feedback: selector de tipo, pills, chip «Sin proveedor» (clicable cuando abre la edición), botón-enlace del aviso, switch y select llevan hover sutil (`--flit-bg-hover`) y foco `flit-focus`; el chip no clicable no tiene hover.
- Notificaciones: guardar proveedor / asignar proveedor → **toast** cerrable de una frase: «Proveedor creado.», «Cambios guardados.», «Proveedor asignado a {compañía}.». Errores de campo (NIT inválido/duplicado, proveedor requerido) → **en línea**. Falla de red al guardar → alerta en el modal. «Hay compañías sin proveedor» → **aviso de página**, no toast. Nunca el texto crudo del API.

**Inactivar proveedor asignado (AC6).** En el diálogo de desactivar (`DialogoEstadoRegistro`), si el impacto dice que tiene compañías asignadas (logística, incluidas las que tienen logística apagada pero lo conservan), el diálogo se abre en modo bloqueo: sin botón de confirmar, solo «Entendido». Copy: «No se puede inactivar a {nombre}: está asignado a {n} compañía(s) ({nombres, hasta 3 y «y N más»}). Asigne otro proveedor a esas compañías y vuelva a intentarlo.». Si el servidor responde 409 igualmente (carrera): toast «Ese proveedor sigue asignado a compañías. Recargamos la lista.» y recarga. `fraseImpactoProveedor` debe sumar «proveedor de logística de N compañías» para Logística. La baja (eliminar) mantiene su regla actual y suma el mismo motivo.

## Permiso/slug

Sin página nueva. Se reutilizan los slugs de la página actual. Las acciones de alta, edición y asignación de proveedor exigen la función de **gestión de proveedores** (hoy `editable` para crear/editar; estado en `parametrizacion.proveedores.estado`; eliminar en `parametrizacion.proveedores.eliminar`). Sin ella:
- No se ve «Nuevo proveedor», «Editar», ni el selector de tipo; la lista es solo lectura.
- En la edición de compañía, el selector de proveedor se muestra deshabilitado como texto («Proveedor de logística: X» o «Sin proveedor») y no hay enlace «Crear proveedor».
- El chip «Sin proveedor», el filtro y el aviso de página **sí** se ven (informan), pero el aviso no lleva «Ver compañías» editable ni abre la edición.
Los slugs/permisos finales de la función de gestión los confirma architecture (ver pregunta 3). Roles solo de `USER_ROLES`; `operaciones` no existe.

## Datos (confirmar con architecture/backend; no inventar)

Hoy existe `GET/…/flito/parametrizacion/proveedores-soat` (+ `/:id/impacto`, `PATCH /:id/estado`). Se requiere, si aún no existe: listado de proveedores con `tipo` (`SOAT|LOGISTICA`) y campos de logística (NIT, contacto, teléfono); `proveedorLogisticaId` y `proveedorLogisticaNombre` en `GET /clients`; impacto con compañías asignadas (conteo y nombres) para el bloqueo de baja; validación server-side de «logística encendida exige proveedor» y del NIT. La PII del contacto/teléfono viaja en body, nunca en query/URL (`AGENTS.md` §14).

## Notas para QA (≤10)

1. Alta Logística: sin NIT o con NIT `1234`, `12345-67`, `abc` falla en línea; `12345`, `900123456-7`, 15 dígitos pasan.
2. Contacto y teléfono vacíos guardan; Activo por defecto encendido.
3. Cambiar el tipo en el alta limpia los campos del otro tipo y no los envía.
4. Compañía: encender logística sin proveedor no deja guardar; apagar guarda sin pedir proveedor y lo conserva (volver a encender lo muestra).
5. Compañías existentes con logística encendida y sin proveedor muestran el chip y entran en el filtro «Sin proveedor (N)»; N baja al asignar.
6. Proveedor asignado (incluso a compañía con logística apagada): inactivar muestra el bloqueo con el número correcto.
7. Usuario sin gestión de proveedores: no hay alta, edición ni selector activo; sí ve chip/filtro/aviso.
8. 4 estados de lista y de selector, con Reintentar funcional.
9. Móvil 360 px: modal sin desborde, filtros envuelven, tabla con scroll propio; ambos temas.
10. Teclado: orden de foco tipo → campos → Cancelar/primaria; foco al primer error al guardar.

## Accesibilidad

`<label>` asociado a cada campo (incluye selector de tipo como `fieldset` + `legend`); obligatorios con `aria-required`; errores con `aria-invalid` + `aria-describedby` y foco al primer campo inválido (patrón de `TabProveedores`); chip con texto («Sin proveedor»), no solo color; aviso con `role="status"`; el modal devuelve el foco al disparador; bloqueo de baja anunciado en el diálogo (`role="alertdialog"`). Contraste ≥ 4.5:1 en ambos temas con tokens `--flit-*`.

## Decisiones y descartes

- Un solo modal con selector de tipo (lo pide el AC), no dos botones «Nuevo proveedor SOAT / Logística» (serían dos primarias).
- Sin columna «Proveedor de logística» en Clientes: el chip dentro de la celda existente y el filtro bastan; la tabla ya está apretada.
- Sin pestaña nueva «Logística»: el proveedor es el mismo catálogo con tipo.
- Sin banner/ilustración/animación; el aviso es una tarjeta del kit y se retira solo al llegar a 0.
- Componentes del kit: `FlitModal`, `FlitField`, `flitInp`, `FlitSelect`, `FlitSwitch`, `FiltroSegmentado`, `FlitTable/Th/Tr`, `FlitEmpty`, `ChipEstado`/`StatusChip`/`ChipSinGestion`, `EstadoRegistro` (pills, `VacioFiltro`), `DialogoEstadoRegistro`, `MenuFila`, `toastOk/toastError`, `flitBtnPrimary/Secondary`. Ningún patrón visual nuevo.

## Preguntas abiertas para David (máx. 4)

1. Hoy la columna `logisticaAutogestionable` se muestra invertida («FLITO gestiona»). ¿«Logística encendida» en la HU significa «FLITO gestiona logística» (autogestionable = false)? Se asume que sí.
2. ¿«Sin proveedor» debe bloquear algo en la operación (p. ej. no poder crear viajes para esa compañía) o es solo marca de limpieza de datos? Cambia la urgencia del aviso.
3. ¿Qué permiso exacto es «gestión de proveedores»: el `editable` actual de Clientes o uno nuevo (`parametrizacion.proveedores.*`)? ¿Quién puede asignar proveedor en la compañía: el mismo?
4. Al apagar logística con proveedor conservado: ¿se muestra el proveedor conservado en solo lectura (propuesto) o se oculta del todo?

## Brief de mockup

- Pantallas: (1) Pestaña Proveedores con columna Tipo y pills de tipo; (2) modal alta Logística y modal alta SOAT; (3) edición de compañía con logística encendida (selector obligatorio, error en línea) y apagada (proveedor conservado); (4) lista de Clientes con chip «Sin proveedor», filtro «Sin proveedor (3)» y aviso de página; (5) diálogo bloqueo de baja; (6) vista móvil de (2) y (4).
- Estados: cargando, error con Reintentar, vacío (copy arriba), lleno.
- Datos ficticios: proveedores «Logística Andina S.A.S.» NIT 900123456-7, «Rutas del Norte» NIT 800555111; compañías «Compañía Ejemplo 1…5». Sin PII real.
- No mostrar: contacto/teléfono en la lista, historial, columnas extra en Clientes.
- Usar tokens `--flit-*` y el Artifact «Design System»; nunca HEX sueltos.

HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: /home/david/flit/flito/docs/ux/proveedores-logistica-formulario-14105-slim.md
  Oficio: primaria única | jerarquía dicha | vacío con siguiente paso | responsive dicho | feedback dicho | notificación elegida | sin efectos
  Densidad: sin cambio
  Pantallas: 6 | Requerimientos nuevos de datos: tipo/campos de logística en proveedores, proveedor de logística en GET /clients, impacto con compañías asignadas (a confirmar con architecture)
  Mockup: brief listo
  Siguiente: respuestas de David a las 4 preguntas → hilo publica mockup (Artifact design) y espera «ok» humano → architecture-agent (datos) → frontend-agent
  Reconocimiento: 9
