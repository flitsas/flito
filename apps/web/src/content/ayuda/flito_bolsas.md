## Qué es

El saldo que cada cliente tiene precargado con FLIT y el que FLIT mantiene ante las secretarías. Los KPI de **Saldo total**, **Bolsas en riesgo** y **Conciliación pendiente** encabezan la pantalla; debajo, dos acordeones (**Clientes** y **Tránsitos**). Usted recarga, mueve, corrige y cierra periodos. No **Factura** la liquidación ni hace **emisión electrónica**.

## Para quién

Financiera y Administrador (operan el dinero). El Auditor no entra: a diferencia del resto de FLITO, las bolsas son solo de Administración y Financiera.

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Bolsas**. Ruta `/flito/bolsas`.

## Pasos

1. Elija el **Periodo contable**. Las entradas y salidas de las tarjetas de cliente, el desglose y el cierre son de ese periodo; el saldo y las cifras de los organismos son el acumulado.
2. En **Clientes**, pulse **Abrir bolsa** para la primera recarga de una compañía, o **Ver detalle** en una tarjeta o alerta. En **Tránsitos**, **Crear bolsa** (nombre, secretarías y cobros) o **Ver detalle**.
3. En el detalle del cliente: **Registrar una recarga** (valor y comprobante; **Registrar recarga**), **Movimiento manual** (**Registrar movimiento**), **Corregir un movimiento** (**Asentar corrección**) o **Cerrar** el periodo (**Confirmar el cierre**; irreversible).
4. Marque **Ver el libro completo (todos los periodos)** si necesita el histórico. Si el periodo ya está cerrado verá **Periodo cerrado** y **Descargar el reporte**; los botones que mueven dinero quedan apagados.
5. Si una compañía aún no tiene bolsa, el detalle dice **todavía no tiene bolsa**: se abre sola con la primera recarga.

## Estados

- Cargando: el encabezado **Bolsas** se ve; el tablero aún no (esqueleto).
- Error: mensaje en rojo sobre la tarjeta y **Reintentar**.
- Vacío: **Ningún cliente tiene bolsa todavía.** / **Todavía no hay bolsas de tránsito.**
- Lleno: KPI, alertas de saldo y tarjetas con **Entradas** y **Salidas** del periodo. Un cliente sin bolsa muestra la tarjeta de apertura, no un error.

## Qué no hace

- No cuadra el Excel del portal SOAT: eso es **Conciliación**. Cargar o conciliar una boleta no se hace aquí.
- No **Factura** (congelar la liquidación) ni envía a **emisión electrónica**: eso vive en **Reporte de costos** y en **Facturación electrónica · Operación**.
- No es el listado de compañías: las tarifas y la ficha comercial están en **Clientes y proveedores**.
- El Auditor, el Proveedor y el Gestor de Impuestos no operan bolsas.
