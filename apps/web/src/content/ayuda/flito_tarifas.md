---
resumen: Cuánto se le cobra a cada cliente por trámite y logística.
palabras_clave:
  - tarifas
  - precios
  - cobro por trámite
  - logística
consultas:
  - cuánto se le cobra a un cliente
  - cómo cambio la tarifa de un cliente
version: 1.1
fecha: 2026-10-21
---
## Qué es

La pantalla donde se fija cuánto cobra FLITO a cada cliente por el trámite digital —Matrícula, Traspaso y Otros— y por la logística. Cada valor tiene una vigencia: rige desde el momento en que usted lo guarda y hasta que lo cambie o deje de cobrarlo.

## Para quién

Administrador y Financiera. El Auditor, el Proveedor y el Gestor de Impuestos no entran aquí.

## Cómo se entra

En el menú, **Finanzas → Tarifas**. También desde **Clientes y proveedores**, con el botón **Tarifas** de la fila de una compañía, que abre esta pantalla con esa compañía ya elegida.

## Pasos

1. Elija la compañía en la lista **Clientes** de la izquierda (o búsquela en **Buscar cliente…**). Las que tienen valores sin configurar muestran **Falta 1** o **Faltan N**; con la pestaña **Con faltantes** ve solo esas. A la derecha, sus cuatro filas —**Matrícula**, **Traspaso** y **Otros** del trámite digital, y **Logística**— con el valor vigente, desde cuándo y quién lo fijó. ![Lista de clientes con Falta 1 y Faltan 4, y las cuatro filas de tarifas de un cliente: tres con valor y Logística Sin configurar](./flito_tarifas/01-elegir-compania.png)
2. Pulse **Fijar valor** en una fila que diga **Sin configurar**, o **Cambiar** en una que ya tenga valor. Escriba el número y pulse **Guardar** (o **Cancelar**). El tipo de trámite ya está en la fila: no se escribe. ![Fila Logística en edición con el valor escrito y los botones Guardar y Cancelar](./flito_tarifas/02-fijar-valor.png)
3. Si escribe **0**, FLITO le pide confirmar: cero significa que el trámite **se cobra a $0**, no que está sin configurar.
4. Para no cobrar un concepto, pulse **Dejar de cobrar** y confirme. La fila vuelve a **Sin configurar** y la vigencia queda cerrada en el historial, con su nombre y la hora.
5. Pulse **Historial** en una fila, o **Historial del cliente** arriba, para abrir **Historial de vigencias**: valor, desde, hasta (o **Vigente**), quién la fijó y quién la cerró. Las pastillas filtran por trámite y **Fijadas entre** acota por fecha. ![Historial de vigencias con una tarifa Vigente y la anterior cerrada, con quién la fijó y quién la cerró](./flito_tarifas/03-historial.png)

Cómo cambia un valor y qué queda guardado, de un vistazo:

![Diagrama: una fila sin configurar pasa a vigente al fijar valor y guardar; cambiarla cierra la vigencia anterior y abre otra; dejar de cobrar la devuelve a sin configurar; todo queda en el historial con quién la fijó y quién la cerró](./flito_tarifas/vigencias.svg)

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
