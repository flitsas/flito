---
resumen: Saldos, alta de bolsas, recargas y cierres.
palabras_clave:
  - bolsas
  - saldos
  - recargas
  - cierres
  - crear bolsa
  - inactivar bolsa
  - autogestión
  - documentos
  - expediente
  - cámara de comercio
  - rut
  - certificado bancario
consultas:
  - cómo recargo una bolsa
  - cuál es el saldo de una bolsa
  - cómo cierro una bolsa
  - cómo creo la bolsa de una compañía
  - cómo inactivo o reactivo una bolsa
  - por qué no puedo recargar una bolsa
  - cómo cargo los documentos de la compañía
  - por qué un documento dice vigencia vencida
  - qué hago si no se pudo validar un documento
  - cómo quito un documento que cargué por error
  - cómo creo una bolsa de tránsito
  - cómo cierro el mes de una bolsa de tránsito
  - por qué no puedo reactivar una bolsa de tránsito
version: 1.8
fecha: 2026-10-26
---
## Qué es

El saldo que cada cliente tiene precargado con FLIT y el que FLIT mantiene ante las secretarías. Los KPI de **Saldo total**, **Bolsas en riesgo** y **Conciliación pendiente** encabezan la pantalla; debajo, dos acordeones (**Compañías** y **Tránsitos**). Usted crea la bolsa de una compañía o de tránsito, elige qué descuenta, la inactiva o la reactiva, y recarga, mueve, corrige y cierra periodos. No **Factura** la liquidación ni hace **emisión electrónica**.

## Para quién

Financiera y Administrador (operan el dinero). El Auditor no entra: a diferencia del resto de FLITO, las bolsas son solo de Administración y Financiera. Crear, editar e inactivar una bolsa son permisos propios: si no los tiene, esos botones no aparecen.

## Cómo se entra

En el menú lateral, sección **Finanzas**, ítem **Bolsas**.

## Pasos

