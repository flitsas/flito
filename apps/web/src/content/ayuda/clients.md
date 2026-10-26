---
resumen: Empresas, servicios que gestiona FLITO y datos comerciales.
palabras_clave:
  - clientes
  - proveedores
  - empresas
  - servicios
  - autogestión
  - activos
  - inactivos
consultas:
  - cómo creo un cliente
  - dónde cambio los datos comerciales de una empresa
  - qué es la autogestión
  - qué significa marcar SOAT, Impuestos o Logística
  - cómo elijo el proveedor de SOAT sin trámite de una compañía
  - por qué el permiso de SOAT sin trámite no toma efecto
  - cómo veo solo los clientes inactivos
  - cómo desactivo un cliente
  - cómo vuelvo a activar un cliente
  - por qué dice que ya existe un cliente con ese NIT
  - cómo elimino un cliente
  - por qué no puedo eliminar un cliente
version: 1.9
fecha: 2026-10-25
---
## Qué es

Ficha de las compañías (clientes FLITO) con los servicios que FLITO les gestiona y sus datos comerciales, y de los proveedores de SOAT a los que se enrutan los trámites. La columna **Facturación** indica si la compañía está lista para una **emisión electrónica** posterior; no es **Facturar** en sentido FLITO (congelar la liquidación). Usted parametriza; no despacha.

## Para quién

Administrador (crea compañías, marca los servicios que gestiona FLITO y edita proveedores). Financiera (en gestión solo ve esta pantalla, además de finanzas). Auditor (consulta). El Proveedor y el Gestor de Impuestos no entran aquí.

## Cómo se entra

En la barra de navegación al pie de la pantalla, pulse **Gestión** y, en el panel que se abre, en el grupo **Maestros**, el ítem **Clientes y proveedores**. Si la ventana es estrecha, la barra deja solo los iconos y el nombre de cada sección aparece al pasar el cursor por encima; en pantallas pequeñas, use el botón de menú de la barra superior. También puede pulsar **Ctrl + K** (**Command + K** en Mac) y escribir «clientes».

## Pasos

