---
resumen: Actas, despacho y trazabilidad por documento.
palabras_clave:
  - logística
  - actas
  - despacho
  - mensajería
  - trazabilidad
consultas:
  - cómo genero un acta de despacho
  - dónde está un documento enviado
version: 1.1
fecha: 2026-10-22
---
## Qué es

Consola de las licencias de tránsito de trámites **Aprobado**: de la recogida en el organismo a la entrega firmada. Aquí usted genera actas por compañía y despacha al Mensajero.

## Para quién

Administrador (genera actas, firma y despacha, registra novedades). Auditor (consulta). El Mensajero no entra aquí: su trabajo es **Mi ruta**.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Logística**.

## Pasos

1. En la pestaña **Trámites**, busque por placa, VIN o trámite FLIT y filtre por empresa y por estado: **Pendiente de recogida**, **Registrada**, **Despachada**, **Entregada** o **Con novedad**. ![Pestaña Trámites con el buscador, el filtro de empresas, los cinco estados y la tabla de licencias](./flito_logistica/01-tramites.png)
2. Pulse **Detalle** en una fila para ver el trámite, la sección **Viajes adicionales** y la **Bitácora** de la licencia. Si la licencia está **Registrada** y viene dañada o con datos que no cuadran, pulse **Novedad** en la fila, escriba el **Motivo (obligatorio)** y pulse **Confirmar**. ![Detalle de una licencia con sus datos, la sección Viajes adicionales y la bitácora](./flito_logistica/02-detalle.png)
3. En **Viajes adicionales** verá cuántos viajes lleva el trámite (el viaje 1 va incluido) y el total de los adicionales. Pulse **Registrar viaje**, elija el **Motivo (obligatorio)** —Devolución, Segunda entrega, Documento faltante u Otro; en «Otro» escriba el detalle, sin datos personales— y el **Precio**: **Precio inicial** copia la tarifa de logística vigente de la compañía y no se edita; **Nuevo precio** deja escribir un valor. Confirme con **Registrar**. ![Ventana Registrar viaje con el motivo elegido y la opción Precio inicial con la tarifa vigente](./flito_logistica/03-registrar-viaje.png)
4. Para retirar un viaje, pulse **Quitar** en su fila y confirme. Un viaje no se edita: se quita y se registra de nuevo.
5. En la pestaña **Generación de actas** verá cada empresa con sus licencias registradas por el mensajero. Pulse **Generar acta**: se crea un acta por empresa y la pantalla pasa a la pestaña **Actas**. ![Pestaña Generación de actas con dos empresas, sus licencias registradas y el botón Generar acta](./flito_logistica/04-generacion-de-actas.png)
6. En la pestaña **Actas**, pulse **Ver** para revisar las licencias, las firmas y la bitácora del despacho; dentro está **Descargar PDF**. ![Pestaña Actas con actas Generada, Despachada y Entregada y sus acciones Ver, Firmar y despachar y Devolver](./flito_logistica/05-actas.png)
7. En un acta **Generada**, pulse **Firmar y despachar**. En la ventana **Firmar entrega y despachar** elija el **Mensajero**, escriba si quiere el **Nombre de quien entrega (Operaciones)**, trace la **Firma de quien entrega** y pulse **Firmar y despachar**. ![Ventana Firmar entrega y despachar con el mensajero elegido y la firma trazada](./flito_logistica/06-firmar-y-despachar.png)
8. Si el receptor no recibió un acta **Despachada**, pulse **Devolver**, escriba el **Motivo (obligatorio)** y pulse **Confirmar**.

![Ciclo de una licencia de tránsito: Pendiente de recogida, Registrada cuando el mensajero la escanea, acta generada, Despachada al firmar y despachar, y Entregada con la firma del receptor; la novedad y la devolución la dejan Con novedad](./flito_logistica/ciclo-licencia.svg)

## Estados

- Cargando: las pestañas se ven; las tablas aparecen al llegar los datos. En **Viajes adicionales** se ve la silueta de la lista mientras llega.
- Error: mensaje en rojo sobre la tarjeta. Si los viajes no cargan, el aviso trae **Reintentar**.
- Vacío en trámites: **No hay trámites aprobados. Sincroniza desde FLIT: los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.** Con enlace de compañía: **No hay trámites aprobados de su compañía en esta vista.** seguido de la misma explicación. En actas: **No hay LT registradas pendientes de acta…** / **Aún no hay actas. Ve a «Generación de actas»…** En el detalle de una licencia aún no recogida: **La licencia aún no se ha recogido. El mensajero la escaneará en el organismo.**
- Lleno: listado con placa, propietario, empresa, secretaría, N.º LT y estado.
- Sin mensajeros: en **Firmar entrega y despachar** verá **No hay mensajeros registrados. Crea un usuario con rol Mensajero.**
- Viajes adicionales (en el detalle): sin viajes verá **Sin viajes adicionales. El viaje 1 se cobra con la tarifa vigente.** y **Viajes: 1 (incluye el viaje 1)**; si el trámite ya está liquidado la sección es de solo lectura (**Trámite liquidado: reversa la liquidación para registrar o quitar viajes.**); si la compañía autogestiona la logística verá **La logística de esta compañía la gestiona el cliente.** y no podrá registrar; sin tarifa de logística vigente, **Precio inicial** queda deshabilitado (**La compañía no tiene tarifa de logística vigente**) y solo puede fijar **Nuevo precio**.

## Qué no hace

- No es **Mi ruta**: el Administrador no escanea LT en el organismo desde aquí.
- No despacha SOAT ni impuestos, ni **Factura**, ni hace **emisión electrónica**.
- No crea el trámite: el origen es la sincronización en **Gestión Trámites** (o **+ Trámite demo** en pruebas).
- Una compañía en autogestión de logística no aparece como trabajo de recogida de FLITO.
- Los viajes adicionales no aparecen en el acta ni en su PDF: su costo se consulta en Finanzas (**Reporte de costos**). Ver, registrar o quitar viajes requiere que el administrador le haya asignado esas funciones en **Roles y permisos**.
