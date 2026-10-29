---
resumen: Viajes a FLIT o al cliente, despacho y seguimiento de los viajes.
palabras_clave:
  - logística
  - viajes
  - entregas
  - actas
  - despacho
  - mensajería
  - trazabilidad
  - en flit
  - llegada
consultas:
  - cómo registro un viaje a cliente
  - cómo elijo si el viaje va a FLIT o al cliente
  - cómo veo en qué estado está un viaje
  - dónde está un documento enviado
  - qué significa el estado en flit
version: 2.4
fecha: 2026-10-29
---
## Qué es

Consola de las licencias de tránsito de trámites **Aprobado**: de la recogida en el organismo a la entrega firmada. Aquí usted registra el viaje de cada compañía, a FLIT o al cliente, y despacha al Mensajero.

## Para quién

Administrador (registra viajes, firma y despacha, firma la llegada a FLIT, registra novedades). Auditor (consulta). El Mensajero no entra aquí: su trabajo es **Mi ruta**.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Logística**.

## Pasos

1. En la pestaña **Trámites**, busque por placa, VIN o trámite FLIT y filtre por empresa y por estado: **Pendiente de recogida**, **Registrada**, **En FLIT**, **Despachada**, **Entregada** o **Con novedad**. **En FLIT** es la licencia que ya está en las instalaciones de FLIT; no es un paso que recorra todo trámite. ![Pestaña Trámites con el buscador, el filtro de empresas, los seis estados y la tabla de licencias](./flito_logistica/01-tramites.png)
2. Pulse **Detalle** en una fila para ver el trámite, la sección **Viajes adicionales** y la **Bitácora** de la licencia. Si la licencia está **Registrada** y viene dañada o con datos que no cuadran, pulse **Novedad** en la fila, escriba el **Motivo (obligatorio)** y pulse **Confirmar**. ![Detalle de una licencia con sus datos, la sección Viajes adicionales y la bitácora](./flito_logistica/02-detalle.png)
3. En **Viajes adicionales** verá cuántos viajes lleva el trámite (el viaje 1 va incluido) y el total de los adicionales. Pulse **Registrar viaje**, elija el **Motivo (obligatorio)** —Devolución, Segunda entrega, Documento faltante u Otro; en «Otro» escriba el detalle, sin datos personales— y el **Precio**: **Precio inicial** copia la tarifa de logística vigente de la compañía y no se edita; **Nuevo precio** deja escribir un valor. Confirme con **Registrar**. ![Ventana Registrar viaje con el motivo elegido y la opción Precio inicial con la tarifa vigente](./flito_logistica/03-registrar-viaje.png)
4. Para retirar un viaje, pulse **Quitar** en su fila y confirme. Un viaje no se edita: se quita y se registra de nuevo.
5. Para registrar el mismo viaje a varias LT a la vez, abra la pestaña **Viajes adicionales** (solo la ve quien tenga la función de registrar viajes). Pegue o escriba las placas en el cuadro **Placas** —una por línea; si copia desde Excel puede incluir el valor en la segunda columna— y pulse **Agregar a la lista** (hasta 200 por tanda; las que sobran se quedan en el cuadro). Elija el **Motivo del viaje (obligatorio)**, escriba el valor de cada placa o un **Valor para todas (COP)** y pulse **Aplicar a las seleccionadas**; cada fila sigue editable. Pulse **Registrar N viajes**: el resultado dice cuántos se registraron y, de las que no, el motivo de cada una. **Corregir y reintentar** vuelve a cargar solo las que se arreglan editando (placa o valor).
6. En la pestaña **Viajes** (solo la ve quien tenga la función de registrar viajes) verá cada empresa con sus LT clasificadas y el precio por LT de **Cliente** y de **FLIT** antes de confirmar. Pulse **Registrar viaje**. En **Destino del viaje** elija **Cliente** o **FLIT**; cada LT se puede cambiar. Si unas van a FLIT y otras al cliente, **Confirmar viaje** registra dos viajes. A FLIT hay que elegir el **Motivo de llegada**; la **Nota** es opcional. El precio queda congelado. Si falta el precio de un destino, esa mitad se lee en rojo. **Registrar viaje** aparece si al menos un destino tiene precio. Si usted ve Tarifas, aparece **Ir a Tarifas**; si no, **Pídale a Finanzas que fije el precio.** ![Pestaña Viajes con dos empresas, el precio por LT de Cliente y de FLIT, y el botón Registrar viaje](./flito_logistica/04-viajes-a-cliente.png)
7. En la pestaña **Entregas** ve los viajes ya registrados: compañía, destino (**Cliente** o **FLIT**), estado, cantidad de LT y fecha. Filtre por **Placa**, **Estado**, **Destino** o **Compañía**. Aquí no se registra el viaje ni se confirma el destino: eso sigue en **Viajes**. ![Pestaña Entregas con los filtros de placa, estado, destino y compañía, y la tabla de viajes sin acciones](./flito_logistica/08-entregas.png)
8. En la pestaña **Actas**, pulse **Ver** para revisar las licencias, las firmas y la bitácora del despacho; dentro está **Descargar PDF**. ![Pestaña Actas con actas Generada, Despachada y Entregada y sus acciones Ver, Firmar y despachar y Devolver](./flito_logistica/05-actas.png)
9. En un acta **Generada**, pulse **Firmar y despachar**. En la ventana **Firmar entrega y despachar** elija el **Mensajero**, escriba si quiere el **Nombre de quien entrega (Operaciones)**, trace la **Firma de quien entrega** y pulse **Firmar y despachar**. ![Ventana Firmar entrega y despachar con el mensajero elegido y la firma trazada](./flito_logistica/06-firmar-y-despachar.png)
10. Si el receptor no recibió un acta **Despachada**, pulse **Devolver**, escriba el **Motivo (obligatorio)** y pulse **Confirmar**.
11. Cuando el viaje a FLIT ya está en ruta, quien tenga la función de firmar la llegada ve **Firmar llegada** en esa fila de **Actas** y en **Mi ruta**. El paso muestra **Llegada a FLIT**, las placas y **Firma de quien recibe en FLIT**. No pide cédula ni nombre: queda el de la sesión. Pulse **Confirmar llegada**. Quien no tiene esa función no ve el botón ni ese viaje en la sección Entregas de **Mi ruta**. La entrega al cliente sigue pidiendo nombre, cédula y firma.
12. Si tiene la función de resolver trámites, verá la pestaña **LT pendientes** con el número de LT que esperan. Son licencias que el mensajero recogió sin saber a qué trámite pertenecen; la más antigua aparece primero (pulse **Antigüedad** para invertir el orden). Busque por placa o filtre por **Con firma** / **Sin firma** y pulse **Elegir trámite**: elija el trámite al que pertenece la LT (no viene ninguno marcado), pulse **Continuar**, lea qué pasará con el acta y pulse **Asignar trámite**. Si la LT ya tiene la firma del organismo, entra al acta de la compañía con esa misma firma; si no, entrará al acta cuando el organismo firme.
13. En la pestaña **Motivos de llegada** (solo la ve quien tenga esa función asignada en **Roles y permisos**) administra el catálogo de motivos por los que un organismo llega a las instalaciones de FLIT. Pulse **Nuevo motivo**, escriba el **Nombre** y pulse **Crear motivo**: el nuevo queda al final de la lista. **Editar** corrige el nombre; **Subir** y **Bajar** dejan el orden en que aparecerá al registrar un viaje a FLIT; el menú ⋮ permite **Desactivar** o **Activar**. Filtre con **Todos**, **Activos** o **Inactivos**. Un motivo **no se elimina**: el histórico de viajes conserva el motivo. ![Pestaña Motivos de llegada con la lista en orden, el estado de cada motivo y las acciones Subir, Bajar, Editar y el menú de fila](./flito_logistica/07-motivos-de-llegada.png)