1. Elija la pestaña **Clientes** o **Proveedores**. En **Clientes**, la columna **Estado** dice si cada compañía está **Activo** o **Inactivo**. Encima de la tabla, el filtro **Estado** tiene tres opciones: **Todos** (la de entrada), **Activos** e **Inactivos**; al pulsar una, la tabla muestra solo esas compañías y debajo se lee **Mostrando X de Y** (las que ve de las que hay). Si cambia de pestaña y vuelve, el filtro regresa a **Todos**.
2. En **Clientes**, pulse **Nuevo cliente**, complete **Nombre o razón social** (obligatorio) y, si los tiene, **NIT / Cédula**, **Sucursal** (por defecto 0), **Teléfono** y **Email**, y pulse **Guardar** (o **Cancelar**). No puede haber dos clientes vigentes con el mismo NIT y la misma sucursal.
3. En cada fila, marque **SOAT**, **Impuestos** y **Logística** para indicar que FLITO gestiona ese servicio para la compañía; si la casilla queda desmarcada, la compañía lo hace por su cuenta (autogestión). Debajo de la tabla, dos notas recuerdan qué significa cada casilla. ![Pestaña Clientes con tres compañías demo, el filtro Estado, la columna Estado, sus casillas de servicios, la columna SOAT sin trámite y el chip de Facturación](./clients/01-clientes.png)
4. Al final de las casillas, la columna **SOAT sin trámite** dice a qué proveedor salen las solicitudes de SOAT que los usuarios **Cliente** de esa compañía hacen sin un trámite abierto: el nombre del proveedor (por ejemplo, **Aseguradora Demo Uno**), el nombre seguido de **(inactivo)** si ese proveedor está desactivado, o **Sin proveedor**. Si su usuario tiene la acción **Elegir proveedor de SOAT sin trámite** (se reparte desde **Roles y permisos**), púlselo para abrir el cuadro **SOAT sin trámite · (compañía)**, elija en **Proveedor de SOAT sin trámite** un proveedor activo o **Sin proveedor**, y pulse **Guardar**. Con **Sin proveedor**, los usuarios de la compañía no pueden solicitar SOAT sin trámite. Si el cuadro muestra **Tiene usuarios con permiso de SOAT sin trámite, pero no tiene proveedor elegido: el permiso no toma efecto hasta elegirlo.**, elija un proveedor para que ese permiso sirva. Es independiente de la casilla **SOAT**: marcar o desmarcar una no cambia la otra. Sin esa acción, la columna se lee pero no se cambia. ![Cuadro SOAT sin trámite de una compañía con la lista Proveedor de SOAT sin trámite](./clients/02-soat-sin-tramite.png)
5. Desplace la tabla a la derecha para ver las acciones de la fila. Pulse **Tarifas** para ir al configurador de valores de esa compañía (en Finanzas, **Tarifas**), con la compañía ya elegida; el botón solo lo ven quienes entran a esa pantalla. Pulse **Datos fiscales** para los datos de **emisión electrónica**. El chip de la columna **Facturación** (**Lista**, **Por clasificar** o **Faltan** con el número de datos que faltan) resume si la compañía puede emitirse después.
6. Para sacar de operación a una compañía, o volver a ponerla, pulse el botón **⋮** al final de su fila (solo lo ve el Administrador, que tiene la acción **Activar o desactivar clientes** o **Eliminar clientes**). Si la compañía está **Activo**, el menú ofrece **Desactivar**; si está **Inactivo**, **Activar**. También puede abrirlo con el teclado (**Intro**, **Espacio** o las flechas) y cerrarlo con **Esc**. **Desactivar** abre el cuadro **Desactivar «(compañía)»**, que primero revisa lo que la compañía tiene abierto y lo dice, por ejemplo **Este cliente tiene 3 SOAT, 2 trámites en curso.** (o **No tiene procesos en curso.**). Mientras esté inactivo no recibirá SOAT, impuestos ni trámites nuevos, y si tiene usuarios se cerrará su sesión. Pulse **Desactivar** para confirmar o **Cancelar** para dejarla como estaba. Al terminar verá **Cliente desactivado.** y la fila pasa a **Inactivo**.
7. En una compañía **Inactivo**, **Activar** (desde el mismo **⋮**) abre el cuadro **Activar «(compañía)»**: vuelve a recibir SOAT, impuestos y trámites, y se liberan los trámites que quedaron retenidos mientras estuvo inactiva. Pulse **Activar**; verá **Cliente activado.** y la fila pasa a **Activo**.
8. Para quitar una compañía de FLITO, pulse **⋮** en su fila y elija **Eliminar** (al final del menú, separada por una línea; solo con la acción **Eliminar clientes**). Al abrir el menú, FLITO comprueba si se puede eliminar y, mientras tanto, bajo **Eliminar** se lee **Comprobando…**. Si no se puede, la opción aparece apagada y debajo dice por qué: **Primero debe desactivarlo.** (si sigue **Activo**), los procesos que tiene abiertos, o **Su bolsa tiene saldo de $150.000; debe quedar en cero.** (con el saldo real). Con el teclado, llegue a ella con las flechas y el motivo se lee igual. Si se puede, **Eliminar** abre el cuadro **Eliminar «(compañía)»**: **Dejará de aparecer en FLITO. Su historial se conserva. No se puede deshacer.** Pulse **Eliminar** para confirmar o **Cancelar**. Verá **Cliente eliminado.** y la compañía desaparece de la tabla con cualquier filtro.
9. En **Proveedores**, **Nuevo proveedor** (o **Editar** en la fila): **Nombre**, **Estrategia**, **Umbral OCR (0–1)**, **ANS pactado con el proveedor (horas)** y **Activo**. **Guardar**. El ANS de gestión es único para toda la operación: estas horas quedan como referencia de lo pactado. ![Pestaña Proveedores con dos gestores demo, su estrategia, umbral OCR, ANS pactado, estado y el botón Editar](./clients/03-proveedores.png)

![Diagrama: en el cuadro se elige el proveedor de SOAT sin trámite; con Sin proveedor nadie de la compañía puede solicitar; con un proveedor activo, las solicitudes nuevas salen a él; si el proveedor está inactivo, quedan Gestionado por Operaciones](./clients/canal-soat-sin-tramite.svg)

## Estados

