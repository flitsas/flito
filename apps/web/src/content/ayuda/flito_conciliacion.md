## Qué es

Bandeja de las boletas que Financiera pagó en el portal SOAT, cruzadas contra los SOAT pagados en FLITO. **Cargar una boleta no mueve dinero**: el descuento de las bolsas ocurre al conciliar, y solo si todo cuadra. Usted carga el Excel, revisa el cuadre y confirma. No es **Facturar** ni **emisión electrónica**.

## Para quién

Financiera y Administrador. Quien entra puede cargar y conciliar: no hay modo de solo lectura. El Auditor no entra a esta bandeja (su lectura del comprobante va por la cola **SOAT**).

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Conciliación**. Ruta `/flito/conciliacion`. El detalle de una boleta abre en ruta propia (enlace **Abrir**), no en un modal, para que el reporte de costos pueda enlazarla.

## Pasos

1. Pulse **+ Cargar boleta**. En **Cargar boleta del portal** elija **Cliente**, **Fecha del pago en el portal** y el Excel (`.xlsx`). Pulse **Cargar y cruzar**. Cargar no pide confirmación: todavía no sale dinero.
2. Filtre por **Cliente**, estado de la boleta (**Todas**, **Por conciliar**, **Conciliadas**, **Descartadas**) y **Pagadas entre**. **Limpiar filtros** restaura la bandeja. El KPI **Líneas sin resolver** ofrece **Revisar**.
3. En una fila, **Abrir**. En el detalle, si hay líneas sin cuadrar, **Volver a cruzar** (no mueve un peso). **Descartar** pide **Sí, descartar**: se pierde el cruce y el archivo se puede volver a cargar.
4. Cuando todas las líneas cuadran, pulse **Conciliar boleta** y, en el diálogo, **Sí, conciliar**. **No se puede deshacer**: el valor sale de la bolsa del cliente y de la de tránsito.
5. Tras conciliar, adjunte el **Comprobante del pago PSE** (PDF, JPG o PNG). **Reemplazar** sustituye el archivo. **‹ Volver a Conciliación** regresa a la bandeja.

## Estados

- Cargando: esqueleto de la bandeja (o del detalle).
- Error: **No se pudo cargar la lista de boletas.** / **No se pudo cargar la boleta.** con **Reintentar**. Un 404: **Esa boleta no existe o se descartó.**
- Vacío: **Todavía no hay boletas cargadas.** Con filtros: **Ninguna boleta con los filtros puestos.**
- Lleno: KPI **Por conciliar**, **Conciliadas** y **Líneas sin resolver**, tabla **Boletas de conciliación**. En el detalle: cuadre, bloque de conciliar y comprobante.

## Qué no hace

- No recarga ni cierra bolsas: eso es **Bolsas**. Conciliar sí descuenta de ellas.
- No **Factura** la liquidación ni hace **emisión electrónica**.
- No hay conciliación parcial: basta una línea que no cuadre para bloquear **Conciliar boleta**.
- El Auditor no opera esta bandeja. No busque aquí la cola **SOAT**.
