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
  - cómo creo un proveedor de logística
  - cómo asigno un proveedor de logística a una compañía
  - por qué no puedo inactivar un proveedor
  - cómo veo solo los clientes inactivos
  - cómo desactivo un cliente
  - cómo vuelvo a activar un cliente
  - por qué dice que ya existe un cliente con ese NIT
  - cómo elimino un cliente
  - por qué no puedo eliminar un cliente
  - cómo desactivo un proveedor de SOAT
  - cómo vuelvo a activar un proveedor
  - cómo veo solo los proveedores inactivos
  - cómo elimino un proveedor de SOAT
  - por qué no puedo eliminar un proveedor
  - por qué dice que ya existe un proveedor con ese nombre
version: 2.3
fecha: 2026-10-28
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
3. La columna **Servicios** muestra un chip por servicio: **SOAT · FLITO gestiona**, **Impuestos · Autogestiona**, **Logística · Proveedor: (nombre)**, **Logística · Sin proveedor** o **Logística · Autogestiona**. Para cambiarlos, pulse **Editar** en la fila: en la pestaña **Datos y servicios**, la sección **Servicios** tiene una fila por servicio con el interruptor **FLITO gestiona**; apagado, la compañía lo hace por su cuenta (autogestión). Pulse **Guardar cambios**. ![Pestaña Clientes con tres compañías demo, el filtro Estado, la columna Servicios con un chip por servicio y el chip de Facturación](./clients/01-clientes.png)
4. En **Logística**, con **FLITO gestiona** encendido, elija el **Proveedor de logística**: es obligatorio y **Guardar cambios** no se activa hasta elegirlo. Si lo apaga, el proveedor no se borra: se lee **Proveedor conservado: (nombre). Mientras esté asignado, no se puede inactivar.** y vuelve a aparecer al encenderlo. Las compañías con logística encendida y sin proveedor llevan el chip **Logística · Sin proveedor**; encima de la tabla, un aviso dice **N compañías con logística no tienen proveedor asignado** y el filtro **Sin proveedor (N)** deja solo esas compañías (**Ver compañías** lo activa; con permiso de edición, el chip abre **Editar** de esa compañía). Si su usuario tiene la acción **Elegir proveedor de SOAT sin trámite** (se reparte desde **Roles y permisos**), la fila **SOAT** suma el selector **Proveedor de SOAT sin trámite** —un proveedor activo o **Sin proveedor**— y el chip de SOAT agrega **Proveedor SOAT sin trámite: (nombre)**; sin esa acción no verá ni el selector ni esa parte del chip. Los proveedores desactivados aparecen con **(Inactivo)** y no se pueden elegir; si la compañía ya tenía uno que luego se desactivó, se conserva y puede guardar sin cambiarlo. Con **Sin proveedor**, los usuarios de la compañía no pueden solicitar SOAT sin trámite. Si ve **Tiene usuarios con permiso de SOAT sin trámite, pero no tiene proveedor elegido: el permiso no toma efecto hasta elegirlo.**, elija un proveedor. Es independiente del interruptor **SOAT**. ![Cuadro Editar de una compañía con la sección Servicios y el selector Proveedor de SOAT sin trámite](./clients/02-soat-sin-tramite.png)
5. En el cuadro **Editar** también están las pestañas **Datos fiscales** (los datos de **emisión electrónica**) y **Tarifas** (**Abrir tarifas** lleva al configurador de valores de esa compañía; solo la ven quienes entran a esa pantalla). El chip de la columna **Facturación** (**Lista**, **Por clasificar** o **Faltan** con el número de datos que faltan) resume si la compañía puede emitirse después.
6. Para sacar de operación a una compañía, o volver a ponerla, pulse el botón **⋮** al final de su fila (solo lo ve el Administrador, que tiene la acción **Activar o desactivar clientes** o **Eliminar clientes**). Si la compañía está **Activo**, el menú ofrece **Desactivar**; si está **Inactivo**, **Activar**. También puede abrirlo con el teclado (**Intro**, **Espacio** o las flechas) y cerrarlo con **Esc**. **Desactivar** abre el cuadro **Desactivar «(compañía)»**, que primero revisa lo que la compañía tiene abierto y lo dice, por ejemplo **Este cliente tiene 3 SOAT, 2 trámites en curso.** (o **No tiene procesos en curso.**). Mientras esté inactivo no recibirá SOAT, impuestos ni trámites nuevos, y si tiene usuarios se cerrará su sesión. Pulse **Desactivar** para confirmar o **Cancelar** para dejarla como estaba. Al terminar verá **Cliente desactivado.** y la fila pasa a **Inactivo**.
7. En una compañía **Inactivo**, **Activar** (desde el mismo **⋮**) abre el cuadro **Activar «(compañía)»**: vuelve a recibir SOAT, impuestos y trámites, y se liberan los trámites que quedaron retenidos mientras estuvo inactiva. Pulse **Activar**; verá **Cliente activado.** y la fila pasa a **Activo**.
8. Para quitar una compañía de FLITO, pulse **⋮** en su fila y elija **Eliminar** (al final del menú, separada por una línea; solo con la acción **Eliminar clientes**). Al abrir el menú, FLITO comprueba si se puede eliminar y, mientras tanto, bajo **Eliminar** se lee **Comprobando…**. Si no se puede, la opción aparece apagada y debajo dice por qué: **Primero debe desactivarlo.** (si sigue **Activo**), los procesos que tiene abiertos, o **Su bolsa tiene saldo de $150.000; debe quedar en cero.** (con el saldo real). Con el teclado, llegue a ella con las flechas y el motivo se lee igual. Si se puede, **Eliminar** abre el cuadro **Eliminar «(compañía)»**: **Dejará de aparecer en FLITO. Su historial se conserva. No se puede deshacer.** Pulse **Eliminar** para confirmar o **Cancelar**. Verá **Cliente eliminado.** y la compañía desaparece de la tabla con cualquier filtro.
9. En **Proveedores**, la tabla muestra **Nombre**, **Tipo** (**SOAT** o **Logística**), **NIT**, **Contacto y teléfono**, **Compañías asignadas** y **Estado**, con los filtros **Estado** y **Tipo**. Cada fila tiene **Ver detalle** y, con permiso, **Editar**. **Nuevo proveedor** abre un solo formulario con el selector **Tipo de proveedor**: con **SOAT** pide **Nombre**, **Estrategia**, **Umbral OCR (0–1)** y **ANS pactado (horas)**; con **Logística** (**Presta el servicio de logística a las compañías que lo tengan asignado.**) pide **Nombre** y **NIT** (solo números, con dígito de verificación opcional, por ejemplo 900123456-7), y **Contacto** y **Teléfono** son opcionales; **Activo** viene encendido. **Crear proveedor** o **Guardar cambios**. El estado de un proveedor existente no se cambia aquí, sino con el **⋮** de la fila. El ANS de gestión es único para toda la operación. ![Pestaña Proveedores con el filtro Estado, el tipo, el NIT, las compañías asignadas y los botones Ver detalle y Editar](./clients/03-proveedores.png)
10. Para sacar de operación a un proveedor, o volver a ponerlo, pulse **⋮** al final de su fila (solo lo ve el Administrador, con la acción **Activar o desactivar proveedores**). Si está **Activo**, el menú ofrece **Desactivar**. Si es de **Logística** y está asignado a compañías, un cuadro lo impide: **No se puede inactivar a (proveedor): está asignado a N compañías (hasta tres nombres y «y N más»). Asigne otro proveedor a esas compañías y vuelva a intentarlo.** (pulse **Entendido**; cuenta también las compañías con logística apagada que lo conservan). En los demás casos: el cuadro **Desactivar «(proveedor)»** dice lo que tiene en curso, por ejemplo **4 SOAT en curso, proveedor de SOAT sin trámite de 2 compañías.** (o **No tiene procesos en curso.**). Mientras esté inactivo, sus usuarios no podrán ingresar a FLITO y no aparecerá entre los proveedores a elegir; si tiene usuarios, se cerrará su sesión. Pulse **Desactivar**; verá **Proveedor desactivado.** y la fila pasa a **Inactivo**. Si está **Inactivo**, **Activar** abre **Activar «(proveedor)»**; pulse **Activar** y verá **Proveedor activado.**
11. Para quitar un proveedor de FLITO, pulse **⋮** en su fila y elija **Eliminar** (al final del menú, separada por una línea; solo con la acción **Eliminar proveedores**). Al abrir el menú, FLITO comprueba si se puede eliminar y, mientras tanto, bajo **Eliminar** se lee **Comprobando…**. Si no se puede, la opción aparece apagada y debajo dice por qué: **Primero debe desactivarlo.** (si sigue **Activo**), **Tiene 4 SOAT en curso.** (con el número real) o **Es el proveedor de SOAT sin trámite de 2 compañías (Alfa, Beta).** (con las compañías reales: elija otro proveedor para ellas en el cuadro **Editar** de **Clientes**). Si se puede, **Eliminar** abre el cuadro **Eliminar «(proveedor)»**: **Dejará de aparecer en FLITO. Su historial se conserva. No se puede deshacer.** Pulse **Eliminar** para confirmar o **Cancelar**. Verá **Proveedor eliminado.** y el proveedor desaparece de la tabla con cualquier filtro. Su nombre queda libre para un proveedor nuevo.
12. En un proveedor de **Logística**, **Eliminar** (también con la acción **Eliminar proveedores**) no comprueba nada al abrir el menú: el cuadro **Eliminar «(proveedor)»** confirma y, si no se puede, lo dice en el mismo cuadro: **No se puede eliminar: está asignado a 2 compañías (Alfa, Beta).** (hasta 3 nombres y «y N más»; elija otro proveedor para ellas en **Editar** de **Clientes**) o **No se puede eliminar: todavía figura en compañías dadas de baja o en actas de entrega.** (puede desactivarlo para que deje de ofrecerse). Al **Desactivar** un proveedor de Logística con compañías asignadas, el aviso **No se puede inactivar** muestra el total y hasta 3 nombres. La columna **Compañías asignadas** la cuenta FLITO.