- Cargando: **Cargando compañías…** mientras llega el listado de clientes; **Cargando…** en el listado de proveedores.
- Error: si el listado de compañías no llega, **No pudimos cargar los clientes.** con **Reintentar** sobre la tarjeta; además, aviso al fallar el guardado (el listado no se cae si falla el informe de facturación).
- NIT repetido: si al guardar un cliente nuevo, o los datos fiscales de uno existente, ya hay otro cliente vigente con ese NIT y esa sucursal, bajo el campo del NIT se lee **Ya existe un cliente con el NIT (número) y sucursal (número).**, el cursor queda en ese campo y el formulario conserva lo escrito. Corrija el NIT o cambie la sucursal y vuelva a guardar: el aviso se quita en cuanto cambia cualquiera de los dos.
- Si el guardado del cliente falla por otra causa, un aviso que puede cerrar dice **No pudimos guardar el cliente. Intenta de nuevo.** y el formulario sigue abierto.
- Vacío: **No hay clientes.** (si puede crearlos, añade **Cree el primero con «Nuevo cliente».**) / **No hay proveedores. Crea el primero con «Nuevo proveedor».**
- Vacío del filtro: si hay compañías pero ninguna con el filtro elegido, **No hay registros con este filtro.** con **Ver todos**, que vuelve a **Todos**. No es un error.
- Lleno: tabla **Empresa**, **Estado** (**Activo** / **Inactivo**), **Documento**, **Ciudad**, **Teléfono**, **Email**, las casillas de servicios (**SOAT**, **Impuestos**, **Logística**: marcada = FLITO lo gestiona), **SOAT sin trámite**, **Facturación** y acciones. Si el proveedor de SOAT sin trámite de una compañía está desactivado, la columna lo dice —**(proveedor) (inactivo)**— y sus solicitudes nuevas quedan **Gestionado por Operaciones**.
- En el cuadro **Desactivar**, mientras revisa los procesos se lee **Revisando procesos en curso…** y **Desactivar** no se puede pulsar; si la revisión falla, **No pudimos revisar los procesos en curso de este cliente.** con **Reintentar**.
- Al confirmar **Desactivar** o **Activar**: si otro administrador ya cambió el estado, verá **Otro administrador ya cambió su estado.** y la fila se actualiza con el estado real; si se perdió la conexión, el cuadro dice **No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo.** y el botón pasa a **Reintentar** (la fila no cambia); si su usuario no tiene permiso, **No tiene permiso para esta acción.**
- Al **Eliminar**: si la comprobación del menú falla, bajo **Eliminar** se lee **No pudimos comprobar si se puede eliminar. Elíjala para reintentar.**; al confirmar, si otro administrador ya cambió el estado, verá **Otro administrador ya cambió su estado.**; si se perdió la conexión, el cuadro lo dice y el botón pasa a **Reintentar**; sin permiso, **No tiene permiso para esta acción.** En ninguno de esos casos la fila cambia.
- La columna dice **Sin proveedor** cuando la compañía no tiene proveedor elegido: sus usuarios no ven **Solicitar SOAT**. No es un error; si la compañía lo necesita, elija un proveedor.
- En el cuadro de **SOAT sin trámite**, la lista tiene sus propios estados: **Cargando proveedores…**, **No se pudieron cargar los proveedores.** con **Volver a cargar**, y **No hay proveedores de SOAT activos. Cree uno en la pestaña Proveedores.** Mientras la lista no esté lista, **Guardar** no se puede pulsar. Si al guardar algo falla, el cuadro sigue abierto con su elección y le dice qué pasó (por ejemplo, **Ese proveedor ya no está activo. Elija otro o «Sin proveedor».**).

## Qué no hace

- No despacha trámites, SOAT ni impuestos: solo parametriza la compañía y el proveedor.
- No fija ni cambia tarifas: eso vive en Finanzas, **Tarifas**, a donde lleva el botón **Tarifas** de la fila.
- No **Factura** la liquidación de un trámite. **Lista** habla de **emisión electrónica**, no de Facturar.
- El filtro **Estado** no activa ni desactiva compañías: solo muestra u oculta filas. Eso se hace con el **⋮** de la fila.
- Desactivar no elimina: saca a la compañía de operación y puede volver a activarse. **Eliminar** sí la quita de FLITO (conserva su historial) y no se puede deshacer; exige que esté **Inactivo**, sin procesos abiertos y con la bolsa en cero.
- No es el catálogo de NIT vigilados de **Comparendos** (puede coincidir el NIT, pero es otro listado).
- Un Gestor de Impuestos o un Proveedor no administran compañías desde aquí.
- **SOAT sin trámite** solo dice a qué proveedor salen las solicitudes: no crea la solicitud ni compra el SOAT. Eso lo hace el usuario **Cliente** desde la cola **SOAT**.
- Cambiar el proveedor no reasigna nada de lo ya radicado: solo afecta a las solicitudes **nuevas**. Las que ya están en la cola conservan el proveedor que tienen.
- No da por sí solo el permiso de solicitar: ese se reparte en **Roles y permisos**. Hacen falta los dos, el proveedor y el permiso.
