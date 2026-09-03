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
4. Marque las filas que necesite: la casilla ya **no** se limita a las que admiten una acción. **Enviar al gestor**, **Gestionar en Operaciones** y **Certificar** siguen aplicando **solo** a las filas que ya las admitían, y el botón se lo dice: con ocho marcadas de las que tres son enviables, verá **Enviar al gestor (3 de 8)**.
5. Con filas marcadas, pulse **Descargar soportes (N)**. Se abre **Documentos del ZIP**, donde elige **Factura de venta**, **Recibo del impuesto** o los dos, y obtiene **un solo** archivo con lo elegido. Cada documento se nombra por la placa y el organismo. Si ninguna de las filas marcadas tiene el documento que eligió, **no** se descarga un ZIP vacío: verá un aviso. Si lo marcado pesa más de lo que admite una descarga, marque menos filas y repita.
6. En el encabezado, **Cargar recibos (masivo)** sube los PDF, las imágenes o un ZIP del organismo. En una sola carga caben **hasta 50 archivos**, cada uno de **hasta 15 MB**. El modal le muestra el peso (**N archivos · X MB de 250 MB**). Si se pasa de la cantidad, del peso por archivo o del peso de la carga, FLITO se lo dice y no envía nada: quite archivos y vuelva a intentar. FLITO envía la carga **de 5 en 5**. Un ZIP cuenta como **un** archivo: el navegador no lo abre. Si el ZIP trae muchos PDF, el envío puede no terminar a tiempo; en ese caso suba los PDF sueltos.
7. En una fila, pulse **Ver**. Revise **Factura de venta** (**En FLIT · Ver / descargar** o **Sin factura en FLIT**). Según el caso: **Rechazar**, **Reactivar**, **Asumir en Operaciones**, **Devolver al gestor**, **Reversar** o **Ver soporte**.

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
- El Auditor tampoco descarga soportes en lote, aunque sí puede marcar filas y usar todos los filtros.
- El ZIP de la carga masiva no se descomprime en el navegador: entra como un solo archivo. Si trae muchos PDF y el envío no termina a tiempo, suba los PDF sueltos.