1. Arriba están **Crear bolsa** y los KPI **Saldo total**, **Bolsas en riesgo** y **Conciliación pendiente**. Use **Buscar** (compañía, bolsa o NIT), el filtro **Alcance** (**Todas**, **Compañías**, **Tránsito**) y el filtro **Estado** (**Todas**, **Activas**, **Inactivas**) para encontrar una bolsa. Con un alcance elegido solo se ve su acordeón. ![Cabecera de Bolsas con el botón Crear bolsa, los tres KPI y la barra con Buscar y los filtros Alcance y Estado](./flito_bolsas/01-cabecera-y-kpi.png)
2. En **Compañías**, cada fila dice el **Estado** (Activa o Inactiva), el **Saldo**, el **Nivel** y el **Expediente**: **Docs completos** si la compañía tiene válidos la Cámara de Comercio, el RUT, la cédula del representante legal y el certificado bancario, o **Docs pendientes** si falta alguno, está vencido o no se pudo validar. La columna **Expediente** solo aparece si usted puede ver documentos. Pulse **Ver detalle** en una fila o en una alerta de **Alertas de saldo**. En **Tránsitos**, cada fila dice la **Bolsa**, el **Estado**, el **Saldo** (con **−** si está en préstamo) y el **Nivel** (incluye **En préstamo**); pulse **Ver detalle**. ![Acordeón Compañías con una alerta de saldo crítico y la tabla de compañías con estado, saldo, nivel y Ver detalle; debajo, Tránsitos](./flito_bolsas/02-companias.png)
3. Para dar de alta una bolsa, pulse **Crear bolsa** y responda **¿De quién es la bolsa?**. Con **Compañía**: elija la compañía (las inactivas aparecen con **(Inactivo)** y no se pueden elegir) y marque en **¿Qué conceptos descuenta?** al menos uno (ninguno viene marcado y el GMF no se elige); luego **Crear bolsa**. Se abre el detalle de la bolsa nueva. Con **Tránsito**: escriba el **Nombre**, marque en **¿Qué cobros descuenta?** al menos uno y elija las **Secretarías a las que aplica**; luego **Crear bolsa**. Se abre el detalle de la bolsa nueva. Si una secretaría ya la cubre otra bolsa activa para el mismo cobro, el formulario lo dice junto a la secretaría y con el nombre de esa bolsa: quítela o desmarque ese cobro para guardar. ![Formulario Crear bolsa con la opción Compañía, una compañía elegida, los seis conceptos, SOAT marcado como Autogestionado y el aviso de autogestión](./flito_bolsas/03-crear-bolsa.png)
4. En el detalle de la compañía: el estado, el saldo y los conceptos que descuenta. Elija el **Periodo contable** y, si necesita el histórico, marque **Ver el libro completo (todos los periodos)**. Las acciones son **Registrar una recarga** (valor y comprobante; **Registrar recarga**), **Movimiento manual** (**Registrar movimiento**), **Corregir un movimiento** (**Asentar corrección**) o **Cerrar** el periodo (el botón dice **Cerrar** y el nombre del mes; **Confirmar el cierre**; irreversible). Debajo, el consumo por organismo y por concepto, y los movimientos, que puede **Exportar CSV**. Un movimiento que revierte a otro lleva el enlace **Revierte el movimiento del…** y lo lleva hasta el original. ![Detalle de la bolsa de una compañía: Activa y Normal, Editar conceptos e Inactivar, el saldo, los conceptos que descuenta con SOAT autogestionado, el periodo contable y el extracto](./flito_bolsas/04-detalle-compania.png)
5. Para cambiar los conceptos, pulse **Editar conceptos** y luego **Guardar cambios**.
6. Para dejar de usar una bolsa, pulse **Inactivar**, escriba el **Motivo** (mínimo 5 caracteres) y **Inactivar bolsa**. Para volver a usarla, **Reactivar bolsa** con su motivo. El saldo y los movimientos se conservan.
7. Al final del detalle de una bolsa de compañía está la sección **Documentos**: **Cámara de Comercio**, **RUT**, **Cédula del representante legal**, **Certificado bancario** y **Documento adicional** (opcional). Pulse **Cargar** (o **Reemplazar** si ya hay uno) y elija un PDF, JPG o PNG de hasta 15 MB. La versión anterior queda en **Historial**, y con el icono de descarga baja la vigente. La Cámara de Comercio, el RUT y el certificado bancario quedan en **Validando…** mientras el sistema lee la fecha de expedición; si no la puede leer quedan en **No se pudo validar**: pulse **Digitar fecha**, escriba la fecha y **Guardar fecha**. Si la fecha leída está mal, use **Corregir**. Si el archivo vigente está mal (de otra compañía, otro documento o ilegible), pulse **Quitar** al final de la fila, escriba si quiere un motivo (opcional, sin datos personales) y confirme con **Quitar versión**: la fila vuelve a **Pendiente** con **Cargar**, y la versión queda en **Historial** como **retirada**, con quién la retiró, cuándo, el motivo y su descarga. Si era uno de los cuatro principales, el expediente pasa a **Docs pendientes**. Arriba de la sección, **Docs completos** indica que los cuatro principales están válidos y **Docs pendientes** que falta alguno. ![Sección Documentos del detalle de la bolsa: Docs pendientes, 2 de 4 principales válidos; Cámara de Comercio Válido, RUT Vigencia vencida, cédula Válido, certificado bancario No se pudo validar y documento adicional Pendiente, con Reemplazar, descargar, Historial, Quitar, Corregir, Digitar fecha y Cargar](./flito_bolsas/05-documentos.png)
8. En el detalle de una bolsa de **tránsito**: el estado, el nivel, el saldo (y lo que se debe si está **En préstamo**), lo cargado y lo consumido, y la **Cobertura** (pulse **Ver** para la lista de secretarías y cobros). Las acciones son **Cargar saldo** (valor, fecha y soporte opcional; **Registrar carga**), **Editar cobertura** (**Guardar cambios**) e **Inactivar**. Debajo están los **Movimientos** y los **Cierres del mes**: con **Cerrar un mes** elija el **Mes** y pulse **Cerrar** con el nombre del mes; el cierre queda en la lista con el saldo inicial, las entradas, las salidas y el saldo final.

> [!IMPORTANTE]
> Una compañía tiene una sola bolsa. Si al crearla ve **Esta compañía ya tiene bolsa** (o **ya tiene bolsa (inactiva)**), pulse **Ver su bolsa**: si está inactiva, reactívela en lugar de crear otra.

> [!NOTA]
> Un documento con fecha de expedición vale 30 días: el día 31 pasa solo a **Vigencia vencida** y hay que cargar uno más reciente. La cédula y el documento adicional no vencen. Los documentos son de la compañía, no de la bolsa, y solo los ve el personal de FLIT.

> [!NOTA]
> Si un concepto lleva la marca **Autogestionado**, la compañía lo gestiona por su cuenta: no llegarán movimientos a la bolsa por ese concepto salvo excepciones. Puede marcarlo igual. La autogestión se cambia en **Clientes y proveedores** (enlace **Cambiarlo en Clientes y proveedores**).