![Ciclo de una licencia de tránsito: Pendiente de recogida, Registrada cuando el mensajero la escanea, viaje a cliente registrado, Despachada al firmar y despachar, y Entregada con la firma de quien recibe; la novedad y la devolución la dejan Con novedad](./flito_logistica/ciclo-licencia.svg)

## Estados

- Cargando: las pestañas se ven; las tablas aparecen al llegar los datos. En **Viajes adicionales** se ve la silueta de la lista mientras llega. En **Viajes** y en **Entregas** se ve la silueta y se anuncia **Cargando viajes…**.
- Error: mensaje en rojo sobre la tarjeta. Si los viajes no cargan, el aviso trae **Reintentar**. En **Viajes**: **No se pudieron cargar las LT listas para viaje.** con **Reintentar**; sin permiso, **No tiene permiso para registrar viajes.** En **Entregas**: **No se pudieron cargar los viajes. Inténtelo de nuevo.** con **Reintentar**; sin permiso, **No tiene permiso para ver los viajes.** sin Reintentar.
- Vacío en trámites: **No hay trámites aprobados. Sincroniza desde FLIT: los trámites en estado «Aprobado» aparecen aquí a la espera de su licencia de tránsito.** Con enlace de compañía: **No hay trámites aprobados de su compañía en esta vista.** seguido de la misma explicación. En **Viajes**: **No hay LT clasificadas listas para un viaje. Primero deben recogerse y clasificarse en el organismo.** En **Entregas**, si todavía no hay viajes: **Aún no hay viajes. Regístrelos en Viajes: cuando queden registrados, aparecen aquí.** Si un filtro no deja filas: **Ningún viaje coincide con estos filtros. Pruebe otra placa o quite un filtro.** y **Limpiar filtros**. En actas: **Aún no hay actas. Ve a «Viajes» y registra el viaje de una compañía con LT clasificadas.** En el detalle de una licencia aún no recogida: **La licencia aún no se ha recogido. El mensajero la escaneará en el organismo.**
- Lleno: listado con placa, propietario, empresa, secretaría, N.º LT y estado. El filtro **En FLIT** deja solo las licencias que están en las instalaciones de FLIT; el chip de la fila dice **En FLIT**.
- LT pendientes: sin LT verá **No hay LT esperando trámite…**; con un filtro sin resultados, **Ninguna LT coincide con tu búsqueda** y **Limpiar filtros**; si no carga, **Reintentar**. Si la LT no tiene trámites aprobados para elegir, el diálogo dice **Aún no hay trámites aprobados de este vehículo para elegir.** y solo se puede cerrar. Si otro usuario ya le asignó el trámite, un aviso lo dice y la lista se actualiza.
- Sin mensajeros: en **Firmar entrega y despachar** verá **No hay mensajeros registrados. Crea un usuario con rol Mensajero.**
- Viajes adicionales (pestaña, registro masivo): sin placas verá **Aún no hay placas en la lista. Pega o escribe las placas arriba y pulse «Agregar a la lista».**; mientras se registra, **Registrando N viajes. No cierres ni recargues esta página.**; si falla la solicitud, **No pudimos registrar los viajes. Tus placas siguen en la lista; vuelve a intentarlo.** con **Reintentar**.
- Viajes adicionales (en el detalle): sin viajes verá **Sin viajes adicionales. El viaje 1 se cobra con la tarifa vigente.** y **Viajes: 1 (incluye el viaje 1)**; si el trámite ya está liquidado la sección es de solo lectura (**Trámite liquidado: reversa la liquidación para registrar o quitar viajes.**); si la compañía autogestiona la logística verá **La logística de esta compañía la gestiona el cliente.** y no podrá registrar; sin tarifa de logística vigente, **Precio inicial** queda deshabilitado (**La compañía no tiene tarifa de logística vigente**) y solo puede fijar **Nuevo precio**.
- Motivos de llegada: mientras carga se ve la silueta de la tabla. Si no carga: **No pudimos cargar los motivos de llegada.** con **Reintentar**. Si perdió el permiso: **No tiene permiso para gestionar los motivos de llegada.** sin Reintentar. Sin ningún motivo: **No hay motivos de llegada. Cree el primero con «Nuevo motivo».** Si un filtro no deja filas, **Ver todos**. Si el nombre ya existe, en la ventana: **Ya existe un motivo de llegada con ese nombre. Cambie el nombre o edite el que ya está en la lista.**

## Qué no hace

- No es **Mi ruta**: el Administrador no escanea LT en el organismo desde aquí. La pestaña **Entregas** de esta consola solo consulta viajes; la entrega en campo sigue en **Mi ruta**.
- No despacha SOAT ni impuestos, ni **Factura**, ni hace **emisión electrónica**.
- No crea el trámite: el origen es la sincronización en **Gestión Trámites** (o **+ Trámite demo** en pruebas).
- Una compañía en autogestión de logística no aparece como trabajo de recogida de FLITO.
- Los viajes adicionales no aparecen en el acta ni en su PDF: su costo se consulta en Finanzas (**Reporte de costos**). Ver, registrar o quitar viajes adicionales, y ver la pestaña **Viajes**, requiere que el administrador le haya asignado esas funciones en **Roles y permisos**.
- Sin precio del destino elegido no se registra ese viaje: el precio lo fija Finanzas en **Tarifas**. Si falta solo el de FLIT, el viaje a cliente sí se puede registrar.
- Los motivos de llegada no se eliminan: se desactivan y el histórico conserva el motivo. Ver la pestaña exige que el administrador asigne esa función en **Roles y permisos**.
