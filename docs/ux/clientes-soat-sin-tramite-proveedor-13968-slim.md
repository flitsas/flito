# UX slim — Clientes / SOAT sin trámite: elegir solo el proveedor (HU #13968)

Feature #13966 · Épica #13671 · Módulo `flito-parametrizacion` (no legacy) · API en HU #13967.
Reemplaza el §1 de `soat-envio-directo-al-gestor-y-gestor-por-defecto.md` (interruptor + gestor) en
lo que toca al cuadro y la columna. Lo demás de ese doc sigue vigente.

## Superficie tocada

| Superficie | Archivo | Público |
|---|---|---|
| Columna «SOAT sin trámite» de la tabla Clientes (`textoCanal` + `CeldaCanalSoat`) | `apps/web/src/pages/Clients.tsx` | Operador (admin, financiera, auditor) |
| Cuadro `ModalCanalSoat` | `apps/web/src/pages/Clients.tsx` | Operador con la acción nueva |
| Nota al pie de la tabla sobre «SOAT sin trámite» (líneas ~301-307) | `apps/web/src/pages/Clients.tsx` | Operador con la acción nueva |
| Entrada «Solicitar SOAT» y tarjeta de canal no disponible | `FlitoSoat.tsx`, `FlitoSoatSolicitud.tsx`, `components/flito/soat-cliente/TarjetaCanal.tsx` | Cliente (usted) |

**Qué vino a hacer el operador:** decir a qué proveedor salen las solicitudes de SOAT sin trámite de
una compañía, o que no salgan a ninguno. Una sola decisión, un solo control.

## Delta de claridad (qué se ve / qué se calla)

### Columna (tabla Clientes)

- Sigue **un** encabezado «SOAT sin trámite». La tabla no gana columnas.
- Texto de la celda, **neutro** (sin icono, sin color de aviso, sin chip):

  | Dato | Texto |
  |---|---|
  | Proveedor activo | `<nombre>` |
  | Proveedor inactivo | `<nombre> (inactivo)` |
  | Sin proveedor | `Sin proveedor` |

- Desaparecen «Abierto · …», «Cerrado» y «Abierto · sin gestor». `textoCanal` deja de leer
  `soatSinTramite` (deprecado) y deja de devolver `aviso`; se calcula solo con
  `gestorSoatSinTramite` / `proveedorSoatSinTramiteId`.
- Color: con la acción, el botón `flitBtnSecondary` con **su tinta por defecto** (se quita el
  `color` que hoy se inyecta). Sin la acción, `<span class="text-sm">` en `--flit-text-secondary`.
  `--flit-warning-ink` sale de esta celda.
- `permisoSinTramiteSinEfecto` **no** se pinta en la fila. Solo en el cuadro.

### Cuadro

Se va el interruptor «Canal abierto» y su ayuda. Queda:

```
┌─ SOAT sin trámite · <Compañía> ─────────────────────────── ✕ ┐
│                                                               │
│ [!] Tiene usuarios con permiso de SOAT sin trámite, pero no   │  ← solo si permisoSinTramiteSinEfecto
│     tiene proveedor elegido: el permiso no toma efecto hasta  │
│     elegirlo.                                                 │
│                                                               │
│ Proveedor de SOAT sin trámite                                 │
│ [ Sin proveedor                                         ▾ ]   │
│ A este proveedor salen las solicitudes nuevas. Con «Sin       │
│ proveedor», los usuarios de la compañía no pueden solicitar   │
│ SOAT sin trámite. Las ya radicadas conservan su proveedor.    │
│                                                               │
│ (error de guardado, role="alert", si lo hay)                  │
│                                                               │
│                                   [ Cancelar ]  [ Guardar ]   │
└───────────────────────────────────────────────────────────────┘
```

- **Qué se ve primero:** el aviso (si aplica) y debajo la lista. Nada más compite.
- **Lista** (`FlitSelect`, ya usado aquí):
  - Etiqueta: **Proveedor de SOAT sin trámite**.
  - Opciones, en este orden: `Sin proveedor` (valor `''` → se envía `null`), luego los proveedores
    **activos** por nombre, y si el asignado está inactivo se reinyecta con `nota: 'inactivo'`
    (se conserva `ofrecidos`: sin él, guardar quitaría el proveedor por la espalda).
  - Se va el placeholder «Seleccione gestor…»: «Sin proveedor» **es** un valor válido, no un vacío.
    Se va `required` y `GESTOR_REQUERIDO`: ya no hay combinación inválida que validar.
  - Ayuda (texto de arriba, `ayuda` del `FlitSelect`).
