# UX slim — Viajes adicionales en el detalle del trámite (HU #12620 · Feature #12617 · Épica #12244)

## Superficie tocada
`DetalleModal` de `apps/web/src/pages/FlitoLogistica.tsx` (~L306): `FlitModal wide` con ficha de 6 datos + «Bitácora». Se añade **una sección** entre la ficha y la bitácora. Sin ruta, página ni `PageSlug` nuevos. Tono de la consola: **tú** (calca «Selecciona…», «Crea un usuario…»).

## Delta de claridad (qué se ve / qué se calla)
- **Quien abre el detalle** viene a saber en qué está la licencia y, desde esta HU, si el trámite ya tuvo viajes extra y cuánto suman. La ficha sigue arriba, sin cambios; la bitácora sigue abajo. La sección va **en medio**, con el mismo `h3` uppercase que «Bitácora» para no inventar jerarquía.
- **Siempre visible** en la sección: los dos totales (`Viajes: N` · `Adicionales: $suma`) y la lista corta (una fila por viaje). El motivo detallado de «Otro» y la tarifa del instante van en la segunda línea de la fila, en texto muted: se consultan, no se operan.
- **Única primaria del modal**: «Registrar viaje». Hoy el `DetalleModal` no tiene ninguna; sigue habiendo una sola. Vive al pie de la sección, no en la cabecera del modal (la cabecera es del trámite, no de los viajes).
- **Qué NO se añade**: columna de precio en la cola de trámites, chip/contador en la fila del listado, «Editar» viaje, sumatoria calculada en cliente, KPI de adorno, precio en el acta ni en su PDF (regla dura: esta sección es la **única** superficie de la consola logística que enseña precios).
- **Densidad**: aliviada frente al patrón de Finanzas (sin buscador, sin catálogo). Añade ~4 renglones típicos al modal; el `wide` ya tiene scroll propio. No empeora.

## Wireframe — sección dentro del DetalleModal (estado lleno, con permisos)
```
 Trámite FLIT   FLIT-10234        Empresa      Transportes Andes
 …ficha actual sin cambios…
 ─────────────────────────────────────────────────────────────────
 VIAJES ADICIONALES
 Viajes: 3 (incluye el viaje 1)              Adicionales: $107.000
 ┌───────────────────────────────────────────────────────────────┐
 │ Viaje 2 · $45.000 · Tarifa vigente                   [Quitar] │
 │   Devolución · Ana Ríos · 15/09/26 10:12                      │
 ├───────────────────────────────────────────────────────────────┤
 │ Viaje 3 · $62.000 · Precio manual (tarifa $45.000)   [Quitar] │
 │   Otro: cliente pidió entrega en sede norte · L. Mora · …     │
 └───────────────────────────────────────────────────────────────┘
                                             [ Registrar viaje ]   ← única primaria
 ─────────────────────────────────────────────────────────────────
 BITÁCORA
 …sin cambios…
```
Confirmación de «Quitar» **en la fila** (no un segundo diálogo, como `FilaServicioAdicional`): reemplaza la fila por
`Se quitará el viaje N.º 3 de $62.000. Para corregirlo tendrás que registrarlo de nuevo.  [Cancelar] [Quitar viaje]` (botón `--flit-danger`, secundario).

## Wireframe — `ModalRegistrarViaje` (FlitModal sin `wide`)
```
 Registrar viaje · FLIT-10234                                  [×]
 Motivo (obligatorio)
 [ Selecciona…                                        ▾ ]  Devolución | Segunda entrega | Documento faltante | Otro
 Detalle (obligatorio, máx. 300)               ← solo si «Otro»
 [                                                      ]  No escribas datos personales.   0/300
 Precio
 (•) Precio inicial   Se copiará la tarifa vigente: $45.000
 ( ) Nuevo precio     [ $ ______ ]  COP, sin decimales
 ⚠ mensaje del servidor (role=alert), el modal no cierra
                                   [Cancelar]  [Registrar]  ← deshabilitado hasta validez
```
Sin tarifa (`tarifaVigente === null`): «Precio inicial» deshabilitado con la leyenda «La compañía no tiene tarifa de logística vigente»; «Nuevo precio» preseleccionado y el campo con foco. Nunca se muestra «$0» como tarifa a copiar.

