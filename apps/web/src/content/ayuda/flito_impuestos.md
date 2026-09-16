## Qué es

Cola del impuesto vehicular por organismo. La factura de venta del trámite es precondición del envío; el pago se reconoce cuando usted valida el recibo. **Facturar** en FLITO (congelar la liquidación) no es esta pantalla, y tampoco es **emisión electrónica**.

## Para quién

Gestor de Impuestos (ve **Solicitado** y **Pagado** de los organismos que el Administrador le haya asignado —pueden ser varios—; nunca los **Pendiente**). Administrador (ve toda la cola y puede enviar o asumir). Auditor (solo lectura).

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Impuestos**.

## Pasos

1. Filtre con **Todos**, **Pendiente**, **Solicitado**, **Con novedad** o **Pagado**. El gestor no ve **Todos** ni **Pendiente**.
2. Busque placa, VIN, trámite o comprador. Use **Compañía**, **Organismo**, **Listos para enviar** o **Sin gestión**, y **Solo sin gestión** si aplica. Para acotar por la fecha en que el impuesto quedó registrado en FLITO, use el rango **Creado en FLITO**; es distinto de la columna **Creado** de la tabla, que muestra la fecha del trámite en FLIT.
3. Para llevarse la cola a Excel, pulse **Exportar a Excel** en el encabezado. El archivo trae **el conjunto filtrado completo**, no solo la página que está viendo ni las filas que haya marcado. Mientras se genera, el botón dice **Preparando el archivo…**; al terminar, un aviso le confirma el nombre del archivo descargado y se quita con **Cerrar el aviso**. Si el filtro trae más filas de las que admite un archivo, no se descarga nada: verá un aviso pidiéndole acotar la búsqueda. El Auditor no ve esta acción.
4. Marque las filas que necesite: la casilla ya **no** se limita a las que admiten una acción. **Enviar al gestor**, **Gestionar en Operaciones** y **Certificar** siguen aplicando **solo** a las filas que ya las admitían, y el botón se lo dice: con ocho marcadas de las que tres son enviables, verá **Enviar al gestor (3 de 8)**.
5. Con filas marcadas, pulse **Descargar soportes (N)**. Se abre **Documentos del ZIP**, donde elige **Factura de venta**, **Recibo del impuesto** o los dos, y obtiene **un solo** archivo con lo elegido. Cada documento se nombra por la placa y el organismo. Si ninguna de las filas marcadas tiene el documento que eligió, **no** se descarga un ZIP vacío: verá un aviso. Si lo marcado pesa más de lo que admite una descarga, marque menos filas y repita.
6. El recibo del organismo se carga en **dos fases**. La **liquidación del impuesto** es el documento de la hacienda sin marca: deja el impuesto **Solicitado**, con su valor y su fecha de liquidación, sin pagarlo. El **pago con marca** es el mismo documento con el sello de pagado: es la única vía a **Pagado**. En el encabezado, **Cargar recibos (masivo)** sube los PDF, las imágenes o un ZIP del organismo; arriba del selector de archivos elija la **Fase del recibo**: **Liquidación** o **Pago** (**Pago** viene marcado). Dentro de un ZIP manda la carpeta de cada recibo (**sin marca** es Liquidación; **con marca** o **pagado** es Pago); la fase que eligió aplica a los archivos sueltos y a las entradas del ZIP sin carpeta reconocible. FLITO no adivina la fase por el documento. Sueltos caben **hasta 150 archivos**; dentro de un ZIP, **hasta 300**, y cada archivo puede pesar **hasta 15 MB**. Al elegir un ZIP, FLITO lo abre en su computador y le dice cuántos recibos trae: el peso que ve (**N archivos · X MB de 250 MB**) es el de lo que va a subir, no el del ZIP comprimido. Lo que no sea PDF ni imagen se ignora y se lo dice. Si el ZIP está dañado, tiene contraseña o no trae recibos, no se envía nada. Y si un archivo del ZIP resulta pesar más de lo que el ZIP decía, FLITO para ahí y se lo dice: lo que ya subió se queda. FLITO sube los recibos **de 5 en 5** y le muestra por cuál va. Al terminar, el resumen dice cuántos quedaron **Liquidados**, **Conciliados**, **En revisión**, **Complementos**, **Duplicados** y **Sin asociar**, y la lista de archivos indica el resultado de cada uno.
7. En la columna **Estado**, cada fila dice qué documento tiene el impuesto: **Liquidación** (falta el pago), **Pago** o **Ambos**; sin documento no muestra nada. Al posar el cursor sobre **Liquidación** ve la fecha en que se cargó. Para ver solo los Solicitados con liquidación cargada y sin pagar, marque **Liquidado, pendiente de pago**; se combina con los demás filtros y **Limpiar filtros** lo desmarca. Si combina esa casilla con **Pagado** no verá filas: el aviso se lo explica.
8. Para pagar un impuesto puntual en ventanilla, abra su detalle con **Ver** y pulse **Cargar recibo de caja**, al lado de **Ver soporte**. Solo lo ve el Administrador (o quien tenga la función de recibos de caja), y solo en un impuesto **Solicitado**; si el impuesto no tiene liquidación cargada, el botón aparece deshabilitado y le dice por qué. Elija un solo archivo PDF, JPG o PNG de hasta 15 MB y pulse **Cargar**. Si FLITO lee el valor, el impuesto pasa a **Pagado** y verá el valor y la fecha leídos; si el valor pagado difiere del liquidado, la fila queda con **Diferencia de valor**. Si el valor no se pudo leer, el recibo queda guardado y pasa a **Revisiones OCR**; el impuesto sigue **Solicitado** hasta que se resuelva la revisión. Un archivo repetido, un impuesto que ya no está en gestión o un lector que no responde se le avisan en el mismo cuadro, con la opción de reintentar o de elegir otro archivo.
9. En una fila, pulse **Ver**. Revise **Factura de venta** (**En FLIT · Ver / descargar** o **Sin factura en FLIT**) y **Liquidado el** (la fecha de la liquidación, o **—** si no se ha cargado). Según el caso: **Rechazar**, **Reactivar**, **Asumir en Operaciones**, **Devolver al gestor**, **Reversar** o **Ver soporte**.