- **Aviso** (cuando `permisoSinTramiteSinEfecto === true`): bloque en página dentro del cuadro,
  encima de la lista, mismo patrón de aviso de advertencia del kit que ya usa la app (borde/fondo de
  tokens `--flit-warning*`, **texto en `--flit-warning-ink`**, no `--flit-warning`: 3,4:1 no cumple).
  Copy literal del PO. Sin icono decorativo; si el kit pone uno, `aria-hidden`.
  Se mantiene visible mientras el cuadro esté abierto aunque se elija proveedor en el borrador: el
  dato es del servidor y cambia al guardar.
- **Única primaria:** `GradientButton` **Guardar** (`Guardando…` mientras sale). «Cancelar» es
  `flitBtnSecondary`. Sin cambios de peso respecto a hoy.
- Si el valor elegido es igual al actual, **Guardar** cierra sin petición y sin toast.
- Petición: `PATCH /flito/parametrizacion/companias/:id` con **solo**
  `{ proveedorSoatSinTramiteId: uuid | null }`. Ya no se envía `soatSinTramite`.

### Nota al pie de la tabla

Reemplazar el párrafo de «SOAT sin trámite» (habla de «abrir» y de «gestor») por:

> «SOAT sin trámite» dice a qué proveedor salen las solicitudes que los usuarios Cliente de la
> compañía hacen sin un trámite abierto; «Sin proveedor» deja esa opción cerrada. Es independiente de
> la casilla «SOAT».

Se muestra con la acción nueva (no con `editaAutogestion`).

### Canal Cliente (usted; nunca se nombra al proveedor)

- `puedeSolicitarSoat = false` → no se pinta «Solicitar SOAT sin trámite» en el menú ni el botón
  «Solicitar SOAT» en la cola (`FlitoSoat.tsx`). Sin hueco ni botón deshabilitado: no está.
- Enlace directo a la solicitud, o `403 CANAL_DESACTIVADO` con compañía por enlace: la tarjeta de
  canal (`TarjetaCanalDeshabilitado`) con:
  > Esta opción no está disponible por ahora para su compañía. Si la necesita, comuníquese con su
  > asesor de FLITO.

  Salida secundaria existente «Volver a mis SOAT». Ninguna otra primaria.
- Usuario sin compañía: el selector solo lista compañías con proveedor (lo filtra la API). Si no hay
  ninguna, `puedeSolicitarSoat = false` y no aparece «Solicitar SOAT». Los mensajes vigentes del
  selector (`MENSAJE_COMPANIA_SIN_CANAL`, «Ninguna compañía tiene habilitado…») no cambian: no
  mencionan proveedor.

**Densidad:** aliviada (un control menos en el cuadro; la celda pierde el color de aviso y el prefijo
«Abierto ·»).

## Estados (4) + copy — cuadro

Tratamiento **usted**, igual que el cuadro actual («Seleccione», «Cree uno»).

| Estado | Qué se ve | Guardar |
|---|---|---|
| Cargando | Lista deshabilitada con mensaje del `FlitSelect`: «Cargando proveedores…» | Deshabilitado |
| Error | «No se pudieron cargar los proveedores.» + botón **Volver a cargar** (`onReintentar = recargar`) | Deshabilitado |
| Vacío (sin activos y sin asignado) | «No hay proveedores de SOAT activos. Cree uno en la pestaña Proveedores.» Sin reintento (recargar no crea proveedores) | Deshabilitado |
| Lista | Opciones según arriba, preseleccionado el actual (o «Sin proveedor») | Habilitado |

Constantes: renombrar `GESTOR_*` → `PROVEEDOR_*`; `CANAL_ETIQUETA`, `CANAL_AYUDA`, `GESTOR_VACIA`,
`GESTOR_REQUERIDO` se eliminan.

**Guardado que falla:** el cuadro **no se cierra** y el borrador se conserva. Mensaje con
`role="alert"` sobre la botonera, en `--flit-danger-ink`. **Nunca `errorMessage(err)` crudo**
(antepone el nombre del campo):

| Caso | Copy |
|---|---|
| 400/409 sobre `proveedorSoatSinTramiteId` (inactivo o inexistente — carrera) | «Ese proveedor ya no está activo. Elija otro o «Sin proveedor».» |
| 403 | «No tiene permiso para elegir el proveedor de esta compañía.» |
| Red / 5xx / otro | «No se pudo guardar el proveedor. Intente de nuevo en un momento.» |

