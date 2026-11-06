# UX slim — Proveedores con varios servicios: formulario y lista (HU #14336, #14337)

Feature F2 #14324 · Épica #13757 · Diseño técnico: `docs/adr/ADR-0039-…` (§4.2, §4.3, §7.1) ·
Pantalla `apps/web/src/pages/Clients.tsx`, pestaña **Proveedores** (`TabProveedores`) + modal
`FormProveedor` · Análoga: `docs/ux/clientes-estado-filtro-13948-slim.md`.

Módulo: habla con `flito-parametrizacion` (`/flito/parametrizacion/proveedores`), no con el legacy `soat`.

Mockup: montado con los componentes reales del kit, en un archivo descartable ya retirado; capturas aprobadas en `docs/ux/mockups/proveedores-14324-*.png`. **Donde este documento y la maqueta difieran, manda la maqueta:** conserva el orden de columnas de hoy, con Estado antes de las acciones, y «Ver detalle» y «Editar» como botones.

## Superficie tocada

| Superficie | Cambio |
|---|---|
| `FormProveedor` (modal) | El selector de un tipo pasa a selector múltiple de servicios; bloque «Datos de la empresa» con siete campos; bloque «Datos de SOAT» condicionado; avisos de datos pendientes y de edición simultánea |
| `TabProveedores` (tabla) | Columna «Tipo» → «Servicios», filtro «Tipo» → «Servicio», sale «Contacto y teléfono», entran las columnas de SOAT, «Estado» sube a tercera columna |
| Baja (⋮) | La regla deja de depender de un tipo único y pasa a mirar si el proveedor presta Logística y tiene compañías en ese servicio. Modal y copy sin cambio |

Público: operador interno que administra proveedores. **Qué vino a hacer:** en la lista, encontrar un
proveedor y saber qué servicios presta y si está activo; en el formulario, registrar o corregir una
empresa y los servicios que presta.

## Oficio

| Pregunta | Respuesta |
|---|---|
| ¿Qué se ve primero? | Lista: nombre, servicios y estado. Formulario: los servicios, porque deciden qué más se pide |
| ¿Qué se calla? | Teléfono, correo, dirección y contacto solo en detalle y edición; el listado no los trae (ADR §7.1). Historial: no existe en esta épica, sin enlace ni «última edición por» |
| Primaria | Lista: «Nuevo proveedor». Modal: «Crear proveedor» / «Guardar cambios». En detalle no hay primaria, solo «Cerrar» |
| Vacío y error | Dicen el siguiente paso (ver Estados) |
| Efectos y patrones nuevos | Ninguno. El bloque de SOAT aparece y desaparece sin animación |
| Móvil, feedback, notificación | Ver «Responsive + feedback» |

## Delta del formulario

**Ancho:** `FlitModal` con `wide` (`max-w-2xl`). Son once campos; en `max-w-md` obligaría a mucho scroll.

**Orden:** Servicios → Datos de la empresa → Datos de SOAT (si aplica) → compañías asignadas → acciones.

### Alta (y edición de un proveedor con datos completos)

```
┌ Nuevo proveedor ─────────────────────────────────────────────── ✕ ┐
│ Servicios que presta *                                            │
│ [x] SOAT     [ ] Logística                                        │
│                                                                   │
│ Datos de la empresa                                               │
│ Los proveedores de FLITO son empresas: registre el nombre y el    │
│ NIT de la empresa, no los de una persona natural.                 │
│ Nombre de la empresa *         NIT *                              │
│ [____________________]         [900123456-7_______]               │
│ Teléfono *                     Correo *                           │
│ [____________________]         [__________________]               │
│ Dirección *                    Ciudad *                           │
│ [____________________]         [__________________]               │
│ Persona de contacto *                                             │
│ [____________________]                                            │
│                                                                   │
│ Datos de SOAT                     ← solo con SOAT marcado         │
│ Estrategia                                                        │
│ [p.ej. portal, correo_________________________]                   │
│ Umbral OCR (0–1)               ANS pactado (horas)                │
│ [____________________]         [__________________]               │
│                                                                   │
│                              ( Cancelar )  (( Crear proveedor ))  │
└───────────────────────────────────────────────────────────────────┘
```