## Estados (4) + solo lectura, copy exacto
| Estado | Qué se ve |
|---|---|
| Cargando | Encabezado con el `h3` y un esqueleto de 2 filas (forma de la lista) con `role="status" aria-label="Cargando viajes…"`. La ficha y la bitácora no esperan a esta carga. |
| Vacío | `Viajes: 1 (incluye el viaje 1)` · `Adicionales: $0` + `FlitEmpty`: «Sin viajes adicionales. El viaje 1 se cobra con la tarifa vigente.» Si puede registrar: «Registra el siguiente con «Registrar viaje», aquí abajo.» La primaria sigue en el pie. |
| Error (5xx/red) | `role="alert"`: «No se pudieron cargar los viajes de este trámite. <errorMessage>» + botón secundario **Reintentar**. Solo la sección falla; ficha y bitácora siguen. |
| Error 403 | «No tienes permiso para ver los viajes.» Sin Reintentar (no lo arregla). El resto del detalle intacto. Si el montaje ya se hizo por `hasFuncion`, este caso es la caché de 60 s de permisos. |
| Lleno | Wireframe de arriba. Fijación: «Tarifa vigente» \| «Precio manual (tarifa $X)» \| «Precio manual · sin tarifa vigente». Autor y fecha con el `fecha()` de la página. |
| Solo lectura · liquidado | Encabezado + lista sin «Quitar» ni primaria; aviso muted: «Trámite liquidado: reversa la liquidación para registrar o quitar viajes.» |
| Solo lectura · autogestión | `gestionaLogistica=false`: encabezado + lista (si hubiera) sin botones; aviso muted: «La logística de esta compañía la gestiona el cliente.» |

Errores de escritura por `codigo` (POST y DELETE), en línea, sin cerrar el modal ni la confirmación: `TRAMITE_LIQUIDADO` → «El trámite ya está liquidado. Reversa la liquidación para cambiar los viajes.» y la sección pasa a solo lectura en caliente; `LOGISTICA_AUTOGESTIONADA` → «La logística de esta compañía la gestiona el cliente.»; `TARIFA_LOGISTICA_NO_CONFIGURADA` → «La compañía no tiene tarifa de logística vigente. Elige «Nuevo precio».» y se fuerza el modo manual. Tras 201/204: recargar la lista, anunciar «Viaje N.º 3 registrado.» / «Viaje N.º 3 quitado.», devolver el foco a «Registrar viaje».

## Spec breve de componentes
**`ViajesLogistica`** (`apps/web/src/components/flito/logistica/ViajesLogistica.tsx`) — props: `tramiteId: string`, `idFlit: string`, `puedeRegistrar`, `puedeQuitar: boolean` (resueltos con `hasFuncion`, nunca por rol), `onCambio?: () => void`. Lee del GET: `{ items, totalViajes, totalAdicionales, tarifaVigente: number|null, liquidado, gestionaLogistica }`; no suma en cliente. Montaje condicionado a `hasFuncion('logistica.viajes.ver')` desde `DetalleModal`. Región `<section aria-labelledby>` con el `h3`; totales en `<p role="status" aria-live="polite">` (uno solo en la sección; los anuncios de escritura van en un `sr-only` aparte). Cada fila `<li>`; «Quitar» con `aria-label="Quitar viaje 3"`; la confirmación en fila mueve el foco a «Cancelar»; `Esc` cancela la confirmación. Precio: `n.toLocaleString('es-CO', { style:'currency', currency:'COP', maximumFractionDigits:0 })` — el mismo `pesos` de `components/flito/ImpuestoCola.tsx` (moverlo a `lib/` si se reusa, no duplicar).

