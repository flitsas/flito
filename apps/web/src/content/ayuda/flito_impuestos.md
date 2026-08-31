## Qué es

Cola del impuesto vehicular por organismo. La factura de venta del trámite es precondición del envío; el pago se reconoce cuando usted valida el recibo. **Facturar** en FLITO (congelar la liquidación) no es esta pantalla, y tampoco es **emisión electrónica**.

## Para quién

Gestor de Impuestos (ve **Solicitado** y **Pagado** de su organismo; nunca los **Pendiente**). Administrador (ve toda la cola y puede enviar o asumir). Auditor (solo lectura).

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Impuestos**.

## Pasos

1. Filtre con **Todos**, **Pendiente**, **Solicitado**, **Con novedad** o **Pagado**. El gestor no ve **Todos** ni **Pendiente**.
2. Busque placa, VIN, trámite o comprador. Use **Compañía**, **Organismo**, **Listos para enviar** o **Sin gestión**, y **Solo sin gestión** si aplica. Para acotar por la fecha en que el impuesto quedó registrado en FLITO, use el rango **Creado en FLITO**; es distinto de la columna **Creado** de la tabla, que muestra la fecha del trámite en FLIT.
3. Para llevarse la cola a Excel, pulse **Exportar a Excel** en el encabezado. El archivo trae **el conjunto filtrado completo**, no solo la página que está viendo ni las filas que haya marcado. Mientras se genera, el botón dice **Preparando el archivo…**; al terminar, un aviso le confirma el nombre del archivo descargado y se quita con **Cerrar el aviso**. Si el filtro trae más filas de las que admite un archivo, no se descarga nada: verá un aviso pidiéndole acotar la búsqueda. El Auditor no ve esta acción.
4. Seleccione filas. Si son enviables, pulse **Enviar al gestor** o **Gestionar en Operaciones**. Si son certificables, **Certificar (N)**.
5. En el encabezado, **Cargar recibos (masivo)** sube los PDF o imágenes del organismo.
6. En una fila, pulse **Ver**. Revise **Factura de venta** (**En FLIT · Ver / descargar** o **Sin factura en FLIT**). Según el caso: **Rechazar**, **Reactivar**, **Asumir en Operaciones**, **Devolver al gestor**, **Reversar** o **Ver soporte**.

## Estados

- Cargando: la tabla aún no aparece.
- Error: mensaje en rojo sobre la tarjeta.
- Vacío: **No hay impuestos en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.** Con filtros: **Ningún impuesto coincide con los filtros.**
- Lleno: tabla con compañía, organismo, quién gestiona, estado, liquidado y pagado. Una diferencia de recibo muestra **Diferencia de valor**. Una fila asumida muestra **Operaciones**.

## Qué no hace

- No es **Gestión Trámites**: aquí no se origina el envío masivo de trámites ni se entrega el trámite.
- No **Factura** la liquidación ni dispara **emisión electrónica**.
- No carga derechos de tránsito (eso es **Derechos de tránsito**) ni resuelve OCR (eso es **Revisiones OCR**).
- El gestor no ve ni envía los **Pendiente**; esa frontera la resuelve el Administrador.
- **Exportar a Excel** no se lleva la página que está viendo ni las filas marcadas: se lleva el conjunto filtrado completo. Si ese conjunto es demasiado grande, no entrega un archivo recortado; le pide acotar el filtro.
- El Auditor no exporta: la exportación es del Administrador y del Gestor de Impuestos.
