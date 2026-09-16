## Qué es

La puerta única para los comprobantes de pago y los soportes de un trámite: facturas de SOAT,
recibos de impuesto y de derechos de tránsito, facturas de servicios, transferencias y cualquier
documento del trámite. FLITO lee cada documento y le muestra qué es, a qué llave corresponde
(**ID FLIT**, **placa** o **VIN**) y qué valores trae, con la confianza de cada dato. Lo leído
queda en **Pendientes** para que usted lo revise, lo asocie a su trámite y lo aplique como pago o lo
adjunte como documentación.

## Para quién

Financiera y Administrador. El Auditor no entra a esta pantalla.

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Comprobantes**.

## Pasos

1. Pulse **Cargar comprobantes**. Elija PDF o imágenes (JPG, PNG, WEBP). En una carga caben hasta
   **150 archivos**, cada uno de hasta **15 MB** y hasta **200 MB** en total. El modal le muestra el
   peso; si se pasa, FLITO se lo dice y no envía nada: quite archivos y vuelva a intentar. Un PDF que
   traiga varios documentos seguidos se lee **documento por documento**: cada uno aparece con sus
   páginas (por ejemplo **p. 3-4**).
2. Pulse **Subir y procesar**. Con muchos archivos verá **enviando X de N archivos**. No cierre la
   ventana: lo que ya se envió queda guardado aunque cierre.
3. Al terminar, lea el resultado por documento: **Pendiente** (leído, con el motivo por el que
   espera: sin llave de cruce, tipo o concepto sin identificar, lectura poco confiable, sin lectura…), **Duplicado**
   (ese archivo ya se había cargado; **Ver el original** lo abre) o **Fallido** (no es PDF ni imagen,
   o el PDF pasa de 150 páginas). Pulse **Listo**: la cola queda filtrada por esa carga; la ✕ del
   chip la quita.
4. En la cola, cada carga va agrupada con su fecha, hora y quién la subió. **Solo esta carga** filtra
   por esa carga; los selectores **Concepto** y **Motivo** afinan lo que ve.
5. Pulse **Asociar** en un pendiente (o **Ver** en un aplicado o descartado). A la izquierda verá
   el documento (abierto en su primera página); a la derecha, lo que FLITO leyó con la confianza de
   cada dato: **Alta**, **Media**, **Baja** o **Sin lectura**. FLITO nunca inventa un dato: si no lo
   leyó, el campo va vacío. **Abrir el archivo original** muestra el archivo completo en otra pestaña.
6. Si un documento quedó **Sin lectura (OCR no disponible)**, pulse **Releer**: FLITO vuelve a
   intentarlo. Si el lector sigue sin estar disponible, se lo dice y el documento no cambia.

## Asociar y aplicar

1. Diga qué es el documento: **Comprobante de pago** o **Documentación del trámite**. Si FLITO lo
   leyó con confianza, ya viene marcado; si no, márquelo usted.
2. Elija el **Trámite**. FLITO sugiere los trámites que coinciden con lo leído (**Sugerido · por
   placa**, **por VIN** o **por ID FLIT**); con un solo sugerido ya viene puesto. Si el suyo no está,
   escriba al menos 3 caracteres del **ID FLIT**, la **placa** o el **VIN** y elija uno de los
   resultados. La ✕ **Quitar trámite** vacía el campo.
3. Elija el **Concepto**. Junto a cada opción verá si ese trámite lo admite o por qué no (**ya
   pagado**, **liquidado**, **no gestionado**, **ya documentado**, **estado no permitido**).
4. Revise los datos leídos y corrija lo que haga falta. En un pago, el **Valor** es obligatorio
   (pesos, sin puntos ni signo); en documentación no se pide.
5. Si cambió algo de lo leído (un dato, el trámite sugerido, el concepto o la marca de pago),
   escriba **Por qué cambias lo leído** (mínimo 5 caracteres): queda en la auditoría del comprobante.
   No escriba datos personales.
6. Pulse **Aplicar** (pago) o **Adjuntar** (documentación). Si falta algo, FLITO se lo marca y no
   envía nada. Al terminar, la cola se actualiza y verá el mensaje **Comprobante aplicado a …** o
   **Documentación adjuntada a …**.
7. Si el trámite no admite ese pago (por ejemplo, ya está pagado), FLITO se lo dice y le ofrece
   **Adjuntar como documentación**: el documento queda en el trámite sin contar como pago. Si ya
   había otro comprobante con ese valor, **Reemplazar** le pide un motivo, descarta el anterior y
   aplica este.
8. Para sacar un documento de la cola, pulse **Descartar**, escriba el motivo (mínimo 5 caracteres)
   y confirme. El archivo deja de contar como duplicado: se podrá volver a cargar.

## Estados

- Cargando: la tabla muestra su esqueleto; en el modal, **Procesando…** y **enviando X de N archivos**.
- Error: **No se pudo cargar la cola de comprobantes** con **Reintentar**. En la carga, si el servidor
  no admite el peso o no termina a tiempo, FLITO se lo dice con el siguiente paso y conserva lo que sí
  se procesó.
- Vacío: **No hay comprobantes por asociar.** Con filtros, **Ningún comprobante coincide con los
  filtros** y **Limpiar filtros**.
- Lleno: una fila por documento, agrupadas por carga, con lo leído, la llave, el valor, el estado y
  su motivo, y **Asociar** (pendientes) o **Ver** (aplicados y descartados).
- En el panel: **Buscando…** mientras busca trámites; **Ningún trámite coincide con «…»** si no hay
  resultados; **No se pudo buscar. Vuelve a intentarlo.** si falla la búsqueda; **Aplicando…** o
  **Adjuntando…** mientras envía.

## Qué no hace

- No reparte un pago entre varios trámites: cada comprobante va a un solo trámite.
- No deshace una aplicación: un comprobante aplicado se ve en solo lectura.
- No acepta diferencias de valor frente a la tarifa: eso se hace desde el reporte de costos.
- No abre archivos ZIP: suba los PDF o las imágenes sueltos.
- No carga SOAT del canal Cliente: esas solicitudes no tienen trámite y siguen su propio camino.
- No reemplaza la carga masiva de **SOAT** ni la de **Impuestos**: siguen en sus pantallas. Un
  archivo que ya entró por ahí sale aquí como **Duplicado**.
- No muestra ni guarda datos de personas del documento: FLITO no los lee.
