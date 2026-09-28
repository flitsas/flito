# UX slim — Tipo de servicio al aplicar un pago de servicios adicionales (Bug #12913)

Feature #12607 · Épica #12245. Público: operador interno (Finanzas/Operaciones). Módulo `flito-comprobantes` + servicios adicionales del trámite (`finanzas`). Fichas previas: `flito-comprobantes-panel-asociacion-12634-slim.md`, `flito-comprobantes-carga-y-asociacion.md`, `finanzas-reporte-costos-servicios-adicionales.md` §6.2.

## Superficie tocada
1. `PanelAsociacion` dentro de `DetalleComprobante` (comprobante `pendiente`, `esPago`, concepto = servicios adicionales).
2. Chip/diferencia del reporte de costos (`lib/diferenciaDocumental.ts`).
3. Lista del `PanelServiciosAdicionales` del trámite.

## Delta de claridad (qué se ve / qué se calla)
- **Orden de campos:** Trámite → Concepto → **Tipo de servicio** (nuevo, solo si concepto = servicios adicionales y documento = pago) → Valor → [Aplicar]. Aparece justo tras elegir el concepto; si el concepto cambia a otro, el campo desaparece y su valor se limpia (no queda un tipo «fantasma» enviado).
- **Label:** «Tipo de servicio» (obligatorio; asterisco del kit si el formulario ya lo usa, si no «(obligatorio)» en el label).
- **Ayuda (una línea, bajo el campo, `aria-describedby`):** «El servicio queda asignado al trámite con el valor de este comprobante. Si ya estaba asignado, se actualiza su valor.»
- **Opciones:** tipos **activos** del catálogo, nombre + valor de catálogo (como el buscador). Los ya asignados al trámite **no se excluyen** (aquí se corrigen): se marcan con texto tenue «Ya asignado · se actualizará el valor». Descripción solo en la opción, no tras elegir.
- **Tras elegir:** el campo muestra el nombre; el valor que manda es el del comprobante (el de catálogo no se repite fuera de la lista, para no ofrecer dos cifras).
- **Primaria única:** «Aplicar» se mantiene. `disabled` mientras falte el tipo (además de lo que ya lo deshabilita), con la razón visible: bajo el botón, texto tenue «Elige el tipo de servicio para aplicar.» (tono de la pantalla; si `PanelAsociacion` trata de usted: «Elija…»). No se añade botón.
- **Densidad:** +1 campo solo en ese caso; los demás conceptos no cambian.

## Estados (4) del selector + copy
- **Cargando** (catálogo al mostrarse el campo, una vez): «Cargando el catálogo…» tenue; Aplicar deshabilitado.
- **Error:** `role="alert"` «No se pudo cargar el catálogo de servicios adicionales.» + **Reintentar** (secundario). 403: «Tu usuario no puede ver el catálogo de servicios adicionales. Pídele a un administrador la función «Ver el catálogo de servicios adicionales».» sin Reintentar (copy ya existente del buscador; calcar tono).
- **Vacío (sin tipos activos):** «No hay tipos de servicio adicional activos. Actívalos en Servicios adicionales para poder aplicar este pago.» + enlace «Ir a Servicios adicionales» solo con `hasPage('flito_servicios_adicionales')`. Con búsqueda sin coincidencias: «Ningún tipo activo coincide con «…».»
- **Lleno:** listbox con resaltado del kit; opción elegida con `aria-selected`.
- **Errores al aplicar** (en línea bajo el formulario, `role="alert"`, nunca `e.message` crudo):
  - Tipo dado de baja entre carga y envío: «Ese tipo de servicio ya no está activo. Elige otro.» → repedir catálogo y limpiar la selección.
  - Trámite liquidado/sellado: «El trámite ya está liquidado: no se le pueden asignar servicios. Reversa la liquidación y vuelve a aplicar.»
  - Sin tipo (400 del API, defensa): «Elige el tipo de servicio para aplicar este pago.» y foco al campo.
- **Éxito:** toast existente de `onResuelto`, una frase: «Pago aplicado. «<Servicio>» quedó asignado a <idFlit> por <valor>.» (corrección: «…se actualizó a <valor>.»).

## Reporte: copy del chip/diferencia
- La diferencia de servicios adicionales se **resuelve al aplicar el comprobante con su tipo**, no aceptándola. Donde el globo/chip de diferencia de ese concepto sugiera aceptar, el texto dice: «Falta asignar el servicio: aplica el comprobante con su tipo de servicio en Comprobantes.» `ROTULO_ACEPTAR` no cambia para los demás conceptos; «Diferencia aceptada» sigue diciendo solo que se revisó, sin insinuar que suma. Delta de ayuda en `content/ayuda/finanzas_reporte_costos.md` (línea «Aceptar diferencia no corrige…»): añadir «En servicios adicionales, lo que suma es aplicar el pago con su tipo de servicio.»

## Panel de servicios adicionales del trámite
- Asignación con origen comprobante: `StatusChip tone="neutral"` «Desde comprobante» junto al nombre (no color nuevo). `title`/texto accesible: «Asignado al aplicar un comprobante de pago».
- Su valor es el del comprobante; «Quitar» se mantiene según permiso (sin cambio de reglas en este Bug). Si el dato de origen no viene en el DTO → requerimiento a backend (campo `origen: 'manual' | 'comprobante'`).

## Responsive + feedback del delta
- <lg: el formulario ya es una columna; el selector ocupa ancho completo (`w-full`), la lista hace scroll interno con `max-h`, el texto de ayuda envuelve. El chip «Desde comprobante» envuelve bajo el nombre.
- Opciones con hover `--flit-bg-hover` + `flit-focus`; Reintentar y enlace con foco del kit; `disabled` de Aplicar distinguible (opacidad del kit) y no quita la razón textual.
- Notificación: éxito = toast; errores = en línea (`role="alert"`); vacío/403 = aviso en el campo.

## A11y
Combobox/listbox del buscador (`aria-expanded`, `aria-activedescendant`), `<label>` visible asociado (no solo `aria-label`), `aria-required="true"`, ayuda por `aria-describedby`; Esc cierra la lista sin cerrar el modal (`stopPropagation`); al fallar «sin tipo», foco al campo.

## Permiso/slug
Sin slug nuevo. Aplicar: permiso actual de comprobantes; leer catálogo: `parametrizacion.servicios_adicionales.listar` (403 arriba). Escritura de la asignación la hace el backend al aplicar.

## Notas para QA (≤10)
1. Concepto ≠ servicios adicionales o documento no pago: el campo no aparece.
2. Aplicar deshabilitado sin tipo, con la razón visible.
3. Tipo nuevo → asignación creada con valor del comprobante; tipo ya asignado → valor actualizado, sin duplicar fila.
4. Tipo dado de baja en vuelo → mensaje y catálogo repedido.
5. Trámite liquidado → mensaje pulido, sin crudo del API.
6. 403 de catálogo → sin Reintentar; error de red → con Reintentar.
7. Cambiar concepto limpia el tipo.
8. Panel del trámite muestra «Desde comprobante»; reporte ya no invita a «aceptar» para sumar.
9. Teclado completo y tema oscuro (tokens, sin `text-red-600` nuevo).
