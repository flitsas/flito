## Qué es

La pantalla donde se decide **qué puede hacer cada rol** dentro de FLITO. Muestra la lista de roles con cuántas funciones tiene cada uno y, al lado, el cuadro del rol seleccionado: sus módulos plegados con la cuenta de funciones marcadas. Desde aquí también se crean, editan y borran roles.

## Para quién

Administrador. Ningún otro rol la ve.

## Cómo se entra

Menú **Administración**, ítem **Roles y permisos**, junto a **Usuarios**.

## Pasos

1. Elija el rol en la lista de la izquierda (o en el selector **Rol** en pantallas pequeñas).
2. Abra el módulo que quiera ajustar y marque o desmarque sus funciones. La cuenta del módulo cambia al momento; la de la lista de roles solo cambia al guardar.
3. Pulse **Guardar cambios**. El cambio queda aplicado en la siguiente acción de cada usuario con ese rol; nadie tiene que volver a entrar.
4. Para repartirlo todo de una vez, use **Marcar todas las funciones**; **Desmarcar todas** hace lo contrario. Ninguno de los dos guarda por sí solo.
5. **Descartar** devuelve el cuadro a lo guardado y pide confirmación.
6. **Nuevo rol** abre el formulario: nombre, descripción, **Ámbito de sus usuarios** y **Tipo de acceso** (interno o externo). El código se genera del nombre y no se puede cambiar después.
7. **Editar rol** permite corregir nombre, descripción, ámbito, tipo de acceso y si **Se puede asignar a usuarios nuevos**.
8. **Borrar rol** solo está disponible cuando ningún usuario lo tiene y no es un rol del sistema; la cabecera dice por qué cuando no se puede.

## Estados

- **Cargando**: esqueleto de dos columnas.
- **Error**: «No se pudo cargar el catálogo de roles y funciones.» con el detalle y **Reintentar**.
- **Vacío**: sin roles se ofrece **Nuevo rol**; si el catálogo de funciones llega vacío se ofrece **Reintentar**; un rol sin funciones marcadas avisa de que quien lo tenga no verá nada al entrar.
- **Lleno**: lista de roles y cuadro del rol seleccionado. Con cambios pendientes aparece la barra **Sin guardar** con **Descartar** y **Guardar cambios**.

## Qué no hace

- **El menú lateral y la búsqueda rápida no avisan de cambios sin guardar.** Si sale de la pantalla por ahí con cambios pendientes, se pierden. Sí avisa al cambiar de rol, al pulsar **Volver** y al cerrar o recargar la pestaña.
- Si dos administradores guardan el mismo rol a la vez, se aplica el último guardado sin aviso.
- No muestra ni edita usuarios: para cambiarle el rol a alguien vaya a **Usuarios**.
- No asigna permisos a una persona en particular ni muestra el historial de cambios; eso vive en **Usuarios**.
- La dirección de la pantalla no lleva el rol seleccionado: al recargar se vuelve al primero de la lista.