- **Selector:** casillas nativas dentro de `<fieldset>` + `<legend>`, con el patrón de `BolsaForm`
  (`<label>` con `hover:bg-[var(--flit-bg-hover)]`, input con `flit-focus`). No pills: en este kit las
  pills se leen como elección única, y aquí se pueden marcar las dos.
- **Empresa:** se dice dos veces y sin adorno: el título del bloque y una frase de ayuda
  (`text-sm`, `--flit-text-secondary`). No hay selector de tipo de persona (decisión del humano: solo empresas).
- **Datos de SOAT:** se ven solo con SOAT marcado. Al desmarcarlo se ocultan y no se envían, pero
  **no se borra lo escrito**: si se vuelve a marcar en la misma edición, sigue ahí. Hoy `cambiarTipo`
  limpia los campos; eso desaparece. Los datos generales nunca se limpian al cambiar servicios.
- **Logística:** sin bloque propio. Con Logística marcada se conserva `AVISO_LOGISTICA` bajo el selector.
- **Sin campo «Activo»** (ver pregunta P3).

### Edición de un proveedor con datos pendientes (regla 9)

Se aplica a quien tiene `datosCompletos = false`. Mientras nadie toque un dato general, el formulario
no pide nada: sin asteriscos, sin chip de alerta, sin toast y sin mover el foco.

```
┌ Editar proveedor ────────────────────────────────────────────── ✕ ┐
│ Servicios que presta *                                            │
│ [x] SOAT     [ ] Logística                                        │
│                                                                   │
│ Datos de la empresa                                               │
│ Los proveedores de FLITO son empresas: registre el nombre y el    │
│ NIT de la empresa, no los de una persona natural.                 │
│ Faltan datos de esta empresa. Puede guardar otros cambios sin     │
│ completarlos; si edita alguno de estos datos, se piden todos.     │
│ Nombre de la empresa           NIT                                │
│ [Aseguradora Ejemplo_]         [__________________]               │
│ …                                                                 │
│                             ( Cancelar )  (( Guardar cambios ))   │
└───────────────────────────────────────────────────────────────────┘
```

- Texto normal (`text-sm`, `--flit-text-secondary`), no alerta.
- **Tocar** es que un valor quede distinto del inicial, no enfocar el campo. Si lo devuelve a como
  estaba, vuelve al estado anterior.
- Al tocar un dato general aparecen los asteriscos en los siete campos y la nota cambia a
  «Como editó datos de la empresa, complete todos los campos marcados con *.» (`role="status"`).
- Solo se envía `generales` si se tocó. Así cambiar SOAT o servicios no dispara el 422 de R9.
- **Consecuencia que el operador debe conocer:** corregir el nombre de un proveedor antiguo exige
  completar los siete. Es lo que dice R9; se deja escrito para QA.

### Validaciones y mensajes

La validación corre al guardar, y «Guardar» **no** se deshabilita por campos vacíos: un botón apagado
impediría ver «Marque al menos un servicio». Se apaga solo mientras guarda y tras un conflicto de edición.

Tratamiento **usted**, el de esta pantalla.

