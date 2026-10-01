## Qué es

Centro de despacho de los trámites de FLIT: usted sincroniza, consulta el estado y solicita SOAT e impuestos. Solo los trámites **Asignados** —con compañía y secretaría emparejadas— habilitan esas gestiones.

## Para quién

Administrador (opera, sincroniza y despacha). Auditor (solo lectura). El Proveedor y el Gestor de Impuestos no entran aquí: cada uno trabaja en su propia cola.

## Cómo se entra

En el menú lateral, sección **Gestión**, ítem **Gestión Trámites**. También desde **Tablero FLITO**, al pulsar una alerta operativa (el listado llega con el filtro ya aplicado).

## Pasos

1. Bajo el título está la tarjeta **Sincronización**, con un grupo para **FLIT 1** y otro para **FLIT 2**. En el grupo **FLIT 1**, pulse **Sincronizar FLIT** para traer trámites. Si es la primera vez, elija **Desde**; si ya hay sincronización, puede marcar **Elegir fecha**. Al terminar, un aviso breve le dice cuántos trámites nuevos y con cambios llegaron. En el grupo **FLIT 2**, FLITO lee FLIT 2 solo, cada 5 minutos. Junto a **Última lectura FLIT 2** verá la hora de la última lectura que salió bien y, debajo, cuándo es la próxima («próxima en 3:12») o «Leyendo FLIT 2 ahora…» mientras lee. Si dice **lectura atrasada**, quedan trámites por leer y la siguiente lectura sigue donde quedó. Si la lectura automática está apagada en este ambiente, lo dice ahí mismo.
2. **Interruptores de sincronización** (solo quien tiene el permiso para configurar la sincronización; hoy, el Administrador): cada grupo tiene un interruptor **Encendida / Apagada** y, debajo, quién lo cambió y cuándo.
   - **FLIT 1 apagada:** no entran trámites de FLIT 1 en este ambiente y **Sincronizar FLIT** queda deshabilitado, con el motivo al lado.
   - **FLIT 2 apagada:** FLITO deja de leer trámites nuevos de FLIT 2. Si había una lectura en curso, termina la página actual y se detiene. Al encenderla, la lectura sigue donde quedó.
   - Mientras una fuente está apagada no entra **nada** de ella; lo que ya entró no cambia. Apagar pide confirmación; encender, no. El cambio se guarda para todos los usuarios del ambiente y verá **Guardando…** hasta que el servidor lo confirme.
   - **Lectura automática apagada en el servidor:** si quien administra el ambiente apagó la lectura de FLIT 2 en el servidor, el grupo lo avisa y el interruptor no tiene efecto hasta que la enciendan allí, aunque usted lo vea **Encendida**.
   - Sin ese permiso, usted no ve los interruptores, pero cada grupo le dice en texto si la fuente está encendida o apagada; pídale a un administrador si hay que cambiarla.
