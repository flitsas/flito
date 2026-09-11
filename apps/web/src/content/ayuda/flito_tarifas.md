## Qué es

La pantalla donde se fija cuánto cobra FLITO a cada cliente por el trámite digital —Matrícula, Traspaso y Otros— y por la logística. Cada valor tiene una vigencia: rige desde el momento en que usted lo guarda y hasta que lo cambie o deje de cobrarlo.

## Para quién

Administrador y Financiera. El Auditor, el Proveedor y el Gestor de Impuestos no entran aquí.

## Cómo se entra

En el menú, **Finanzas → Tarifas**. También desde **Clientes y proveedores**, con el botón **Tarifas** de la fila de una compañía, que abre esta pantalla con esa compañía ya elegida.

## Pasos

1. Elija la compañía en la lista de la izquierda. Las que tienen valores sin configurar muestran **Faltan N**; con la pestaña **Con faltantes** ve solo esas.
2. Pulse **Fijar valor** en una fila que diga **Sin configurar**, o **Cambiar** en una que ya tenga valor. Escriba el número y pulse **Guardar**. El tipo de trámite ya está en la fila: no se escribe.
3. Si escribe **0**, FLITO le pide confirmar: cero significa que el trámite **se cobra a $0**, no que está sin configurar.
4. Para no cobrar un concepto, pulse **Dejar de cobrar** y confirme. La fila vuelve a **Sin configurar** y la vigencia queda cerrada en el historial, con su nombre y la hora.
5. Pulse **Historial** en una fila, o **Historial del cliente** arriba, para ver cada vigencia: valor, desde, hasta (o **Vigente**), quién la fijó y quién la cerró. El filtro **Fijadas entre** acota por fecha.

## Estados

- Cargando: un esqueleto en el lugar de la lista o de la matriz, con los botones apagados.
- Error: **No se pudieron cargar los valores de…** con **Reintentar**. FLITO no muestra $0 ni **Sin configurar** por un error: si ve una fila, es lo que hay guardado.
- Vacío: **Todavía no hay clientes.** cuando no existe ninguna compañía; **Sin configurar** en la fila a la que no se le ha fijado valor.
- Lleno: las cuatro filas del cliente con su valor, desde cuándo rige y quién lo fijó.

## Qué no hace

- No cambia lo ya liquidado. Un trámite que ya se facturó conserva el valor con el que se liquidó, aunque usted cambie la tarifa después.
- Cada trámite vale lo que regía en su fecha de aprobación. Si hoy cambia un valor, aplica a los trámites que se aprueben desde hoy; los aprobados antes siguen con el valor de entonces.
- No borra ni «desactiva» tarifas: una vigencia se cierra y queda en el historial.
- No decide si el cliente autogestiona la logística: **Gestiona FLITO** o **Autogestiona el cliente** se lee aquí, pero se cambia en **Clientes y proveedores**.
- No muestra el reporte de costos ni lo que se cobró en cada trámite.
