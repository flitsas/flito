## Qué es

Cola FLITO de adquisición del SOAT. El SOAT se ancla al VIN y solo pasa a **Pagado** cuando usted carga una factura validada. Esta es la cola con rótulo **SOAT** en Gestión (`/flito/soat`). No es el módulo legado de pólizas.

## Para quién

Proveedor (ve **Solicitado** y **Pagado** de su cartera; nunca los **Pendiente**). Administrador (ve toda la cola, envía al gestor y puede asumir por contingencia). Auditor (solo lectura: **Solo lectura · Auditoría observa, no ejecuta acciones.**). Cliente (usuario de una compañía: ve únicamente los SOAT de **su** compañía. Si su compañía tiene abierto el canal **SOAT sin trámite**, además puede solicitar el SOAT de un vehículo que todavía no tiene trámite en FLIT; no envía al gestor ni carga facturas).

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **SOAT**. La ruta de esta cola es `/flito/soat`.

## Pasos

1. Filtre con las pastillas **Todos**, **Pendiente**, **Solicitado**, **Con novedad** o **Pagado**. El Proveedor no ve **Todos** ni **Pendiente**. El Administrador y el Cliente ven además **Pendiente de revisión** y **Rechazada**, que son los dos estados de las solicitudes del canal **SOAT sin trámite**.
2. Busque placa, VIN o comprador. Use **Compañía**, **Organismo**, **Proveedor**, **Listos para enviar** o **Sin gestión**, y **Solo sin gestión** si hace falta. Para acotar por la fecha en que el SOAT quedó registrado en FLITO, use el rango **Creado en FLITO**; es distinto de la columna **Creado** de la tabla, que muestra la fecha del trámite en FLIT.
3. Para llevarse la cola a Excel, pulse **Exportar a Excel** en el encabezado. El archivo trae **el conjunto filtrado completo**, no solo la página que está viendo ni las filas que haya marcado. Mientras se genera, el botón dice **Preparando el archivo…**; al terminar, un aviso le confirma el nombre del archivo descargado y se quita con **Cerrar el aviso**. Si el filtro trae más filas de las que admite un archivo, no se descarga nada: verá un aviso pidiéndole acotar la búsqueda. El Auditor no ve esta acción.
4. Como Administrador, seleccione filas **Pendiente**, elija **Enviar a** (**Gestionado por Operaciones** o un proveedor) y pulse **Enviar al gestor** o **Enviar a Operaciones**.
5. En una fila, pulse **Ver**. En adquisición, **Cargar factura** (un archivo) o, desde el encabezado, **Cargar facturas (masivo)**.
6. Según el caso: **Rechazar**, **Reactivar**, **Reversar**, **Cambiar proveedor**, **Asumir en Operaciones** o **Devolver al proveedor**. **Ver soporte** abre el documento ya cargado. En una solicitud del canal **SOAT sin trámite** no aparecen **Reversar** ni **Cambiar proveedor**: esas filas se resuelven validándolas o rechazándolas.
7. Como Administrador, en una solicitud en **Pendiente de revisión**: pulse **Validar** y elija a quién se envía (**Gestionado por Operaciones** o un proveedor) — la solicitud pasa a **Solicitado**, igual que cuando envía al gestor un SOAT de trámite. O pulse **Rechazar** y elija una **causal** de la lista y escriba una **observación**: las dos son obligatorias, y el Cliente las lee tal cual, así que escriba la observación pensando en que la lee su empresa cliente.
8. Como Cliente, si su compañía tiene el canal abierto, pulse **Solicitar SOAT** en el encabezado: se abre el formulario de la solicitud (placa y VIN, datos del propietario y la factura de venta en PDF). Si el canal está apagado, en lugar del botón verá una tarjeta que lo explica; la cola sigue funcionando igual.
9. Como Cliente, si le rechazaron una solicitud, ábrala con **Ver**: verá la **causal** y la **observación** de Operaciones. Pulse **Corregir y reenviar** para arreglar lo señalado y enviarla de nuevo — es la **misma** solicitud, no una nueva, y vuelve a **Pendiente de revisión**.
10. Como Cliente, cuando su solicitud llega a **Pagado**, ábrala con **Ver** y pulse **Ver soporte**: ahí está la **póliza** en PDF, que puede abrir en una pestaña nueva o descargar. Antes de **Pagado** la póliza todavía no existe. La **factura de venta** que usted cargó sí la ve en cualquier momento, que es lo que le permite comprobar cuál subió cuando le piden corregirla.

## Estados

- Cargando: la tabla aún no aparece.
- Error: mensaje en rojo sobre la tarjeta.
- Vacío: **No hay SOAT en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.** Con filtros: **Ningún SOAT coincide con los filtros.**
- Lleno: tabla **Pólizas SOAT** con compañía, quién gestiona, estado, solicitado, pagado y valor. Junto a la placa y el VIN, cada fila le muestra también los datos del vehículo que llegan de FLIT: **cilindraje**, **carrocería** y **tipo de servicio**. El dato que FLIT no envía aparece como **—** y no es un error. Una fila asumida muestra el chip **Operaciones**. Las solicitudes que llegan por el canal **SOAT sin trámite** aparecen con el estado **Pendiente de revisión** hasta que Operaciones las valida, o **Rechazada** si se devolvieron para corregir; esos dos estados solo existen en ese canal. Cuando la póliza queda cargada, el SOAT pasa a **Pagado** y el documento queda disponible en **Ver soporte** para la compañía dueña de la solicitud.

## Qué no hace

- No despacha el trámite ni solicita el SOAT desde aquí: eso se origina en **Gestión Trámites**.
- No liquida, no **Factura** en sentido FLITO (congelar liquidación) ni hace **emisión electrónica**.
- No gestiona impuestos, derechos de tránsito ni comparendos.
- El Proveedor no ve ni envía los **Pendiente**; esa frontera la resuelve el Administrador.
- **Rechazar** (del gestor, que deja el SOAT **Con novedad**) y **Rechazar** una solicitud en revisión no son lo mismo: distinto momento, distinto responsable y distinto estado.
- Una solicitud **Rechazada** no es una negación en firme: significa «corrija y reenvíe». Quien radica puede corregirla y volver a enviarla cuantas veces haga falta.
- Al corregir y reenviar no se puede cambiar la **placa** ni el **VIN**: si esos datos están mal, la solicitud correcta es otra y se radica de nuevo.
- El Cliente no ve los documentos internos de la operación: solo la póliza de su SOAT y la factura de venta que él mismo cargó.
- Esta pantalla no envía la póliza por correo ni la adjunta a ningún mensaje: se descarga desde aquí.
- **Exportar a Excel** no se lleva la página que está viendo ni las filas marcadas: se lleva el conjunto filtrado completo. Si ese conjunto es demasiado grande, no entrega un archivo recortado; le pide acotar el filtro.
- El Auditor no exporta. El Cliente tampoco: la exportación es del Administrador y del Proveedor.