| Caso | Copy | Dónde |
|---|---|---|
| Sin servicio | **Marque al menos un servicio** | Bajo el selector; foco en la primera casilla |
| NIT repetido | **Ya existe un proveedor con ese NIT: [nombre]** | Bajo NIT (`ErrorCampo`, `aria-invalid`, foco) |
| Quitar servicio bloqueado | **No puede quitar [servicio]: [motivo y cantidad]** | Bajo el selector, `role="alert"`; la casilla vuelve a quedar marcada, porque el servicio sigue activo |
| Campo general vacío | «Este dato es obligatorio.» *(propuesto)* | Bajo el campo; foco en el primero |
| Correo inválido | «Escriba un correo válido, por ejemplo contacto@empresa.com.» *(propuesto)* | Bajo el campo |
| NIT inválido | `ERROR_NIT`, sin cambio | Bajo el campo |
| Nombre repetido | Ver pregunta P4 | Bajo Nombre |
| 422 de R9 | Se traduce campo por campo a «Este dato es obligatorio.» | Bajo cada campo |
| Otro fallo | `mensajeErrorGuardar`, sin cambio | `role="alert"` sobre las acciones |

Ejemplos de **[motivo y cantidad]**, a partir de los bloqueos de ADR §4.3:

- «No puede quitar SOAT: tiene 2 compañías asignadas y 3 reglas de enrutamiento»
- «No puede quitar Logística: tiene 3 compañías asignadas y 1 gestión abierta»

«Gestión abierta» agrupa SOAT sin terminar, actas y LT abiertas. Solo se nombran los motivos con
cantidad mayor que cero, y el singular se ajusta. No se bloquea la casilla por adelantado: solo el
servidor conoce reglas y gestiones (`GET /:id/impacto` exige otro permiso), y dos reglas distintas
para el mismo caso confundirían.

### Edición simultánea

```
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ Otro usuario cambió este proveedor mientras usted editaba.    │ │
│ │ Lo que escribió no se guardó. Al recargar verá los datos      │ │
│ │ actuales y perderá lo que escribió.        ( Recargar datos ) │ │
│ └───────────────────────────────────────────────────────────────┘ │
│                     ( Cancelar )  (( Guardar cambios — apagado )) │
```

- Con el 409 `PROVEEDOR_EDITADO_POR_OTRO`, el aviso va en el modal, encima de las acciones, con
  `role="alert"` y el foco en «Recargar datos». No es toast: es un error del modal y sigue siendo cierto.
- Lo escrito sigue visible, para que el operador pueda copiarlo antes de recargar.
- «Guardar cambios» queda deshabilitado hasta recargar. Reenviar con la versión vieja fallaría igual.
- «Recargar datos» (`flitBtnSecondary`) pide `GET /:id`, reemplaza el formulario con la versión nueva,
  quita el aviso y lleva el foco a la primera casilla. Si falla: «No pudimos recargar el proveedor.
  Inténtelo de nuevo.», y el botón sigue disponible.
- Al cerrar el modal, la lista hace `recargar()`.
- Copy propuesto en usted porque el del ADR tutea (ver pregunta P5).
- Sin vista de diferencias ni fusión: no está en el alcance.

### Detalle (solo lectura)

- Servicios como `StatusChip` neutros, no casillas. «Datos de SOAT» solo si presta SOAT.
- Sin asteriscos (hoy se ve «Nombre *» en detalle: se corrige) y sin la nota de datos pendientes.
  Un dato vacío se ve como «—».
- Una línea de compañías: la actual si tiene un solo servicio; con dos,
  «Asignado a 2 compañías en SOAT y 3 en Logística.». También en edición: explica de antemano un bloqueo.

## Delta de la lista

