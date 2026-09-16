## Qué es

Consola de las licencias de tránsito de trámites **Aprobado**: de la recogida en el organismo a la entrega firmada. Aquí usted genera actas por compañía y despacha al Mensajero.

## Para quién

Administrador (genera actas, firma y despacha, registra novedades). Auditor (consulta). El Mensajero no entra aquí: su trabajo es **Mi ruta**.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Logística**.

## Pasos

1. En **Trámites**, busque placa, VIN o trámite FLIT. Filtre por empresa y por estado: **Pendiente de recogida**, **Registrada**, **Despachada**, **Entregada**, **Con novedad**.
2. Pulse **Detalle** en una fila. Si la LT está **Registrada**, **Novedad** documenta un daño o inconsistencia.
3. En el detalle, la sección **Viajes adicionales** muestra cuántos viajes lleva el trámite (el viaje 1 va incluido) y el total de los adicionales. Pulse **Registrar viaje**, elija el **Motivo** (Devolución, Segunda entrega, Documento faltante u Otro —en «Otro» escriba el detalle, sin datos personales—) y el precio: **Precio inicial** copia la tarifa de logística vigente de la compañía y no se edita; **Nuevo precio** deja escribir un valor. Confirme con **Registrar**.
4. Para retirar un viaje pulse **Quitar** en su fila y confirme. Un viaje no se edita: se quita y se registra de nuevo.
5. En **Generación de actas**, cuando la compañía tenga LT registradas por el mensajero, pulse **Generar acta**.
6. En **Actas**, pulse **Ver** o **Descargar PDF**. **Firmar y despachar** abre **Firmar entrega y despachar**: elija mensajero, firme y confirme **Firmar y despachar**. **Devolver** si el receptor no recibió.
7. Si no hay mensajeros, verá **No hay mensajeros registrados. Crea un usuario con rol Mensajero.**

## Estados

- Cargando: las pestañas se ven; las tablas aparecen al llegar los datos.
- Error: mensaje en rojo sobre la tarjeta.
- Vacío en trámites: **No hay trámites aprobados. Sincroniza desde FLIT: los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.** En actas: **No hay LT registradas pendientes de acta…** / **Aún no hay actas. Ve a «Generación de actas»…**
- Lleno: listado con placa, propietario, empresa, secretaría, N.º LT y estado.
- Viajes adicionales (en el detalle): **Cargando viajes…** mientras llega la lista; sin viajes verá **Sin viajes adicionales. El viaje 1 se cobra con la tarifa vigente** y **Viajes: 1**; si el trámite ya está liquidado la sección es de solo lectura (**Trámite liquidado: reversa la liquidación para registrar o quitar viajes**); si la compañía autogestiona la logística verá **La logística de esta compañía la gestiona el cliente** y no podrá registrar; sin tarifa de logística vigente, **Precio inicial** queda deshabilitado y solo puede fijar **Nuevo precio**.

## Qué no hace

- No es **Mi ruta**: el Administrador no escanea LT en el organismo desde aquí.
- No despacha SOAT ni impuestos, ni **Factura**, ni hace **emisión electrónica**.
- No crea el trámite: el origen es la sincronización en **Gestión Trámites** (o **+ Trámite demo** en pruebas).
- Una compañía en autogestión de logística no aparece como trabajo de recogida de FLITO.
- Los viajes adicionales no aparecen en el acta ni en su PDF: su costo se consulta en Finanzas (**Reporte de costos**). Ver, registrar o quitar viajes requiere que el administrador le haya asignado esas funciones en **Roles y permisos**.