3. Busque por placa, VIN, id o comprador, o use **Recién llegados sin gestionar**. Filtre por **Todas**, **Autogestionadas** o **No autogestionadas**. La columna **Fuente** indica si el trámite llegó de FLIT o de FLIT 2; el filtro **Fuente** (**Todas**, **FLIT**, **FLIT 2**) muestra solo los de un sistema, y **Limpiar filtros** lo devuelve a **Todas**.
4. Marque los trámites que necesite: la casilla ya **no** se limita a los **Asignados**, así que también puede marcar los ya entregados para llevarse sus soportes. Si ve **Empresa no existe**, pulse **Crear empresa**. Si ve **Secretaría sin emparejar**, empareje antes de despachar.
5. Con la selección, pulse **Solicitar SOAT**, **Solicitar Impuestos**, **Solicitar ambos** o **Entregar**. Esas acciones siguen aplicando **solo** a los trámites que ya las admitían, y el botón se lo dice: con tres marcados de los que dos se pueden despachar, verá **Solicitar SOAT (2 de 3)**. **Entregar** solo aplica si la fila muestra **Listo para entregar**.
6. Con trámites marcados, pulse **Descargar soportes (N)**. Se abre **Documentos del ZIP**, donde elige **Factura de venta**, **Recibo del impuesto**, **Comprobante del SOAT** o los que necesite, y obtiene **un solo** archivo ZIP con todo lo elegido. Cada trámite llega como **un solo PDF** con sus documentos en este orden: factura de venta, recibo del impuesto y comprobante del SOAT; el archivo se llama con la placa (por ejemplo, **ABC123.pdf**). Si un documento viene protegido y no se puede unir, va aparte, tal cual, como **ABC123-2.pdf**. Si un documento está dañado y no se puede leer, queda fuera y el aviso final le dice cuántos. Mientras se prepara verá **Preparando el archivo…**; con muchos trámites puede tardar unos minutos. Antes este botón traía solo las facturas de venta. Si ninguno de los trámites marcados tiene el documento que eligió, **no** se descarga un ZIP vacío: verá un aviso. En una fila, **Crear empresa**, el historial o **Soportes** abren el detalle de esa compañía o de ese trámite.
7. **Acceso a FLIT 2** (solo administradores): el botón del grupo **FLIT 2** abre un panel con el usuario de servicio con el que FLITO entra a FLIT 2, quién lo guardó y desde cuándo. La contraseña no se muestra nunca. Si aún no hay acceso, el panel lo dice. Con permiso de guardar, escriba el usuario y la contraseña que entregó FLIT 2 y pulse **Guardar acceso**: los campos se vacían al guardar. Con un acceso ya guardado, **Probar conexión** comprueba si FLIT 2 lo acepta y deja el resultado en un aviso dentro del panel (conectado, sin permiso de datos personales, rechazado, bloqueado un rato, o FLIT 2 que no responde); el botón no aparece hasta que haya un acceso guardado. Sin ese permiso, solo verá el estado.

## Estados

- Cargando: la tabla aún no aparece mientras llega el listado.
- Error: el mensaje en rojo sobre la tarjeta si falla el listado. Si falla **Sincronizar FLIT**, un aviso breve lo dice y ofrece **Reintentar**. Si no se pueden consultar los interruptores, la tarjeta **Sincronización** lo dice con **Reintentar**, y el resto de la zona sigue funcionando.
- Aviso de FLIT 2: si FLIT 2 rechaza o bloquea el acceso, o lleva más de 30 minutos sin leerse, aparece un aviso dentro del grupo **FLIT 2**; su título dice la causa (acceso rechazado, acceso bloqueado por un tiempo, falló la última lectura o más de 30 minutos sin leer), y debajo, la última lectura exitosa y qué hacer. El aviso se quita solo cuando vuelve una lectura exitosa. Si algunos trámites llegaron sin los datos del comprador, el aviso lo dice: su SOAT e impuestos quedan en espera hasta que FLIT 2 habilite el permiso de datos personales. Si FLIT 2 aún no tiene acceso, verá **FLIT 2 sin configurar**. Si una lectura falla, la línea dice cuándo se reintenta; si FLIT 2 rechazó el acceso, revíselo en **Acceso a FLIT 2**. Con FLIT 2 apagada (por el interruptor o en el servidor) no hay alerta de atraso: el grupo dice que la lectura automática está apagada y por qué.
- Vacío: **No hay trámites. Sincroniza desde FLIT para traer trámites.** Si hay filtros: **Ningún trámite coincide con el filtro.**
- Lleno: tabla con trámite, fechas, vehículo, comprador, compañía, SOAT, impuestos, logística, derechos de tránsito y soportes. Un trámite listo muestra **Listo para entregar**.

## Qué no hace

- No es la cola del Proveedor (**SOAT**) ni la del Gestor de Impuestos (**Impuestos**).
- No carga recibos de derechos de tránsito ni resuelve OCR: eso vive en **Derechos de tránsito** y **Revisiones OCR**.
- **Facturar** un trámite (congelar la liquidación) y la **emisión electrónica** no se hacen aquí.
- No entrega licencias de tránsito: eso es **Logística** / **Mi ruta**.
- El Auditor no descarga soportes en lote, aunque sí puede marcar trámites y usar todos los filtros.