> [!NOTA]
> En una bolsa de tránsito, una secretaría autogestionada para impuestos lleva el aviso **este organismo es autogestionado para impuestos: no llegarán movimientos de impuesto a la bolsa salvo excepciones**, en el detalle y al editar la cobertura. Puede guardar igual.

> [!PRECAUCION]
> Una bolsa de tránsito inactiva no recibe descuentos ni cargas: **Cargar saldo** se ve deshabilitado y el detalle avisa **Reactiva la bolsa primero**. Al inactivarla, sus secretarías quedan libres para otra bolsa; si al reactivarla otra bolsa activa ya cubre alguna, el detalle lo dice con la secretaría, el cobro y el enlace **Ver** a esa bolsa, y la bolsa sigue inactiva.

> [!PRECAUCION]
> Con la bolsa inactiva no se registran recargas, movimientos manuales ni correcciones, y los trámites no descuentan de ella. El detalle lo avisa con **Reactiva la bolsa primero**. El cierre del periodo sigue disponible. Los documentos se pueden ver y descargar, pero no cargar ni corregir hasta reactivarla.

El ciclo de la bolsa de una compañía en un periodo, de un vistazo:

![Diagrama: se crea la bolsa y se eligen sus conceptos; durante el periodo hay recargas, consumos y movimientos manuales o correcciones; al cerrar el periodo y confirmar el cierre queda cerrado de forma irreversible y se descarga el reporte](./flito_bolsas/ciclo-periodo.svg)

## Estados

- Cargando: el encabezado **Bolsas** se ve; el tablero aún no (esqueleto).
- Error: **No pudimos cargar las bolsas. Revisa tu conexión e intenta de nuevo.** y **Reintentar**.
- Vacío: **Todavía no hay bolsas. Crea la primera y elige si es de una compañía o de tránsito.** con **Crear bolsa**. Si la búsqueda no encuentra nada: **Ninguna bolsa coincide con…** y **Limpiar filtros**.
- Lleno: KPI, alertas de saldo y la tabla de compañías con estado, saldo, nivel y expediente.
- Expediente en la tabla: mientras se consulta se ve una barra gris; si la consulta falla, la celda muestra **—** y arriba de la tabla aparece **No pudimos cargar el estado de los documentos.** con **Reintentar**. La tabla funciona igual.
- Documentos: mientras carga, **Cargando el expediente**; si falla, **No pudimos cargar los documentos de la compañía. Intenta de nuevo.** con **Reintentar**; sin documentos, **Todavía no hay documentos. Carga los cuatro principales para dejar el expediente completo.** Si solo puede ver documentos (o la bolsa está inactiva), no aparecen **Cargar**, **Digitar fecha** ni **Quitar**. En **Historial**, cada versión dice si es la **vigente**, si fue **reemplazada** por una carga nueva o si fue **retirada** con **Quitar**; las retiradas muestran **Retirada por** y el motivo, y se pueden descargar.
- Tránsito: si no hay ninguna, **Todavía no hay bolsas de tránsito. Pulsa «Crear bolsa» y elige Tránsito.** En el detalle, **Movimientos** y **Cierres del mes** cargan cada uno por su lado: si uno falla dice **No pudimos cargar…** con su propio **Reintentar**, y sin datos dice **Esta bolsa todavía no tiene movimientos** o **Todavía no se ha cerrado ningún mes**.
- Compañía sin bolsa: el detalle dice **Crea la bolsa de la compañía primero** con **Crear bolsa** (la compañía ya viene elegida). Si al recargar aparece ese mismo aviso, la bolsa no existe todavía.

## Qué no hace

- No cuadra el Excel del portal SOAT: eso es **Conciliación**. Cargar o conciliar una boleta no se hace aquí.
- No **Factura** (congelar la liquidación) ni envía a **emisión electrónica**: eso vive en **Reporte de costos** y en **Facturación electrónica · Operación**.
- No es el listado de compañías ni cambia su autogestión: las tarifas, la ficha comercial y la autogestión están en **Clientes y proveedores**.
- No borra una bolsa: se inactiva y se puede reactivar.
- Quitar un documento no lo borra: la versión queda en **Historial** como retirada. Para restaurarla, vuelva a cargar el archivo.
- El Auditor, el Proveedor y el Gestor de Impuestos no operan bolsas.
