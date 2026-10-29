# UX slim — Logística · catálogo de motivos de llegada a FLIT (HU #14120)

Feature C3.1 #14093 · Épica #13758 · API ya existe (HU #14119). Flujo LOCAL.
Mockup: publicado 2026-10-29 (lleno + modal 409). **Sin «ok» humano no se lanza frontend-agent**.

Público: operador interno de Logística (siembra: `admin`; el resto, desde el panel). Tono de **esta** pestaña: **usted** (pedido de la HU; la ficha de ayuda `flito_logistica.md` ya usa usted). No se unifica el resto de la consola, que tutea en varios copy.

---

## Oficio (respondido por escrito)

| Pregunta | Respuesta |
|---|---|
| ¿Qué vino a hacer quien abre esto? | Administrar el catálogo: crear un motivo, corregir el nombre, dejarlo en el orden en que debe aparecer al registrar un viaje a FLIT, o apagarlo / volverlo a encender. |
| ¿Qué se ve primero? | La lista de motivos en el orden de aparición, con el nombre y el estado. Eso decide «este es el que toco». |
| ¿Qué se calla y dónde vive? | El `id` uuid (`data-id` de fila, nunca en pantalla ni en URL). El entero `orden` (el orden *se ve* como posición en la lista). Quién lo creó y cuándo (auditoría de servidor). Precio, guía, proveedor, «tipo transportadora» (el sembrado es solo un nombre). Borrar: no existe. |
| ¿Cuál es la única primaria? | **«Nuevo motivo»** (`flitBtnPrimary`) en la pestaña. Editar, Subir, Bajar y Activar/Desactivar son de fila. El modal tiene su propia primaria («Crear motivo» / «Guardar cambios») porque tapa la lista. |
| ¿El vacío y el error dicen el siguiente paso? | Sí: el vacío manda a «Nuevo motivo»; el error de carga trae **Reintentar**; el 403 no se pinta como error de lista (la pestaña no existe). |
| ¿Efectos o patrón nuevo? | No. Kit `flit/` + `MenuFila` + `FlitModal`. Sin drag-and-drop, sin página nueva, sin HEX. |
| ¿Móvil (&lt;`lg`)? | La barra de pestañas envuelve; primaria bajo el título; pills envuelven; tabla con scroll de `FlitTable`; modal a una columna. |
| ¿Feedback? | Todo control (pestaña, pills, Subir/Bajar, Editar, ⋮, primaria, ✕ del modal, toast) con hover `--flit-bg-hover` y foco `flit-focus`. |
| ¿Notificación? | Éxito de crear/editar/ordenar/estado → **toast** cerrable de una frase. Duplicado y validación → **en línea** en el modal. Fallo de lista → aviso en la pestaña + Reintentar. |

---

## Decisión de superficie: pestaña, no página nueva

**Se elige pestaña gated en `FlitoLogistica.tsx`.** Sin `PageSlug` nuevo, sin `lazy()` extra, sin ítem de menú.

| | A. Pestaña en la consola (elegida) | B. Página nueva (`lazy()` + `hasPage`) |
|---|---|---|
| Visita | Quien ya está en Logística y tiene la función opcional de `ver_consola` | Segunda puerta: menú + slug + árbol |
| AC4 | Sin `logistica.motivos.gestionar` la pestaña **no se pinta** y **no hay GET** (calco Viajes a cliente / LT pendientes) | Habría que inventar `PageSlug` y un nodo de página que HU #14119 no creó |
| Análoga | `TabProveedores`: catálogo CRUD como pestaña del dominio, no ruta | `FlitoServiciosAdicionales`: página propia porque es Finanzas, con valor, slug y roles propios |
| Densidad | La pestaña **solo la ve quien tiene la función** (siembra: admin). El operador diario sigue con las pestañas operativas | Un ítem de menú para ~3–10 filas es ruido |

**Por qué no B.** La función vive como *opcional* de `accion.logistica.ver_consola`, no como acción de página. Crear slug + nav duplicaría la puerta y contradice el contrato de #14119. El catálogo no es el trabajo de quien abre Trámites: por eso no se mezcla en esa tabla, se aísla en su pestaña, al **final** de la barra, etiqueta **«Motivos de llegada»**, sin badge.