```
 [ Clientes ][ Proveedores ]
 (( Nuevo proveedor ))                                   ← única primaria (sin cambio)
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ Estado                          Servicio                                                  │
│ ( Todos )( Activos )( Inactivos )   ( Todos )( SOAT )( Logística )                        │
│                                                                                           │
│ Nombre          Servicios         Estado     NIT          Compañías asignadas             │
│                                              Umbral OCR  ANS pactado                      │
│ ───────────────────────────────────────────────────────────────────────────────────────── │
│ Seguros Andina  [SOAT]            [Activo]   —            2                               │
│ Datos por completar                          0,85        24 h              Ver Editar ⋮   │
│ Envíos del Sur  [Logística]       [Activo]   900123456-7  3                               │
│                                              —           —                 Ver Editar ⋮   │
│ Red Integral    [SOAT][Logística] [Inactivo] 800987654-3  2 SOAT · 3 Logística            │
│                                              0,90        48 h              Ver Editar ⋮   │
│                                                                                           │
│ Mostrando 3 de 3                                                                          │
│ El ANS de gestión es único para toda la operación… (nota al pie, sin cambio)              │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Es una sola fila por proveedor; el dibujo la parte en dos solo para que quepa. Orden real:
**Nombre · Servicios · Estado · NIT · Compañías asignadas · Umbral OCR · ANS pactado · acciones.**

- **Servicios:** un `StatusChip tone="neutral"` por servicio, siempre SOAT y luego Logística,
  `flex flex-wrap gap-1`. El texto es el dato: sin colores por servicio.
- **Filtro «Servicio»:** `FlitPillGroup` + `FlitPillButton` con `pressed`, en cliente sobre lo cargado.
  Un proveedor con los dos aparece en ambas opciones. Usa rótulo visible con `aria-labelledby`, como
  `FiltroEstadoPills`. Cambia el `aria-label="Tipo"` actual.
- **Estado:** sube a tercera columna para que identificador y estado se vean sin scroll
  (`_principios-flito.md`, Jerarquía; igual que en Clientes).
- **Columnas de SOAT (decisión del humano, P1):** solo Umbral OCR y ANS pactado; Estrategia queda en detalle y formulario. Logística no las necesita: «—» en los proveedores sin SOAT y, con el filtro «Logística», las dos columnas desaparecen.
- **Compañías asignadas:** con un servicio, el número; con dos, «2 SOAT · 3 Logística». No se suman:
  una compañía puede tener al mismo proveedor en los dos servicios y se contaría doble.
- **NIT:** «—» en los antiguos que no lo tienen.
- **«Datos por completar»:** línea `text-xs` en `--flit-text-muted` bajo el nombre, solo si
  `datosCompletos = false` y el usuario puede editar. No es chip ni filtro: muchos proveedores
  SOAT antiguos la tendrán, y un chip llenaría la tabla de alarmas.
- **Se va «Contacto y teléfono»:** el listado nuevo no los trae (ADR §7.1). Quedan en detalle y edición.

**Densidad:** sale una columna y entran dos, 8 en total; 6 con el filtro «Logística».

### Baja

| Proveedor | Compañías | Resultado al elegir «Desactivar» |
|---|---|---|
| Solo SOAT | Con o sin compañías | `DialogoEstadoRegistro`, se puede inactivar |
| Solo Logística | Con compañías | Modal existente «No se puede inactivar» (`textoBajaBloqueada`) |
| Solo Logística | Sin compañías | `DialogoEstadoRegistro` |
| SOAT + Logística | Con compañías en Logística | Modal «No se puede inactivar»; el total y los nombres son solo de Logística |
| SOAT + Logística | Solo en SOAT | `DialogoEstadoRegistro` |

Consecuencia en el diálogo: una sola frase para todos, porque inactivar siempre invalida sesiones
(ADR §4.2): `CONSECUENCIA_DESACTIVAR` y `CONSECUENCIA_ACTIVAR`. Se retiran las variantes de logística.

Carrera (alguien asignó compañías o cambió el proveedor entre el diálogo y el clic): toast y recarga,
como hoy. `PROVEEDOR_EDITADO_POR_OTRO` en la baja dice «Otro usuario cambió este proveedor. Recargamos la lista.»

## Estados (4) + copy

| Estado | Qué se ve | Filtros y pie |
|---|---|---|
| Cargando | «Cargando proveedores…», sin cambio | Ocultos |
| Error | `role="alert"`: «No pudimos cargar los proveedores.» + **Reintentar**, sin cambio | Ocultos |
| Vacío sin proveedores | `FlitEmpty`: «No hay proveedores. Cree el primero con «Nuevo proveedor».» o, sin permiso, «No hay proveedores. Pida a un administrador que los registre.», sin cambio | Ocultos |
| Vacío del filtro | `VacioFiltro`: «No hay registros con este filtro.» + **Ver todos**, que limpia Estado y Servicio | Visibles; «Mostrando 0 de Y» |
| Lleno | Tabla de arriba | Visibles; «Mostrando X de Y» |

```
Cargando                                Error
┌──────────────────────────────┐        ┌──────────────────────────────────────────────┐
│ Cargando proveedores…        │        │ No pudimos cargar los proveedores. (Reintentar)│
└──────────────────────────────┘        └──────────────────────────────────────────────┘

