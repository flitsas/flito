---
resumen: Alta, edición, bloqueo y baja de las personas que entran a FLITO, con el historial de cambios.
palabras_clave:
  - usuarios
  - gestión de usuarios
  - nuevo usuario
  - contraseña
  - dar de baja
  - historial de cambios
consultas:
  - cómo creo un usuario
  - cómo le cambio la contraseña a un usuario
  - cómo desactivo o doy de baja a un usuario
  - quién le cambió el rol a un usuario
  - por qué no puedo darle a un usuario la función de eliminar clientes
version: 1.3
fecha: 2026-10-26
---
## Qué es

La pantalla **Gestión de usuarios**: las personas que pueden entrar a FLITO, su rol, su ámbito (compañía, proveedor u organismos, según el enlace del rol) y su estado. Desde aquí se crean, se editan, se les cambia la contraseña, se desactivan, se dan de baja y se reactivan. La pestaña **Historial** registra cada cambio en usuarios, roles y permisos.

## Para quién

Quien tenga el ítem **Usuarios**. De partida, el Administrador gestiona todo; el Auditor entra a la misma pantalla y solo ve el **Historial**. **Descargar Excel** pide además la acción de exportar usuarios. Todo se reparte desde **Roles y permisos**.

## Cómo se entra

Menú **Administración**, ítem **Usuarios**.

## Pasos

1. Entre a **Usuarios**. En la pestaña **Usuarios** filtre por **Rol** y por **Vista** (**En alta**, **Dados de baja** o **Todos**); debajo, **Usuarios por rol** cuenta cuántos hay de cada rol y cuántos están activos e inactivos. **Descargar Excel** baja todas las coincidencias del filtro. ![Lista de usuarios demo con filtros, conteo por rol y acciones por fila](./users/01-usuarios.png)
2. Para crear a alguien pulse **Nuevo usuario** y complete **Username (login)**, **Nombre completo**, **Email (opcional)**, **Contraseña** (mínimo 8 caracteres con minúscula, mayúscula, número y un carácter especial) y **Rol base**; según el enlace del rol se pide la compañía, el proveedor o los organismos. Una compañía inactiva aparece con **(Inactivo)** y no se puede elegir; si el usuario ya estaba atado a una que se desactivó, el campo la conserva con esa marca y el resto del formulario se guarda igual. Con los proveedores de SOAT pasa lo mismo: uno desactivado aparece con **(Inactivo)**, apagado, y no se puede elegir; si el usuario ya estaba atado a él, el campo lo conserva. Debajo, **Permisos de este usuario** muestra lo que trae el rol y permite añadir o quitar excepciones. Pulse **Crear usuario**. ![Formulario Nuevo usuario vacío con los campos y los permisos que trae el rol](./users/02-nuevo-usuario.png)
3. En la fila de una persona, **Editar** cambia sus datos, su rol, su ámbito y sus excepciones de permisos, y **Contraseña** le asigna una nueva. Cuatro funciones son exclusivas del Administrador y no admiten excepción: **Activar o desactivar clientes**, **Eliminar clientes**, **Activar o desactivar proveedores** y **Eliminar proveedores**. En una persona con otro rol aparecen apagadas con la nota **Exclusiva del Administrador: solo la tiene quien tiene ese rol.**; en un Administrador, marcadas por el rol con **Exclusiva del Administrador: la da su rol y no se puede quitar.** Para que alguien las tenga, cámbiele el **Rol base** a Administrador.
4. **Desactivar** le impide entrar sin sacarla de la lista; **Activar** la devuelve. Usted no puede desactivarse ni darse de baja a sí mismo (su fila dice «(tú)»).
5. **Dar de baja** la saca de la lista **En alta**; queda en **Dados de baja**, donde **Reactivar** la recupera.
6. En la pestaña **Historial** filtre por **Usuario**, **Recurso** (**Todos**, **Usuarios**, **Roles**, **Cuadro rol × función** o **Funciones por usuario**) y fechas. Cada fila dice **Cuándo**, **Quién**, **Qué** y el **Cambio** (antes → después). ![Historial con dos cambios demo: una desactivación y un cambio de rol](./users/03-historial.png)

![Diagrama del ciclo de un usuario: nuevo usuario activo, desactivar y activar, dar de baja y reactivar, con cada cambio en el historial](./users/ciclo-usuario.svg)

> [!IMPORTANTE]
> Los permisos de cada rol se deciden en **Roles y permisos**. Aquí solo se añaden o quitan excepciones para una persona.

## Estados

- **Cargando**: la tabla dice «Cargando...»; el historial, «Cargando el historial…».
- **Error**: «No se pudo cargar la lista de usuarios» con **Reintentar**; en la pestaña Historial, «No se pudo cargar el historial.».
- **Vacío**: «Sin usuarios» o, en **Dados de baja**, «Nadie dado de baja». El historial sin cambios dice que aparecerán a partir del primero.
- **No se guardó**: si al guardar FLITO rechaza una función exclusiva del Administrador (por ejemplo, porque otra persona cambió el rol mientras tanto), el cuadro lo dice con el nombre de la función, le pide cerrar y volver a abrir el usuario, y conserva lo que usted cambió.
- **Lleno**: la tabla con **Usuario**, **Nombre**, **Email**, **Rol**, **Ámbito**, **Estado** y **Acciones**; el historial, paginado.

## Qué no hace

- No define qué puede hacer cada rol: eso es **Roles y permisos**.
- No borra a nadie de forma definitiva: dar de baja conserva a la persona y su historial.
- No muestra los accesos a datos personales de cada persona: eso es **Log accesos PII**.
