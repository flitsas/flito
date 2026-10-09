## Qué es

La pantalla donde se decide **qué puede hacer cada rol** dentro de FLITO. Muestra la lista de roles con cuántas funciones tiene cada uno y, al lado, el cuadro del rol seleccionado: sus módulos plegados, repartidos en tres secciones según de dónde viene cada módulo: **FLITO**, **Ya existía y FLITO lo usa** y **Existe pero no se usa**. Cada sección y cada módulo llevan la cuenta de funciones marcadas. Desde aquí también se crean, editan y borran roles.

## Para quién

Administrador. Ningún otro rol la ve.

## Cómo se entra

Menú **Administración**, ítem **Roles y permisos**, junto a **Usuarios**.

## Pasos

1. Elija el rol en la lista de la izquierda (o en el selector **Rol** en pantallas pequeñas).
2. Busque el módulo en su sección y ábralo para marcar o desmarcar sus funciones. Cada módulo empieza por su pantalla (**Entrar a la pantalla …**) y debajo, separadas por una línea, van sus acciones. Las acciones se habilitan al marcar la pantalla (en los módulos con dos pantallas basta una) y, hasta entonces, se ven apagadas con la nota «Marca primero la pantalla…». Si desmarca la única pantalla marcada, sus acciones se desmarcan en el mismo gesto: la barra **Sin guardar** las cuenta y **Descartar** las devuelve. La cuenta del módulo y la de su sección cambian al momento; la de la lista de roles solo cambia al guardar. Los módulos de **Existe pero no se usa** son anteriores a FLITO: si se marcan, el rol sí entra a esas pantallas, solo que FLITO no las usa hoy.
3. Pulse **Guardar cambios**. El cambio queda aplicado en la siguiente acción de cada usuario con ese rol; nadie tiene que volver a entrar.
4. Para repartirlo todo de una vez, use **Marcar todas las funciones**; **Desmarcar todas** hace lo contrario. Ninguno de los dos guarda por sí solo.
5. **Descartar** devuelve el cuadro a lo guardado y pide confirmación.
6. **Nuevo rol** abre el formulario: nombre, descripción y **Enlace**, que decide qué datos ven las personas con ese rol. Elija una de cuatro opciones; cada una explica debajo lo que verá el rol:
   - **Ninguno** (viene marcado): ve todos los datos de los módulos que el rol tenga marcados.
   - **Compañía**: ve solo lo de su compañía en Gestión Trámites, SOAT, Impuestos, su bolsa, Comprobantes y Logística. No ve catálogos ni configuración; el resto le queda cerrado.
   - **Proveedor**: ve solo lo asignado a su proveedor. Hoy aplica a SOAT.
   - **Organismos**: ve solo lo de sus secretarías de tránsito en Impuestos y Derechos de tránsito. El resto le queda cerrado.

   La compañía, el proveedor o las secretarías concretas de cada persona se eligen en **Usuarios**, no aquí. El código del rol se genera del nombre y no se puede cambiar después.
7. **Editar rol** permite corregir nombre, descripción, enlace y si **Se puede asignar a usuarios nuevos**. El enlace solo se puede cambiar mientras ningún usuario tenga el rol; si lo tiene alguien, el formulario lo avisa y hay que cambiarles el rol primero en **Usuarios**.
8. **Borrar rol** solo está disponible cuando ningún usuario lo tiene y no es un rol del sistema; la cabecera dice por qué cuando no se puede.

## Estados

- **Cargando**: esqueleto de dos columnas.
- **Error**: «No se pudo cargar el catálogo de roles y funciones.» con el detalle y **Reintentar**.
- **Vacío**: sin roles se ofrece **Nuevo rol**; si el catálogo de funciones llega vacío se ofrece **Reintentar**; un rol sin funciones marcadas avisa de que quien lo tenga no verá nada al entrar.
- **Lleno**: lista de roles y cuadro del rol seleccionado con sus tres secciones; una sección sin módulos no se muestra. La cabecera del cuadro dice el enlace del rol y cuántos usuarios lo tienen. Con cambios pendientes aparece la barra **Sin guardar** con **Descartar** y **Guardar cambios**.
- **Error al guardar el rol**: el formulario muestra «No se pudo guardar el rol. Inténtalo de nuevo; si se repite, recarga la página.» sin cerrarse.
- **Acciones marcadas sin la pantalla**: si un rol guardado tiene acciones de un módulo sin su pantalla, el encabezado del módulo añade **· n sin pantalla** y, al abrirlo, un aviso dice «n acciones marcadas sin la pantalla» con el botón **Desmarcarlas**. Esas acciones se ven marcadas pero bloqueadas hasta que marque la pantalla o las desmarque; si no toca nada, se guardan tal como estaban.

## Qué no hace

- **El menú lateral y la búsqueda rápida no avisan de cambios sin guardar.** Si sale de la pantalla por ahí con cambios pendientes, se pierden. Sí avisa al cambiar de rol, al pulsar **Volver** y al cerrar o recargar la pestaña.
- Si dos administradores guardan el mismo rol a la vez, se aplica el último guardado sin aviso.
- No muestra ni edita usuarios: para cambiarle el rol a alguien vaya a **Usuarios**.
- No asigna permisos a una persona en particular ni muestra el historial de cambios; eso vive en **Usuarios**.
- Las secciones solo ordenan la pantalla: no cambian qué se guarda ni qué permisos tiene el rol. Por eso **Privacidad y datos** muestra una función que en otras pantallas aparece bajo **Administración**.
- La dirección de la pantalla no lleva el rol seleccionado: al recargar se vuelve al primero de la lista.
