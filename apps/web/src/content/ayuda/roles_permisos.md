## Qué es

La pantalla donde se decide **qué puede ver y hacer cada rol** dentro de FLITO. Muestra la lista de roles con cuántos permisos tiene cada uno y, al lado, los **Permisos del rol** seleccionado, ordenados igual que el menú: cada **elemento del menú** (Gestión, Finanzas, Administración…) contiene sus **ítems** (las pantallas), y cada ítem sus **acciones** (ver, crear, exportar…). Todo lo que se reparte está dentro del menú: no hay permisos sueltos aparte. Desde aquí también se crean, editan y borran roles.

## Para quién

Quien tenga el permiso de ver **Roles y permisos**. Para cambiar las marcas hace falta además la acción **Asignar permisos**; para crear, editar o borrar roles, la acción correspondiente. Sin ellas la pantalla se ve en solo lectura.

## Cómo se entra

Menú **Administración**, ítem **Roles y permisos**, junto a **Usuarios**.

## Pasos

1. Elija el rol en la lista de la izquierda (o en el selector **Rol** en pantallas pequeñas).
2. Despliegue el elemento del menú y el ítem que quiera y marque o desmarque. Un permiso vale solo si están marcados el elemento, el ítem y la acción. Una casilla con unas marcas sí y otras no se ve como **parcial**.
3. Si desmarca un elemento o un ítem, lo de adentro **no se pierde**: queda visible, apagado y con sus marcas, con la nota «… está desmarcado: lo de adentro no aplica, pero sus marcas se conservan para cuando lo vuelvas a marcar». Al volver a marcarlo, las marcas reaparecen activas.
4. Algunos casos llevan su propia nota:
   - Los ítems de módulos anteriores a FLITO no se dividen en acciones: marcarlos da acceso a todo lo de la pantalla. En PESV, crear y editar los registros pide además la acción **Administrar**.
   - Las operaciones **Opcional** (por ejemplo, ver el documento del propietario sin enmascarar) no vienen con su ítem: se marcan aparte.
   - Un ítem marcado sin ninguna acción avisa «Marcado sin ninguna acción: …»; marque al menos una o desmarque el ítem.
   - **Ayuda** no se marca: cada usuario la ve sola, con los capítulos de lo que puede usar.
   - Algunas operaciones se usan desde varias pantallas y **vienen con el módulo donde se usan**, sin casilla propia: consultar vehículos viene con **Vehículos**, **SOAT antiguo**, **Flota** y **Trámite Digital**; consultar una persona en el RUNT, leer la cédula y buscar en Fasecolda vienen con **Trámite Digital**, que incluye Traspaso. Basta con marcar el ítem.
   - El resumen de rendimiento de FLITO es el ítem **Rendimiento** de **Administración**: quien lo tenga lo verá en el menú, dentro de Administración.
5. Pulse **Guardar cambios**. El cambio queda aplicado en la siguiente acción de cada usuario con ese rol; nadie tiene que volver a entrar. La barra **Sin guardar** cuenta lo pendiente y **Descartar** lo devuelve a lo guardado.
6. Para repartirlo todo de una vez use **Marcar todo**, que marca todos los ítems y acciones del árbol, pero **no** los opcionales; **Desmarcar todo** quita todo. Ninguno de los dos guarda por sí solo.
7. **Nuevo rol** abre el formulario: nombre, descripción y **Enlace**, que decide qué datos ven las personas con ese rol. Elija una de cuatro opciones; cada una explica debajo lo que verá el rol:
   - **Ninguno** (viene marcado): ve todos los datos de los módulos que el rol tenga marcados.
   - **Compañía**: ve solo lo de su compañía en Gestión Trámites, SOAT, Impuestos, su bolsa, Comprobantes y Logística. No ve catálogos ni configuración; el resto le queda cerrado.
   - **Proveedor**: ve solo lo asignado a su proveedor. Hoy aplica a SOAT.
   - **Organismos**: ve solo lo de sus secretarías de tránsito en Impuestos y Derechos. El resto le queda cerrado.

   La compañía, el proveedor o las secretarías concretas de cada persona se eligen en **Usuarios**, no aquí. El código del rol se genera del nombre y no se puede cambiar después. El rol nuevo nace con **Perfil** marcado (ver sus datos y cambiar su contraseña) para que nadie se quede sin poder cambiarla; si no lo quiere, desmárquelo y guarde.
8. **Editar rol** permite corregir nombre, descripción, enlace y si **Se puede asignar a usuarios nuevos**. El enlace solo se puede cambiar mientras ningún usuario tenga el rol; si lo tiene alguien, el formulario lo avisa y hay que cambiarles el rol primero en **Usuarios**.
9. **Borrar rol** solo está disponible cuando ningún usuario lo tiene y no es un rol del sistema; la cabecera dice por qué cuando no se puede.

## Estados

- **Cargando**: esqueleto de dos columnas.
- **Error**: «No se pudo cargar el catálogo de roles y permisos. Revisa tu conexión y vuelve a intentarlo.» con **Reintentar**. Si falla solo el árbol del rol elegido, el aviso lo dice y ofrece **Reintentar** ahí mismo.
- **Vacío**: sin roles se ofrece **Nuevo rol**; si el catálogo llega vacío se ofrece **Reintentar**; un rol sin nada marcado avisa de que quien lo tenga no verá ningún elemento del menú al entrar.
- **Lleno**: lista de roles y árbol del rol seleccionado. La cabecera dice el enlace del rol y cuántos usuarios lo tienen. Con cambios pendientes aparece la barra **Sin guardar** con **Descartar** y **Guardar cambios**.
- **Solo lectura**: sin la acción **Asignar permisos**, un aviso lo explica y no hay casillas que cambiar.
- **No se guardó por seguridad**: si el cambio dejaría a FLITO sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos, un aviso en la página lo explica, nombra lo que hay que volver a marcar con **Mostrar dónde está**, y sus cambios siguen ahí sin guardar.
- **Error al guardar**: «No se pudieron guardar los permisos. Tus cambios siguen aquí; vuelve a intentarlo con «Guardar cambios».»
- **Error al guardar el rol**: el formulario muestra «No se pudo guardar el rol. Inténtalo de nuevo; si se repite, recarga la página.» sin cerrarse.

## Qué no hace

- **El menú lateral y la búsqueda rápida no avisan de cambios sin guardar.** Si sale de la pantalla por ahí con cambios pendientes, se pierden. Sí avisa al cambiar de rol, al pulsar **Volver** y al cerrar o recargar la pestaña.
- Si dos administradores guardan el mismo rol a la vez, se aplica el último guardado sin aviso.
- No muestra ni edita usuarios: para cambiarle el rol a alguien vaya a **Usuarios**.
- No asigna permisos a una persona en particular ni muestra el historial de cambios; eso vive en **Usuarios**, con el mismo árbol. Allí una excepción que añade una acción a la que al rol de la persona le falta el elemento o el ítem se marca «Añadido · sin efecto»: no vale hasta que se añada también lo que falta.
- La dirección de la pantalla no lleva el rol seleccionado: al recargar se vuelve al primero de la lista.