Vacío sin proveedores                   Vacío del filtro
┌──────────────────────────────┐        ┌──────────────────────────────────────────────┐
│ ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐ │        │ Estado (…)   Servicio (Todos)(SOAT)(Logística)│
│ ╎ No hay proveedores. Cree  ╎ │        │ ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐ │
│ ╎ el primero con «Nuevo     ╎ │        │ ╎ No hay registros con este filtro.         ╎ │
│ ╎ proveedor».               ╎ │        │ ╎               ( Ver todos )               ╎ │
│ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ │        │ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ │
└──────────────────────────────┘        │ Mostrando 0 de 12                            │
                                        └──────────────────────────────────────────────┘
```

Cambiar un filtro no pide datos ni pasa por «Cargando». Abrir editar o detalle pide `GET /:id`; si
falla, sigue el toast «No pudimos abrir el proveedor. Inténtelo de nuevo.».

## Responsive + feedback del delta

**Móvil (<`lg`):**

- Los dos grupos de filtros envuelven y quedan uno bajo otro, con rótulo encima de las pills.
- La tabla usa el scroll horizontal de `FlitTable`, sin desbordar la página. Nombre, Servicios y
  Estado se ven al entrar; las acciones quedan al final del scroll, sin columna fija, como hoy.
- Los chips de un proveedor con dos servicios pueden caer en dos líneas dentro de su celda.
- El modal ocupa el ancho disponible con su scroll propio. Las rejillas son `grid-cols-1 sm:grid-cols-2`
  y las casillas envuelven con `flex-wrap`. Las acciones del pie envuelven.

**Feedback:**

- Casillas: `<label>` entero clicable, hover `--flit-bg-hover`, foco `flit-focus`.
- Pills, botones, `MenuFila` e inputs: los del kit, sin cambios.
- Chips, «Datos por completar», notas y pie no son interactivos: sin hover ni cursor de mano.

**Notificación:**

| Acción | Patrón | Copy |
|---|---|---|
| Crear / guardar | Toast cerrable | «Proveedor creado.» / «Cambios guardados.» |
| Validación, NIT repetido, quitar servicio | En línea en el modal | Tabla de mensajes |
| Edición simultánea | Aviso en el modal | Sección propia |
| Desactivar / activar | Toast cerrable, como hoy | «Proveedor desactivado.» / «Proveedor activado.» |
| Filtrar | Ninguna; lo dicen la pill y el pie | — |

Nunca el error crudo del API. Las dos excepciones son los mensajes pedidos de NIT y de quitar servicio,
con el nombre y las cantidades que entregue el servidor.

**Contraste y temas:** solo tokens con par oscuro: `--flit-text-primary`, `--flit-text-secondary`,
`--flit-text-muted`, `--flit-danger-text`, y `StatusChip`. Ningún HEX ni valor del texto antiguo de la
Épica. La verificación cubre claro y oscuro, ≥ 4.5:1 en texto y ≥ 3:1 en foco.

## Kit reutilizado

| Pieza | Uso |
|---|---|
| `FlitModal` (`wide`), `FlitField`, `flitInp` | Formulario |
| `ErrorCampo` (`ErrorNit` de `nitDuplicado`) | Errores bajo campo |
| `flitBtnPrimary`, `flitBtnSecondary` | Acciones |
| Patrón de casilla de `BolsaForm` | Selector de servicios |
| `StatusChip`, `ChipEstado` | Servicios y estado |
| `FlitCard`, `FlitTable`, `FlitTh`, `FlitTr`, `FlitEmpty` | Lista |
| `FlitPillGroup`, `FlitPillButton`, `FiltroEstadoPills` | Filtros |
| `PieConteo`, `VacioFiltro`, `MenuFila`, `DialogoEstadoRegistro` | Pie, vacío, ⋮ y baja |

Sin componentes ni tokens nuevos.

## Datos: requerimientos para `architecture-agent` / `backend-agent`

El módulo unificado de F2 aún no existe en `apps/api`. Lo siguiente sale del ADR-0039 §7.1, y estos
cuatro puntos no están cerrados allí:

1. **El listado no trae datos de SOAT.** `GET /` entrega `{id, nombre, nit, servicios[], activo,
   companiasPorServicio, datosCompletos, version}`. Las columnas pedidas necesitan además
   `estrategia`, `umbralOcr` y `slaHoras`. Depende de P1.
2. **Guardar debe ser una sola acción para el operador.** El contrato separa `PATCH /:id` de
   `POST|DELETE /:id/servicios/:servicio`, y solo el PATCH lleva `versionEsperada`. Con varias llamadas:
   un fallo deja el proveedor a medias, y si cada una sube `version`, el PATCH siguiente choca con
   la edición del mismo usuario. **Preferido:** que `PATCH /:id` acepte `servicios[]` en una sola
   transacción. **Si se mantiene separado:** las llamadas de servicio devuelven la `version` nueva y el
   orden es quitar → agregar → PATCH. R7 obliga a agregar SOAT antes de enviar su configuración. El
   primer «No puede quitar» detiene todo sin escribir nada. Un fallo posterior se avisa así: «Los
   servicios se actualizaron, pero no los demás datos. Inténtelo de nuevo.»
3. **El 409 de quitar servicio debe traer cantidades por motivo**, o el texto ya compuesto, para
   armar el mensaje exacto sin mostrar un error técnico.
4. **El 409 de NIT repetido debe traer el nombre del otro proveedor** con el copy nuevo. La expresión
   `DUPLICADO` de `FormProveedor` espera el formato anterior y hay que actualizarla.

Otros datos: `datosCompletos` y `version` vienen en el listado; el formulario de edición lee
`GET /:id` con datos personales. Ciudad es texto libre (`varchar(100)` en el ADR).

**PII:** sin datos en URL ni en query del SPA. `servicio` no es PII. Teléfono, correo, dirección y
contacto no van en la lista.

## Permiso/slug

- Página y `PageSlug` de Clientes, sin cambio. Sin slug nuevo.
- Ver lista, chips y filtros: quien abre la pestaña.
- Crear y editar, incluidos servicios: `editable` (funciones `…proveedores.crear` / `.editar` del ADR).
- Desactivar / Activar: `…proveedores.estado`. Eliminar: `…proveedores.eliminar`.
- La función `historial` del ADR no se usa en UI en esta épica.

## Decisiones de producto cerradas

| # | Tema | Decisión |
|---|---|---|
| **P1** | Columnas de SOAT | Decisión del humano: Logística no las necesita. Quedan Umbral OCR y ANS pactado para SOAT; «—» en los demás y ocultas al filtrar por Logística |
| **P2** | Proveedor antiguo que suma un servicio | Decisión del humano: agregar un servicio cuenta como editar, así que se exigen los datos generales, incluido el NIT |
| **P3** | «Activo» en el alta | Decisión del hilo: se retira; todo proveedor nace activo |
| **P4** | Nombre repetido | Decisión del hilo: «Ya existe un proveedor con ese nombre: [nombre]» |
| **P5** | Copy de edición simultánea | Decisión del hilo: el del wireframe, en usted |

## Notas para QA (≤10)

1. Alta sin servicio → «Marque al menos un servicio», foco en la primera casilla, nada se envía.
2. Marcar y desmarcar SOAT muestra y oculta sus datos; desmarcado no se envían; al volver a marcar sigue lo escrito.
3. Alta con siete generales vacíos → error bajo cada uno. El formulario dice que el proveedor es una empresa.
4. Proveedor antiguo: cambiar solo el umbral guarda sin pedir generales ni mostrar asteriscos. Al tocar un general o agregar un servicio aparecen los asteriscos y se piden los siete.
5. NIT repetido → mensaje exacto bajo NIT, también con otro formato o sin dígito de verificación.
6. Quitar servicio con compañías, reglas o gestión abierta → mensaje exacto con cantidades; la casilla vuelve a marcada y el proveedor queda intacto. Quitar el último → «Marque al menos un servicio».
7. Dos sesiones sobre el mismo proveedor: la segunda ve el aviso, lo escrito sigue visible, guardar apagado; «Recargar datos» trae lo actual.
8. Lista: una etiqueta por servicio; el mixto aparece en ambos filtros; columnas SOAT con «—» en Logística; vacío del filtro con «Ver todos»; error con «Reintentar». No aparecen teléfono ni contacto.
9. Baja: los cinco casos de la tabla. Carrera: toast y recarga.
10. Teclado y lector: casillas agrupadas por la leyenda, errores asociados con `aria-describedby`, foco visible. Claro y oscuro; móvil de 360 px sin desborde de página.

## Decisiones y descartes

- **Casillas, no pills** para el selector: las pills sugieren elección única.
- **Sin chip ni banner para datos pendientes:** afectaría a muchos proveedores sin que haya nada urgente.
- **Sin aplicar servicios al instante:** una casilla que guarda sola, dentro de un formulario con «Guardar», crea dos formas de guardar.
- **Sin desactivar la casilla por adelantado** al no poder quitar un servicio: el cliente no conoce todos los motivos.
- **Sin cambiar `textoBajaBloqueada`:** el pedido dice que el bloqueo ya existe. En un mixto, la cifra es de Logística y la fila lo muestra rotulado.
- **Sin historial, sin colores por servicio, sin vista de diferencias:** fuera de alcance o adorno.

## Brief de mockup

**Archivo:** `docs/ux/mockups/proveedores-servicios-14324.html`, autocontenido, con las clases y tokens del
kit (`--flit-*`, nunca HEX), sin JS de negocio ni red. Capturas a 1366×768 y 375×812, en claro y oscuro.

**Vistas de lista** (wireframes de «Delta de la lista» y «Estados»): lleno, cargando, error, vacío sin
proveedores, vacío del filtro. Móvil del estado lleno.

**Vistas de formulario:**

1. Alta con SOAT marcado.
2. Alta con solo Logística (sin bloque de SOAT).
3. Antiguo con datos pendientes, sin tocar.
4. Antiguo tras tocar un general, con asteriscos.
5. «Marque al menos un servicio».
6. NIT repetido.
7. «No puede quitar SOAT…».
8. Aviso de edición simultánea.
9. Detalle de solo lectura.
10. Móvil de la vista 1.

**Componentes:** los de «Kit reutilizado».

**Datos ficticios, sin PII real:** Seguros Andina (SOAT, datos por completar, portal, 0,85, 24 h, 2
compañías) · Envíos del Sur (Logística, 900123456-7, 3 compañías) · Red Integral (ambos, inactivo,
800987654-3, correo, 0,90, 48 h, 2 SOAT · 3 Logística) · contacto@empresa.com · Calle 00 # 00-00.

**Copy:** el exacto de este documento.

**No mostrar:** teléfono, correo, dirección o contacto en la lista; historial; selector de tipo de persona;
«Activo» en el alta; colores por servicio; dos primarias.
