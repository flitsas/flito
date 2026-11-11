---
resumen: Cuánto se le cobra a cada cliente y cuánto cobra cada proveedor por su servicio.
palabras_clave:
  - tarifas
  - precios
  - cobro por trámite
  - logística
  - costo de proveedor
  - tarifa de proveedor
consultas:
  - cuánto se le cobra a un cliente
  - cómo cambio la tarifa de un cliente
  - cuánto nos cobra un proveedor
  - cómo fijo lo que cobra un proveedor de SOAT o de logística
version: 2.0
fecha: 2026-11-11
---
## Qué es

La pantalla donde se fija cuánto cobra FLITO a cada cliente por el trámite digital —Matrícula, Traspaso y Otros— y por la logística, que tiene dos precios: **Entrega a cliente** y **Entrega a FLIT**. Cada valor tiene una vigencia: rige desde el momento en que usted lo guarda y hasta que lo cambie o deje de cobrarlo.

Tiene dos modos, que se eligen en **Ver tarifas de**: **Clientes** —lo que FLITO cobra a cada compañía— y **Proveedores** —lo que cada proveedor le cobra a FLITO por su servicio, en pesos y sin IVA—. Son valores distintos y no se mezclan.

## Para quién

Administrador y Financiera. El Auditor, el Proveedor y el Gestor de Impuestos no entran aquí.

## Cómo se entra

En el menú, **Finanzas → Tarifas**. También desde **Clientes y proveedores**, con el botón **Tarifas** de la fila de una compañía, que abre esta pantalla con esa compañía ya elegida.

## Pasos

1. Con **Ver tarifas de** en **Clientes**, elija la compañía en la lista **Clientes** de la izquierda (o búsquela en **Buscar cliente…**). Las que tienen valores sin configurar muestran **Falta 1** o **Faltan N**; con la pestaña **Con faltantes** ve solo esas. Un cliente inactivo aparece en gris con **Inactivo** y no se puede elegir. A la derecha, las tres filas del trámite digital —**Matrícula**, **Traspaso** y **Otros**— y, debajo, el grupo **Logística** con dos paneles, **Entrega a cliente** y **Entrega a FLIT**; cada uno con el valor vigente, desde cuándo y quién lo fijó. **Entrega a FLIT** también hay que configurarla —cuenta en **Falta** / **Faltan N**—, pero solo se cobra cuando la logística pasa por FLIT; sin precio no se puede registrar un viaje a FLIT y no se bloquea nada más. ![Lista de clientes con Falta 1 y Faltan 5, y las filas de tarifas de un cliente: el trámite digital con valor y, en Logística, Entrega a cliente con valor y Entrega a FLIT Sin configurar con el chip Falta](./flito_tarifas/01-elegir-compania.png)
2. Pulse **Fijar valor** en una fila o panel que diga **Sin configurar**, o **Cambiar** en uno que ya tenga valor. Escriba el número y pulse **Guardar** (o **Cancelar**). El tipo de trámite ya está en la fila: no se escribe. ![Fila Logística en edición con el valor escrito y los botones Guardar y Cancelar](./flito_tarifas/02-fijar-valor.png)
3. Si escribe **0**, FLITO le pide confirmar: cero significa que el trámite **se cobra a $0**, no que está sin configurar.
4. Para no cobrar un concepto, pulse **Dejar de cobrar** y confirme (en un panel sin valor este botón está apagado). La fila o el panel vuelve a **Sin configurar** y la vigencia queda cerrada en el historial, con su nombre y la hora.
5. Pulse **Historial** en una fila o panel, o **Historial del cliente** arriba, para abrir **Historial de vigencias**: valor, desde, hasta (o **Vigente**), quién la fijó y quién la cerró. Las pastillas filtran por trámite y **Fijadas entre** acota por fecha. ![Historial de vigencias con una tarifa Vigente y la anterior cerrada, con quién la fijó y quién la cerró](./flito_tarifas/03-historial.png)
6. Para ver lo que cobra un proveedor, en **Ver tarifas de** pulse **Proveedores**. A la izquierda aparecen los proveedores activos (o búsquelos en **Buscar proveedor…**); en un celular, elíjalo en **Proveedor**.
7. Al elegir uno, verá solo los servicios que presta: **Logística** tiene un valor; **SOAT** tiene dos, **SOAT con trámite** y **SOAT sin trámite**. Si presta los dos servicios, verá las tres filas, cada una con su propio valor.
8. **Fijar valor**, **Cambiar**, **Dejar de cobrar** e **Historial** funcionan igual que en Clientes, también la confirmación al guardar **0**. **Historial del proveedor** reúne todas sus vigencias.
9. Si otra persona cambió el mismo valor mientras usted lo editaba, FLITO no guarda el suyo y avisa **Otro usuario cambió este valor. Recarga para ver el vigente** con el botón **Recargar**.
10. Un proveedor inactivo se ve en modo de solo lectura con el aviso **Este proveedor está inactivo.**: su historial se conserva, pero no se le pueden fijar ni cambiar valores. Si a un proveedor se le quita un servicio, su fila deja de mostrarse; en el historial, ese valor aparece con **Sin servicio asignado**, y vuelve si se le asigna el servicio otra vez.

Cómo cambia un valor y qué queda guardado, de un vistazo (igual en los dos modos):

![Diagrama: una fila sin configurar pasa a vigente al fijar valor y guardar; cambiarla cierra la vigencia anterior y abre otra; dejar de cobrar la devuelve a sin configurar; todo queda en el historial con quién la fijó y quién la cerró](./flito_tarifas/vigencias.svg)

## Estados

- Cargando: un esqueleto en el lugar de la lista o de la matriz, con los botones apagados.
- Error: **No se pudieron cargar los valores de…** con **Reintentar**. FLITO no muestra $0 ni **Sin configurar** por un error: si ve una fila, es lo que hay guardado.
- Vacío: **Todavía no hay clientes.** cuando no existe ninguna compañía; **Sin configurar** en la fila a la que no se le ha fijado valor.
- Lleno: las tres filas de trámite y los dos paneles de logística del cliente con su valor, desde cuándo rige y quién lo fijó.
- En **Proveedores**: **No hay proveedores activos.** cuando no hay ninguno, y un aviso cuando el proveedor elegido no tiene servicios asignados.

## Qué no hace

- No cambia lo ya liquidado. Un trámite que ya se facturó conserva el valor con el que se liquidó, aunque usted cambie la tarifa después.
- Cada trámite vale lo que regía en su fecha de aprobación. Si hoy cambia un valor, aplica a los trámites que se aprueben desde hoy; los aprobados antes siguen con el valor de entonces.
- No borra ni «desactiva» tarifas: una vigencia se cierra y queda en el historial.
- No decide si el cliente autogestiona la logística: **Gestiona FLITO** o **Autogestiona el cliente** se lee aquí, pero se cambia en **Clientes y proveedores**.
- No muestra el reporte de costos ni lo que se cobró en cada trámite.
- Lo que cobra un proveedor solo queda registrado: todavía no se usa para liquidar ni para el reporte de costos, y un valor **Sin configurar** no bloquea ningún SOAT ni ninguna entrega.
- El proveedor no ve esta pantalla ni sus valores.