**`ModalRegistrarViaje`** — props: `tramiteId`, `idFlit`, `tarifaVigente: number|null`, `busy`, `onClose`, `onRegistrado(viaje)`. `FlitModal` (trae `role=dialog`, `aria-modal`, `useFocusTrap`, `restoreFocusRef` → botón «Registrar viaje»). Foco inicial en el `select` de motivo (o en «Nuevo precio» si no hay tarifa). `FlitField` con `label` en cada control; el detalle de «Otro» con `maxLength=300`, `aria-describedby` a la leyenda «No escribas datos personales» y contador; radios de precio en `fieldset/legend="Precio"`; `input type=number inputMode=numeric min=0 step=1`. Validez: motivo elegido ∧ (no «Otro» ∨ detalle.trim() ≥ 1) ∧ (inicial con tarifa ∨ manual con entero ≥ 0). `Enter` en el campo de precio envía si es válido; `Esc` cierra si no está `busy`. Error del servidor en `<p role="alert">` bajo el formulario.

Datos: GET/POST/DELETE de viajes del backend de la Feature #12617 (rutas y campos exactos los fija la HU backend; esta spec asume el contrato del prompt). PII: el detalle de «Otro» viaja en el body, nunca en query; la leyenda es la única guarda de la UI.

## Permiso/slug
Sin slug nuevo: la página sigue siendo `flito.logistica`. Funciones: `logistica.viajes.ver` (monta la sección), `logistica.viajes.registrar` (primaria), `logistica.viajes.quitar` (acción de fila). Roles que las ven: los que Operaciones asigne en el módulo de roles configurables; la UI no consulta rol.

## Oficio
- **Primaria = «Registrar viaje»**: es el único trabajo que se ejecuta aquí; ver y quitar son consulta y corrección. Una sola en todo el modal.
- **«Quitar» secundaria y destructiva con confirmación en fila**: borra dinero cobrable sin «Editar» (decisión de la HU: la corrección es registrar de nuevo), así que la confirmación dice qué se pierde y cuál es el camino de vuelta. En fila y no en otro modal porque ya estamos dentro de uno.
- **COP** con el mismo formato de la consola (`es-CO`, sin decimales, `tabular-nums`): no se inventa otro `pesos`.
- **Precio manual ≥ 0 sin tope**: decisión de negocio de la Feature; la UI solo exige entero no negativo y muestra la tarifa del instante al lado para que el operador vea la desviación. `$0` es válido como precio manual; lo que nunca aparece es `$0` como «tarifa a copiar».
- Sin efectos ni patrón nuevo: `FlitModal`, `FlitField`, `FlitEmpty`, botones del kit, `h3` de la propia página.

## Notas para QA (≤10)
1. Sin `logistica.viajes.ver` la sección no existe en el DOM; ficha y bitácora intactas.
2. Con `ver` pero sin `registrar`/`quitar`: lista y totales sí, ningún botón.
3. Vacío muestra «Viajes: 1» y «$0» en Adicionales; el `FlitEmpty` nombra la primaria solo si puede registrar.
4. `tarifaVigente=null`: «Precio inicial» deshabilitado con su leyenda, «Nuevo precio» preseleccionado; no se ve «$0» como tarifa.
5. «Otro» sin detalle → «Registrar» deshabilitado; con 301 caracteres el input corta en 300.
6. Manual con `-1` o decimales → deshabilitado; `0` → habilitado.
7. 409 `TRAMITE_LIQUIDADO` en POST: el modal muestra el error, no cierra; al cerrarlo la sección ya está en solo lectura.
8. Quitar: la confirmación cita N.º y precio exactos; `Esc`/Cancelar devuelve la fila; tras 204 el total baja y el `aria-live` anuncia.
9. Error 5xx del GET: solo la sección cae; «Reintentar» recarga la sección, no el modal.
10. Acta y PDF del acta: ningún precio, antes y después de registrar viajes.