![Diagrama: en el cuadro se elige el proveedor de SOAT sin trámite; con Sin proveedor nadie de la compañía puede solicitar; con un proveedor activo, las solicitudes nuevas salen a él; si el proveedor está inactivo, quedan Gestionado por Operaciones](./clients/canal-soat-sin-tramite.svg)

## Estados

- Cargando: **Cargando compañías…** mientras llega el listado de clientes; **Cargando proveedores…** en el listado de proveedores.
- Error: si el listado de compañías no llega, **No pudimos cargar los clientes.** (o **No pudimos cargar los proveedores.**) con **Reintentar** sobre la tarjeta; además, aviso al fallar el guardado (el listado no se cae si falla el informe de facturación).
- NIT repetido: si al guardar un cliente nuevo, o los datos fiscales de uno existente, ya hay otro cliente vigente con ese NIT y esa sucursal, bajo el campo del NIT se lee **Ya existe un cliente con el NIT (número) y sucursal (número).**, el cursor queda en ese campo y el formulario conserva lo escrito. Corrija el NIT o cambie la sucursal y vuelva a guardar: el aviso se quita en cuanto cambia cualquiera de los dos.
- Nombre de proveedor repetido: si al crear o renombrar un proveedor ya hay otro vigente con ese nombre, bajo el campo **Nombre** se lee **Ya existe un proveedor SOAT con el nombre (nombre).**, el cursor queda en ese campo y el formulario conserva lo escrito. El aviso se quita en cuanto cambia el nombre. Si el guardado falla por otra causa, el formulario sigue abierto y dice qué pasó (por ejemplo, **No pudimos guardar el proveedor. Inténtelo de nuevo.**).
- Si el guardado del cliente falla por otra causa, un aviso que puede cerrar dice **No pudimos guardar el cliente. Intenta de nuevo.** y el formulario sigue abierto.
- Vacío: **No hay clientes.** (si puede crearlos, añade **Cree el primero con «Nuevo cliente».**) / **No hay proveedores.** (si puede crearlos, añade **Cree el primero con «Nuevo proveedor».**)
- Vacío del filtro: si hay compañías (o proveedores) pero ninguno con el filtro elegido, **No hay registros con este filtro.** con **Ver todos**, que vuelve a **Todos**. No es un error.
- Lleno: tabla **Empresa**, **Documento**, **Servicios** (un chip por servicio), **Facturación** y **Editar**; una compañía inactiva lleva el chip **Inactivo** junto al nombre. Con el filtro **Sin proveedor**, si ya no queda ninguna: **Todas las compañías con logística tienen proveedor.** con **Ver todas**.
- En el cuadro **Desactivar**, mientras revisa los procesos se lee **Revisando procesos en curso…** y **Desactivar** no se puede pulsar; si la revisión falla, **No pudimos revisar los procesos en curso de este cliente.** (o **de este proveedor.**) con **Reintentar**.
- Al confirmar **Desactivar** o **Activar**: si otro administrador ya cambió el estado, verá **Otro administrador ya cambió su estado.** y la fila se actualiza con el estado real; si se perdió la conexión, el cuadro dice **No pudimos conectar con FLITO. Revise su conexión e inténtelo de nuevo.** y el botón pasa a **Reintentar** (la fila no cambia); si su usuario no tiene permiso, **No tiene permiso para esta acción.**
- Al **Eliminar**: si la comprobación del menú falla, bajo **Eliminar** se lee **No pudimos comprobar si se puede eliminar. Elíjala para reintentar.**; al confirmar, si otro administrador ya cambió el estado, verá **Otro administrador ya cambió su estado.**; si se perdió la conexión, el cuadro lo dice y el botón pasa a **Reintentar**; sin permiso, **No tiene permiso para esta acción.** En ninguno de esos casos la fila cambia.
- La columna dice **Sin proveedor** cuando la compañía no tiene proveedor elegido: sus usuarios no ven **Solicitar SOAT**. No es un error; si la compañía lo necesita, elija un proveedor.
- En el cuadro **Editar**, cada selector de proveedor (SOAT sin trámite y logística) tiene sus propios estados: **Cargando proveedores…**, **No se pudieron cargar los proveedores.** con **Volver a cargar**, y **No hay proveedores de SOAT activos. Cree uno en la pestaña Proveedores.** Mientras la lista no esté lista, el selector queda deshabilitado; en logística, **No pudimos cargar los proveedores de logística.** con **Volver a cargar**. Si al guardar algo falla, el cuadro sigue abierto con su elección y le dice qué pasó (por ejemplo, **Ese proveedor ya no está activo. Elija otro o «Sin proveedor».**).