**Implementación (nota para frontend, no se codea aquí):** extraer `TabMotivosLlegada.tsx` en `components/flito/logistica/` (calco `ViajesACliente` / `TabProveedores`) para no empujar `FlitoLogistica.tsx` al techo de 800. La página solo añade la entrada en `TABS` con `hasFuncion('logistica.motivos.gestionar')`. El `PageHeaderCard` de la consola **no cambia** (sigue hablando de trámites); el título de trabajo vive *dentro* de la pestaña.

---

## Superficie tocada

- `apps/web/src/pages/FlitoLogistica.tsx` — una pestaña más, gated.
- Componente nuevo de pestaña (no de kit): lista + modal + diálogo de estado.
- Ruta existente `/flito/logistica`, slug existente `flito_logistica`.
- **No** se toca Mi ruta, Viajes a cliente, el viaje a FLIT (HU #14122), ni la ficha de ayuda en esta HU (el delta de `flit-ayuda-flito` lo declara el hilo en pre-PR: la pestaña **sí** cambia lo visible de un módulo con ficha).

---

## Delta de claridad (qué se ve / qué se calla)

**Siempre visible en la pestaña (lleno):**

1. Título **«Motivos de llegada»** + una frase: «Motivos por los que un organismo llega a las instalaciones de FLIT. El orden de esta lista es el que verá al registrar un viaje a FLIT.»
2. Primaria **Nuevo motivo**.
3. Pills de estado (kit `FiltroEstadoPills`): Todos | Activos | Inactivos. Filtro **en cliente** sobre el GET de todos (el admin tiene que ver inactivos para reactivarlos). **No** usar `?soloActivos=true` en esta pantalla: ese query es del viaje a FLIT.
4. Tabla, en el orden del API (`orden`, `nombre`): **Motivo** (nombre) · **Estado** (`ChipEstado`) · **Acciones**.

**Acciones de fila (secundarias, no primarias):**

| Control | Qué hace |
|---|---|
| **Subir** / **Bajar** (`flitBtnIconoSm`, `aria-label` «Subir {nombre}» / «Bajar {nombre}») | Intercambia `orden` con el vecino de la lista **completa** (no de la vista filtrada) y recarga. Primero: Subir apagado. Último: Bajar apagado. Sin drag-and-drop. |
| **Editar** (`flitBtnSecondarySm`) | Abre el modal con el nombre. |
| **⋮** (`MenuFila`) | «Desactivar» o «Activar». |

**Modal crear/editar — un solo campo:**

- **Nombre** (obligatorio, 1–120, trim). Label asociado. `aria-required`.
- No hay campo Orden: el alta manda `orden: max(existentes)+10` (lista vacía → 10) para que el nuevo quede **al final**. Reordenar es Subir/Bajar.
- Primaria del modal: **Crear motivo** / **Guardar cambios**. **Cancelar** secundario.

**Diálogo de estado (`FlitModal`, no `DialogoEstadoRegistro`):** ese diálogo pide impacto de clientes/proveedores y no aplica. Copy:

- Desactivar: «Si desactiva «{nombre}», no aparecerá al registrar un viaje a FLIT. El histórico de viajes conserva el motivo.» Primaria **Desactivar** (tono peligro del kit: `--flit-danger-ink` en el texto, botón `flitBtnPrimary` — no inventar un botón rojo nuevo). Cancelar secundario.
- Activar: ««{nombre}» volverá a aparecer al registrar un viaje a FLIT.» Primaria **Activar**.

**Se calla / no está:**

- Columna con el entero `orden`, uuid, auditoría, NIT, precio, guía, transportadora como tipo.
- **Eliminar** / DELETE.
- Filtro de búsqueda (el catálogo es corto).
- Cambio del `PageHeaderCard` global.
- Tratamiento especial del sembrado «Destino lejano (transportadora externa)»: es un nombre más.

Densidad de la consola para quien **no** tiene la función: **sin cambio**. Para admin: una pestaña más al final, lista corta. No se pregunta al PO.

### Wireframe (contrato de estructura)

Lleno, escritorio:

```
Logística                                          ← PageHeaderCard (sin cambio)
Trámites | Viajes a cliente | Actas | … | Motivos de llegada
────────────────────────────────────────────────────────────
Motivos de llegada                    [ Nuevo motivo ]  ← única primaria
Motivos por los que un organismo llega a las
instalaciones de FLIT. El orden de esta lista es
el que verá al registrar un viaje a FLIT.

Estado:  ( Todos )  Activos  Inactivos

┌ Motivo                                      Estado     Acciones          ┐
│ Sin dirección de entrega al recoger         Activo     ↑ ↓ Editar  ⋮     │
│ Destino lejano (transportadora externa)     Activo     ↑ ↓ Editar  ⋮     │
│ Otro                                        Activo     ↑ ↓ Editar  ⋮     │
└──────────────────────────────────────────────────────────────────────────┘
Mostrando 3 de 3
```

Modal crear:

```
┌ Nuevo motivo de llegada ──────────────────────────── ✕ ┐
│ Nombre *                                                │
│ [________________________________]                      │
│                                                         │
│                    [ Cancelar ]  [ Crear motivo ]       │
└─────────────────────────────────────────────────────────┘
```

Duplicado (modal abierto, error en línea, foco en Nombre):

```
Nombre *
[Otro                              ]  ← aria-invalid
Ya existe un motivo de llegada con ese nombre.
Cambie el nombre o edite el que ya está en la lista.
```

---

## Estados (4) + copy

GET al **entrar a la pestaña**, no al montar la consola. Sin función: cero peticiones.

| Superficie | Cargando | Error | Vacío | Lleno |
|---|---|---|---|---|
| Lista | Esqueleto de **esa** tabla (3 filas, mismas columnas; `role="status"` «Cargando motivos de llegada…»). No un spinner genérico. | Red/5xx: «No pudimos cargar los motivos de llegada.» + **Reintentar** (`role="alert"`, `--flit-danger-ink`). 403 en el GET (función retirada a media sesión): «No tiene permiso para gestionar los motivos de llegada.» **sin** Reintentar — no es fallo transitorio. | Sin ningún motivo: «No hay motivos de llegada. Cree el primero con «Nuevo motivo».» Filtro sin resultados: `VacioFiltro` «Ningún motivo {activos/inactivos}.» + **Ver todos**. | Tabla en orden de aparición |
| Modal al guardar | Primaria «Guardando…» deshabilitada | Nombre vacío/largo: en línea. 409: en línea (copy abajo). Otro fallo: `role="alert"` en el modal «No pudimos guardar el motivo. Intente de nuevo.» | n/a | n/a |
| Diálogo estado | Primaria «Guardando…» deshabilitada | `role="alert"` en el diálogo «No pudimos cambiar el estado. Intente de nuevo.» 404: se cierra, toast, recarga | n/a | n/a |

**Copy 409 (nunca el crudo del API, aunque el servidor ya traiga una frase):** «Ya existe un motivo de llegada con ese nombre. Cambie el nombre o edite el que ya está en la lista.» `aria-invalid` + `aria-describedby` + foco en Nombre. El modal **sigue abierto**.

**422** de nombre vacío: «Escriba el nombre del motivo.» Largo: «El nombre admite máximo 120 caracteres.»

---

## Responsive + feedback del delta

- **&lt;`lg`:** la barra de pestañas de la consola ya envuelve (`flex-wrap`); **Nuevo motivo** pasa debajo del título de la pestaña (misma altura de control); pills envuelven; `FlitTable` con scroll horizontal del kit (Motivo se lee primero; Acciones al final, sin `min-w` que desborde); modal a una columna, primaria y Cancelar apilados a ancho disponible, Cancelar arriba o a la izquierda según el patrón de `FlitModal` ya usado en la consola; Subir/Bajar permanecen icono con `aria-label` (el toque es 28 px del kit, no se agranda con un patrón nuevo).
- **Feedback:** pestaña, pills, `flitBtnIconoSm`, Editar, ⋮, primaria, Cancelar, ✕, toasts: hover `--flit-bg-hover` y `flit-focus`. Subir/Bajar deshabilitados se ven `disabled` (opacidad del kit), sin hover de acción. `transition-colors` ≤ `--flit-duration-base`. Sin sombras extra, drag, ni animación de reorden.
- **Temas:** solo tokens `--flit-*` (error `--flit-danger-ink`, no `text-red-600`). Los dos temas.

### Notificaciones (una por acción)

| Acción | Canal | Copy |
|---|---|---|
| Crear | toastOk, 4 s, cerrable | «Motivo creado.» |
| Editar nombre | toastOk | «Cambios guardados.» |
| Subir / Bajar | toastOk | «Orden actualizado.» |
| Desactivar | toastOk | «Motivo desactivado. No aparecerá al registrar un viaje a FLIT.» |
| Activar | toastOk | «Motivo activado.» |
| 409 / validación | en línea en el modal | ver Estados |
| Red al guardar | alerta en modal o toastError con Reintentar si el diálogo ya cerró | «No pudimos guardar el motivo. Intente de nuevo.» |
| 404 al editar/estado | toastError + recarga | «Ese motivo ya no está. Recargamos la lista.» |
| Lista fallida | aviso en página | no toast |

Un toast por acción (`id` estable). Nunca `e.message`. El filtro activo es estado de la vista: **no** es toast.

---

## Permiso/slug

- Página: `hasPage(..., 'flito_logistica')` — ya existe. **Sin PageSlug nuevo.**
- Pestaña y todas las acciones: `hasFuncion('logistica.motivos.gestionar')`.
- Sin la función: **no se pinta la pestaña**, no hay GET/POST/PATCH, no hay «Nuevo motivo» ni menú de fila. Quien solo tiene `logistica.consola.ver` sigue igual que hoy.
- Roles: solo `USER_ROLES`. No diseñar `operaciones`. La siembra es `admin`; otros roles la ganan en el panel, no en esta HU.
- PII: ninguna. Query `soloActivos` no se usa aquí. Ids en path del PATCH, no en el router de la SPA.

---

## Datos (existentes; cero endpoints nuevos)

`GET/POST /api/flito/logistica/motivos-llegada` · `PATCH /:id` · `PATCH /:id/estado`.
DTO `{ id, nombre, activo, orden }`. 409 duplicado (`lower(nombre)`). Sin DELETE.

Alta: `POST { nombre, orden: max+10 }`. Editar nombre: `PATCH { nombre }`. Ordenar: dos `PATCH { orden }` (intercambio con el vecino de la lista completa). Estado: `PATCH /:id/estado { activo }`.

---

## Accesibilidad

- Pestaña de la consola: calcar el `tablist`/`tab` ya usado en Logística (hoy los botones no exponen `role="tab"`: **no se rediseña la barra en esta HU**; el botón nuevo es gemelo de los existentes, con `flit-focus` y hover).
- `<label>` en Nombre; obligatorios `aria-required`; error `aria-invalid` + `aria-describedby`; foco al primer inválido al guardar.
- Subir/Bajar y ⋮ con `aria-label` que nombra el motivo. Chip de estado con texto («Activo» / «Inactivo»), no solo color.
- Modal y diálogo devuelven el foco al disparador (`restoreFocusRef`).
- Contraste ≥ 4.5:1 / foco ≥ 3:1, claro y oscuro.

---

## Notas para QA (≤10)

1. Sin `logistica.motivos.gestionar`: no existe la pestaña; DevTools no muestra GET a `/motivos-llegada` al abrir Logística.
2. Con la función: pestaña al final; GET al entrar (no antes); seed visible en orden 10/20/30 (nombres sembrados).
3. Crear «Otro» (o el mismo nombre distinta capitalización) → 409 en línea, modal abierto, sin toast de error crudo.
4. Crear un nombre nuevo → queda **al final**; Subir lo mueve; Bajar del último deshabilitado.
5. Desactivar → desaparece de Activos, sigue en Todos/Inactivos; toast de una frase; no hay Eliminar.
6. Activar desde Inactivos → vuelve a Activos; toast.
7. 4 estados de lista (esqueleto, Reintentar, vacío con siguiente paso, lleno) y modal.
8. Móvil 360 px: primaria debajo del título, pills envuelven, tabla con scroll propio, modal una columna. Ambos temas.
9. Teclado: orden Título → Nueva → pills → Subir/Bajar/Editar/⋮; en el modal Nombre → Cancelar → primaria; foco visible.
10. Usuario con consola y sin la función no ve acciones «escondidas» en Trámites ni en el header.

---

## Decisiones y descartes

- **Pestaña, no página:** ver sección de decisión. Oficio: no saturar el menú ni inventar slug.
- **Subir/Bajar, no drag ni campo numérico:** el orden *es* la lista; el entero `orden` es implementación. Drag sería patrón nuevo.
- **Alta al final (`max+10`):** el default 0 del API metería el nuevo *arriba* de los sembrados.
- **`FlitModal` de estado, no `DialogoEstadoRegistro`:** ese diálogo es de impacto Clientes/Proveedores; aquí no hay endpoint de impacto.
- **Filtro en cliente, GET de todos:** hace falta ver inactivos. `soloActivos` es del viaje a FLIT.
- **Usted solo en esta pestaña:** pedido de la HU. No se reescribe Trámites/Actas.
- **Sin efectos, sin KPI, sin búsqueda.** Tres a diez filas se escanean.

Kit: `PageHeaderCard` (intocado), pestañas existentes, `FlitCard`, `FlitTable`/`FlitTh`/`FlitTr`, `FlitEmpty`, `FlitField`, `flitInp`, `FlitModal`, `StatusChip` / `ChipEstado`, `FiltroEstadoPills` / `VacioFiltro` / `PieConteo`, `MenuFila`, `flitBtnPrimary` / `flitBtnSecondary` / `flitBtnSecondarySm` / `flitBtnIconoSm`, `toastOk` / `toastError`. Cero componentes nuevos en `components/flit/`.

---

## Brief de mockup

El hilo publica Artifact `design` con el Design System FLITO (https://claude.ai/artifact/3EphuzBBadDZ1fGEVKWNCP) y espera **«ok»** humano.

**Pantallas / vistas (una por vista, 4 estados navegables + móvil):**

1. Consola Logística · pestaña Motivos · **lleno** (wireframe de arriba). Datos ficticios, **sin PII real:** «Sin dirección de entrega al recoger», «Destino lejano (transportadora externa)», «Otro», «Documentos incompletos en el organismo».
2. Mismos datos · **cargando** (esqueleto de tabla).
3. **Error** de carga + Reintentar.
4. **Vacío** total + primaria visible.
5. Filtro Inactivos sin filas → `VacioFiltro`.
6. Modal **Nuevo motivo** (vacío y con error 409 en línea).
7. Modal **Editar** con nombre cargado.
8. Diálogo **Desactivar**.
9. Vista **móvil 360 px** de (1) y (6).

**No mostrar:** entero `orden`, uuid, menú Eliminar, pestaña si el prototipo simula usuario sin función (añadir una vista 0: consola *sin* la pestaña, para AC4), drag handles, página de menú nueva.

**Copy exacto** de vacío/error: el de «Estados (4)». Toasts: una frase, con ✕.

**Tokens:** `--flit-*` del Design System. Nunca HEX sueltos.

---

HANDOFF
  Modo: slim
  Resultado: OK
  Entrega: docs/ux/logistica-motivos-llegada-14120-slim.md
  Oficio: primaria única («Nuevo motivo») | jerarquía dicha (lista en orden) | vacío con siguiente paso | responsive dicho | feedback dicho | notificación elegida (toast vs en línea vs aviso) | sin efectos
  Densidad: sin cambio (pestaña solo con la función)
  Pantallas: 1 pestaña + modal + diálogo | Requerimientos nuevos de datos: ninguno
  Mockup: brief listo
  Siguiente: hilo publica mockup (Artifact design) y espera «ok» humano → frontend-agent
  Reconocimiento: 12
