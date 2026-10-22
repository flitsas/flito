---
resumen: Cruce del recaudo SOAT contra lo emitido.
palabras_clave:
  - conciliación
  - recaudo
  - SOAT emitido
  - cruce
consultas:
  - cómo concilio el recaudo SOAT
  - por qué no cuadra la conciliación
version: 1.1
fecha: 2026-10-21
---
## Qué es

Bandeja de las boletas que Financiera pagó en el portal SOAT, cruzadas contra los SOAT pagados en FLITO. **Cargar una boleta no mueve dinero**: el descuento de las bolsas ocurre al conciliar, y solo si todo cuadra. Usted carga el Excel, revisa el cuadre y confirma. No es **Facturar** ni **emisión electrónica**.

## Para quién

Financiera y Administrador. Quien entra puede cargar y conciliar: no hay modo de solo lectura. El Auditor no entra a esta bandeja (su lectura del comprobante va por la cola **SOAT**).

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Conciliación**. El detalle de una boleta abre en su propia página (con **Abrir**), no en una ventana encima, para que el reporte de costos pueda enlazarla.

## Pasos

1. Pulse **+ Cargar boleta**. En **Cargar boleta del portal** elija **Cliente**, **Fecha del pago en el portal** (la del pago, no la de hoy) y el **Excel de la boleta (.xlsx)**, tal como lo descarga del portal. Pulse **Cargar y cruzar**. Cargar no pide confirmación: todavía no sale dinero. ![Ventana Cargar boleta del portal con Cliente, Fecha del pago en el portal, el Excel de la boleta y los botones Cancelar y Cargar y cruzar](./flito_conciliacion/01-cargar-boleta.png)
2. Filtre por **Cliente**, estado de la boleta (**Todas**, **Por conciliar**, **Conciliadas**, **Descartadas**) y **Pagadas entre**. **Limpiar filtros** restaura la bandeja. Los KPI dicen cuántas hay **Por conciliar**, cuántas **Conciliadas** y cuántas **Líneas sin resolver**; este último ofrece **Revisar**. ![Bandeja de Conciliación con los filtros, los tres KPI y tres boletas: una con una línea que no cuadra, otra con todas cuadradas y una conciliada](./flito_conciliacion/02-bandeja.png)
3. En una fila, **Abrir**. El detalle dice cuántas líneas cuadran y, en la columna **Resultado**, qué pasó con cada una y qué hacer. Si hay líneas sin cuadrar, corrija y pulse **Volver a cruzar** (no mueve un peso). **Descartar** pide **Sí, descartar**: se pierde el cruce y el archivo se puede volver a cargar. ![Detalle de una boleta por conciliar: Conciliar boleta apagado porque 1 de 2 líneas no cuadra, y la línea con Valor distinto explicando la diferencia](./flito_conciliacion/03-detalle-sin-cuadrar.png)
4. Cuando todas las líneas cuadran, pulse **Conciliar boleta** y, en el diálogo, **Sí, conciliar**. **No se puede deshacer**: el valor sale de la bolsa del cliente y de la de tránsito. ![Diálogo Conciliar con el número de SOAT, el cliente y el valor, el aviso No se puede deshacer y los botones Cancelar y Sí, conciliar](./flito_conciliacion/04-conciliar.png)
5. Tras conciliar, adjunte el **Comprobante del pago PSE** (PDF, JPG o PNG, máximo 15 MB). **Reemplazar** sustituye el archivo. **‹ Volver a Conciliación** regresa a la bandeja. ![Boleta conciliada: las líneas cuadradas y el bloque Comprobante del pago PSE para adjuntar el archivo](./flito_conciliacion/05-comprobante-pse.png)

El ciclo de una boleta, de un vistazo:

![Diagrama: se carga la boleta sin mover dinero y FLITO cruza cada línea; si alguna no cuadra se corrige y se vuelve a cruzar, o se descarta; si todas cuadran se concilia, se descuenta de las bolsas sin poder deshacerlo y se adjunta el comprobante del pago PSE](./flito_conciliacion/ciclo-boleta.svg)

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
