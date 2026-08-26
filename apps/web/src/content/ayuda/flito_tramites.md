## Qué es

Centro de despacho de los trámites de FLIT: usted sincroniza, consulta el estado y solicita SOAT e impuestos. Solo los trámites **Asignados** —con compañía y secretaría emparejadas— habilitan esas gestiones.

## Para quién

Administrador (opera, sincroniza y despacha). Auditor (solo lectura). El Proveedor y el Gestor de Impuestos no entran aquí: cada uno trabaja en su propia cola.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Gestión Trámites**. También desde **Tablero FLITO**, al pulsar una alerta operativa (el listado llega con el filtro ya aplicado).

## Pasos

1. Pulse **Sincronizar FLIT** para traer trámites. Si es la primera vez, elija **Desde**; si ya hay sincronización, puede marcar **Elegir fecha**.
2. Busque por placa, VIN, id o comprador, o use **Recién llegados sin gestionar**. Filtre por **Todas**, **Autogestionadas** o **No autogestionadas**.
3. Marque trámites **Asignados** con compañía y secretaría emparejadas. Si ve **Empresa no existe**, pulse **Crear empresa**. Si ve **Secretaría sin emparejar**, empareje antes de despachar.
4. Con la selección, pulse **Solicitar SOAT**, **Solicitar Impuestos**, **Solicitar ambos** o **Entregar**. **Entregar** solo aplica si la fila muestra **Listo para entregar**.
5. Use **Descargar facturas (zip)** para los soportes. En una fila, **Crear empresa**, el historial o **Soportes** abren el detalle de esa compañía o de ese trámite.

## Estados

- Cargando: la tabla aún no aparece mientras llega el listado.
- Error: el mensaje en rojo sobre la tarjeta (por ejemplo, si falló la sincronización).
- Vacío: **No hay trámites. Sincroniza desde FLIT para traer trámites.** Si hay filtros: **Ningún trámite coincide con el filtro.**
- Lleno: tabla con trámite, fechas, vehículo, comprador, compañía, SOAT, impuestos, logística, derechos de tránsito y soportes. Un trámite listo muestra **Listo para entregar**.

## Qué no hace

- No es la cola del Proveedor (**SOAT**) ni la del Gestor de Impuestos (**Impuestos**).
- No carga recibos de derechos de tránsito ni resuelve OCR: eso vive en **Derechos de tránsito** y **Revisiones OCR**.
- **Facturar** un trámite (congelar la liquidación) y la **emisión electrónica** no se hacen aquí.
- No entrega licencias de tránsito: eso es **Logística** / **Mi ruta**.