**Éxito:** toast cerrable (éxito ~4 s, patrón `toast.success` actual) y se recarga el listado:
- Proveedor elegido: «Proveedor de SOAT sin trámite actualizado. Las solicitudes ya radicadas conservan el suyo.»
- «Sin proveedor»: «<Compañía> queda sin proveedor: sus usuarios no pueden solicitar SOAT sin trámite.»

El aviso del cuadro es aviso en página, no toast (es estado, no resultado).

## Responsive + feedback del delta

- **<lg:** la celda vive dentro del scroll horizontal de `FlitTable` (sin cambio); el texto del botón
  no se trunca a mitad de nombre (`whitespace-nowrap` como hoy). El cuadro `FlitModal` ocupa el ancho
  del móvil; el aviso y la ayuda envuelven; la botonera ya es `flex flex-wrap justify-end`.
- **Feedback:** el botón de la celda y los de la botonera son del kit (`flitBtnSecondary`,
  `GradientButton`) con hover sutil y `flit-focus`; al quitar el `color` inline no se debe perder el
  hover. El `<select>` de `FlitSelect` y «Volver a cargar» conservan su foco del kit. El aviso no es
  interactivo.
- **Notificación:** éxito = toast cerrable; fallo = `role="alert"` en el cuadro; condición sin efecto
  = aviso en página del cuadro.

## Permiso/slug

- Página sin cambio (`PageSlug` actual de Clientes).
- Nuevo gate del cuadro y de la nota: `hasFuncion('parametrizacion.companias.soat_sin_tramite')`
  (acción «Elegir proveedor de SOAT sin trámite»). Variable propia, p. ej. `editaSinTramite`;
  **no** reutilizar `editaAutogestion`, que sigue gobernando las casillas, Proveedores y la ficha
  fiscal.
- Sin la acción: celda en solo lectura (`<span>`), sin cuadro, sin nota.
- **Dependencia a confirmar con #13967:** quien tenga solo la acción nueva debe poder leer
  `GET /flito/parametrizacion/proveedores-soat` (catálogo del cuadro). Si no, el cuadro caería
  siempre en Error: requerimiento para backend.
- Accesibilidad: el aviso lleva `id` y la lista lo referencia en `aria-describedby` (junto a la
  ayuda), para que el lector lo lea al llegar al control; además es texto plano visible en el orden
  del DOM antes de la lista. `aria-label` de la celda sigue conteniendo el texto visible
  («SOAT sin trámite de <Compañía>: <texto>»), nombre de la compañía, nunca su NIT. Contraste ≥ 4.5:1
  en claro y oscuro (`--flit-warning-ink`, `--flit-danger-ink`, `--flit-text-secondary`).

## Notas para QA (≤10)

1. Celda: proveedor activo → solo el nombre; inactivo → «<nombre> (inactivo)»; ninguno → «Sin proveedor». Sin color de aviso ni «Abierto/Cerrado» en ningún caso, en claro y oscuro.
2. Con `permisoSinTramiteSinEfecto = true` la fila no muestra nada extra; el cuadro muestra el aviso literal y el lector lo anuncia al enfocar la lista.
3. El cuadro no tiene interruptor; «Sin proveedor» es la primera opción y guardarla envía `{ proveedorSoatSinTramiteId: null }` (sin `soatSinTramite` en el body).
4. Asignado inactivo aparece en la lista con «inactivo» y guardar sin tocar no lo cambia.
5. Los 4 estados del catálogo con sus textos; Error → «Volver a cargar» recarga; Vacío sin reintento; Guardar deshabilitado en los tres.
6. Guardado fallido: el cuadro sigue abierto, conserva la elección y muestra el copy pulido (nunca «proveedorSoatSinTramiteId: …»).
7. Usuario sin `parametrizacion.companias.soat_sin_tramite` (aunque tenga `tramites.autogestion.desbloquear`): celda en solo lectura. Con la acción y sin `desbloquear`: abre el cuadro.
8. Cliente de compañía sin proveedor: no ve «Solicitar SOAT sin trámite» en el menú ni «Solicitar SOAT»; por URL directa ve la tarjeta literal; nunca la palabra «proveedor».
9. `403 CANAL_DESACTIVADO` al enviar con compañía por enlace → misma tarjeta.
10. Usuario sin compañía: el selector solo lista compañías con proveedor; sin ninguna, no aparece «Solicitar SOAT».
