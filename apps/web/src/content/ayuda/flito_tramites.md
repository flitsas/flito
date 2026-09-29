## Qué es

Centro de despacho de los trámites de FLIT: usted sincroniza, consulta el estado y solicita SOAT e impuestos. Solo los trámites **Asignados** —con compañía y secretaría emparejadas— habilitan esas gestiones.

## Para quién

Administrador (opera, sincroniza y despacha). Auditor (solo lectura). El Proveedor y el Gestor de Impuestos no entran aquí: cada uno trabaja en su propia cola.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Gestión Trámites**. También desde **Tablero FLITO**, al pulsar una alerta operativa (el listado llega con el filtro ya aplicado).

## Pasos

1. Pulse **Sincronizar FLIT** para traer trámites. Si es la primera vez, elija **Desde**; si ya hay sincronización, puede marcar **Elegir fecha**. Pulse **Sincronizar FLIT 2** para traer lo nuevo de FLIT 2. No pide fecha: sigue donde quedó la lectura anterior. FLIT 2 también se lee solo cada pocos minutos, así que este botón sirve cuando no quiere esperar. Si hay mucho por leer, trae lo que alcanza en un minuto y el resto llega con la lectura automática. El resultado aparece en un aviso breve con cuántos trámites llegaron nuevos o con cambios.
2. Busque por placa, VIN, id o comprador, o use **Recién llegados sin gestionar**. Filtre por **Todas**, **Autogestionadas** o **No autogestionadas**. La columna **Fuente** indica si el trámite llegó de FLIT o de FLIT 2; el filtro **Fuente** (**Todas**, **FLIT**, **FLIT 2**) muestra solo los de un sistema, y **Limpiar filtros** lo devuelve a **Todas**.
3. Marque los trámites que necesite: la casilla ya **no** se limita a los **Asignados**, así que también puede marcar los ya entregados para llevarse sus soportes. Si ve **Empresa no existe**, pulse **Crear empresa**. Si ve **Secretaría sin emparejar**, empareje antes de despachar.
4. Con la selección, pulse **Solicitar SOAT**, **Solicitar Impuestos**, **Solicitar ambos** o **Entregar**. Esas acciones siguen aplicando **solo** a los trámites que ya las admitían, y el botón se lo dice: con tres marcados de los que dos se pueden despachar, verá **Solicitar SOAT (2 de 3)**. **Entregar** solo aplica si la fila muestra **Listo para entregar**.
5. Con trámites marcados, pulse **Descargar soportes (N)**. Se abre **Documentos del ZIP**, donde elige **Factura de venta**, **Recibo del impuesto**, **Comprobante del SOAT** o los que necesite, y obtiene **un solo** archivo ZIP con todo lo elegido. Cada trámite llega como **un solo PDF** con sus documentos en este orden: factura de venta, recibo del impuesto y comprobante del SOAT; el archivo se llama con la placa (por ejemplo, **ABC123.pdf**). Si un documento viene protegido y no se puede unir, va aparte, tal cual, como **ABC123-2.pdf**. Si un documento está dañado y no se puede leer, queda fuera y el aviso final le dice cuántos. Mientras se prepara verá **Preparando el archivo…**; con muchos trámites puede tardar unos minutos. Antes este botón traía solo las facturas de venta. Si ninguno de los trámites marcados tiene el documento que eligió, **no** se descarga un ZIP vacío: verá un aviso. En una fila, **Crear empresa**, el historial o **Soportes** abren el detalle de esa compañía o de ese trámite.
6. **Acceso a FLIT 2** (solo administradores): el botón de la cabecera abre un panel con el usuario de servicio con el que FLITO entra a FLIT 2, quién lo guardó y desde cuándo. La contraseña no se muestra nunca. Si aún no hay acceso, el panel lo dice. Con permiso de guardar, escriba el usuario y la contraseña que entregó FLIT 2 y pulse **Guardar acceso**: los campos se vacían al guardar. Con un acceso ya guardado, **Probar conexión** comprueba si FLIT 2 lo acepta y deja el resultado en un aviso dentro del panel (conectado, sin permiso de datos personales, rechazado, bloqueado un rato, o FLIT 2 que no responde); el botón no aparece hasta que haya un acceso guardado. Sin ese permiso, solo verá el estado.

## Estados

- Cargando: la tabla aún no aparece mientras llega el listado.
- Error: el mensaje en rojo sobre la tarjeta si falla el listado o la sincronización de FLIT. Si falla **Sincronizar FLIT 2**, un aviso breve dice por qué (por ejemplo, que ya hay una lectura en marcha o que FLIT 2 no responde) y, si sirve, ofrece **Reintentar**. Si el aviso habla del acceso, revíselo en **Acceso a FLIT 2**.
- Vacío: **No hay trámites. Sincroniza desde FLIT para traer trámites.** Si hay filtros: **Ningún trámite coincide con el filtro.**
- Lleno: tabla con trámite, fechas, vehículo, comprador, compañía, SOAT, impuestos, logística, derechos de tránsito y soportes. Un trámite listo muestra **Listo para entregar**.

## Qué no hace

- No es la cola del Proveedor (**SOAT**) ni la del Gestor de Impuestos (**Impuestos**).
- No carga recibos de derechos de tránsito ni resuelve OCR: eso vive en **Derechos de tránsito** y **Revisiones OCR**.
- **Facturar** un trámite (congelar la liquidación) y la **emisión electrónica** no se hacen aquí.
- No entrega licencias de tránsito: eso es **Logística** / **Mi ruta**.
- El Auditor no descarga soportes en lote, aunque sí puede marcar trámites y usar todos los filtros.