## Estados

- Cargando: la tabla aún no aparece.
- Error: mensaje en rojo sobre la tarjeta.
- Vacío: **No hay impuestos en esta vista. Sincroniza desde el Tablero para traer trámites nuevos.** Con filtros: **Ningún impuesto coincide con los filtros.** Con **Liquidado, pendiente de pago** marcado: **No hay impuestos liquidados pendientes de pago con estos filtros.**
- Lleno: tabla con compañía, organismo, quién gestiona, estado, liquidado y pagado. Una diferencia de recibo muestra **Diferencia de valor**. Una fila asumida muestra **Operaciones**. El documento cargado se ve como **Liquidación**, **Pago** o **Ambos** bajo el estado.

## Qué no hace

- No es **Gestión Trámites**: aquí no se origina el envío masivo de trámites ni se entrega el trámite.
- No **Factura** la liquidación ni dispara **emisión electrónica**.
- No carga derechos de tránsito (eso es **Derechos de tránsito**) ni resuelve OCR (eso es **Revisiones OCR**).
- El gestor no ve ni envía los **Pendiente**; esa frontera la resuelve el Administrador.
- **Exportar a Excel** no se lleva la página que está viendo ni las filas marcadas: se lleva el conjunto filtrado completo. Si ese conjunto es demasiado grande, no entrega un archivo recortado; le pide acotar el filtro.
- El Auditor no exporta: la exportación es del Administrador y del Gestor de Impuestos.
- El Auditor tampoco descarga soportes en lote, aunque sí puede marcar filas y usar todos los filtros.
- La carga masiva no arregla un ZIP: si trae un archivo de más de 15 MB, hay que sacarlo del ZIP, comprimirlo de nuevo y volver a elegirlo. Desde el modal no se puede quitar.
- No deduce la fase leyendo el documento: la decide usted con el selector o la carpeta del ZIP.
- El recibo de caja es de uno en uno y desde **Ver**; no se carga en lote ni paga un impuesto que no tenga liquidación.