## Qué no hace

- No despacha trámites, SOAT ni impuestos: solo parametriza la compañía y el proveedor.
- No fija ni cambia tarifas: eso vive en Finanzas, **Tarifas**, a donde lleva la pestaña **Tarifas** del cuadro **Editar**.
- No **Factura** la liquidación de un trámite. **Lista** habla de **emisión electrónica**, no de Facturar.
- El filtro **Estado** no activa ni desactiva compañías ni proveedores: solo muestra u oculta filas. Eso se hace con el **⋮** de la fila.
- Desactivar no elimina: saca a la compañía de operación y puede volver a activarse. **Eliminar** sí la quita de FLITO (conserva su historial) y no se puede deshacer; exige que esté **Inactivo**, sin procesos abiertos y con la bolsa en cero. Con un proveedor pasa igual: **Eliminar** exige que esté **Inactivo**, sin SOAT en curso y sin compañías que lo tengan como proveedor de SOAT sin trámite.
- No es el catálogo de NIT vigilados de **Comparendos** (puede coincidir el NIT, pero es otro listado).
- Un Gestor de Impuestos o un Proveedor no administran compañías desde aquí.
- **SOAT sin trámite** solo dice a qué proveedor salen las solicitudes: no crea la solicitud ni compra el SOAT. Eso lo hace el usuario **Cliente** desde la cola **SOAT**.
- Cambiar el proveedor no reasigna nada de lo ya radicado: solo afecta a las solicitudes **nuevas**. Las que ya están en la cola conservan el proveedor que tienen.
- No da por sí solo el permiso de solicitar: ese se reparte en **Roles y permisos**. Hacen falta los dos, el proveedor y el permiso.
